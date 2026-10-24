// ---------------------------------------------------------------------------
// src/dashboard.js — the Pit Wall control-room dashboard, painted to a canvas
// and shown IN-WORLD on the stadium's big LED screens (corners + goal ends).
// createDashboard() -> { texture, update(dt) }. Swap `texture` onto the
// `big_screens` material and call update(dt) each frame. Figures are demo
// placeholders for now — feed them from live Pit Wall data later.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const BG = '#05080c';
const VOLT = '#c6ff2e';
const WHITE = '#eef3f7';
const DIM = 'rgba(255,255,255,0.42)';
const RED = '#ff5564';
const MONO = 'ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace';

export function createDashboard(W = 1024) {
  const H = Math.round(W * 0.5625);                 // 16:9, matches the screen panels
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;

  // --- demo data (wire to live Pit Wall state later) ---
  const RATIO = 68, LIMIT = 70;
  const KPIS = [
    ['CASH', '£14.2M'], ['TRANSFER PAYABLES', '£8.4M'],
    ['FFP HEADROOM', '£2.1M'], ['EVIDENCE SPEND', '$0.42'],
  ];
  const QUEUE = [
    'WI-204  INSTALLMENT · CASTLETON CITY · £1.20M · VERIFIED',
    'WI-205  ADD-ON CLAIM · FENWICK ROVERS · £0.50M · ESCALATED',
    'WI-206  BANK-DETAIL CHANGE · HELD · FRAUD CHECK',
    'WI-207  SOLIDARITY SHORTFALL · £0.08M · AUTO-BOOKED',
    'WI-208  FX GAIN/LOSS · EUR→GBP · £0.03M · POSTED',
  ];
  const TICKER = '   ' + QUEUE.join('      •      ') + '      •   ';

  let t = 0, acc = 0;

  function panel(x, y, w, h) {
    c.fillStyle = 'rgba(198,255,46,0.045)';
    c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(198,255,46,0.16)';
    c.lineWidth = Math.max(1, W * 0.0012);
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function draw() {
    const w = W, h = H;
    const px = (v) => v * w, py = (v) => v * h;
    c.fillStyle = BG; c.fillRect(0, 0, w, h);
    c.textBaseline = 'alphabetic';

    // ---- header ----
    c.textAlign = 'left';
    c.fillStyle = VOLT;
    c.font = `800 ${Math.round(h * 0.085)}px ${MONO}`;
    c.fillText('PIT WALL', px(0.035), py(0.11));
    c.fillStyle = DIM;
    c.font = `600 ${Math.round(h * 0.032)}px ${MONO}`;
    c.fillText('AUTONOMOUS TRANSFER FINANCE', px(0.037), py(0.155));
    // LIVE pulse (top-right)
    const pulse = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 4));
    c.fillStyle = `rgba(198,255,46,${pulse.toFixed(3)})`;
    c.beginPath(); c.arc(px(0.84), py(0.092), h * 0.016, 0, Math.PI * 2); c.fill();
    c.fillStyle = WHITE;
    c.textAlign = 'left';
    c.font = `700 ${Math.round(h * 0.034)}px ${MONO}`;
    c.fillText('LIVE', px(0.862), py(0.105));
    c.fillStyle = DIM;
    c.textAlign = 'right';
    c.font = `600 ${Math.round(h * 0.030)}px ${MONO}`;
    c.fillText('HARBOURSIDE FC · MATCHDAY 34', px(0.965), py(0.165));
    // divider
    c.strokeStyle = 'rgba(198,255,46,0.30)';
    c.lineWidth = Math.max(1, W * 0.0015);
    c.beginPath(); c.moveTo(px(0.035), py(0.205)); c.lineTo(px(0.965), py(0.205)); c.stroke();

    // ---- squad-cost ratio (left) ----
    panel(px(0.035), py(0.25), px(0.30), py(0.52));
    c.textAlign = 'left';
    c.fillStyle = DIM;
    c.font = `600 ${Math.round(h * 0.034)}px ${MONO}`;
    c.fillText('SQUAD-COST RATIO', px(0.06), py(0.31));
    c.fillStyle = RATIO < LIMIT ? VOLT : RED;
    c.font = `800 ${Math.round(h * 0.17)}px ${MONO}`;
    c.fillText(`${RATIO}%`, px(0.058), py(0.49));
    // bar
    const bx = px(0.06), bw = px(0.255), by = py(0.56), bh = py(0.045);
    c.fillStyle = 'rgba(255,255,255,0.10)'; c.fillRect(bx, by, bw, bh);
    c.fillStyle = VOLT; c.fillRect(bx, by, bw * (RATIO / 100), bh);
    const lx = bx + bw * (LIMIT / 100);                 // limit marker
    c.fillStyle = RED; c.fillRect(lx - 1, by - py(0.012), 2, bh + py(0.024));
    c.fillStyle = RED;
    c.font = `600 ${Math.round(h * 0.030)}px ${MONO}`;
    c.fillText(`LIMIT ${LIMIT}%`, lx - px(0.01), by + py(0.11));

    // ---- KPI grid (right 2×2) ----
    const gx = px(0.375), gy = py(0.25), gw = px(0.59), gh = py(0.52);
    for (let i = 0; i < 4; i++) {
      const col = i % 2, row = (i / 2) | 0;
      const cw = gw / 2, chh = gh / 2;
      const x = gx + col * cw, y = gy + row * chh;
      panel(x + 6, y + 6, cw - 12, chh - 12);
      c.textAlign = 'left';
      c.fillStyle = DIM;
      c.font = `600 ${Math.round(h * 0.032)}px ${MONO}`;
      c.fillText(KPIS[i][0], x + px(0.025), y + py(0.075));
      c.fillStyle = WHITE;
      c.font = `800 ${Math.round(h * 0.085)}px ${MONO}`;
      c.fillText(KPIS[i][1], x + px(0.023), y + py(0.195));
    }

    // ---- work-queue ticker (bottom) ----
    const ty = py(0.84), th = py(0.12);
    c.fillStyle = '#0a0d13'; c.fillRect(0, ty, w, th);
    c.fillStyle = VOLT; c.fillRect(0, ty, px(0.004), th);
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.font = `700 ${Math.round(h * 0.05)}px ${MONO}`;
    c.fillStyle = VOLT;
    const label = 'SYSTEM OF WORK ▸ ';
    c.fillText(label, px(0.02), ty + th / 2);
    const labelW = c.measureText(label).width;
    // scrolling queue text, clipped to the area right of the label
    c.save();
    c.beginPath(); c.rect(px(0.02) + labelW, ty, w - px(0.02) - labelW, th); c.clip();
    c.fillStyle = WHITE;
    c.font = `600 ${Math.round(h * 0.046)}px ${MONO}`;
    const span = c.measureText(TICKER).width;
    let off = (t * (w * 0.09)) % span;
    const startX = px(0.02) + labelW - off;
    c.fillText(TICKER, startX, ty + th / 2);
    c.fillText(TICKER, startX + span, ty + th / 2);  // seamless wrap
    c.restore();
    c.textBaseline = 'alphabetic';

    // ---- LED texel grid + scanline (screen feel) ----
    c.globalAlpha = 0.16; c.fillStyle = '#000';
    for (let y = 0; y < h; y += 5) c.fillRect(0, y, w, 1);
    for (let x = 0; x < w; x += 5) c.fillRect(x, 0, 1, h);
    c.globalAlpha = 0.05; c.fillStyle = VOLT;
    const sy = (t * 40) % h;
    c.fillRect(0, sy, w, 2);
    c.globalAlpha = 1;
  }

  draw();

  return {
    texture: tex,
    update(dt) {
      t += dt; acc += dt;
      if (acc < 1 / 15) return;   // ~15 fps is plenty for a stadium board
      acc = 0;
      draw();
      tex.needsUpdate = true;
    },
  };
}
