// End-to-end in a real browser. Reports which voices were chosen, which
// utterances actually STARTED (not merely queued), and any blacklisted duds.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--use-angle=metal']});
const page = await b.newPage();
await page.setViewport({width:1280,height:720});
await page.evaluateOnNewDocument(() => {
  window.__spoken = [];
  const s = window.speechSynthesis;
  const orig = s.speak.bind(s);
  s.speak = (u) => {
    const rec = { text: u.text, voice: u.voice && u.voice.name, started: false };
    if (u.text.trim()) window.__spoken.push(rec);
    const prevStart = u.onstart;
    u.onstart = (e) => { rec.started = true; if (prevStart) prevStart(e); };
    return orig(u);
  };
});
await page.goto('http://localhost:8017/index.html?live=1',{waitUntil:'networkidle0',timeout:60000});
await new Promise(r=>setTimeout(r,2000));
await page.mouse.click(640,400);
for (let i=0;i<110;i++) await new Promise(r=>setTimeout(r,1000));
const out = await page.evaluate(()=>({spoken:window.__spoken, dbg:window.__APP.commentary.debug()}));
console.log('voices chosen:', JSON.stringify(out.dbg.voices));
console.log('lastError:', out.dbg.lastError);
for (const s of out.spoken) console.log((s.started?'SPOKE ':'SILENT').padEnd(7), (s.voice||'(default)').padEnd(28), s.text);
await b.close();
