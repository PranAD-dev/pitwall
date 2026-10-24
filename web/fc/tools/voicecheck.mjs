// Captures what the commentary module actually queues into speechSynthesis.
// The star is teleported onto the ball so the game's own selection logic picks
// him — assigning match.controlledPlayer directly gets overwritten by the sim.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
await page.evaluateOnNewDocument(() => {
  window.__spoken = [];
  // speechSynthesis is a read-only accessor on Window; plain assignment is
  // silently ignored, so define over it.
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => [],   // real SpeechSynthesisVoice objects cannot be faked
      speak: (u) => window.__spoken.push({text:u.text, lang:u.lang, rate:+u.rate.toFixed(2)}),
      cancel: () => {}, resume: () => {}, addEventListener: () => {}, onvoiceschanged: null,
    },
  });
});
await page.goto('http://localhost:8017/index.html?cam=broadcast&t=6&seed=7&live=1',{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__SHOT_READY === true',{timeout:60000});
await page.keyboard.press('KeyW');                      // gesture unlocks speech
await new Promise(r=>setTimeout(r,200));
const selected=[];
for (let i=0;i<10;i++){
  // Park the star on the ball; the AI selector will then choose him.
  await page.evaluate(()=>{
    const {teams, ball} = window.__APP;
    const star=(teams.players||[]).find(p=>p&&p.star);
    star.pos.set(ball.pos.x, 0, ball.pos.z);
  });
  await new Promise(r=>setTimeout(r,800));
  selected.push(await page.evaluate(()=>{const p=window.__APP.match.controlledPlayer;return p&&p.star?'STAR':(p?p.name:null);}));
}
const spoken = await page.evaluate(()=>window.__spoken);
console.log(JSON.stringify({selectedOverTime:selected, spokenCount:spoken.length, lines:spoken, errors:errs.slice(0,3)},null,2));
await b.close();
