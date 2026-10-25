// ---------------------------------------------------------------------------
// cover.js — the DEFAULT face of a jumbotron: a clean "what this board is" card
// (big title + one-line purpose + a hint on how to open it), instead of a static
// slide. Each billboard rests on its cover and swaps to live content on activate.
// createCover(spec) -> { texture, update }.
// ---------------------------------------------------------------------------
import * as THREE from 'three';

const MONO = 'ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace';

export function createCover(spec = {}) {
  const W = 1024, H = 576;
  const accent = spec.accent || '#c6ff2e';
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  let t = 0, last = -1;

  function wrap(text, x, y, maxw, lh) {
    const words = String(text || '').split(' ');
    let line = '', yy = y;
    for (const w of words) {
      const test = line + w + ' ';
      if (c.measureText(test).width > maxw && line) { c.fillText(line, x, yy); line = w + ' '; yy += lh; }
      else line = test;
    }
    c.fillText(line, x, yy);
  }

  function draw() {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a121b'); g.addColorStop(1, '#05080c');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // giant index watermark
    c.textAlign = 'right'; c.fillStyle = 'rgba(198,255,46,.10)';
    c.font = `800 ${Math.round(H * 0.46)}px ${MONO}`;
    c.fillText(spec.no || '', W - 40, H - 46);
    // frame
    c.strokeStyle = 'rgba(198,255,46,.22)'; c.lineWidth = 2;
    c.strokeRect(24, 24, W - 48, H - 48);
    // top mark
    c.textAlign = 'left';
    c.fillStyle = accent; c.font = `800 ${Math.round(H * 0.033)}px ${MONO}`;
    c.fillText('PIT WALL', 48, 72);
    if (spec.badge) {
      c.fillStyle = 'rgba(255,255,255,.4)'; c.font = `700 ${Math.round(H * 0.026)}px ${MONO}`;
      c.fillText('· ' + spec.badge, 48 + c.measureText('PIT WALL').width + 14, 72);
    }
    // title
    c.fillStyle = '#eef3f7'; c.font = `800 ${Math.round(H * 0.105)}px ${MONO}`;
    c.fillText(spec.title || '', 48, H * 0.52);
    // accent underline
    c.fillStyle = accent; c.fillRect(50, H * 0.57, Math.round(H * 0.17), 5);
    // subtitle (wrapped)
    c.fillStyle = 'rgba(255,255,255,.62)'; c.font = `600 ${Math.round(H * 0.039)}px ${MONO}`;
    wrap(spec.sub || '', 48, H * 0.69, W - 130, Math.round(H * 0.052));
    // hint + pulsing dot
    const on = Math.floor(t * 1.5) % 2 === 0;
    c.fillStyle = on ? accent : 'rgba(198,255,46,.3)';
    c.beginPath(); c.arc(54, H - 58, 6, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.55)'; c.font = `700 ${Math.round(H * 0.031)}px ${MONO}`;
    c.fillText(spec.hint || '', 72, H - 51);
    // scanlines
    c.globalAlpha = 0.1; c.fillStyle = '#000';
    for (let y = 0; y < H; y += 5) c.fillRect(0, y, W, 1);
    c.globalAlpha = 1;
  }
  draw();

  return {
    texture: tex,
    update(dt) {
      t += dt;
      const f = Math.floor(t * 1.5);
      if (f !== last) { last = f; draw(); tex.needsUpdate = true; }
    },
  };
}
