'use strict';
/* Regenerates the images in docs/screenshots. Not part of the test run. */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { serve, startApi, stopApi, ui, ROOT } = require('./lib');

const API = 8181, WEB = 8182;
const DATA = path.join(require('os').tmpdir(), 'keyring-shots');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PW = 'demo-master-phrase';

const DEMO = [
  { name: 'Sonarr → Jellyfin', issuer: 'Jellyfin', app: 'Sonarr', key: 'e9f1c2a7b4d84e0c9a1f37bd',
    url: 'http://10.0.0.20:8096', stack: 'media-stack @ 10.0.0.20', tags: 'media, portainer',
    expires: new Date(Date.now() + 15 * 864e5).toISOString().slice(0, 10),
    notes: 'Set under Sonarr → Settings → Connect → Jellyfin.\nRegenerate from the Jellyfin dashboard.' },
  { name: 'Portainer admin token', issuer: 'Portainer', app: 'deploy scripts', key: 'ptr_live_9f3a77e21b4c',
    url: 'https://10.0.0.20:9443', stack: 'portainer', tags: 'portainer, infra', expires: '2026-01-01' },
  { name: 'Radarr API', issuer: 'Radarr', app: 'Overseerr', key: 'ra_44b8c1de7790',
    stack: 'media-stack', tags: 'media' },
  { name: 'OpenWeather', issuer: 'OpenWeather', app: 'Home Assistant', key: 'ow_2b7d19aa5c',
    secret: 'sec_9911fe02', url: 'https://api.openweathermap.org', tags: 'iot' }
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const api = await startApi(DATA, API);
  const web = await serve(WEB, API);
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1180, height: 780 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();

  await p.goto('http://127.0.0.1:' + WEB + '/');
  await p.waitForTimeout(400);
  await p.screenshot({ path: path.join(OUT, 'unlock.png'), clip: { x: 290, y: 120, width: 600, height: 540 } });

  await ui.create(p, PW);
  for (const d of DEMO) await ui.add(p, d);
  await p.waitForTimeout(900);

  await p.screenshot({ path: path.join(OUT, 'list-dark.png') });

  await p.locator('.row').filter({ hasText: 'Sonarr' }).locator('.rhead').click();
  await p.waitForTimeout(300);
  await p.locator('[data-reveal]').first().click();
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(OUT, 'entry-dark.png') });

  await p.click('#menubtn'); await p.waitForTimeout(200);
  await p.click('[data-a="theme"]'); await p.waitForTimeout(350);
  await p.screenshot({ path: path.join(OUT, 'entry-light.png') });

  await b.close();
  await stopApi(api);
  await new Promise(r => web.close(r));
  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('screenshots written to docs/screenshots');
})();
