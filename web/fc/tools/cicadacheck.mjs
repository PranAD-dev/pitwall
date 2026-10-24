// Verifies the cicada chorus fires on its timer and takes over the bus.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--use-angle=metal']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
// 12-second cycle so the timer can be observed rather than waited out.
await page.goto('http://localhost:8017/index.html?live=1&cicada=12',{waitUntil:'networkidle0',timeout:60000});
await new Promise(r=>setTimeout(r,1200));
await page.mouse.click(640,400);
const seen=[];
for (let i=0;i<30;i++){
  await new Promise(r=>setTimeout(r,1000));
  const d = await page.evaluate(()=>window.__APP.audio.debug());
  seen.push(d.chorusActive ? 'CHORUS' : '.');
}
const d = await page.evaluate(()=>window.__APP.audio.debug());
console.log('chorusEvery:', d.chorusEvery, 's');
console.log('timeline:', seen.join(''));
console.log('chorus seconds observed:', seen.filter(x=>x==='CHORUS').length, '/ 30');
console.log('errors:', errs.slice(0,3).length?errs.slice(0,3):'clean');
await b.close();
