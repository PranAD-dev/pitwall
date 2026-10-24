// Frame-rate probe. Reports the actual WebGL renderer string (so you know
// whether you measured the GPU or a software rasteriser) plus frame timings.
// usage: node tools/perf.js [cam] [seconds] [--gpu]
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cam = process.argv[2] || 'broadcast';
const secs = parseFloat(process.argv[3] || '8');
const useGpu = process.argv.includes('--gpu');

const args = ['--mute-audio', '--window-size=1920,1080'];
if (useGpu) args.push('--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization');
else args.push('--enable-unsafe-swiftshader');

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: useGpu ? false : true,
  args,
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:8017/index.html?cam=${cam}&t=6&seed=7&live=1`, {
    waitUntil: 'networkidle0', timeout: 60000,
  });
  await page.waitForFunction('window.__SHOT_READY === true', { timeout: 60000 });

  const result = await page.evaluate(async (secs) => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';

    const frames = [];
    let last = performance.now();
    await new Promise((resolve) => {
      const t0 = last;
      function tick(now) {
        frames.push(now - last);
        last = now;
        if (now - t0 < secs * 1000) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
    const f = frames.slice(5).sort((a, b) => a - b);
    const pct = (p) => Math.round(f[Math.floor(f.length * p)] * 100) / 100;
    const mean = f.reduce((a, b) => a + b, 0) / f.length;
    const info = window.__APP.renderer.info;
    return {
      renderer,
      frames: f.length,
      meanMs: Math.round(mean * 100) / 100,
      fps: Math.round((1000 / mean) * 10) / 10,
      p50: pct(0.5), p95: pct(0.95),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs ? info.programs.length : null,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
    };
  }, secs);

  console.log(JSON.stringify({ cam, ...result }, null, 2));
} finally {
  await browser.close();
}
