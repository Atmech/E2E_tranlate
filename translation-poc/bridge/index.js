// Entry point:
//   - TCP server (AudioSocket) for Asterisk        :AUDIOSOCKET_PORT
//   - HTTP server: GET /health + static agent-ui/   :BRIDGE_HTTP_PORT
//   - WS /agent on the HTTP server for the browser agent
//   - WS /media for native Asterisk media; /audiosocket for the legacy relay
import 'dotenv/config';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createParser, FRAME } from './audiosocket.js';
import { CallBridge } from './CallBridge.js';
import { handleNativeConnection } from './native-websocket.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', 'agent-ui');

const HTTP_PORT = Number(process.env.PORT || process.env.BRIDGE_HTTP_PORT || 8080);
const AS_PORT = Number(process.env.AUDIOSOCKET_PORT || 9092);
const AGENT_WS_PATH = process.env.AGENT_WS_PATH || '/agent';
const AS_WS_PATH = '/audiosocket'; // AudioSocket-over-WS for relay clients

if (!process.env.GEMINI_API_KEY) {
  console.error('FATAL: GEMINI_API_KEY missing. Copy .env.example to .env.');
  process.exit(1);
}

const activeCalls = new Map(); // callId -> legacy CallBridge or paired CallTranslationSession
const agents = new Set();      // currently connected agent WS sockets

// ---- AudioSocket TCP server (Asterisk connects here) ----
const tcp = net.createServer((sock) => {
  sock.setNoDelay(true); // disable Nagle: forward each 20ms audio frame without coalescing delay
  let bridge = null;
  let callId = null;

  const parser = createParser(async (type, payload) => {
    switch (type) {
      case FRAME.UUID: {
        if (bridge) { sock.end(); return; }
        callId = payload.toString('hex');
        if (activeCalls.size > 0) {
          console.warn('[as] rejecting concurrent call: single-call POC');
          sock.end();
          return;
        }
        bridge = new CallBridge(callId, sock);
        activeCalls.set(callId, bridge);
        console.log(`[as] call up: ${callId}`);
        try {
          await bridge.init();
          // Attach any agent sockets already connected when the call came up.
          for (const agentWs of agents) bridge.attachAgent(agentWs);
        } catch (e) {
          console.error(`[as] init failed for ${callId}:`, e?.message || e);
          bridge.close();
          if (activeCalls.get(callId) === bridge) activeCalls.delete(callId);
          sock.destroy();
        }
        break;
      }
      case FRAME.AUDIO:
        bridge?.onCallAudio(payload);
        break;
      case FRAME.DTMF:
        console.log(`[as] dtmf ${callId}:`, payload.toString('ascii'));
        break;
      case FRAME.HANGUP:
        teardown();
        sock.end();
        break;
      case FRAME.ERROR:
        console.error(`[as] error frame ${callId}:`, payload);
        break;
      default:
        break;
    }
  });

  sock.on('data', (chunk) => parser(chunk));
  const teardown = () => {
    if (bridge && activeCalls.get(callId) === bridge) {
      bridge.close();
      activeCalls.delete(callId);
    }
  };
  sock.on('end', teardown);
  sock.on('close', teardown);
  sock.on('error', (e) => { console.error('[as] socket error:', e?.message || e); teardown(); });
});

tcp.listen(AS_PORT, () => console.log(`audiosocket on :${AS_PORT}`));

// ---- HTTP server (health + static UI) ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeCalls: activeCalls.size }));
    return;
  }
  // static serve agent-ui/
  const rel = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(UI_DIR, path.normalize(rel));
  if (!file.startsWith(UI_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WS /agent (browser) ----
// Both WS servers share one HTTP server, so use noServer + a single upgrade router.
// (Attaching multiple WebSocketServer({server,path}) makes the first one 400 every
//  upgrade whose path it doesn't own, before the second can handle it.)
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  console.log('[agent] connected');
  agents.add(ws);
  // Resolve on every message: a browser can stay connected across multiple calls.
  const bindToLiveCall = () => {
    const live = activeCalls.values().next().value;
    if (!live?.ready || live.closed || live.acceptsBrowserAudio === false) return null;
    live.attachAgent(ws); // idempotent; does not reset PTT for every audio packet
    return live;
  };
  bindToLiveCall();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !['join', 'audio', 'ptt'].includes(msg.type)) return;
    const bound = bindToLiveCall();
    if (msg.type === 'join') {
      ws.send(JSON.stringify({ type: 'joined', ok: !!bound, pending: activeCalls.size > 0 }));
    } else if (msg.type === 'audio' && typeof msg.data === 'string') {
      bound?.onAgentAudio(msg.data);
    } else if (msg.type === 'ptt') {
      bound?.setPtt(!!msg.active);
    }
  });

  ws.on('close', () => {
    agents.delete(ws);
    for (const call of activeCalls.values()) call.detachAgent?.(ws);
    console.log('[agent] disconnected');
  });
});

// ---- WS /audiosocket (relay.js connects here instead of raw TCP) ----
// Wraps each WS connection in a socket-like shim so CallBridge sees the same interface.
const asWss = new WebSocketServer({ noServer: true });
// Native chan_websocket uses raw PCM and text control events, not AudioSocket frames.
const mediaWss = new WebSocketServer({ noServer: true, maxPayload: 65500 });
mediaWss.on('connection', ws => handleNativeConnection(ws, {
  activeCalls, agents, createBridge: (...args) => new CallBridge(...args),
}));

// Single upgrade handler routes by pathname to the right WS server.
httpServer.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === AGENT_WS_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (pathname === AS_WS_PATH) {
    asWss.handleUpgrade(req, socket, head, (ws) => asWss.emit('connection', ws, req));
  } else if (pathname === '/media') {
    mediaWss.handleUpgrade(req, socket, head, (ws) => mediaWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});
asWss.on('connection', (ws) => {
  let bridge = null;
  let callId = null;

  // Shim: CallBridge/OutputPacer call sock.write(buf) to send audio back to Asterisk.
  // We forward those bytes as binary WS messages to relay.js which writes them to TCP.
  const sockShim = {
    destroyed: false,
    writable: true,
    write(buf) { if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true }); },
    end() { ws.close(); },
  };

  const parser = createParser(async (type, payload) => {
    switch (type) {
      case FRAME.UUID: {
        if (bridge) { ws.close(); return; }
        callId = payload.toString('hex');
        if (activeCalls.size > 0) {
          console.warn('[asws] rejecting concurrent call: single-call POC');
          ws.close();
          return;
        }
        bridge = new CallBridge(callId, sockShim);
        activeCalls.set(callId, bridge);
        console.log(`[asws] call up: ${callId}`);
        try {
          await bridge.init();
          for (const agentWs of agents) bridge.attachAgent(agentWs);
        } catch (e) {
          console.error(`[asws] init failed for ${callId}:`, e?.message || e);
          bridge.close();
          if (activeCalls.get(callId) === bridge) activeCalls.delete(callId);
          ws.close();
        }
        break;
      }
      case FRAME.AUDIO: bridge?.onCallAudio(payload); break;
      case FRAME.DTMF: console.log(`[asws] dtmf ${callId}:`, payload.toString('ascii')); break;
      case FRAME.HANGUP: teardown(); ws.close(); break;
      case FRAME.ERROR: console.error(`[asws] error frame ${callId}:`, payload); break;
      default: break;
    }
  });

  ws.on('message', (data) => parser(Buffer.isBuffer(data) ? data : Buffer.from(data)));
  const teardown = () => {
    sockShim.destroyed = true; sockShim.writable = false;
    if (bridge && activeCalls.get(callId) === bridge) {
      bridge.close();
      activeCalls.delete(callId);
    }
  };
  ws.on('close', teardown);
  ws.on('error', (e) => { console.error('[asws] error:', e?.message || e); teardown(); });
  console.log('[asws] relay connected');
});

httpServer.listen(HTTP_PORT, () => console.log(`http on :${HTTP_PORT} (agent ui + ws ${AGENT_WS_PATH} + audiosocket ws ${AS_WS_PATH} + native ws /media)`));
