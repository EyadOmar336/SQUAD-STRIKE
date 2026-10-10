const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function api(path, body, method) {
  const response = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  assert(response.ok, `${path}: ${result.error || response.status}`);
  return result;
}

async function auditLayout(page, name, safe = {}) {
  await page.evaluate(safe => {
    for (const edge of ['top', 'right', 'bottom', 'left']) document.documentElement.style.setProperty(`--game-safe-${edge}`, `${safe[edge] || 0}px`);
  }, safe);
  await page.waitForTimeout(250);
  const result = await page.evaluate(() => {
    const failures = [];
    const box = element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const visible = element => getComputedStyle(element).visibility !== 'hidden' && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
    const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
    const center = { x: innerWidth / 2 - 44, y: innerHeight / 2 - 44, right: innerWidth / 2 + 44, bottom: innerHeight / 2 + 44 };
    const widgets = [...document.querySelectorAll('[data-hud]')].filter(visible).map(el => ({ name: el.dataset.hud, el, ...box(el) }));
    const controls = [...document.querySelectorAll('.hud-icon, .touch-action, .touch-fire, .touch-joystick')].filter(visible).map(el => ({ name: el.getAttribute('aria-label'), el, ...box(el) }));
    for (const w of [...widgets, ...controls]) {
      if (w.x < -1 || w.y < -1 || w.right > innerWidth + 1 || w.bottom > innerHeight + 1) failures.push(`${w.name} outside viewport`);
      if (intersects(w, center)) failures.push(`${w.name} obscures aiming area`);
    }
    for (let i = 0; i < widgets.length; i++) for (let j = i + 1; j < widgets.length; j++) {
      if (intersects(widgets[i], widgets[j])) failures.push(`${widgets[i].name} overlaps ${widgets[j].name}`);
    }
    for (let i = 0; i < controls.length; i++) {
      const c = controls[i];
      if (c.width < 43.9 || c.height < 43.9) failures.push(`${c.name} is smaller than 44px`);
      for (let j = i + 1; j < controls.length; j++) if (intersects(c, controls[j])) failures.push(`${c.name} overlaps ${controls[j].name}`);
      for (const w of widgets) if (!w.el.contains(c.el) && intersects(c, w)) failures.push(`${c.name} overlaps HUD ${w.name}`);
      const hit = document.elementFromPoint(c.x + c.width / 2, c.y + c.height / 2);
      if (!hit || !c.el.contains(hit)) failures.push(`${c.name} is blocked by ${hit?.className || 'nothing'}`);
    }
    const aimHit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    if (!aimHit?.closest('.touch-look-zone')) failures.push(`Center swipe intercepted by ${aimHit?.className}`);
    const toolbar = document.querySelector('.hud-tool-buttons');
    const roomText = document.querySelector('.hud-operation-text');
    if (intersects(box(toolbar), box(roomText))) failures.push('Room name runs behind toolbar');
    if (document.querySelector('.battle-shell').scrollWidth > innerWidth + 1) failures.push('Horizontal overflow');
    return {
      failures,
      widgets: widgets.map(({ el, ...item }) => item),
      controls: controls.map(({ el, ...item }) => item),
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  fs.writeFileSync(`.checks/hud/${name}.json`, JSON.stringify(result, null, 2));
  await page.screenshot({ path: `.checks/hud/${name}.png` });
  assert.deepEqual(result.failures, [], `${name}: ${result.failures.join('; ')}`);
  console.log(`PASS: ${name} — separated HUD, clear aim, reachable 44px+ controls`);
}

(async () => {
  fs.mkdirSync('.checks/hud', { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], sessions = [];
  let roomCode;
  try {
    const seed = await api('/api/rooms', { name: 'IRON SANDS • ALPHA SQUAD', map: 'desert', playerName: 'HUD_TEST_BUILDER', capacity: 4, isPrivate: true });
    roomCode = seed.room.code;
    await api(`/api/rooms/${roomCode}`, { token: seed.token }, 'DELETE');
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      localStorage.setItem('squadstrike-name', 'HUD_TOUCH_OPERATOR');
      localStorage.setItem('squadstrike-settings', JSON.stringify({ quality: 'auto', sound: false, sensitivity: 1, volume: 0 }));
    });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    let session;
    page.on('response', async response => {
      if (response.url() === `${base}/api/rooms/${roomCode}` && response.request().method() === 'POST' && response.ok()) {
        session = await response.json(); sessions.push(session);
      }
    });
    await page.goto(`${base}/?room=${roomCode}`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'JOIN ROOM', exact: true }).tap();
    await page.getByRole('button', { name: 'DEPLOY TO BATTLEFIELD', exact: true }).tap();
    await page.getByRole('button', { name: 'ENGAGE', exact: true }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'ENGAGE', exact: true }).tap();
    await page.evaluate(() => { window.__originalHudCanvas = document.querySelector('.battle-canvas canvas'); });
    const dimensions = process.env.HUD_SKIP_LAYOUT ? [] : [
      [390, 844], [360, 800], [320, 568], [375, 667], [430, 932],
      [844, 390], [667, 375], [568, 320], [740, 360], [915, 412],
      [568, 280], [667, 300], [844, 270],
    ];
    for (const [width, height] of dimensions) {
      await page.setViewportSize({ width, height });
      await auditLayout(page, `${width > height ? 'landscape' : 'portrait'}-${width}x${height}`);
      assert(await page.evaluate(() => window.__originalHudCanvas === document.querySelector('.battle-canvas canvas')), 'Rotation must not recreate the renderer or reset the match');
    }
    if (!process.env.HUD_SKIP_LAYOUT) {
      await page.setViewportSize({ width: 844, height: 390 });
      await auditLayout(page, 'landscape-notch', { left: 44, right: 44, bottom: 21 });
      await page.setViewportSize({ width: 390, height: 844 });
      await auditLayout(page, 'portrait-notch', { top: 47, bottom: 34 });
    }
    if (process.env.HUD_LAYOUT_ONLY) {
      assert.deepEqual(errors, []);
      console.log('PASS: all portrait, landscape, short-height and safe-area layout cases');
      return;
    }
    await page.evaluate(() => { for (const edge of ['top','right','bottom','left']) document.documentElement.style.setProperty(`--game-safe-${edge}`, '0px'); });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(350);

    // Restart the existing match if test setup consumed health; the room session is unchanged.
    await page.getByRole('button', { name: 'Pause game', exact: true }).tap();
    await page.getByRole('button', { name: 'RESTART OPERATION', exact: true }).tap();
    await page.waitForTimeout(450);
    const self = async () => (await api(`/api/rooms/${roomCode}`)).players.find(p => p.id === session.playerId);
    const client = await context.newCDPSession(page);
    const touch = (type, points) => client.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    const stick = await page.locator('.touch-joystick').boundingBox();
    const fire = await page.locator('.touch-fire').boundingBox();
    const start = { id: 1, x: stick.x + stick.width / 2 - 25, y: stick.y + stick.height / 2 + 16 };
    const origin = (await self()).position;
    await touch('touchStart', [start]);
    await page.waitForTimeout(350);
    const stationary = (await self()).position;
    assert(Math.hypot(stationary.x - origin.x, stationary.z - origin.z) < 0.1, 'Off-center joystick contact must not cause an initial jump');
    const move = { ...start, x: start.x + 18, y: start.y - 34 };
    await touch('touchMove', [move]);
    await page.waitForTimeout(650);
    const moved = await self();
    assert(Math.hypot(moved.position.x - stationary.x, moved.position.z - stationary.z) > 0.3, 'Joystick must move the real network player');
    const fireStart = { id: 2, x: fire.x + fire.width / 2, y: fire.y + fire.height / 2 };
    await touch('touchStart', [move, fireStart]);
    const shotsBefore = moved.shots;
    await page.waitForTimeout(180);
    await touch('touchMove', [move, { ...fireStart, x: fireStart.x - 42, y: fireStart.y - 8 }]);
    await page.waitForTimeout(500);
    const firing = await self();
    assert(firing.shots > shotsBefore, 'FIRE must shoot while joystick is held');
    assert(Math.abs(firing.position.yaw - moved.position.yaw) > 0.06, 'Dragging FIRE must turn the real player');
    assert.equal(await page.locator('.touch-joystick').getAttribute('data-active'), 'true');
    // CDP's non-empty touchEnd list contains the released contact, not the contacts still held.
    await touch('touchEnd', [{ ...fireStart, x: fireStart.x - 42, y: fireStart.y - 8 }]);
    assert.equal(await page.locator('.touch-fire').getAttribute('data-held'), 'false');
    assert.equal(await page.locator('.touch-joystick').getAttribute('data-active'), 'true', 'Lifting the fire finger must not release the movement finger');
    await touch('touchEnd', []);
    await page.waitForTimeout(550);
    const released = await self();
    await page.waitForTimeout(350);
    const still = await self();
    assert.equal(still.shots, released.shots, 'No stuck automatic fire after release');
    assert(Math.hypot(still.position.x - released.position.x, still.position.z - released.position.z) < 0.12, 'No stuck movement after release');
    console.log('PASS: floating joystick, two-finger move + fire + drag aim, independent release');

    await page.getByRole('button', { name: 'Reload weapon', exact: true }).tap();
    await page.waitForFunction(() => document.querySelector('.ammo-count strong')?.textContent === '30', null, { timeout: 5000 });
    await page.getByRole('button', { name: 'Toggle aim down sights', exact: true }).tap();
    assert.equal(await page.getByRole('button', { name: 'Toggle aim down sights', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Toggle aim down sights', exact: true }).tap();
    await page.getByRole('button', { name: 'Jump', exact: true }).tap();
    const grenadesBefore = await page.locator('.grenade-count b').innerText();
    await page.getByRole('button', { name: 'Throw grenade', exact: true }).tap();
    await page.waitForFunction(previous => Number(document.querySelector('.grenade-count b')?.textContent) === previous - 1, Number(grenadesBefore));
    console.log('PASS: reload, aim toggle, jump and grenade controls retained');

    const updatedFire = await page.locator('.touch-fire').boundingBox();
    await touch('touchStart', [{ id: 3, x: updatedFire.x + updatedFire.width / 2, y: updatedFire.y + updatedFire.height / 2 }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(550);
    await touch('touchCancel', []);
    assert.equal(await page.locator('.touch-fire').getAttribute('data-held'), 'false');
    assert.equal(await page.locator('.touch-joystick').getAttribute('data-active'), 'false');
    assert(await page.evaluate(() => window.__originalHudCanvas === document.querySelector('.battle-canvas canvas')));
    const afterRotate = await self();
    await page.waitForTimeout(350);
    assert.equal((await self()).shots, afterRotate.shots);
    console.log('PASS: rotate during held fire releases input without recreating room or renderer');

    await page.getByRole('button', { name: 'Pause game', exact: true }).tap();
    const slider = page.getByLabel('Touch sensitivity', { exact: true });
    await slider.focus();
    await slider.press('Home');
    for (let step = 0; step < 4; step++) await slider.press('ArrowRight');
    assert.equal(await page.evaluate(() => localStorage.getItem('squadstrike-touch-sensitivity')), '0.65');
    await page.screenshot({ path: '.checks/hud/touch-settings.png' });
    await page.getByRole('button', { name: 'RESUME BATTLE', exact: true }).tap();
    console.log('PASS: in-game touch sensitivity saved without restarting the game');
    await page.getByRole('button', { name: 'Pause game', exact: true }).tap();
    await page.getByRole('button', { name: 'Return to lobby', exact: true }).tap();
    await page.getByRole('button', { name: 'Leave room', exact: true }).tap();
    await page.getByRole('button', { name: 'التبديل إلى العربية', exact: true }).tap();
    await page.getByRole('button', { name: 'العب الآن', exact: true }).tap();
    await page.getByRole('button', { name: 'ابدأ القتال', exact: true }).tap();
    await auditLayout(page, 'arabic-portrait');
    await page.setViewportSize({ width: 667, height: 375 });
    await auditLayout(page, 'arabic-landscape');
    assert.equal(await page.locator('.armor-panel').getAttribute('aria-label'), 'الدرع: غير متاح في هذا النمط');
    assert.deepEqual(errors, [], 'Browser must have no runtime or console errors');
    console.log('PASS: Arabic HUD and honest armor state; no browser errors');
  } finally {
    for (const session of sessions) { try { await api(`/api/rooms/${roomCode}`, { token: session.token }, 'DELETE'); } catch {} }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
