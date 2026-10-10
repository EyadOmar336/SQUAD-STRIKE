// Voice chat smoke test: WebRTC signaling relay + two real browser sessions with
// fake microphones talking to each other + microphone permission flows.
// Honesty note: this exercises the full pipeline (permission UI, signaling, peer
// connections, audio tracks flowing, speaking indicator, mute) between two live
// browser players on one machine with synthetic mic input. Final voice quality
// validation still needs two real human players on real devices/networks.
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.TEST_BASE_URL || 'http://localhost:3000';

async function api(path, body, method) {
  const response = await fetch(base + path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert(response.ok, data.error || `API request failed: ${path}`);
  return data;
}

(async () => {
  fs.mkdirSync('.checks', { recursive: true });
  // --- Part 1: signaling relay works over the API ---
  const seed = await api('/api/rooms', { name: 'Voice Comms Test', map: 'valley', playerName: 'VOICE_BUILDER', capacity: 4, isPrivate: true });
  const code = seed.room.code;
  await api('/api/rooms/' + code, { token: seed.token }, 'DELETE');
  const bravo = await api('/api/rooms/' + code, { name: 'BRAVO_VOICE' });
  const alpha = await api('/api/rooms/' + code, { name: 'ALPHA_VOICE' });
  let poll = await api(`/api/rooms/${code}/voice`, { token: bravo.token });
  assert.deepEqual(poll.peers, [], 'Voice roster starts empty before anyone enables voice');
  await api(`/api/rooms/${code}/voice`, { token: alpha.token, signals: [{ to: bravo.playerId, kind: 'offer', payload: { sdp: { type: 'offer', sdp: 'v=0-fake' } } }] });
  poll = await api(`/api/rooms/${code}/voice`, { token: bravo.token });
  assert.equal(poll.signals.length, 1, 'Offer must reach the target player');
  assert.equal(poll.signals[0].from, alpha.playerId);
  assert.equal(poll.signals[0].kind, 'offer');
  assert.equal(poll.signals[0].payload.sdp.sdp, 'v=0-fake');
  assert.deepEqual(poll.peers.map(p => p.id).sort(), [alpha.playerId].sort(), 'Active voice peers are visible on the roster');
  poll = await api(`/api/rooms/${code}/voice`, { token: bravo.token });
  assert.equal(poll.signals.length, 0, 'Signals are consumed once delivered');
  const bad = await fetch(`${base}/api/rooms/${code}/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong-token' }) });
  assert.equal(bad.status, 401, 'Voice signaling requires a valid session');
  console.log('PASS: voice signaling relay (offer routing, consumption, roster, auth)');

  // --- Part 2: two browser players with fake microphones ---
  const browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ['--mute-audio'],
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const errors = [], sessions = [];
  try {
    const pages = [];
    const playerIds = {};
    for (const name of ['ALPHA_VOICE', 'BRAVO_VOICE']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      await context.addInitScript(name => {
        localStorage.setItem('squadstrike-name', name);
        localStorage.setItem('squadstrike-settings', JSON.stringify({ quality: 'low', sound: true, volume: 0.2, sensitivity: 1 }));
      }, name);
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(`${name}: ${error.message}`));
      page.on('response', async response => {
        if (response.url() === `${base}/api/rooms/${code}` && response.request().method() === 'POST' && response.ok()) {
          const data = await response.json();
          sessions.push(data);
          playerIds[name] = data.playerId;
        }
      });
      await page.goto(`${base}/?room=${code}`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: 'JOIN ROOM', exact: true }).click();
      await page.getByRole('button', { name: 'DEPLOY TO BATTLEFIELD', exact: true }).click();
      await page.getByRole('button', { name: 'ENGAGE', exact: true }).waitFor({ timeout: 60000 });
      await page.getByRole('button', { name: 'ENGAGE', exact: true }).click();
      pages.push(page);
    }
    console.log('PASS: two players deployed into the same room');

    // Enable voice through the real in-game paths: hotkey V while fighting (mouse is
    // pointer-locked then), and the pause-menu mic button on the second player.
    await pages[0].keyboard.press('KeyV');
    await pages[0].getByRole('heading', { name: 'TALK TO YOUR SQUAD.' }).waitFor();
    assert(await pages[0].getByText('never recorded or stored', { exact: false }).isVisible(), 'Permission dialog must explain mic usage clearly');
    await pages[0].getByRole('button', { name: 'ENABLE MICROPHONE', exact: true }).click();
    await pages[0].waitForFunction(() => document.querySelector('.voice-toggle')?.dataset.voiceStatus === 'live', null, { timeout: 15000 });
    await pages[1].keyboard.press('KeyP');
    await pages[1].getByRole('heading', { name: 'TAKE A BREATHER.' }).waitFor();
    await pages[1].locator('.pause-utilities').getByRole('button', { name: 'Voice chat microphone', exact: true }).click();
    await pages[1].getByRole('heading', { name: 'TALK TO YOUR SQUAD.' }).waitFor();
    await pages[1].getByRole('button', { name: 'ENABLE MICROPHONE', exact: true }).click();
    await pages[1].waitForFunction(() => document.querySelector('.voice-toggle')?.dataset.voiceStatus === 'live', null, { timeout: 15000 });
    await pages[1].getByRole('button', { name: 'RESUME BATTLE', exact: true }).click();
    console.log('PASS: clear mic permission dialog (hotkey + pause menu), both microphones live');

    // Peer connections must form and carry real, decoded audio.
    for (const page of pages) {
      await page.waitForFunction(() => Number(document.querySelector('.voice-toggle')?.dataset.voicePeers) >= 1, null, { timeout: 45000 });
      await page.waitForFunction(() => {
        const audio = document.querySelector('audio[data-voice-audio]');
        return !!audio?.srcObject && audio.srcObject.getAudioTracks().some(track => track.readyState === 'live');
      }, null, { timeout: 45000 });
    }
    // Raw transport proof: RTP audio packets must actually cross in both directions.
    for (const page of pages) {
      await page.waitForFunction(async () => {
        const stats = await window.__squadVoice.transportStats();
        return stats.some(s => s.bytesReceived > 0 && s.bytesSent > 0);
      }, null, { timeout: 45000 });
    }
    const transport = await pages[0].evaluate(() => window.__squadVoice.transportStats());
    assert(transport[0].bytesReceived > 0 && transport[0].bytesSent > 0, 'RTP audio must flow both ways');
    console.log('PASS: RTP voice packets flowing in both directions', JSON.stringify(transport));
    // The fake mic emits a periodic tone. The LOCAL indicator proves mic capture;
    // the REMOTE indicator on the other player proves voice audio crossed the
    // WebRTC connection and was analyzed on the receiving side.
    // (Element decode counters are not maintained in headless Chromium, so the
    // speaking indicator is the in-app signal that remote audio is flowing.)
    // The engine auto-pauses a page when it loses focus, and the feed lives in the
    // live HUD — so each page is brought to the front (and resumed) before its checks.
    async function focusBattle(page) {
      await page.bringToFront();
      await page.waitForTimeout(300);
      const resume = page.getByRole('button', { name: 'RESUME BATTLE', exact: true });
      for (let i = 0; i < 3 && await resume.isVisible().catch(() => false); i++) {
        await resume.click();
        await page.waitForTimeout(300);
      }
    }
    try {
      await focusBattle(pages[0]);
      await pages[0].waitForSelector('[data-speaking-peer="self"]', { timeout: 40000 });
      await pages[0].waitForSelector(`[data-speaking-peer="${playerIds['BRAVO_VOICE']}"]`, { timeout: 40000 });
      await focusBattle(pages[1]);
      await pages[1].waitForSelector('[data-speaking-peer="self"]', { timeout: 40000 });
      await pages[1].waitForSelector(`[data-speaking-peer="${playerIds['ALPHA_VOICE']}"]`, { timeout: 40000 });
    } catch (error) {
      for (const [index, page] of pages.entries()) {
        const debug = await page.evaluate(() => ({
          snapshot: window.__squadVoice?.snapshot(),
          analysis: window.__squadVoice?.analysis?.state,
          feed: document.querySelector('.voice-feed')?.outerHTML ?? 'no-feed',
          status: document.querySelector('.voice-status')?.textContent ?? 'no-status',
          paused: !!document.querySelector('.pause-dialog'),
        }));
        console.log(`speaking debug page${index}:`, JSON.stringify(debug));
      }
      throw error;
    }
    await pages[1].screenshot({ path: '.checks/voice-live.png' });
    console.log('PASS: speaking indicators show local and remote players while they talk');

    // Mute / unmute keeps the call alive and flips state instantly. The battle
    // locks the mouse to the canvas, so the player reaches HUD buttons through
    // the pause menu — exactly the in-match route.
    await focusBattle(pages[0]);
    await pages[0].keyboard.press('KeyP');
    await pages[0].locator('.pause-utilities').getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await pages[0].waitForFunction(() => document.querySelector('.voice-toggle')?.dataset.voiceStatus === 'muted', null, { timeout: 5000 });
    assert.equal(await pages[0].locator('.voice-status').getAttribute('data-voice-status'), 'muted');
    await pages[0].locator('.pause-utilities').getByRole('button', { name: 'Unmute microphone', exact: true }).click();
    await pages[0].waitForFunction(() => document.querySelector('.voice-toggle')?.dataset.voiceStatus === 'live', null, { timeout: 5000 });
    await pages[1].waitForFunction(() => Number(document.querySelector('.voice-toggle')?.dataset.voicePeers) >= 1, null, { timeout: 10000 });

    // Game systems must remain intact while voice runs.
    const soundControl = pages[0].locator('.pause-utilities').getByRole('button', { name: /sound/i });
    assert(await soundControl.isVisible(), 'Game sound toggle stays available and independent');
    const soundLabelBefore = (await soundControl.innerText()).trim();
    await soundControl.click();
    const soundLabelAfter = (await pages[0].locator('.pause-utilities').getByRole('button', { name: /sound/i }).innerText()).trim();
    assert.notEqual(soundLabelAfter, soundLabelBefore, 'Game sound toggle still works');
    await pages[0].locator('.pause-utilities').getByRole('button', { name: /sound/i }).click();
    assert(/\d+\s*\/\s*\d+/.test(await pages[0].locator('.hud-score').textContent() ?? ''), 'Room HUD still shows the squad');
    assert((await pages[0].locator('.pause-utilities [data-voice-status]').getAttribute('data-voice-status')) === 'live', 'Mic button stays available');
    await pages[0].getByRole('button', { name: 'RESUME BATTLE', exact: true }).click();
    console.log('PASS: mute/unmute toggle keeps the call, game sounds and HUD unaffected');

    // Denial path: a player whose getUserMedia is refused gets clear guidance.
    const deniedContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await deniedContext.addInitScript(() => {
      localStorage.setItem('squadstrike-name', 'DENIED_VOICE');
      localStorage.setItem('squadstrike-settings', JSON.stringify({ quality: 'low', sound: false, volume: 0.1, sensitivity: 1 }));
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; };
      window.__realGetUserMedia = original;
    });
    const deniedPage = await deniedContext.newPage();
    deniedPage.on('pageerror', error => errors.push(`denied: ${error.message}`));
    await deniedPage.goto(`${base}/?room=${code}`, { waitUntil: 'networkidle' });
    await deniedPage.getByRole('button', { name: 'JOIN ROOM', exact: true }).click();
    await deniedPage.getByRole('button', { name: 'DEPLOY TO BATTLEFIELD', exact: true }).click();
    await deniedPage.getByRole('button', { name: 'ENGAGE', exact: true }).waitFor({ timeout: 120000 });
    await deniedPage.getByRole('button', { name: 'ENGAGE', exact: true }).click();
    await deniedPage.keyboard.press('KeyV');
    await deniedPage.getByRole('button', { name: 'ENABLE MICROPHONE', exact: true }).click();
    await deniedPage.getByRole('button', { name: 'TRY AGAIN', exact: true }).waitFor({ timeout: 10000 });
    await deniedPage.getByText('Microphone permission was blocked', { exact: false }).waitFor({ timeout: 10000 });
    await deniedPage.screenshot({ path: '.checks/voice-denied.png' });
    await deniedPage.getByRole('button', { name: 'NOT NOW', exact: true }).click();
    assert.equal(await deniedPage.locator('.voice-toggle').getAttribute('data-voice-status'), 'denied');
    console.log('PASS: blocked microphone shows clear recovery guidance');

    assert.deepEqual(errors, [], `Browser errors: ${errors.join('; ')}`);
    console.log('PASS: no page errors across voice sessions');
  } finally {
    for (const session of sessions) { try { await api('/api/rooms/' + code, { token: session.token }, 'DELETE'); } catch {} }
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
