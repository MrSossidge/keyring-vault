'use strict';
/* The vault on its own: no sync server, no network. */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { harness, serve, ui } = require('./lib');

const PORT = 8171;
const PW = 'correct-horse-battery';

module.exports = async function run() {
  const t = harness('Local vault — encryption, CRUD, backup/restore');
  const web = await serve(PORT);
  const b = await chromium.launch();
  const ctx = await b.newContext({ acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => t.fail('page error: ' + e.message));

  await p.goto('http://127.0.0.1:' + PORT + '/');
  await p.waitForTimeout(400);

  t.ok('runs in a secure context with WebCrypto',
    await p.evaluate(() => window.isSecureContext && !!crypto.subtle));
  t.ok('a fresh browser is offered the create screen',
    await p.locator('h1', { hasText: 'Create your vault' }).isVisible());

  await ui.create(p, PW);
  t.ok('creating the vault lands in the app', await p.locator('#add').isVisible());
  t.ok('empty state explains itself', (await p.locator('.empty h3').innerText()).includes('Nothing stored'));

  await ui.add(p, {
    name: 'Sonarr to Jellyfin', issuer: 'Jellyfin', app: 'Sonarr',
    key: 'abc123SECRETKEY', secret: 'shh-client-secret',
    url: 'http://10.0.0.20:8096', stack: 'media-stack', tags: 'portainer, media',
    expires: new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10),
    notes: 'Regenerate under Dashboard > API Keys'
  });
  t.ok('the entry appears in the list', (await ui.names(p))[0].includes('Sonarr'));
  t.ok('an approaching expiry is flagged', await p.locator('.badge.soon').first().isVisible());
  t.ok('tags become filter chips', (await p.locator('.tags-row .chip').count()) >= 2);

  await ui.add(p, { name: 'Portainer admin token', issuer: 'Portainer', key: 'ptr_live_999', tags: 'portainer', expires: '2020-01-01' });
  t.ok('a second entry is stored', (await ui.rows(p)) === 2);
  t.ok('a past expiry is flagged as expired', await p.locator('.badge.exp').first().isVisible());

  /* values are hidden until asked for */
  await p.locator('.row').filter({ hasText: 'Sonarr' }).locator('.rhead').click();
  await p.waitForTimeout(300);
  t.ok('secrets are masked by default', /^•+$/.test((await p.locator('.fld .v.secret').first().innerText()).trim()));
  await p.locator('[data-reveal]').first().click();
  await p.waitForTimeout(250);
  t.ok('reveal shows the real value', (await p.locator('.fld .v.secret').first().innerText()).includes('abc123SECRETKEY'));
  t.ok('the other secret stays masked', /^•+$/.test((await p.locator('.fld .v.secret').nth(1).innerText()).trim()));

  /* copy */
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await p.locator('.row').filter({ hasText: 'Sonarr' }).locator('.rhead [data-copy="key"]').click();
  await p.waitForTimeout(300);
  t.ok('the copy button puts the key on the clipboard',
    (await p.evaluate(() => navigator.clipboard.readText())) === 'abc123SECRETKEY');

  /* search + tags */
  await p.fill('#q', 'jellyfin'); await p.waitForTimeout(250);
  t.ok('search narrows the list', (await ui.rows(p)) === 1);
  await p.fill('#q', ''); await p.waitForTimeout(200);
  await p.locator('.tags-row .chip', { hasText: 'media' }).first().click(); await p.waitForTimeout(250);
  t.ok('a tag chip filters', (await ui.rows(p)) === 1);
  await p.locator('.tags-row .chip', { hasText: 'clear' }).first().click(); await p.waitForTimeout(250);
  t.ok('clearing the tag restores the list', (await ui.rows(p)) === 2);

  /* what actually sits in storage */
  const raw = await p.evaluate(() => localStorage.getItem('keyring.vault.v1'));
  t.ok('stored blob is an encrypted record', JSON.parse(raw).enc === true && !!JSON.parse(raw).ct);
  t.ok('stored blob leaks neither key nor entry name',
    !raw.includes('abc123SECRETKEY') && !raw.includes('Sonarr'));

  /* backup */
  const backupPath = path.join(os.tmpdir(), 'keyring-test-backup.json');
  const dl = p.waitForEvent('download');
  await p.click('#menubtn'); await p.waitForTimeout(150);
  await p.click('[data-a="exp-enc"]');
  fs.writeFileSync(backupPath, fs.readFileSync(await (await dl).path()));
  t.ok('the exported backup is still encrypted', JSON.parse(fs.readFileSync(backupPath, 'utf8')).enc === true);

  /* lock / unlock */
  await p.click('#lockbtn'); await p.waitForTimeout(300);
  t.ok('locking returns to the unlock screen', await p.locator('h1', { hasText: 'Unlock' }).isVisible());
  await ui.unlock(p, 'not-the-password');
  t.ok('the wrong password is refused', (await p.locator('#gerr').innerText()).includes('Wrong'));
  await ui.unlock(p, PW);
  t.ok('the right password restores the entries', (await ui.rows(p)) === 2);

  await p.reload(); await p.waitForTimeout(400); await ui.unlock(p, PW);
  t.ok('the vault survives a reload', (await ui.rows(p)) === 2);

  /* master password rotation */
  await p.click('#menubtn'); await p.waitForTimeout(150);
  await p.click('[data-a="chpw"]'); await p.waitForTimeout(250);
  await p.fill('#c_old', PW); await p.fill('#c_a', 'new-master-phrase'); await p.fill('#c_b', 'new-master-phrase');
  await p.click('#c_go'); await p.waitForTimeout(1200);
  await p.click('#lockbtn'); await p.waitForTimeout(300);
  await ui.unlock(p, 'new-master-phrase');
  t.ok('the vault opens with the new password', (await ui.rows(p)) === 2);

  /* wipe, then restore the backup with its original password */
  await p.click('#menubtn'); await p.waitForTimeout(150);
  await p.click('[data-a="wipe"]'); await p.waitForTimeout(250);
  await p.fill('#w_c', 'ERASE'); await p.click('#w_go'); await p.waitForTimeout(500);
  t.ok('wiping returns to the create screen', await p.locator('h1', { hasText: 'Create your vault' }).isVisible());
  await ui.create(p, 'a-brand-new-vault');
  await p.click('#menubtn'); await p.waitForTimeout(150);
  await p.click('[data-a="imp"]'); await p.waitForTimeout(250);
  await p.setInputFiles('#i_file', backupPath); await p.waitForTimeout(400);
  await p.fill('#i_pw', PW);
  await p.click('#i_go'); await p.waitForTimeout(1200);
  t.ok('the encrypted backup restores', (await ui.rows(p)) === 2);

  /* theme */
  await p.click('#menubtn'); await p.waitForTimeout(150);
  await p.click('[data-a="theme"]'); await p.waitForTimeout(250);
  t.ok('the theme toggle sticks', (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'light');

  /* no WebCrypto => refuse to pretend */
  const p2 = await ctx.newPage();
  await p2.addInitScript(() => { try { Object.defineProperty(window.crypto, 'subtle', { value: undefined, configurable: true }); } catch (e) {} });
  await p2.goto('http://127.0.0.1:' + PORT + '/'); await p2.waitForTimeout(400);
  t.ok('without WebCrypto the page says so instead of storing plaintext',
    await p2.locator('.banner.bad').first().isVisible());

  await b.close();
  await new Promise(r => web.close(r));
  fs.rmSync(backupPath, { force: true });
  return t.failures;
};

if (require.main === module) module.exports().then(f => process.exit(f ? 1 : 0));
