// Verifies that keyboard input actually drives the controlled player.
// usage: node tools/inputcheck.js
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--enable-unsafe-swiftshader', '--mute-audio', '--window-size=900,600'],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:8017/index.html?cam=broadcast&t=6&seed=7&live=1',
    { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction('window.__SHOT_READY === true', { timeout: 60000 });

  const before = await page.evaluate(() => {
    const m = window.__APP.match;
    const p = m.controlledPlayer;
    return {
      hasControlled: !!p,
      id: p && p.id, number: p && p.number, team: p && p.team,
      pos: p && { x: +p.pos.x.toFixed(2), z: +p.pos.z.toFixed(2) },
    };
  });

  // Hold "D" (screen-right) for a second of real time.
  await page.focus('body');
  await page.keyboard.down('KeyD');
  await new Promise((r) => setTimeout(r, 1000));
  const during = await page.evaluate(() => {
    const m = window.__APP.match;
    const p = m.controlledPlayer;
    return {
      id: p && p.id,
      pos: p && { x: +p.pos.x.toFixed(2), z: +p.pos.z.toFixed(2) },
      speed: p && +Math.hypot(p.vel.x, p.vel.z).toFixed(2),
    };
  });
  await page.keyboard.up('KeyD');

  // Same player still selected? Did it move along −X (screen-right)?
  const moved = before.pos && during.pos
    ? { dx: +(during.pos.x - before.pos.x).toFixed(2), dz: +(during.pos.z - before.pos.z).toFixed(2) }
    : null;

  console.log(JSON.stringify({
    errors: errors.slice(0, 3),
    before, during, movedWhileHoldingD: moved,
    sameControlledPlayer: before.id === during.id,
  }, null, 2));
} finally {
  await browser.close();
}
