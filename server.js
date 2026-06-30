// ═══════════════════════════════════════════════════════════════
// SARVAM PROXY SERVER
// Bridges browser WebSocket connections (which can't send custom
// auth headers) to Sarvam AI's streaming STT WebSocket (which
// requires an Api-Subscription-Key header).
//
// Browser  --ws-->  This proxy  --ws+header-->  Sarvam AI
//
// Deploy free on Render.com or Railway.app
// Env var required: SARVAM_API_KEY
// ═══════════════════════════════════════════════════════════════

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY || '';

if (!SARVAM_API_KEY) {
  console.error('❌ SARVAM_API_KEY environment variable is not set!');
}

// Simple HTTP server for health checks (Render/Railway need this)
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'sarvam-proxy', hasKey: !!SARVAM_API_KEY }));
    return;
  }
  res.writeHead(404);
  res.end('Not found');
});

// WebSocket server that browsers connect to
const wss = new WebSocket.Server({ server, path: '/stt' });

wss.on('connection', (clientWs, req) => {
  console.log('✅ Browser client connected');

  // Parse query params from client connection (language, model etc.)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const languageCode = url.searchParams.get('language_code') || 'hi-IN';
  const model = url.searchParams.get('model') || 'saarika:v2.5';
  const sampleRate = url.searchParams.get('sample_rate') || '16000';

  if (!SARVAM_API_KEY) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'Server missing SARVAM_API_KEY' }));
    clientWs.close();
    return;
  }

  // Build Sarvam WebSocket URL with query params (model, language)
  const sarvamUrl = `wss://api.sarvam.ai/speech-to-text/ws?language-code=${languageCode}&model=${model}&sample_rate=${sampleRate}`;

  // Connect to Sarvam with the required auth header (only possible server-side)
  const sarvamWs = new WebSocket(sarvamUrl, {
    headers: { 'Api-Subscription-Key': SARVAM_API_KEY }
  });

  let sarvamReady = false;
  const pendingAudio = [];

  sarvamWs.on('open', () => {
    sarvamReady = true;
    console.log('✅ Connected to Sarvam AI');
    clientWs.send(JSON.stringify({ type: 'ready' }));
    // Flush any audio that arrived before Sarvam was ready
    while (pendingAudio.length) {
      sarvamWs.send(pendingAudio.shift());
    }
  });

  // Relay messages from Sarvam back to the browser client
  sarvamWs.on('message', (data) => {
    try {
      clientWs.send(data.toString());
    } catch (e) {
      console.error('Error relaying to client:', e.message);
    }
  });

  sarvamWs.on('error', (err) => {
    console.error('❌ Sarvam WS error:', err.message);
    try {
      clientWs.send(JSON.stringify({ type: 'error', message: 'Sarvam connection error: ' + err.message }));
    } catch (e) {}
  });

  sarvamWs.on('close', (code, reason) => {
    console.log(`Sarvam WS closed: ${code} ${reason}`);
    try {
      clientWs.send(JSON.stringify({ type: 'closed', code, reason: reason.toString() }));
      clientWs.close();
    } catch (e) {}
  });

  // Relay audio data from browser client to Sarvam
  clientWs.on('message', (data) => {
    if (sarvamReady && sarvamWs.readyState === WebSocket.OPEN) {
      sarvamWs.send(data);
    } else {
      // Buffer audio until Sarvam connection is ready
      pendingAudio.push(data);
    }
  });

  clientWs.on('close', () => {
    console.log('Browser client disconnected');
    if (sarvamWs.readyState === WebSocket.OPEN || sarvamWs.readyState === WebSocket.CONNECTING) {
      sarvamWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error('Client WS error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Sarvam proxy listening on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   WebSocket endpoint: ws://localhost:${PORT}/stt`);
});
