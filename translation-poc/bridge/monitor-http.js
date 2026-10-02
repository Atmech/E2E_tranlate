import fs from 'node:fs';
import { MonitorAuth } from './monitor-auth.js';

const asset = name => fs.readFileSync(new URL(`../monitor-ui/${name}`, import.meta.url));
const securityHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw new Error('Body too large');
  }
  return JSON.parse(body);
}

export function createMonitorHandler(monitor, { env = process.env, auth = new MonitorAuth({
  username: env.MONITOR_USERNAME, passwordHash: env.MONITOR_PASSWORD_HASH,
  origin: env.MONITOR_ORIGIN, trustProxy: env.MONITOR_TRUST_PROXY === 'true',
}) } = {}) {
  // Keep these outside the legacy public static directory.
  const files = new Map([
    ['/monitor/login', ['login.html', 'text/html; charset=utf-8']],
    ['/monitor/login.js', ['login.js', 'text/javascript']],
    ['/monitor/style.css', ['style.css', 'text/css']],
    ['/monitor', ['index.html', 'text/html; charset=utf-8']],
    ['/monitor/', ['index.html', 'text/html; charset=utf-8']],
    ['/monitor/app.js', ['app.js', 'text/javascript']],
  ].map(([route, [file, type]]) => [route, { body: asset(file), type }]));
  const streams = new Set();

  return async function handleMonitor(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== '/monitor' && !pathname.startsWith('/monitor/')) return false;
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
    const reply = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message }));
      return true;
    };
    if (!auth.enabled) return reply(503, 'Call monitor is disabled until admin credentials and origin are configured.');
    if (!auth.transportAllowed(req)) return reply(403, 'Use the configured secure monitor address.');
    if (!auth.local) res.setHeader('strict-transport-security', 'max-age=31536000');
    if (req.headers.origin && req.headers.origin !== auth.origin) return reply(403, 'Origin not allowed.');

    if (req.method === 'POST' && ['/monitor/login', '/monitor/logout'].includes(pathname)) {
      if (!auth.mutationAllowed(req)) return reply(403, 'Request not allowed.');
      if (pathname === '/monitor/logout') {
        auth.logout(req);
        for (const stream of streams) if (!auth.session(stream.req)) stream.res.end();
        res.setHeader('set-cookie', auth.cookie('', 0));
        return reply(200, 'Signed out.');
      }
      if (req.headers['content-type'] !== 'application/json') return reply(415, 'Expected JSON.');
      try {
        const { username, password } = await readBody(req);
        const result = await auth.login(username, password, req.socket.remoteAddress);
        if (result.status === 200) {
          auth.logout(req); // Rotate any existing session on successful login.
          res.setHeader('set-cookie', auth.cookie(result.token));
          return reply(200, 'Signed in.');
        }
        if (result.status === 429) res.setHeader('retry-after', '900');
        return reply(result.status, result.status === 429 ? 'Too many attempts. Try again in 15 minutes.' : 'Invalid username or password.');
      } catch { return reply(400, 'Could not process sign-in.'); }
    }
    if (req.method !== 'GET') return reply(405, 'Method not allowed.');
    const publicAsset = ['/monitor/login', '/monitor/login.js', '/monitor/style.css'].includes(pathname);
    if (!publicAsset && !auth.session(req)) {
      if (pathname === '/monitor' || pathname === '/monitor/') {
        res.writeHead(303, { location: '/monitor/login' }); res.end(); return true;
      }
      return reply(401, 'Sign in to view the monitor.');
    }
    if (pathname === '/monitor/api/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(monitor.snapshot()));
    } else if (/^\/monitor\/api\/calls\/[a-f0-9-]{36}\/transcript$/.test(pathname)) {
      const id = pathname.split('/')[4];
      const transcript = monitor.getTranscript(id);
      if (!transcript) return reply(404, 'Call is no longer in retained history.');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(transcript));
    } else if (pathname === '/monitor/events') {
      if (streams.size >= 20) return reply(429, 'Too many live monitor connections.');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-accel-buffering': 'no' });
      const stream = { req, res };
      streams.add(stream);
      const send = () => {
        if (!auth.session(req)) {
          res.write('event: expired\ndata: {}\n\n'); res.end(); return;
        }
        // Bound memory for a slow or abandoned browser.
        if (res.writableLength > 256 * 1024) { res.destroy(); return; }
        res.write(`data: ${JSON.stringify(monitor.snapshot())}\n\n`);
      };
      const timer = setInterval(send, 1000);
      timer.unref?.();
      res.on('close', () => { clearInterval(timer); streams.delete(stream); });
      send();
    } else if (files.has(pathname)) {
      const { body, type } = files.get(pathname);
      res.writeHead(200, { 'content-type': type }); res.end(body);
    } else return reply(404, 'Not found.');
    return true;
  };
}
