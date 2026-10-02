import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const HASH_PATTERN = /^scrypt-v1:([a-f0-9]{32}):([a-f0-9]{128})$/;
const hashToken = token => createHash('sha256').update(token).digest('hex');
const SCRYPT = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

export async function passwordHash(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256)
    throw new Error('Use a password between 14 and 256 characters.');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, SCRYPT);
  return `scrypt-v1:${salt}:${key.toString('hex')}`;
}

export class MonitorAuth {
  constructor({ username, passwordHash: encoded, origin, trustProxy = false,
    now = Date.now, sessionMs = 8 * 60 * 60 * 1000 } = {}) {
    Object.assign(this, { username, encoded, now, sessionMs, trustProxy });
    this.sessions = new Map();
    this.attempts = new Map();
    this.verifying = false;
    this.enabled = false;
    try {
      const url = new URL(origin);
      this.local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((!this.local && url.protocol !== 'https:') || url.origin !== origin) return;
      this.origin = url.origin;
      this.cookieName = this.local ? 'call_monitor_local' : '__Secure-call_monitor';
      this.enabled = typeof username === 'string' && username.length > 0 && username.length <= 128 &&
        HASH_PATTERN.test(encoded || '');
    } catch { /* Fail closed for incomplete or invalid configuration. */ }
  }

  transportAllowed(req) {
    if (!this.enabled || req.headers.host !== new URL(this.origin).host) return false;
    if (this.local) return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    return !!req.socket.encrypted || (this.trustProxy && req.headers['x-forwarded-proto'] === 'https');
  }

  mutationAllowed(req) {
    return req.headers.origin === this.origin && req.headers['x-monitor-request'] === '1';
  }

  cookie(token, maxAge = this.sessionMs / 1000) {
    return `${this.cookieName}=${token}; Path=/monitor; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge)}${this.local ? '' : '; Secure'}`;
  }

  token(req) {
    return (req.headers.cookie || '').split(';').map(c => c.trim())
      .find(c => c.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1) || '';
  }

  session(req) {
    this.prune();
    const token = this.token(req);
    return /^[a-f0-9]{64}$/.test(token) ? this.sessions.get(hashToken(token)) : undefined;
  }

  logout(req) { this.sessions.delete(hashToken(this.token(req))); }

  prune() {
    for (const [key, session] of this.sessions) if (session.expires <= this.now()) this.sessions.delete(key);
    for (const [key, window] of this.attempts) if (window.until <= this.now()) this.attempts.delete(key);
  }

  async login(username, password, address) {
    this.prune();
    if (!this.enabled) return { status: 503 };
    // Ignore forwarded IPs. A global limit also bounds guessing and memory when
    // multiple clients share a proxy. Only one memory-hard verification at a time.
    const keys = [['global', 30], [`ip:${address}`, 5]];
    if (this.verifying || keys.some(([key, limit]) => (this.attempts.get(key)?.count || 0) >= limit))
      return { status: 429 };
    for (const [key] of keys) {
      const window = this.attempts.get(key) || { count: 0, until: this.now() + 15 * 60 * 1000 };
      window.count++;
      this.attempts.set(key, window);
    }
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 128 || password.length > 256)
      return { status: 401 };
    this.verifying = true;
    try {
      const [, salt, expected] = this.encoded.match(HASH_PATTERN);
      const actual = await derive(password, salt, 64, SCRYPT);
      const sameUser = timingSafeEqual(Buffer.from(hashToken(username), 'hex'), Buffer.from(hashToken(this.username), 'hex'));
      if (!timingSafeEqual(actual, Buffer.from(expected, 'hex')) || !sameUser) return { status: 401 };
      const token = randomBytes(32).toString('hex');
      while (this.sessions.size >= 20) this.sessions.delete(this.sessions.keys().next().value);
      this.sessions.set(hashToken(token), { expires: this.now() + this.sessionMs });
      return { status: 200, token };
    } finally { this.verifying = false; }
  }
}
