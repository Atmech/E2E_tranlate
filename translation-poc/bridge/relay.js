// Local TCP→WS relay. Run alongside Asterisk (inside the house).
// Asterisk connects to TCP :9092 as usual; relay forwards binary frames
// to the bridge running on Render via WebSocket.
//
// Usage: node bridge/relay.js wss://your-bridge.onrender.com
//        RENDER_URL=wss://your-bridge.onrender.com node bridge/relay.js
import 'dotenv/config';
import net from 'node:net';
import { WebSocket } from 'ws';

const RENDER_URL = process.argv[2] || process.env.RENDER_URL;
if (!RENDER_URL) {
  console.error('Usage: node bridge/relay.js wss://<render-host>');
  process.exit(1);
}

const WS_PATH = '/audiosocket';
const TCP_PORT = Number(process.env.AUDIOSOCKET_PORT || 9092);

const wsUrl = RENDER_URL.replace(/\/$/, '') + WS_PATH;
console.log(`relay: TCP :${TCP_PORT} → ${wsUrl}`);

net.createServer((tcp) => {
  console.log('[relay] asterisk connected');
  tcp.setNoDelay(true); // disable Nagle: send each 20ms audio frame immediately, no coalescing wait
  const ws = new WebSocket(wsUrl);

  // Asterisk sends the UUID frame the instant it connects, but the WS handshake to a
  // remote bridge isn't open yet. Buffer everything until the WS opens, then flush in
  // order — otherwise the UUID frame is lost and the bridge never registers the call.
  const queue = [];
  ws.on('open', () => {
    console.log('[relay] ws open');
    for (const chunk of queue) ws.send(chunk, { binary: true });
    queue.length = 0;
  });
  ws.on('error', (e) => { console.error('[relay] ws error:', e.message); tcp.destroy(); });
  ws.on('close', () => { console.log('[relay] ws closed'); tcp.destroy(); });

  // Asterisk → bridge (queue until WS open, then stream)
  tcp.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
    else queue.push(chunk);
  });

  // bridge → Asterisk
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    tcp.write(buf);
  });

  tcp.on('close', () => { console.log('[relay] tcp closed'); ws.close(); });
  tcp.on('error', (e) => { console.error('[relay] tcp error:', e.message); ws.close(); });
}).listen(TCP_PORT, () => console.log(`[relay] listening on TCP :${TCP_PORT}`));
