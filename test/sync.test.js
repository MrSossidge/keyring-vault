'use strict';
/* Two browser profiles against a real sync server. */
const { chromium } = require('playwright');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { harness, serve, startApi, stopApi, ui } = require('./lib');

const API = 8172, WEB = 8173;
const DATA = path.join(os.tmpdir(), 'keyring-sync-test');
const PW = 'shared-master-phrase';

const request = (opts, body) => new Promise(res => {
  const q = http.request(Object.assign({ host: '127.0.0.1', port: API, path: '/api/vault' }, opts), r => {
    let d = ''; r.on('data', c => d += c); r.on('end', () => res({ status: r.statusCode, body: d }));
  });
  q.on('error', () => res({ status: 0, body: '' }));
  if (body) q.write(body);
  q.end();
});

module.exports = async function run() {
  const t = harness('Sync — two devices, one encrypted blob');
  let api = await startApi(DATA, API);
  const web = await serve(WEB, API);
  const b = await chromium.launch();

  const device = async name => {
    const p = await (await b.newContext()).newPage();
    p.on('pageerror', e => t.fail('page error [' + name + ']: ' + e.message));
    await p.goto('http://127.0.0.1:' + WEB + '/');
    await p.waitForTimeout(500);
    return p;
  };

  /* --- device A seeds the server --- */
  const A = await device('A');
  t.ok('A: an empty server means a fresh vault', await A.locator('h1', { hasText: 'Create your vault' }).isVisible());
  await ui.create(A, PW);
  await ui.add(A, { name: 'Sonarr key', issuer: 'Sonarr', key: 'sonarr-AAA111', tags: 'media' });
  await ui.add(A, { name: 'Portainer token', issuer: 'Portainer', key: 'ptr-BBB222', tags: 'infra' });
  await A.waitForTimeout(900);

  t.ok('the server wrote a vault file', fs.existsSync(path.join(DATA, 'vault.json')));
  const blob = fs.readFileSync(path.join(DATA, 'vault.json'), 'utf8');
  t.ok('what it stored is an encrypted record', JSON.parse(blob).enc === true && !!JSON.parse(blob).ct);
  t.ok('the server never sees a key value', !blob.includes('sonarr-AAA111') && !blob.includes('ptr-BBB222'));
  t.ok('the server never sees an entry name', !blob.includes('Portainer token') && !blob.includes('Sonarr'));

  /* --- device B is a separate browser profile --- */
  const B = await device('B');
  t.ok('B: finds the server copy and asks to unlock', await B.locator('h1', { hasText: 'Unlock' }).isVisible());
  await ui.unlock(B, PW);
  t.ok('B: sees both of A\'s keys', (await ui.rows(B)) === 2);
  t.ok('B: sees exactly the same entries', (await ui.names(B)).sort().join('|') === (await ui.names(A)).sort().join('|'));

  /* --- additions travel --- */
  await ui.add(B, { name: 'Radarr key', issuer: 'Radarr', key: 'radarr-CCC333', tags: 'media' });
  await B.waitForTimeout(900);
  await A.reload(); await A.waitForTimeout(600); await ui.unlock(A, PW);
  t.ok('A: picks up what B added', (await ui.rows(A)) === 3);

  /* --- deletes must not come back --- */
  await A.locator('[data-del]').first().click(); await A.waitForTimeout(300);
  await A.locator('#yes').click(); await A.waitForTimeout(1200);
  const survivors = (await ui.names(A)).sort();
  t.ok('A: the entry is gone locally', (await ui.rows(A)) === 2);
  await B.reload(); await B.waitForTimeout(600); await ui.unlock(B, PW);
  t.ok('B: the delete propagated rather than resurrecting', (await ui.rows(B)) === 2);
  t.ok('B: the same two entries survive', (await ui.names(B)).sort().join('|') === survivors.join('|'));

  /* --- concurrent edits merge instead of clobbering --- */
  await ui.add(A, { name: 'A-only key', issuer: 'AAA', key: 'aaa-111' });
  await A.waitForTimeout(900);
  await ui.add(B, { name: 'B-only key', issuer: 'BBB', key: 'bbb-222' }); // B's ETag is now stale
  await B.waitForTimeout(2000);
  const bn = await ui.names(B);
  t.ok('B: a stale write merges both sides instead of losing one',
    bn.includes('A-only key') && bn.includes('B-only key'));
  await A.reload(); await A.waitForTimeout(600); await ui.unlock(A, PW);
  t.ok('A: converges on the same set', (await ui.names(A)).sort().join('|') === bn.sort().join('|'));
  t.ok('both devices hold four keys', (await ui.rows(A)) === 4);

  /* --- a value written on B is readable on A --- */
  await A.locator('.row').filter({ hasText: 'B-only key' }).locator('.rhead').click();
  await A.waitForTimeout(300);
  await A.locator('[data-reveal]').first().click(); await A.waitForTimeout(300);
  t.ok('A: decrypts a key that B created', (await A.locator('.fld .v.secret').first().innerText()).includes('bbb-222'));

  await b.close();
  await stopApi(api);

  /* --- server-side guards --- */
  api = await startApi(DATA, API, { KEYRING_TOKEN: 's3cret' }, { fresh: false });
  const auth = { Authorization: 'Bearer s3cret', 'Content-Type': 'application/json' };
  t.ok('an unauthenticated read is refused', (await request({ method: 'GET' })).status === 401);
  t.ok('a wrong token is refused', (await request({ method: 'GET', headers: { Authorization: 'Bearer nope' } })).status === 401);
  t.ok('the right token is accepted', (await request({ method: 'GET', headers: auth })).status === 200);

  const plain = await request({ method: 'PUT', headers: Object.assign({ 'If-Match': '*' }, auth) },
    JSON.stringify({ v: 1, enc: false, data: { entries: [{ key: 'oops' }] } }));
  t.ok('the server refuses to store an unencrypted vault',
    plain.status === 400 && plain.body.includes('plaintext_refused'));

  const stale = await request({ method: 'PUT', headers: Object.assign({ 'If-Match': '"deadbeef"' }, auth) },
    JSON.stringify({ v: 1, enc: true, kdf: { salt: 'x' }, iv: 'y', ct: 'z' }));
  t.ok('the server rejects a stale If-Match', stale.status === 409);

  t.ok('previous versions are kept', fs.readdirSync(path.join(DATA, 'versions')).length > 0);

  await stopApi(api);
  await new Promise(r => web.close(r));
  fs.rmSync(DATA, { recursive: true, force: true });
  return t.failures;
};

if (require.main === module) module.exports().then(f => process.exit(f ? 1 : 0));
