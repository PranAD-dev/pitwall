// Injects a synthetic Switch-Pro-like gamepad to verify button/axis mapping
// without hardware. Buttons are indexed by PHYSICAL POSITION per the
// Gamepad API "standard" mapping: 0=bottom(B) 1=right(A) 2=left(Y) 3=top(X).
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader','--window-size=900,600']});
const page = await b.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
await page.evaluateOnNewDocument(() => {
  window.__pad = { axes:[0,0,0,0], buttons:new Array(17).fill(0), id:'Pro Controller (STANDARD GAMEPAD)' };
  navigator.getGamepads = () => [{
    connected:true, id:window.__pad.id, index:0, mapping:'standard',
    axes:window.__pad.axes,
    buttons:window.__pad.buttons.map(v=>({pressed:v>0.5, touched:v>0.1, value:v})),
  }];
});
await page.goto('http://localhost:8017/index.html?cam=broadcast&t=6&seed=7&live=1',{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__SHOT_READY === true',{timeout:60000});

const set = (o) => page.evaluate((o)=>{ if(o.axes) window.__pad.axes=o.axes; if(o.buttons){window.__pad.buttons=new Array(17).fill(0); for(const i of o.buttons) window.__pad.buttons[i]=1;} }, o);
const st  = () => page.evaluate(()=>{const p=window.__APP.match.controlledPlayer;return{id:p&&p.id,vx:+p.vel.x.toFixed(2),vz:+p.vel.z.toFixed(2),sp:+Math.hypot(p.vel.x,p.vel.z).toFixed(2)};});
const out={};
// Stick right (+x) should drive world −X ; stick up (−y) should drive world +Z
await set({axes:[1,0,0,0]});  await new Promise(r=>setTimeout(r,1600)); out.stickRight=await st();
await set({axes:[0,0,0,0]});  await new Promise(r=>setTimeout(r,900));
await set({axes:[0,-1,0,0]}); await new Promise(r=>setTimeout(r,1600)); out.stickUp=await st();
// Half deflection must give a slower jog than full
await set({axes:[0,0,0,0]});  await new Promise(r=>setTimeout(r,900));
await set({axes:[0,-0.55,0,0]}); await new Promise(r=>setTimeout(r,1600)); out.stickHalf=await st();
// L (index 4) = switch player
await set({axes:[0,0,0,0], buttons:[]}); await new Promise(r=>setTimeout(r,400));
const before=(await st()).id;
await set({buttons:[4]}); await new Promise(r=>setTimeout(r,180)); await set({buttons:[]}); await new Promise(r=>setTimeout(r,300));
out.switchWithL={before, after:(await st()).id};
// Face buttons must not throw: bottom(pass) right(shoot) left(through) top(lofted)
for (const i of [0,1,2,3]) { await set({buttons:[i]}); await new Promise(r=>setTimeout(r,160)); await set({buttons:[]}); await new Promise(r=>setTimeout(r,240)); }
out.phase = await page.evaluate(()=>window.__APP.match.state.phase);
out.errors = errs.slice(0,3);
console.log(JSON.stringify(out,null,2));
await b.close();
