// Emulates a phone (coarse pointer, touch, 3x DPR, landscape) and verifies the
// mobile path: touch controls mount, quality drops, the scene renders clean.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true, args:['--enable-unsafe-swiftshader','--mute-audio']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
page.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); });
await page.emulate({
  name:'iPhone 15 landscape',
  userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport:{width:852,height:393,deviceScaleFactor:3,isMobile:true,hasTouch:true,isLandscape:true},
});
await page.goto('http://localhost:8017/index.html?t=6&seed=7&live=1',{waitUntil:'networkidle0',timeout:90000});
await page.waitForFunction('window.__SHOT_READY === true',{timeout:90000});
const r = await page.evaluate(()=>({
  coarse: matchMedia('(pointer: coarse)').matches,
  touchRoot: !!document.querySelector('.ft-root'),
  buttons: document.querySelectorAll('.ft-btn').length,
  miniButtons: document.querySelectorAll('.ft-mini').length,
  rotateShown: getComputedStyle(document.getElementById('rotate')).display,
  pixelRatio: window.__APP.renderer.getPixelRatio(),
  devicePixelRatio: window.devicePixelRatio,
  canvasW: window.__APP.renderer.domElement.width,
  crowdInstances: (()=>{let n=0;window.__APP.scene.traverse(o=>{if(o.isInstancedMesh&&o.count>2000)n=Math.max(n,o.count);});return n;})(),
}));
// Simulate a thumb drag on the left half and check the player responds.
const before = await page.evaluate(()=>{const p=window.__APP.match.controlledPlayer;return {id:p.id,x:+p.pos.x.toFixed(2)};});
await page.touchscreen.touchStart(150,220);
await page.touchscreen.touchMove(240,220);            // drag right
await new Promise(r=>setTimeout(r,2200));
const during = await page.evaluate(()=>{const p=window.__APP.match.controlledPlayer;return {id:p.id,vx:+p.vel.x.toFixed(2),vz:+p.vel.z.toFixed(2)};});
await page.touchscreen.touchEnd();
await page.screenshot({path:'shots/mobile.png'});
console.log(JSON.stringify({...r, before, duringDragRight:during, errors:errs.slice(0,4)},null,2));
await b.close();
