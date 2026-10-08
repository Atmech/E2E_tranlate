import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CallMonitor, failureCause, translatorTelemetry } from '../bridge/CallMonitor.js';
import { MonitorAuth, passwordHash } from '../bridge/monitor-auth.js';
import { handleNativeConnection } from '../bridge/native-websocket.js';

const password = 'test-only-long-passphrase';
const encoded = await passwordHash(password);
const credentials = { username: 'operator', passwordHash: encoded, origin: 'https://monitor.example.test' };
const cookieRequest = (auth, token) => ({ headers: { cookie: auth.cookie(token) } });

test('auth fails closed with absent, invalid or non-HTTPS configuration', () => {
  for (const config of [{}, { ...credentials, username: '' }, { ...credentials, passwordHash: 'plaintext' },
    { ...credentials, origin: 'http://public.example.test' }, { ...credentials, origin: 'https://monitor.example.test/path' }]) {
    const auth = new MonitorAuth(config);
    assert.equal(auth.enabled, false);
    assert.equal(auth.session({ headers: {} }), undefined);
  }
  assert.equal(new MonitorAuth(credentials).enabled, true);
});

test('password hash is salted; sessions rotate, expire, and are revoked on logout', async () => {
  assert.notEqual(encoded, await passwordHash(password));
  assert.ok(!encoded.includes(password));
  let now = 1000;
  const auth = new MonitorAuth({ ...credentials, now: () => now, sessionMs: 100 });
  const a = await auth.login('operator', password, 'a');
  const b = await auth.login('operator', password, 'a');
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.notEqual(a.token, b.token);
  assert.match(auth.cookie(a.token), /HttpOnly; SameSite=Strict/);
  assert.match(auth.cookie(a.token), /; Secure$/);
  assert.ok(auth.session(cookieRequest(auth, a.token)));
  auth.logout(cookieRequest(auth, a.token));
  assert.equal(auth.session(cookieRequest(auth, a.token)), undefined);
  now += 101;
  assert.equal(auth.session(cookieRequest(auth, b.token)), undefined);
});

test('login limits apply across usernames and bound global guessing', async () => {
  let now = 1000;
  const auth = new MonitorAuth({ ...credentials, now: () => now });
  assert.equal((await auth.login('wrong', password, 'ip')).status, 401);
  assert.equal((await auth.login('operator', 'wrong', 'ip')).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await auth.login(null, null, 'ip')).status, 401);
  assert.equal((await auth.login('operator', password, 'ip')).status, 429);
  for (let i = 0; i < 25; i++) await auth.login(null, null, `ip-${i}`);
  assert.equal((await auth.login('operator', password, 'new-ip')).status, 429);
  now += 900001;
  assert.equal((await auth.login('operator', password, 'ip')).status, 200);
});

test('transport and CSRF checks reject spoofed origins, hosts, and untrusted forwarded headers', () => {
  const auth = new MonitorAuth(credentials);
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'monitor.example.test',
    'x-forwarded-proto': 'https', origin: credentials.origin, 'x-monitor-request': '1' } };
  assert.equal(auth.transportAllowed(req), false);
  req.socket.encrypted = true;
  assert.equal(auth.transportAllowed(req), true);
  assert.equal(auth.mutationAllowed(req), true);
  req.headers.origin = 'https://attacker.test';
  assert.equal(auth.mutationAllowed(req), false);
  req.headers.host = 'attacker.test';
  assert.equal(auth.transportAllowed(req), false);
  const local = new MonitorAuth({ ...credentials, origin: 'http://localhost:8080' });
  assert.equal(local.transportAllowed({ headers: { host: 'localhost:8080' }, socket: { remoteAddress: '10.0.0.2' } }), false);
  const proxy = new MonitorAuth({ ...credentials, trustProxy: true });
  assert.equal(proxy.transportAllowed({ headers: { host: 'monitor.example.test', 'x-forwarded-proto': 'https' }, socket: {} }), true);
});

test('history is bounded by count and age; reused call IDs and active calls stay separate', () => {
  let now = 100;
  const monitor = new CallMonitor({ now: () => now, historyLimit: 2, eventLimit: 3, issueLimit: 2, retentionMs: 1000 });
  const active = monitor.start('active');
  for (let i = 0; i < 4; i++) {
    now += 1; const id = monitor.start('reused');
    for (let e = 0; e < 5; e++) monitor.event(id, 'warning', 'Safe warning');
    monitor.end(id, 'Timed out', true);
  }
  let snapshot = monitor.snapshot();
  assert.equal(snapshot.calls.length, 3);
  assert.equal(new Set(snapshot.calls.map(c => c.id)).size, 3);
  assert.equal(snapshot.counts.failed, 2);
  assert.equal(snapshot.issues.length, 2);
  assert.ok(snapshot.calls.every(c => c.events.length <= 3));
  now += 1001; snapshot = monitor.snapshot();
  assert.deepEqual(snapshot.calls.map(c => c.id), [active]);
  assert.equal(snapshot.issues.length, 0);
});

test('provider errors cannot expose request text, secrets or URLs', () => {
  for (const message of ['quota exhausted: secret-api-key https://x.test?key=secret',
    'User said a private transcript', '<script>alert(1)</script>', '401: Bearer secret']) {
    const cause = failureCause(new Error(message));
    assert.ok(!cause.includes('secret')); assert.ok(!cause.includes('transcript')); assert.ok(!cause.includes('<script>'));
  }
  assert.equal(failureCause(new Error('429 RESOURCE_EXHAUSTED')), 'Provider quota or rate limit');
});

test('speech history stays out of snapshots, is bounded, and ends with call retention', () => {
  let now = 100;
  const monitor = new CallMonitor({ now: () => now, retentionMs: 50,
    maxTextEntries: 2, maxTextChars: 24, maxTextChunkChars: 12 });
  const id = monitor.start('speech-call');
  monitor.transcript(id, 'caller', 'recognized', 'first utterance');
  monitor.transcript(id, 'caller', 'translated', 'second utterance');
  monitor.transcript(id, 'agent', 'translated', 'third utterance');
  assert.equal(monitor.getTranscript(id).records.length, 2);
  assert.ok(monitor.getTranscript(id).omitted >= 1);
  assert.equal(monitor.snapshot().calls[0].transcriptVersion, 3);
  assert.ok(!JSON.stringify(monitor.snapshot()).includes('utterance'));
  monitor.end(id);
  monitor.transcript(id, 'agent', 'recognized', 'late speech');
  assert.equal(monitor.getTranscript(id).records.length, 2);
  now += 51;
  monitor.snapshot();
  assert.equal(monitor.getTranscript(id), null);
});

test('native telemetry retains speech text privately alongside failures and directions', async t => {
  const monitor = new CallMonitor(); const activeCalls = new Map(); const translators = [];
  const connect = (role, id = 'call-a') => {
    const ws = new EventEmitter();
    Object.assign(ws, { readyState: 1, bufferedAmount: 0, send() {}, close(code = 1000) {
      if (this.readyState === 3) return; this.readyState = 3; this.emit('close', code);
    } });
    handleNativeConnection(ws, { activeCalls, monitor, mode: 'translation', createTranslator: (lang, callbacks) => {
      const tr = { callbacks, async start() {}, feed() {}, close() {} }; translators.push(tr); return tr;
    } });
    t.after(() => ws.close());
    ws.control = event => ws.emit('message', Buffer.from(JSON.stringify(event)), false);
    ws.control({ event: 'MEDIA_START', connection_id: 'test', format: 'slin', optimal_frame_size: 320,
      channel_variables: { CALL_ID: id, ROLE: role, SOURCE_LANG: role === 'caller' ? 'hi' : 'en', TARGET_LANG: role === 'caller' ? 'en' : 'hi' } });
    return ws;
  };
  connect('invalid');
  assert.equal(monitor.snapshot().issues[0].sessionId, null);
  assert.match(monitor.snapshot().issues[0].message, /ROLE/);
  const caller = connect('caller');
  caller.emit('message', Buffer.alloc(320), true);
  const agent = connect('agent');
  await new Promise(resolve => setImmediate(resolve));
  let call = monitor.snapshot().calls[0];
  assert.equal(call.state, 'ready'); assert.equal(call.legs.caller.droppedBytes, 320);
  assert.equal(call.legs.caller.translator, 'ready');
  assert.equal(call.legs.caller.receivedBytes, 320);
  translators[0].callbacks.onInputText('नमस्ते');
  translators[0].callbacks.onOutputText('Hello');
  assert.deepEqual(monitor.getTranscript(call.id).records.map(e => [e.role, e.kind, e.text]),
    [['caller', 'recognized', 'नमस्ते'], ['caller', 'translated', 'Hello']]);
  assert.ok(!JSON.stringify(monitor.snapshot()).includes('नमस्ते'));
  agent.control({ event: 'MEDIA_XOFF' });
  assert.equal(monitor.snapshot().calls[0].legs.agent.paused, true);
  translators[0].callbacks.onAudio(new Int16Array(24000 * 4));
  assert.equal(monitor.snapshot().calls[0].legs.agent.queueMs, 4000);
  translators[0].callbacks.onFailure(new Error('429: secret credential'));
  call = monitor.snapshot().calls[0];
  assert.equal(call.state, 'failed'); assert.equal(activeCalls.size, 0); assert.equal(monitor.readers.size, 0);
  assert.ok(call.events.some(e => e.role === 'caller' && e.message.includes('quota')));
  assert.ok(!JSON.stringify(monitor.snapshot()).includes('secret'));
  assert.equal(call.legs.agent.connected, false);
  assert.equal(call.legs.agent.queueMs, 4000, 'capture queue before cleanup clears it');
});


test('recovery telemetry triggers attention and exposes bounded counters without provider details', () => {
  const monitor = new CallMonitor(); const id = monitor.start('recovering-call');
  let state = 'recovering', queue = 600;
  const translator = { getStats: () => ({ state, outboxMs: queue, maxOutboxMs: 2000,
    reconnectCount: 2, freshFallbackCount: 1, recoveryMs: 900, secret: 'must-not-leak' }) };
  monitor.update(id, { state: 'ready' });
  monitor.watch(id, () => ({ caller: translatorTelemetry(translator) }));
  let snapshot = monitor.snapshot();
  assert.equal(snapshot.counts.attention, 1);
  assert.equal(snapshot.calls[0].legs.caller.translator, 'recovering');
  assert.equal(snapshot.calls[0].legs.caller.inputQueueMs, 600);
  assert.ok(!JSON.stringify(snapshot).includes('must-not-leak'));
  state = 'catching_up'; snapshot = monitor.snapshot(); assert.equal(snapshot.counts.attention, 1);
  state = 'ready'; queue = 0; snapshot = monitor.snapshot(); assert.equal(snapshot.counts.attention, 0);
});

test('cost widget totals both directions without double counting and survives history pruning', () => {
  let now = 100;
  const monitor = new CallMonitor({ now: () => now, historyLimit: 0 });
  const id = monitor.start('cost-call');
  const measured = { model: 'gemini-3.5-live-translate-preview', inputSubmittedMs: 60000,
    outputReceivedMs: 60000, usageReports: 1 };
  monitor.watch(id, () => ({caller:{cost:measured},agent:{cost:measured}}));
  const first=monitor.snapshot();
  assert.ok(Math.abs(first.cost.estimatedUsd - 0.0735) < 1e-9);
  assert.equal(first.cost.calls,1); assert.equal(first.cost.pricedDirections,2);
  assert.deepEqual(monitor.snapshot().cost,first.cost);
  now=200;monitor.end(id);monitor.end(id);
  const ended=monitor.snapshot();assert.equal(ended.calls.length,0);
  assert.equal(ended.cost.estimatedUsd,first.cost.estimatedUsd);
  assert.equal(ended.cost.activeUsd,0);assert.equal(ended.cost.completedUsd,first.cost.estimatedUsd);
  assert.equal(ended.cost.calls,1);
  const another=monitor.start('cost-call');monitor.watch(another,()=>({caller:{cost:measured},agent:{cost:measured}}));
  assert.equal(monitor.snapshot().cost.calls,2);
  assert.equal(monitor.snapshot().cost.estimatedUsd,2*first.cost.estimatedUsd);
});

test('cost coverage distinguishes missing data and unknown model from zero-priced usage', () => {
  const monitor=new CallMonitor();const id=monitor.start('partial');
  monitor.leg(id,'caller',{cost:{model:'unknown',inputSubmittedMs:60000,outputReceivedMs:0,usageReports:0}});
  const snapshot=monitor.snapshot();
  assert.equal(snapshot.cost.pricedDirections,0);assert.equal(snapshot.cost.unpricedDirections,1);
  assert.equal(snapshot.cost.missingDirections,1);assert.equal(snapshot.cost.usageReports,0);
  assert.equal(snapshot.cost.inputMinutes,1);
  monitor.start('loop','loopback');assert.equal(monitor.snapshot().cost.calls,1);
  assert.equal(new CallMonitor().snapshot().cost.calls,0);
});
