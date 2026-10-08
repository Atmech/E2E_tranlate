// Optional server-side limits. Disabled by default to preserve existing call admission.
function integer(env, key, max) {
  const value = Number(env[key] ?? 0);
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${key} must be 0–${max}`);
  return value;
}
export class ConnectionLimits {
  constructor(env = process.env, now = Date.now) {
    this.now = now;
    this.maxCalls = integer(env, 'MAX_ACTIVE_CALLS', 1000) || Infinity;
    this.maxConnections = integer(env, 'MAX_MEDIA_CONNECTIONS', 10000) || Infinity;
    this.rateLimit = integer(env, 'MAX_UPGRADES_PER_MINUTE', 10000);
    this.heartbeatMs = integer(env, 'WS_HEARTBEAT_MS', 120000);
    if (this.heartbeatMs > 0 && this.heartbeatMs < 100) throw new Error('WS_HEARTBEAT_MS must be 0 or at least 100');
    this.connections = new Set();
    this.windowAt = now(); this.attempts = 0;
  }
  checkUpgrade() {
    if (this.rateLimit) {
      if (this.now() - this.windowAt >= 60000) { this.windowAt = this.now(); this.attempts = 0; }
      if (++this.attempts > this.rateLimit) return 429;
    }
    return this.connections.size >= this.maxConnections ? 503 : 0;
  }
  track(ws) {
    this.connections.add(ws);
    ws.once('close', () => this.connections.delete(ws));
    if (!this.heartbeatMs) return;
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const timer = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      if (ws.readyState === 1) ws.ping();
    }, this.heartbeatMs);
    timer.unref?.();
    ws.once('close', () => clearInterval(timer));
  }
}
