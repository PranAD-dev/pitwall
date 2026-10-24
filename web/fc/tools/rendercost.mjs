// True render cost: time forced renderer.render() calls with gl.finish(),
// bypassing requestAnimationFrame so vsync throttling cannot skew the result.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:false, args:['--use-angle=metal','--ignore-gpu-blocklist','--window-size=1920,1080']});
const page = await b.newPage();
await page.setViewport({width:1920,height:1080,deviceScaleFactor:1});
await page.goto('http://localhost:8017/index.html?cam=broadcast&t=6&seed=7&live=1',{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__SHOT_READY === true',{timeout:60000});
const r = await page.evaluate(async () => {
  const gl = document.querySelector('canvas').getContext('webgl2');
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const { renderer, scene, rig } = window.__APP;
  const t = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    renderer.render(scene, rig.camera);
    gl.finish();                        // block until the GPU is genuinely done
    t.push(performance.now() - t0);
  }
  const s = t.slice(10).sort((a, b) => a - b);
  const info = renderer.info.render;
  return { renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?',
    p50: +s[Math.floor(s.length * 0.5)].toFixed(2),
    p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
    headroomAt60: +(16.7 / s[Math.floor(s.length * 0.5)]).toFixed(1),
    drawCalls: info.calls, triangles: info.triangles };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
