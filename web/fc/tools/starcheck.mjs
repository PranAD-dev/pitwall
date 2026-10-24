// Behavioural guarantee, measured over real matches rather than staged shots:
//   - both stars run at ~2x everyone else
//   - a star's shot is NEVER saved (no 'save' event ever names one as shooter)
//   - stars are involved and score
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
const seeds = process.argv.slice(2).length ? process.argv.slice(2) : ['7','21','99'];
const all=[];
for (const seed of seeds) {
  await page.goto(`http://localhost:8017/index.html?cam=broadcast&t=0.5&seed=${seed}`,{waitUntil:'networkidle0',timeout:60000});
  await page.waitForFunction('window.__SHOT_READY === true',{timeout:60000});
  all.push(await page.evaluate((secs)=>{
    const {match, ball, teams} = window.__APP;
    const DT=1/120;
    const stars=(teams.players||[]).filter(p=>p&&p.star);
    const nums=new Set(stars.map(s=>s.number));
    const goalsBy={}, savesAgainstStar=[]; let starTouches=0, prev=null;
    match.onEvent((t,d)=>{
      if(t==='goal'&&d&&d.scorer) goalsBy[d.scorer.number]=(goalsBy[d.scorer.number]||0)+1;
      // side disambiguates: the away squad also has a #7 and a #10
      if(t==='save'&&d&&d.side==='home'&&nums.has(d.shooter)) savesAgainstStar.push(d.shooter);
    });
    for(let i=0;i<Math.round(secs/DT);i++){
      match.update(DT); teams.update(DT); ball.update(DT);
      const c=ball.controlledBy;
      if(c&&c.star&&prev!==c) starTouches++;
      prev=c;
    }
    return { score:match.state.score, goalsBy, savesAgainstStar, starTouches,
             speeds: stars.map(s=>({n:s.number,name:s.name,sp:+s.maxSpeed.toFixed(1)})) };
  }, 400));
}
console.log(JSON.stringify({seeds, all, errors:errs.slice(0,3)},null,2));
await b.close();
