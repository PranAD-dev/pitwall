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

// --- Empty field view: the stadium + pitch, every player and the ball removed.
// The camera is the repo's OWN rig (broadcast by default; also try ?cam=stadium,
// ?cam=goal, ?cam=broadcast, ?cam=closeup) — now framing the empty pitch. ---
function setupField() {
  for (const p of teams.players) p.group.visible = false; // remove all 22 players + referee
  if (ball.mesh) ball.mesh.visible = false;               // and the ball
  const hudEl = document.getElementById('hud');
  if (hudEl) hudEl.style.display = 'none';                // no scoreboard overlay
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
  rig.update(dt);               // repo camera rig frames the pitch (ball rests at centre)
  if (!FIELD) hud.update(dt);
  commentary.update(dt);
  audio.update(dt, ex);
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
