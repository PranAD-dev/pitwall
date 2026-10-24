// Speaks a line with EVERY installed French voice, one at a time, with no
// cancel() anywhere — cancel() immediately before speak() is itself a known way
// to kill the new utterance, and it poisoned the first version of this test.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:false,args:['--use-angle=metal']});
const page = await b.newPage();
await page.goto('http://localhost:8017/index.html?live=1',{waitUntil:'networkidle0',timeout:60000});
await page.mouse.click(400,300);
const r = await page.evaluate(async () => {
  const s = window.speechSynthesis;
  await new Promise(res=>{ if((s.getVoices()||[]).length) return res(); s.addEventListener('voiceschanged',res,{once:true}); setTimeout(res,3000); });
  const fr = (s.getVoices()||[]).filter(v=>/^fr-FR/i.test(v.lang));
  const out=[];
  for (const v of fr) {
    const res1 = await new Promise((res)=>{
      const u = new SpeechSynthesisUtterance('Gabriel Acher, quel joueur incroyable !');
      u.voice = v; u.lang = 'fr-FR'; u.volume = 0.02; u.rate = 2.2;
      let started = false, t0 = performance.now();
      u.onstart = () => { started = true; };
      u.onend = () => res(started ? 'ok ' + Math.round(performance.now()-t0) + 'ms' : 'ended-without-start');
      u.onerror = (e) => res('error:' + e.error);
      setTimeout(() => res(started ? 'ok(slow)' : 'NO-AUDIO (never started)'), 6000);
      s.speak(u);
    });
    out.push({ name: v.name, result: res1 });
    // let the engine settle fully before the next one
    await new Promise(z=>setTimeout(z,500));
  }
  return out;
});
for (const v of r) console.log(String(v.result).padEnd(26), v.name);
await b.close();
