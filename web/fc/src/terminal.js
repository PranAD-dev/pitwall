// ---------------------------------------------------------------------------
// terminal.js — a live scenario terminal drawn onto a jumbotron. The agent's
// think → run_sql → propose → verdict → forecast → report trail scrolls across
// the big screen like a terminal. createTerminal() -> { texture, write, clear, update }.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const BG = '#05080c', VOLT = '#c6ff2e', WHITE = '#eef3f7', DIM = 'rgba(255,255,255,.5)',
  AMBER = '#ffcf33', BLUE = '#7fd4ff', RED = '#ff5564';
export const TCOL = { VOLT, WHITE, DIM, AMBER, BLUE, RED };
const MONO = 'ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace';

export function createTerminal(W = 1024) {
  const H = Math.round(W * 0.5625);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;

  const lines = [];
  const MAXLINES = 15, WRAP = 72;
  let t = 0, lastFrame = -1, dirty = true;

  function write(text, color) {
    String(text == null ? '' : text).split('\n').forEach((seg) => {
      while (seg.length > WRAP) { lines.push({ t: seg.slice(0, WRAP), c: color || WHITE }); seg = '  ' + seg.slice(WRAP); }
      lines.push({ t: seg, c: color || WHITE });
    });
    while (lines.length > MAXLINES) lines.shift();
    dirty = true;
  }
  function clear() { lines.length = 0; dirty = true; }

  function draw() {
    c.fillStyle = BG; c.fillRect(0, 0, W, H);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.fillStyle = VOLT; c.font = `800 ${Math.round(H * 0.052)}px ${MONO}`;
    c.fillText('PIT WALL ▸ SCENARIO TERMINAL', W * 0.04, H * 0.1);
    c.strokeStyle = 'rgba(198,255,46,.3)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(W * 0.04, H * 0.135); c.lineTo(W * 0.96, H * 0.135); c.stroke();
    c.font = `600 ${Math.round(H * 0.039)}px ${MONO}`;
    const lh = H * 0.052, y0 = H * 0.21;
    lines.forEach((ln, i) => { c.fillStyle = ln.c; c.fillText(ln.t, W * 0.04, y0 + i * lh); });
    // blinking cursor on the next free line
    if (Math.floor(t * 2) % 2) {
      c.fillStyle = VOLT;
      c.fillText('▌', W * 0.04, y0 + Math.min(lines.length, MAXLINES) * lh);
    }
    c.globalAlpha = 0.14; c.fillStyle = '#000';
    for (let y = 0; y < H; y += 5) c.fillRect(0, y, W, 1);
    for (let x = 0; x < W; x += 5) c.fillRect(x, 0, 1, H);
    c.globalAlpha = 1;
  }
  draw();

  return {
    texture: tex, write, clear,
    update(dt) {
      t += dt;
      const f = Math.floor(t * 3);
      if (dirty || f !== lastFrame) { lastFrame = f; draw(); dirty = false; tex.needsUpdate = true; }
    },
  };
}
