'use strict';
// content.vngnc.net — tiny HTML showcase with an admin panel.
// Zero dependencies: Node's standard library only.

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

// ---------- config ----------
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || '/data');
const PAGES_DIR = path.join(DATA_DIR, 'pages');
const META_FILE = path.join(DATA_DIR, 'pages.json');
const SECRET_FILE = path.join(DATA_DIR, '.secret');
const ADMIN_USER = process.env.ADMIN_USER || process.env.BASIC_AUTH_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.BASIC_AUTH_PASSWORD || '';
const SANDBOX_PAGES = process.env.SANDBOX_PAGES !== 'false';
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 20) * 1024 * 1024;
const ADMIN_SESSION_MS = 7 * 24 * 3600 * 1000;
const PAGE_SESSION_MS = 30 * 24 * 3600 * 1000;
const RESERVED = new Set(['admin', 'api', 'healthz', 'robots.txt', 'favicon.ico', 'static', 'login', 'logout']);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

if (!ADMIN_PASSWORD) {
  console.error('ERROR: ADMIN_PASSWORD is not set; refusing to start without a password.');
  process.exit(1);
}

fs.mkdirSync(PAGES_DIR, { recursive: true });

const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'admin.html'), 'utf8');
const LOGIN_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'login.html'), 'utf8');

// Is /data a real mounted volume? If not, uploads vanish on redeploy.
let dataIsMounted = true;
try {
  const mounts = fs.readFileSync('/proc/mounts', 'utf8');
  dataIsMounted = mounts.split('\n').some((l) => l.split(' ')[1] === DATA_DIR);
} catch { /* not Linux (local dev) — assume fine */ }
if (!dataIsMounted) console.warn(`WARNING: ${DATA_DIR} is not a mounted volume. Uploaded pages will be lost on redeploy.`);

// ---------- crypto helpers ----------
let secret;
try {
  secret = fs.readFileSync(SECRET_FILE);
  if (secret.length < 32) throw new Error('short secret');
} catch {
  secret = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
}
// Changing ADMIN_PASSWORD changes the key, which logs out every session.
const signingKey = crypto.createHmac('sha256', secret).update(`key:${ADMIN_USER}:${ADMIN_PASSWORD}`).digest();

const sign = (data) => crypto.createHmac('sha256', signingKey).update(data).digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function makeToken(scope, ttl) {
  const exp = Date.now() + ttl;
  return `${exp}.${sign(`${scope}:${exp}`)}`;
}

function checkToken(token, scope) {
  if (!token) return false;
  const i = token.indexOf('.');
  if (i < 1) return false;
  const exp = Number(token.slice(0, i));
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  return safeEqual(token.slice(i + 1), sign(`${scope}:${exp}`));
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('base64url')}$${h.toString('base64url')}`;
}

function verifyPassword(pw, stored) {
  const [kind, s, h] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !s || !h) return false;
  const expected = Buffer.from(h, 'base64url');
  if (expected.length !== 32) return false;
  const actual = crypto.scryptSync(String(pw), Buffer.from(s, 'base64url'), 32);
  return crypto.timingSafeEqual(expected, actual);
}

// ---------- page metadata store ----------
let pages = new Map();
try {
  pages = new Map(Object.entries(JSON.parse(fs.readFileSync(META_FILE, 'utf8'))));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.error('ERROR: could not read pages.json', e);
    process.exit(1);
  }
}

let saveChain = Promise.resolve();
let saveTimer = null;
function saveMeta() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const snapshot = JSON.stringify(Object.fromEntries(pages), null, 2);
  saveChain = saveChain
    .then(async () => {
      const tmp = `${META_FILE}.tmp`;
      await fsp.writeFile(tmp, snapshot);
      await fsp.rename(tmp, META_FILE);
    })
    .catch((e) => console.error('ERROR: saving pages.json failed', e));
  return saveChain;
}
function saveMetaSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveMeta, 2000);
}

// Serialize all mutations so concurrent requests can't race on slugs.
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn);
  lock = run.catch(() => {});
  return run;
}

const pageFile = (slug) => path.join(PAGES_DIR, `${slug}.html`);

async function writeAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

function randomSlug() {
  for (;;) {
    const bytes = crypto.randomBytes(8);
    let s = '';
    for (const b of bytes) s += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
    if (!pages.has(s)) return s;
  }
}

function validateSlug(s) {
  if (!SLUG_RE.test(s)) return 'URL can only use a–z, 0–9 and dashes (max 64), and can’t start or end with a dash.';
  if (RESERVED.has(s)) return `“${s}” is reserved, pick another URL.`;
  return null;
}

function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' })[e]);
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

function publicMeta(m) {
  return {
    slug: m.slug,
    title: m.title,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    size: m.size,
    views: m.views || 0,
    hasPassword: Boolean(m.passwordHash),
  };
}

// ---------- login rate limiting ----------
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function isLimited(key, max) {
  const a = attempts.get(key);
  return Boolean(a && a.reset > Date.now() && a.count >= max);
}
function recordFailure(key) {
  const now = Date.now();
  let a = attempts.get(key);
  if (!a || a.reset <= now) { a = { count: 0, reset: now + WINDOW_MS }; attempts.set(key, a); }
  a.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, a] of attempts) if (a.reset <= now) attempts.delete(k);
}, 10 * 60 * 1000).unref();

// ---------- http helpers ----------
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function clientIp(req) {
  return (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
}

function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function parseCookies(req) {
  const out = Object.create(null);
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function cookie(req, name, value, { pathAttr, maxAgeMs, sameSite }) {
  const parts = [`${name}=${value}`, `Path=${pathAttr}`, 'HttpOnly', `SameSite=${sameSite}`, `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

// Reject cross-origin state-changing requests (incl. Origin: null from sandboxed pages).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] !== 'cross-site';
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'same-origin',
};
const ADMIN_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}
function sendHtml(res, status, html, extra = {}) {
  send(res, status, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
}
function redirect(res, location, extra = {}) {
  send(res, 303, '', { Location: location, ...extra });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length']);
    if (len > limit) return reject(new HttpError(413, `Too large (max ${Math.round(limit / 1048576)} MB).`));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON.');
  try { return JSON.parse((await readBody(req, MAX_UPLOAD_BYTES + 64 * 1024)).toString('utf8')); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function simplePage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f6f6f4;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e2e2dd;--accent:#2f5bea;--danger:#c0362c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--fg:#ececea;--muted:#9a9a94;--line:#33332f;--accent:#7b9bff;--danger:#ff7b70}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
.card{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
h1{font-size:1.15rem;margin:0 0 4px}p{color:var(--muted);margin:0 0 18px;font-size:.92rem}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);margin-bottom:12px}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{width:100%;font:inherit;font-weight:600;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
.error{color:var(--danger);font-size:.9rem;margin:-4px 0 12px}
</style></head><body><main class="card">${bodyHtml}</main></body></html>`;
}

function pagePasswordForm(slug, error) {
  return simplePage('Protected page', `<h1>This page is protected</h1><p>Enter the password to view it.</p>
<form method="post" action="/${escapeHtml(slug)}">
<input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password">
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
<button>View page</button></form>`);
}

function loginPage(error) {
  return LOGIN_HTML.replace('<!--ERROR-->', error ? `<div class="error">${escapeHtml(error)}</div>` : '');
}

// ---------- route handlers ----------
function isAdmin(req) {
  return checkToken(parseCookies(req).cs_admin, 'admin');
}

async function handleLogin(req, res) {
  if (!sameOrigin(req)) return sendHtml(res, 403, loginPage('Request blocked. Reload and try again.'), { 'Content-Security-Policy': ADMIN_CSP });
  const ip = clientIp(req);
  if (isLimited(`login:${ip}`, 10) || isLimited('login:*', 50)) {
    return sendHtml(res, 429, loginPage('Too many attempts. Wait 15 minutes and try again.'), { 'Content-Security-Policy': ADMIN_CSP });
  }
  const form = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'));
  const userOk = safeEqual(form.get('username') || '', ADMIN_USER);
  const passOk = safeEqual(form.get('password') || '', ADMIN_PASSWORD);
  if (!(userOk && passOk)) {
    recordFailure(`login:${ip}`);
    recordFailure('login:*');
    return sendHtml(res, 401, loginPage('Wrong username or password.'), { 'Content-Security-Policy': ADMIN_CSP });
  }
  const token = makeToken('admin', ADMIN_SESSION_MS);
  redirect(res, '/admin', { 'Set-Cookie': cookie(req, 'cs_admin', token, { pathAttr: '/admin', maxAgeMs: ADMIN_SESSION_MS, sameSite: 'Strict' }) });
}

async function handleApi(req, res, kind, slugParam) {
  if (!isAdmin(req)) return sendJson(res, 401, { error: 'Not logged in.' });
  if (req.method !== 'GET' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-origin request blocked.' });

  // GET /admin/api/status
  if (kind === 'status') {
    return sendJson(res, 200, { dataIsMounted, maxUploadMb: MAX_UPLOAD_BYTES / 1048576, sandbox: SANDBOX_PAGES });
  }

  // /admin/api/pages
  if (slugParam === null) {
    if (req.method === 'GET') {
      const list = [...pages.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicMeta);
      return sendJson(res, 200, { pages: list });
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const html = typeof body.html === 'string' ? body.html : '';
      if (!html.trim()) throw new HttpError(400, 'The HTML is empty.');
      const size = Buffer.byteLength(html);
      if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Too large.');
      const result = await withLock(async () => {
        let slug = String(body.slug || '').trim().toLowerCase();
        if (slug) {
          const err = validateSlug(slug);
          if (err) throw new HttpError(400, err);
          if (pages.has(slug)) throw new HttpError(409, `/${slug} already exists. Pick another URL or edit that page.`);
        } else {
          slug = randomSlug();
        }
        await writeAtomic(pageFile(slug), html);
        const now = new Date().toISOString();
        const meta = {
          slug,
          title: String(body.title || '').trim().slice(0, 200) || extractTitle(html) || slug,
          createdAt: now,
          updatedAt: now,
          size,
          views: 0,
          passwordHash: body.password ? hashPassword(body.password) : null,
        };
        pages.set(slug, meta);
        await saveMeta();
        return meta;
      });
      return sendJson(res, 201, { page: publicMeta(result) });
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  // /admin/api/pages/:slug
  const slug = slugParam;
  if (!pages.has(slug)) return sendJson(res, 404, { error: 'Page not found.' });

  if (req.method === 'PATCH') {
    const body = await readJson(req);
    const result = await withLock(async () => {
      const meta = pages.get(slug);
      if (!meta) throw new HttpError(404, 'Page not found.');
      const updated = { ...meta };
      let target = slug;

      if (body.slug !== undefined && String(body.slug).trim().toLowerCase() !== slug) {
        target = String(body.slug).trim().toLowerCase();
        const err = validateSlug(target);
        if (err) throw new HttpError(400, err);
        if (pages.has(target)) throw new HttpError(409, `/${target} already exists.`);
      }
      if (typeof body.html === 'string') {
        if (!body.html.trim()) throw new HttpError(400, 'The HTML is empty.');
        updated.size = Buffer.byteLength(body.html);
        if (updated.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Too large.');
      }
      if (body.title !== undefined) updated.title = String(body.title).trim().slice(0, 200) || meta.title;
      if (body.password === null || body.password === '') updated.passwordHash = null;
      else if (typeof body.password === 'string') updated.passwordHash = hashPassword(body.password);

      if (typeof body.html === 'string') await writeAtomic(pageFile(slug), body.html);
      if (target !== slug) {
        await fsp.rename(pageFile(slug), pageFile(target));
        pages.delete(slug);
        updated.slug = target;
      }
      updated.updatedAt = new Date().toISOString();
      pages.set(target, updated);
      await saveMeta();
      return updated;
    });
    return sendJson(res, 200, { page: publicMeta(result) });
  }

  if (req.method === 'DELETE') {
    await withLock(async () => {
      if (!pages.has(slug)) return;
      pages.delete(slug);
      await saveMeta();
      await fsp.rm(pageFile(slug), { force: true });
    });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 405, { error: 'Method not allowed.' });
}

async function servePage(req, res, slug) {
  const meta = pages.get(slug);
  if (!meta) return notFound(res);

  if (meta.passwordHash) {
    const cookieName = `cs_p_${slug}`;
    const scope = `page:${slug}:${meta.passwordHash}`;
    if (req.method === 'POST') {
      if (!sameOrigin(req)) return sendHtml(res, 403, pagePasswordForm(slug, 'Request blocked. Reload and try again.'));
      const key = `page:${clientIp(req)}:${slug}`;
      if (isLimited(key, 10)) return sendHtml(res, 429, pagePasswordForm(slug, 'Too many attempts. Wait 15 minutes.'));
      const form = new URLSearchParams((await readBody(req, 16 * 1024)).toString('utf8'));
      if (!verifyPassword(form.get('password') || '', meta.passwordHash)) {
        recordFailure(key);
        return sendHtml(res, 401, pagePasswordForm(slug, 'Wrong password.'));
      }
      const token = makeToken(scope, PAGE_SESSION_MS);
      return redirect(res, `/${slug}`, { 'Set-Cookie': cookie(req, cookieName, token, { pathAttr: `/${slug}`, maxAgeMs: PAGE_SESSION_MS, sameSite: 'Lax' }) });
    }
    if (!checkToken(parseCookies(req)[cookieName], scope)) {
      return sendHtml(res, 401, pagePasswordForm(slug, ''));
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });

  let stat;
  try { stat = await fsp.stat(pageFile(slug)); } catch { return notFound(res); }
  const headers = {
    ...BASE_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': stat.size,
    'Cache-Control': meta.passwordHash ? 'private, no-cache' : 'no-cache',
  };
  // Run uploaded pages in an isolated origin so their scripts can't touch the admin panel.
  if (SANDBOX_PAGES) headers['Content-Security-Policy'] = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(pageFile(slug)).on('error', () => res.destroy()).pipe(res);

  meta.views = (meta.views || 0) + 1;
  saveMetaSoon();
}

function notFound(res) {
  sendHtml(res, 404, simplePage('Not found', '<h1>Not found</h1><p>There’s no page at this address.</p>'));
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname === '/healthz') return send(res, 200, 'ok\n', { 'Content-Type': 'text/plain' });
  if (pathname === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /\n', { 'Content-Type': 'text/plain' });
  if (pathname === '/favicon.ico') return send(res, 204, '');

  if (pathname === '/admin' || pathname === '/admin/') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return sendHtml(res, 200, isAdmin(req) ? ADMIN_HTML : loginPage(''), { 'Content-Security-Policy': ADMIN_CSP });
  }
  if (pathname === '/admin/login') {
    if (req.method !== 'POST') return redirect(res, '/admin');
    return handleLogin(req, res);
  }
  if (pathname === '/admin/logout') {
    return redirect(res, '/admin', { 'Set-Cookie': cookie(req, 'cs_admin', '', { pathAttr: '/admin', maxAgeMs: 0, sameSite: 'Strict' }) });
  }
  const api = /^\/admin\/api\/(?:(status)|pages(?:\/([^/]+))?)$/.exec(pathname);
  if (api) {
    if (api[1]) return handleApi(req, res, 'status', null);
    let slug = null;
    if (api[2] !== undefined) {
      try { slug = decodeURIComponent(api[2]); } catch { return sendJson(res, 400, { error: 'Bad URL.' }); }
    }
    return handleApi(req, res, 'pages', slug);
  }

  const page = /^\/([a-z0-9-]{1,64})\/?$/.exec(pathname);
  if (page && !RESERVED.has(page[1])) return servePage(req, res, page[1]);

  return notFound(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) return res.destroy();
    if (req.url.startsWith('/admin/api/')) return sendJson(res, status, { error: status === 500 ? 'Server error.' : err.message });
    send(res, status, status === 500 ? 'Server error' : err.message, { 'Content-Type': 'text/plain; charset=utf-8' });
  });
});

server.listen(PORT, () => {
  console.log(`Listening on :${PORT} — ${pages.size} page(s) in ${DATA_DIR}. Admin user: ${ADMIN_USER}.`);
});

function shutdown() {
  server.close();
  saveMeta().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
