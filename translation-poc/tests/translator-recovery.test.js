import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { int16ToB64 } from '../bridge/audio.js';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function harness(env = {}) {
  let time = 0, id = 0;
  const timers = new Map(), calls = [], failures = [], logs = [];
  const timer = (fn, ms, repeat = false) => {
    timers.set(++id, { fn, ms, at: time + ms, repeat }); return id;
  };
  const context = vm.createContext({
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    Buffer, Int16Array, performance: { now: () => time },
    process: { env: { GEMINI_API_KEY: 'offline-test', GEMINI_CHUNK_SAMPLES: '320', GEMINI_RECONNECT_BUFFER_SECONDS: '10', GEMINI_CLOSE_WAIT_MS: '0', GEMINI_RETRY_BASE_MS: '0', GEMINI_RETRY_JITTER_MS: '0', ...env } }, int16ToB64, Modality: { AUDIO: 'AUDIO' },
    setTimeout: (fn, ms) => timer(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => timer(fn, ms, true), clearInterval: id => timers.delete(id),
    GoogleGenAI: class { live = { connect: options => new Promise((resolve, reject) => {
      const call = { ...options, sent: [], closed: 0, reject, throwSend: false };
      call.session = {
        sendRealtimeInput(payload) {
          if (call.throwSend || call.sent.length === call.failAfter) throw new Error('send failed');
          call.sent.push({ payload, at: time });
        },
        close() { call.closed++; if (!call.deferClose) call.callbacks.onclose({ reason: 'intentional close' }); },
      };
      call.open = () => resolve(call.session);
      call.ready = () => call.callbacks.onmessage({ setupComplete: {} });
      call.message = message => call.callbacks.onmessage(message);
      call.close = () => call.callbacks.onclose({ reason: 'remote close' });
      calls.push(call);
    }) }; },
  });
  const source = fs.readFileSync(new URL('../bridge/Translator.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export class Translator', 'class Translator');
  vm.runInContext(source + '\nthis.Translator = Translator;', context);
  const t = new context.Translator('en', { onFailure: error => failures.push(error) });
  const tick = async ms => {
    const end = time + ms;
    while (true) {
      const next = [...timers].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [key, item] = next; time = item.at;
      if (item.repeat) item.at += item.ms; else timers.delete(key);
      item.fn(); await settle();
    }
    time = end;
  };
  return { t, calls, failures, timers, logs, tick,
    async start() { const p = t.start(); calls[0].open(); calls[0].ready(); await p; },
    async ready(index = calls.length - 1) { calls[index].open(); calls[index].ready(); await settle(); },
    async rotate(handle = 'handle') {
      calls.at(-1).message({ sessionResumptionUpdate: { resumable: true, newHandle: handle } });
      calls.at(-1).message({ goAway: { timeLeft: '60s' } }); await settle();
    },
  };
}
const pcm = value => new Int16Array(320).fill(value);
const samples = call => call.sent.filter(x => x.payload.audio).map(x => Buffer.from(x.payload.audio.data, 'base64').readInt16LE());

test('setup acceptance gates audio; configuration retains translation and enables long sessions', async () => {
  const h = harness(); const starting = h.t.start();
  h.calls[0].open(); await settle(); h.t.feed(pcm(1));
  assert.equal(h.t.session, null); assert.equal(h.calls[0].sent.length, 0);
  assert.ok(h.calls[0].config.contextWindowCompression.slidingWindow);
  assert.ok(h.calls[0].config.sessionResumption);
  assert.equal(h.calls[0].config.translationConfig.targetLanguageCode, 'en');
  h.calls[0].ready(); await starting;
  assert.deepEqual(samples(h.calls[0]), [1]); h.t.close();
});

test('GoAway resumes latest handle; stale callbacks cannot kill call or emit audio', async () => {
  const h = harness(); await h.start(); let audio = 0; h.t.onAudio = () => audio++;
  h.calls[0].message({ sessionResumptionUpdate: { resumable: true, newHandle: 'older' } });
  await h.rotate('latest');
  assert.equal(h.calls[0].closed, 1);
  assert.equal(h.calls[1].config.sessionResumption.handle, 'latest');
  h.calls[0].close(); h.calls[0].callbacks.onerror(new Error('stale'));
  h.calls[0].message({ serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=' } }] } } });
  await h.ready(); assert.equal(audio, 0); assert.equal(h.failures.length, 0);
  assert.equal(h.calls.length, 2); h.t.close(); assert.equal(h.timers.size, 0);
});

test('reconnect backlog clears while continuous live input preserves every sample in order', async () => {
  const h = harness(); await h.start(); await h.rotate();
  for (let i = 1; i <= 150; i++) h.t.feed(pcm(i)); // Three seconds spans every catch-up tier.
  assert.equal(h.t.getStats().outboxMs, 3000);
  await h.ready();
  for (let i = 151; i <= 400; i++) { await h.tick(20); h.t.feed(pcm(i)); }
  assert.equal(h.t.getStats().outboxMs, 0);
  assert.equal(h.t.drainTimer, null);
  assert.deepEqual(samples(h.calls[1]), Array.from({ length: 400 }, (_, i) => i + 1));
  assert.equal(h.t.getStats().maxOutboxMs, 3000);
  assert.equal(h.t.getStats().reconnectCount, 1);
  assert.equal(h.failures.length, 0);
  const count = h.calls[1].sent.length;
  h.t.feed(pcm(401)); // Back on the immediate-send path.
  assert.equal(h.calls[1].sent.length, count + 1);
  h.t.close();
});

test('synthetic tail pauses through reconnect and backlog, then runs in real time', async () => {
  const h = harness(); await h.start(); await h.rotate();
  h.t.feed(pcm(9)); h.t.endInput(); await h.tick(500);
  assert.equal(h.t.outbox.length, 1);
  await h.ready(); assert.deepEqual(samples(h.calls[1]), [9]);
  await h.tick(2000);
  assert.equal(h.calls[1].sent.length, 22);
  assert.equal(h.calls[1].sent.at(-1).payload.audioStreamEnd, true);
  assert.ok(h.calls[1].sent[1].at >= 600); h.t.close();
});

test('new speech cancels paused synthetic tail', async () => {
  const h = harness(); await h.start(); await h.rotate();
  h.t.feed(pcm(1)); h.t.endInput(); await h.tick(200);
  h.t.feed(pcm(2)); await h.ready(); await h.tick(2200);
  assert.deepEqual(samples(h.calls[1]), [1, 2]); h.t.close();
});

test('close before setup completion rejects attempt, closes it, and retries', async () => {
  const h = harness(); await h.start(); await h.rotate();
  h.calls[1].open(); await settle(); h.calls[1].close(); await settle();
  assert.equal(h.calls[1].closed, 1); assert.equal(h.t.session, null);
  assert.equal(h.calls.length, 3); await h.ready(); assert.equal(h.failures.length, 0); h.t.close();
});

test('GoAway during setup rejects the attempt instead of hanging recovery', async () => {
  const h = harness(); await h.start(); await h.rotate();
  h.calls[1].open(); h.calls[1].message({ goAway: { timeLeft: '0s' } }); await settle();
  assert.equal(h.calls.length, 3); await h.ready(); h.t.close();
});

test('three failed resume attempts lead to one fresh fallback with context reset', async () => {
  const h = harness(); await h.start(); await h.rotate();
  for (let i = 1; i <= 3; i++) { h.calls[i].reject(new Error('invalid handle')); await settle(); }
  assert.equal(h.calls.length, 5); assert.equal(h.calls[4].config.sessionResumption.handle, undefined);
  await h.ready(); assert.equal(h.failures.length, 0); assert.equal(h.t.resumeHandle, null); h.t.close();
});

test('failed fallback raises one terminal failure and releases timers and queue', async () => {
  const h = harness(); await h.start(); await h.rotate(); h.t.feed(pcm(2));
  for (let i = 1; i <= 4; i++) { h.calls[i].reject(new Error('unavailable')); await settle(); }
  assert.equal(h.failures.length, 1); assert.equal(h.t.closed, true);
  assert.equal(h.timers.size, 0); assert.equal(h.t.outbox.length, 0);
  h.calls[0].close(); assert.equal(h.failures.length, 1);
});

test('missing handle rotates immediately to fresh session', async () => {
  const h = harness(); await h.start(); h.calls[0].message({ goAway: { timeLeft: '0s' } }); await settle();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].config.sessionResumption.handle, undefined);
  await h.ready(); h.t.close();
});

test('stalled setup times out; late session is disposed without activation', async () => {
  const h = harness(); await h.start(); await h.rotate(); await h.tick(5000);
  assert.equal(h.calls.length, 4); h.calls[1].open(); h.calls[1].ready(); await settle();
  assert.equal(h.calls[1].closed, 1); assert.equal(h.t.session, null);
  await h.ready(); h.t.close();
});

test('hangup while connecting cancels recovery and closes a late session', async () => {
  const h = harness(); await h.start(); await h.rotate(); h.t.close(); await settle();
  h.calls[1].open(); h.calls[1].ready(); await settle();
  assert.equal(h.calls[1].closed, 1); assert.equal(h.calls.length, 2);
  assert.equal(h.timers.size, 0); assert.equal(h.failures.length, 0);
});

test('buffer overflow fails once instead of silently dropping speech', async () => {
  const h = harness(); await h.start(); await h.rotate();
  for (let i = 0; i < 501; i++) h.t.feed(pcm(i));
  await settle(); assert.equal(h.failures.length, 1); assert.match(h.failures[0].message, /buffer/);
  assert.equal(h.t.outboxBytes, 0); assert.equal(h.timers.size, 0);
});

test('send and backlog flush failures close failed sockets and retain unsent input', async () => {
  const h = harness(); await h.start();
  h.calls[0].message({ sessionResumptionUpdate: { resumable: true, newHandle: 'h' } });
  h.calls[0].throwSend = true; h.t.feed(pcm(7)); await settle();
  assert.equal(h.calls[0].closed, 1);
  h.calls[1].throwSend = true; await h.ready();
  assert.equal(h.calls[1].closed, 1); assert.equal(h.calls.length, 3);
  await h.ready(); assert.deepEqual(samples(h.calls[2]), [7]); h.t.close();
});

test('general-model stream-end remains ordered after buffered speech', async () => {
  const h = harness({ GEMINI_LIVE_MODEL: 'general-live' }); await h.start(); await h.rotate();
  h.t.feed(pcm(1)); h.t.endInput(); h.t.feed(pcm(2));
  await h.ready(); await h.tick(50);
  assert.deepEqual(h.calls[1].sent.map(x => x.payload.audioStreamEnd || 'audio'), ['audio', true, 'audio']); h.t.close();
});

test('five calls with two directions survive four independent rotations without terminal failure', async () => {
  const directions = Array.from({ length: 10 }, () => harness());
  for (const h of directions) await h.start();
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let i = 0; i < directions.length; i++) {
      const h = directions[i]; await h.rotate(`direction-${i}-rotation-${rotation}`);
      h.t.feed(pcm(i + 1)); await h.ready(); await h.tick(20);
      assert.equal(h.calls.at(-1).config.sessionResumption.handle, `direction-${i}-rotation-${rotation}`);
      assert.deepEqual(samples(h.calls.at(-1)), [i + 1]);
    }
  }
  for (const h of directions) { assert.equal(h.failures.length, 0); h.t.close(); assert.equal(h.timers.size, 0); }
});

test('repeated setup success followed by send failure exhausts the bounded recovery budget', async () => {
  const h = harness(); await h.start(); await h.rotate(); h.t.feed(pcm(1));
  for (let i = 1; i <= 4; i++) {
    h.calls[i].throwSend = true; await h.ready(i); assert.equal(h.calls[i].closed, 1);
  }
  assert.equal(h.calls.length, 5); assert.equal(h.failures.length, 1);
  assert.equal(h.timers.size, 0); assert.equal(h.t.outbox.length, 0);
});

test('initial setup rejection fails once and never activates the closed socket', async () => {
  const h = harness(); const starting = h.t.start();
  h.calls[0].open(); await settle(); h.calls[0].close();
  await assert.rejects(starting, /remote close/);
  assert.equal(h.t.session, null); assert.equal(h.failures.length, 1);
  assert.equal(h.calls[0].closed, 1); assert.equal(h.timers.size, 0);
});

test('synthetic tail retries failed silence after recovery rather than dropping the tail', async () => {
  const h = harness(); await h.start(); h.t.feed(pcm(1)); h.t.endInput();
  h.calls[0].throwSend = true; await h.tick(100); await h.ready(); await h.tick(2000);
  assert.equal(h.calls[1].sent.length, 21); assert.equal(h.calls[1].sent.at(-1).payload.audioStreamEnd, true);
  h.t.close();
});


test('invalid catch-up timing and timeout settings fail at startup', () => {
  for (const env of [
    { GEMINI_MIN_DRAIN_DELAY_MS: '20' },
    { GEMINI_MIN_DRAIN_DELAY_MS: 'NaN' },
    { GEMINI_MIN_DRAIN_DELAY_MS: '0' },
    { GEMINI_CHUNK_SAMPLES: '16' },
    { GEMINI_CATCHUP_MEDIUM_MS: '-1' },
    { GEMINI_CATCHUP_HIGH_MS: 'NaN' },
    { GEMINI_CATCHUP_MEDIUM_MS: '2000', GEMINI_CATCHUP_HIGH_MS: '500' },
    { GEMINI_CONNECT_TIMEOUT_MS: 'NaN' },
    { GEMINI_CONNECT_TIMEOUT_MS: '0' },
  ]) assert.throws(() => harness(env), /must/);
});

test('transport diagnostics survive recovery and fatal logging before cleanup', async () => {
  const h = harness(); await h.start();
  h.calls[0].callbacks.onclose({ code: 1011, reason: 'remote failure', wasClean: false });
  await settle();
  const reconnect = h.logs.find(args => String(args[0]).includes('reconnecting #'));
  assert.equal(reconnect[1].code, 1011);
  assert.equal(reconnect[1].wasClean, false);
  h.t.feed(pcm(1));
  h.calls[1].callbacks.onerror({ message: 'quota exhausted', code: 429, status: 'RESOURCE_EXHAUSTED', details: 'test detail' });
  await settle();
  assert.equal(h.failures.length, 1);
  assert.equal(h.failures[0].code, 429);
  const fatal = h.logs.find(args => String(args[0]).includes('FATAL'))[1];
  assert.equal(fatal.status, 'RESOURCE_EXHAUSTED');
  assert.equal(fatal.details, 'test detail');
  assert.equal(fatal.outboxBytes, 640);
  assert.equal(h.t.outboxBytes, 0);
});

test('continuous speech exercises every timed-out resume and fresh attempt before the audio buffer fills', async () => {
  const h = harness(); await h.start(); await h.rotate();
  for (let i = 0; i < 500 && !h.t.closed; i++) { h.t.feed(pcm(i)); await h.tick(20); }
  assert.equal(h.calls.length, 5, 'initial session, three resume attempts, one fresh fallback');
  assert.equal(h.calls[4].config.sessionResumption.handle, undefined);
  assert.equal(h.failures.length, 1);
  assert.match(h.failures[0].message, /timed out|deadline/);
  assert.ok(h.t.getStats().maxOutboxMs < 10000);
  assert.equal(h.timers.size, 0);
});

test('general Live interpretation disables source-triggered interruption and propagates explicit cancellation', async () => {
  const h = harness({ GEMINI_LIVE_MODEL: 'general-live' }); await h.start();
  assert.equal(h.calls[0].config.realtimeInputConfig.activityHandling, 'NO_INTERRUPTION');
  let interrupted = 0, audio = 0;
  h.t.onInterrupted = () => interrupted++; h.t.onAudio = () => audio++;
  h.calls[0].message({ serverContent: { interrupted: true, modelTurn: { parts: [{ inlineData: { data: 'AAA=' } }] } } });
  assert.equal(interrupted, 1); assert.equal(audio, 0); h.t.close();
});

test('health transitions track reconnection, fallback, catch-up and readiness', async () => {
  const h = harness(); const transitions = [];
  h.t.onStateChange = (state, details) => transitions.push({ state, ...details });
  await h.start(); await h.rotate(); h.t.feed(pcm(1)); h.t.feed(pcm(2));
  for (let i = 1; i <= 3; i++) { h.calls[i].reject(new Error('invalid handle')); await settle(); }
  await h.ready(); await h.tick(100);
  assert.ok(transitions.some(x => x.state === 'recovering'));
  assert.ok(transitions.some(x => x.freshFallback));
  assert.ok(transitions.some(x => x.state === 'catching_up'));
  assert.equal(h.t.getStats().state, 'ready');
  assert.equal(h.t.getStats().freshFallbackCount, 1);
  h.t.close(); assert.equal(h.t.getStats().state, 'closed');
});

const productionRecovery = {
  GEMINI_CLOSE_WAIT_MS: '1000', GEMINI_RETRY_BASE_MS: '500', GEMINI_RETRY_JITTER_MS: '250',
};

test('replacement waits for close confirmation and backoff while retaining speech', async () => {
  const h = harness({ ...productionRecovery, GEMINI_RETRY_JITTER_MS: '0' }); await h.start();
  h.calls[0].deferClose = true;
  await h.rotate(); h.t.feed(pcm(7));
  await h.tick(100); assert.equal(h.calls.length, 1);
  h.calls[0].close(); await settle();
  await h.tick(499); assert.equal(h.calls.length, 1);
  await h.tick(1); assert.equal(h.calls.length, 2);
  h.calls[1].open(); await settle();
  assert.equal(h.calls[1].sent.length, 0, 'setup acceptance still gates buffered audio');
  h.calls[1].ready(); await settle(); await h.tick(100);
  assert.deepEqual(samples(h.calls[1]), [7]);
  assert.equal(h.t.getStats().state, 'ready'); h.t.close(); assert.equal(h.timers.size, 0);
});

test('missing close event has a bounded wait; stale close cannot kill replacement', async () => {
  const h = harness(productionRecovery); await h.start(); h.calls[0].deferClose = true;
  await h.rotate(); await h.tick(1500);
  assert.equal(h.calls.length, 2); await h.ready();
  h.calls[0].close(); await settle();
  assert.equal(h.t.session, h.calls[1].session); assert.equal(h.failures.length, 0);
  assert.ok(h.logs.some(args => String(args[0]).includes('close confirmed=false'))); h.t.close();
});

test('hangup cancels close wait and backoff without opening another socket', async () => {
  for (const deferClose of [false, true]) {
    const h = harness(productionRecovery); await h.start(); h.calls[0].deferClose = deferClose;
    await h.rotate(); h.t.close(); await settle(); await h.tick(10000);
    assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0); assert.equal(h.failures.length, 0);
  }
});

test('production delays preserve fresh fallback inside continuous-audio buffer deadline', async () => {
  const h = harness(productionRecovery); await h.start(); h.calls[0].deferClose = true;
  await h.rotate();
  for (let i = 0; i < 500 && !h.t.closed; i++) { h.t.feed(pcm(i)); await h.tick(20); }
  assert.equal(h.calls.length, 5);
  assert.equal(h.calls[4].config.sessionResumption.handle, undefined);
  assert.equal(h.failures.length, 1); assert.match(h.failures[0].message, /timed out|deadline/);
  assert.ok(h.t.getStats().maxOutboxMs < 10000); assert.equal(h.timers.size, 0);
});

test('retry backoff grows after explicit rejection and remains cancellable', async () => {
  const h = harness({ ...productionRecovery, GEMINI_CLOSE_WAIT_MS: '0', GEMINI_RETRY_JITTER_MS: '0' });
  await h.start(); await h.rotate(); await h.tick(500);
  assert.equal(h.calls.length, 2);
  h.calls[1].reject(Object.assign(new Error('conflict'), { code: 409 })); await settle();
  await h.tick(999); assert.equal(h.calls.length, 2);
  await h.tick(1); assert.equal(h.calls.length, 3);
  await h.ready(); assert.equal(h.failures.length, 0); h.t.close();
});

const costRecords = (h, prefix = '[gemini-cost] ') => h.logs
  .filter(args => String(args[0]).startsWith(prefix))
  .map(args => JSON.parse(args[0].slice(prefix.length)));

test('cost logs count submitted audio once across send failure, replay and synthetic tail', async () => {
  const h = harness(); await h.start();
  h.calls[0].message({ sessionResumptionUpdate: { resumable: true, newHandle: 'private-handle' } });
  h.calls[0].throwSend = true; h.t.feed(pcm(7)); await settle();
  await h.ready(); h.t.endInput(); await h.tick(2000);
  h.calls[1].message({serverContent:{modelTurn:{parts:[{inlineData:{data:Buffer.alloc(4800).toString('base64')}}]}}});
  h.t.close(); h.t.close();
  const records = costRecords(h); assert.equal(records.filter(x=>x.event==='end').length,1);
  const end=records.at(-1);
  assert.equal(end.inputReceivedMs,20); assert.equal(end.inputSubmittedMs,2020);
  assert.equal(end.syntheticInputSubmittedMs,2000); assert.equal(end.outputReceivedMs,100);
  assert.equal(end.connectionAttempt,2); assert.equal(end.queuedInputMs,0);
  assert.ok(!JSON.stringify(records).includes('private-handle'));
});

test('usage metadata is captured without serverContent, not summed, and excludes content', async () => {
  const h = harness(); await h.start();
  for (const n of [100,100,20]) h.calls[0].message({usageMetadata:{totalTokenCount:n,
    promptTokensDetails:[{modality:'AUDIO',tokenCount:n, secret:'private'}],
    privateText:'private', responseTokenCount:-1}});
  const reports=costRecords(h,'[gemini-usage] ');
  assert.deepEqual(reports.map(x=>x.usage.totalTokenCount),[100,100,20]);
  assert.equal(reports[0].usage.responseTokenCount,undefined);
  assert.ok(!JSON.stringify(reports).includes('private'));
  h.t.close(); assert.equal(costRecords(h).at(-1).usageReports,3);
});

test('cost summaries retain unsent input on failure and are sampled at most once per minute', async () => {
  const h=harness(); await h.start(); h.t.feed(pcm(1)); await h.tick(60000); h.t.feed(pcm(2));
  assert.equal(costRecords(h).filter(x=>x.event==='sample').length,1);
  await h.rotate(); h.t.feed(pcm(3));
  for(let i=1;i<=4;i++){h.calls[i].reject(new Error('unavailable'));await settle();}
  const end=costRecords(h).at(-1);
  assert.equal(end.event,'end');assert.equal(end.failed,true);
  assert.equal(end.inputReceivedMs,60);assert.equal(end.inputSubmittedMs,40);assert.equal(end.queuedInputMs,20);
});

// Existing recovery cases above retain explicit 20ms/10s overrides for compatibility.
// These cases exercise the new production defaults and burst failure boundaries.
const burstDefaults = { GEMINI_CHUNK_SAMPLES: undefined, GEMINI_RECONNECT_BUFFER_SECONDS: undefined };
const pcm40 = value => new Int16Array(640).fill(value);

test('default chunks combine two 20ms frames and flush a short final frame', async () => {
  const h = harness({ ...burstDefaults, GEMINI_LIVE_MODEL: 'general-live' }); await h.start();
  h.t.feed(pcm(1)); assert.equal(h.calls[0].sent.length, 0);
  h.t.feed(pcm(2));
  const audio = Buffer.from(h.calls[0].sent[0].payload.audio.data, 'base64');
  assert.equal(audio.length, 1280);
  assert.equal(audio.readInt16LE(0), 1); assert.equal(audio.readInt16LE(640), 2);
  h.t.feed(pcm(3)); h.t.endInput();
  assert.equal(Buffer.from(h.calls[0].sent[1].payload.audio.data, 'base64').length, 640);
  assert.equal(h.calls[0].sent[2].payload.audioStreamEnd, true);
  assert.equal(h.t.getStats().cost.inputSubmittedMs, 60); h.t.close();
});

test('default reconnect buffer accepts 30 seconds and fails on the next chunk', async () => {
  const h = harness(burstDefaults); await h.start(); await h.rotate();
  for (let i = 0; i < 750; i++) h.t.feed(pcm40(i));
  assert.equal(h.failures.length, 0); assert.equal(h.t.getStats().outboxMs, 30000);
  h.t.feed(pcm40(750)); await settle();
  assert.equal(h.failures.length, 1); assert.match(h.failures[0].message, /30s or 3000 messages/);
  assert.equal(h.timers.size, 0);
});

test('default bursts pace 160ms at 4x and drain a ten-second backlog with ongoing input', async () => {
  const h = harness(burstDefaults); await h.start(); await h.rotate();
  for (let i = 1; i <= 250; i++) h.t.feed(pcm40(i));
  await h.ready(); assert.equal(h.calls[1].sent.length, 4);
  await h.tick(39); assert.equal(h.calls[1].sent.length, 4);
  await h.tick(1); assert.equal(h.calls[1].sent.length, 8);
  for (let i = 251; i <= 400; i++) { h.t.feed(pcm40(i)); await h.tick(40); }
  assert.equal(h.failures.length, 0); assert.equal(h.t.getStats().state, 'ready');
  assert.equal(h.t.getStats().outboxMs, 0); assert.equal(h.t.drainTimer, null);
  assert.deepEqual(samples(h.calls[1]), Array.from({ length: 400 }, (_, i) => i + 1));
  assert.equal(h.t.getStats().maxDrainBurstMessages, 4);
  assert.equal(h.t.getStats().maxDrainBurstMs, 160);
  assert.equal(h.t.getStats().cost.inputSubmittedMs, 16000); h.t.close();
});

test('a mid-burst failure replays only unaccepted chunks and counts accepted audio once', async () => {
  const h = harness(burstDefaults); await h.start(); await h.rotate();
  for (let i = 1; i <= 6; i++) h.t.feed(pcm40(i));
  h.calls[1].failAfter = 2; await h.ready(1);
  assert.deepEqual(samples(h.calls[1]), [1, 2]);
  assert.equal(h.t.outboxBytes, 4 * 1280);
  assert.equal(h.t.getStats().cost.inputSubmittedMs, 80);
  await h.ready(); await h.tick(500);
  assert.deepEqual(samples(h.calls[2]), [3, 4, 5, 6]);
  assert.equal(h.t.outboxBytes, 0);
  assert.equal(h.t.getStats().cost.inputSubmittedMs, 240);
  assert.equal(h.failures.length, 0); h.t.close(); assert.equal(h.timers.size, 0);
});

test('burst message cap bounds control-only queues and preserves order', async () => {
  const h = harness({ ...burstDefaults, GEMINI_CATCHUP_BURST_MAX_MESSAGES: '3' });
  await h.start(); await h.rotate();
  for (let i = 0; i < 10; i++) h.t._send({ audioStreamEnd: true, testSequence: i });
  await h.ready(); assert.equal(h.calls[1].sent.length, 3);
  await h.tick(1); assert.equal(h.calls[1].sent.length, 3);
  await h.tick(1); assert.equal(h.calls[1].sent.length, 6);
  await h.tick(4);
  assert.deepEqual(h.calls[1].sent.map(x => x.payload.testSequence), Array.from({ length: 10 }, (_, i) => i));
  assert.equal(h.t.getStats().maxDrainBurstMessages, 3);
  assert.equal(h.t.getStats().cost.inputSubmittedMs, 0); h.t.close();
});

test('burst configuration rejects invalid targets and message limits', () => {
  for (const value of ['19', '1001', 'NaN', 'Infinity'])
    assert.throws(() => harness({ GEMINI_CATCHUP_BURST_TARGET_MS: value }), /must/);
  for (const value of ['0', '65', '1.5', 'NaN'])
    assert.throws(() => harness({ GEMINI_CATCHUP_BURST_MAX_MESSAGES: value }), /must/);
});
