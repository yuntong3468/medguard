/**
 * MedGuard 轻量后端（零依赖，Node.js 内置模块）
 *  - 静态托管前端（../MedGuard-智能体）
 *  - 账号登录（HMAC 签名 token，账号可配）
 *  - 病历存档共享（同一条记录按 姓名+年龄+疾病 去重）
 *
 * 启动：node server/server.js        （默认 http://localhost:8080）
 * 环境变量：
 *   PORT       端口，默认 8080
 *   MG_SECRET  签名密钥（生产必须设置）
 *   MG_USERS   账号列表，格式 "demo:medguard2026,judge1:pass123"
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

const ROOT = path.resolve(__dirname, '..');
const STATIC_DIR = path.join(ROOT, 'MedGuard-智能体');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'cases.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

/* ---------------- 存储（原子写） ---------------- */
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

/* ---------------- 鉴权 ---------------- */
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac !== expect) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
function userFrom(req) {
  const h = req.headers['authorization'] || '';
  return verify(h.replace(/^Bearer\s+/i, ''));
}

/* ---------------- 简单限流 ---------------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = hits.get(ip) || { n: 0, t: now };
  if (now - rec.t > 60000) { rec.n = 0; rec.t = now; }
  rec.n++;
  hits.set(ip, rec);
  return rec.n > 120;
}

/* ---------------- 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon'
};
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS'
  }, extra || {}));
  res.end(body);
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

/* ---------------- 静态文件 ---------------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // 找不到就当单页应用，回 index.html
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

/* ---------------- 主服务 ---------------- */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  if (limited(ip)) return send(res, 429, { error: 'too many requests' });

  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    /* 健康检查 */
    if (p === '/api/health') {
      return send(res, 200, { ok: true, ts: Date.now(), cases: readAll().length });
    }

    /* 登录 */
    if (p === '/api/login' && req.method === 'POST') {
      const { user, password } = await body(req);
      const ok = USERS[user] && USERS[user] === password;
      if (!ok) return send(res, 401, { error: '账号或密码不正确' });
      const token = sign({ user, exp: Date.now() + 12 * 3600 * 1000 });
      return send(res, 200, { token, user });
    }

    /* 存档：读 */
    if (p === '/api/cases' && req.method === 'GET') {
      if (!userFrom(req)) return send(res, 401, { error: '未登录' });
      return send(res, 200, { items: readAll() });
    }

    /* 存档：写（按 姓名+年龄+疾病 去重） */
    if (p === '/api/cases' && req.method === 'POST') {
      if (!userFrom(req)) return send(res, 401, { error: '未登录' });
      const rec = await body(req);
      if (!rec || !rec.name || !rec.dx) return send(res, 400, { error: '缺少必填字段' });
      const list = readAll();
      const dup = list.find(a => a.name === rec.name && String(a.age) === String(rec.age) && a.dx === rec.dx);
      if (dup) {
        if (dup.status !== rec.status) {
          dup.status = rec.status;
          writeAll(list);
          return send(res, 200, { id: dup.id, updated: true });
        }
        return send(res, 200, { id: dup.id, duplicate: true });
      }
      rec.id = rec.id || ('A' + Date.now());
      rec.ts = rec.ts || new Date().toISOString();
      list.unshift(rec);
      writeAll(list);
      return send(res, 201, { id: rec.id });
    }

    /* 存档：改状态 */
    const m1 = p.match(/^\/api\/cases\/([\w-]+)$/);
    if (m1 && req.method === 'PATCH') {
      if (!userFrom(req)) return send(res, 401, { error: '未登录' });
      const { status } = await body(req);
      const list = readAll();
      const item = list.find(a => a.id === m1[1]);
      if (!item) return send(res, 404, { error: 'not found' });
      item.status = status;
      writeAll(list);
      return send(res, 200, { ok: true });
    }

    /* 存档：删 */
    if (m1 && req.method === 'DELETE') {
      if (!userFrom(req)) return send(res, 401, { error: '未登录' });
      writeAll(readAll().filter(a => a.id !== m1[1]));
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
  console.log('静态目录:', STATIC_DIR);
  console.log('账号:', Object.keys(USERS).join(', '));
  console.log('密钥:', SECRET.slice(0, 8) + '...');
});
