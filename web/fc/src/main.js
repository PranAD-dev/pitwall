import * as THREE from 'three';
import { makeRng } from './util.js';
import { createInput } from './input.js';
import { createLighting } from './lighting.js';
import { createPitch } from './pitch.js';
import { createStadium } from './stadium.js';
import { createCrowd } from './crowd.js';
import { createBall } from './ball.js';
import { createTeams } from './players.js';
import { createMatch } from './match.js';
import { createCameraRig } from './cameraRig.js';
import { createHud } from './hud.js';
import { createPostFX } from './postfx.js';
import { createCommentary } from './commentary.js';
import { createAudio } from './audio.js';
import { createDashboard } from './dashboard.js';

const params = new URLSearchParams(location.search);
const SEED = parseInt(params.get('seed') || '7', 10);
const SHOT_T = params.get('t') ? parseFloat(params.get('t')) : null;
const CAM_MODE = params.get('cam') || 'broadcast';
// Coarse pointer + small viewport => phone/tablet. Drop to the low-cost path
// (smaller crowd, smaller textures, fewer shadow casters) unless overridden.
const IS_MOBILE = (() => {
  try {
    return window.matchMedia('(pointer: coarse)').matches &&
      Math.min(window.innerWidth, window.innerHeight) < 900;
  } catch (e) { return false; }
})();
const QUALITY = params.get('quality') || (IS_MOBILE ? 'low' : 'high');
const LIVE = params.get('live') === '1'; // keep animating even in shot mode
// Empty-field view is the DEFAULT: the stadium + pitch with no players and no
// match running. Add ?match=1 to play the full match instead.
const FIELD = params.get('match') !== '1';

const SIM_DT = 1 / 120;

// --- Renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: !IS_MOBILE, powerPreference: 'high-performance' });
// Phone panels are 3x DPR; rendering a 1080p-class scene at 3x melts the GPU
// and the battery for detail nobody can resolve at arm's length.
const MAX_DPR = IS_MOBILE ? 1.5 : 2;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const rng = makeRng(SEED);
const ctx = { scene, renderer, rng, quality: QUALITY };

// --- Build world ------------------------------------------------------------
const lighting = createLighting(ctx);
const pitch = createPitch(ctx);
const stadium = createStadium(ctx);
const crowd = createCrowd(ctx);
const ball = createBall(ctx);
const teams = createTeams(ctx);
const match = createMatch(ctx, { ball, teams, pitch });
const rig = createCameraRig(ctx, { ball, teams, match });
// Published so world-space UI (the controlled-player marker) can billboard.
ctx.camera = rig.camera;
const hud = createHud({ match });
const postfx = createPostFX(ctx, { camera: rig.camera });
const input = createInput();
const commentary = createCommentary({ match, rng: makeRng(SEED ^ 0x9e37) });
const audio = createAudio({ match, rng: makeRng(SEED ^ 0x51ab) });

rig.setMode(CAM_MODE);

window.__APP = { scene, renderer, ball, teams, match, rig, commentary, audio, THREE };

// --- Empty field view: the stadium + pitch, every player and the ball removed,
// with free orbit navigation (drag to rotate · scroll to zoom). ---
const OVERVIEW = { az: Math.PI, pol: 0.26, r: 105, x: 0, y: 3, z: 0 };
const nav = {
  az: OVERVIEW.az, pol: OVERVIEW.pol, r: OVERVIEW.r,          // current orbit
  taz: OVERVIEW.az, tpol: OVERVIEW.pol, tr: OVERVIEW.r,       // desired orbit
  tx: OVERVIEW.x, ty: OVERVIEW.y, tz: OVERVIEW.z,             // current look-at point
  dx: OVERVIEW.x, dy: OVERVIEW.y, dz: OVERVIEW.z,             // desired look-at point
};
let boardIdx = -1;
function initNav() {
  const dom = renderer.domElement;
  dom.style.touchAction = 'none';
  let dragging = false, lx = 0, ly = 0;
  dom.addEventListener('pointerdown', (e) => { dragging = true; lx = e.clientX; ly = e.clientY; try { dom.setPointerCapture(e.pointerId); } catch (_) {} });
  dom.addEventListener('pointerup', () => { dragging = false; });
  dom.addEventListener('pointercancel', () => { dragging = false; });
  dom.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - lx, dy = e.clientY - ly; lx = e.clientX; ly = e.clientY;
    nav.taz -= dx * 0.005;
    nav.tpol = Math.min(1.45, Math.max(0.02, nav.tpol + dy * 0.005)); // can't go under the pitch
  });
  dom.addEventListener('wheel', (e) => {
    e.preventDefault();
    nav.tr = Math.min(260, Math.max(8, nav.tr * (1 + Math.sign(e.deltaY) * 0.08)));
  }, { passive: false });
}
function updateNav(dt) {
  const k = 1 - Math.exp(-3.5 * dt);                // smooth glide toward the desired pose
  nav.az += (nav.taz - nav.az) * k;
  nav.pol += (nav.tpol - nav.pol) * k;
  nav.r += (nav.tr - nav.r) * k;
  nav.tx += (nav.dx - nav.tx) * k;
  nav.ty += (nav.dy - nav.ty) * k;
  nav.tz += (nav.dz - nav.tz) * k;
  const cp = Math.cos(nav.pol), sp = Math.sin(nav.pol);
  rig.camera.position.set(nav.tx + nav.r * Math.sin(nav.az) * cp, nav.ty + nav.r * sp, nav.tz + nav.r * Math.cos(nav.az) * cp);
  rig.camera.lookAt(nav.tx, nav.ty, nav.tz);
  rig.camera.updateProjectionMatrix();
}
// --- fly the camera to a good head-on view of a chosen board, and cycle them ---
function setNavLabel() {
  const el = document.getElementById('pw-label');
  if (el) el.textContent = boardIdx < 0 ? 'OVERVIEW' : `BOARD ${boardIdx + 1}/${(stadium.screenViews || []).length}`;
}
function focusBoard(i) {
  const views = stadium.screenViews || [];
  if (!views.length) return;
  boardIdx = ((i % views.length) + views.length) % views.length;
  const v = views[boardIdx];
  const d = Math.max(9, v.w * 1.6);                 // back off to frame the whole board
  const ox = v.nx * d, oz = v.nz * d;               // sit in front of it (pitch side)
  nav.dx = v.pos.x; nav.dy = v.pos.y; nav.dz = v.pos.z;
  nav.tr = Math.hypot(ox, oz);
  nav.tpol = 0.06;                                  // ~level with the board, a hair above
  nav.taz = Math.atan2(ox, oz);
  setNavLabel();
}
function overview() {
  boardIdx = -1;
  nav.taz = OVERVIEW.az; nav.tpol = OVERVIEW.pol; nav.tr = OVERVIEW.r;
  nav.dx = OVERVIEW.x; nav.dy = OVERVIEW.y; nav.dz = OVERVIEW.z;
  setNavLabel();
}
function buildNavUI() {
  const style = document.createElement('style');
  style.textContent = `
    #pwnav{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:50;
      display:flex;align-items:center;gap:8px;pointer-events:auto;font:12px ui-monospace,monospace;}
    #pwnav button{color:#c6ff2e;background:rgba(5,8,12,.82);border:1px solid rgba(198,255,46,.4);
      border-radius:8px;padding:9px 14px;cursor:pointer;letter-spacing:.04em;transition:all .12s;}
    #pwnav button:hover{background:rgba(198,255,46,.16);border-color:#c6ff2e;}
    #pw-label{color:rgba(255,255,255,.78);background:rgba(5,8,12,.82);border:1px solid rgba(198,255,46,.25);
      border-radius:8px;padding:9px 12px;min-width:104px;text-align:center;}`;
  document.head.appendChild(style);
  const bar = document.createElement('div');
  bar.id = 'pwnav';
  bar.innerHTML = '<button id="pw-view">◎ VIEW BOARD</button>' +
    '<button id="pw-prev">←</button><span id="pw-label">OVERVIEW</span><button id="pw-next">→</button>' +
    '<button id="pw-over">⤢ OVERVIEW</button>';
  document.body.appendChild(bar);
  const cur = () => (boardIdx < 0 ? 0 : boardIdx);
  document.getElementById('pw-view').addEventListener('click', () => focusBoard(cur()));
  document.getElementById('pw-prev').addEventListener('click', () => focusBoard(cur() - 1));
  document.getElementById('pw-next').addEventListener('click', () => focusBoard(cur() + 1));
  document.getElementById('pw-over').addEventListener('click', overview);
}
let dash = null;
function setupField() {
  for (const p of teams.players) p.group.visible = false; // remove all 22 players + referee
  if (ball.mesh) ball.mesh.visible = false;               // and the ball
  const hudEl = document.getElementById('hud');
  if (hudEl) hudEl.style.display = 'none';                // no scoreboard overlay
  // Pit Wall dashboard IN-WORLD on the big LED screens (corners + goal ends)
  dash = createDashboard(1024);
  const screens = scene.getObjectByName('big_screens');
  if (screens) { screens.material.map = dash.texture; screens.material.needsUpdate = true; }
  initNav();
  buildNavUI();
}
if (FIELD) setupField();

// --- Loop -------------------------------------------------------------------
function simTick(dt) {
  if (FIELD) return; // empty pitch: nothing to simulate
  match.setUserInput(input.sample());
  match.update(dt);
  teams.update(dt);
  ball.update(dt);
}

function frameUpdate(dt) {
  const ex = match.state ? match.state.excitement || 0 : 0;
  crowd.update(dt, ex);
  lighting.update(dt);
  if (stadium.update) stadium.update(dt);
  if (pitch.update) pitch.update(dt, match.state);
  if (FIELD) { updateNav(dt); if (dash) dash.update(dt); } else rig.update(dt);
  if (!FIELD) hud.update(dt);
  if (!FIELD) commentary.update(dt); // no voicelines on the empty field
  if (!FIELD) audio.update(dt, ex);  // and no crowd audio
  if (postfx.update) postfx.update(dt);
}

function render() {
  postfx.composer.render();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_DPR));
  renderer.setSize(w, h);
  rig.camera.aspect = w / h;
  rig.camera.updateProjectionMatrix();
  postfx.resize(w, h);
}
window.addEventListener('resize', resize);
// iOS fires orientationchange before the viewport metrics settle.
window.addEventListener('orientationchange', () => setTimeout(resize, 250));

if (SHOT_T !== null) {
  // Deterministic warm-up: fast-forward the sim, converge the camera, render once.
  const ticks = Math.round(SHOT_T / SIM_DT);
  for (let i = 0; i < ticks; i++) {
    simTick(SIM_DT);
    if (i % 2 === 0) frameUpdate(SIM_DT * 2);
  }
  // Extra rig/crowd settle so smoothing has converged on the final state.
  for (let i = 0; i < 240; i++) frameUpdate(1 / 60);
  resize();
  render();
  window.__SHOT_READY = true;
  if (LIVE) startLoop();
} else {
  startLoop();
}

function startLoop() {
  let last = performance.now();
  let acc = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    let frameDt = (now - last) / 1000;
    last = now;
    frameDt = Math.min(frameDt, 0.25);
    acc += frameDt;
    while (acc >= SIM_DT) {
      simTick(SIM_DT);
      acc -= SIM_DT;
    }
    frameUpdate(frameDt);
    render();
  });
}
