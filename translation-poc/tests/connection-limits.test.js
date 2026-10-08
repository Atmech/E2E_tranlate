import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConnectionLimits } from '../bridge/connection-limits.js';
const socket = () => Object.assign(new EventEmitter(), { readyState: 1, ping() {}, terminate() { this.emit('close'); } });
test('defaults impose no new admission or heartbeat requirement', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const limits = new ConnectionLimits({});
  assert.equal(limits.maxCalls, Infinity); assert.equal(limits.maxConnections, Infinity);
  const ws = socket(); ws.ping = () => assert.fail('heartbeat must be disabled by default');
  ws.terminate = () => assert.fail('legacy client must not be disconnected for missing pong');
  limits.track(ws);
  for (let n = 0; n < 1000; n++) assert.equal(limits.checkUpgrade(), 0);
  t.mock.timers.tick(120000); ws.emit('close'); assert.equal(limits.connections.size, 0);
});
test('opt-in connection and rate caps release slots and expire rate windows', () => {
  let now = 1000;
  const limits = new ConnectionLimits({ MAX_MEDIA_CONNECTIONS: '2', MAX_UPGRADES_PER_MINUTE: '4' }, () => now);
  const a = socket(), b = socket(); limits.track(a); limits.track(b);
  assert.equal(limits.checkUpgrade(), 503);
  a.emit('close'); assert.equal(limits.checkUpgrade(), 0); b.emit('close');
  limits.checkUpgrade(); limits.checkUpgrade(); assert.equal(limits.checkUpgrade(), 429);
  now += 60000; assert.equal(limits.checkUpgrade(), 0);
});
test('explicit heartbeat opt-in terminates abandoned sockets and preserves responsive ones', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const limits = new ConnectionLimits({ WS_HEARTBEAT_MS: '100' });
  const ws = socket(); let pings = 0, closed = 0;
  ws.ping = () => pings++; ws.terminate = () => { closed++; ws.emit('close'); };
  limits.track(ws); t.mock.timers.tick(100); ws.emit('pong'); t.mock.timers.tick(100);
  assert.equal(pings, 2); assert.equal(closed, 0);
  t.mock.timers.tick(100); assert.equal(closed, 1); assert.equal(limits.connections.size, 0);
});
test('invalid limits fail startup instead of silently enabling a bad policy', () => {
  for (const env of [{ MAX_ACTIVE_CALLS: '-1' }, { MAX_MEDIA_CONNECTIONS: 'NaN' },
    { MAX_UPGRADES_PER_MINUTE: '1.5' }, { WS_HEARTBEAT_MS: '1' }])
    assert.throws(() => new ConnectionLimits(env), /must be/);
});
