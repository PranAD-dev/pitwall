// Forces each star to shoot from several distances and reports whether the
// attempt ends in a goal.
//
// Two things must hold before firing or the result is meaningless:
//  - the match must be in open play (a shot during a celebration is ignored);
//  - match's INTERNAL controller must actually be this player. Setting
//    ball.controlledBy from outside does not set it — the sim assigns it when
//    the nearest player claims a loose ball. With two very fast stars on the
//    pitch, the other one can claim it first, which reads as a phantom miss.
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
await page.goto('http://localhost:8017/index.html?cam=broadcast&t=0.5&seed=7',{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__SHOT_READY === true',{timeout:60000});
const r = await page.evaluate(()=>{
  const {match, ball, teams} = window.__APP;
  const DT=1/120;
  const stars=(teams.players||[]).filter(p=>p&&p.star);
  const idle=()=>match.setUserInput({moveVec:{x:0,z:0},magnitude:0,active:false});
  const step=()=>{ match.update(DT); teams.update(DT); ball.update(DT); };
  const waitPlay=(sec)=>{ let n=0; while(match.state.phase!=='play' && n<sec/DT){ idle(); step(); n++; } return match.state.phase==='play'; };
  const out=[];
  for (const star of stars)
  for (const dist of [6,16,28,45,55]) {
    if(!waitPlay(25)) { out.push({who:star.number, distance:dist, goal:null}); continue; }
    for(let i=0;i<Math.round(0.6/DT);i++){ idle(); step(); }
    const gx = match.state.attackDirHome * 52.5;
    const px = gx - match.state.attackDirHome*dist;
    // Park every other outfielder well away so nobody else can claim the ball.
    for (const p of teams.players||[]) {
      if (p===star || p.role==='GK' || !p.team) continue;
      p.pos.set(-gx*0.85, 0, (p.number%2?1:-1)*26); p.vel.set(0,0,0);
    }
    star.pos.set(px,0,2); star.vel.set(0,0,0);
    ball.place(px + match.state.attackDirHome*0.4, 2);
    // Let the sim hand him the ball for real.
    let owned=false;
    for(let i=0;i<Math.round(1.5/DT);i++){ idle(); step(); if(ball.controlledBy===star && match.controlledPlayer===star){owned=true;break;} }
    if(!owned){ out.push({who:star.number, distance:dist, goal:null}); continue; }
    const before = match.state.score.home;
    match.setUserInput({moveVec:{x:0,z:0},magnitude:0,active:false,shootPressed:true});
    match.update(DT);
    let scored=false;
    for(let i=0;i<Math.round(5/DT);i++){ idle(); step(); if(match.state.score.home>before){scored=true;break;} }
    out.push({who:star.number, distance:dist, goal:scored});
  }
  return {results: out};
});
console.log(JSON.stringify(r,null,2));
if (errs.length) console.log('errors', errs.slice(0,2));
await b.close();
