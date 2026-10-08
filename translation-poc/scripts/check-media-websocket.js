// Explicit local network integration check: npm run test:media-ws (no Gemini or Asterisk).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { handleNativeConnection } from '../bridge/native-websocket.js';

test('two real /media sockets negotiate media, pair and cross-route PCM', { timeout: 5000 }, async t => {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/media', maxPayload: 65500 });
  const activeCalls = new Map(), clients = [];
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  wss.on('connection', ws => handleNativeConnection(ws, {
    activeCalls, mode: 'translation',
    createTranslator: (lang, callbacks) => ({
      async start() {}, close() {},
      feed(input) {
        assert.equal(input.length, 320);
        callbacks.onAudio(new Int16Array(480).fill(lang === 'en' ? 1111 : -2222));
        callbacks.onTurnEnd();
      },
    }),
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  for (const role of ['caller', 'agent']) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/media`, 'media');
    clients.push(ws); await once(ws, 'open');
    assert.equal(ws.protocol, 'media');
    ws.send(JSON.stringify({ event: 'MEDIA_START', connection_id: 'translation_media',
      format: 'slin', optimal_frame_size: 320, ptime: 20,
      channel_variables: { CALL_ID: 'real-call', ROLE: role,
        SOURCE_LANG: role === 'caller' ? 'hi' : 'en', TARGET_LANG: role === 'caller' ? 'en' : 'hi' },
    }));
  }
  for (let n = 0; n < 100 && !activeCalls.get('real-call')?.ready; n++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(activeCalls.get('real-call')?.ready, true);
  const [caller, agent] = clients;
  let callerMessages = 0, agentMessages = 0;
  caller.on('message', () => callerMessages++); agent.on('message', () => agentMessages++);
  const agentAudio = once(agent, 'message');
  caller.send(Buffer.alloc(320, 1));
  const [toAgent, agentBinary] = await agentAudio;
  assert.equal(agentBinary, true); assert.equal(toAgent.length, 320);
  assert.equal(toAgent.readInt16LE(318), 1111); assert.equal(callerMessages, 0);
  const callerAudio = once(caller, 'message');
  agent.send(Buffer.alloc(320, 2));
  const [toCaller, callerBinary] = await callerAudio;
  assert.equal(callerBinary, true); assert.equal(toCaller.length, 320);
  assert.equal(toCaller.readInt16LE(318), -2222); assert.equal(agentMessages, 1);
  const closed = Promise.all(clients.map(ws => once(ws, 'close')));
  caller.close(1000); await closed;
  assert.equal(activeCalls.size, 0);
});
