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
const https = require('https');

const PORT = process.env.PORT || 8080;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY || '';

if (!SARVAM_API_KEY) {
  console.error('❌ SARVAM_API_KEY environment variable is not set!');
}

// Simple HTTP server for health checks + file transcription relay
const server = http.createServer((req, res) => {
  // CORS headers — allow the GitHub Pages app to call this proxy directly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'sarvam-proxy', hasKey: !!SARVAM_API_KEY }));
    return;
  }

  // Relay recording-upload transcription requests to Sarvam's REST API.
  // Browser talks to us (CORS-enabled above), we forward server-to-server
  // to Sarvam with the auth header that browsers can't reliably attach
  // for multipart requests across origins.
  if (req.url === '/transcribe-file' && req.method === 'POST') {
    if (!SARVAM_API_KEY) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server missing SARVAM_API_KEY' }));
      return;
    }
    const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30MB safety cap (REST endpoint is for <30s clips anyway)
    const contentType = req.headers['content-type'] || 'multipart/form-data';
    const chunks = [];
    let totalSize = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD_BYTES && !aborted) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large — use the Batch API for files over 30s/30MB' }));
        req.destroy();
        return;
      }
      if (!aborted) chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);
      const sarvamReq = https.request(
        'https://api.sarvam.ai/speech-to-text',
        {
          method: 'POST',
          headers: {
            'api-subscription-key': SARVAM_API_KEY,
            'Content-Type': contentType,
            'Content-Length': body.length
          },
          timeout: 60000 // 60s — generous for a <30s audio clip plus model inference time
        },
        (sarvamRes) => {
          let respBody = '';
          sarvamRes.on('data', (c) => { respBody += c; });
          sarvamRes.on('end', () => {
            res.writeHead(sarvamRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(respBody);
          });
        }
      );
      sarvamReq.on('timeout', () => {
        console.error('❌ Sarvam REST relay timed out');
        sarvamReq.destroy();
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Sarvam took too long to respond' }));
        }
      });
      sarvamReq.on('error', (err) => {
        console.error('❌ Sarvam REST relay error:', err.message);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Proxy relay failed: ' + err.message }));
        }
      });
      sarvamReq.write(body);
      sarvamReq.end();
    });

    req.on('error', (err) => {
      console.error('❌ Incoming upload request error:', err.message);
    });

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
  // saaras:v3 is the current recommended streaming model per Sarvam docs (better accuracy
  // than legacy saarika:v2.5). Client can still override via ?model=saarika:v2.5 if needed.
  const model = url.searchParams.get('model') || 'saaras:v3';
  const sampleRate = url.searchParams.get('sample_rate') || '16000';
  // mode only applies to saaras:v3 — 'transcribe' keeps output in the spoken language (Hindi)
  const mode = url.searchParams.get('mode') || 'transcribe';

  if (!SARVAM_API_KEY) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'Server missing SARVAM_API_KEY' }));
    clientWs.close();
    return;
  }

  // Build Sarvam WebSocket URL with query params (model, language)
  let sarvamUrl = `wss://api.sarvam.ai/speech-to-text/ws?language-code=${languageCode}&model=${model}&sample_rate=${sampleRate}&high_vad_sensitivity=true&vad_signals=true`;
  if (model === 'saaras:v3') sarvamUrl += `&mode=${mode}`;
  console.log('→ Connecting to Sarvam:', sarvamUrl);

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
    while (pendingAudio.length) {
      sarvamWs.send(pendingAudio.shift());
    }
  });

  // Keepalive: ping both legs every 20s so neither the browser<->proxy nor
  // proxy<->Sarvam connection gets dropped during natural pauses in speech
  // (many proxies/load-balancers idle-timeout WebSockets after ~30-60s of silence).
  const keepaliveInterval = setInterval(() => {
    if (sarvamWs.readyState === WebSocket.OPEN) {
      try { sarvamWs.ping(); } catch(e) {}
    }
    if (clientWs.readyState === WebSocket.OPEN) {
      try { clientWs.ping(); } catch(e) {}
    }
  }, 20000);

  // Relay messages from Sarvam back to the browser client
  sarvamWs.on('message', (data) => {
    try {
      clientWs.send(data.toString());
    } catch (e) {
      console.error('Error relaying to client:', e.message);
    }
  });

  // 'unexpected-response' fires when Sarvam rejects the handshake itself (403 bad auth,
  // 400 bad params) — carries the real HTTP status + body, the most useful signal for
  // diagnosing "invalid api key" type failures.
  sarvamWs.on('unexpected-response', (request, response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      console.error(`❌ Sarvam rejected handshake: HTTP ${response.statusCode} — ${body}`);
      try {
        clientWs.send(JSON.stringify({
          type: 'error',
          message: `Sarvam auth/connection failed (HTTP ${response.statusCode}): ${body || response.statusMessage}`
        }));
        clientWs.close();
      } catch (e) {}
    });
  });

  sarvamWs.on('error', (err) => {
    console.error('❌ Sarvam WS error:', err.message);
    try {
      clientWs.send(JSON.stringify({ type: 'error', message: 'Sarvam connection error: ' + err.message }));
    } catch (e) {}
  });

  sarvamWs.on('close', (code, reason) => {
    console.log(`Sarvam WS closed: ${code} ${reason}`);
    clearInterval(keepaliveInterval);
    try {
      clientWs.send(JSON.stringify({ type: 'closed', code, reason: reason.toString() }));
      clientWs.close();
    } catch (e) {}
  });

  // Relay audio data (JSON messages with base64 audio) from browser client to Sarvam
  const MAX_PENDING_CHUNKS = 200; // ~safety cap (~a few seconds of audio at 4096-sample chunks)
  clientWs.on('message', (data) => {
    // data is a JSON string like {"audio":{"data":"...","encoding":"audio/wav","sample_rate":"16000"}}
    if (sarvamReady && sarvamWs.readyState === WebSocket.OPEN) {
      sarvamWs.send(data);
    } else if (sarvamWs.readyState === WebSocket.CONNECTING) {
      // Buffer audio until Sarvam connection is ready, but cap it so a stuck
      // connection can't accumulate unbounded memory.
      if (pendingAudio.length < MAX_PENDING_CHUNKS) {
        pendingAudio.push(data);
      }
    }
    // If sarvamWs is CLOSING/CLOSED, silently drop — nothing useful to do with it.
  });

  clientWs.on('close', () => {
    console.log('Browser client disconnected');
    clearInterval(keepaliveInterval);
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
