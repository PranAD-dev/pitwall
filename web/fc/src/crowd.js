import * as THREE from 'three';
import { STANDS, TIERS, forEachSeat, TEAMS, makeCanvasTexture, clamp, lerp, damp } from './util.js';

// ---------------------------------------------------------------------------
// crowd.js — the populated bowl: seat shells, terrace architecture and an
// instanced, animated crowd (~25k fans) in a handful of draw calls.
//
//  1. SEAT SHELLS. Every kept seat position carries a real 10-triangle seat
//     (reclined back panel + pan) in the club palette, blocked per section and
//     carrying a lettered mosaic in the upper tier. Empty seats (a few percent)
//     are tipped up. This is what removes the bare concrete that used to show
//     under every row and turn the terrace into a car-park ramp.
//  2. ARCHITECTURE. Stairways get real half-rise steps with a lit nosing;
//     vomitory mouths are blacked out and lit from inside by a warm concourse
//     glow instead of reading as lighter concrete than their surroundings.
//  3. FANS. One InstancedMesh sampling a 64-cell procedural atlas (32 paired
//     identities × seated/standing). Every silhouette is drawn with a dark
//     outline pass first, so mip bleed can only ever produce a dark rim — the
//     old 1px white premultiply halo is structurally impossible now. Alpha to
//     coverage against the 4x MSAA composer target resolves the edges.
//  4. ORIENTATION. Fans do NOT face the camera: each carries its own facing
//     yaw (toward the pitch, jittered), blended only partially toward the lens,
//     so a stand seen at 40° shows shoulders and profiles. Per-instance torso
//     lean, scale, mirror, row-height jitter and hue jitter break the lattice.
//  5. GRADE. The crowd is keyed well under the pitch and pushed toward dark
//     neutrals; only club colour and a sparse scatter of hi-vis stewards and
//     lit "glints" punch through. That darkness is what makes the pitch glow.
// ---------------------------------------------------------------------------

const COLS = 8;
const ROWS = 6;           // rows 0-2 seated, rows 3-5 the same identities standing
const NVAR = 24;          // paired identities: seated cell + standing cell
const QUAD_W = 1.08;      // world meters spanned by one atlas cell horizontally
const QUAD_H = 2.22;      // and vertically (arms-up headroom included)
const INSET = 0.95;       // sampled central window of each cell (bleed guard)
const FOOT_DROP = 0.05;   // fan feet sit this far below the seat anchor y

const OUTLINE = '#07080b';

// ---------------------------------------------------------------------------
// Small color helpers (canvas-side, plain sRGB strings)
// ---------------------------------------------------------------------------
function shadeHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(Math.round(((n >> 16) & 255) * k), 0, 255);
  const g = clamp(Math.round(((n >> 8) & 255) * k), 0, 255);
  const b = clamp(Math.round((n & 255) * k), 0, 255);
  return `rgb(${r},${g},${b})`;
}

function pick(rng, arr) { return arr[Math.min(arr.length - 1, (rng() * arr.length) | 0)]; }

const STAND_POSES = ['V', 'oneUp', 'wave', 'fists', 'clapHigh', 'point', 'headHold', 'scarfUp'];
const SEAT_POSES = ['lap', 'crossed', 'clap', 'lean', 'phone', 'scarfHold'];

// ---------------------------------------------------------------------------
// Fan identities. Generated once and shared by every atlas pass so the colour
// atlas, the dark outline underlay and the tint mask are pixel-identical.
// ---------------------------------------------------------------------------
function makeVariants(rng) {
  // Night skin values: a face under floodlight spill is a mid-tone, never a
  // highlight. These are keyed well down so the terrace does not read as a
  // field of glowing eggs.
  const skins = [
    ['#a4805f', '#7d5c3f'], ['#9c7853', '#745331'], ['#8e6b46', '#66492b'],
    ['#7d5b39', '#584022'], ['#6a4b2e', '#4a3420'], ['#553920', '#3a2716'],
    ['#3f2b1a', '#2b1d11'], ['#ad8a68', '#856345'],
  ];
  const hairs = ['#100e08', '#171208', '#2a1d0c', '#3f2d1b', '#5e4c30', '#8a8072', '#42454a', '#6b6e73'];
  const pantsCols = ['#14161a', '#1c1e23', '#26304a', '#1a2740', '#2c2f35', '#211c19', '#0f1114'];
  const jacketCols = ['#1f2228', '#282b31', '#2c3038', '#241f1c', '#1b2330', '#26262c', '#2a2f36', '#31353c'];

  const variants = [];
  for (let i = 0; i < NVAR; i++) {
    const skin = pick(rng, skins);
    const hr = rng();
    // Over half the bowl wears something on its head at a night match — that
    // headwear is what stops the crowd reading as a lattice of pale ovals.
    const hairStyle = hr < 0.24 ? 'short' : hr < 0.46 ? 'beanie' : hr < 0.52 ? 'bald'
      : hr < 0.62 ? 'long' : hr < 0.82 ? 'hood' : 'cap';
    const jacket = hairStyle === 'hood' ? true : rng() < 0.46;
    const scarf = rng() < 0.26;
    // Poses are dealt round-robin so all eight arm sets appear equally often
    // and the arms-up "V" can never dominate a block.
    let standArms = STAND_POSES[(i + ((rng() * 3) | 0)) % STAND_POSES.length];
    if (standArms === 'scarfUp' && !scarf) standArms = 'clapHigh';
    variants.push({
      skin,
      skinDk: shadeHex(skin[1], 0.74),
      hair: pick(rng, hairs),
      hairStyle,
      jacket,
      jacketCol: pick(rng, jacketCols),
      pantsCol: pick(rng, pantsCols),
      build: 0.90 + rng() * 0.22,
      heightMul: 0.955 + rng() * 0.09,
      headR: 0.099 + rng() * 0.014,
      lean: rng() * 2 - 1,
      scarf,
      seatArms: SEAT_POSES[(i + ((rng() * 5) | 0)) % SEAT_POSES.length],
      standArms,
      armSpread: 0.36 + rng() * 0.12,
      phone: rng() < 0.14,
    });
  }
  return variants;
}

// ---------------------------------------------------------------------------
// Atlas painter.
//   mode 'outline' : every shape filled AND stroked in near-black — laid down
//                    first so the outermost texels of each silhouette are dark.
//                    Kills bright mip/mask fringing and separates neighbours.
//   mode 'color'   : the real thing.
//   mode 'mask'    : white where the per-instance tint applies, dilated by a
//                    stroke so the mask can never undershoot the colour.
// All coordinates are WORLD METERS, origin at the bottom-centre of the cell's
// sampled window, y-up.
// ---------------------------------------------------------------------------
function paintAtlas(c, w, h, mode, variants) {
  const cw = w / COLS, chH = h / ROWS;
  const lw = 3.2 * (w / 2048);
  if (mode === 'mask') { c.fillStyle = '#000'; c.fillRect(0, 0, w, h); }
  c.lineJoin = 'round';
  c.lineCap = 'round';

  for (let v = 0; v < variants.length; v++) {
    const col = v % COLS;
    const sr = (v / COLS) | 0;                 // 0..2 seated rows
    if (mode === 'color') {
      drawFan(c, col * cw, sr * chH, cw, chH, variants[v], false, 'outline', lw);
      drawFan(c, col * cw, (sr + 3) * chH, cw, chH, variants[v], true, 'outline', lw);
    }
    drawFan(c, col * cw, sr * chH, cw, chH, variants[v], false, mode, lw);
    drawFan(c, col * cw, (sr + 3) * chH, cw, chH, variants[v], true, mode, lw);
  }
}

function drawFan(c, x0, y0, cw, chH, p, standing, mode, lw) {
  const isMask = mode === 'mask';
  const isOut = mode === 'outline';
  const H = p.heightMul;

  const px = (mx) => x0 + cw * (0.5 + INSET * mx / QUAD_W);
  const py = (my) => y0 + chH * ((1 + INSET) / 2 - INSET * my / QUAD_H);
  const RX = (m) => cw * INSET * m / QUAD_W;
  const RY = (m) => chH * INSET * m / QUAD_H;

  // shape(tinted, style, pathFn) — the only drawing primitive.
  const shape = (tinted, style, path) => {
    if (isMask && !tinted) { c.fillStyle = '#000'; c.beginPath(); path(); c.fill(); return; }
    c.beginPath(); path();
    if (isOut) {
      c.fillStyle = OUTLINE; c.strokeStyle = OUTLINE; c.lineWidth = lw;
      c.stroke(); c.fill();
    } else if (isMask) {
      c.fillStyle = '#fff'; c.strokeStyle = '#fff'; c.lineWidth = lw * 1.45;
      c.stroke(); c.fill();
    } else {
      c.fillStyle = style; c.fill();
    }
  };
  const gloss = (fn) => { if (mode === 'color') fn(); };

  // --- path primitives, all in meters -------------------------------------
  const ell = (mx, my, mrx, mry) => {
    c.moveTo(px(mx) + RX(mrx), py(my));
    c.ellipse(px(mx), py(my), RX(mrx), RY(mry), 0, 0, Math.PI * 2);
  };
  const rr = (mx, myBot, mw, mh, mr) => {
    const X = px(mx) - RX(mw) / 2, Y = py(myBot + mh);
    const W = RX(mw), Hh = RY(mh);
    const rx = Math.min(RX(mr), W / 2), ry = Math.min(RY(mr), Hh / 2);
    c.moveTo(X + rx, Y);
    c.lineTo(X + W - rx, Y); c.quadraticCurveTo(X + W, Y, X + W, Y + ry);
    c.lineTo(X + W, Y + Hh - ry); c.quadraticCurveTo(X + W, Y + Hh, X + W - rx, Y + Hh);
    c.lineTo(X + rx, Y + Hh); c.quadraticCurveTo(X, Y + Hh, X, Y + Hh - ry);
    c.lineTo(X, Y + ry); c.quadraticCurveTo(X, Y, X + rx, Y);
    c.closePath();
  };
  // capsule between two points, thickness in meters (anisotropy-correct)
  const cap = (x1, y1, x2, y2, tw) => {
    const dx = x2 - x1, dy = y2 - y1;
    const L = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / L * tw * 0.5, ny = dx / L * tw * 0.5;
    c.moveTo(px(x1 + nx), py(y1 + ny));
    c.lineTo(px(x2 + nx), py(y2 + ny));
    c.lineTo(px(x2 - nx), py(y2 - ny));
    c.lineTo(px(x1 - nx), py(y1 - ny));
    c.closePath();
    ell(x1, y1, tw * 0.5, tw * 0.5);
    ell(x2, y2, tw * 0.5, tw * 0.5);
  };
  // tapered torso polygon: hips → shoulders
  const trunk = (cx, yBot, yTop, wBot, wTop, tilt) => {
    const xb = cx, xt = cx + tilt;
    c.moveTo(px(xb - wBot / 2), py(yBot));
    c.lineTo(px(xb + wBot / 2), py(yBot));
    c.lineTo(px(xt + wTop / 2), py(yTop - 0.03));
    c.quadraticCurveTo(px(xt + wTop / 2), py(yTop), px(xt + wTop / 2 - 0.05), py(yTop));
    c.lineTo(px(xt - wTop / 2 + 0.05), py(yTop));
    c.quadraticCurveTo(px(xt - wTop / 2), py(yTop), px(xt - wTop / 2), py(yTop - 0.03));
    c.closePath();
  };
  const vGrad = (myTop, myBot, c1, c2) => {
    const g = c.createLinearGradient(0, py(myTop), 0, py(myBot));
    g.addColorStop(0, c1); g.addColorStop(1, c2); return g;
  };

  // --- palette -------------------------------------------------------------
  const bw = p.build;
  const tinted = !p.jacket;
  // Tintable fabric is painted as a MID-grey ramp, never near-white: the shirt
  // colour lands well below paper-white once the per-instance tint multiplies
  // in, which is what stops the stand becoming a wall of candy apple.
  const topLight = tinted ? '#cfd3d9' : shadeHex(p.jacketCol, 1.5);
  const topDark = tinted ? '#5d626a' : shadeHex(p.jacketCol, 0.55);
  const sleeveL = tinted ? '#b7bcc4' : shadeHex(p.jacketCol, 1.22);
  const sleeveD = tinted ? '#6d727a' : shadeHex(p.jacketCol, 0.66);
  const pantsG = vGrad(0.9 * H, 0.0, shadeHex(p.pantsCol, 1.3), shadeHex(p.pantsCol, 0.55));

  const drawHead = (hx, hy) => {
    const r = p.headR;
    shape(false, p.skinDk, () => cap(hx - 0.012, hy - r - 0.10, hx, hy - r * 0.55, 0.085));
    let g = p.skin[1];
    if (mode === 'color') {
      g = c.createRadialGradient(px(hx - r * 0.18), py(hy + r * 0.42), RX(r) * 0.12,
        px(hx), py(hy - r * 0.3), RX(r) * 1.7);
      g.addColorStop(0, p.skin[0]); g.addColorStop(1, p.skinDk);
    }
    shape(false, g, () => ell(hx, hy, r * 0.86, r));
    if (p.hairStyle === 'short') {
      shape(false, p.hair, () => {
        c.moveTo(px(hx - r * 0.88), py(hy + r * 0.08));
        c.quadraticCurveTo(px(hx), py(hy + r * 1.32), px(hx + r * 0.88), py(hy + r * 0.08));
        c.quadraticCurveTo(px(hx + r * 0.7), py(hy + r * 0.42), px(hx), py(hy + r * 0.44));
        c.quadraticCurveTo(px(hx - r * 0.7), py(hy + r * 0.42), px(hx - r * 0.88), py(hy + r * 0.08));
        c.closePath();
      });
    } else if (p.hairStyle === 'long') {
      shape(false, shadeHex(p.hair, 0.82), () => rr(hx, hy - r * 1.5, r * 1.9, r * 2.0, r * 0.5));
      shape(false, p.hair, () => ell(hx, hy + r * 0.34, r * 0.96, r * 0.78));
    } else if (p.hairStyle === 'beanie') {
      shape(true, '#dfe2e6', () => {
        c.moveTo(px(hx - r * 0.9), py(hy + r * 0.05));
        c.quadraticCurveTo(px(hx), py(hy + r * 1.5), px(hx + r * 0.9), py(hy + r * 0.05));
        c.closePath();
      });
      shape(true, '#b9bec6', () => rr(hx, hy - r * 0.02, r * 1.85, 0.036, 0.012));
    } else if (p.hairStyle === 'cap') {
      shape(true, '#b9bec6', () => {
        c.moveTo(px(hx - r * 0.86), py(hy + r * 0.16));
        c.quadraticCurveTo(px(hx), py(hy + r * 1.36), px(hx + r * 0.86), py(hy + r * 0.16));
        c.closePath();
      });
      shape(false, '#3a3d43', () => rr(hx - r * 0.85, hy + r * 0.10, r * 1.1, 0.03, 0.012));
    } else if (p.hairStyle === 'hood') {
      shape(false, shadeHex(p.jacketCol, 1.28), () => ell(hx, hy + r * 0.18, r * 1.28, r * 1.14));
      shape(false, '#0a0b0e', () => ell(hx, hy - r * 0.08, r * 0.66, r * 0.66));
      shape(false, p.skinDk, () => ell(hx, hy - r * 0.1, r * 0.5, r * 0.5));
    }
    // eye shadow — at 40 px a head this is the difference between a face and
    // an egg, and it kills the "floating pale ovals" read at broadcast range
    gloss(() => {
      c.fillStyle = 'rgba(20,14,10,0.42)';
      c.beginPath(); ell(hx, hy - r * 0.1, r * 0.62, r * 0.19); c.fill();
      c.fillStyle = 'rgba(18,12,8,0.30)';
      c.beginPath(); ell(hx, hy - r * 0.62, r * 0.72, r * 0.30); c.fill();
    });
    // faint floodlight kiss on the crown
    gloss(() => {
      c.fillStyle = 'rgba(255,246,232,0.13)';
      c.beginPath(); ell(hx - r * 0.15, hy + r * 0.62, r * 0.40, r * 0.15); c.fill();
    });
  };

  const scarfBand = (mx, my, mw, mh, ang) => {
    shape(true, '#e6e8ec', () => {
      c.save();
      c.translate(px(mx), py(my));
      c.rotate(ang || 0);
      c.translate(-px(mx), -py(my));
      rr(mx, my, mw, mh, mh * 0.35);
      c.restore();
    });
    gloss(() => {
      c.save();
      c.translate(px(mx), py(my)); c.rotate(ang || 0); c.translate(-px(mx), -py(my));
      c.fillStyle = 'rgba(12,13,18,0.5)';
      const n = 5;
      for (let i = 0; i < n; i++) {
        const sx = mx - mw / 2 + (i + 0.3) * (mw / n);
        c.fillRect(px(sx), py(my + mh), RX(mw / n * 0.42), RY(mh));
      }
      c.restore();
    });
  };

  // --- arm helper: shoulder → elbow → hand --------------------------------
  const arm = (sx, sy, ex, ey, hx, hy, w) => {
    shape(tinted, sleeveL, () => cap(sx, sy, ex, ey, w));
    shape(tinted, sleeveD, () => cap(ex, ey, hx, hy, w * 0.86));
    shape(false, p.skinDk, () => ell(hx, hy, 0.046, 0.05));
  };

  if (!standing) {
    // ======================= SEATED =======================================
    const hipY = 0.50 * H, shY = 1.06 * H, headY = 1.255 * H;
    const kneeY = 0.47 * H, ankY = 0.08 * H;
    const shW = 0.215 * bw, hipW = 0.15 * bw;
    const tilt = p.seatArms === 'lean' ? 0.055 : p.lean * 0.022;

    // shins + shoes
    shape(false, pantsG, () => { cap(-0.115, kneeY, -0.12, ankY, 0.145); cap(0.115, kneeY, 0.12, ankY, 0.145); });
    shape(false, '#0e0f12', () => { rr(-0.125, 0.0, 0.19, 0.075, 0.03); rr(0.125, 0.0, 0.19, 0.075, 0.03); });
    // thighs (foreshortened from the front): knee up to hip
    shape(false, pantsG, () => { cap(-0.115, kneeY, -0.085, hipY, 0.175); cap(0.115, kneeY, 0.085, hipY, 0.175); });
    // torso
    shape(tinted, vGrad(shY, hipY - 0.04, topLight, topDark),
      () => trunk(0, hipY - 0.03, shY, hipW * 2, shW * 2, tilt));
    // arms
    const asx = shW * 0.94, asy = shY - 0.05;
    if (p.seatArms === 'crossed') {
      arm(-asx, asy, -shW * 1.12, shY - 0.26, 0.09, shY - 0.28, 0.105 * bw);
      arm(asx, asy, shW * 1.12, shY - 0.22, -0.09, shY - 0.24, 0.105 * bw);
    } else if (p.seatArms === 'clap') {
      arm(-asx, asy, -shW * 1.2, shY - 0.24, -0.035, shY - 0.14, 0.1 * bw);
      arm(asx, asy, shW * 1.2, shY - 0.24, 0.035, shY - 0.14, 0.1 * bw);
    } else if (p.seatArms === 'phone') {
      arm(-asx, asy, -shW * 1.25, shY - 0.2, -0.1, shY + 0.06, 0.1 * bw);
      arm(asx, asy, shW * 1.2, shY - 0.3, 0.16, hipY + 0.12, 0.1 * bw);
    } else if (p.seatArms === 'scarfHold') {
      arm(-asx, asy, -shW * 1.3, shY - 0.2, -0.19, shY - 0.06, 0.1 * bw);
      arm(asx, asy, shW * 1.3, shY - 0.2, 0.19, shY - 0.04, 0.1 * bw);
      scarfBand(0, shY - 0.11, 0.42, 0.08, 0);
    } else { // lap / lean
      const hy = p.seatArms === 'lean' ? kneeY + 0.09 : hipY + 0.14;
      arm(-asx, asy, -shW * 1.28, (asy + hy) * 0.5, -0.14, hy, 0.105 * bw);
      arm(asx, asy, shW * 1.28, (asy + hy) * 0.5, 0.14, hy, 0.105 * bw);
    }
    if (p.scarf && p.seatArms !== 'scarfHold') {
      scarfBand(tilt * 0.6, shY - 0.17, shW * 1.85, 0.075, 0);
    }
    drawHead(tilt * 1.6, headY);
    if (p.phone && p.seatArms === 'phone') {
      gloss(() => {
        c.fillStyle = 'rgba(190,220,255,0.5)';
        c.beginPath(); ell(-0.1, shY + 0.08, 0.05, 0.05); c.fill();
        c.fillStyle = '#eaf3ff';
        c.beginPath(); rr(-0.1, shY + 0.05, 0.035, 0.055, 0.008); c.fill();
      });
    }
    gloss(() => {
      c.fillStyle = 'rgba(255,244,226,0.16)';
      c.beginPath(); ell(tilt, shY - 0.03, shW * 0.95, 0.022); c.fill();
    });
  } else {
    // ================== STANDING / CELEBRATING ============================
    const hipY = 0.94 * H, shY = 1.44 * H, headY = 1.645 * H;
    const kneeY = 0.50 * H, ankY = 0.09 * H;
    const shW = 0.215 * bw, hipW = 0.155 * bw;
    const tilt = p.lean * 0.035;

    shape(false, pantsG, () => {
      cap(-0.085, hipY, -0.10, kneeY, 0.165); cap(-0.10, kneeY, -0.105, ankY, 0.135);
      cap(0.085, hipY, 0.10, kneeY, 0.165); cap(0.10, kneeY, 0.105, ankY, 0.135);
    });
    shape(false, '#0e0f12', () => { rr(-0.11, 0.0, 0.185, 0.08, 0.03); rr(0.11, 0.0, 0.185, 0.08, 0.03); });
    shape(tinted, vGrad(shY, hipY - 0.06, topLight, topDark),
      () => trunk(0, hipY - 0.05, shY, hipW * 2, shW * 2, tilt));

    const sp = p.armSpread;
    const asx = shW * 0.95, asy = shY - 0.04;
    const w = 0.105 * bw;
    let L, R;
    switch (p.standArms) {
      case 'V':
        L = [-sp * 0.78, shY + 0.20, -sp, shY + 0.50];
        R = [sp * 0.78, shY + 0.22, sp, shY + 0.52]; break;
      case 'oneUp':
        L = [-sp * 0.74, shY + 0.16, -sp * 0.86, shY + 0.48];
        R = [shW * 1.35, shY - 0.26, 0.18, shY - 0.5]; break;
      case 'wave':
        L = [-sp * 0.88, shY - 0.06, -sp * 0.72, shY + 0.24];
        R = [sp * 0.88, shY - 0.04, sp * 0.7, shY + 0.27]; break;
      case 'fists':
        L = [-shW * 1.6, shY - 0.24, -0.13, shY - 0.06];
        R = [shW * 1.6, shY - 0.22, 0.13, shY - 0.03]; break;
      case 'clapHigh':
        L = [-shW * 1.5, shY + 0.12, -0.045, shY + 0.42];
        R = [shW * 1.5, shY + 0.12, 0.045, shY + 0.42]; break;
      case 'point':
        L = [-shW * 1.4, shY - 0.26, -0.17, shY - 0.44];
        R = [sp * 0.72, shY + 0.02, sp * 0.95, shY + 0.22]; break;
      case 'headHold':
        L = [-shW * 1.75, shY + 0.04, -0.115, shY + 0.26];
        R = [shW * 1.75, shY + 0.04, 0.115, shY + 0.27]; break;
      default: // scarfUp
        L = [-sp * 0.7, shY + 0.18, -sp * 0.82, shY + 0.46];
        R = [sp * 0.7, shY + 0.18, sp * 0.82, shY + 0.47]; break;
    }
    arm(-asx, asy, L[0], L[1], L[2], L[3], w);
    arm(asx, asy, R[0], R[1], R[2], R[3], w);

    if (p.standArms === 'scarfUp') {
      scarfBand((L[2] + R[2]) * 0.5, (L[3] + R[3]) * 0.5 - 0.04, Math.abs(R[2] - L[2]) + 0.06, 0.085, 0);
    } else if (p.scarf) {
      scarfBand(tilt * 0.6, shY - 0.2, shW * 1.9, 0.08, 0);
    }
    drawHead(tilt * 1.5, headY);
    if (p.phone) {
      gloss(() => {
        c.fillStyle = 'rgba(190,220,255,0.5)';
        c.beginPath(); ell(L[2], L[3] + 0.03, 0.055, 0.055); c.fill();
        c.fillStyle = '#eaf3ff';
        c.beginPath(); rr(L[2], L[3], 0.04, 0.06, 0.008); c.fill();
      });
    }
    gloss(() => {
      c.fillStyle = 'rgba(255,244,226,0.18)';
      c.beginPath(); ell(tilt, shY - 0.02, shW * 0.95, 0.024); c.fill();
    });
  }
}

// ---------------------------------------------------------------------------
// Fan shaders
// ---------------------------------------------------------------------------
const FAN_VERT = /* glsl */ `
  attribute vec4 aTint;   // rgb = tint (linear), a = whole-sprite shade
  attribute vec4 aAnim;   // x phase, y freq mul, z stand-up threshold, w jump amp
  attribute vec4 aCell;   // xy seated cell UV offset, zw standing cell UV offset
  attribute vec4 aSize;   // x width (sign = mirror), y height, z lean, w billboard blend
  attribute vec2 aFace;   // cos/sin of the fan's own facing yaw in XZ

  uniform float uTime;
  uniform float uExcite;
  uniform vec2 uCellSize;

  varying vec2 vUv;
  varying vec4 vTint;

  #include <common>
  #include <fog_pars_vertex>

  void main() {
    vec3 seat = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

    vec3 toCam = cameraPosition - seat;
    float fl = max(length(toCam.xz), 1e-3);
    vec2 camDir = toCam.xz / fl;

    // The fan faces the pitch, NOT the lens. We rotate only part of the way
    // toward the camera so profiles and three-quarter views survive; far fans
    // blend most of the way so the distant bowl never goes edge-on.
    float a0 = atan(aFace.y, aFace.x);
    float a1 = atan(camDir.y, camDir.x);
    float d = a1 - a0;
    d = mod(d + PI, 2.0 * PI) - PI;
    float distBlend = clamp((fl - 42.0) / 55.0, 0.0, 1.0);
    float a = a0 + d * mix(aSize.w, 0.94, distBlend);
    vec2 f = vec2(cos(a), sin(a));
    vec3 right = vec3(f.y, 0.0, -f.x);

    float phase = aAnim.x;
    float freq  = aAnim.y;

    float murmur = 0.55 + 0.45 * sin(uTime * 0.31 + seat.x * 0.045 + seat.z * 0.06 + phase * 0.5);
    float idle = murmur * (1.0 + uExcite * 1.6);

    float stand = smoothstep(aAnim.z - 0.07, aAnim.z + 0.07, uExcite);

    float bob  = 0.030 * idle * sin(uTime * (1.7 * freq) + phase);
    float sway = 0.035 * idle * sin(uTime * (1.15 * freq) + phase * 1.71);

    float jw = 5.8 * freq;
    float jump = 0.40 * aAnim.w * stand * smoothstep(0.15, 1.0, uExcite)
               * pow(max(sin(uTime * jw + phase * 2.9), 0.0), 0.7);

    float w = abs(aSize.x);
    float h = aSize.y * (1.0 + 0.03 * stand);
    float lean = aSize.z + 0.012 * idle * sin(uTime * (0.9 * freq) + phase * 2.3);

    vec3 wp = seat
      + right * (position.x * w + lean * position.y * h + sway)
      + vec3(0.0, position.y * h + bob + jump, 0.0);

    float mir = 0.5 - 0.5 * sign(aSize.x);
    vec2 luv = uv;
    luv.x = mix(luv.x, 1.0 - luv.x, mir);
    luv = (luv - 0.5) * ${INSET} + 0.5;
    vec2 cellOff = mix(aCell.xy, aCell.zw, step(0.5, stand));
    vUv = cellOff + luv * uCellSize;

    vTint = aTint;

    vec4 mvPosition = modelViewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FAN_FRAG = /* glsl */ `
  uniform sampler2D uAtlas;
  uniform sampler2D uMask;

  varying vec2 vUv;
  varying vec4 vTint;

  #include <common>
  #include <fog_pars_fragment>

  void main() {
    vec4 tex = texture2D(uAtlas, vUv);
    // Alpha-to-coverage: hand the MSAA target a real coverage ramp instead of
    // a hard discard, so silhouettes resolve and stop crawling in motion.
    float a = smoothstep(0.26, 0.62, tex.a);
    if (a < 0.004) discard;

    float m = texture2D(uMask, vUv).r;
    vec3 col = tex.rgb * mix(vec3(1.0), vTint.rgb, m) * vTint.a;

    gl_FragColor = vec4(col, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// ---------------------------------------------------------------------------
// Seat shell shaders — 10 triangles per seat, one draw call for the bowl.
// ---------------------------------------------------------------------------
const SEAT_VERT = /* glsl */ `
  attribute vec4 aSeat;   // rgb seat colour (linear), a = baked light level
  attribute float aTip;   // 1 = empty seat, pan folded up
  attribute float aPart;  // 0 = back panel, 1 = pan

  varying vec3 vCol;

  #include <common>
  #include <fog_pars_vertex>

  void main() {
    vec3 p = position;
    vec3 n = normal;
    if (aPart > 0.5 && aTip > 0.5) {
      float A = -1.28;
      float ca = cos(A), sa = sin(A);
      vec3 q = p - vec3(0.0, 0.415, -0.10);
      p = vec3(q.x, q.y * ca - q.z * sa, q.y * sa + q.z * ca) + vec3(0.0, 0.415, -0.10);
      n = vec3(n.x, n.y * ca - n.z * sa, n.y * sa + n.z * ca);
    }
    // Cheap baked key: sky/roof from above plus a pitch-side bounce. Normals
    // stay in seat-local space, which is all we need (yaw only).
    float lam = 0.16 + 0.50 * max(n.y, 0.0) + 0.44 * max(n.z, 0.0)
              + 0.10 * max(-n.z, 0.0);
    vCol = aSeat.rgb * aSeat.a * lam;

    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SEAT_FRAG = /* glsl */ `
  varying vec3 vCol;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(vCol, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// ---------------------------------------------------------------------------
// Seat geometry: reclined back panel (slight V in plan) + pan. +Z faces pitch.
// ---------------------------------------------------------------------------
function makeSeatGeometry() {
  const pos = [], nor = [], part = [], idx = [];
  let base = 0;
  const quad = (a, b, c, d, n, pt) => {
    for (const v of [a, b, c, d]) { pos.push(v[0], v[1], v[2]); nor.push(n[0], n[1], n[2]); part.push(pt); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  };

  const hw = 0.235;          // half width
  const bulge = 0.035;       // centre of the back panel bows toward the pitch
  const yB = 0.435, yT = 0.90;
  const zBot = -0.085, zTop = -0.175;   // reclined

  // back panel, two halves so it reads as a shell not a card
  quad([-hw, yB, zBot], [0, yB, zBot + bulge], [0, yT, zTop + bulge], [-hw, yT, zTop],
    [-0.26, 0.16, 0.95], 0);
  quad([0, yB, zBot + bulge], [hw, yB, zBot], [hw, yT, zTop], [0, yT, zTop + bulge],
    [0.26, 0.16, 0.95], 0);
  // back of the shell (seen by the row behind) — darker via normal
  quad([hw, yB, zBot - 0.012], [-hw, yB, zBot - 0.012], [-hw, yT, zTop - 0.012], [hw, yT, zTop - 0.012],
    [0, 0.1, -1], 0);
  // seat pan
  const pw = 0.215;
  quad([-pw, 0.425, -0.10], [pw, 0.425, -0.10], [pw, 0.455, 0.215], [-pw, 0.455, 0.215],
    [0, 0.96, -0.28], 1);
  // pan front edge
  quad([-pw, 0.455, 0.215], [pw, 0.455, 0.215], [pw, 0.375, 0.20], [-pw, 0.375, 0.20],
    [0, 0.1, 0.99], 1);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

// ---------------------------------------------------------------------------
// LOW-POLY 3D SPECTATORS — the front rows of every stand.
// ~140 triangles each, one instanced draw call, posed entirely in the vertex
// shader from a handful of joint angles. Billboards cannot survive at 15 m;
// these carry real volume, real yaw toward the pitch and real self-shading.
// ---------------------------------------------------------------------------
// part ids: 0 torso, 1 head+neck, 2 headwear, 3 upperArmL, 4 foreArmL,
//           5 upperArmR, 6 foreArmR, 7 thighL, 8 shinL+footL, 9 thighR, 10 shinR+footR
const HIP_Y = 0.91, KNEE_Y = 0.47, SHOULDER_Y = 1.41, ELBOW_Y = 1.14, ARM_X = 0.205;

function makeSpectatorGeometry() {
  const pos = [], nor = [], part = [], idx = [];
  let base = 0;
  const box = (cx, cy, cz, sx, sy, sz, pt, topS = 1, botS = 1) => {
    const hy = sy / 2;
    const bx = sx / 2 * botS, bz = sz / 2 * botS;
    const tx = sx / 2 * topS, tz = sz / 2 * topS;
    const v = [
      [cx - bx, cy - hy, cz - bz], [cx + bx, cy - hy, cz - bz],
      [cx + bx, cy - hy, cz + bz], [cx - bx, cy - hy, cz + bz],
      [cx - tx, cy + hy, cz - tz], [cx + tx, cy + hy, cz - tz],
      [cx + tx, cy + hy, cz + tz], [cx - tx, cy + hy, cz + tz],
    ];
    const faces = [
      [3, 2, 6, 7, [0, 0.12, 0.99]], [1, 0, 4, 5, [0, 0.12, -0.99]],
      [2, 1, 5, 6, [0.99, 0.12, 0]], [0, 3, 7, 4, [-0.99, 0.12, 0]],
      [7, 6, 5, 4, [0, 1, 0]], [0, 1, 2, 3, [0, -1, 0]],
    ];
    for (const f of faces) {
      for (let i = 0; i < 4; i++) {
        const p = v[f[i]];
        pos.push(p[0], p[1], p[2]); nor.push(f[4][0], f[4][1], f[4][2]); part.push(pt);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
  };

  box(0, 1.17, 0.005, 0.40, 0.58, 0.235, 0, 1.06, 0.80);   // torso
  box(0, 1.47, 0, 0.10, 0.09, 0.10, 1);                    // neck
  box(0, 1.615, 0.005, 0.158, 0.205, 0.175, 1);            // head
  box(0, 1.715, 0.002, 0.172, 0.075, 0.19, 2);             // hair / cap crown
  for (let s = 0; s < 2; s++) {
    const sx = s === 0 ? -1 : 1;
    const up = s === 0 ? 3 : 5, fo = s === 0 ? 4 : 6;
    const th = s === 0 ? 7 : 9, sh = s === 0 ? 8 : 10;
    box(sx * ARM_X, 1.275, 0, 0.105, 0.30, 0.115, up);
    box(sx * ARM_X, 1.015, 0.008, 0.09, 0.29, 0.10, fo);
    box(sx * 0.098, 0.69, 0, 0.16, 0.46, 0.175, th);
    box(sx * 0.098, 0.27, 0.005, 0.128, 0.42, 0.15, sh);
    box(sx * 0.098, 0.045, 0.075, 0.115, 0.09, 0.245, sh);  // foot
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

const SPEC_VERT = /* glsl */ `
  attribute float aPart;
  attribute vec4 aShirt;   // rgb shirt (linear), a = baked light level
  attribute vec4 aSkin;    // rgb skin, a = hair darkness mix
  attribute vec4 aPants;   // rgb trousers, a = 1 if headwear takes the shirt colour
  attribute vec4 aArmA;    // seated:  gL, eL, gR, eR   (spread, elbow bend)
  attribute vec4 aArmB;    // standing:gL, eL, gR, eR
  attribute vec4 aArmF;    // forward: fL_seat, fR_seat, fL_stand, fR_stand
  attribute vec4 aState;   // x stand threshold, y phase, z freq, w lean

  uniform float uTime;
  uniform float uExcite;

  varying vec3 vCol;

  #include <common>
  #include <fog_pars_vertex>

  vec3 rx(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c); }
  vec3 rz(vec3 v, float a) { float c = cos(a), s = sin(a); return vec3(v.x * c - v.y * s, v.x * s + v.y * c, v.z); }

  void main() {
    float stand = smoothstep(aState.x - 0.07, aState.x + 0.07, uExcite);
    float st = 1.0 - stand;                    // 1 = seated
    float ph = aState.y, fq = aState.z;

    vec3 HIP = vec3(0.0, ${HIP_Y}, 0.0);
    vec3 KNEE = vec3(0.0, ${KNEE_Y}, 0.0);
    vec3 pelv = vec3(0.0, -0.45 * st, -0.05 * st);

    float A = -1.55 * st;
    float B =  1.55 * st;

    vec3 p = position;
    vec3 n = normal;
    float pt = aPart;

    if (pt > 6.5) {
      // legs
      if (pt == 8.0 || pt == 10.0) {
        p = rx(p - KNEE, B) + KNEE;
        n = rx(n, B);
      }
      p = rx(p - HIP, A) + HIP + pelv;
      n = rx(n, A);
    } else {
      float side = (pt == 3.0 || pt == 4.0) ? -1.0 : 1.0;
      if (pt > 2.5) {
        // arms: elbow bend, then shoulder spread + forward swing
        float g = side < 0.0 ? mix(aArmA.x, aArmB.x, stand) : mix(aArmA.z, aArmB.z, stand);
        float e = side < 0.0 ? mix(aArmA.y, aArmB.y, stand) : mix(aArmA.w, aArmB.w, stand);
        float f = side < 0.0 ? mix(aArmF.x, aArmF.z, stand) : mix(aArmF.y, aArmF.w, stand);
        // celebration wave rides on top of the pose
        float wav = 0.22 * uExcite * stand * sin(uTime * (4.4 * fq) + ph + side);
        vec3 SH = vec3(side * ${ARM_X}, ${SHOULDER_Y}, 0.0);
        vec3 EL = vec3(side * ${ARM_X}, ${ELBOW_Y}, 0.0);
        if (pt == 4.0 || pt == 6.0) { p = rx(p - EL, -e) + EL; n = rx(n, -e); }
        p = rz(p - SH, g * side);
        n = rz(n, g * side);
        p = rx(p, -f - wav); n = rx(n, -f - wav);
        p += SH;
      }
      // upper-body lean + idle breathing
      float lean = aState.w + 0.02 * sin(uTime * (1.2 * fq) + ph);
      float hgt = max(p.y - ${HIP_Y}, 0.0);
      p.x += lean * hgt;
      p += pelv;
    }

    // jump on the big moments
    float jump = 0.34 * stand * smoothstep(0.2, 1.0, uExcite)
               * pow(max(sin(uTime * (5.4 * fq) + ph * 2.7), 0.0), 0.7);
    p.y += jump + 0.012 * sin(uTime * (1.7 * fq) + ph);

    vec3 base = aShirt.rgb;
    if (pt == 1.0) base = aSkin.rgb;
    else if (pt == 2.0) base = mix(aSkin.rgb * aSkin.a, aShirt.rgb, aPants.a);
    else if (pt == 4.0 || pt == 6.0) base = aSkin.rgb;
    else if (pt > 6.5) base = aPants.rgb;

    float lam = 0.17 + 0.46 * max(n.y, 0.0) + 0.46 * max(n.z, 0.0) + 0.16 * abs(n.x);
    vCol = base * aShirt.a * lam;

    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const SPEC_FRAG = /* glsl */ `
  varying vec3 vCol;
  #include <common>
  #include <fog_pars_fragment>
  void main() {
    gl_FragColor = vec4(vCol, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// Arm pose library: [spread, elbowBend, forward] per arm, seated and standing.
const SEAT_ARMS = [
  [[0.14, 0.95, 0.55], [0.14, 0.95, 0.55]],     // hands on lap
  [[0.62, 2.30, 0.80], [0.58, 2.35, 0.85]],     // folded
  [[0.34, 1.95, 0.95], [0.34, 1.95, 0.95]],     // clapping
  [[0.20, 1.20, 0.35], [0.72, 2.10, 0.60]],     // one elbow out
  [[0.16, 0.70, 0.20], [0.44, 2.55, 1.10]],     // phone up
  [[0.50, 1.55, 0.70], [0.50, 1.55, 0.70]],     // leaning on knees
];
const STAND_ARMS = [
  [[2.45, 0.20, 0.10], [2.45, 0.20, 0.10]],     // V
  [[2.60, 0.15, 0.05], [0.22, 0.35, 0.20]],     // one up
  [[1.28, 1.75, 0.30], [1.28, 1.80, 0.35]],     // wave
  [[0.70, 2.05, 0.55], [0.70, 2.05, 0.55]],     // fists
  [[1.05, 2.35, 0.85], [1.05, 2.35, 0.85]],     // clap overhead
  [[2.20, 1.90, 0.15], [2.20, 1.90, 0.15]],     // hands on head
  [[0.30, 0.55, 0.15], [1.25, 0.70, 1.05]],     // pointing
  [[0.24, 0.30, 0.10], [0.24, 0.30, 0.10]],     // just standing
];

// ---------------------------------------------------------------------------
// Tiny merged-geometry builder for the terrace architecture (aisles + voms).
// Colours are baked per vertex; one MeshBasicMaterial, one draw call.
// ---------------------------------------------------------------------------
function makeBuilder() {
  const pos = [], col = [], idx = [];
  let base = 0;
  return {
    pos, col, idx,
    quad(a, b, c, d, cols) {
      for (const v of [a, b, c, d]) pos.push(v[0], v[1], v[2]);
      for (let i = 0; i < 4; i++) {
        const k = cols.length === 4 ? cols[i] : cols[0];
        col.push(k[0], k[1], k[2]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    },
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeBoundingSphere();
      return g;
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createCrowd(ctx) {
  const { scene, rng, quality } = ctx;
  const low = quality === 'low';

  // ---- atlases -------------------------------------------------------------
  const variants = makeVariants(rng);

  const AW = low ? 1024 : 2048, AH = low ? 1024 : 2048;
  const atlasTex = makeCanvasTexture(AW, AH, (c, w, h) => paintAtlas(c, w, h, 'color', variants), {
    wrap: THREE.ClampToEdgeWrapping,
  });
  const maskTex = makeCanvasTexture(AW, AH, (c, w, h) => paintAtlas(c, w, h, 'mask', variants), {
    wrap: THREE.ClampToEdgeWrapping,
    colorSpace: THREE.NoColorSpace,
  });

  // ---- fan material --------------------------------------------------------
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: { value: 0 },
    uExcite: { value: 0 },
    uAtlas: { value: atlasTex },
    uMask: { value: maskTex },
    uCellSize: { value: new THREE.Vector2(1 / COLS, 1 / ROWS) },
  };
  const fanMat = new THREE.ShaderMaterial({
    name: 'crowdFan',
    uniforms,
    vertexShader: FAN_VERT,
    fragmentShader: FAN_FRAG,
    side: THREE.DoubleSide,
    transparent: false,
    alphaToCoverage: true,
    fog: true,
  });

  // ---- stand architecture --------------------------------------------------
  const standLen = {};
  for (const s of STANDS) standLen[s.id] = s.length;
  const standOf = {};
  for (const s of STANDS) standOf[s.id] = s;

  const AISLE_HALF = 0.70;
  const nSecOf = (id) => (id === 'north' || id === 'south' ? 12 : 8);

  function aisleAt(standId, u) {
    const L = standLen[standId];
    const n = nSecOf(standId);
    const along = u * L;
    const pitchM = L / n;
    const k = Math.round(along / pitchM);
    if (k < 1 || k > n - 1) return { d: 99, k: -1 };
    return { d: Math.abs(along - k * pitchM), k };
  }

  const WALK = [9, 6];

  const hash = (a, b, c, d = 0) => {
    let h = (a * 374761393 + b * 668265263 + c * 2147483647 + d * 1103515245) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const standNum = { west: 1, east: 2, north: 3, south: 4 };

  // vomitory block for stairway k of (stand,tier): null or {rowFrom,rowTo}
  function vomAt(standId, tierIdx, k) {
    if (k < 1) return null;
    const hv = hash(standNum[standId] || 1, tierIdx, k);
    if (hv >= 0.55) return null;
    const top = WALK[tierIdx] + 1 + ((hv * 7) | 0) % 3;
    return { from: top, to: top + 4, hv };
  }
  const VOM_HALF = 2.10;

  function seatKept(standId, tierIdx, row, u) {
    const rows = TIERS[tierIdx].rows;
    if (row === WALK[tierIdx]) return false;
    if (tierIdx === 0 && row === rows - 1) return false;
    const { d, k } = aisleAt(standId, u);
    if (d < AISLE_HALF) return false;
    if (k > 0 && d < VOM_HALF) {
      const v = vomAt(standId, tierIdx, k);
      if (v && row >= v.from && row < v.to) return false;
    }
    return true;
  }

  // a few percent of seats stay empty so the shells read through the mass
  function seatEmpty(standId, tierIdx, row, seatIdx) {
    const h = hash(standNum[standId] || 1, tierIdx * 97 + row, seatIdx, 7);
    return h < (tierIdx === 1 ? 0.075 : 0.035);
  }

  // ---- upper-tier lettered mosaic -----------------------------------------
  const MOSAIC_TEXT = { north: 'HARBOURSIDE', south: 'PIT WALL', west: 'ULTRAS', east: '' };
  const mosaics = {};
  for (const s of STANDS) {
    const txt = MOSAIC_TEXT[s.id];
    if (!txt) continue;
    const tier = TIERS[1];
    const nSeats = Math.floor(s.length / tier.seatPitch);
    const tex = makeCanvasTexture(nSeats, tier.rows, (c, w, h) => {
      c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      const fs = Math.round(h * 0.66);
      c.font = `900 ${fs}px system-ui, sans-serif`;
      const tw = c.measureText(txt).width || 1;
      const sx = (w * 0.72) / tw;
      c.save();
      c.translate(w / 2, h * 0.52);
      c.scale(sx, 1);
      c.fillText(txt, 0, 0);
      c.restore();
    }, { colorSpace: THREE.NoColorSpace });
    const cvs = tex.image;
    const data = cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data;
    mosaics[s.id] = { w: cvs.width, h: cvs.height, data };
    tex.dispose();
  }
  function mosaicAt(standId, row, seatIdx) {
    const m = mosaics[standId];
    if (!m) return 0;
    const x = clamp(seatIdx, 0, m.w - 1);
    const y = clamp(m.h - 1 - row, 0, m.h - 1);
    return m.data[(y * m.w + x) * 4] > 128 ? 1 : 0;
  }

  // The front rows of every stand get real geometry — billboards do not
  // survive at 15 m. Everything behind them stays on the sprite field.
  const ROWS_3D = low ? 3 : 6;
  const is3D = (tierIdx, row) => tierIdx === 0 && row < ROWS_3D;

  // ---- counting pass (deterministic — no rng consumed here) ----------------
  let nSeats = 0, nSeatFans = 0, n3D = 0;
  forEachSeat(({ standId, tierIdx, row, seatIdx, u }) => {
    if (!seatKept(standId, tierIdx, row, u)) return;
    nSeats++;
    if (seatEmpty(standId, tierIdx, row, seatIdx)) return;
    if (is3D(tierIdx, row)) n3D++; else nSeatFans++;
  });

  // ---- extras: aisle standers + stewards facing the crowd -----------------
  const extras = [];
  for (const s of STANDS) {
    const n = nSecOf(s.id);
    const pitchM = s.length / n;
    for (let t = 0; t < TIERS.length; t++) {
      const tier = TIERS[t];
      for (let k = 1; k < n; k++) {
        const v = vomAt(s.id, t, k);
        for (let r = 0; r < tier.rows; r += 2) {
          if (r === WALK[t]) continue;
          if (v && r >= v.from && r < v.to) continue;
          if (t === 0 && r === tier.rows - 1) continue;
          const h = hash(standNum[s.id], t * 131 + r, k, 3);
          if (h > 0.34) continue;
          const dist = tier.baseDist[s.axis] + r * tier.rowDepth + 0.16;
          const y = tier.baseY + r * tier.rowRise;
          const along = k * pitchM - s.length / 2 + (h - 0.17) * 1.1;
          const steward = h < 0.07 && r < 6;
          extras.push({ s, dist, y, along, standing: true, steward });
        }
      }
    }
    // hi-vis stewards on the front terrace row, backs to the pitch
    const t0 = TIERS[0];
    const seats0 = Math.floor(s.length / t0.seatPitch);
    for (let i = 6; i < seats0; i += 19) {
      extras.push({
        s, dist: t0.baseDist[s.axis] + 0.12, y: t0.baseY,
        along: (i + 0.5) * t0.seatPitch - s.length / 2,
        standing: true, steward: true, faceOut: true,
      });
    }
  }

  const nFans = nSeatFans + extras.length;

  // ---- buffers -------------------------------------------------------------
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.translate(0, 0.5, 0);

  const tintArr = new Float32Array(nFans * 4);
  const animArr = new Float32Array(nFans * 4);
  const cellArr = new Float32Array(nFans * 4);
  const sizeArr = new Float32Array(nFans * 4);
  const faceArr = new Float32Array(nFans * 2);

  const fanMesh = new THREE.InstancedMesh(geo, fanMat, nFans);
  fanMesh.frustumCulled = false;
  fanMesh.castShadow = false;
  fanMesh.receiveShadow = false;

  const seatGeo = makeSeatGeometry();
  const seatColArr = new Float32Array(nSeats * 4);
  const seatTipArr = new Float32Array(nSeats);
  const seatMat = new THREE.ShaderMaterial({
    name: 'crowdSeats',
    uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    vertexShader: SEAT_VERT,
    fragmentShader: SEAT_FRAG,
    side: THREE.DoubleSide,
    fog: true,
  });
  const seatMesh = new THREE.InstancedMesh(seatGeo, seatMat, nSeats);
  seatMesh.frustumCulled = false;

  // ---- 3D spectators -------------------------------------------------------
  const specGeo = makeSpectatorGeometry();
  const shirtArr = new Float32Array(n3D * 4);
  const skinArr = new Float32Array(n3D * 4);
  const pantsArr = new Float32Array(n3D * 4);
  const armAArr = new Float32Array(n3D * 4);
  const armBArr = new Float32Array(n3D * 4);
  const armFArr = new Float32Array(n3D * 4);
  const stateArr = new Float32Array(n3D * 4);
  const specUniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: { value: 0 },
    uExcite: { value: 0 },
  };
  const specMat = new THREE.ShaderMaterial({
    name: 'crowdSpec3D',
    uniforms: specUniforms,
    vertexShader: SPEC_VERT,
    fragmentShader: SPEC_FRAG,
    fog: true,
  });
  const specMesh = new THREE.InstancedMesh(specGeo, specMat, n3D);
  specMesh.frustumCulled = false;

  const SKIN_3D = ['#a4805f', '#9c7853', '#8e6b46', '#7d5b39', '#6a4b2e', '#553920', '#3f2b1a', '#ad8a68'];
  const PANTS_3D = ['#14161a', '#1c1e23', '#26304a', '#1a2740', '#2c2f35', '#211c19', '#232b33'];

  // ---- palettes ------------------------------------------------------------
  const HOME_RED = TEAMS.home.primary, HOME_DARK = TEAMS.home.secondary;
  const AWAY_W = TEAMS.away.primary, AWAY_B = TEAMS.away.secondary;
  const reds = [HOME_RED, shadeHex(HOME_RED, 0.6), shadeHex(HOME_RED, 0.8),
    '#8e1420', '#6d1a1d', '#a3252c'];
  const darks = [HOME_DARK, '#232529', '#101114', '#2e3036', '#1a1d22', '#191411'];
  // Cool charcoals and navies dominate; two earth tones only, so the mass
  // never turns sepia and the club red is the only warm thing in the stand.
  const neutrals = [
    '#3c4148', '#28324a', '#454a51', '#343a41', '#565c64', '#474d55',
    '#1c2c3c', '#22252b', '#2f3640', '#3a4047', '#4c525a', '#232a33',
    '#2a3038', '#515861', '#30343a', '#3f454d', '#443a2e', '#4a4436',
  ];
  const whites = [AWAY_W, '#dfe3ea', '#eef1f5'];
  const blues = [AWAY_B, shadeHex(AWAY_B, 0.72), shadeHex(AWAY_B, 1.15)];

  // seat shell palette — deep club red / near-black, plus the away block
  // Moulded polypropylene under floodlight: the club red is present but sits
  // low in value and chroma, so the bowl reads dark-red, not candy apple.
  const SEAT_RED = new THREE.Color('#4d1a1e');
  const SEAT_RED2 = new THREE.Color('#5f2126');
  const SEAT_DARK = new THREE.Color('#191a1e');
  const SEAT_DARK2 = new THREE.Color('#24262b');
  const SEAT_AWAY = new THREE.Color('#232f4e');
  const SEAT_LIGHT = new THREE.Color('#9aa1a9');

  const isAway = (standId, tierIdx, u) => standId === 'east' && tierIdx === 1 && u > 0.72 && u < 0.98;
  const isAwaySteward = (standId, tierIdx, u) =>
    standId === 'east' && tierIdx === 1 && ((u > 0.703 && u <= 0.72) || (u >= 0.98 && u < 0.997));
  const isUltras = (standId, tierIdx, u) => standId === 'west' && tierIdx === 0 && u > 0.22 && u < 0.78;

  const secCache = new Map();
  const sectionOf = (standId, tierIdx, u) => {
    const nSec = nSecOf(standId);
    const sec = Math.min(nSec - 1, (u * nSec) | 0);
    const key = standId + ':' + tierIdx + ':' + sec;
    let sp = secCache.get(key);
    if (!sp) {
      sp = { red: 0.17 + 0.24 * rng(), black: 0.22 + 0.18 * rng(), sec };
      secCache.set(key, sp);
    }
    return sp;
  };

  // baked light level for a seat/fan — the whole bowl sits well under the pitch
  function bakedShade(standId, tierIdx, row, u) {
    const tRows = TIERS[tierIdx].rows;
    const rn = tRows > 1 ? row / (tRows - 1) : 0;
    let shade = tierIdx === 0
      ? lerp(0.78, 0.32, Math.pow(rn, 0.78))
      : lerp(0.60, 0.24, Math.pow(rn, 0.70));
    shade *= lerp(0.62, 1.0, Math.pow(Math.sin(u * Math.PI), 0.55));
    shade *= 0.86 + 0.18 * (0.5 + 0.5 * Math.sin(u * 9.1 + tierIdx * 2.3))
                  + 0.08 * (0.5 + 0.5 * Math.sin(u * 23.7 + 1.7));
    return shade;
  }

  const color = new THREE.Color();
  const seatCol = new THREE.Color();
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const vPos = new THREE.Vector3();
  const vScl = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);

  let fi = 0, si = 0, gi = 0;

  // NIGHT GRADE. Fabric the floodlights barely reach reads dark and nearly
  // achromatic; only shirts catching the beam keep their colour, and a
  // minority of well-lit "glints" stay vivid. Shared by sprites and 3D fans
  // so the two populations sit in exactly the same key.
  function gradeTint(out, src, shade, steward, away, teamCol) {
    out.copy(src);
    out.r = clamp(out.r * (0.82 + 0.34 * rng()), 0, 1);
    out.g = clamp(out.g * (0.82 + 0.34 * rng()), 0, 1);
    out.b = clamp(out.b * (0.82 + 0.34 * rng()), 0, 1);
    const lit = clamp(shade, 0, 1);
    const glint = rng() < 0.05 + 0.16 * lit;
    let chroma, value;
    if (steward) { chroma = 1.0; value = 1.25; }
    else if (away) { chroma = 0.66 + 0.24 * rng(); value = 0.95 + 0.22 * rng(); }
    else if (glint) { chroma = 0.85 + 0.15 * rng(); value = 1.05 + 0.18 * rng(); }
    else {
      chroma = (0.24 + 0.28 * rng()) * lerp(0.76, 1.30, lit) * (teamCol ? 1.45 : 0.72);
      value = (0.80 + 0.32 * rng()) * lerp(0.86, 1.14, lit);
    }
    const lum = 0.2126 * out.r + 0.7152 * out.g + 0.0722 * out.b;
    out.setRGB(
      clamp((lum + (out.r - lum) * chroma) * value, 0, 1),
      clamp((lum + (out.g - lum) * chroma) * value, 0, 1),
      clamp((lum + (out.b - lum) * chroma) * value, 0, 1),
    );
    return out;
  }

  const tmpCol = new THREE.Color();

  // 3D spectator writer — front rows only.
  function writeSpec(opts) {
    const { x, y, z, theta, shade, tintCol, steward, away, teamCol } = opts;
    const i = gi++;
    const c4 = i * 4;

    gradeTint(color, tintCol, shade, steward, away, teamCol);
    shirtArr[c4 + 0] = color.r;
    shirtArr[c4 + 1] = color.g;
    shirtArr[c4 + 2] = color.b;
    shirtArr[c4 + 3] = clamp(shade * 1.05, 0, 2);

    tmpCol.set(pick(rng, SKIN_3D));
    skinArr[c4 + 0] = tmpCol.r; skinArr[c4 + 1] = tmpCol.g; skinArr[c4 + 2] = tmpCol.b;
    skinArr[c4 + 3] = 0.10 + 0.35 * rng();          // hair darkness off the skin tone

    tmpCol.set(pick(rng, PANTS_3D));
    pantsArr[c4 + 0] = tmpCol.r; pantsArr[c4 + 1] = tmpCol.g; pantsArr[c4 + 2] = tmpCol.b;
    pantsArr[c4 + 3] = rng() < 0.34 ? 1 : 0;        // club-colour hat / hood

    const sa = SEAT_ARMS[(rng() * SEAT_ARMS.length) | 0];
    const sb = STAND_ARMS[(rng() * STAND_ARMS.length) | 0];
    const jit = () => (rng() - 0.5) * 0.22;
    armAArr[c4 + 0] = sa[0][0] + jit(); armAArr[c4 + 1] = sa[0][1] + jit();
    armAArr[c4 + 2] = sa[1][0] + jit(); armAArr[c4 + 3] = sa[1][1] + jit();
    armBArr[c4 + 0] = sb[0][0] + jit(); armBArr[c4 + 1] = sb[0][1] + jit();
    armBArr[c4 + 2] = sb[1][0] + jit(); armBArr[c4 + 3] = sb[1][1] + jit();
    armFArr[c4 + 0] = sa[0][2] + jit(); armFArr[c4 + 1] = sa[1][2] + jit();
    armFArr[c4 + 2] = sb[0][2] + jit(); armFArr[c4 + 3] = sb[1][2] + jit();

    stateArr[c4 + 0] = steward ? 2.0 : (rng() < 0.10 ? -1.0 : 0.05 + 0.9 * rng());
    stateArr[c4 + 1] = rng() * Math.PI * 2;
    stateArr[c4 + 2] = 0.8 + rng() * 0.7;
    stateArr[c4 + 3] = (rng() - 0.5) * 0.14;        // torso lean

    q.setFromAxisAngle(yAxis, theta + (rng() - 0.5) * 0.5);
    vPos.set(x, y, z);
    const s = 0.94 + 0.12 * rng();
    vScl.set(s * (0.96 + 0.08 * rng()), s, s);
    m4.compose(vPos, q, vScl);
    specMesh.setMatrixAt(i, m4);
    vScl.set(1, 1, 1);
  }

  // Fan writer, shared by seated fans and the aisle/steward extras.
  function writeFan(opts) {
    const { x, y, z, faceYaw, shade, forceStand, steward, away, tintCol } = opts;
    const i = fi++;
    const c4 = i * 4;

    // identity → atlas cells
    const vi = (rng() * NVAR) | 0;
    const colIdx = vi % COLS;
    const sr = (vi / COLS) | 0;
    cellArr[c4 + 0] = colIdx / COLS;
    cellArr[c4 + 1] = 1 - (sr + 1) / ROWS;
    cellArr[c4 + 2] = colIdx / COLS;
    cellArr[c4 + 3] = 1 - (sr + 4) / ROWS;

    gradeTint(color, tintCol, shade, steward, away, opts.teamCol);

    tintArr[c4 + 0] = color.r;
    tintArr[c4 + 1] = color.g;
    tintArr[c4 + 2] = color.b;
    tintArr[c4 + 3] = shade;

    animArr[c4 + 0] = rng() * Math.PI * 2;
    animArr[c4 + 1] = 0.8 + rng() * 0.7;
    // ~9% of the bowl is on its feet all match long; stewards never stand up
    animArr[c4 + 2] = steward ? 2.0 : forceStand ? -1.0 : (rng() < 0.09 ? -1.0 : 0.05 + 0.92 * rng());
    animArr[c4 + 3] = steward ? 0.0 : 0.7 + 0.6 * rng();

    const s = 0.955 + 0.075 * rng();
    sizeArr[c4 + 0] = QUAD_W * s * (0.97 + 0.06 * rng()) * (rng() < 0.5 ? -1 : 1);
    sizeArr[c4 + 1] = QUAD_H * s;
    sizeArr[c4 + 2] = (rng() - 0.5) * 0.16;               // torso lean / shear
    sizeArr[c4 + 3] = 0.34 + 0.26 * rng();                // billboard blend

    const fy = faceYaw + (rng() - 0.5) * 0.55;
    faceArr[i * 2 + 0] = Math.cos(fy);
    faceArr[i * 2 + 1] = Math.sin(fy);

    m4.makeTranslation(x, y, z);
    fanMesh.setMatrixAt(i, m4);
  }

  // ---- fill pass -----------------------------------------------------------
  forEachSeat(({ pos, yaw, standId, tierIdx, row, seatIdx, u }) => {
    if (!seatKept(standId, tierIdx, row, u)) return;
    const stand = standOf[standId];
    const away = isAway(standId, tierIdx, u);
    const ultras = isUltras(standId, tierIdx, u);
    const sp = sectionOf(standId, tierIdx, u);
    const shade = bakedShade(standId, tierIdx, row, u);
    const empty = seatEmpty(standId, tierIdx, row, seatIdx);

    // -------- seat shell --------
    const mos = tierIdx === 1 ? mosaicAt(standId, row, seatIdx) : 0;
    if (away) seatCol.copy(SEAT_AWAY);
    else if (mos) seatCol.copy(SEAT_LIGHT);
    else {
      // Two-thirds dark, one-third club red, blocked by section with a band of
      // contrast rows across the middle — reads as a designed seating plan.
      const band = (row >= 4 && row <= 6) || (tierIdx === 1 && row >= 10 && row <= 11);
      const secRed = sp.sec % 3 === 1;
      if (band !== secRed) seatCol.copy(secRed ? SEAT_RED : SEAT_DARK);
      else seatCol.copy(secRed ? SEAT_RED2 : SEAT_DARK2);
    }
    const seatJit = 0.86 + 0.28 * hash(standNum[standId], row, seatIdx, 11);
    const s4 = si * 4;
    seatColArr[s4 + 0] = seatCol.r * seatJit;
    seatColArr[s4 + 1] = seatCol.g * seatJit;
    seatColArr[s4 + 2] = seatCol.b * seatJit;
    seatColArr[s4 + 3] = clamp(shade * 0.92 + 0.04, 0, 2);
    seatTipArr[si] = empty ? 1 : 0;
    const theta = Math.PI / 2 - yaw + (hash(standNum[standId], row, seatIdx, 5) - 0.5) * 0.12;
    q.setFromAxisAngle(yAxis, theta);
    const depthDir = stand.axis === 'x' ? [stand.sign, 0] : [0, stand.sign];
    vPos.set(
      pos.x + depthDir[0] * 0.16,
      pos.y - FOOT_DROP,
      pos.z + depthDir[1] * 0.16,
    );
    m4.compose(vPos, q, vScl);
    seatMesh.setMatrixAt(si, m4);
    si++;

    if (empty) return;

    // -------- fan --------
    const steward =
      (isAwaySteward(standId, tierIdx, u) && (row & 1) === 0 && seatIdx % 3 === 0) ||
      (tierIdx === 0 && row === 1 && seatIdx % 31 === 13);

    let teamCol = false;
    if (steward) color.set('#ff8a1e');
    else if (away) {
      const r = rng();
      color.set(r < 0.52 ? pick(rng, whites) : r < 0.85 ? pick(rng, blues) : pick(rng, neutrals));
      teamCol = r < 0.85;
    } else {
      const pRed = ultras ? 0.66 : sp.red;
      const pBlack = ultras ? 0.18 : sp.black;
      const r = rng();
      if (r < pRed) { color.set(pick(rng, reds)); teamCol = true; }
      else if (r < pRed + pBlack) color.set(pick(rng, darks));
      else if (rng() < 0.025) color.set('#b8912a');
      else color.set(pick(rng, neutrals));
    }

    let sh = shade;
    if (away) sh = Math.max(sh, lerp(0.62, 0.30, row / Math.max(1, TIERS[tierIdx].rows - 1)));
    if (steward) sh = Math.max(sh, 0.78);

    if (is3D(tierIdx, row)) {
      writeSpec({
        x: pos.x + depthDir[0] * 0.06,
        y: pos.y - FOOT_DROP,
        z: pos.z + depthDir[1] * 0.06,
        theta: Math.PI / 2 - yaw,
        shade: sh, tintCol: color, steward, away, teamCol,
      });
      return;
    }

    writeFan({
      x: pos.x + depthDir[0] * ((hash(standNum[standId], row, seatIdx, 2) - 0.5) * 0.12 - 0.02),
      y: pos.y - FOOT_DROP + (hash(standNum[standId], row, seatIdx, 9) - 0.5) * 0.075,
      z: pos.z + depthDir[1] * ((hash(standNum[standId], row, seatIdx, 2) - 0.5) * 0.12 - 0.02)
        + (stand.axis === 'x' ? (hash(standNum[standId], row, seatIdx, 4) - 0.5) * 0.10 : 0),
      faceYaw: yaw,
      standId, tierIdx, row, u,
      shade: sh, steward, away, ultras, teamCol,
      tintCol: color,
    });
  });

  // ---- extras --------------------------------------------------------------
  for (const e of extras) {
    const s = e.s;
    const x = s.axis === 'x' ? s.sign * e.dist : e.along;
    const z = s.axis === 'x' ? e.along : s.sign * e.dist;
    let yaw;
    if (s.axis === 'x') yaw = s.sign > 0 ? Math.PI : 0;
    else yaw = s.sign > 0 ? -Math.PI / 2 : Math.PI / 2;
    if (e.faceOut) yaw += Math.PI;
    if (e.steward) color.set('#ff8a1e');
    else color.set(pick(rng, rng() < 0.35 ? reds : neutrals));
    writeFan({
      x, y: e.y - FOOT_DROP, z,
      faceYaw: yaw,
      standId: s.id, tierIdx: 0, row: 0, u: 0.5,
      shade: e.steward ? 0.9 : 0.6,
      steward: e.steward, away: false, ultras: false, teamCol: !e.steward,
      forceStand: true,
      tintCol: color,
    });
  }

  fanMesh.count = fi;
  fanMesh.instanceMatrix.needsUpdate = true;
  seatMesh.instanceMatrix.needsUpdate = true;
  specMesh.count = gi;
  specMesh.instanceMatrix.needsUpdate = true;
  specGeo.setAttribute('aShirt', new THREE.InstancedBufferAttribute(shirtArr, 4));
  specGeo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skinArr, 4));
  specGeo.setAttribute('aPants', new THREE.InstancedBufferAttribute(pantsArr, 4));
  specGeo.setAttribute('aArmA', new THREE.InstancedBufferAttribute(armAArr, 4));
  specGeo.setAttribute('aArmB', new THREE.InstancedBufferAttribute(armBArr, 4));
  specGeo.setAttribute('aArmF', new THREE.InstancedBufferAttribute(armFArr, 4));
  specGeo.setAttribute('aState', new THREE.InstancedBufferAttribute(stateArr, 4));
  geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tintArr, 4));
  geo.setAttribute('aAnim', new THREE.InstancedBufferAttribute(animArr, 4));
  geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cellArr, 4));
  geo.setAttribute('aSize', new THREE.InstancedBufferAttribute(sizeArr, 4));
  geo.setAttribute('aFace', new THREE.InstancedBufferAttribute(faceArr, 2));
  seatGeo.setAttribute('aSeat', new THREE.InstancedBufferAttribute(seatColArr, 4));
  seatGeo.setAttribute('aTip', new THREE.InstancedBufferAttribute(seatTipArr, 1));

  // ---- terrace architecture: stairways + vomitories ------------------------
  const arch = makeBuilder();
  const DARK = [0.012, 0.013, 0.016];
  const HOLE = [0.006, 0.006, 0.008];

  const wp = (s, d, a, y) => (s.axis === 'x' ? [s.sign * d, y, a] : [a, y, s.sign * d]);

  // A flat panel spanning [d0,d1] × [a0,a1] at height y.
  const flat = (s, d0, d1, a0, a1, y, cols) =>
    arch.quad(wp(s, d0, a0, y), wp(s, d1, a0, y), wp(s, d1, a1, y), wp(s, d0, a1, y), cols);
  // A vertical panel at distance d spanning [a0,a1] × [y0,y1].
  const upright = (s, d, a0, a1, y0, y1, cols) =>
    arch.quad(wp(s, d, a0, y0), wp(s, d, a1, y0), wp(s, d, a1, y1), wp(s, d, a0, y1), cols);

  for (const s of STANDS) {
    const n = nSecOf(s.id);
    const pitchM = s.length / n;
    for (let t = 0; t < TIERS.length; t++) {
      const tier = TIERS[t];
      const base = tier.baseDist[s.axis];
      for (let k = 1; k < n; k++) {
        const ac = k * pitchM - s.length / 2;
        const a0 = ac - AISLE_HALF, a1 = ac + AISLE_HALF;
        const v = vomAt(s.id, t, k);
        for (let r = 0; r < tier.rows; r++) {
          const d0 = base + r * tier.rowDepth;
          const y = tier.baseY + r * tier.rowRise - FOOT_DROP;
          const inVom = v && r >= v.from && r < v.to;
          if (inVom) {
            // blacked-out tunnel mouth: dark tread + dark riser, no light
            flat(s, d0 - 0.02, d0 + tier.rowDepth + 0.02, a0 - 0.06, a1 + 0.06, y + 0.012, [HOLE]);
            upright(s, d0 - 0.02, a0 - 0.06, a1 + 0.06, y - tier.rowRise, y + 0.012, [HOLE]);
            if (r === v.to - 1) {
              // warm concourse light bleeding out of the back of the mouth
              const yb = y + 0.012, yt = y + 2.5;
              const warmB = [1.55, 0.86, 0.42], warmT = [0.05, 0.035, 0.03];
              upright(s, d0 + tier.rowDepth, a0 - 0.06, a1 + 0.06, yb, yt,
                [warmB, warmB, warmT, warmT]);
              // side walls of the mouth
              arch.quad(wp(s, d0 - 0.02, a0 - 0.06, yb), wp(s, d0 + tier.rowDepth, a0 - 0.06, yb),
                wp(s, d0 + tier.rowDepth, a0 - 0.06, yt), wp(s, d0 - 0.02, a0 - 0.06, yt),
                [[0.10, 0.07, 0.05], [0.30, 0.19, 0.10], [0.03, 0.025, 0.02], [0.03, 0.025, 0.02]]);
              arch.quad(wp(s, d0 + tier.rowDepth, a1 + 0.06, yb), wp(s, d0 - 0.02, a1 + 0.06, yb),
                wp(s, d0 - 0.02, a1 + 0.06, yt), wp(s, d0 + tier.rowDepth, a1 + 0.06, yt),
                [[0.30, 0.19, 0.10], [0.10, 0.07, 0.05], [0.03, 0.025, 0.02], [0.03, 0.025, 0.02]]);
              // lintel
              flat(s, d0 - 0.02, d0 + tier.rowDepth + 0.02, a0 - 0.06, a1 + 0.06, yt, [DARK]);
            }
            continue;
          }
          if (r === WALK[t]) continue;
          // real stairway: split each terrace step into two half-rise treads.
          // Values ride the same baked light as the crowd so the stairs fall
          // into darkness with the stand instead of glowing at the back.
          const hr = tier.rowRise * 0.5;
          const hd = tier.rowDepth * 0.5;
          const sl = clamp(bakedShade(s.id, t, r, (ac + s.length / 2) / s.length), 0.12, 1.4);
          const mid = [0.050 * sl, 0.052 * sl, 0.060 * sl];
          const tread = [0.075 * sl, 0.077 * sl, 0.088 * sl];
          const nose = [0.30 * sl, 0.295 * sl, 0.275 * sl];
          // upper half-step surface
          flat(s, d0 + hd, d0 + tier.rowDepth + 0.01, a0, a1, y + hr, [tread]);
          // its riser
          upright(s, d0 + hd, a0, a1, y, y + hr, [mid]);
          // lower half surface (slightly proud of the concrete so it reads dark)
          flat(s, d0, d0 + hd, a0, a1, y + 0.01, [tread]);
          // nosing highlights
          flat(s, d0 + hd - 0.045, d0 + hd, a0, a1, y + hr + 0.004, [nose]);
          flat(s, d0 - 0.045, d0, a0, a1, y + 0.014, [nose]);
        }
      }
    }
  }

  const archMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: true });
  const archMesh = new THREE.Mesh(arch.build(), archMat);
  archMesh.frustumCulled = false;

  // ---- scene ---------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'crowd';
  group.add(archMesh);
  group.add(seatMesh);
  group.add(specMesh);
  group.add(fanMesh);
  scene.add(group);

  // ---- animation state -----------------------------------------------------
  let time = 0;
  let excite = 0;

  return {
    group,
    update(dt, excitement = 0) {
      time += dt;
      const target = clamp(excitement || 0, 0, 1);
      const lambda = target > excite ? 6.0 : 1.1;
      excite = damp(excite, target, lambda, dt);
      uniforms.uTime.value = time;
      uniforms.uExcite.value = excite;
      specUniforms.uTime.value = time;
      specUniforms.uExcite.value = excite;
    },
  };
}
