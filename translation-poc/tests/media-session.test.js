import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleNativeConnection } from '../bridge/native-websocket.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const mediaStart = (role, overrides = {}) => ({
  event: 'MEDIA_START', connection_id: 'translation_media',
  format: 'slin', optimal_frame_size: 320, ptime: 20,
  channel_variables: { CALL_ID: 'abc123', ROLE: role,
    SOURCE_LANG: role === 'caller' ? 'hi' : 'en',
    TARGET_LANG: role === 'caller' ? 'en' : 'hi', ...overrides },
});
function harness(t, { start, setupTimeoutMs, maxCalls = Infinity } = {}) {
  const activeCalls = new Map(), translators = [];
  const createTranslator = (targetLang, callbacks) => {
    const translator = { targetLang, callbacks, feeds: [], closed: false,
      async start() { await start?.(this); },
      feed(pcm) { this.feeds.push(pcm); },
      close() { this.closed = true; },
    };
    translators.push(translator);
    return translator;
  };
  function connect(role, overrides) {
    const ws = new EventEmitter();
    Object.assign(ws, { readyState: 1, bufferedAmount: 0, sent: [] });
    ws.send = (data, options) => ws.sent.push({ data, options });
    ws.close = (code, reason) => {
      if (ws.readyState === 3) return;
      Object.assign(ws, { readyState: 3, closeCode: code, closeReason: reason });
      ws.emit('close');
    };
    ws.control = event => ws.emit('message', Buffer.from(JSON.stringify(event)), false);
    ws.audio = pcm => ws.emit('message', pcm, true);
    handleNativeConnection(ws, { activeCalls, mode: 'translation', createTranslator, setupTimeoutMs, maxCalls });
    t.after(() => ws.close(1000));
    if (role) ws.control(mediaStart(role, overrides));
    return ws;
  }
  return { activeCalls, translators, connect,
    session: () => activeCalls.get('abc123'),
    translator: role => translators.find(tr => tr.targetLang === (role === 'caller' ? 'en' : 'hi')),
  };
}
function output(translator, value) {
  translator.callbacks.onAudio(new Int16Array(480).fill(value)); // 20ms @ 24kHz
  translator.callbacks.onTurnEnd();
}

for (const firstRole of ['caller', 'agent']) test(`pair ${firstRole} first; translate to opposite socket only`, async t => {
  const h = harness(t);
  const first = h.connect(firstRole);
  first.audio(Buffer.alloc(320));
  assert.equal(h.translators.length, 0, 'wait for peer before spending on models');
  assert.equal(h.session().legs.get(firstRole).droppedBytes, 320);
  const second = h.connect(firstRole === 'caller' ? 'agent' : 'caller');
  await settle();
  const caller = firstRole === 'caller' ? first : second;
  const agent = firstRole === 'agent' ? first : second;
  assert.equal(h.activeCalls.size, 1, 'same connection_id does not prevent pairing by CALL_ID');
  assert.equal(h.session().ready, true);
  assert.equal(h.session().acceptsBrowserAudio, false);
  caller.audio(Buffer.alloc(320, 1));
  assert.equal(h.translator('caller').feeds[0].length, 320, '8kHz -> 16kHz');
  assert.equal(h.translator('agent').feeds.length, 0);
  output(h.translator('caller'), 1200);
  h.session().legs.get('agent').pacer._tick();
  assert.equal(caller.sent.length, 0);
  assert.equal(agent.sent.length, 1);
  assert.equal(agent.sent[0].data.length, 320);
  assert.equal(agent.sent[0].data.readInt16LE(318), 1200);
  assert.equal(agent.sent[0].options.binary, true);
  agent.audio(Buffer.alloc(320, 2));
  assert.equal(h.translator('agent').feeds.length, 1);
  output(h.translator('agent'), -900);
  h.session().legs.get('caller').pacer._tick();
  assert.equal(caller.sent.length, 1);
  assert.equal(caller.sent[0].data.readInt16LE(318), -900);
  caller.close(1000);
  assert.equal(agent.readyState, 3);
  assert.equal(h.activeCalls.size, 0);
  assert.ok(h.translators.every(tr => tr.closed));
  output(h.translator('caller'), 2000);
  assert.equal(agent.sent.length, 1, 'late model output ignored after hangup');
});

test('missing metadata is rejected; duplicate role and wrong languages preserve valid peer', async t => {
  const h = harness(t);
  for (const overrides of [{ CALL_ID: '' }, { ROLE: 'other' }, { SOURCE_LANG: '' }, { TARGET_LANG: undefined }]) {
    assert.equal(h.connect('caller', overrides).closeCode, 1008);
    assert.equal(h.activeCalls.size, 0);
  }
  const missing = h.connect();
  missing.control({ ...mediaStart('caller'), channel_variables: undefined });
  assert.equal(missing.closeCode, 1008);
  const caller = h.connect('caller'), original = h.session();
  for (const [role, overrides] of [['caller', {}], ['agent', { SOURCE_LANG: 'fr' }]]) {
    assert.equal(h.connect(role, overrides).closeCode, 1008);
    assert.equal(h.session(), original);
    assert.equal(caller.readyState, 1);
  }
  const agent = h.connect('agent'); await settle();
  assert.equal(h.session().ready, true);
  agent.close(1000);
  h.connect('caller'); h.connect('agent'); await settle();
  assert.equal(h.session().ready, true, 'next call can reuse IDs after full teardown');
});

for (const ending of ['hangup', 'translator failure']) test(`concurrent calls isolate audio and cleanup on ${ending}`, async t => {
  const h = harness(t);
  // Interleave setup, with opposite roles arriving first and identical transport IDs.
  const callerA = h.connect('caller');
  const agentB = h.connect('agent', { CALL_ID: 'call-b' });
  const agentA = h.connect('agent');
  const callerB = h.connect('caller', { CALL_ID: 'call-b' });
  await settle();
  assert.equal(h.activeCalls.size, 2);
  const a = h.session(), b = h.activeCalls.get('call-b');
  assert.ok(a.ready && b.ready);
  assert.equal(new Set(h.translators).size, 4);

  const routes = [
    [a, 'caller', callerA, agentA, 1100],
    [a, 'agent', agentA, callerA, -1200],
    [b, 'caller', callerB, agentB, 2100],
    [b, 'agent', agentB, callerB, -2200],
  ];
  for (const [session, role, source, destination, value] of routes) {
    const translator = session.legs.get(role).translator;
    const feedCounts = h.translators.map(tr => tr.feeds.length);
    source.audio(Buffer.alloc(320, 1));
    h.translators.forEach((tr, i) =>
      assert.equal(tr.feeds.length, feedCounts[i] + (tr === translator ? 1 : 0)));
    output(translator, value);
    session.legs.get(role === 'caller' ? 'agent' : 'caller').pacer._tick();
    assert.equal(destination.sent.length, 1);
    assert.equal(destination.sent[0].data.readInt16LE(318), value);
  }
  assert.equal(h.connect('caller', { CALL_ID: 'call-b' }).closeCode, 1008);
  assert.ok(a.ready && b.ready, 'duplicate participant must not close either call');

  if (ending === 'hangup') callerA.close(1000);
  else a.legs.get('caller').translator.callbacks.onFailure(new Error('test failure'));
  assert.equal(callerA.readyState, 3);
  assert.equal(agentA.readyState, 3);
  assert.equal(h.activeCalls.size, 1);
  assert.equal(h.activeCalls.get('call-b'), b);
  for (const leg of a.legs.values()) {
    assert.equal(leg.translator.closed, true);
    assert.equal(leg.pacer.timer, null);
  }
  assert.ok(b.ready);
  assert.equal(callerB.readyState, 1);
  assert.equal(agentB.readyState, 1);
  assert.ok([...b.legs.values()].every(leg => !leg.translator.closed));
  callerB.audio(Buffer.alloc(320));
  assert.equal(b.legs.get('caller').translator.feeds.length, 2);
  output(b.legs.get('caller').translator, 3100);
  b.legs.get('agent').pacer._tick();
  assert.equal(agentB.sent[1].data.readInt16LE(318), 3100);
});

test('CALL_ID collision preserves an existing incompatible bridge', t => {
  const h = harness(t), existing = {};
  h.activeCalls.set('abc123', existing);
  assert.equal(h.connect('caller').closeCode, 1008);
  assert.equal(h.session(), existing);
});

test('recipient XOFF pauses only recipient output; XON resumes exact queued audio', async t => {
  const h = harness(t), caller = h.connect('caller'), agent = h.connect('agent'); await settle();
  agent.control({ event: 'MEDIA_XOFF' });
  output(h.translator('caller'), 1000); output(h.translator('agent'), 2000);
  const agentPacer = h.session().legs.get('agent').pacer;
  agentPacer._tick(); h.session().legs.get('caller').pacer._tick();
  assert.equal(agent.sent.length, 0); assert.equal(agentPacer.queue.length, 320);
  assert.equal(caller.sent.length, 1);
  agent.control({ event: 'MEDIA_XON' }); agentPacer._tick();
  assert.equal(agent.sent[0].data.readInt16LE(318), 1000);
});

test('disconnect during setup closes both translators and cannot revive session', async t => {
  const resolvers = [];
  const h = harness(t, { start: () => new Promise(resolve => resolvers.push(resolve)) });
  const caller = h.connect('caller'), agent = h.connect('agent'); await settle();
  const session = h.session();
  caller.audio(Buffer.alloc(320));
  assert.equal(h.translator('caller').feeds.length, 0);
  caller.close(1000); resolvers.forEach(resolve => resolve()); await settle();
  assert.equal(agent.readyState, 3); assert.equal(session.ready, false);
  assert.equal(h.activeCalls.size, 0); assert.ok(h.translators.every(tr => tr.closed));
  for (const leg of session.legs.values()) assert.equal(leg.pacer.timer, null);
});

test('setup rejection and runtime translator failure close the entire pair', async t => {
  const failed = harness(t, { start: async () => { throw new Error('fake failure'); } });
  const caller = failed.connect('caller'), agent = failed.connect('agent'); await settle();
  assert.equal(caller.closeCode, 1011); assert.equal(agent.closeCode, 1011);
  assert.equal(failed.activeCalls.size, 0); assert.ok(failed.translators.every(tr => tr.closed));
  const h = harness(t), a = h.connect('caller'), b = h.connect('agent'); await settle();
  h.translator('caller').callbacks.onFailure(new Error('disconnected'));
  assert.equal(a.closeCode, 1011); assert.equal(b.closeCode, 1011); assert.equal(h.activeCalls.size, 0);
});

test('missing peer and stalled model startup release the reserved call', async t => {
  const h = harness(t, { setupTimeoutMs: 15 });
  const caller = h.connect('caller');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(caller.closeCode, 1011); assert.equal(h.activeCalls.size, 0);
  const stalled = harness(t, { setupTimeoutMs: 15, start: () => new Promise(() => {}) });
  const a = stalled.connect('caller'), b = stalled.connect('agent');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(a.closeCode, 1011); assert.equal(b.closeCode, 1011);
  assert.equal(stalled.activeCalls.size, 0);
});

test('paused playback queue has a bound and slow transport closes both connections', async t => {
  for (const slowSocket of [false, true]) {
    const h = harness(t), caller = h.connect('caller'), agent = h.connect('agent'); await settle();
    if (slowSocket) {
      agent.bufferedAmount = 80001;
      output(h.translator('caller'), 42);
      h.session().legs.get('agent').pacer._tick();
    } else {
      agent.control({ event: 'MEDIA_XOFF' });
      h.translator('caller').callbacks.onAudio(new Int16Array(24_000 * 31));
    }
    assert.equal(caller.readyState, 3); assert.equal(agent.readyState, 3);
    assert.equal(h.activeCalls.size, 0);
  }
});


test('capacity rejects a new call while allowing the existing call to acquire its peer', async t => {
  const h = harness(t, { maxCalls: 1 });
  h.connect('caller');
  const denied = h.connect('caller', { CALL_ID: 'another' });
  assert.equal(denied.closeCode, 1008); assert.equal(h.activeCalls.size, 1);
  h.connect('agent'); await settle();
  assert.equal(h.session().ready, true); assert.equal(h.translators.length, 2);
});
test('interruption clears only the destination playback queue', async t => {
  const h = harness(t); h.connect('caller'); h.connect('agent'); await settle();
  output(h.translator('caller'), 700); output(h.translator('agent'), -700);
  const caller = h.session().legs.get('caller'), agent = h.session().legs.get('agent');
  let flushed = 0; agent.sock.flushPlayback = () => flushed++;
  h.translator('caller').callbacks.onInterrupted();
  assert.equal(agent.pacer.queuedBytes, 0); assert.equal(flushed, 1);
  assert.ok(caller.pacer.queuedBytes > 0); assert.equal(h.session().ready, true);
});
