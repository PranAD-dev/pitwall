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
import { PILLAR_KEYS, createPillar } from './pillars.js';
import { createCover } from './cover.js';
import { TCOL, createTerminal } from './terminal.js';
import { createReporter } from './reporter.js';
import { createLiveReport, primeSpeech } from './livereport.js';

// unlock speech synthesis on the very first user gesture (browsers gate it)
window.addEventListener('pointerdown', () => primeSpeech(), { once: true });

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
// crowd ambience + the (French) commentary voicelines are OFF — only the Cartesia
// report narration should speak. No-op stubs keep the rest of the interface intact.
const commentary = { update() {}, toggleMute() {}, muted: true };
const audio = { update() {}, toggleMute() {}, muted: true };

rig.setMode(CAM_MODE);

window.__APP = { scene, renderer, ball, teams, match, rig, commentary, audio, THREE };

// --- Empty field view: the stadium + pitch, every player and the ball removed,
// with free orbit navigation (drag to rotate · scroll to zoom). ---
// the landing-page angle — ⤢ OVERVIEW returns to exactly this (inside the bowl)
const OVERVIEW = { az: -1.592, pol: 0.233, r: 96.2, x: 44, y: 3, z: 0 };
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
  // press "p" to print the current camera — orbit to the angle you want, hit p,
  // read the console, and tell me the numbers to lock it in.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'p' || e.key === 'P') {
      console.log(`[camera] az=${nav.az.toFixed(3)} pol=${nav.pol.toFixed(3)} r=${nav.r.toFixed(1)} `
        + `target=(${nav.tx.toFixed(1)}, ${nav.ty.toFixed(1)}, ${nav.tz.toFixed(1)})`);
    }
  });
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
function focusBoard(i, tight) {
  const views = stadium.screenViews || [];
  if (!views.length) return;
  boardIdx = ((i % views.length) + views.length) % views.length;
  const v = views[boardIdx];
  const d = tight ? Math.max(6, v.w * 1.12)         // tight: the board fills the screen
                  : Math.max(9, v.w * 1.6);         // normal: frame the whole board w/ margin
  const ox = v.nx * d, oz = v.nz * d;               // sit in front of it (pitch side)
  nav.dx = v.pos.x; nav.dy = v.pos.y; nav.dz = v.pos.z;
  nav.tr = Math.hypot(ox, oz);
  nav.tpol = tight ? 0.02 : 0.06;                   // head-on when tight
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
  bar.innerHTML = '<button id="pw-auto">▶ AUTO RUN</button><button id="pw-logs">▤ LOGS</button>' +
    '<button id="pw-view">◎ VIEW BOARD</button>' +
    '<button id="pw-prev">←</button><span id="pw-label">OVERVIEW</span><button id="pw-next">→</button>' +
    '<button id="pw-over">⤢ OVERVIEW</button><button id="pw-full" title="fullscreen">⛶</button>';
  document.body.appendChild(bar);
  const cur = () => (boardIdx < 0 ? 0 : boardIdx);
  const hideMenu = () => { if (window.__pwHideMenu) window.__pwHideMenu(); };
  document.getElementById('pw-view').addEventListener('click', () => { focusBoard(cur()); hideMenu(); });
  document.getElementById('pw-prev').addEventListener('click', () => { focusBoard(cur() - 1); hideMenu(); });
  document.getElementById('pw-next').addEventListener('click', () => { focusBoard(cur() + 1); hideMenu(); });
  document.getElementById('pw-auto').addEventListener('click', activateAuto);
  document.getElementById('pw-logs').addEventListener('click', activateLogs);
  document.getElementById('pw-over').addEventListener('click', () => { overview(); deactivateTerminal(); deactivateReport(); deactivateHistory(); deactivateScore(); deactivateAuto(); deactivateLogs(); deactivateOnboard(); if (window.__pwTxrClose && txrActive) { txrDeactivate(); } if (window.__pwShowMenu) window.__pwShowMenu(); });
  document.getElementById('pw-full').addEventListener('click', () => {
    const d = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (d.requestFullscreen) d.requestFullscreen();
  });
}
let pillars = [];
let terminal = null, termActive = false, termBuf = '';
const TERM_SCREEN = 0;   // which big screen becomes the terminal

function activateTerminal() {
  if (!terminal) return;
  const m = scene.getObjectByName('big_screen_' + TERM_SCREEN);
  if (m) { m.material.map = terminal.texture; m.material.needsUpdate = true; }
  termActive = true;
  termBuf = ''; terminal.setPrompt('');
  focusBoard(TERM_SCREEN);          // normal framing (⛶ for fullscreen on demand)
  if (window.__pwHideMenu) window.__pwHideMenu();
  if (window.__pwShowTermBar) window.__pwShowTermBar();
  terminal.clear();
  terminal.write('● HARBOURSIDE AGENT — ON DUTY', TCOL.VOLT);
  terminal.write('onboarded · policies loaded · memory live', TCOL.DIM);
  terminal.write('watching transfers · payables · receivables · wages · agent fees · clauses', TCOL.WHITE);
  terminal.write('working alongside you — hand me anything ▸', TCOL.BLUE);
}
function deactivateTerminal() {
  const m = scene.getObjectByName('big_screen_' + TERM_SCREEN);
  if (m && pillars[TERM_SCREEN]) { m.material.map = pillars[TERM_SCREEN].texture; m.material.needsUpdate = true; }
  termActive = false;
  if (window.__pwHideTermBar) window.__pwHideTermBar();
}
window.__pwDeactivateTerm = deactivateTerminal;
window.__pwActivateTerm = activateTerminal;   // menu "Control room" tile flies here

// --- a SECOND, parallel agent: the LiveKit finance-report on its own billboard ---
let reporter = null, reportPlayer = null, reportActive = false;
const REPORT_SCREEN = 1;   // a different big screen from the terminal → two agents, live at once
function activateReport(mode) {
  if (!reporter) return;
  const m = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
  if (m) { m.material.map = reporter.texture; m.material.needsUpdate = true; }
  reportActive = true;
  focusBoard(REPORT_SCREEN);        // normal framing (⛶ for fullscreen on demand)
  if (window.__pwHideMenu) window.__pwHideMenu();
  if (mode === 'financial') reportPlayer.startFinancial();   // reports desk: DB + forecast
  else reportPlayer.start('WI-5602');                        // the fraud-hold decision
}
function deactivateReport() {
  const m = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
  if (m && pillars[REPORT_SCREEN]) { m.material.map = pillars[REPORT_SCREEN].texture; m.material.needsUpdate = true; }
  reportActive = false;
  if (reportPlayer) reportPlayer.stop();
  try { if (reportVideoEl) reportVideoEl.pause(); } catch (e) {}   // also stop the billboard video
  _duckAmbience(false);                                           // and un-mute the crowd
  if (window.__pwReportHide) window.__pwReportHide();
}
window.__pwActivateReport = activateReport;
window.__pwReportFinancial = () => activateReport('financial');
window.__pwDeactivateReport = deactivateReport;

// --- Transaction report IN-STADIUM: click a History topic → fly to the report
//     billboard, read it there, talk to the agent, download it — no browser tab. ---
let txrScenes = [], txrIdx = 0, txrWi = null, txrActive = false, txrReturn = null;
// fly to the REPORT billboard + open the report HUD (shared by History + the terminal)
function _reportBoardSetup(title, wi, back) {
  if (!reporter) return false;
  txrWi = wi || null; txrActive = true; txrReturn = back || null;
  if (reportPlayer) { try { reportPlayer.stop(); } catch (e) { /* idle */ } }
  const m = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
  if (m) { m.material.map = reporter.texture; m.material.needsUpdate = true; }
  reportActive = true;
  focusBoard(REPORT_SCREEN);
  if (window.__pwHideHistBar) window.__pwHideHistBar();
  if (window.__pwHideMenu) window.__pwHideMenu();
  if (window.__pwHideTermBar) window.__pwHideTermBar();
  reporter.setTitle(title || 'report');
  if (window.__pwShowTxrBar) window.__pwShowTxrBar(title || 'report');
  return true;
}
function _renderScenes(scenes, title) {
  txrScenes = (scenes && scenes.length) ? scenes : [{ say: 'No report.', draw: null }];
  txrIdx = 0;
  reporter.setTitle(title || txrWi || 'report');
  reporter.showScene(txrScenes[0], 0, txrScenes.length, { build: true });
  if (window.__pwTxrLabel) window.__pwTxrLabel(title || txrWi || 'report', 1, txrScenes.length);
}
async function txReport(wi) {
  if (!_reportBoardSetup(wi, wi, () => { if (window.__pwActivateHistory) window.__pwActivateHistory(); })) return;
  reporter.idle('loading the transaction report…');
  let plan = { scenes: [] }, audit = [];
  try {
    [plan, audit] = await Promise.all([
      fetch('/api/explain/' + encodeURIComponent(wi)).then((r) => r.json()),
      fetch('/api/audit/' + encodeURIComponent(wi)).then((r) => r.json())]);
  } catch (e) { /* offline */ }
  if (!txrActive || txrWi !== wi) return;
  const scenes = (plan.scenes || []).slice();
  const A = Array.isArray(audit) ? audit : [];
  // top up with scenes synthesized from the audit so every report has substance (we aim
  // for ≥3 content scenes, then the audit trail as the final slide ⇒ at least 4 total)
  if (A.length) {
    const isHuman = (a) => a && /:/.test(a) && !/ai_agent|gateway|sync|policy|retrieval|system/.test(a);
    const create = A.find((r) => r.action === 'create');
    const prop = A.find((r) => r.action === 'propose');
    const human = A.filter((r) => isHuman(r.actor)).pop();
    const verdict = A.filter((r) => ['post', 'hold', 'reject', 'approve', 'ask', 'correct'].indexOf(r.action) >= 0).pop() || A[A.length - 1];
    const synth = [
      { say: 'The case — ' + (plan.title || wi) + ((create && create.reason) ? ' (' + create.reason + ')' : '') + '.',
        draw: { type: 'flow', title: 'the case', boxes: ['received', 'under review'] } },
      { say: (prop && prop.reason) || 'The agent assessed the case and proposed a treatment.',
        draw: { type: 'flow', title: 'what the agent found', boxes: ['assessed', 'proposed'] } },
      { say: (verdict && verdict.reason) || 'The decision was recorded.',
        draw: { type: 'flow', title: 'the call',
          boxes: [(verdict && (verdict.state || verdict.action)) || 'decided', human ? ('you ▸ ' + (human.action || 'reviewed')) : 'logged'] } },
    ];
    while (scenes.length < 3 && synth.length) scenes.push(synth.shift());
  }
  // final slide: the append-only audit trail
  if (A.length) {
    scenes.push({ say: 'Append-only audit trail — logged, and never editable.',
      draw: { type: 'table', title: 'append-only audit trail',
        columns: ['time', 'actor', 'action', 'why'],
        rows: A.map((r) => [r.at || '', r.actor || '', (r.action || '') + (r.allowed === false ? ' ✗' : ''), (r.reason || '').slice(0, 42)]) } });
  }
  _renderScenes(scenes.length ? scenes : [{ say: 'No detailed record for ' + wi + '.', draw: null }], plan.title || wi);
}
// the Teamwork-Terminal FULL REPORT → the captured scenario trace, on the billboard
function _scenarioScenes(trace) {
  const steps = trace.steps || [], scenes = [];
  scenes.push({ say: '“' + (trace.text || '') + '”',
    draw: { type: 'flow', title: 'scenario', boxes: ['you asked', 'the agent works it'] } });
  steps.filter((s) => s.kind === 'think' || s.kind === 'recall').slice(0, 6).forEach((s) =>
    scenes.push({ say: (s.kind === 'recall' ? 'recalled memory · ' : '') + (s.text || ''), draw: null }));
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].kind !== 'run_sql') continue;
    let res = null;
    for (let j = i + 1; j < steps.length; j++) { if (steps[j].kind === 'sql_result') { res = steps[j].data || {}; break; } if (steps[j].kind === 'run_sql') break; }
    const rows = (res && res.rows) || [], cols = (res && res.columns) || (rows[0] ? Object.keys(rows[0]) : []);
    scenes.push({ say: 'queried the database — ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + ' pulled',
      draw: rows.length ? { type: 'table', title: (steps[i].text || '').slice(0, 56),
        columns: cols.slice(0, 4), rows: rows.slice(0, 8).map((r) => cols.slice(0, 4).map((c) => String(r[c]))) } : null });
  }
  const prop = steps.filter((s) => s.kind === 'propose').pop();
  const post = steps.filter((s) => s.kind === 'post').pop();
  const ah = steps.filter((s) => s.kind === 'await_human').pop();
  if (prop || post || ah) {
    let say = prop ? (prop.text || (prop.data || {}).reason || '') : '';
    if (post) say += ' → ' + ((post.data || {}).final || (post.data || {}).action || '');
    if (ah) say = (ah.data || {}).question || say;
    const jl = post && (post.data || {}).journal_lines;
    const draw = (jl && jl.length)
      ? { type: 'table', title: 'the money note it posted', columns: ['account', 'debit', 'credit'],
          rows: jl.map((l) => [String(l.account || l.code || ''), l.debit ? String(l.debit) : '', l.credit ? String(l.credit) : '']) }
      : { type: 'flow', title: 'verdict', boxes: [(prop && (prop.data || {}).situation_type) || 'classified', (post && (post.data || {}).final) || (ah ? 'asked a human' : 'escalated')] };
    scenes.push({ say, draw });
  }
  return scenes;
}
function scnReportBoard(trace) {
  if (!trace || !trace.steps || !trace.steps.length) return;
  _reportBoardSetup('scenario · ' + (trace.wi || ''), trace.wi, () => activateTerminal());
  _renderScenes(_scenarioScenes(trace), 'scenario report');
}
window.__pwScnReportBoard = scnReportBoard;
// open a saved Teamwork-Terminal run on the billboard by id (History → "on billboard")
async function scnReportBoardByWi(wi) {
  let d = null;
  try { d = await fetch('/api/scenario/trace/' + encodeURIComponent(wi)).then((r) => r.json()); } catch (e) { /* offline */ }
  if (d && d.found && d.steps && d.steps.length) { scnReportBoard({ text: d.text, at: d.at, wi: d.wi, steps: d.steps }); return; }
  txReport(wi);   // older run with no saved trace → fall back to the generic report
}
window.__pwScnReportBoardByWi = scnReportBoardByWi;
function txrStep(d) {
  if (!txrActive || !txrScenes.length) return;
  txrIdx = ((txrIdx + d) % txrScenes.length + txrScenes.length) % txrScenes.length;
  reporter.showScene(txrScenes[txrIdx], txrIdx, txrScenes.length, { build: true });
  if (window.__pwTxrLabel) window.__pwTxrLabel(txrWi, txrIdx + 1, txrScenes.length);
}
function txrDeactivate() {
  txrStop();
  const m = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
  if (m && pillars[REPORT_SCREEN]) { m.material.map = pillars[REPORT_SCREEN].texture; m.material.needsUpdate = true; }
  reportActive = false; txrActive = false;
  if (window.__pwHideTxrBar) window.__pwHideTxrBar();
}
function txrDownload() {
  const out = ['# Pit Wall — Transaction Report', '', '**' + (txrWi || '') + '**', ''];
  txrScenes.forEach((s, i) => {
    if (s.say) out.push((i + 1) + '. ' + s.say);
    const d = s.draw;
    if (d && d.type === 'table') {
      out.push(''); out.push('| ' + (d.columns || []).join(' | ') + ' |');
      out.push('|' + (d.columns || []).map(() => '---').join('|') + '|');
      (d.rows || []).forEach((r) => out.push('| ' + r.join(' | ') + ' |'));
    } else if (d && (d.lines || d.items)) {
      (d.lines || d.items || []).forEach((l) => out.push('   - ' + (l.label || l)));
    }
    out.push('');
  });
  const blob = new Blob([out.join('\n')], { type: 'text/markdown' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = 'pitwall-' + (txrWi || 'report') + '.md';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function txrAsk(q) {
  if (!txrActive || !q) return;
  if (window.__pwTxrAnswer) window.__pwTxrAnswer('thinking…', true);
  try {
    const r = await fetch('/api/ask?' + new URLSearchParams({ wi: txrWi, q }).toString(), { method: 'POST' }).then((x) => x.json());
    if (window.__pwTxrAnswer) window.__pwTxrAnswer((r && r.answer) || '(no answer)', false);
  } catch (e) { if (window.__pwTxrAnswer) window.__pwTxrAnswer('(backend offline)', false); }
}
// speak + AUTOPLAY the report on the billboard (Cartesia voice → browser fallback),
// auto-advancing each scene as it finishes being read out loud
let txrPlaying = false, txrAudio = null, txrCart = true;
function _speak(text) {
  return new Promise((res) => {
    const tt = String(text || '').trim(); if (!tt) { res(); return; }
    const browser = () => { try { const u = new SpeechSynthesisUtterance(tt); u.onend = res; u.onerror = res; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { res(); } };
    if (!txrCart) { browser(); return; }
    fetch('/api/voice?text=' + encodeURIComponent(tt)).then((r) => {
      if (r.status === 404) { txrCart = false; browser(); return; }
      if (!r.ok) { browser(); return; }
      r.blob().then((b) => {
        if (!txrAudio) txrAudio = new Audio();
        const u = URL.createObjectURL(b); txrAudio.src = u;
        const done = () => { try { URL.revokeObjectURL(u); } catch (e) { /* */ } res(); };
        txrAudio.onended = done; txrAudio.onerror = done; txrAudio.play().catch(done);
      }).catch(browser);
    }).catch(browser);
  });
}
async function txrPlay() {
  if (!txrActive || txrPlaying) return;
  txrPlaying = true; if (window.__pwTxrPlaying) window.__pwTxrPlaying(true);
  for (let i = txrIdx; i < txrScenes.length && txrPlaying && txrActive; i++) {
    txrIdx = i;
    reporter.showScene(txrScenes[i], i, txrScenes.length, { build: true });
    if (window.__pwTxrLabel) window.__pwTxrLabel(txrWi, i + 1, txrScenes.length);
    await _speak(txrScenes[i].say);
    if (!txrPlaying || !txrActive) break;
    await new Promise((r) => setTimeout(r, 450));
  }
  txrPlaying = false; if (window.__pwTxrPlaying) window.__pwTxrPlaying(false);
}
function txrStop() { txrPlaying = false; try { if (txrAudio) txrAudio.pause(); } catch (e) { /* */ } try { speechSynthesis.cancel(); } catch (e) { /* */ } if (window.__pwTxrPlaying) window.__pwTxrPlaying(false); }
window.__pwTxrPlay = () => { if (txrPlaying) txrStop(); else txrPlay(); };
window.__pwTxReport = txReport;
window.__pwTxrStep = txrStep;
window.__pwTxrDownload = txrDownload;
window.__pwTxrAsk = txrAsk;
window.__pwTxrClose = () => { txrStop(); const back = txrReturn; txrDeactivate(); if (back) back(); else { overview(); if (window.__pwShowMenu) window.__pwShowMenu(); } };

// --- play the rendered report MP4 directly ON the billboard (as a video texture) ---
let reportVideoEl = null, reportVideoTex = null, _ambienceDucked = false;
function _duckAmbience(on) {
  try {
    if (on && !_ambienceDucked) {
      if (audio && audio.toggleMute && !audio.muted) audio.toggleMute();
      if (commentary && commentary.toggleMute && !commentary.muted) commentary.toggleMute();
      _ambienceDucked = true;
    } else if (!on && _ambienceDucked) {
      if (audio && audio.toggleMute && audio.muted) audio.toggleMute();
      if (commentary && commentary.toggleMute && commentary.muted) commentary.toggleMute();
      _ambienceDucked = false;
    }
  } catch (e) { /* ambience ducking is best-effort */ }
}
function activateReportVideo() {
  const m = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
  if (!m) return;
  reportActive = true;
  focusBoard(REPORT_SCREEN);
  if (window.__pwHideMenu) window.__pwHideMenu();
  // a loading frame while the server renders the mp4 (~40s the first time, cached after)
  if (reporter) {
    m.material.map = reporter.texture; m.material.needsUpdate = true;
    reporter.setTitle('financial report · video');
    reporter.idle('rendering the report video on the server…  (~40s first time, instant after)');
  }
  if (!reportVideoEl) {
    reportVideoEl = document.createElement('video');
    reportVideoEl.crossOrigin = 'anonymous';
    reportVideoEl.playsInline = true; reportVideoEl.setAttribute('playsinline', '');
    reportVideoEl.preload = 'auto';
    Object.assign(reportVideoEl.style, { position: 'fixed', left: '-20px', top: '-20px',
      width: '2px', height: '2px', opacity: '0', pointerEvents: 'none' });
    document.body.appendChild(reportVideoEl);
    reportVideoTex = new THREE.VideoTexture(reportVideoEl);
    reportVideoTex.colorSpace = THREE.SRGBColorSpace;
    reportVideoTex.minFilter = THREE.LinearFilter; reportVideoTex.magFilter = THREE.LinearFilter;
    reportVideoTex.generateMipmaps = false;
    reportVideoEl.addEventListener('playing', () => {
      const mm = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
      if (mm && reportActive) { mm.material.map = reportVideoTex; mm.material.needsUpdate = true; }
      _duckAmbience(true);
    });
    reportVideoEl.addEventListener('error', () => {
      if (reporter && reportActive) reporter.idle('could not render the video — is `make fc` running?');
    });
  }
  reportVideoEl.src = '/api/report-video';
  try { reportVideoEl.currentTime = 0; } catch (e) {}
  reportVideoEl.muted = false; reportVideoEl.volume = 1.0;
  const p = reportVideoEl.play();
  if (p && p.catch) p.catch(() => {            // autoplay-with-sound refused → start muted, then unmute
    reportVideoEl.muted = true;
    reportVideoEl.play().then(() => { reportVideoEl.muted = false; }).catch(() => {});
  });
}
function deactivateReportVideo() {
  const m = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
  if (m && pillars[REPORT_SCREEN]) { m.material.map = pillars[REPORT_SCREEN].texture; m.material.needsUpdate = true; }
  reportActive = false;
  _duckAmbience(false);
  try { if (reportVideoEl) reportVideoEl.pause(); } catch (e) {}
}
window.__pwReportVideo = activateReportVideo;
window.__pwDeactivateReportVideo = deactivateReportVideo;

// --- Transaction history: step the chain of events (audit + reasoning + evidence) ---
let historyReporter = null, historyEvents = [], histIdx = 0, historyActive = false;
const HISTORY_SCREEN = 2;
function showHistEvent(i) {
  if (!historyEvents.length) { historyReporter.idle('no transaction history yet'); return; }
  histIdx = ((i % historyEvents.length) + historyEvents.length) % historyEvents.length;
  const e = historyEvents[histIdx];
  historyReporter.setTitle((e.wi ? e.wi + ' · ' : '') + (e.title || 'transaction'));
  historyReporter.showScene(e, histIdx, historyEvents.length);
  if (window.__pwHistLabel) window.__pwHistLabel(histIdx + 1, historyEvents.length, e.wi || '');
}
async function activateHistory() {
  if (!historyReporter) return;
  const m = scene.getObjectByName('big_screen_' + HISTORY_SCREEN);
  if (m) { m.material.map = historyReporter.texture; m.material.needsUpdate = true; }
  historyActive = true;
  focusBoard(HISTORY_SCREEN);
  if (window.__pwHideMenu) window.__pwHideMenu();
  if (window.__pwShowHistBar) window.__pwShowHistBar();
  historyReporter.idle('loading history…');
  try { historyEvents = (await fetch('/api/history').then((r) => r.json())).events || []; }
  catch (e) { historyEvents = []; }
  // the topic rail = one entry per transaction (the head events), each opening its report
  const topics = [];
  historyEvents.forEach((e, i) => { if (e.head) topics.push({ wi: e.wi, title: e.title, meta: e.meta, idx: i }); });
  if (window.__pwHistTopics) window.__pwHistTopics(topics);
  histIdx = 0; showHistEvent(0);
}
function deactivateHistory() {
  const m = scene.getObjectByName('big_screen_' + HISTORY_SCREEN);
  if (m && pillars[HISTORY_SCREEN]) { m.material.map = pillars[HISTORY_SCREEN].texture; m.material.needsUpdate = true; }
  historyActive = false;
  if (window.__pwHideHistBar) window.__pwHideHistBar();
}
window.__pwActivateHistory = activateHistory;
window.__pwDeactivateHistory = deactivateHistory;

// --- Scoreboard: scored vs the answer key (deck ① "is it real enough") ---
let scoreReporter = null, scoreActive = false;
const SCORE_SCREEN = 3;
async function activateScore() {
  if (!scoreReporter) return;
  const m = scene.getObjectByName('big_screen_' + SCORE_SCREEN);
  if (m) { m.material.map = scoreReporter.texture; m.material.needsUpdate = true; }
  scoreActive = true;
  focusBoard(SCORE_SCREEN);
  if (window.__pwHideMenu) window.__pwHideMenu();
  scoreReporter.idle('scoring against the answer key…');
  try {
    const d = await fetch('/api/score').then((r) => r.json());
    if (d.error) { scoreReporter.idle('score unavailable — ' + d.error); return; }
    scoreReporter.setTitle('Harbourside FC · 21 planted issues · answer key');
    scoreReporter.showScene({
      say: `Scored autonomously against the answer key — the agent never sees it: ${d.precision}% precision on auto-completed work, ${d.violations} must-not-auto-complete violations, ${d.recall_correct} of ${d.total} planted issues caught.`,
      draw: { type: 'table', title: 'eval · scored vs the answer key',
        columns: ['metric', 'result', 'target'],
        rows: [
          ['Precision on auto-completed', d.precision + '%', '100%'],
          ['Must-not-auto-complete violations', String(d.violations), '0'],
          ['Planted-issue recall', d.recall_correct + ' / ' + d.total, '—'],
          ['Automation rate', d.automation + '%  (' + d.auto_completed + ' auto)', '—'],
          ['Escalation quality', d.escalation + '%  (' + d.escalated + ' asked)', '—'],
        ], highlight_row: 0 },
    }, 0, 1);
  } catch (e) { scoreReporter.idle('score backend offline — run `make fc`'); }
}
function deactivateScore() {
  const m = scene.getObjectByName('big_screen_' + SCORE_SCREEN);
  if (m && pillars[SCORE_SCREEN]) { m.material.map = pillars[SCORE_SCREEN].texture; m.material.needsUpdate = true; }
  scoreActive = false;
}
window.__pwActivateScore = activateScore;
window.__pwDeactivateScore = deactivateScore;

// --- Autonomous run: replay the 21 real decisions the agent made unattended ---
let autoReporter = null, autoActive = false, autoTimer = null;
const AUTO_SCREEN = 4;
async function activateAuto() {
  if (!autoReporter) return;
  const m = scene.getObjectByName('big_screen_' + AUTO_SCREEN);
  if (m) { m.material.map = autoReporter.texture; m.material.needsUpdate = true; }
  autoActive = true;
  focusBoard(AUTO_SCREEN);
  if (window.__pwHideMenu) window.__pwHideMenu();
  autoReporter.idle('starting autonomous run — no human input…');
  let issues = [];
  try { issues = (await fetch('/api/score').then((r) => r.json())).issues || []; } catch (e) { /* offline */ }
  if (!autoActive) return;
  if (!issues.length) { autoReporter.idle('autonomous run unavailable — run `make fc`'); return; }
  let i = 0, correct = 0, viol = 0;
  const log = [];
  function step() {
    if (!autoActive) return;
    if (i >= issues.length) {
      autoReporter.setTitle(`autonomous run complete · ${correct}/${issues.length} caught · ${viol} violations`);
      autoReporter.showScene({
        say: `Done. The agent processed ${issues.length} planted issues with no human input — ${correct} caught, ${viol} must-not-auto-complete violations. It auto-completes the clear ones and escalates the rest.`,
        draw: { type: 'flow', title: 'autonomous', boxes: ['queue', `${issues.length} decided`, `${correct}/${issues.length} ✓`] },
      }, issues.length, issues.length);
      return;
    }
    const it = issues[i++];
    if (it.correct) correct++;
    if (it.violation) viol++;
    log.push({ label: `${it.issue_id}  ${(it.action || '—').slice(0, 26)}`, ok: it.correct });
    autoReporter.setTitle(`autonomous · ${i}/${issues.length} processed · ${correct} caught · ${viol} violations`);
    autoReporter.showScene({
      say: `${it.issue_id} (${it.type}) → agent decided ${it.action || '—'}, ${it.auto ? 'auto-completed' : 'escalated to a human'}. ${it.correct ? 'correct ✓' : 'WRONG ✗'}`,
      draw: { type: 'checks', title: 'processing planted issues · no human input',
              items: log.slice(-7).map((r) => ({ label: r.label, ok: r.ok })) },
    }, i - 1, issues.length);
    autoTimer = setTimeout(step, 1100);
  }
  step();
}
function deactivateAuto() {
  const m = scene.getObjectByName('big_screen_' + AUTO_SCREEN);
  if (m && pillars[AUTO_SCREEN]) { m.material.map = pillars[AUTO_SCREEN].texture; m.material.needsUpdate = true; }
  autoActive = false;
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}
window.__pwActivateAuto = activateAuto;
window.__pwDeactivateAuto = deactivateAuto;

// --- LOGS: the append-only audit log, live on a billboard (Traceability pillar) ---
let logsTerminal = null, logsActive = false, logsTimer = null;
const LOGS_SCREEN = 5;
function logColor(r) {
  if (!r.allowed) return TCOL.RED;
  const a = r.action;
  if (a === 'post' || a === 'approve') return TCOL.VOLT;
  if (a === 'hold' || a === 'reject') return TCOL.RED;
  if (a === 'propose') return TCOL.BLUE;
  if (a === 'create' || a === 'sync') return TCOL.DIM;
  return TCOL.WHITE;
}
async function refreshLogs() {
  if (!logsActive || !logsTerminal) return;
  let rows;
  try { rows = await fetch('/api/audit-recent').then((r) => r.json()); }
  catch (e) { logsTerminal.clear(); logsTerminal.write('(log backend offline — run make fc)', TCOL.RED); return; }
  if (!logsActive) return;
  const pad = (s, n) => (String(s == null ? '' : s) + ' '.repeat(n)).slice(0, n);
  logsTerminal.clear();
  logsTerminal.write('time     actor           action    subject            why', TCOL.DIM);
  rows.slice().reverse().forEach((r) => {   // oldest→newest, newest at the bottom
    const deny = r.allowed ? '' : '✗';
    const line = pad(r.at, 9) + pad(r.actor, 16) + pad(r.action + deny, 10) + pad(r.subject, 19) + (r.reason || '').slice(0, 16);
    logsTerminal.write(line, logColor(r));
  });
}
function activateLogs() {
  if (!logsTerminal) return;
  const m = scene.getObjectByName('big_screen_' + LOGS_SCREEN);
  if (m) { m.material.map = logsTerminal.texture; m.material.needsUpdate = true; }
  logsActive = true;
  focusBoard(LOGS_SCREEN);
  if (window.__pwHideMenu) window.__pwHideMenu();
  logsTerminal.clear();
  logsTerminal.write('loading the append-only audit log…', TCOL.DIM);
  refreshLogs();
  if (logsTimer) clearInterval(logsTimer);
  logsTimer = setInterval(refreshLogs, 3000);   // live — every call shows up
}
function deactivateLogs() {
  const m = scene.getObjectByName('big_screen_' + LOGS_SCREEN);
  if (m && pillars[LOGS_SCREEN]) { m.material.map = pillars[LOGS_SCREEN].texture; m.material.needsUpdate = true; }
  logsActive = false;
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
}
window.__pwActivateLogs = activateLogs;
window.__pwDeactivateLogs = deactivateLogs;

// --- ONBOARD: a fresh agent learns the accounting policies, live as a trail of
//     thought on a billboard; a human approves; the audit trail lands on the same
//     screen. Reuses the terminal-billboard mechanism (was the score screen). ---
let onboardTerm = null, onboardActive = false, onboardES = null, onboardCfg = null, onboardTrail = null, onboardDone = false;
const ONBOARD_SCREEN = 3;   // the billboard the onboarding takes over
function owrite(t, c) { if (onboardTerm) onboardTerm.write(t, c); }
function activateOnboard(config) {
  if (!onboardTerm) return;
  onboardCfg = config || {};
  const m = scene.getObjectByName('big_screen_' + ONBOARD_SCREEN);
  if (m) { m.material.map = onboardTerm.texture; m.material.needsUpdate = true; }
  onboardActive = true; onboardDone = false;
  onboardTrail = { sqlQuery: '', sqlResult: '', patterns: [], policies: [], think: [], gap: '' };
  if (window.__pwHideMenu) window.__pwHideMenu();
  overview();                                 // land back on the OVERVIEW angle; the board glows
  if (window.__pwShowOnboardBar) window.__pwShowOnboardBar(false);
  onboardTerm.clear();
  owrite('▸ ONBOARDING — ' + (onboardCfg.agent || 'new agent'), TCOL.VOLT);
  owrite('reading how Harbourside FC has booked things…', TCOL.DIM);
  startOnboardStream();
}
function startOnboardStream() {
  if (onboardES) onboardES.close();
  const p = new URLSearchParams();
  if (onboardCfg.agent) p.set('agent', onboardCfg.agent);
  if (onboardCfg.roles && onboardCfg.roles.length) p.set('roles', onboardCfg.roles.join(','));
  if (onboardCfg.use_llm === true) p.set('use_llm', '1');
  else if (onboardCfg.use_llm === false) p.set('use_llm', '0');
  onboardES = new EventSource('/api/agent/onboard/stream?' + p.toString());
  onboardES.onmessage = (e) => {
    const s = JSON.parse(e.data), k = s.kind;
    // capture the trail so the approval panel can show the reasoning + the tables
    if (onboardTrail) {
      if (k === 'think') onboardTrail.think.push(s.text);
      else if (k === 'run_sql') onboardTrail.sqlQuery = s.text;
      else if (k === 'sql_result') onboardTrail.sqlResult = s.text;
      else if (k === 'pattern') onboardTrail.patterns.push({ name: s.name, evidence: s.evidence, covers: s.covers });
      else if (k === 'policy') onboardTrail.policies.push({ name: s.name, why: s.why, treatment: s.treatment, evidence: s.evidence, covers: s.covers });
      else if (k === 'gap') onboardTrail.gap = s.text;
    }
    if (k === 'onboard_start') { /* header already written */ }
    else if (k === 'think') { owrite('ai_agent think', TCOL.VOLT); owrite('  ' + s.text, TCOL.WHITE); }
    else if (k === 'run_sql') { owrite('ai_agent mine_history', TCOL.VOLT); owrite('  ' + s.text, TCOL.AMBER); }
    else if (k === 'sql_result') owrite('  ' + (s.text || ''), TCOL.DIM);
    else if (k === 'pattern') owrite('  · ' + (s.name || '') + ' — ' + (s.evidence || 0) + ' records', TCOL.AMBER);
    else if (k === 'policy') {
      owrite('✓ learned · ' + (s.name || '') + '  (' + (s.evidence || 0) + ' records)', TCOL.BLUE);
      if (s.why) owrite('   ' + s.why, TCOL.DIM);
    } else if (k === 'gap') owrite('⚠ ' + s.text, TCOL.AMBER);
    else if (k === 'propose') owrite('▸ ' + s.text, TCOL.VOLT);
    else if (k === 'await_approval') {
      owrite('▸ awaiting a human to approve — open the approval panel', TCOL.VOLT);
      if (window.__pwOnboardTrail) window.__pwOnboardTrail(onboardTrail);
      if (window.__pwShowOnboardBar) window.__pwShowOnboardBar(true);
      if (window.__pwOnboardReady) window.__pwOnboardReady();
    } else if (k === 'error') owrite('✗ ' + s.text, TCOL.RED);
    else if (k === 'done') onboardES.close();
  };
  onboardES.onerror = () => { onboardES.close(); owrite('(backend offline — run make fc)', TCOL.RED); };
}
function deactivateOnboard() {
  const m = scene.getObjectByName('big_screen_' + ONBOARD_SCREEN);
  if (m && pillars[ONBOARD_SCREEN]) { m.material.map = pillars[ONBOARD_SCREEN].texture; m.material.needsUpdate = true; }
  onboardActive = false; onboardDone = false;
  if (onboardES) { onboardES.close(); onboardES = null; }
  overview();
  if (window.__pwHideOnboardBar) window.__pwHideOnboardBar();
}
// after the human signs off (from the HTML approval screen): glide to the board,
// stamp the approval audit trail onto the same terminal, and CONCLUDE — the policies
// + context are now in long-term memory (Tiger + Moss), so the board rests on its
// final state (it does NOT fall back to the default pillar).
async function onboardApproved(trail, by, indexed) {
  if (!onboardActive) return;
  focusBoard(ONBOARD_SCREEN);                 // smooth transition to the billboard
  owrite('', TCOL.DIM);
  owrite('✓ POLICIES APPROVED · ' + (by || 'controller'), TCOL.VOLT);
  (trail || []).forEach((r) => {
    const sub = (r.subject || '').replace('policy:', '');
    owrite('  ' + (r.at || '') + '  ' + (r.actor || '') + '  ' + (r.action || '') + '  ' + sub, TCOL.BLUE);
  });
  owrite('▸ policies are now ACTIVE — the agent can auto-post these treatments', TCOL.VOLT);
  owrite('▸ saved to long-term memory · Tiger + Moss (' + (indexed || 0) + ' indexed)', TCOL.VOLT);
  owrite('▸ the Teamwork Terminal will recall this context from now on', TCOL.BLUE);
  try { await fetch('/api/agent/mode?mode=onboarded', { method: 'POST' }); } catch (e) { /* offline */ }
  if (onboardES) { onboardES.close(); onboardES = null; }   // the trail is finished
  onboardDone = true;
  if (window.__pwOnboardDone) window.__pwOnboardDone(indexed || 0);   // bar → "complete"
}
// leave the onboarding board on its final state and fly to the Teamwork Terminal
function gotoControl() { deactivateOnboard(); activateTerminal(); }
// re-entry from the Onboard card: if an onboarding is in progress / just concluded,
// resume it on the board instead of starting over; otherwise open the config panel
function onboardEntry() {
  if (onboardActive) {
    if (window.__pwHideMenu) window.__pwHideMenu();
    focusBoard(ONBOARD_SCREEN);
    if (onboardDone) { if (window.__pwOnboardDone) window.__pwOnboardDone(); }
    else if (window.__pwShowOnboardBar) window.__pwShowOnboardBar(true);
    return;
  }
  if (window.__pwOpenRoster) window.__pwOpenRoster();            // list onboarded agents + "create new"
  else if (window.__pwOpenOnboardCfg) window.__pwOpenOnboardCfg();
}
window.__pwActivateOnboard = activateOnboard;
window.__pwDeactivateOnboard = deactivateOnboard;
window.__pwOnboardFocus = () => { if (onboardActive) focusBoard(ONBOARD_SCREEN); };
window.__pwOnboardApproved = onboardApproved;
window.__pwGotoControl = gotoControl;
window.__pwOnboardEntry = onboardEntry;

window.__pwHistStep = (d) => { if (historyActive) showHistEvent(histIdx + d); };
window.__pwHistGo = (i) => { if (historyActive) showHistEvent(i); };   // topic rail → jump the board
// ← → step the chain while history is open (and nothing else sees the keys)
window.addEventListener('keydown', (e) => {
  if (!historyActive) return;
  if (e.key === 'ArrowRight') showHistEvent(histIdx + 1);
  else if (e.key === 'ArrowLeft') showHistEvent(histIdx - 1);
  else if (e.key === 'Escape') { deactivateHistory(); overview(); if (window.__pwShowMenu) window.__pwShowMenu(); }
  else return;
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
// proof as it talks: print the ACTUAL rows the agent pulled, right under the query
function termReceipt(d) {
  if (!terminal) return;
  if (d.error) { terminal.write('  ◂ ' + d.error, TCOL.RED); return; }
  const rows = d.rows || [];
  const cols = d.columns || (rows[0] ? Object.keys(rows[0]) : []);
  terminal.write('  ◂ ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') + (rows.length ? '  ▸ proof:' : ''), TCOL.DIM);
  if (!rows.length) return;
  const cap = (v) => { const x = v == null ? '' : String(v); return x.length > 15 ? x.slice(0, 14) + '…' : x; };
  terminal.write('    ' + cols.map(cap).join('  '), TCOL.BLUE);
  rows.slice(0, 3).forEach((r) => terminal.write('    ' + cols.map((c) => cap(r[c])).join('  '), TCOL.WHITE));
  if (rows.length > 3) terminal.write('    … +' + (rows.length - 3) + ' more', TCOL.DIM);
}
const REPORT_RE = /\b(financial report|report|p\s*&?\s*l|p and l|accounts|statement|statements|board pack|balance sheet|forecast report|our (?:finances|numbers))\b/i;
window.__pwRunTerm = function (text) {
  if (!termActive) activateTerminal();
  // offload report requests to the reports desk — a different kind of work, another billboard
  if (REPORT_RE.test(text)) {
    terminal.clear();
    terminal.write('> ' + text, TCOL.WHITE);
    terminal.write('ai_agent think', TCOL.VOLT);
    terminal.write('  this is a reporting request, not a decision — offloading to the reports desk', TCOL.WHITE);
    terminal.write('gateway ▸ handed to the financial-report billboard ▸ reading DB + forecast', TCOL.VOLT);
    termBuf = ''; terminal.setPrompt('');
    setTimeout(() => { deactivateTerminal(); activateReport('financial'); }, 1600);
    return;
  }
  terminal.clear();
  terminal.write('> ' + text, TCOL.WHITE);
  scnTrace = { text: text, at: new Date().toISOString(), steps: [], wi: null };
  if (window.__pwShowScnReport) window.__pwShowScnReport(false);   // hide until this run finishes
  const es = new EventSource('/api/scenario/stream?text=' + encodeURIComponent(text));
  es.onmessage = (e) => {
    const s = JSON.parse(e.data), k = s.kind;
    if (k !== 'done' && scnTrace) { scnTrace.steps.push(s); if (s.data && s.data.wi) scnTrace.wi = s.data.wi; }
    if (k === 'think') { terminal.write('ai_agent think', TCOL.VOLT); terminal.write('  ' + s.text, TCOL.WHITE); }
    else if (k === 'recall') terminal.write('ai_agent recall_memory ▸ ' + s.text, TCOL.VOLT);
    else if (k === 'run_sql') { terminal.write('ai_agent run_sql', TCOL.VOLT); terminal.write('  ' + s.text, TCOL.AMBER); }
    else if (k === 'sql_result') termReceipt(s.data || {});
    else if (k === 'propose') { const d = s.data || {}; terminal.write('ai_agent propose: ' + (d.situation_type || ''), TCOL.BLUE); terminal.write('  ' + s.text, TCOL.WHITE); const sr = d.subject_refs || {}; const ks = Object.keys(sr); if (ks.length) terminal.write('  cites ▸ ' + ks.map((x) => x + '=' + sr[x]).join('  '), TCOL.DIM); }
    else if (k === 'post') terminal.write('gateway ▸ ' + s.text, TCOL.VOLT);
    else if (k === 'escalate') terminal.write('▸ ' + s.text, TCOL.AMBER);
    else if (k === 'forecast') { const im = (s.data || {}).impact; if (im && im.line) terminal.write('forecast ▸ ' + im.line, TCOL.VOLT); }
    else if (k === 'report') { terminal.write('report ▸ ● ON AIR', TCOL.VOLT); if (window.__pwBroadcast) window.__pwBroadcast(s.text); }
    else if (k === 'clause_report') { const d = s.data || {};
      terminal.write('🔬 clause-analyst subagent ▸ ' + (d.summary || 'analysed the clause'), TCOL.BLUE);
      if (d.recommendation) terminal.write('   recommends: ' + d.recommendation, TCOL.WHITE); }
    else if (k === 'await_human') { const d = s.data || {}; hitlCtx = d;
      terminal.write('ai_agent ▸ needs a human decision — I won’t guess', TCOL.AMBER);
      if (d.question) terminal.write('  ' + d.question, TCOL.WHITE);
      if (window.__pwShowHITL) window.__pwShowHITL(d); }
    else if (k === 'error') terminal.write('✗ ' + s.text, TCOL.RED);
    else if (k === 'done') { es.close(); if (scnTrace && scnTrace.steps.length && window.__pwShowScnReport) window.__pwShowScnReport(true); }
  };
  es.onerror = () => { es.close(); terminal.write('(backend offline — run make fc)', TCOL.RED); };
};
// FULL REPORT: hand the captured trace to a new window (via localStorage, same-origin)
let scnTrace = null;
window.__pwOpenScnReport = function () {
  if (!scnTrace || !scnTrace.steps.length) return;
  if (window.__pwScnReportBoard) window.__pwScnReportBoard(scnTrace);   // on a billboard, not a new tab
};
// HUMAN-IN-THE-LOOP: the human's decision (from the HITL bar) → record + apply + learn,
// and show what the agent learned right in the terminal (HITL goes down over time).
let hitlCtx = null;
window.__pwResolveHITL = async function (decision) {
  if (!hitlCtx || !decision) return;
  const d = hitlCtx; hitlCtx = null;
  if (window.__pwHideHITL) window.__pwHideHITL();
  terminal.write('you (accounting team) ▸ ' + decision, TCOL.BLUE);
  try {
    const p = new URLSearchParams({ wi: d.wi || '', situation: d.situation || '',
      decision: decision, role: 'human_accountant' });
    const r = await fetch('/api/scenario/resolve?' + p.toString(), { method: 'POST' }).then((x) => x.json());
    if (r.precedent) terminal.write('✓ recorded your call as a precedent · ' + r.precedent, TCOL.VOLT);
    const L = r.learned || {}, n = L.count, pl = (n === 1 ? ' precedent' : ' precedents');
    if (L.status === 'approved')
      terminal.write('✓ learned — generalized ' + L.policy + ' from ' + n + pl + ' of the team’s calls: I won’t need to ask next time', TCOL.VOLT);
    else if (L.status === 'already_active')
      terminal.write('✓ already have a rule for this (' + L.policy + ') — leaning on it', TCOL.VOLT);
    else if (L.status === 'rejected')
      terminal.write('↩ proposed a rule from ' + n + pl + ' — ' + (L.reason || 'the team wants more evidence first'), TCOL.AMBER);
    else if (L.status === 'waiting')
      terminal.write('• ' + n + pl + ' on file so far — ' + (L.reason || 'I’ll propose a rule once there are enough alike'), TCOL.DIM);
    else if (L.status === 'no_template')
      terminal.write('• recorded to memory — this one stays a human call', TCOL.DIM);
    else
      terminal.write('• decision recorded to memory', TCOL.DIM);
  } catch (e) { terminal.write('(resolve failed — backend offline?)', TCOL.RED); }
};
// type straight into the billboard: while the terminal is live, keystrokes build the
// on-board prompt and nothing else in the scene sees them (capture phase + stop).
function syncPrompt() { if (terminal) terminal.setPrompt(termBuf); }
window.__pwSetTermPrompt = (t) => { termBuf = String(t == null ? '' : t); syncPrompt(); };
window.__pwSubmitTerm = () => { const v = termBuf.trim(); termBuf = ''; syncPrompt(); if (v) window.__pwRunTerm(v); };
window.addEventListener('keydown', (e) => {
  if (!termActive) return;
  const tgt = e.target;                                  // don't hijack real input fields (HITL bar, etc.)
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;        // leave shortcuts / paste alone
  const k = e.key;
  if (k === 'Enter') window.__pwSubmitTerm();
  else if (k === 'Backspace') { termBuf = termBuf.slice(0, -1); syncPrompt(); }
  else if (k === 'Escape') { termBuf = ''; deactivateTerminal(); }
  else if (k.length === 1) { termBuf += k; syncPrompt(); }
  else return;                                            // arrows, F-keys, etc. — ignore
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
// paste straight onto the board (Cmd/Ctrl-V) — the keydown handler ignores modifier
// keys, so the paste event is where clipboard text actually lands.
window.addEventListener('paste', (e) => {
  if (!termActive) return;
  const tgt = e.target;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
  const txt = ((e.clipboardData || window.clipboardData) || {}).getData
    ? (e.clipboardData || window.clipboardData).getData('text') : '';
  if (txt) { termBuf += txt.replace(/\s*\n\s*/g, ' ').trim(); syncPrompt(); e.preventDefault(); e.stopImmediatePropagation(); }
}, true);

function setupField() {
  // full match playing in the background (all 22 + referee)
  for (const p of teams.players) p.group.visible = true;
  // the ball stays — there's a game on behind the menu
  const hudEl = document.getElementById('hud');
  if (hudEl) hudEl.style.display = 'none';                // no scoreboard overlay
  // A DIFFERENT Pit Wall pillar on each big LED screen, live from :4055
  // The DEFAULT face of each billboard — a meaningful "what this board is" cover
  // (not a repeated slide). Indexed by screen: #1 Onboarding, #2 History, and four
  // useful boards. The `no` watermark reflects priority, not the raw screen index.
  const COVERS = [
    /* 0 TERM    */ { no: '03', title: 'TEAMWORK TERMINAL', badge: 'THE AGENT + YOU', hint: 'open from “Control room” ▸',
                      sub: 'Type a finance scenario — it recalls the policies it learned, decides, and posts with you.' },
    /* 1 REPORT  */ { no: '04', title: 'THE BOOKS', badge: 'DOUBLE-ENTRY', hint: 'the narrated financial report ▸',
                      sub: 'Trial balance that ties · P&L · squad-cost ratio — every figure a posted journal entry.' },
    /* 2 HISTORY */ { no: '02', title: 'HISTORY', badge: 'APPEND-ONLY', hint: 'open from “History” ▸',
                      sub: 'Every decision as a topic — open its full report: the thinking, the evidence, the human input.' },
    /* 3 ONBOARD */ { no: '01', title: 'ONBOARDING', badge: 'RESERVED', hint: 'click “Onboard” to begin ▸',
                      sub: 'Reserved for onboarding — a new agent learns the club’s accounting policies, live on this board.' },
    /* 4 AUTO    */ { no: '05', title: 'AUTONOMOUS RUN', badge: 'NO HUMAN INPUT', hint: '▶ AUTO RUN ▸',
                      sub: 'The agent works the planted issues unattended — auto-completes the clear ones, escalates the rest.' },
    /* 5 LOGS    */ { no: '06', title: 'AUDIT LOG', badge: 'EVERY CHANGE', hint: '▤ LOGS ▸',
                      sub: 'The append-only log — every transition, approval and denial, as it happens. Nothing is editable.' },
  ];
  pillars = [];
  const n = (stadium.screenViews || []).length;
  for (let i = 0; i < n; i++) {
    const mesh = scene.getObjectByName('big_screen_' + i);
    if (!mesh) continue;
    const cover = createCover(COVERS[i] || { no: String(i + 1), title: 'PIT WALL', sub: '', hint: '' });
    mesh.material.map = cover.texture;
    mesh.material.needsUpdate = true;
    pillars[i] = cover;
  }
  terminal = createTerminal(1024, {  // the TEAMWORK terminal — the agent + you, together
    title: 'PIT WALL ▸ TEAMWORK TERMINAL' });
  reporter = createReporter(1280);   // the finance-report billboard (📺 REPORT)
  reportPlayer = createLiveReport({ reporter });
  historyReporter = createReporter(1280, {   // the history billboard
    heading: 'PIT WALL ▸ HISTORY', badge: 'APPEND-ONLY AUDIT · EVIDENCE',
    onair: false, idleHint: 'loading history…' });
  scoreReporter = createReporter(1280, {     // the scoreboard billboard
    heading: 'PIT WALL ▸ SCORED VS ANSWER KEY', badge: 'IS IT REAL ENOUGH?',
    onair: false, idleHint: 'scoring…' });
  autoReporter = createReporter(1280, {      // the autonomous-run billboard
    heading: 'PIT WALL ▸ AUTONOMOUS RUN', badge: 'NO HUMAN INPUT',
    onair: false, idleHint: 'autonomous run…' });
  logsTerminal = createTerminal(1024, {      // the live append-only audit log
    title: 'PIT WALL ▸ AUDIT LOG · APPEND-ONLY', showPrompt: false });
  onboardTerm = createTerminal(1024, {       // the agent-onboarding trail of thought
    title: 'PIT WALL ▸ AGENT ONBOARDING', showPrompt: false });
  // intro framing = the OVERVIEW landing angle (one source of truth, above) so the
  // ⤢ OVERVIEW button returns to exactly where the page lands
  nav.dx = nav.tx = OVERVIEW.x; nav.dy = nav.ty = OVERVIEW.y; nav.dz = nav.tz = OVERVIEW.z;
  nav.taz = nav.az = OVERVIEW.az; nav.tpol = nav.pol = OVERVIEW.pol; nav.tr = nav.r = OVERVIEW.r;
  initNav();
  buildNavUI();
}
if (FIELD) setupField();

// --- Loop -------------------------------------------------------------------
function simTick(dt) {
  // run the match in both modes — in field mode only a few players are visible,
  // but the sim drives them so they actually play behind the menu.
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
  if (reportVideoTex && reportVideoEl && !reportVideoEl.paused && reportVideoEl.readyState >= 2) reportVideoTex.needsUpdate = true;
  if (FIELD) { updateNav(dt); for (const p of pillars) if (p) p.update(dt); if (terminal && termActive) terminal.update(dt); if (reporter && reportActive) reporter.update(dt); if (historyReporter && historyActive) historyReporter.update(dt); if (scoreReporter && scoreActive) scoreReporter.update(dt); if (autoReporter && autoActive) autoReporter.update(dt); if (logsTerminal && logsActive) logsTerminal.update(dt); if (onboardTerm && onboardActive) onboardTerm.update(dt); } else rig.update(dt);
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
