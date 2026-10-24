// Verifies the synthesised atmosphere actually runs: AudioContext started and
// running after a gesture, nodes scheduling, and no console errors.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--use-angle=metal']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
page.on('console',m=>{ if(m.type()==='error') errs.push(m.text()); });
await page.goto('http://localhost:8017/index.html?live=1',{waitUntil:'networkidle0',timeout:60000});
await new Promise(r=>setTimeout(r,1500));
console.log('before gesture:', JSON.stringify(await page.evaluate(()=>window.__APP.audio.debug())));
await page.mouse.click(640,400);
await new Promise(r=>setTimeout(r,1200));
console.log('after gesture: ', JSON.stringify(await page.evaluate(()=>window.__APP.audio.debug())));
// force the entrance fanfare and a goal roar
await page.evaluate(()=>window.__APP.audio.anthem());
await new Promise(r=>setTimeout(r,3000));
const mid = await page.evaluate(()=>window.__APP.audio.debug());
await new Promise(r=>setTimeout(r,12000));
console.log('after 15s:    ', JSON.stringify(await page.evaluate(()=>window.__APP.audio.debug())));
console.log('errors:', errs.slice(0,4).length?errs.slice(0,4):'clean');
await b.close();
