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
import { PILLAR_KEYS, createPillar } from './pillars.js';
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
  document.getElementById('pw-over').addEventListener('click', () => { overview(); deactivateTerminal(); deactivateReport(); deactivateHistory(); deactivateScore(); deactivateAuto(); deactivateLogs(); if (window.__pwShowMenu) window.__pwShowMenu(); });
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
  terminal.write('just start typing — Enter runs it, Esc exits', TCOL.DIM);
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
function activateReport() {
  if (!reporter) return;
  const m = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
  if (m) { m.material.map = reporter.texture; m.material.needsUpdate = true; }
  reportActive = true;
  focusBoard(REPORT_SCREEN);        // normal framing (⛶ for fullscreen on demand)
  if (window.__pwHideMenu) window.__pwHideMenu();
  reportPlayer.start('WI-5602');   // the fraud-hold decision, narrated + grounded
}
function deactivateReport() {
  const m = scene.getObjectByName('big_screen_' + REPORT_SCREEN);
  if (m && pillars[REPORT_SCREEN]) { m.material.map = pillars[REPORT_SCREEN].texture; m.material.needsUpdate = true; }
  reportActive = false;
  if (reportPlayer) reportPlayer.stop();
}
window.__pwActivateReport = activateReport;
window.__pwDeactivateReport = deactivateReport;

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
  historyReporter.idle('loading transaction history…');
  try { historyEvents = (await fetch('/api/history').then((r) => r.json())).events || []; }
  catch (e) { historyEvents = []; }
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
window.__pwHistStep = (d) => { if (historyActive) showHistEvent(histIdx + d); };
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
window.__pwRunTerm = function (text) {
  if (!termActive) activateTerminal();
  terminal.clear();
  terminal.write('> ' + text, TCOL.WHITE);
  const es = new EventSource('/api/scenario/stream?text=' + encodeURIComponent(text));
  es.onmessage = (e) => {
    const s = JSON.parse(e.data), k = s.kind;
    if (k === 'think') { terminal.write('ai_agent think', TCOL.VOLT); terminal.write('  ' + s.text, TCOL.WHITE); }
    else if (k === 'recall') terminal.write('ai_agent recall_memory ▸ ' + s.text, TCOL.VOLT);
    else if (k === 'run_sql') { terminal.write('ai_agent run_sql', TCOL.VOLT); terminal.write('  ' + s.text, TCOL.AMBER); }
    else if (k === 'sql_result') termReceipt(s.data || {});
    else if (k === 'propose') { const d = s.data || {}; terminal.write('ai_agent propose: ' + (d.situation_type || ''), TCOL.BLUE); terminal.write('  ' + s.text, TCOL.WHITE); const sr = d.subject_refs || {}; const ks = Object.keys(sr); if (ks.length) terminal.write('  cites ▸ ' + ks.map((x) => x + '=' + sr[x]).join('  '), TCOL.DIM); }
    else if (k === 'post') terminal.write('gateway ▸ ' + s.text, TCOL.VOLT);
    else if (k === 'escalate') terminal.write('▸ ' + s.text, TCOL.AMBER);
    else if (k === 'forecast') { const im = (s.data || {}).impact; if (im && im.line) terminal.write('forecast ▸ ' + im.line, TCOL.VOLT); }
    else if (k === 'report') { terminal.write('report ▸ ● ON AIR', TCOL.VOLT); if (window.__pwBroadcast) window.__pwBroadcast(s.text); }
    else if (k === 'error') terminal.write('✗ ' + s.text, TCOL.RED);
    else if (k === 'done') es.close();
  };
  es.onerror = () => { es.close(); terminal.write('(backend offline — run make fc)', TCOL.RED); };
};
// type straight into the billboard: while the terminal is live, keystrokes build the
// on-board prompt and nothing else in the scene sees them (capture phase + stop).
function syncPrompt() { if (terminal) terminal.setPrompt(termBuf); }
window.__pwSetTermPrompt = (t) => { termBuf = String(t == null ? '' : t); syncPrompt(); };
window.__pwSubmitTerm = () => { const v = termBuf.trim(); termBuf = ''; syncPrompt(); if (v) window.__pwRunTerm(v); };
window.addEventListener('keydown', (e) => {
  if (!termActive) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;        // leave shortcuts / paste alone
  const k = e.key;
  if (k === 'Enter') window.__pwSubmitTerm();
  else if (k === 'Backspace') { termBuf = termBuf.slice(0, -1); syncPrompt(); }
  else if (k === 'Escape') { termBuf = ''; deactivateTerminal(); }
  else if (k.length === 1) { termBuf += k; syncPrompt(); }
  else return;                                            // arrows, F-keys, etc. — ignore
  e.preventDefault(); e.stopImmediatePropagation();
}, true);

function setupField() {
  // full match playing in the background (all 22 + referee)
  for (const p of teams.players) p.group.visible = true;
  // the ball stays — there's a game on behind the menu
  const hudEl = document.getElementById('hud');
  if (hudEl) hudEl.style.display = 'none';                // no scoreboard overlay
  // A DIFFERENT Pit Wall pillar on each big LED screen, live from :4055
  pillars = [];
  const n = (stadium.screenViews || []).length;
  for (let i = 0; i < n; i++) {
    const mesh = scene.getObjectByName('big_screen_' + i);
    if (!mesh) continue;
    const p = createPillar(PILLAR_KEYS[i % PILLAR_KEYS.length]);
    mesh.material.map = p.texture;
    mesh.material.needsUpdate = true;
    pillars.push(p);
  }
  terminal = createTerminal(1024);   // ready to take over a screen on ⌨ SCENARIO
  reporter = createReporter(1280);   // the finance-report billboard (📺 REPORT)
  reportPlayer = createLiveReport({ reporter });
  historyReporter = createReporter(1280, {   // the transaction-history billboard
    heading: 'PIT WALL ▸ TRANSACTION HISTORY', badge: 'APPEND-ONLY AUDIT · EVIDENCE',
    onair: false, idleHint: 'loading transaction history…' });
  scoreReporter = createReporter(1280, {     // the scoreboard billboard
    heading: 'PIT WALL ▸ SCORED VS ANSWER KEY', badge: 'IS IT REAL ENOUGH?',
    onair: false, idleHint: 'scoring…' });
  autoReporter = createReporter(1280, {      // the autonomous-run billboard
    heading: 'PIT WALL ▸ AUTONOMOUS RUN', badge: 'NO HUMAN INPUT',
    onair: false, idleHint: 'autonomous run…' });
  logsTerminal = createTerminal(1024, {      // the live append-only audit log
    title: 'PIT WALL ▸ AUDIT LOG · APPEND-ONLY', showPrompt: false });
  // intro framing: the exact angle you picked (press "p" to re-capture)
  nav.dx = nav.tx = 44; nav.dy = nav.ty = 3; nav.dz = nav.tz = 0;
  nav.taz = nav.az = -1.592; nav.tpol = nav.pol = 0.233; nav.tr = nav.r = 96.2;
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
  if (FIELD) { updateNav(dt); for (const p of pillars) p.update(dt); if (terminal && termActive) terminal.update(dt); if (reporter && reportActive) reporter.update(dt); if (historyReporter && historyActive) historyReporter.update(dt); if (scoreReporter && scoreActive) scoreReporter.update(dt); if (autoReporter && autoActive) autoReporter.update(dt); if (logsTerminal && logsActive) logsTerminal.update(dt); } else rig.update(dt);
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
