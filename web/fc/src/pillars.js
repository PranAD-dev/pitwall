// ---------------------------------------------------------------------------
// pillars.js — six DISTINCT in-world jumbotron panels, one per Hyphenate deck
// pillar, each drawn to its own canvas and fed live from the Pit Wall API
// (http://localhost:4055). Fixes "every board says the same thing": each screen
// now shows a different system (Environment / Agents+Humans / Harness /
// Traceability / Self-learning+improving / Forecast).
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const API = 'http://localhost:4055';
const BG = '#05080c', VOLT = '#c6ff2e', WHITE = '#eef3f7', DIM = 'rgba(255,255,255,.5)',
  BLUE = '#7fd4ff', RED = '#ff5564';
const MONO = 'ui-monospace,"SF Mono",Menlo,monospace';
const fmt = (n) => n == null ? '—' : (Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k');

export const PILLAR_KEYS = ['environment', 'agents', 'harness', 'traceability', 'memory', 'forecast'];

const DEF = {
  environment: { no: '01', title: 'ENVIRONMENT', sub: 'SYNC INTO ONE SHAPE', url: '/api/environment', draw: drawEnv },
  agents: { no: '02', title: 'AGENTS + HUMANS', sub: 'WHO MAY DO WHAT', url: '/api/denials', draw: drawAgents },
  harness: { no: '03', title: 'THE HARNESS', sub: 'CRUD ON THE WORK', url: '/api/metrics', draw: drawHarness },
  traceability: { no: '04', title: 'TRACEABILITY', sub: 'EVERY TRANSITION A DIFF', url: '/api/audit-recent', draw: drawTrace },
  memory: { no: '05', title: 'LEARNS + IMPROVES', sub: 'POLICIES IN FORCE', url: '/api/policies', draw: drawMemory },
  forecast: { no: '06', title: 'FORECAST', sub: 'THE 5TH SYSTEM', url: '/api/forecast', draw: drawForecast },
};

export function createPillar(key) {
  const def = DEF[key] || DEF.environment;
  const W = 1024, H = Math.round(W * 0.5625);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;

  let data = null, err = false, t = 0, acc = 99, lastFrame = -1;
  const load = () => fetch(API + def.url).then((r) => r.json()).then((d) => { data = d; err = false; })
    .catch(() => { err = true; });
  load();

  function frame() {
    c.fillStyle = BG; c.fillRect(0, 0, W, H);
    chrome(c, W, H, def);
    if (data) def.draw(c, W, H, data, t);
    else { c.fillStyle = DIM; c.font = `600 ${Math.round(H * 0.05)}px ${MONO}`; c.textAlign = 'center';
      c.fillText(err ? 'PIT WALL OFFLINE · run `make fc`' : 'connecting…', W / 2, H * 0.6); c.textAlign = 'left'; }
    grid(c, W, H);
    tex.needsUpdate = true;
  }
  frame();

  return {
    texture: tex,
    update(dt) {
      t += dt; acc += dt;
      if (acc > 5) { acc = 0; load(); }
      const f = Math.floor(t * 3);
      if (f !== lastFrame) { lastFrame = f; frame(); }   // ~3 fps redraw
    },
  };
}

// ---- shared chrome ----
function chrome(c, w, h, def) {
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillStyle = VOLT; c.font = `800 ${Math.round(h * 0.055)}px ${MONO}`;
  c.fillText(def.no + ' · ' + def.title, w * 0.045, h * 0.135);
  c.fillStyle = DIM; c.font = `600 ${Math.round(h * 0.034)}px ${MONO}`;
  c.fillText(def.sub, w * 0.047, h * 0.19);
  c.strokeStyle = 'rgba(198,255,46,.3)'; c.lineWidth = Math.max(1, w * 0.0015);
  c.beginPath(); c.moveTo(w * 0.045, h * 0.23); c.lineTo(w * 0.955, h * 0.23); c.stroke();
}
function grid(c, w, h) {
  c.globalAlpha = 0.15; c.fillStyle = '#000';
  for (let y = 0; y < h; y += 5) c.fillRect(0, y, w, 1);
  for (let x = 0; x < w; x += 5) c.fillRect(x, 0, 1, h);
  c.globalAlpha = 1;
}
function big(c, w, h, text, y, color) {
  c.fillStyle = color || VOLT; c.font = `800 ${Math.round(h * 0.17)}px ${MONO}`;
  c.fillText(text, w * 0.045, y);
}
function lab(c, w, h, text, y) {
  c.fillStyle = DIM; c.font = `600 ${Math.round(h * 0.034)}px ${MONO}`;
  c.fillText(text, w * 0.045, y);
}

// ---- per-pillar draws ----
function drawEnv(c, w, h, d) {
  lab(c, w, h, 'GOLDEN ROWS · SYNCED FROM 5 SYSTEMS OF RECORD', h * 0.33);
  big(c, w, h, String(d.total ?? '—'), h * 0.52);
  c.font = `600 ${Math.round(h * 0.036)}px ${MONO}`; c.fillStyle = WHITE;
  const ents = Object.entries(d.golden || {}).slice(0, 6);
  ents.forEach(([k, v], i) => {
    const x = w * (0.045 + 0.47 * (i % 2)), y = h * (0.66 + 0.12 * Math.floor(i / 2));
    c.fillStyle = DIM; c.fillText(k, x, y);
    c.fillStyle = VOLT; c.textAlign = 'right'; c.fillText(String(v), x + w * 0.4, y); c.textAlign = 'left';
  });
}
function drawAgents(c, w, h, d) {
  lab(c, w, h, 'can(actor, action, resource) · CHECKED ON EVERY CALL', h * 0.32);
  const rows = [['ai_agent', 'propose · ask'], ['human_controller', 'approve policy'],
    ['human_cfo', 'release fraud hold'], ['gateway', 'post (only)']];
  c.font = `600 ${Math.round(h * 0.044)}px ${MONO}`;
  rows.forEach(([a, act], i) => {
    const y = h * (0.42 + 0.1 * i);
    c.fillStyle = BLUE; c.fillText(a, w * 0.045, y);
    c.fillStyle = WHITE; c.fillText(act, w * 0.5, y);
  });
  const dn = (d && d[0]) || null;
  c.fillStyle = RED; c.font = `700 ${Math.round(h * 0.042)}px ${MONO}`;
  c.fillText(dn ? `✗ DENIED · ${dn.actor} ${dn.action}` : 'separation of duties enforced', w * 0.045, h * 0.9);
}
function drawHarness(c, w, h, d) {
  lab(c, w, h, 'NEW → PROPOSED → APPROVED → POSTED · HELD', h * 0.32);
  const st = (d && d.states) || {};
  const cells = [['POSTED', st.POSTED || 0], ['HELD', st.HELD || 0],
    ['PROPOSED', st.PROPOSED || 0], ['NEW', st.NEW || 0]];
  cells.forEach(([s, n], i) => {
    const x = w * (0.045 + 0.24 * i);
    c.fillStyle = DIM; c.font = `600 ${Math.round(h * 0.03)}px ${MONO}`; c.fillText(s, x, h * 0.45);
    c.fillStyle = s === 'HELD' ? RED : VOLT; c.font = `800 ${Math.round(h * 0.13)}px ${MONO}`;
    c.fillText(String(n), x, h * 0.63);
  });
  c.fillStyle = DIM; c.font = `600 ${Math.round(h * 0.036)}px ${MONO}`;
  c.fillText(`${d.audit_allowed || 0} allowed · ${d.audit_denied || 0} denied transitions logged`, w * 0.045, h * 0.86);
}
function drawTrace(c, w, h, d) {
  lab(c, w, h, 'APPEND-ONLY · WRITTEN WITH THE CHANGE · DENIED LOGGED', h * 0.31);
  c.font = `600 ${Math.round(h * 0.04)}px ${MONO}`;
  (d || []).slice(0, 7).forEach((r, i) => {
    const y = h * (0.41 + 0.075 * i);
    c.fillStyle = DIM; c.fillText(r.at, w * 0.045, y);
    c.fillStyle = BLUE; c.fillText((r.actor || '').slice(0, 16), w * 0.2, y);
    c.fillStyle = r.allowed ? VOLT : RED; c.fillText(r.action, w * 0.62, y);
  });
}
function drawMemory(c, w, h, d) {
  const ps = (d || []).filter((p) => p.auto);
  const learned = ps.filter((p) => p.origin === 'learned').length;
  const impr = ps.filter((p) => p.origin === 'self-improved').length;
  lab(c, w, h, 'THE AGENT\'S MEMORY IN THE DB', h * 0.32);
  big(c, w, h, String(ps.length), h * 0.5);
  c.font = `700 ${Math.round(h * 0.04)}px ${MONO}`;
  c.fillStyle = BLUE; c.fillText(`${learned} LEARNED`, w * 0.045, h * 0.63);
  c.fillStyle = VOLT; c.fillText(`${impr} SELF-IMPROVED`, w * 0.045, h * 0.71);
  c.fillStyle = DIM; c.font = `600 ${Math.round(h * 0.034)}px ${MONO}`;
  c.fillText(ps.slice(0, 5).map((p) => p.id + ` (${p.evidence})`).join('  ·  '), w * 0.045, h * 0.86);
}
function drawForecast(c, w, h, d) {
  lab(c, w, h, 'SQUAD-COST RATIO', h * 0.32);
  const ratio = d.squad_cost_ratio || 0, lim = d.squad_cost_limit || 70;
  big(c, w, h, ratio + '%', h * 0.5, ratio > lim ? RED : VOLT);
  const bx = w * 0.045, bw = w * 0.5, by = h * 0.56, bh = h * 0.05;
  c.fillStyle = 'rgba(255,255,255,.1)'; c.fillRect(bx, by, bw, bh);
  c.fillStyle = VOLT; c.fillRect(bx, by, bw * Math.min(1, ratio / lim), bh);
  c.fillStyle = RED; c.fillRect(bx + bw, by - h * 0.012, 3, bh + h * 0.024);
  c.fillStyle = DIM; c.font = `600 ${Math.round(h * 0.03)}px ${MONO}`; c.fillText('LIMIT ' + lim + '%', bx + bw - w * 0.08, by + h * 0.1);
  c.font = `600 ${Math.round(h * 0.036)}px ${MONO}`;
  c.fillStyle = DIM; c.fillText('CASH PIPELINE (NET)', w * 0.62, h * 0.45);
  c.fillStyle = VOLT; c.font = `800 ${Math.round(h * 0.09)}px ${MONO}`; c.fillText('£' + fmt(d.pipeline_net), w * 0.62, h * 0.56);
  c.fillStyle = DIM; c.font = `600 ${Math.round(h * 0.032)}px ${MONO}`;
  c.fillText(`in £${fmt(d.pipeline_in)}  ·  out £${fmt(d.pipeline_out)}`, w * 0.62, h * 0.67);
}
