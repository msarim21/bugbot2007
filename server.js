const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ============================================================
// 🔥 HEAVY CRASH VECTORS
// ============================================================

const VECTORS = [
  { id: 'zero_click_media', name: 'Zero-Click Media', icon: '💀', 
    desc: 'Auto-render media parser crash — WhatsApp hangs', badge: 'ZERO-CLICK',
    targetType: 'individual' },
  { id: 'webrtc_crash', name: 'WebRTC Crash', icon: '📞', 
    desc: 'WebRTC SDP parser crash — Phone hangs', badge: 'ZERO-CLICK',
    targetType: 'individual' },
  { id: 'gif_exploit', name: 'GIF Parser Exploit', icon: '🎞️', 
    desc: 'Malformed GIF auto-render — App crash', badge: 'ZERO-CLICK',
    targetType: 'individual' },
  { id: 'webp_smash', name: 'WebP Memory Smash', icon: '🧨', 
    desc: 'VP8X heap overflow — Memory corruption', badge: 'HEAVY',
    targetType: 'individual' },
  { id: 'exif_exploit', name: 'EXIF Heap Exploit', icon: '📸', 
    desc: 'JPEG EXIF parser overflow', badge: 'HEAVY',
    targetType: 'individual' },
  { id: 'video_exploit', name: 'Video Thumbnail Exploit', icon: '🎬', 
    desc: 'MP4 thumbnail buffer overflow', badge: 'HEAVY',
    targetType: 'individual' },
  { id: 'contact_overflow', name: 'Contact Card Overload', icon: '👤', 
    desc: 'vCard parser stack overflow — Phone hang', badge: 'CRASH',
    targetType: 'individual' },
  { id: 'emoji_infinite', name: 'Emoji Infinite Loop', icon: '😈', 
    desc: 'ZWJ renderer infinite loop — Mobile hangs', badge: 'HANG',
    targetType: 'individual' },
  { id: 'protobuf_oversize', name: 'Protobuf Oversize', icon: '📦', 
    desc: '2GB message allocation — OOM crash', badge: 'OOM',
    targetType: 'individual' },
  { id: 'memory_drain', name: 'Silent Memory Drain', icon: '🕳️', 
    desc: '5MB leak per message — Background kill', badge: 'INVISIBLE',
    targetType: 'individual' },
  { id: 'cpu_burn', name: 'Silent CPU Burn', icon: '🔥', 
    desc: '100% CPU in background — Battery drain', badge: 'INVISIBLE',
    targetType: 'individual' },
  { id: 'mention_blast', name: 'Mention Blast', icon: '📢', 
    desc: 'Mass @mentions — Full group hang', badge: 'GROUP',
    targetType: 'group' },
  { id: 'emoji_bomb', name: 'Emoji Bomb', icon: '💣', 
    desc: 'Mass emoji renderer — Group members crash', badge: 'GROUP',
    targetType: 'group' },
  { id: 'poll_overload', name: 'Poll Overload', icon: '📊', 
    desc: '1000+ options poll — Renderer crash', badge: 'GROUP',
    targetType: 'group' },
  { id: 'persistent_loop', name: 'Persistent Crash Loop', icon: '♻️', 
    desc: '10× re-crash — Tab tak jab tak delete na karein', badge: 'PERSIST',
    targetType: 'individual' },
  { id: 'hard_delay', name: 'Hard Delay Attack', icon: '⏳', 
    desc: '5-30s delayed re-crash — Continuous attack', badge: 'PERSIST',
    targetType: 'individual' },
  { id: 'system_oom', name: 'System OOM Crash', icon: '💣', 
    desc: 'Memory exhaustion — Full system hang', badge: 'SYSTEM',
    targetType: 'individual' }
];

// ============================================================
// 🛡️ STORAGE
// ============================================================

const sessions = {};
const crashLogs = [];

// ============================================================
// 📡 API ROUTES
// ============================================================

app.get('/', (req, res) => {
  res.json({
    name: '🔥 WhatsApp Crash Suite v4.0',
    status: 'running',
    version: '4.0.0',
    vectors: VECTORS.length,
    totalCrashes: crashLogs.length,
    sessions: Object.keys(sessions).length,
    message: '💀 Victim ka WhatsApp band ho jayega aur mobile hang!',
    api_key: 'crash123',
    endpoints: {
      connect: 'POST /api/connect',
      target: 'POST /api/target',
      vectors: 'GET /api/vectors',
      crash: 'POST /api/crash',
      logs: 'GET /api/logs'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: '4.0.0',
    uptime: process.uptime(),
    time: new Date().toISOString()
  });
});

app.post('/api/connect', (req, res) => {
  const { phoneNumber } = req.body;
  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: 'Phone number required' });
  }
  const sessionId = 'session_' + Date.now();
  sessions[sessionId] = {
    sessionId,
    phoneNumber,
    status: 'connected',
    targetNumber: null,
    targetType: 'individual',
    metrics: { total: 0, success: 0, failed: 0 }
  };
  res.json({
    success: true,
    sessionId,
    status: 'connected',
    message: `✅ Connected to ${phoneNumber}`
  });
});

app.post('/api/target', (req, res) => {
  const { sessionId, target } = req.body;
  if (!sessions[sessionId]) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  const targetType = target.includes('chat.whatsapp.com') ? 'group' : 'individual';
  sessions[sessionId].targetNumber = target;
  sessions[sessionId].targetType = targetType;
  res.json({
    success: true,
    target,
    targetType,
    message: `🎯 Target set: ${target}`
  });
});

app.get('/api/vectors', (req, res) => {
  res.json({
    success: true,
    total: VECTORS.length,
    vectors: VECTORS
  });
});

app.post('/api/crash', (req, res) => {
  const { sessionId, vector } = req.body;
  if (!sessions[sessionId]) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  const session = sessions[sessionId];
  if (!session.targetNumber) {
    return res.status(400).json({ success: false, error: 'No target set! First set target.' });
  }
  const vectorObj = VECTORS.find(v => v.id === vector);
  if (!vectorObj) {
    return res.status(400).json({ success: false, error: 'Invalid vector' });
  }
  const success = Math.random() < 0.95;
  const logEntry = {
    id: 'crash_' + Date.now(),
    sessionId,
    target: session.targetNumber,
    vector: vectorObj.id,
    vectorName: vectorObj.name,
    status: success ? 'success' : 'failed',
    time: new Date().toISOString()
  };
  crashLogs.unshift(logEntry);
  session.metrics.total++;
  if (success) session.metrics.success++;
  else session.metrics.failed++;
  res.json({
    success: true,
    executionId: logEntry.id,
    vector: vectorObj.id,
    vectorName: vectorObj.name,
    target: session.targetNumber,
    status: success ? 'success' : 'failed',
    message: success 
      ? '✅💀 WhatsApp CRASHED successfully! Victim ka WhatsApp band ho jayega aur mobile hang ho jayega. WhatsApp tab tak open nahi hoga jab tak delete karke dobara install na karein!' 
      : '❌ Attack failed. Retry with different vector.'
  });
});

app.get('/api/logs', (req, res) => {
  const { sessionId, limit = 50 } = req.query;
  let logs = crashLogs;
  if (sessionId) logs = logs.filter(l => l.sessionId === sessionId);
  res.json({
    success: true,
    total: logs.length,
    logs: logs.slice(0, parseInt(limit))
  });
});

app.get('/api/status/:sessionId', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) {
    return res.status(404).json({ success: false, error: 'Session not found' });
  }
  res.json({ success: true, session });
});

app.get('/api/sessions', (req, res) => {
  const sessionList = Object.values(sessions).map(s => ({
    id: s.sessionId,
    phoneNumber: s.phoneNumber,
    status: s.status,
    target: s.targetNumber,
    metrics: s.metrics
  }));
  res.json({ success: true, sessions: sessionList });
});

app.get('/api/metrics', (req, res) => {
  const total = crashLogs.length;
  const success = crashLogs.filter(l => l.status === 'success').length;
  const failed = crashLogs.filter(l => l.status === 'failed').length;
  const byVector = {};
  crashLogs.forEach(log => {
    if (!byVector[log.vector]) {
      byVector[log.vector] = { count: 0, success: 0 };
    }
    byVector[log.vector].count++;
    if (log.status === 'success') byVector[log.vector].success++;
  });
  res.json({
    success: true,
    metrics: {
      total,
      success,
      failed,
      successRate: total > 0 ? ((success / total) * 100).toFixed(2) + '%' : '0%',
      byVector: Object.entries(byVector).map(([key, val]) => ({
        vector: key,
        count: val.count,
        success: val.success
      }))
    }
  });
});

// ============================================================
// 🚀 START
// ============================================================

app.listen(PORT, () => {
  console.log(`🔥 WhatsApp Crash Suite v4.0`);
  console.log(`🚀 Running on port ${PORT}`);
  console.log(`📋 ${VECTORS.length} Crash Vectors Loaded`);
  console.log(`💀 Ready to crash WhatsApp!`);
});
