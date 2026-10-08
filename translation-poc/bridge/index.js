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
import { CallMonitor } from './CallMonitor.js';
import { createMonitorHandler } from './monitor-http.js';
import { ConnectionLimits } from './connection-limits.js';

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

const limits = new ConnectionLimits();
const activeCalls = new Map(); // callId -> legacy CallBridge or paired CallTranslationSession
const agents = new Set();      // currently connected agent WS sockets
const monitor = new CallMonitor();
const handleMonitor = createMonitorHandler(monitor);

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
          monitor.event(null, 'warning', 'Legacy TCP call rejected: another call is active');
          sock.end();
          return;
        }
        bridge = new CallBridge(callId, sock, { monitor, onClose: () => { if (activeCalls.get(callId) === bridge) activeCalls.delete(callId); } });
        activeCalls.set(callId, bridge);
        console.log(`[as] call up: ${callId}`);
        try {
          await bridge.init();
          // Attach any agent sockets already connected when the call came up.
          for (const agentWs of agents) bridge.attachAgent(agentWs);
        } catch (e) {
          console.error(`[as] init failed for ${callId}:`, e?.message || e);
          bridge.reportFailure?.('caller', e);
          bridge.close('Translator setup failed', true);
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
        monitor.event(bridge?.monitorId, 'error', 'Asterisk AudioSocket error frame');
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
  sock.on('error', (e) => {
    console.error('[as] socket error:', e?.message || e);
    if (bridge) bridge.close('AudioSocket transport error', true);
    else monitor.event(null, 'error', 'AudioSocket transport error before call setup');
    teardown();
  });
});

tcp.listen(AS_PORT, () => console.log(`audiosocket on :${AS_PORT}`));

// ---- HTTP server (health + static UI) ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const httpServer = http.createServer(async (req, res) => {
  try { if (await handleMonitor(req, res)) return; }
  catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('Monitor unavailable'); return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeCalls: activeCalls.size }));
    return;
  }
  // static serve agent-ui/
  const pathname = new URL(req.url, 'http://localhost').pathname;
  // The legacy demo has one public file. Never expose monitor assets or sibling directories.
  if (!['/', '/index.html'].includes(pathname)) { res.writeHead(404); res.end('not found'); return; }
  const file = path.join(UI_DIR, 'index.html');
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
// Browser PCM is JSON/base64 (at most 100ms per normal message).
const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
wss.on('connection', (ws) => {
  limits.track(ws);
  console.log('[agent] connected');
  agents.add(ws);
  let failed = false;
  const detach = () => {
    agents.delete(ws);
    for (const call of activeCalls.values()) call.detachAgent?.(ws);
  };
  // ws emits an error for malformed protocol frames before closing the socket.
  // Handle it locally; leaving this event unhandled terminates the whole process.
  ws.on('error', () => {
    failed = true;
    detach();
    monitor.event(null, 'error', 'Browser agent WebSocket error');
  });
  ws.on('close', () => {
    detach();
    console.log('[agent] disconnected');
  });
  const failMessage = () => {
    failed = true;
    detach();
    monitor.event(null, 'error', 'Browser agent message processing failed');
    ws.close(1011, 'Agent message processing failed');
  };
  // Resolve on every message: a browser can stay connected across multiple calls.
  const bindToLiveCall = () => {
    const live = activeCalls.values().next().value;
    if (!live?.ready || live.closed || live.acceptsBrowserAudio === false) return null;
    live.attachAgent(ws); // idempotent; does not reset PTT for every audio packet
    return live;
  };
  try { bindToLiveCall(); } catch { failMessage(); }

  ws.on('message', (raw) => {
    if (failed) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || !['join', 'audio', 'ptt'].includes(msg.type)) return;
    try {
      const bound = bindToLiveCall();
      if (msg.type === 'join') {
        ws.send(JSON.stringify({ type: 'joined', ok: !!bound, pending: activeCalls.size > 0 }));
      } else if (msg.type === 'audio' && typeof msg.data === 'string') {
        bound?.onAgentAudio(msg.data);
      } else if (msg.type === 'ptt') {
        bound?.setPtt(!!msg.active);
      }
    } catch { failMessage(); }
  });
});

// ---- WS /audiosocket (relay.js connects here instead of raw TCP) ----
// Wraps each WS connection in a socket-like shim so CallBridge sees the same interface.
// Allow a full 65535-byte AudioSocket payload plus framing and coalesced frames.
const asWss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
// Native chan_websocket uses raw PCM and text control events, not AudioSocket frames.
const mediaWss = new WebSocketServer({ noServer: true, maxPayload: 65500 });
mediaWss.on('connection', ws => {
  limits.track(ws);
  handleNativeConnection(ws, {
    activeCalls, agents, monitor, maxCalls: limits.maxCalls,
    createBridge: (id, sock, options) => new CallBridge(id, sock, { ...options, monitor }),
  });
});

// Single upgrade handler routes by pathname to the right WS server.
httpServer.on('upgrade', (req, socket, head) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch { socket.destroy(); return; }
  if (![AGENT_WS_PATH, AS_WS_PATH, '/media'].includes(pathname)) { socket.destroy(); return; }
  const rejection = limits.checkUpgrade();
  if (rejection) {
    socket.end(`HTTP/1.1 ${rejection} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
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
  limits.track(ws);
  let bridge = null;
  let callId = null;

  // Shim: CallBridge/OutputPacer call sock.write(buf) to send audio back to Asterisk.
  // We forward those bytes as binary WS messages to relay.js which writes them to TCP.
  const sockShim = {
    destroyed: false,
    writable: true,
    get bufferedAmount() { return ws.bufferedAmount; },
    write(buf) { if (ws.readyState === ws.OPEN) ws.send(buf, { binary: true }); },
    end() { ws.close(); },
  };

  const parser = createParser(async (type, payload) => {
    try {
      switch (type) {
        case FRAME.UUID: {
          if (bridge) { ws.close(); return; }
          callId = payload.toString('hex');
          if (activeCalls.size > 0) {
            console.warn('[asws] rejecting concurrent call: single-call POC');
            monitor.event(null, 'warning', 'Legacy relay call rejected: another call is active');
            ws.close();
            return;
          }
          bridge = new CallBridge(callId, sockShim, { monitor, onClose: () => { if (activeCalls.get(callId) === bridge) activeCalls.delete(callId); } });
          activeCalls.set(callId, bridge);
          console.log(`[asws] call up: ${callId}`);
          try {
            await bridge.init();
            for (const agentWs of agents) bridge.attachAgent(agentWs);
          } catch (e) {
            console.error(`[asws] init failed for ${callId}:`, e?.message || e);
            bridge.reportFailure?.('caller', e);
            bridge.close('Translator setup failed', true);
            if (activeCalls.get(callId) === bridge) activeCalls.delete(callId);
            ws.close();
          }
          break;
        }
        case FRAME.AUDIO: bridge?.onCallAudio(payload); break;
        case FRAME.DTMF: console.log(`[asws] dtmf ${callId}:`, payload.toString('ascii')); break;
        case FRAME.HANGUP: teardown(); ws.close(); break;
        case FRAME.ERROR:
          monitor.event(bridge?.monitorId, 'error', 'Asterisk relay error frame');
          console.error(`[asws] error frame ${callId}:`, payload); break;
        default: break;
      }
    } catch {
      monitor.event(bridge?.monitorId, 'error', 'Relay message processing failed');
      teardown();
      ws.close(1011, 'Relay message processing failed');
    }
  });

  ws.on('message', (data) => {
    if (sockShim.destroyed) return;
    try { parser(Buffer.isBuffer(data) ? data : Buffer.from(data)); }
    catch {
      monitor.event(bridge?.monitorId, 'error', 'Relay frame parsing failed');
      teardown();
      ws.close(1011, 'Relay frame parsing failed');
    }
  });
  const teardown = () => {
    sockShim.destroyed = true; sockShim.writable = false;
    if (bridge && activeCalls.get(callId) === bridge) {
      bridge.close();
      activeCalls.delete(callId);
    }
  };
  ws.on('close', teardown);
  ws.on('error', (e) => {
    console.error('[asws] error:', e?.message || e);
    if (bridge) bridge.close('Relay transport error', true);
    else monitor.event(null, 'error', 'Relay transport error before call setup');
    teardown();
  });
  console.log('[asws] relay connected');
});

httpServer.listen(HTTP_PORT, () => console.log(`http on :${HTTP_PORT} (agent ui + ws ${AGENT_WS_PATH} + audiosocket ws ${AS_WS_PATH} + native ws /media)`));
