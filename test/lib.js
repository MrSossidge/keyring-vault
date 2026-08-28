'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PAGE = path.join(ROOT, 'site', 'keyring.html');

/* --- tiny assertion harness ------------------------------------- */
function harness(title) {
  let fails = 0;
  console.log('\n\x1b[1m' + title + '\x1b[0m');
  return {
    ok(name, cond) {
      if (!cond) fails++;
      console.log(cond ? '  \x1b[32mPASS\x1b[0m  ' + name : '  \x1b[31mFAIL\x1b[0m  ' + name);
    },
    fail(msg) { fails++; console.log('  \x1b[31mFAIL\x1b[0m  ' + msg); },
    get failures() { return fails; }
  };
}

/* --- serve the page, optionally proxying /api ------------------- */
function serve(port, apiPort) {
  const srv = http.createServer((req, res) => {
    if (apiPort && req.url.startsWith('/api')) {
      const up = http.request(
        { host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers },
        r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(up);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(PAGE));
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

/* --- run the real sync server ----------------------------------- */
function startApi(dataDir, port, env, opts) {
  const fresh = !opts || opts.fresh !== false;
  if (fresh) fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  return new Promise(resolve => {
    const p = spawn('node', [path.join(ROOT, 'sync', 'server.js')], {
      env: Object.assign({}, process.env, { KEYRING_DATA: dataDir, PORT: String(port) }, env || {})
    });
    p.stdout.on('data', d => { if (String(d).includes('listening')) resolve(p); });
    p.stderr.on('data', d => process.stderr.write('[api] ' + d));
  });
}
const stopApi = p => new Promise(r => { if (!p) return r(); p.on('exit', () => r()); p.kill(); });

/* --- page driving ------------------------------------------------ */
const ui = {
  async create(p, pw) { await p.fill('#p1', pw); await p.fill('#p2', pw); await p.click('#go'); await p.waitForTimeout(1200); },
  async unlock(p, pw) { await p.fill('#p1', pw); await p.click('#go'); await p.waitForTimeout(1400); },
  async add(p, fields) {
    await p.click('#add'); await p.waitForTimeout(250);
    for (const [k, v] of Object.entries(fields)) await p.fill('#f_' + k, v);
    await p.click('#save'); await p.waitForTimeout(1100);
  },
  rows: p => p.locator('.row').count(),
  async names(p) { return (await p.locator('.rname').allInnerTexts()).map(t => t.split('\n')[0].trim()); }
};

module.exports = { ROOT, PAGE, harness, serve, startApi, stopApi, ui };
