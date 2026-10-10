const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const base = 'http://localhost:3000';
async function api(path, body, method) {
  const response = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert(response.ok, data.error || 'API request failed');
  return data;
}
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const sessions = [];
  let code;
  try {
    const seed = await api('/api/rooms', { name: 'Private Squad Test', map: 'harbor', playerName: 'ROOM_BUILDER', capacity: 4, isPrivate: true });
    code = seed.room.code;
    await api('/api/rooms/' + code, { token: seed.token }, 'DELETE');
    const pages = [];
    for (const name of ['ALPHA_TEST', 'BRAVO_TEST']) {
      const context = await browser.newContext({ viewport: { width: 960, height: 640 }, deviceScaleFactor: 1 });
      await context.addInitScript(name => { localStorage.setItem('squadstrike-name', name); localStorage.setItem('squadstrike-settings', JSON.stringify({ quality: 'auto', sound: false, volume: 0.1, sensitivity: 1 })); }, name);
      const page = await context.newPage();
      page.on('pageerror', error => { throw error; });
      page.on('response', async response => { if (response.url() === base + '/api/rooms/' + code && response.request().method() === 'POST' && response.ok()) sessions.push(await response.json()); });
      await page.goto(base + '/?room=' + code, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'JOIN ROOM', exact: true }).click();
      await page.getByRole('button', { name: 'DEPLOY TO BATTLEFIELD', exact: true }).click();
      await page.getByRole('button', { name: 'ENGAGE', exact: true }).waitFor({ timeout: 30000 });
      await page.getByRole('button', { name: 'ENGAGE', exact: true }).click();
      pages.push(page);
    }
    await pages[1].waitForFunction(() => document.querySelector('.hud-score')?.textContent.includes('2 / 4'), null, { timeout: 15000 });
    let room = await api('/api/rooms/' + code);
    assert.equal(room.players.filter(p => p.playing).length, 2);
    const before = room.players.find(p => p.name === 'BRAVO_TEST').position;
    await pages[1].keyboard.down('KeyW'); await pages[1].waitForTimeout(650); await pages[1].keyboard.up('KeyW');
    await pages[1].waitForTimeout(550);
    room = await api('/api/rooms/' + code);
    const after = room.players.find(p => p.name === 'BRAVO_TEST').position;
    assert(Math.hypot(after.x - before.x, after.z - before.z) > 0.4, 'Movement must synchronize out of a clear spawn point');
    console.log('PASS: invite link, two browser sessions, shared room, replicated movement');
    await pages[1].keyboard.press('KeyP');
    await pages[1].getByRole('button', { name: 'Return to lobby', exact: true }).click();
    await pages[1].getByRole('button', { name: 'Leave room', exact: true }).click();
    await pages[1].getByRole('button', { name: 'التبديل إلى العربية', exact: true }).click();
    await pages[1].getByRole('button', { name: 'العب الآن', exact: true }).waitFor();
    assert.equal(await pages[1].locator('html').getAttribute('lang'), 'ar');
    assert(await pages[1].evaluate(() => document.body.scrollWidth <= innerWidth));
    console.log('PASS: Arabic interface, RTL layout and document language');
  } finally {
    for (const session of sessions) { try { await api('/api/rooms/' + code, { token: session.token }, 'DELETE'); } catch {} }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
