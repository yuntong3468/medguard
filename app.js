/**
 * MedGuard 单文件后端（根目录版，零依赖）
 * 启动：node app.js
 * 自动探测前端目录：MedGuard-智能体 / public / static / 当前目录
 *
 * 环境变量：
 *   PORT       端口（Render 会自动给）
 *   MG_USERS   账号，格式 demo:medguard2026
 *   MG_SECRET  签名密钥
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.MG_SECRET || crypto.randomBytes(24).toString('hex');
const USERS = (process.env.MG_USERS || 'demo:medguard2026')
  .split(',').map(s => s.trim()).filter(Boolean)
  .reduce((acc, item) => {
    const i = item.indexOf(':');
    if (i > 0) acc[item.slice(0, i)] = item.slice(i + 1);
    return acc;
  }, {});

const ROOT = __dirname;

/* ---------- 找前端目录 ---------- */
function pickStatic() {
  if (process.env.MG_STATIC) {
    const p = path.resolve(ROOT, process.env.MG_STATIC);
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  const cands = ['MedGuard-智能体', 'public', 'static', 'dist', 'web', '.'];
  for (const c of cands) {
    const p = path.resolve(ROOT, c);
    if (fs.existsSync(path.join(p, 'index.html'))) return p;
  }
  return null;
}
const STATIC_DIR = pickStatic();

/* ---------- 数据目录 ---------- */
function pickData() {
  const cands = [path.join(ROOT, 'server', 'data'), path.join(ROOT, 'data'), path.join(__dirname, '.data')];
  for (const d of cands) {
    try {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, 'cases.json');
      if (!fs.existsSync(f)) fs.writeFileSync(f, '[]', 'utf8');
      return f;
    } catch (e) { /* 下一个 */ }
  }
  return path.join(__dirname, '.data', 'cases.json');
}
const DATA_FILE = pickData();

/* ---------- 存储 ---------- */
let cache = null;
function readAll() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { cache = []; }
  return cache;
}
function writeAll(list) {
  cache = list.slice(0, 2000);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

/* ---------- 鉴权 ---------- */
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verify(t) {
  if (!t || t.indexOf('.') < 0) return null;
  const [b, mac] = t.split('.');
  if (mac !== crypto.createHmac('sha256', SECRET).update(b).digest('base64url')) return null;
  try {
    const p = JSON.parse(Buffer.from(b, 'base64url').toString('utf8'));
    return (p.exp && Date.now() > p.exp) ? null : p;
  } catch (e) { return null; }
}
function userFrom(req) {
  return verify((req.headers['authorization'] || '').replace(/^Bearer\s+/i, ''));
}

/* ---------- 限流 ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const r = hits.get(ip) || { n: 0, t: now };
  if (now - r.t > 60000) { r.n = 0; r.t = now; }
  r.n++;
  hits.set(ip, r);
  return r.n > 180;
}

/* ---------- 工具 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};
function send(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(b),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  });
  res.end(b);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/* ---------- 静态服务 ---------- */
function serveStatic(req, res, pathname) {
  if (!STATIC_DIR) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<h1>找不到前端目录</h1><p>请把 index.html 放在 MedGuard-智能体/ 或 public/ 或根目录。</p>');
  }
  var rel = decodeURIComponent(pathname.split('?')[0]);
  if (rel === '/') rel = '/index.html';

  // 阻断敏感文件：后端代码、数据、配置、版本库
  var BLOCK = /^\/(server|data|\.data|\.git)(\/|$)|^\/(app\.js|package\.json|package-lock\.json|render\.yaml|DEPLOY\.md|Procfile|\.gitignore)$/i;
  if (BLOCK.test(rel)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not Found');
  }

  const file = path.join(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      const idx = path.join(STATIC_DIR, 'index.html');
      return fs.readFile(idx, (e2, buf) => {
        if (e2) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    fs.readFile(file, (e2, buf) => {
      if (e2) return send(res, 500, { error: 'read error' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(buf);
    });
  });
}

/* ---------- 主服务 ---------- */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  if (limited(ip)) return send(res, 429, { error: 'too many requests' });

  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;
  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    if (p === '/api/health') {
      return send(res, 200, { ok: true, static: !!STATIC_DIR, cases: readAll().length, ts: Date.now() });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const { user, password } = await body(req);
      if (!(USERS[user] && USERS[user] === password)) return send(res, 401, { error: '账号或密码不正确' });
      return send(res, 200, { token: sign({ user, exp: Date.now() + 12 * 3600e3 }), user });
    }

    if (p === '/api/cases' && req.method === 'GET') {
      if (!userFrom(req)) return send(res, 401, { error: '未登录' });
      return send(res, 200, { items: readAll() });
    }

    if (p === '/api/cases' && req.method === 'POST') {
      if (!userFrom(req)) return send(res, 401, { error: '未登录' });
      const rec = await body(req);
      if (!rec || !rec.name || !rec.dx) return send(res, 400, { error: '缺少必填字段' });
      const list = readAll();
      const dup = list.find(a => a.name === rec.name && String(a.age) === String(rec.age) && a.dx === rec.dx);
      if (dup) {
        if (dup.status !== rec.status) { dup.status = rec.status; writeAll(list); return send(res, 200, { id: dup.id, updated: true }); }
        return send(res, 200, { id: dup.id, duplicate: true });
      }
      rec.id = rec.id || ('A' + Date.now());
      rec.ts = rec.ts || new Date().toISOString();
      list.unshift(rec);
      writeAll(list);
      return send(res, 201, { id: rec.id });
    }

    const m = p.match(/^\/api\/cases\/([\w-]+)$/);
    if (m && req.method === 'PATCH') {
      if (!userFrom(req)) return send(res, 401, { error: '未登录' });
      const { status } = await body(req);
      const list = readAll();
      const item = list.find(a => a.id === m[1]);
      if (!item) return send(res, 404, { error: 'not found' });
      item.status = status; writeAll(list);
      return send(res, 200, { ok: true });
    }
    if (m && req.method === 'DELETE') {
      if (!userFrom(req)) return send(res, 401, { error: '未登录' });
      writeAll(readAll().filter(a => a.id !== m[1]));
      return send(res, 200, { ok: true });
    }

    if (p.startsWith('/api/')) return send(res, 404, { error: 'no such api' });
    return serveStatic(req, res, p);
  } catch (e) {
    return send(res, 500, { error: e.message || 'server error' });
  }
});

server.listen(PORT, () => {
  console.log('MedGuard backend on http://localhost:' + PORT);
  console.log('static dir :', STATIC_DIR || '(未找到)');
  console.log('data file  :', DATA_FILE);
  console.log('accounts   :', Object.keys(USERS).join(', '));
});
