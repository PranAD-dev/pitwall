// How often is each Draguignan player the selected (announced) player?
// Commentary only fires for whoever pickControlled chooses.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
const page = await b.newPage();
await page.goto('http://localhost:8017/index.html?cam=broadcast&t=0.5&seed=7',{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__SHOT_READY === true',{timeout:60000});
const r = await page.evaluate((secs)=>{
  const {match, ball, teams} = window.__APP;
  const DT=1/120; const count={}; 
  for(let i=0;i<Math.round(secs/DT);i++){
    match.update(DT); teams.update(DT); ball.update(DT);
    const p = match.controlledPlayer;
    if (p) count[p.name] = (count[p.name]||0) + DT;
  }
  return Object.entries(count).map(([n,s])=>({name:n, sec:+s.toFixed(1)})).sort((a,b)=>b.sec-a.sec);
}, 400);
console.log(JSON.stringify(r,null,1));
await b.close();
