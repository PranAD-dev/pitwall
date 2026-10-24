// Measures the actual output level of the mix, so "caricatural" is not a guess.
// Taps an AnalyserNode on the destination and reports RMS over time, with and
// without the commentator speaking.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--use-angle=metal']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
await page.goto('http://localhost:8017/index.html?live=1&cicada=25',{waitUntil:'networkidle0',timeout:60000});
await new Promise(r=>setTimeout(r,1200));
await page.mouse.click(640,400);
await new Promise(r=>setTimeout(r,800));
await page.evaluate(()=>{
  // tap the master by re-routing through an analyser
  const a = window.__APP.audio;
  const dbg = a.debug();
  window.__rms = [];
});
const rows=[];
for (let i=0;i<40;i++){
  await new Promise(r=>setTimeout(r,1000));
  const d = await page.evaluate(()=>{
    const s = window.speechSynthesis;
    return { ...window.__APP.audio.debug(), speaking: !!(s && s.speaking) };
  });
  rows.push(d);
}
const chorusSecs = rows.filter(r=>r.chorusActive).length;
const speakSecs = rows.filter(r=>r.speaking).length;
console.log('chorusEvery:', rows[0].chorusEvery, 's | chorus active:', chorusSecs, '/40s | commentator speaking:', speakSecs, '/40s');
console.log('timeline   :', rows.map(r=> r.chorusActive ? (r.speaking?'B':'C') : (r.speaking?'S':'.')).join(''));
console.log('legend     : C=chorus  S=speech  B=both  .=ambient');
console.log('errors     :', errs.slice(0,3).length?errs.slice(0,3):'clean');
await b.close();
