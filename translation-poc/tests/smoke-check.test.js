import test from 'node:test';
import assert from 'node:assert/strict';
import { runSmoke } from '../bridge/smoke-check.js';
test('smoke fails if setup or established session fails; every outcome disposes the session', async () => {
  for (const where of ['setup', 'after-open', 'healthy']) {
    let closed = 0, failed;
    const stats = { hasSession: true, closed: false };
    const result = runSmoke(onFailure => {
      failed = onFailure;
      return { async start() { if (where === 'setup') throw new Error('setup rejected'); },
        feed(input) { assert.equal(input.length, 8000); }, getStats: () => stats,
        close() { closed++; } };
    }, { wait: async () => { if (where === 'after-open') failed(new Error('session closed')); } });
    if (where === 'healthy') assert.equal((await result).hasSession, true);
    else await assert.rejects(result, /rejected|closed/);
    assert.equal(closed, 1);
  }
});
test('smoke rejects a never-accepted setup and a silently closed session', async () => {
  await assert.rejects(runSmoke(() => ({ start: () => new Promise(() => {}), close() {} }), { timeoutMs: 5 }), /timed out/);
  await assert.rejects(runSmoke(() => ({ async start() {}, feed() {},
    getStats: () => ({ closed: true }), close() {} }), { wait: async () => {} }), /prematurely/);
});
