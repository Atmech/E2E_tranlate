// Real Asterisk round-trip test through extension 5000. No Gemini key or phone needed.
// Stop npm start first: this temporarily owns the same localhost:8080 /media endpoint.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { handleNativeConnection } from '../bridge/native-websocket.js';

const cli = command => execFileSync('docker', ['exec', 'translation-asterisk', 'asterisk', '-rx', command], { encoding: 'utf8', timeout: 10000 });
const server = http.createServer();
const wss = new WebSocketServer({ server, path: '/media', maxPayload: 65500 });
const activeCalls = new Map();
const marker = Buffer.alloc(320);
for (let i = 0; i < 160; i++) marker.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * 440 * i / 8000)), i * 2);
let current;
wss.on('connection', ws => handleNativeConnection(ws, {
  activeCalls, agents: new Set(),
  createBridge: (id, sock, { pacer }) => ({
    async init() {
      current.id = id;
      pacer.start();
      pacer.push(Buffer.concat(Array(25).fill(marker)));
      pacer.commit();
    },
    onCallAudio(pcm) {
      current.received++;
      // Asterisk's Echo application must return the exact PCM we sent, not just silence.
      if (pcm.includes(marker)) current.matched++;
      if (current.matched === 3) sock.end();
    },
    attachAgent() {},
    close() { pacer.stop(); current.resolve(); },
  }),
}));

try {
  console.log(cli('core show version').trim());
  assert.match(cli('module show like chan_websocket'), /Running/);
  assert.match(cli('dialplan show 5000@demo'), /WebSocket\/translation\/c\(slin\)/);
  server.listen(8080); await once(server, 'listening');
  for (let n = 1; n <= 2; n++) {
    let timer;
    const done = new Promise((resolve, reject) => {
      current = { received: 0, matched: 0, resolve };
      timer = setTimeout(() => reject(new Error('No PCM round-trip within 15 seconds')), 15000);
    });
    try {
      cli('channel originate Local/5000@demo/n application Echo');
      await done;
      assert.ok(current.matched >= 3, 'Expected three exact raw PCM frames echoed by Asterisk');
      assert.equal(activeCalls.size, 0, 'Hangup must release the active call');
      // Wait for Asterisk to tear down both Local legs before the next call.
      for (let i = 0; i < 30; i++) {
        if (!cli('core show channels concise').includes('Local/5000@demo')) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(!cli('core show channels concise').includes('Local/5000@demo'), 'Asterisk call did not hang up');
      console.log(`PASS call ${n}: MEDIA_START, ${current.matched} exact PCM echoes, clean hangup (${current.id})`);
    } finally { clearTimeout(timer); }
  }
  console.log('PASS: native WebSocket media, real dialplan, bidirectional PCM, sequential calls. No relay, no Gemini.');
} finally {
  for (const ws of wss.clients) ws.terminate();
  wss.close(); server.close();
}
