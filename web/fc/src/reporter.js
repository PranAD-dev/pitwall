// ---------------------------------------------------------------------------
// reporter.js — a finance-report billboard. A second agent (the explainer, over
// LiveKit when live, HTTP otherwise) streams grounded scenes; we build each one
// on the big screen like a broadcast: title, the spoken caption, and the scene's
// evidence (table / checks / flow / calc). createReporter() -> { texture, setTitle,
// showScene, setSource, idle, update }.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const BG = '#05080c', VOLT = '#c6ff2e', WHITE = '#eef3f7', DIM = 'rgba(255,255,255,.5)',
  AMBER = '#ffcf33', BLUE = '#7fd4ff', RED = '#ff5564', PANEL = 'rgba(255,255,255,.04)';
const MONO = 'ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace';
const SANS = '"Rajdhani",system-ui,sans-serif';

export function createReporter(W = 1280, opts = {}) {
  const HEADING = opts.heading || 'PIT WALL ▸ FINANCE REPORT';
  const BADGE = opts.badge || 'LIVEKIT · CARTESIA';
  const ONAIR = opts.onair !== false;
  const IDLE_HINT = opts.idleHint || 'press  📺 REPORT  — a second agent narrates a decision here';
  const H = Math.round(W * 0.5625);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;

  let title = 'FINANCE REPORT', source = 'standby', scene = null, idx = 0, total = 0;
  let t = 0, lastFrame = -1, dirty = true;

  function setTitle(x) { title = String(x || 'FINANCE REPORT'); dirty = true; }
  function setSource(x) { source = String(x || ''); dirty = true; }
  function idle(msg) { scene = { _idle: msg || 'waiting for the report agent…' }; dirty = true; }
  function showScene(s, i, n) { scene = s || null; idx = (i | 0); total = (n | 0); dirty = true; }

  // --- small canvas helpers --------------------------------------------------
  function wrap(text, font, maxW) {
    c.font = font;
    const words = String(text || '').split(/\s+/); const lines = []; let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (c.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  function roundRect(x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }

  // --- the four evidence renderers (return nothing; draw into box from y) -----
  function drawTable(d, x, y, w) {
    const cols = d.columns || [], rows = d.rows || [], hi = d.highlight_row;
    const cw = w / Math.max(1, cols.length), rh = H * 0.058;
    c.font = `700 ${Math.round(H * 0.03)}px ${MONO}`; c.textBaseline = 'middle';
    c.fillStyle = VOLT;
    cols.forEach((h, j) => c.fillText(String(h), x + j * cw + 10, y + rh / 2));
    c.strokeStyle = 'rgba(198,255,46,.25)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, y + rh); c.lineTo(x + w, y + rh); c.stroke();
    c.font = `500 ${Math.round(H * 0.03)}px ${MONO}`;
    rows.forEach((row, r) => {
      const ry = y + rh * (r + 1);
      if (r === hi) { c.fillStyle = 'rgba(255,85,100,.16)'; c.fillRect(x, ry, w, rh); }
      row.forEach((cell, j) => {
        c.fillStyle = r === hi ? RED : WHITE;
        c.fillText(String(cell), x + j * cw + 10, ry + rh / 2);
      });
    });
  }
  function drawChecks(d, x, y, w) {
    const items = d.items || [], rh = H * 0.07;
    c.textBaseline = 'middle';
    items.forEach((it, r) => {
      const ry = y + rh * r, ok = !!it.ok;
      c.fillStyle = ok ? 'rgba(198,255,46,.1)' : 'rgba(255,85,100,.12)';
      roundRect(x, ry + 4, w, rh - 8, 6); c.fill();
      c.font = `800 ${Math.round(H * 0.036)}px ${MONO}`;
      c.fillStyle = ok ? VOLT : RED;
      c.fillText(ok ? '✓' : '✗', x + 16, ry + rh / 2);
      c.font = `500 ${Math.round(H * 0.03)}px ${MONO}`;
      c.fillStyle = WHITE;
      c.fillText(String(it.label || ''), x + 54, ry + rh / 2);
    });
  }
  function drawFlow(d, x, y, w) {
    const boxes = d.boxes || []; if (!boxes.length) return;
    const gap = 26, bw = (w - gap * (boxes.length - 1)) / boxes.length, bh = H * 0.15, by = y + H * 0.02;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    boxes.forEach((b, i) => {
      const bx = x + i * (bw + gap), last = i === boxes.length - 1;
      c.fillStyle = last ? 'rgba(255,85,100,.14)' : PANEL;
      c.strokeStyle = last ? RED : 'rgba(198,255,46,.5)'; c.lineWidth = 2;
      roundRect(bx, by, bw, bh, 10); c.fill(); c.stroke();
      c.fillStyle = last ? RED : WHITE; c.font = `700 ${Math.round(H * 0.032)}px ${MONO}`;
      wrap(b, c.font, bw - 18).forEach((ln, k, a) =>
        c.fillText(ln, bx + bw / 2, by + bh / 2 + (k - (a.length - 1) / 2) * H * 0.044));
      if (!last) { c.fillStyle = VOLT; c.font = `800 ${Math.round(H * 0.05)}px ${MONO}`; c.fillText('▸', bx + bw + gap / 2, by + bh / 2); }
    });
    c.textAlign = 'left';
  }
  function drawCalc(d, x, y, w) {
    const lines = d.lines || [], lh = H * 0.062;
    c.font = `600 ${Math.round(H * 0.036)}px ${MONO}`; c.textBaseline = 'middle';
    lines.forEach((ln, r) => {
      const last = r === lines.length - 1;
      c.fillStyle = last ? VOLT : WHITE;
      c.fillText(String(ln), x, y + lh * r + lh / 2);
    });
  }

  function draw() {
    c.fillStyle = BG; c.fillRect(0, 0, W, H);
    // header
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.fillStyle = VOLT; c.font = `800 ${Math.round(H * 0.044)}px ${MONO}`;
    c.fillText(HEADING, W * 0.035, H * 0.085);
    // badge (top-right) + optional ON AIR dot
    c.textAlign = 'right';
    if (ONAIR) {
      c.font = `800 ${Math.round(H * 0.024)}px ${MONO}`;
      const on = Math.floor(t * 1.4) % 2 === 0;
      c.fillStyle = on ? RED : 'rgba(255,85,100,.3)';
      c.fillText('● ON AIR', W * 0.965, H * 0.06);
    }
    c.fillStyle = BLUE; c.font = `700 ${Math.round(H * 0.02)}px ${MONO}`;
    c.fillText(BADGE, W * 0.965, H * 0.09);
    c.textAlign = 'left';
    c.strokeStyle = 'rgba(198,255,46,.3)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(W * 0.035, H * 0.11); c.lineTo(W * 0.965, H * 0.11); c.stroke();
    // title
    c.fillStyle = WHITE; c.font = `700 ${Math.round(H * 0.036)}px ${SANS}`;
    c.fillText(title.toUpperCase(), W * 0.035, H * 0.165);

    const L = W * 0.035, RW = W * 0.93;
    if (!scene) {
      c.fillStyle = DIM; c.font = `500 ${Math.round(H * 0.032)}px ${MONO}`;
      c.fillText(IDLE_HINT, L, H * 0.3);
    } else if (scene._idle) {
      c.fillStyle = DIM; c.font = `500 ${Math.round(H * 0.034)}px ${MONO}`;
      wrap(scene._idle, c.font, RW).forEach((ln, i) => c.fillText(ln, L, H * 0.3 + i * H * 0.05));
      // pulsing dots
      const dots = '.'.repeat(1 + (Math.floor(t * 2) % 3));
      c.fillStyle = VOLT; c.fillText(dots, L, H * 0.42);
    } else {
      // spoken caption
      c.fillStyle = WHITE; c.font = `500 ${Math.round(H * 0.04)}px ${SANS}`;
      let y = H * 0.24;
      wrap(scene.say || '', c.font, RW).forEach((ln) => { c.fillText(ln, L, y); y += H * 0.056; });
      // evidence box
      const boxY = Math.min(y + H * 0.02, H * 0.42);
      const d = scene.draw;
      if (d) {
        c.fillStyle = AMBER; c.font = `800 ${Math.round(H * 0.026)}px ${MONO}`;
        c.fillText((d.title || d.type || '').toUpperCase(), L, boxY);
        const inner = boxY + H * 0.04;
        if (d.type === 'table') drawTable(d, L, inner, RW);
        else if (d.type === 'checks') drawChecks(d, L, inner, RW);
        else if (d.type === 'flow') drawFlow(d, L, inner, RW);
        else if (d.type === 'calc') drawCalc(d, L, inner, RW);
      }
    }
    // footer: scene progress + source
    c.textBaseline = 'alphabetic';
    c.fillStyle = DIM; c.font = `600 ${Math.round(H * 0.024)}px ${MONO}`;
    const prog = total ? `scene ${idx + 1} / ${total}` : '';
    c.fillText(prog, L, H * 0.955);
    c.textAlign = 'right';
    c.fillStyle = source.startsWith('live') ? VOLT : DIM;
    c.fillText(source, W * 0.965, H * 0.955);
    c.textAlign = 'left';
    // scanlines
    c.globalAlpha = 0.12; c.fillStyle = '#000';
    for (let yy = 0; yy < H; yy += 5) c.fillRect(0, yy, W, 1);
    c.globalAlpha = 1;
  }
  draw();

  return {
    texture: tex, setTitle, setSource, idle, showScene,
    update(dt) {
      t += dt;
      const f = Math.floor(t * 3);
      if (dirty || f !== lastFrame) { lastFrame = f; draw(); dirty = false; tex.needsUpdate = true; }
    },
  };
}
