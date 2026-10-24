// Gameplay sanity check: run the sim headlessly and report match statistics.
// usage: node tools/simcheck.js [seconds] [seed]
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const secs = parseFloat(process.argv[2] || '180');
const seed = process.argv[3] || '7';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--mute-audio', '--window-size=800,600'],
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`http://localhost:8017/index.html?cam=broadcast&t=0.5&seed=${seed}`, {
    waitUntil: 'networkidle0', timeout: 60000,
  });
  await page.waitForFunction('window.__SHOT_READY === true', { timeout: 60000 });

  const report = await page.evaluate((secs) => {
    const { match, ball, teams } = window.__APP;
    const DT = 1 / 120;
    const events = [];
    match.onEvent((type, data) => events.push({ type, t: match.state.clockSec, data: data && data.number }));

    const spread = [];       // team shape: mean distance of players from their centroid
    const ballTouches = new Set();
    let maxBallSpeed = 0, aerialTicks = 0, ticks = 0;

    for (let i = 0; i < Math.round(secs / DT); i++) {
      match.update(DT); teams.update(DT); ball.update(DT);
      ticks++;
      const sp = Math.hypot(ball.vel.x, ball.vel.z);
      if (sp > maxBallSpeed) maxBallSpeed = sp;
      if (ball.pos.y > 0.35) aerialTicks++;
      if (ball.controlledBy) ballTouches.add(ball.controlledBy.id);
      if (i % 600 === 0) {
        for (const side of ['home', 'away']) {
          const ps = teams[side].filter((p) => p.role !== 'GK');
          const cx = ps.reduce((a, p) => a + p.pos.x, 0) / ps.length;
          const cz = ps.reduce((a, p) => a + p.pos.z, 0) / ps.length;
          const d = ps.reduce((a, p) => a + Math.hypot(p.pos.x - cx, p.pos.z - cz), 0) / ps.length;
          spread.push(Math.round(d * 10) / 10);
        }
      }
    }
    const counts = {};
    for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
    return {
      score: match.state.score,
      clock: Math.round(match.state.clockSec),
      phase: match.state.phase,
      eventCounts: counts,
      firstEvents: events.slice(0, 14),
      distinctBallHandlers: ballTouches.size,
      maxBallSpeed: Math.round(maxBallSpeed * 10) / 10,
      aerialPct: Math.round((aerialTicks / ticks) * 100),
      shapeSpreadSamples: spread.slice(0, 12),
    };
  }, secs);

  console.log(JSON.stringify({ seed, secs, errors: errors.slice(0, 5), ...report }, null, 2));
} finally {
  await browser.close();
}
