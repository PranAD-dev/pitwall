// Prints the Draguignan XI as the game actually builds it: shirt name, role,
// top speed and hair colour, so name/number/hair wiring can be eyeballed.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
await page.goto('http://localhost:8017/index.html?cam=broadcast&t=2&seed=7',{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__SHOT_READY === true',{timeout:60000});
const r = await page.evaluate(()=>{
  const out=[];
  for (const p of (window.__APP.teams.players||[])) {
    if (!p || p.team!=='home') continue;
    let hair=null;
    p.group.traverse(o=>{ if(!hair && o.name && /hair/i.test(o.name) && o.material && o.material.color) hair='#'+o.material.color.getHexString(); });
    out.push({n:p.number, name:p.name, role:p.role, sp:+p.maxSpeed.toFixed(2), star:!!p.star, hair});
  }
  return out.sort((a,b)=>a.n-b.n);
});
console.log(JSON.stringify({home:r, errors:errs.slice(0,3)},null,2));
await b.close();
