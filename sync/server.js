'use strict';
/* ============================================================
   Keyring sync — a deliberately boring blob store.
   Holds ONE file: the AES-GCM ciphertext your browser produced.
   It cannot read your keys. It has no idea what a key is.

   GET  /api/vault   -> the stored record (404 if none yet)
   PUT  /api/vault   -> replace it (If-Match: <etag> for safety)
   DELETE /api/vault -> remove it (a snapshot is kept)
   GET  /api/health  -> {ok:true}

   Env:
     KEYRING_DATA      where to write        (default /data)
     KEYRING_TOKEN     shared bearer token   (default: no auth)
     KEYRING_KEEP      version snapshots     (default 10)
     KEYRING_ALLOW_PLAINTEXT=1  accept unencrypted blobs (don't)
     KEYRING_UID       drop to uid:gid after fixing /data ownership
   ============================================================ */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA  = process.env.KEYRING_DATA || '/data';
const FILE  = path.join(DATA, 'vault.json');
const VERS  = path.join(DATA, 'versions');
const TOKEN = (process.env.KEYRING_TOKEN || '').trim();
const KEEP  = Math.max(0, parseInt(process.env.KEYRING_KEEP || '10', 10) || 0);
const ALLOW_PLAINTEXT = process.env.KEYRING_ALLOW_PLAINTEXT === '1';
const PORT  = parseInt(process.env.PORT || '8080', 10);
const MAX   = 5 * 1024 * 1024;

fs.mkdirSync(DATA, { recursive: true });
if (KEEP) fs.mkdirSync(VERS, { recursive: true });

/* A fresh Docker named volume is created root-owned, so a container that
   starts as an unprivileged user cannot write to it. Start as root, take
   ownership of the data dir, then drop privileges before serving. Set
   KEYRING_UID=uid:gid to enable; unset means stay as whoever we are. */
(function dropPrivileges() {
  const spec = (process.env.KEYRING_UID || '').trim();
  if (!spec || typeof process.getuid !== 'function' || process.getuid() !== 0) return;
  const [uid, gid] = spec.split(':').map(n => parseInt(n, 10));
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    console.error('[keyring] KEYRING_UID must look like 1000:1000 — staying as root');
    return;
  }
  const chownTree = dir => {
    fs.chownSync(dir, uid, gid);
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      f.isDirectory() ? chownTree(full) : fs.chownSync(full, uid, gid);
    }
  };
  try {
    chownTree(DATA);
    process.setgid(gid);
    process.setuid(uid);
    console.log('[keyring] dropped privileges to ' + uid + ':' + gid);
  } catch (e) {
    console.error('[keyring] could not drop privileges: ' + e.message);
  }
})();

const etagOf = buf => '"' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 24) + '"';

function send(res, code, obj, extra) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'X-Keyring-Api': '1',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extra || {}));
  res.end(body);
}

function authed(req) {
  if (!TOKEN) return true;
  const h = req.headers['authorization'] || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-keyring-token'] || '');
  const a = Buffer.from(String(t));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, cb) {
  let len = 0; const chunks = [];
  req.on('data', c => {
    len += c.length;
    if (len > MAX) { req.destroy(); return cb(new Error('too large')); }
    chunks.push(c);
  });
  req.on('end', () => cb(null, Buffer.concat(chunks)));
  req.on('error', e => cb(e));
}

function snapshot(buf) {
  if (!KEEP) return;
  try {
    const name = 'vault-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    fs.writeFileSync(path.join(VERS, name), buf);
    const files = fs.readdirSync(VERS).filter(f => f.startsWith('vault-')).sort();
    while (files.length > KEEP) fs.unlinkSync(path.join(VERS, files.shift()));
  } catch (e) { console.error('[keyring] snapshot failed:', e.message); }
}

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (url === '/api/health' || url === '/health') return send(res, 200, { ok: true, encrypted_only: !ALLOW_PLAINTEXT });

  if (url !== '/api/vault' && url !== '/vault') return send(res, 404, { error: 'not_found' });
  if (!authed(req)) return send(res, 401, { error: 'unauthorized' });

  /* ---- read ---- */
  if (req.method === 'GET' || req.method === 'HEAD') {
    let buf;
    try { buf = fs.readFileSync(FILE); }
    catch (e) { return send(res, 404, { error: 'empty' }); }
    const tag = etagOf(buf);
    if (req.headers['if-none-match'] === tag) return send(res, 304, {}, { ETag: tag });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'ETag': tag,
      'X-Keyring-Api': '1',
      'Cache-Control': 'no-store'
    });
    return res.end(req.method === 'HEAD' ? undefined : buf);
  }

  /* ---- write ---- */
  if (req.method === 'PUT' || req.method === 'POST') {
    return readBody(req, (err, buf) => {
      if (err) return send(res, 413, { error: 'too_large', max: MAX });

      let rec;
      try { rec = JSON.parse(buf.toString('utf8')); }
      catch (e) { return send(res, 400, { error: 'bad_json' }); }

      // The server refuses to be the place your keys sit in the clear.
      if (!rec || typeof rec !== 'object') return send(res, 400, { error: 'bad_record' });
      if (rec.enc !== true && !ALLOW_PLAINTEXT) return send(res, 400, { error: 'plaintext_refused' });
      if (rec.enc === true && (!rec.ct || !rec.iv || !rec.kdf)) return send(res, 400, { error: 'bad_record' });

      let current = null;
      try { current = fs.readFileSync(FILE); } catch (e) {}
      const currentTag = current ? etagOf(current) : null;
      const ifMatch = req.headers['if-match'];

      if (ifMatch && ifMatch !== '*' && ifMatch !== currentTag) {
        return send(res, 409, { error: 'conflict', etag: currentTag }, currentTag ? { ETag: currentTag } : {});
      }
      if (current) snapshot(current);

      const out = Buffer.from(JSON.stringify(rec));
      const tmp = FILE + '.tmp';
      try {
        fs.writeFileSync(tmp, out, { mode: 0o600 });
        fs.renameSync(tmp, FILE);
      } catch (e) {
        console.error('[keyring] write failed:', e.message);
        return send(res, 500, { error: 'write_failed' });
      }
      return send(res, 200, { ok: true, bytes: out.length }, { ETag: etagOf(out) });
    });
  }

  /* ---- delete ---- */
  if (req.method === 'DELETE') {
    let current = null;
    try { current = fs.readFileSync(FILE); } catch (e) {}
    if (!current) return send(res, 404, { error: 'empty' });
    const ifMatch = req.headers['if-match'];
    if (ifMatch && ifMatch !== '*' && ifMatch !== etagOf(current)) {
      return send(res, 409, { error: 'conflict', etag: etagOf(current) });
    }
    snapshot(current);
    try { fs.unlinkSync(FILE); }
    catch (e) { return send(res, 500, { error: 'delete_failed' }); }
    return send(res, 200, { ok: true, deleted: true });
  }

  return send(res, 405, { error: 'method_not_allowed' });
});

server.listen(PORT, () => {
  console.log('[keyring] sync listening on :' + PORT);
  console.log('[keyring] data dir ' + DATA + ' | auth ' + (TOKEN ? 'on' : 'OFF') +
              ' | plaintext ' + (ALLOW_PLAINTEXT ? 'ALLOWED' : 'refused') + ' | keep ' + KEEP);
});
