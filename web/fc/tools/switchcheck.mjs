// Asserts the switch key selects the outfielder NEAREST THE BALL, excluding the
// one already selected. Checks the actual distance ranking, not just that the
// name changed.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
const page = await b.newPage();
await page.goto('http://localhost:8017/index.html?cam=broadcast&t=8&seed=7&live=1',{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__SHOT_READY === true',{timeout:60000});

const rows=[];
for (let i=0;i<10;i++){
  // Snapshot the ranking BEFORE the press, then press and see who we got.
  const before = await page.evaluate(()=>{
    const {match, ball, teams} = window.__APP;
    const cur = match.controlledPlayer;
    const d = (p)=>Math.hypot(p.pos.x-ball.pos.x, p.pos.z-ball.pos.z);
    const out = (teams.players||[]).filter(p=>p&&p.team==='home'&&p.role!=='GK');
    const ranked = out.slice().sort((a,b)=>d(a)-d(b)).map(p=>({n:p.name, d:+d(p).toFixed(1)}));
    const expected = ranked.find(r=>r.n!==(cur&&cur.name));
    return { cur: cur&&cur.name, expected };
  });
  await page.keyboard.press('KeyQ');
  await new Promise(r=>setTimeout(r,180));
  const after = await page.evaluate(()=>{const p=window.__APP.match.controlledPlayer;return p&&p.name;});
  rows.push({ from: before.cur, expected: before.expected.n, got: after,
              dist: before.expected.d, ok: after === before.expected.n });
  await new Promise(r=>setTimeout(r,900));
}
for (const r of rows) console.log((r.ok?'OK  ':'FAIL'), `${String(r.from).padEnd(11)} -> ${String(r.got).padEnd(11)} (nearest was ${r.expected} @ ${r.dist}m)`);
console.log('passed:', rows.filter(r=>r.ok).length, '/', rows.length);
await b.close();
