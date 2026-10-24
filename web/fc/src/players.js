// ---------------------------------------------------------------------------
// src/players.js — 22 procedural athletes + referee for FIFACHER.
//
// Each player: code-built skeleton (19 bones) + smooth-skinned procedural body
// built from lofted rings (torso with chest/lat/waist taper, deltoid-capped
// arms with elbow + forearm flare + real hands, thighs/calves, boots with a
// defined soleplate and heel, a real neck, a shaped head with brow/nose/
// cheekbone/jaw/chin relief plus ears and geometric hair), one kit-atlas
// texture per player (canvas), and a fully procedural animation stack:
// idle / locomotion (phase-locked to ground speed, no skating) + keyframed
// action layers (pass/shoot/tackle/dives/...).
//
// Conventions (READ BEFORE TOUCHING SIGNS):
//   Model local space: +X forward, +Z player's RIGHT, +Y up.
//   world facing angle f (0 = +X) means direction (cos f, 0, sin f);
//   group.rotation.y = -facing maps local +X onto that direction.
//   Limb sagittal swing: rotation.z (+ swings a hanging limb FORWARD;
//   knee flexion is shin.z NEGATIVE, elbow flexion is forearm.z POSITIVE,
//   foot toe-up is +z). Abduction: rotation.x (+ moves a hanging limb toward
//   -Z, i.e. LEFT limb outward). Spine forward lean = NEGATIVE z.
//
// Winding rule for every builder here ("pattern B"): emit vertex rows in
// ASCENDING sweep order (bottom→top for Y-tubes, heel→toe for X-tubes) with
// the ring angle DECREASING for Y-tubes / INCREASING for X-tubes. connectRows
// then produces outward-facing triangles. Vertex normals are recomputed at
// the end from the faces, welded per PART, so authored shapes (flat boot
// soles, noses, hair rims) shade correctly without analytic normals.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { TEAMS, ACHERS, acherFor, makeCanvasTexture, clamp, lerp, damp, angleLerp } from './util.js';

const TAU = Math.PI * 2;
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const gs = (x, mu, sg) => Math.exp(-0.5 * ((x - mu) / sg) * ((x - mu) / sg));
const wrapPI = (a) => { a = a % TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; };
const approachAngle = (cur, target, maxDelta) => {
  const d = wrapPI(target - cur);
  return cur + clamp(d, -maxDelta, maxDelta);
};
const sgn = (v) => (v < 0 ? -1 : 1);
// signed superellipse component: p<1 → boxier, p=1 → ellipse
const se = (v, p) => sgn(v) * Math.pow(Math.abs(v), p);

// --- Canonical joint layout (meters, for a 1.80 m athlete; scaled by s) -----
const J = {
  ankle: 0.08, knee: 0.52, hip: 0.97, hipLat: 0.088,
  hipsBone: 1.00, spine: 1.13, chest: 1.30, neckBase: 1.485, neckTop: 1.585,
  headC: 1.700, headR: 0.099,
  clavY: 1.455, clavLat: 0.045, shoulder: 1.470, shoulderLat: 0.170,
  elbow: 1.155, elbowLat: 0.197, wrist: 0.885, wristLat: 0.216,
  handTip: 0.706, handTipLat: 0.222,
};

// Head ellipsoid: fore-aft / vertical / lateral scale on headR.
const HEAD_SX = 0.99, HEAD_SY = 1.13, HEAD_SZ = 0.855;
const HEAD_CX = 0.008;      // head sits a touch forward of the neck axis
const HEAD_TH_MAX = 2.85;   // sphere is open below this (hidden by the neck)

const BI = {
  hips: 0, spine: 1, chest: 2, neck: 3, head: 4,
  clavL: 5, uarmL: 6, farmL: 7, handL: 8,
  clavR: 9, uarmR: 10, farmR: 11, handR: 12,
  thighL: 13, shinL: 14, footL: 15,
  thighR: 16, shinR: 17, footR: 18,
};
const BONE_COUNT = 19;

// --- Casting palettes -------------------------------------------------------
const SKIN_TONES = ['#f0c8a0', '#e5b48c', '#d9a077', '#c68d5e', '#a9714b', '#8a5a3b', '#6f452c', '#5a3824'];
// Hair sits 2–3 stops under every skin tone: a blond cap at skin luminance
// turns the whole head into one beige egg with no silhouette separation.
const HAIR_COLORS = ['#12100e', '#1a1410', '#241a10', '#33240f', '#3f3016', '#22222a', '#101012', '#4a2a12'];
// Weighted deck. Most of a squad has real hair; the styles have to differ in
// SILHOUETTE (thickness, crown volume, how far the sides are cut back), not
// just in colour, or 22 men read as 22 copies of one helmet.
const HAIR_STYLES = [
  'short', 'short', 'short', 'crop', 'crop', 'crop', 'fade', 'fade',
  'buzz', 'buzz', 'curly', 'afro', 'quiff', 'quiff', 'long', 'long',
];
const EYE_COLORS = ['#3b2a1c', '#4a3220', '#2e2118', '#3d4a3a', '#3a4756'];

// Sporting Club Draguignan — the Acher family XI, goalkeeper included. Shirt
// names use FIRST names, because "ACHER" on eleven backs tells you nothing.
// Roles drive the formation slot, so the two supers must be declared FW to sit
// in the front three: a fourth declared forward gets pushed into central
// midfield, 67 m from goal and below his own shooting range.
const HOME_SQUAD = [
  { n: 1, name: 'FRANCETTE', role: 'GK' },
  { n: 2, name: 'ANAÉ', role: 'DF' }, { n: 4, name: 'ALAIN', role: 'DF' },
  { n: 5, name: 'AUGUSTINE', role: 'DF' }, { n: 3, name: 'ROXANE', role: 'DF' },
  { n: 6, name: 'ADRIEN', role: 'MF' }, { n: 8, name: 'ÉLISE', role: 'MF' },
  { n: 11, name: 'CHLOÉ', role: 'MF' },
  { n: 10, name: 'G. ACHER', role: 'FW' },
  { n: 7, name: 'M. ACHER', role: 'FW' }, { n: 9, name: 'LÉA', role: 'FW' },
];
// Stade Saint-Aubinais — Breton/Ille-et-Vilaine surnames.
const AWAY_SQUAD = [
  { n: 1, name: 'HAMON', role: 'GK' },
  { n: 2, name: 'GAUTIER', role: 'DF' }, { n: 4, name: 'LEMOINE', role: 'DF' },
  { n: 5, name: 'RENOUARD', role: 'DF' }, { n: 3, name: 'BOSCHER', role: 'DF' },
  { n: 6, name: 'JOUAULT', role: 'MF' }, { n: 8, name: 'DELAUNAY', role: 'MF' },
  { n: 10, name: 'GERNIGON', role: 'MF' },
  { n: 7, name: 'TREHOREL', role: 'FW' }, { n: 9, name: 'RUELLAN', role: 'FW' },
  { n: 11, name: 'MAHE', role: 'FW' },
];

// 4-3-3 default spots (home attacks +X; away mirrored). GK first.
const FORMATION_433 = [
  [-49.5, 0],
  [-33, -20], [-34, -7], [-34, 7], [-33, 20],
  [-19, -12], [-21, 0], [-19, 12],
  [-8, -17], [-6, 0], [-8, 17],
];

// --- UV atlas cells [u0, u1, v0, v1] ---------------------------------------
const CELL = {
  torsoF: [0.00, 0.25, 0.50, 1.00],
  torsoB: [0.25, 0.50, 0.50, 1.00],
  arm: [0.50, 0.75, 0.50, 1.00],
  leg: [0.75, 1.00, 0.50, 1.00],
  head: [0.00, 0.25, 0.02, 0.48],
  hair: [0.26, 0.49, 0.02, 0.48],
  boot: [0.51, 0.74, 0.02, 0.48],
  misc: [0.755, 0.995, 0.02, 0.48],
};
const cellUV = (cell, u, v) => [lerp(cell[0], cell[1], clamp(u, 0, 1)), lerp(cell[2], cell[3], clamp(v, 0, 1))];
// Geometry samples a slightly inset window of each cell. The atlas is one
// texture with RepeatWrapping, so a tube seam landing exactly on a cell
// boundary drags in the neighbouring cell's colour (a thin wrong-coloured
// stripe down the flank). Painting still uses the full cell, so the inset is
// pure bleed guard.
const UV_INSET = 0.018;
const cellUVg = (cell, u, v) => cellUV(cell,
  UV_INSET + (1 - 2 * UV_INSET) * clamp(u, 0, 1),
  UV_INSET + (1 - 2 * UV_INSET) * clamp(v, 0, 1));
// sub-rectangle of a cell (i,j) in a cols×rows grid, with a small inset so
// mip bleeding between neighbours stays out of the sampled area.
function subCell(cell, i, j, cols, rows, inset = 0.06) {
  const du = (cell[1] - cell[0]) / cols, dv = (cell[3] - cell[2]) / rows;
  return [
    cell[0] + du * (i + inset), cell[0] + du * (i + 1 - inset),
    cell[2] + dv * (j + inset), cell[2] + dv * (j + 1 - inset),
  ];
}
// misc swatches: (0,0) ear · (1,0) dark · (0,1) skin · (1,1) hair
const SW_EAR = subCell(CELL.misc, 0, 0, 2, 2, 0.02);
const SW_DARK = subCell(CELL.misc, 1, 0, 2, 2);
const SW_SKIN = subCell(CELL.misc, 0, 1, 2, 2);
const SW_HAIR = subCell(CELL.misc, 1, 1, 2, 2);
const flatUV = (sw) => cellUV(sw, 0.5, 0.5);

// --- Geometry accumulator ---------------------------------------------------
function newAcc() {
  return { p: [], n: [], uv: [], si: [], sw: [], idx: [], g: [], part: 0 };
}
function startPart(acc) { acc.part++; }
function pushVert(acc, x, y, z, nx, ny, nz, u, v, ia, wa, ib, wb) {
  acc.p.push(x, y, z);
  const il = Math.hypot(nx, ny, nz) || 1;
  acc.n.push(nx / il, ny / il, nz / il);
  acc.uv.push(u, v);
  const ws = (wa + wb) || 1;
  acc.si.push(ia, ib, 0, 0);
  acc.sw.push(wa / ws, wb / ws, 0, 0);
  acc.g.push(acc.part);
  return acc.p.length / 3 - 1;
}
// Connect a grid of vertex rows (each row = array of indices, equal lengths).
function connectRows(acc, rows) {
  for (let r = 0; r < rows.length - 1; r++) {
    const a = rows[r], b = rows[r + 1];
    for (let i = 0; i < a.length - 1; i++) {
      acc.idx.push(a[i], a[i + 1], b[i]);
      acc.idx.push(a[i + 1], b[i + 1], b[i]);
    }
  }
}
// Fan-close an existing ring of indices around a new centre vertex.
// `up`: true → the cap faces the +sweep direction of the ring's own winding.
function fanRing(acc, row, cx, cy, cz, nx, ny, nz, uv, w, flip) {
  const ci = pushVert(acc, cx, cy, cz, nx, ny, nz, uv[0], uv[1], w[0], w[1], w[2], w[3]);
  for (let c = 0; c < row.length - 1; c++) {
    if (flip) acc.idx.push(ci, row[c + 1], row[c]);
    else acc.idx.push(ci, row[c], row[c + 1]);
  }
}

// Vertical elliptical tube. rings: [{ y, rx, rz, cx?, cz?, w:[ia,wa,ib,wb] }]
// listed TOP → BOTTOM. angle span [a0..a1] (a1 < a0) with `seg` columns;
// u via uFn(t), v via vFn(y). opts: { capTop, capBottom }.
function buildTubeY(acc, rings, seg, a0, a1, cell, vFn, uFn, opts = {}) {
  const rows = [];
  const n = rings.length;
  for (let k = n - 1; k >= 0; k--) {
    const rg = rings[k];
    const row = [];
    const cx = rg.cx || 0, cz = rg.cz || 0;
    for (let c = 0; c <= seg; c++) {
      const t = c / seg;
      const a = lerp(a0, a1, t); // decreasing
      const ca = Math.cos(a), sa = Math.sin(a);
      const [u, v] = cellUVg(cell, uFn(t), vFn(rg.vy !== undefined ? rg.vy : rg.y));
      const [ia, wa, ib, wb] = rg.w;
      // free-edge modulation (shirt hem scallop) — a function of azimuth only,
      // so both tube halves still meet exactly at the ±90° seams.
      const y = rg.hk && opts.edgeFn ? rg.y + rg.hk * opts.edgeFn(a) : rg.y;
      row.push(pushVert(acc, cx + rg.rx * ca, y, cz + rg.rz * sa, ca, 0, sa, u, v, ia, wa, ib, wb));
    }
    rows.push(row);
  }
  connectRows(acc, rows);
  // rows[last] is the TOP ring (rings[0]); a decreasing ⇒ (ci, r[c], r[c+1]) faces +Y
  if (opts.capTop) {
    const rg = rings[0];
    const [u, v] = cellUVg(cell, uFn(0.5), vFn(rg.y));
    fanRing(acc, rows[rows.length - 1], rg.cx || 0, rg.y, rg.cz || 0, 0, 1, 0, [u, v], rg.w, false);
  }
  if (opts.capBottom) {
    const rg = rings[n - 1];
    const [u, v] = cellUVg(cell, uFn(0.5), vFn(rg.y));
    fanRing(acc, rows[0], rg.cx || 0, rg.y, rg.cz || 0, 0, -1, 0, [u, v], rg.w, true);
  }
}

// Recompute vertex normals from faces, welding coincident vertices within the
// same PART only (so parts keep hard edges and tube seams shade seamlessly).
function recomputeNormals(acc) {
  const P = acc.p, I = acc.idx, G = acc.g;
  const nv = P.length / 3;
  const map = new Map();
  const rep = new Int32Array(nv);
  for (let i = 0; i < nv; i++) {
    const k = G[i] + '|' + Math.round(P[i * 3] * 20000) + '|' +
      Math.round(P[i * 3 + 1] * 20000) + '|' + Math.round(P[i * 3 + 2] * 20000);
    const r = map.get(k);
    if (r === undefined) { map.set(k, i); rep[i] = i; } else rep[i] = r;
  }
  const A = new Float64Array(nv * 3);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    let r = rep[I[t]] * 3; A[r] += nx; A[r + 1] += ny; A[r + 2] += nz;
    r = rep[I[t + 1]] * 3; A[r] += nx; A[r + 1] += ny; A[r + 2] += nz;
    r = rep[I[t + 2]] * 3; A[r] += nx; A[r + 1] += ny; A[r + 2] += nz;
  }
  for (let i = 0; i < nv; i++) {
    const r = rep[i] * 3;
    const x = A[r], y = A[r + 1], z = A[r + 2];
    const l = Math.hypot(x, y, z);
    if (l > 1e-12) { acc.n[i * 3] = x / l; acc.n[i * 3 + 1] = y / l; acc.n[i * 3 + 2] = z / l; }
  }
}

function accToGeometry(acc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(acc.si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(acc.sw, 4));
  g.setIndex(acc.idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 2.4);
  return g;
}

// ---------------------------------------------------------------------------
// Kit atlas painting. One texture per player.
// Torso v: y 0.905→1.595; arm v: y 0.700→1.560; leg v: y 0.070→1.010.
// ---------------------------------------------------------------------------
const TORSO_Y0 = 0.905, TORSO_Y1 = 1.595;
const ARM_Y0 = 0.700, ARM_Y1 = 1.560;
const LEG_Y0 = 0.070, LEG_Y1 = 1.010;
const torsoV = (y) => (y - TORSO_Y0) / (TORSO_Y1 - TORSO_Y0);
const armV = (y) => (y - ARM_Y0) / (ARM_Y1 - ARM_Y0);
const legV = (y) => (y - LEG_Y0) / (LEG_Y1 - LEG_Y0);
// The shorts shell owns the top of the leg cell (v ≥ SHORTS_V0); the leg tube
// below the hem is bare skin, so there is exactly one painted hem in the atlas.
const SHORTS_V0 = 0.756, SHORTS_Y0 = 0.752, SHORTS_Y1 = 1.060;
const shortsV = (y) => SHORTS_V0 + (y - SHORTS_Y0) * (1 - SHORTS_V0) / (SHORTS_Y1 - SHORTS_Y0);

// Torso u: linear in the PROJECTED width instead of the angle, so the back
// number reads undistorted from straight behind (and the crest from the front).
const torsoU = (t) => (1 - Math.cos(Math.PI * t)) * 0.5;

function shade(hex, amt) { // amt -1..1 darken/lighten
  const c = new THREE.Color(hex);
  if (amt >= 0) c.lerp(new THREE.Color('#ffffff'), amt);
  else c.lerp(new THREE.Color('#000000'), -amt);
  return '#' + c.getHexString();
}

function makeKitTexture(spec, rng, size) {
  return makeCanvasTexture(size, size, (g, W, H) => {
    const px = (u) => u * W;
    const py = (v) => (1 - v) * H;
    // rect in a cell using cell-local coords
    const cRect = (cell, u0, v0, u1, v1, fill) => {
      const [au0, av0] = cellUV(cell, u0, v0);
      const [au1, av1] = cellUV(cell, u1, v1);
      g.fillStyle = fill;
      g.fillRect(px(au0), py(av1), px(au1 - au0), py(av0) - py(av1));
    };
    const K = spec.kit; // { shirt, trim, shorts, socks, numFill, numStroke, crest }
    g.fillStyle = '#101012';
    g.fillRect(0, 0, W, H);

    // ---- torso cells (front + back) ----
    // The torso tube is shirt all the way down now; its last rings are the
    // rolled hem, so the bottom of the cell paints the hem's dark underside.
    const hemV = torsoV(0.9755), collarV = torsoV(1.508), skinV = torsoV(1.5335);
    for (const cell of [CELL.torsoF, CELL.torsoB]) {
      const back = cell === CELL.torsoB;
      cRect(cell, 0, 0, 1, 1, K.shirt);
      // hem: dark underside → soft contact shadow → free edge highlight.
      // v < 0.040 is only ever sampled by the inside of the hem roll.
      cRect(cell, 0, 0, 1, 0.040, shade(K.shirt, -0.70));
      cRect(cell, 0, 0.040, 1, 0.060, shade(K.shirt, -0.40));
      cRect(cell, 0, 0.060, 1, 0.068, shade(K.shirt, 0.10));   // lit free edge
      {
        const [gu0, gv0] = cellUV(cell, 0, 0.068), [gu1, gv1] = cellUV(cell, 1, hemV);
        const hg2 = g.createLinearGradient(0, py(gv0), 0, py(gv1));
        hg2.addColorStop(0, 'rgba(0,0,0,0.30)'); hg2.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = hg2;
        g.fillRect(px(gu0), py(gv1), px(gu1 - gu0), py(gv0) - py(gv1));
      }
      // neck skin above the collar
      cRect(cell, 0, skinV, 1, 1, spec.skin);
      // ribbed collar band (geometry gives it thickness; this gives it knit)
      cRect(cell, 0, collarV, 1, skinV, K.trim);
      for (let i = 0; i < 46; i++) {
        cRect(cell, i / 46 + 0.004, collarV + 0.002, i / 46 + 0.010, skinV - 0.002, 'rgba(0,0,0,0.16)');
      }
      cRect(cell, 0, collarV, 1, collarV + 0.006, shade(K.trim, -0.5)); // collar shadow
      // side-panel shading (fakes cloth curvature + hides the half seams)
      const [cu0, cv0] = cellUV(cell, 0, 0), [cu1, cv1] = cellUV(cell, 1, skinV);
      for (const s of [0, 1]) {
        const x0 = s ? px(cu1) : px(cu0);
        const gradS = g.createLinearGradient(x0, 0, x0 + (s ? -W * 0.062 : W * 0.062), 0);
        gradS.addColorStop(0, 'rgba(0,0,0,0.22)'); gradS.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gradS;
        g.fillRect(s ? px(cu1) - px(0.065) : px(cu0), py(cv1), px(0.065), py(cv0) - py(cv1));
      }
      // torso modelling: chest / lat / spine relief so the tube reads as a body
      const bodyTop = torsoV(1.470), bodyBot = torsoV(1.06);
      if (!back) {
        // ONE soft vertical sternum shadow. No symmetric pec arcs and no
        // second circular mark beside the crest — two matching curves either
        // side of the sternum is what made the chest read as a face.
        const [su, sv0] = cellUV(cell, 0.5, torsoV(1.20));
        const [, sv1] = cellUV(cell, 0.5, torsoV(1.44));
        const stg = g.createLinearGradient(px(su) - W * 0.022, 0, px(su) + W * 0.022, 0);
        stg.addColorStop(0, 'rgba(0,0,0,0)'); stg.addColorStop(0.5, 'rgba(0,0,0,0.15)');
        stg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = stg;
        g.fillRect(px(su) - W * 0.022, py(sv1), W * 0.044, py(sv0) - py(sv1));
        // one continuous pec lower edge straight across, no paired curves
        const [au, av] = cellUV(cell, 0.5, torsoV(1.318));
        const pg2 = g.createLinearGradient(0, py(av) + W * 0.010, 0, py(av) - W * 0.004);
        pg2.addColorStop(0, 'rgba(0,0,0,0.13)'); pg2.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = pg2;
        g.fillRect(px(cellUV(cell, 0.20, 0)[0]), py(av) - W * 0.004,
          px(cellUV(cell, 0.80, 0)[0] - cellUV(cell, 0.20, 0)[0]), W * 0.014);
      } else {
        // spine channel + scapula shading
        const [su, sv0] = cellUV(cell, 0.5, bodyBot);
        const [, sv1] = cellUV(cell, 0.5, bodyTop);
        const spg = g.createLinearGradient(px(su) - W * 0.016, 0, px(su) + W * 0.016, 0);
        spg.addColorStop(0, 'rgba(0,0,0,0)'); spg.addColorStop(0.5, 'rgba(0,0,0,0.18)');
        spg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = spg;
        g.fillRect(px(su) - W * 0.016, py(sv1), W * 0.032, py(sv0) - py(sv1));
        for (const s of [-1, 1]) {
          const [pu, pv] = cellUV(cell, 0.5 + s * 0.17, torsoV(1.415));
          const rg = g.createRadialGradient(px(pu), py(pv), 0, px(pu), py(pv), W * 0.05);
          rg.addColorStop(0, 'rgba(255,255,255,0.08)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = rg;
          g.beginPath(); g.arc(px(pu), py(pv), W * 0.05, 0, TAU); g.fill();
        }
      }
      // shoulder / trap highlight so the deltoid line continues onto the shirt
      const [tu, tv] = cellUV(cell, 0.5, torsoV(1.482));
      const tg = g.createLinearGradient(0, py(tv) - W * 0.02, 0, py(tv) + W * 0.03);
      tg.addColorStop(0, 'rgba(255,255,255,0.10)'); tg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = tg;
      g.fillRect(px(cellUV(cell, 0, 0)[0]), py(tv) - W * 0.02, px(0.25), W * 0.05);
    }
    // front V-notch under the collar
    {
      const [nu, nv] = cellUV(CELL.torsoF, 0.5, collarV);
      g.fillStyle = K.trim;
      g.beginPath();
      g.moveTo(px(nu) - W * 0.013, py(nv));
      g.lineTo(px(nu) + W * 0.013, py(nv));
      g.lineTo(px(nu), py(nv - 0.030));
      g.closePath(); g.fill();
    }
    // cloth: diagonal drape folds running from each armpit toward the opposite
    // hip, painted as a shadow with a lit crest so the jersey reads as fabric.
    for (const cell of [CELL.torsoF, CELL.torsoB]) {
      // all folds run the SAME way — crossing diagonals paint an X on the chest
      for (let f = 0; f < 4; f++) {
        const u0 = 0.5 + (0.32 - 0.04 * f), v0 = torsoV(1.30 - 0.05 * f);
        const u1 = 0.5 - (0.16 + 0.04 * f), v1 = torsoV(1.10 - 0.04 * f);
        const [x0, y0] = cellUV(cell, u0, v0), [x1, y1] = cellUV(cell, u1, v1);
        g.lineCap = 'round';
        g.strokeStyle = 'rgba(0,0,0,0.055)';
        g.lineWidth = Math.max(3, W * 0.0075);
        g.beginPath(); g.moveTo(px(x0), py(y0));
        g.quadraticCurveTo(px((x0 + x1) * 0.5), py((y0 + y1) * 0.5 - 0.010), px(x1), py(y1));
        g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.035)';
        g.lineWidth = Math.max(2, W * 0.0040);
        g.beginPath(); g.moveTo(px(x0), py(y0) + W * 0.005);
        g.quadraticCurveTo(px((x0 + x1) * 0.5), py((y0 + y1) * 0.5 - 0.010) + W * 0.005, px(x1), py(y1) + W * 0.005);
        g.stroke();
        g.lineCap = 'butt';
      }
    }
    // fabric micro-noise on the shirt+shorts area of both torso cells
    for (let i = 0; i < 1600; i++) {
      const cell = i % 2 ? CELL.torsoF : CELL.torsoB;
      const [u, v] = cellUV(cell, rng(), rng());
      g.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.030)' : 'rgba(0,0,0,0.035)';
      g.fillRect(px(u), py(v), 2, 2);
    }

    if (!spec.isRef) {
      // ---- BIG back number ----
      g.font = `900 ${Math.round(H * 0.150)}px "Archivo Black","Arial Black",system-ui,sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const [bu, bv] = cellUV(CELL.torsoB, 0.5, torsoV(1.298));
      g.lineWidth = Math.max(3, H * 0.0085);
      g.strokeStyle = K.numStroke;
      g.strokeText(String(spec.number), px(bu), py(bv));
      g.fillStyle = K.numFill;
      g.fillText(String(spec.number), px(bu), py(bv));
      // back name
      g.font = `700 ${Math.round(H * 0.028)}px system-ui,sans-serif`;
      const [nu2, nv2] = cellUV(CELL.torsoB, 0.5, torsoV(1.452));
      g.fillStyle = K.numFill;
      const nm = spec.name.length > 10 ? spec.name.slice(0, 10) : spec.name;
      g.fillText(nm.split('').join(' '), px(nu2), py(nv2));
      // ---- front: crest, sponsor, small number ----
      const [cru, crv] = cellUV(CELL.torsoF, 0.355, torsoV(1.400));
      const crR = H * 0.021;
      g.fillStyle = K.trim;
      g.beginPath(); g.arc(px(cru), py(crv), crR, 0, TAU); g.fill();
      // inner disc must contrast with the ring, and several kits have
      // trim === crest, so fall back to the shirt colour when they collide
      const crestC = new THREE.Color(K.crest).getHexString() ===
        new THREE.Color(K.trim).getHexString() ? K.shirt : K.crest;
      g.fillStyle = crestC;
      g.beginPath(); g.arc(px(cru), py(crv), crR * 0.68, 0, TAU); g.fill();
      g.fillStyle = K.trim;
      g.beginPath();
      g.moveTo(px(cru), py(crv) - crR * 0.45);
      g.lineTo(px(cru) + crR * 0.4, py(crv) + crR * 0.35);
      g.lineTo(px(cru) - crR * 0.4, py(crv) + crR * 0.35);
      g.closePath(); g.fill();
      // sponsor wordmark
      g.font = `800 ${Math.round(H * 0.026)}px system-ui,sans-serif`;
      const [su, sv] = cellUV(CELL.torsoF, 0.5, torsoV(1.208));
      g.fillStyle = spec.sponsorColor;
      g.fillText(spec.sponsor, px(su), py(sv));
      // NOTE: no small front number. A crest and a numeral at the same height
      // either side of the sternum reads as a pair of eyes at closeup range.
    } else {
      const [bu, bv] = cellUV(CELL.torsoF, 0.36, torsoV(1.400));
      g.fillStyle = '#ffd400';
      g.beginPath(); g.arc(px(bu), py(bv), H * 0.016, 0, TAU); g.fill();
      g.font = `700 ${Math.round(H * 0.020)}px system-ui,sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#ffd400';
      const [lu, lv] = cellUV(CELL.torsoF, 0.5, torsoV(1.225));
      g.fillText('LIGUE FABLE', px(lu), py(lv));
    }

    // ---- arm cell: shoulder→sleeve→rolled cuff→skin→hand ----
    const cuffTop = armV(1.2925), cuffBot = armV(1.2705), cuffUnder = armV(1.2555);
    const gloveTop = armV(0.930);
    cRect(CELL.arm, 0, 0, 1, 1, spec.skin);
    cRect(CELL.arm, 0, cuffUnder, 1, 1, K.shirt);
    cRect(CELL.arm, 0, cuffBot, 1, cuffTop, K.trim);                       // cuff band
    for (let i = 0; i < 40; i++) {                                          // rib knit
      cRect(CELL.arm, i / 40 + 0.004, cuffBot, i / 40 + 0.011, cuffTop, 'rgba(0,0,0,0.14)');
    }
    cRect(CELL.arm, 0, cuffUnder, 1, cuffBot, shade(K.trim, -0.62));       // under-turn
    cRect(CELL.arm, 0, cuffUnder - 0.010, 1, cuffUnder, 'rgba(0,0,0,0.34)'); // cuff shadow
    if (spec.isGK) cRect(CELL.arm, 0, 0, 1, gloveTop, spec.gloveColor);
    // deltoid / biceps / forearm shading bands (u wraps the limb: 0.5 = back)
    {
      const [au0, av0] = cellUV(CELL.arm, 0, armV(0.90));
      const [au1, av1] = cellUV(CELL.arm, 1, armV(1.56));
      const ag = g.createLinearGradient(px(au0), 0, px(au1), 0);
      ag.addColorStop(0.00, 'rgba(255,255,255,0.05)');
      ag.addColorStop(0.13, 'rgba(0,0,0,0.06)');
      ag.addColorStop(0.26, 'rgba(0,0,0,0.15)');
      ag.addColorStop(0.40, 'rgba(0,0,0,0.05)');
      ag.addColorStop(0.50, 'rgba(0,0,0,0.02)');
      ag.addColorStop(0.60, 'rgba(0,0,0,0.05)');
      ag.addColorStop(0.74, 'rgba(0,0,0,0.15)');
      ag.addColorStop(0.87, 'rgba(0,0,0,0.06)');
      ag.addColorStop(1.00, 'rgba(255,255,255,0.05)');
      g.fillStyle = ag;
      g.fillRect(px(au0), py(av1), px(au1 - au0), py(av0) - py(av1));
    }
    // NOTE: no painted finger separations. The digits are real geometry now;
    // painted grooves on top of them are exactly what made a hand read mitten.
    // Just a whisper of warmth in the palm hollow.
    {
      const [hu, hv] = cellUV(CELL.arm, 0.50, armV(0.845));
      const pgr = g.createRadialGradient(px(hu), py(hv), 0, px(hu), py(hv), W * 0.020);
      pgr.addColorStop(0, 'rgba(90,40,30,0.10)'); pgr.addColorStop(1, 'rgba(90,40,30,0)');
      g.fillStyle = pgr;
      g.beginPath(); g.arc(px(hu), py(hv), W * 0.020, 0, TAU); g.fill();
    }
    for (let i = 0; i < 320; i++) {
      const [u, v] = cellUV(CELL.arm, rng(), lerp(cuffTop, 1, rng()));
      g.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.035)';
      g.fillRect(px(u), py(v), 2, 2);
    }

    // ---- leg cell: bare leg below v0, shorts SHELL above it ----
    // v ≥ SHORTS_V0 is sampled only by the shorts shell, so the leg tube itself
    // is skin all the way to the hip: one garment, one hem, no double edge.
    const shortsEnd = SHORTS_V0, sockTop = legV(0.452), bandBot = legV(0.400);
    cRect(CELL.leg, 0, 0, 1, 1, spec.skin);
    cRect(CELL.leg, 0, shortsEnd, 1, 1, K.shorts);
    cRect(CELL.leg, 0, 0, 1, sockTop, K.socks);
    cRect(CELL.leg, 0, bandBot, 1, sockTop, K.trim); // turnover band
    // shorts side stripe + the side-split seam at the outer edge
    cRect(CELL.leg, 0.225, shortsEnd + 0.026, 0.275, 0.99, K.trim);
    cRect(CELL.leg, 0.725, shortsEnd + 0.026, 0.775, 0.99, K.trim);
    for (const u of [0.25, 0.75]) {
      cRect(CELL.leg, u - 0.003, shortsEnd + 0.026, u + 0.003, 0.99, 'rgba(0,0,0,0.22)');
    }
    // hem roll: dark underside → bevel → lit free edge
    cRect(CELL.leg, 0, shortsEnd, 1, 0.7665, shade(K.shorts, -0.75));
    cRect(CELL.leg, 0, 0.7665, 1, 0.7755, shade(K.shorts, -0.45));
    cRect(CELL.leg, 0, 0.7755, 1, 0.7885, shade(K.shorts, 0.14));
    {
      const [gu0, gv0] = cellUV(CELL.leg, 0, 0.7885), [gu1, gv1] = cellUV(CELL.leg, 1, 0.83);
      const hg3 = g.createLinearGradient(0, py(gv0), 0, py(gv1));
      hg3.addColorStop(0, 'rgba(0,0,0,0.22)'); hg3.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = hg3;
      g.fillRect(px(gu0), py(gv1), px(gu1 - gu0), py(gv0) - py(gv1));
    }
    // drape folds across the shorts
    for (let f = 0; f < 5; f++) {
      const u = 0.10 + f * 0.19, dir = f % 2 ? 1 : -1;
      const [x0, y0] = cellUV(CELL.leg, u, 0.80);
      const [x1, y1] = cellUV(CELL.leg, u + dir * 0.05, 0.97);
      g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = Math.max(3, W * 0.006);
      g.beginPath(); g.moveTo(px(x0), py(y0)); g.lineTo(px(x1), py(y1)); g.stroke();
    }
    // limb shading: dark at the two silhouette edges (u 0.25 / 0.75 are the sides)
    {
      const [lu0, lv0] = cellUV(CELL.leg, 0, 0);
      const [lu1, lv1] = cellUV(CELL.leg, 1, 1);
      const lg = g.createLinearGradient(px(lu0), 0, px(lu1), 0);
      lg.addColorStop(0.00, 'rgba(255,255,255,0.05)');
      lg.addColorStop(0.25, 'rgba(0,0,0,0.18)');
      lg.addColorStop(0.50, 'rgba(0,0,0,0.06)');
      lg.addColorStop(0.75, 'rgba(0,0,0,0.18)');
      lg.addColorStop(1.00, 'rgba(255,255,255,0.05)');
      g.fillStyle = lg;
      g.fillRect(px(lu0), py(lv1), px(lu1 - lu0), py(lv0) - py(lv1));
    }
    // sock ribbing
    for (let i = 0; i < 12; i++) {
      cRect(CELL.leg, i / 12 + 0.02, 0.02, i / 12 + 0.032, sockTop - 0.02, 'rgba(0,0,0,0.10)');
    }

    // ---- boot cell: v 0 = soleplate underside, v 1 = top of the boot ----
    cRect(CELL.boot, 0, 0, 1, 1, spec.bootUpper);
    cRect(CELL.boot, 0, 0, 1, 0.140, spec.bootSole);                    // soleplate
    cRect(CELL.boot, 0, 0.140, 1, 0.178, shade(spec.bootSole, 0.34));   // lit outsole edge
    cRect(CELL.boot, 0, 0.178, 1, 0.232, shade(spec.bootUpper, -0.55)); // dark welt
    cRect(CELL.boot, 0.38, 0.90, 0.47, 1.0, '#e9e6dd');                 // lace webbing
    {
      // brand flash sweeping from midfoot to toe
      const [f0u, f0v] = cellUV(CELL.boot, 0.22, 0.36);
      const [f1u, f1v] = cellUV(CELL.boot, 0.80, 0.62);
      g.strokeStyle = spec.bootFlash;
      g.lineWidth = Math.max(3, H * 0.012);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(px(f0u), py(f0v));
      g.quadraticCurveTo(px((f0u + f1u) * 0.5), py(f0v - 0.05), px(f1u), py(f1v));
      g.stroke();
      // heel counter accent + its stitch line
      cRect(CELL.boot, 0.02, 0.30, 0.13, 0.82, shade(spec.bootUpper, 0.20));
      cRect(CELL.boot, 0.128, 0.30, 0.140, 0.82, shade(spec.bootUpper, -0.5));
      // vamp: dark under the laces so the collar reads as a separate piece
      cRect(CELL.boot, 0.16, 0.86, 0.38, 1.0, shade(spec.bootUpper, -0.35));
      g.lineCap = 'butt';
    }
    for (let i = 0; i < 160; i++) {
      const [u, v] = cellUV(CELL.boot, rng(), lerp(0.2, 1, rng()));
      g.fillStyle = 'rgba(255,255,255,0.035)';
      g.fillRect(px(u), py(v), 2, 2);
    }

    // ---- head cell ----
    cRect(CELL.head, 0, 0, 1, 1, spec.skin);
    const hc = CELL.head;
    {
      const [u0, v0] = cellUV(hc, 0, 0), [u1, v1] = cellUV(hc, 1, 1);
      const gr = g.createLinearGradient(0, py(v1), 0, py(v0));
      gr.addColorStop(0, 'rgba(255,255,255,0.05)');
      gr.addColorStop(0.55, 'rgba(0,0,0,0)');
      gr.addColorStop(1, 'rgba(0,0,0,0.18)');
      g.fillStyle = gr;
      g.fillRect(px(u0), py(v1), px(u1 - u0), py(v0) - py(v1));
      // temple/side falloff so the head doesn't read as a flat oval
      const sg2 = g.createLinearGradient(px(u0), 0, px(u1), 0);
      sg2.addColorStop(0.00, 'rgba(0,0,0,0.22)');
      sg2.addColorStop(0.26, 'rgba(0,0,0,0.14)');
      sg2.addColorStop(0.50, 'rgba(255,255,255,0.05)');
      sg2.addColorStop(0.74, 'rgba(0,0,0,0.14)');
      sg2.addColorStop(1.00, 'rgba(0,0,0,0.22)');
      g.fillStyle = sg2;
      g.fillRect(px(u0), py(v1), px(u1 - u0), py(v0) - py(v1));
    }
    // ---- face ------------------------------------------------------------
    // THE HEAD CELL IS VIOLENTLY ANISOTROPIC. Cell-local u wraps the FULL 360°
    // of azimuth (≈552 mm of skin per unit u at the eye line) while cell-local
    // v spans π rad of the head ellipsoid (≈364 mm per unit v). A circle drawn
    // in texture space therefore lands on the face as a 2.8× WIDE smear — which
    // is exactly how two small eyes, their socket shadows and their brows fused
    // into one continuous dark bar from ear to ear (the bandit mask).
    // So: push a transform where ONE UNIT = ONE MILLIMETRE of real skin
    // (+x = viewer right, +y = DOWN the face, origin on the midline at the eye
    // line) and author every feature at life size. Sculpted landmarks, as theta
    // from the crown: brow ridge 1.42, eye globe 1.605, nose tip 1.855,
    // nostrils 1.972, lip line 2.130, lower lip 2.180, chin 2.42.
    // KEEP THE FACE UNDER-DRAWN: a plain face is fine, a masked one is not.
    const FMM_U = 552, FMM_V = 364;   // mm of skin per unit of painted cell uv
    const facV = (th) => UV_INSET + (1 - 2 * UV_INSET) * (1 - th / Math.PI);
    const mmY = (th) => (th - 1.605) * (FMM_V * (1 - 2 * UV_INSET) / Math.PI);
    const EYE_DX = 35.6;              // mm midline → pupil (IPD ≈ 71 mm)
    {
      const [fu, fv] = cellUV(hc, 0.5, facV(1.605));
      g.save();
      g.translate(px(fu), py(fv));
      g.scale((CELL.head[1] - CELL.head[0]) * W / FMM_U,
        (CELL.head[3] - CELL.head[2]) * H / FMM_V);
      g.lineJoin = 'round';

      for (const sd of [-1, 1]) {
        g.save();
        g.translate(sd * EYE_DX, 0);
        g.scale(-sd, 1);               // local +x now points MEDIALLY (nose-ward)
        // socket: shallow, tight, and it fades out ~14 mm short of the midline
        // so the two sockets can never join across the bridge.
        const so = g.createRadialGradient(0, -3, 0, 0, -3, 19);
        so.addColorStop(0, 'rgba(46,28,18,0.15)');
        so.addColorStop(0.55, 'rgba(46,28,18,0.09)');
        so.addColorStop(1, 'rgba(46,28,18,0)');
        g.fillStyle = so;
        g.beginPath(); g.ellipse(0, -3, 19, 14, 0, 0, TAU); g.fill();
        // aperture: 27 × 10 mm — one tenth of the face width, not one half
        g.save();
        g.beginPath();
        g.moveTo(13.2, 1.0);                          // medial canthus
        g.quadraticCurveTo(2.0, -5.6, -13.4, -1.6);   // upper lid → lateral canthus
        g.quadraticCurveTo(-1.5, 4.6, 13.2, 1.0);     // lower lid
        g.closePath();
        g.clip();
        // sclera is never paper-white on a lit face
        g.fillStyle = '#aca698';
        g.fillRect(-16, -10, 32, 20);
        g.fillStyle = spec.irisColor;
        g.beginPath(); g.arc(0.4, -0.3, 5.2, 0, TAU); g.fill();
        g.fillStyle = '#100c08';
        g.beginPath(); g.arc(0.4, -0.3, 2.3, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.8)';
        g.beginPath(); g.arc(-1.5, -2.2, 1.2, 0, TAU); g.fill();
        // upper lash: a hairline sliver, clipped to the aperture
        g.fillStyle = 'rgba(30,19,12,0.72)';
        g.beginPath();
        g.moveTo(13.4, 0.4);
        g.quadraticCurveTo(2.0, -6.0, -13.6, -2.2);
        g.lineTo(-13.6, -4.4);
        g.quadraticCurveTo(2.0, -8.4, 13.4, -1.8);
        g.closePath(); g.fill();
        g.restore();
        // lower lid catchlight
        g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1.1;
        g.beginPath();
        g.moveTo(11.5, 2.2); g.quadraticCurveTo(-1.5, 5.4, -12.0, 0.4);
        g.stroke();
        // brow: ONE short arc per eye. Medial end stops 10 mm from the midline,
        // so ~21 mm of bare skin always separates the pair. Never a bar.
        g.strokeStyle = `rgba(${spec.browRGB},0.27)`;
        g.lineWidth = 4.2;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(25.0, -13.0);
        g.quadraticCurveTo(3.0, -18.4, -20.0, -13.6);
        g.stroke();
        g.lineCap = 'butt';
        g.restore();
      }

      // Nose. The sculpt pushes the tip 25 % of the head radius forward while
      // its UV barely moves, so paint laid on the nose is STRETCHED over the
      // underside — and the underside only catches green ground bounce. Dark
      // paint here turns into a black-green stain running down the middle of
      // the face. Keep it to a hint: the geometry already does the shading.
      {
        const ny = mmY(1.905);
        const ns = g.createRadialGradient(0, ny + 2, 0, 0, ny + 1, 10);
        ns.addColorStop(0, 'rgba(0,0,0,0.11)'); ns.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = ns;
        g.beginPath(); g.ellipse(0, ny + 1, 10, 7, 0, 0, TAU); g.fill();
        const oy = mmY(1.972);
        for (const sd of [-1, 1]) {
          g.fillStyle = 'rgba(20,11,7,0.36)';
          g.beginPath();
          g.ellipse(sd * 6.0, oy, 2.5, 1.5, sd * 0.45, 0, TAU);
          g.fill();
          g.strokeStyle = 'rgba(0,0,0,0.10)'; g.lineWidth = 1.2;
          g.beginPath();
          g.arc(sd * 7.4, oy - 1.6, 7.0, 0.5, 2.5);
          g.stroke();
        }
      }
      // mouth: lip line + a lit lower lip
      {
        const my = mmY(2.130);
        g.strokeStyle = 'rgba(52,22,16,0.50)'; g.lineWidth = 1.9;
        g.beginPath();
        g.moveTo(-22, my - 1.2);
        g.quadraticCurveTo(0, my + 3.4, 22, my - 1.2);
        g.stroke();
        const ly = mmY(2.180);
        g.strokeStyle = 'rgba(255,235,225,0.10)'; g.lineWidth = 2.6;
        g.beginPath();
        g.moveTo(-15, ly); g.quadraticCurveTo(0, ly + 2.4, 15, ly);
        g.stroke();
      }
      // Every shadow below the eye line is scaled by how light the skin is.
      // A floodlit head is already darkest under the jaw; on the deepest skin
      // tones another painted shadow there crushes the whole lower face into
      // one black mass — the same "mask" failure, one storey down.
      const lum = (() => {
        const c = new THREE.Color(spec.skin);
        return clamp(0.42 + 0.58 * (0.30 * c.r + 0.59 * c.g + 0.11 * c.b), 0, 1);
      })();
      // jaw / chin shadow — barely more than a suggestion.
      {
        const jy = mmY(2.60);
        const jg = g.createRadialGradient(0, jy, 0, 0, jy, 46);
        jg.addColorStop(0, `rgba(0,0,0,${(0.09 * lum).toFixed(3)})`);
        jg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = jg;
        g.beginPath(); g.ellipse(0, jy, 46, 32, 0, 0, TAU); g.fill();
      }
      if (spec.stubble) {
        // beard zone only: jaw, chin and the upper lip. The old version was a
        // head-wide disc that greyed the entire skull.
        const sy = mmY(2.30);
        const sgr = g.createRadialGradient(0, sy, 8, 0, sy, 68);
        sgr.addColorStop(0, `rgba(${spec.browRGB},${(0.15 * lum).toFixed(3)})`);
        sgr.addColorStop(0.62, `rgba(${spec.browRGB},${(0.10 * lum).toFixed(3)})`);
        sgr.addColorStop(1, `rgba(${spec.browRGB},0)`);
        g.fillStyle = sgr;
        g.beginPath(); g.ellipse(0, sy, 68, 50, 0, 0, TAU); g.fill();
      }
      g.restore();
    }
    // painted hair (under the geometric cap, prevents skin peeking at the rim)
    if (!spec.bald) {
      const hv = 1 - spec.hairFront / Math.PI - 0.035;   // painted hairline
      const bv = 1 - spec.hairBack / Math.PI - 0.04;     // painted nape line
      cRect(hc, 0, hv, 1, 1, spec.hair);
      cRect(hc, 0, bv, 0.26, hv + 0.03, spec.hair);
      cRect(hc, 0.74, bv, 1, hv + 0.03, spec.hair);
      // sideburns — SHORT. They live in front of the ear and stop above the
      // cheekbone; run them to the eye line and each temple grows a dark slab.
      for (const [u0, u1] of [[0.195, 0.265], [0.735, 0.805]]) {
        const [gu0, gv0] = cellUV(hc, u0, hv + 0.02), [gu1, gv1] = cellUV(hc, u1, hv - 0.075);
        const sbg = g.createLinearGradient(0, py(gv0), 0, py(gv1));
        sbg.addColorStop(0, spec.hair);
        sbg.addColorStop(0.45, `rgba(${hexRGB(spec.hair)},0.75)`);
        sbg.addColorStop(1, `rgba(${hexRGB(spec.hair)},0)`);
        g.fillStyle = sbg;
        g.fillRect(px(gu0), py(gv0), px(gu1 - gu0), py(gv1) - py(gv0));
      }
      // ~1 cm fade below the hairline and the nape, plus loose strands, so the
      // geometric cap edge never lands on a hard hair/skin step
      const hrgb = hexRGB(spec.hair);
      for (const [v0, v1] of [[hv, hv - 0.034], [bv, bv - 0.026]]) {
        const [gu0, gv0] = cellUV(hc, 0, v0), [gu1, gv1] = cellUV(hc, 1, v1);
        const fg = g.createLinearGradient(0, py(gv0), 0, py(gv1));
        fg.addColorStop(0, `rgba(${hrgb},0.92)`);
        fg.addColorStop(0.45, `rgba(${hrgb},0.42)`);
        fg.addColorStop(1, `rgba(${hrgb},0)`);
        g.fillStyle = fg;
        g.fillRect(px(gu0), py(gv0), px(gu1 - gu0), py(gv1) - py(gv0));
      }
      // loose strands hanging below the rim. Kept short and faint — long, dark
      // strands over the forehead read as a rash of dots at closeup range.
      for (let i = 0; i < 200; i++) {
        const u = rng();
        const base = u > 0.24 && u < 0.76 ? hv : bv;
        const d = rng();
        const [su3, sv3] = cellUV(hc, u, base - d * 0.022);
        g.fillStyle = `rgba(${hrgb},${(0.30 * (1 - d) + 0.06).toFixed(3)})`;
        g.fillRect(px(su3), py(sv3), 1.5, 2 + rng() * 3);
      }
    } else {
      // Shaved horseshoe. It MUST be feathered on all four sides: the old
      // version was three hard-edged rectangles, which printed a black slab
      // across the temple and jaw that read as a chinstrap from any 3/4 angle.
      // Painted as thin azimuth strips, each with its own vertical fade, and
      // the strip alpha falls to zero before it reaches the face.
      const vLo = 1 - 2.12 / Math.PI, vHi = 1 - 1.34 / Math.PI;
      for (let i = 0; i < 48; i++) {
        const u0 = i / 48, u1 = (i + 1) / 48;
        const a = Math.abs((0.5 - (u0 + u1) * 0.5) * TAU);
        const wgt = smooth01((a - 0.95) / 0.75) * (0.30 + 0.14 * smooth01((a - 2.1) / 0.9));
        if (wgt < 0.004) continue;
        const [gu0, gv0] = cellUV(hc, u0, vLo), [gu1, gv1] = cellUV(hc, u1, vHi);
        const bg = g.createLinearGradient(0, py(gv0), 0, py(gv1));
        bg.addColorStop(0, `rgba(${spec.hairRGB},0)`);
        bg.addColorStop(0.30, `rgba(${spec.hairRGB},${(wgt * 0.9).toFixed(3)})`);
        bg.addColorStop(0.72, `rgba(${spec.hairRGB},${wgt.toFixed(3)})`);
        bg.addColorStop(1, `rgba(${spec.hairRGB},0)`);
        g.fillStyle = bg;
        // integer-aligned so the strips tile exactly: a fractional edge would
        // antialias and print 48 faint vertical seams around the skull.
        const x0 = Math.round(px(gu0)), x1 = Math.round(px(gu1));
        g.fillRect(x0, Math.round(py(gv1)), x1 - x0, Math.round(py(gv0) - py(gv1)));
      }
    }

    // ---- hair cell (for the cap geometry) ----
    cRect(CELL.hair, 0, 0, 1, 1, spec.bald ? spec.skin : spec.hair);
    if (!spec.bald) {
      // darker at the rim, lighter on the crown → volume
      const [h0u, h0v] = cellUV(CELL.hair, 0, 0), [h1u, h1v] = cellUV(CELL.hair, 1, 1);
      const hg = g.createLinearGradient(0, py(h0v), 0, py(h1v));
      hg.addColorStop(0, 'rgba(0,0,0,0.35)');
      hg.addColorStop(0.55, 'rgba(0,0,0,0.05)');
      hg.addColorStop(1, 'rgba(255,255,255,0.07)');
      g.fillStyle = hg;
      g.fillRect(px(h0u), py(h1v), px(h1u - h0u), py(h0v) - py(h1v));
      for (let i = 0; i < 420; i++) {
        const [u, v] = cellUV(CELL.hair, rng(), rng());
        g.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.16)';
        g.fillRect(px(u), py(v), 1.5, 4);
      }
    }

    // ---- misc cell: ear · dark · skin · hair swatches ----
    // ATLAS PADDING: the whole cell is flooded with SKIN first and the dark
    // swatch is inset well inside its quadrant. Mip bleed across a swatch edge
    // can then only ever drag in skin — a dark cell bleeding into the ear cell
    // is what printed a hard rectangular patch on the keeper's cheek.
    cRect(CELL.misc, 0, 0, 1, 1, spec.skin);
    {
      const [e0u, e0v] = cellUV(SW_EAR, 0, 0), [e1u, e1v] = cellUV(SW_EAR, 1, 1);
      const cu = (e0u + e1u) / 2, cv = (e0v + e1v) / 2;
      const rr = px(e1u - e0u) * 0.5;
      // concha bowl occlusion + a lit helix rim
      const eg = g.createRadialGradient(px(cu), py(cv), 0, px(cu), py(cv), rr);
      eg.addColorStop(0, 'rgba(0,0,0,0.34)');
      eg.addColorStop(0.34, 'rgba(0,0,0,0.20)');
      eg.addColorStop(0.72, 'rgba(0,0,0,0.04)');
      eg.addColorStop(0.88, 'rgba(255,255,255,0.10)');
      eg.addColorStop(1, 'rgba(0,0,0,0.05)');
      g.fillStyle = eg;
      g.fillRect(px(e0u), py(e1v), px(e1u - e0u), py(e0v) - py(e1v));
    }
    cRect(SW_DARK, 0.14, 0.14, 0.86, 0.86, '#141418');
    cRect(SW_SKIN, 0, 0, 1, 1, spec.skin);
    cRect(SW_HAIR, 0.10, 0.10, 0.90, 0.90, spec.bald ? spec.skin : spec.hair);
  }, { anisotropy: 8 });
}

// ---------------------------------------------------------------------------
// Shared material maps. The atlas layout is identical for every player, so the
// roughness/normal response is identical too — build once, share across all 23
// meshes. Roughness is what gives hair its anisotropic-looking crown band and
// skin its floodlit sheen; without it every surface is one matte value.
// ---------------------------------------------------------------------------
let SHARED_MAPS = null;
function sharedMaps(rng) {
  if (SHARED_MAPS) return SHARED_MAPS;
  const S = 512;
  const fill = (g, cell, v, u0 = 0, u1 = 1, v0 = 0, v1 = 1) => {
    const a = cellUV(cell, u0, v0), b = cellUV(cell, u1, v1);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(a[0] * S, (1 - b[1]) * S, (b[0] - a[0]) * S, (b[1] - a[1]) * S);
  };
  const rough = makeCanvasTexture(S, S, (g) => {
    g.fillStyle = 'rgb(210,210,210)';
    g.fillRect(0, 0, S, S);
    for (const c of [CELL.torsoF, CELL.torsoB, CELL.arm]) fill(g, c, 218);
    fill(g, CELL.leg, 218);
    fill(g, CELL.leg, 200, 0, 1, 0, legV(0.452));            // socks
    fill(g, CELL.arm, 140, 0, 1, 0, armV(1.246));            // skin: sheen
    fill(g, CELL.leg, 140, 0, 1, legV(0.452), SHORTS_V0);
    fill(g, CELL.head, 138);
    fill(g, CELL.misc, 138);
    // Hair is NOT lacquer. At roughness ~0.54 the crown catches a hard specular
    // sheet from the floodlights and every strand bump sparkles — the cap reads
    // as a wet swimming cap. Matte it right down and leave only a soft band.
    fill(g, CELL.hair, 186);
    // anisotropic band across the crown
    const hb = cellUV(CELL.hair, 0, 0.58), hb2 = cellUV(CELL.hair, 1, 0.84);
    const grd = g.createLinearGradient(0, (1 - hb2[1]) * S, 0, (1 - hb[1]) * S);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.5, 'rgba(146,146,146,0.7)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(hb[0] * S, (1 - hb2[1]) * S, (hb2[0] - hb[0]) * S, (hb2[1] - hb[1]) * S);
    fill(g, CELL.boot, 108);                                 // boot upper
    fill(g, CELL.boot, 178, 0, 1, 0, 0.18);                  // soleplate
  }, { colorSpace: THREE.NoColorSpace });

  // Normal map: a greyscale height field painted with the 2D API, then Sobel'd
  // into tangent-space normals. Gives the jersey a weave and drape wrinkles,
  // the socks a rib, and the boot a welt/lace relief — the difference between
  // cloth and body paint under a raking floodlight.
  const NS = 512;
  const norm = makeCanvasTexture(NS, NS, (g, W, Hh) => {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = Hh;
    const h = cv.getContext('2d');
    const pxu = (u) => u * W, pyv = (v) => (1 - v) * Hh;
    const cr = (cell, u0, v0, u1, v1, style) => {
      const a = cellUV(cell, u0, v0), b = cellUV(cell, u1, v1);
      h.fillStyle = style;
      h.fillRect(pxu(a[0]), pyv(b[1]), pxu(b[0] - a[0]), pyv(a[1]) - pyv(b[1]));
    };
    h.fillStyle = '#808080';
    h.fillRect(0, 0, W, Hh);
    // fabric weave — CLOTH REGIONS ONLY. Running it over the whole cell puts an
    // orange-peel on every arm and thigh, which is worse than flat skin.
    const weave = [
      [CELL.torsoF, 0, torsoV(1.505)], [CELL.torsoB, 0, torsoV(1.505)],
      [CELL.arm, armV(1.256), 1], [CELL.leg, SHORTS_V0, 1], [CELL.leg, 0, legV(0.452)],
    ];
    for (const [cell, v0, v1] of weave) {
      const n = Math.round(4200 * (v1 - v0));
      for (let i = 0; i < n; i++) {
        const a = cellUV(cell, rng(), lerp(v0, v1, rng()));
        h.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.20)' : 'rgba(0,0,0,0.20)';
        h.fillRect(pxu(a[0]), pyv(a[1]), 1, 1);
      }
    }
    h.filter = 'blur(2px)';
    // drape folds, matching the painted ones
    for (const cell of [CELL.torsoF, CELL.torsoB]) {
      for (let f = 0; f < 4; f++) {
        const a0 = cellUV(cell, 0.5 + (0.32 - 0.04 * f), torsoV(1.30 - 0.05 * f));
        const a1 = cellUV(cell, 0.5 - (0.16 + 0.04 * f), torsoV(1.10 - 0.04 * f));
        h.strokeStyle = '#b4b4b4'; h.lineWidth = W * 0.008; h.lineCap = 'round';
        h.beginPath(); h.moveTo(pxu(a0[0]), pyv(a0[1]));
        h.quadraticCurveTo(pxu((a0[0] + a1[0]) * 0.5), pyv((a0[1] + a1[1]) * 0.5 - 0.010),
          pxu(a1[0]), pyv(a1[1]));
        h.stroke();
        h.strokeStyle = '#4c4c4c'; h.lineWidth = W * 0.004;
        h.beginPath(); h.moveTo(pxu(a0[0]), pyv(a0[1]) + W * 0.008);
        h.quadraticCurveTo(pxu((a0[0] + a1[0]) * 0.5), pyv((a0[1] + a1[1]) * 0.5 - 0.010) + W * 0.008,
          pxu(a1[0]), pyv(a1[1]) + W * 0.008);
        h.stroke();
      }
      cr(cell, 0, 0.060, 1, 0.072, '#c8c8c8');   // hem roll ridge
      cr(cell, 0, torsoV(1.508), 1, torsoV(1.516), '#5a5a5a');
    }
    h.filter = 'none';
    // collar + cuff rib knit
    for (let i = 0; i < 48; i++) {
      cr(CELL.torsoF, i / 48, torsoV(1.510), i / 48 + 0.010, torsoV(1.532), '#a0a0a0');
      cr(CELL.torsoB, i / 48, torsoV(1.510), i / 48 + 0.010, torsoV(1.532), '#a0a0a0');
      cr(CELL.arm, i / 48, armV(1.272), i / 48 + 0.010, armV(1.291), '#a0a0a0');
    }
    // sock rib
    for (let i = 0; i < 22; i++) {
      cr(CELL.leg, i / 22, 0.02, i / 22 + 0.020, legV(0.452), '#9c9c9c');
    }
    // shorts hem lip + side seam
    cr(CELL.leg, 0, SHORTS_V0 + 0.018, 1, SHORTS_V0 + 0.030, '#c0c0c0');
    for (const u of [0.25, 0.75]) cr(CELL.leg, u - 0.004, SHORTS_V0 + 0.03, u + 0.004, 0.99, '#6a6a6a');
    // boot: welt ridge, heel counter seam, lace band
    cr(CELL.boot, 0, 0.175, 1, 0.200, '#cccccc');
    cr(CELL.boot, 0.128, 0.30, 0.142, 0.82, '#5c5c5c');
    for (let i = 0; i < 5; i++) cr(CELL.boot, 0.16 + i * 0.05, 0.88, 0.19 + i * 0.05, 1.0, '#b8b8b8');
    // hair strands
    for (let i = 0; i < 900; i++) {
      const a = cellUV(CELL.hair, rng(), rng());
      h.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)';
      h.fillRect(pxu(a[0]), pyv(a[1]), 1.5, 5);
    }

    const src = h.getImageData(0, 0, W, Hh).data;
    const out = g.createImageData(W, Hh);
    const at = (x, y) => src[((y & (Hh - 1)) * W + (x & (W - 1))) * 4];
    const k = 1.5;
    for (let y = 0; y < Hh; y++) {
      for (let x = 0; x < W; x++) {
        const du = (at(x + 1, y) - at(x - 1, y)) / 255 * k;
        const dv = -(at(x, y + 1) - at(x, y - 1)) / 255 * k;
        const l = Math.hypot(du, dv, 1);
        const i = (y * W + x) * 4;
        out.data[i] = Math.round((-du / l * 0.5 + 0.5) * 255);
        out.data[i + 1] = Math.round((-dv / l * 0.5 + 0.5) * 255);
        out.data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
        out.data[i + 3] = 255;
      }
    }
    g.putImageData(out, 0, 0);
  }, { colorSpace: THREE.NoColorSpace });

  SHARED_MAPS = { rough, norm };
  return SHARED_MAPS;
}

// ---------------------------------------------------------------------------
// Skeleton. All positions canonical × s (s = height/1.80). Bones have zero
// rest rotation; direction lives in child offsets, so animation rotations are
// deltas from the bind pose.
// ---------------------------------------------------------------------------
function buildSkeleton(s) {
  const B = new Array(BONE_COUNT);
  const mk = (i, name, x, y, z) => {
    const b = new THREE.Bone();
    b.name = name; b.position.set(x * s, y * s, z * s);
    B[i] = b; return b;
  };
  const hips = mk(BI.hips, 'hips', 0, J.hipsBone, 0);
  const spine = mk(BI.spine, 'spine', 0, J.spine - J.hipsBone, 0);
  const chest = mk(BI.chest, 'chest', 0, J.chest - J.spine, 0);
  const neck = mk(BI.neck, 'neck', 0, J.neckBase - J.chest, 0);
  const head = mk(BI.head, 'head', 0, J.neckTop - J.neckBase, 0);
  hips.add(spine); spine.add(chest); chest.add(neck); neck.add(head);
  for (const side of [-1, 1]) { // -1 = L (−Z), +1 = R (+Z)
    const o = side < 0 ? 0 : 4;
    const clav = mk(BI.clavL + o, side < 0 ? 'clavL' : 'clavR', 0, J.clavY - J.chest, side * J.clavLat);
    const uarm = mk(BI.uarmL + o, side < 0 ? 'uarmL' : 'uarmR', 0, J.shoulder - J.clavY, side * (J.shoulderLat - J.clavLat));
    const farm = mk(BI.farmL + o, side < 0 ? 'farmL' : 'farmR', 0, J.elbow - J.shoulder, side * (J.elbowLat - J.shoulderLat));
    const hand = mk(BI.handL + o, side < 0 ? 'handL' : 'handR', 0, J.wrist - J.elbow, side * (J.wristLat - J.elbowLat));
    chest.add(clav); clav.add(uarm); uarm.add(farm); farm.add(hand);
    const ol = side < 0 ? 0 : 3;
    const thigh = mk(BI.thighL + ol, side < 0 ? 'thighL' : 'thighR', 0, J.hip - J.hipsBone, side * J.hipLat);
    const shin = mk(BI.shinL + ol, side < 0 ? 'shinL' : 'shinR', 0, J.knee - J.hip, 0);
    const foot = mk(BI.footL + ol, side < 0 ? 'footL' : 'footR', 0, J.ankle - J.knee, 0);
    hips.add(thigh); thigh.add(shin); shin.add(foot);
  }
  return B;
}

// ---------------------------------------------------------------------------
// Ring tables. TORSO / ARM / LEG listed TOP → BOTTOM.
// ---------------------------------------------------------------------------

// [y, rx(depth), rz(half-width), ia, wa, ib, wb]
// The torso tube is BODY + SHIRT only: it ends in a rolled, scalloped shirt hem
// at y≈0.95 that hangs free over the shorts shell (see SHORTS_RINGS). Nothing
// below the hem belongs to this tube — the old "shorts painted on the torso"
// section is what produced the peplum/second-hem read.
const TORSO_RINGS = [
  // the top three rings live INSIDE the head shell and plug its open base
  [1.606, 0.013, 0.012, BI.head, 0.85, BI.neck, 0.15],
  [1.598, 0.028, 0.027, BI.head, 0.50, BI.neck, 0.50],
  [1.588, 0.038, 0.038, BI.neck, 0.85, BI.head, 0.15],
  [1.576, 0.046, 0.047, BI.neck, 1.00, BI.head, 0.00],
  [1.560, 0.052, 0.055, BI.neck, 1.00, BI.head, 0.00],
  [1.545, 0.057, 0.060, BI.neck, 1.00, BI.head, 0.00],
  [1.533, 0.061, 0.066, BI.neck, 0.86, BI.chest, 0.14],   // sternocleidomastoid
  [1.527, 0.073, 0.084, BI.neck, 0.55, BI.chest, 0.45],   // ribbed collar, top rim
  [1.518, 0.077, 0.091, BI.chest, 0.72, BI.neck, 0.28],   // collar band
  [1.508, 0.081, 0.110, BI.chest, 0.82, BI.neck, 0.18],   // collar base
  [1.496, 0.091, 0.146, BI.chest, 0.92, BI.neck, 0.08],   // trapezius slope
  [1.478, 0.106, 0.181, BI.chest, 1.00, BI.spine, 0.00],
  [1.458, 0.120, 0.202, BI.chest, 1.00, BI.spine, 0.00],  // acromion / shoulder line
  [1.430, 0.132, 0.210, BI.chest, 1.00, BI.spine, 0.00],
  [1.395, 0.140, 0.213, BI.chest, 1.00, BI.spine, 0.00],  // chest / lat peak
  [1.352, 0.143, 0.209, BI.chest, 1.00, BI.spine, 0.00],
  [1.305, 0.140, 0.197, BI.chest, 0.82, BI.spine, 0.18],
  [1.255, 0.133, 0.181, BI.spine, 0.58, BI.chest, 0.42],
  [1.205, 0.127, 0.171, BI.spine, 0.88, BI.chest, 0.12],
  [1.160, 0.123, 0.165, BI.spine, 0.78, BI.hips, 0.22],   // waist (wider → V torso)
  [1.115, 0.121, 0.163, BI.hips, 0.55, BI.spine, 0.45],
  [1.070, 0.123, 0.168, BI.hips, 0.80, BI.spine, 0.20],
  [1.030, 0.126, 0.177, BI.hips, 1.00, BI.spine, 0.00],   // hip (narrower than chest)
  [0.995, 0.130, 0.190, BI.hips, 1.00, BI.spine, 0.00],   // shirt starts to hang free
  [0.968, 0.132, 0.199, BI.hips, 1.00, BI.spine, 0.00, 0.55],
  [0.952, 0.131, 0.198, BI.hips, 1.00, BI.spine, 0.00, 1.00],   // hem outer edge (scalloped)
  [0.9455, 0.106, 0.170, BI.hips, 1.00, BI.spine, 0.00, 1.00],  // hem under-bevel (dark)
  [0.958, 0.092, 0.136, BI.hips, 1.00, BI.spine, 0.00, 0.70],   // hem return, inside the shorts
];

// Shirt hem free edge: scallop + a deeper dip at the side seams, in meters.
const shirtHem = (a) => 0.006 * Math.cos(3 * a) - 0.007 * Math.abs(Math.sin(a));

// Shorts shell: ONE garment, two lobes fused at the crotch. Each ring is the
// boundary of the union of two ellipses (half-axes Rx,Rz) centred at z = ±d, so
// the shell always strictly contains both thighs — no seam, no hole, one hem.
// [y, Rx, Rz, d, wThigh, hemK]
const SHORTS_RINGS = [
  [1.055, 0.112, 0.134, 0.026, 0.00, 0],
  [1.020, 0.116, 0.138, 0.034, 0.00, 0],
  [0.985, 0.120, 0.140, 0.044, 0.05, 0],
  [0.950, 0.124, 0.136, 0.052, 0.14, 0],
  [0.905, 0.129, 0.128, 0.068, 0.32, 0],
  [0.860, 0.129, 0.124, 0.080, 0.55, 0],
  [0.815, 0.124, 0.118, 0.086, 0.72, 0.35],
  [0.785, 0.119, 0.114, 0.088, 0.82, 1.00],   // hem, flared clear of the quad
  [0.772, 0.114, 0.109, 0.088, 0.86, 1.00],   // hem edge loop
  [0.763, 0.099, 0.093, 0.088, 0.88, 0.85],   // under-bevel (goes dark)
  [0.757, 0.083, 0.079, 0.088, 0.90, 0.60],   // tucks inside the thigh
];
// Shorts hem: a soft scallop, gently lifted toward the outer seam. The lift
// used to be 30 mm concentrated in a narrow band at |a| = π/2 (a "side split"),
// which cut a hard NOTCH out of the hip silhouette and exposed the dark hem
// underside as a bar. A hem is a smooth closed curve — keep the modulation
// low-order and shallow so the outline never steps.
const shortsHem = (a) => 0.009 * Math.pow(Math.sin(a), 2) + 0.004 * Math.cos(4 * a);

// [y, r, lat, cx, roleA, wA, roleB, wB]
const ARM_RINGS = [
  [1.492, 0.018, 0.1440, 0.000, 'chest', 0.80, 'uarm', 0.20],  // buried in the trap
  [1.484, 0.034, 0.1480, 0.000, 'chest', 0.66, 'uarm', 0.34],
  [1.470, 0.050, 0.1545, 0.000, 'chest', 0.46, 'uarm', 0.54],
  [1.450, 0.060, 0.1600, 0.000, 'chest', 0.26, 'uarm', 0.74],
  [1.422, 0.0648, 0.1665, -0.001, 'chest', 0.10, 'uarm', 0.90], // deltoid peak
  [1.385, 0.0630, 0.170, -0.002, 'uarm', 1.00, 'chest', 0.00],
  [1.352, 0.0592, 0.175, -0.003, 'uarm', 1.00, 'farm', 0.00],  // biceps
  [1.316, 0.0556, 0.180, -0.004, 'uarm', 1.00, 'farm', 0.00],
  [1.292, 0.0548, 0.1840, -0.004, 'uarm', 1.00, 'farm', 0.00],
  [1.280, 0.0596, 0.1852, -0.004, 'uarm', 1.00, 'farm', 0.00], // rolled cuff, flare
  [1.271, 0.0592, 0.1858, -0.004, 'uarm', 1.00, 'farm', 0.00], // cuff free edge
  [1.264, 0.0508, 0.1866, -0.004, 'uarm', 1.00, 'farm', 0.00], // cuff under-turn
  [1.256, 0.0492, 0.1872, -0.004, 'uarm', 0.97, 'farm', 0.03],
  [1.226, 0.0470, 0.1888, -0.004, 'uarm', 0.82, 'farm', 0.18],
  [1.186, 0.0440, 0.1928, -0.003, 'uarm', 0.58, 'farm', 0.42],
  [1.158, 0.0424, 0.1958, -0.005, 'uarm', 0.44, 'farm', 0.56], // elbow
  [1.140, 0.0436, 0.1975, -0.009, 'farm', 0.72, 'uarm', 0.28], // olecranon point
  [1.115, 0.0455, 0.1995, -0.004, 'farm', 0.90, 'uarm', 0.10],
  [1.080, 0.0468, 0.2020, 0.000, 'farm', 1.00, 'hand', 0.00],  // forearm belly
  [1.035, 0.0436, 0.2045, 0.000, 'farm', 1.00, 'hand', 0.00],
  [0.985, 0.0375, 0.2080, 0.000, 'farm', 1.00, 'hand', 0.00],
  [0.935, 0.0306, 0.2120, 0.000, 'farm', 0.94, 'hand', 0.06],
  [0.902, 0.0264, 0.2145, 0.000, 'farm', 0.70, 'hand', 0.30],
  [0.888, 0.0250, 0.2155, 0.000, 'farm', 0.45, 'hand', 0.55], // wrist
];

// Hand. Palm faces medially, so the broad faces point along ±Z and the
// index→pinky breadth runs across ±X (index forward at +X). The palm is a
// rounded slab that is 1.6× the WRIST breadth, closed by a web cap that the
// four separated digits grow out of — no paddle, no painted grooves.
// [y, halfX (breadth), halfZ (thickness), cx, cIn (medial drift)]
const PALM_RINGS = [
  [0.9065, 0.0268, 0.0258, 0.000, 0.000],  // swallows the open end of the arm
  [0.8910, 0.0300, 0.0262, 0.001, 0.000],
  [0.8700, 0.0344, 0.0248, 0.003, 0.001],
  [0.8480, 0.0392, 0.0231, 0.005, 0.003],
  [0.8270, 0.0418, 0.0219, 0.007, 0.005],
  [0.8100, 0.0424, 0.0206, 0.008, 0.007], // knuckle row (dorsal bumps)
  [0.8010, 0.0412, 0.0183, 0.009, 0.008],
];
// Four digits: [x offset, radius, length, total curl (rad)]. The cascade is the
// resting hand: index nearly straight, pinky curled most.
const FINGERS = [
  [0.0322, 0.0090, 0.0735, 0.52],
  [0.0108, 0.0094, 0.0795, 0.76],
  [-0.0108, 0.0086, 0.0740, 0.99],
  [-0.0316, 0.0073, 0.0600, 1.24],
];

// [y, rx, rz, cx, roleA, wA, roleB, wB]
// Pure body from hip to ankle — the shorts are their own shell now. Shaped for
// anatomy: quad mass, a patella plate weighted to the SHIN (so it rides forward
// and the hollow opens behind the joint when the knee bends), a high
// gastrocnemius belly set back from the shin axis, and a narrow achilles.
const LEG_RINGS = [
  // The top two rings are buried inside the pelvis and the shorts shell. They
  // are deliberately narrow: at full hip width they land exactly ON the torso
  // surface and the two skins saw against each other, printing a black zigzag
  // of shorts-coloured triangles across the waist.
  [1.010, 0.075, 0.070, 0.000, 'hips', 0.45, 'thigh', 0.55],
  [0.950, 0.089, 0.082, -0.002, 'thigh', 0.85, 'hips', 0.15],
  [0.885, 0.099, 0.094, -0.002, 'thigh', 1.00, 'shin', 0.00],
  [0.830, 0.095, 0.090, -0.002, 'thigh', 1.00, 'shin', 0.00],
  [0.790, 0.091, 0.0865, -0.002, 'thigh', 1.00, 'shin', 0.00],
  [0.740, 0.087, 0.0825, -0.002, 'thigh', 1.00, 'shin', 0.00],
  [0.680, 0.081, 0.0770, -0.001, 'thigh', 1.00, 'shin', 0.00],
  [0.620, 0.0735, 0.0695, 0.000, 'thigh', 1.00, 'shin', 0.00],
  [0.580, 0.0685, 0.0640, 0.001, 'thigh', 0.88, 'shin', 0.12], // vastus flare
  [0.552, 0.0645, 0.0600, 0.003, 'thigh', 0.62, 'shin', 0.38],
  [0.532, 0.0620, 0.0575, 0.006, 'thigh', 0.38, 'shin', 0.62], // patella (rides fwd)
  [0.512, 0.0605, 0.0560, 0.006, 'thigh', 0.18, 'shin', 0.82],
  [0.492, 0.0595, 0.0558, 0.000, 'shin', 0.90, 'thigh', 0.10],
  [0.470, 0.0625, 0.0595, -0.008, 'shin', 1.00, 'thigh', 0.00],
  [0.452, 0.0672, 0.0648, -0.013, 'shin', 1.00, 'foot', 0.00], // sock turnover
  [0.436, 0.0690, 0.0662, -0.017, 'shin', 1.00, 'foot', 0.00],
  [0.415, 0.0715, 0.0680, -0.021, 'shin', 1.00, 'foot', 0.00], // gastrocnemius
  [0.380, 0.0680, 0.0640, -0.021, 'shin', 1.00, 'foot', 0.00],
  [0.340, 0.0595, 0.0555, -0.018, 'shin', 1.00, 'foot', 0.00],
  [0.290, 0.0490, 0.0450, -0.014, 'shin', 1.00, 'foot', 0.00],
  [0.235, 0.0395, 0.0360, -0.008, 'shin', 0.92, 'foot', 0.08],
  [0.185, 0.0330, 0.0300, -0.004, 'shin', 0.70, 'foot', 0.30], // achilles
  [0.140, 0.0308, 0.0282, -0.001, 'shin', 0.40, 'foot', 0.60],
  [0.105, 0.0315, 0.0288, 0.001, 'shin', 0.18, 'foot', 0.82], // malleoli
  [0.078, 0.0300, 0.0275, 0.002, 'foot', 1.00, 'shin', 0.00],
];

// Boot stations heel→toe: [x, soleBottomY, soleTopY, upperTopY, halfWidth].
// A real last: 26 cm long over an 8.6 cm width, heel counter curving up and
// back, a low laced vamp, a rounded toe box. Studs hang below soleBottomY, so
// STUD_Y (not the outsole) is the ground contact plane.
const BOOT_STATIONS = [
  [-0.068, 0.022, 0.036, 0.088, 0.025],
  [-0.058, 0.012, 0.032, 0.108, 0.031],   // heel counter
  [-0.032, 0.009, 0.029, 0.102, 0.037],
  [-0.004, 0.008, 0.027, 0.097, 0.040],
  [0.030, 0.008, 0.025, 0.093, 0.042],    // instep / vamp
  [0.068, 0.008, 0.023, 0.083, 0.043],
  [0.106, 0.008, 0.022, 0.069, 0.042],
  [0.142, 0.009, 0.022, 0.055, 0.038],
  [0.172, 0.011, 0.024, 0.041, 0.030],    // toe box
  [0.192, 0.017, 0.027, 0.030, 0.017],
];
// Conical studs: [x, |z|, radius]. Mirrored in z unless |z| is 0.
const BOOT_STUDS = [
  [0.163, 0.000, 0.0060], [0.138, 0.028, 0.0062], [0.100, 0.036, 0.0064],
  [0.058, 0.036, 0.0064], [0.020, 0.033, 0.0060],
  [-0.052, 0.021, 0.0066], [-0.030, 0.029, 0.0064],
];
const STUD_Y = 0.0015;   // stud tip height in model space = ground contact

// ---------------------------------------------------------------------------
// Body builders
// ---------------------------------------------------------------------------

function buildTorso(acc, s, bw, bd) {
  startPart(acc);
  // vy: the hem's under-bevel and inside return are physically at ~0.95 but
  // must sample the dark bottom of the cell — without it the dark underside
  // paint lands on the OUTER face and prints a black zigzag along the hem.
  const HEM_VY = { 0.968: 0.966, 0.952: 0.950, 0.9455: 0.928, 0.958: 0.907 };
  const rings = TORSO_RINGS.map(([y, rx, rz, ia, wa, ib, wb, hk]) => ({
    y: y * s, rx: rx * bd * s, rz: rz * bw * s, w: [ia, wa, ib, wb], hk: (hk || 0) * s,
    vy: HEM_VY[y] !== undefined ? HEM_VY[y] * s : undefined,
  }));
  const tv = (y) => torsoV(y / s);
  const opts = { edgeFn: shirtHem };
  // front: a from +90° → −90°   (u: viewer-left → viewer-right, text unmirrored)
  buildTubeY(acc, rings, 22, Math.PI / 2, -Math.PI / 2, CELL.torsoF, tv, torsoU, opts);
  // back: a from 270° → 90° (through 180° = −X back centre)
  buildTubeY(acc, rings, 22, Math.PI * 1.5, Math.PI / 2, CELL.torsoB, tv, torsoU, opts);
  // close the shirt tube from below (buried inside the shorts shell)
  startPart(acc);
  const bot = rings[rings.length - 1];
  const rows = [];
  const seg = 12;
  const [du, dv] = flatUV(SW_DARK);
  const row = [];
  for (let c = 0; c <= seg; c++) {
    const a = (c / seg) * TAU;
    row.push(pushVert(acc, bot.rx * 0.94 * Math.cos(a), bot.y, bot.rz * 0.94 * Math.sin(a),
      0, -1, 0, du, dv, BI.hips, 1, BI.spine, 0));
  }
  rows.push(row);
  fanRing(acc, row, 0, bot.y - 0.012 * s, 0, 0, -1, 0, [du, dv], [BI.hips, 1, BI.spine, 0], false);
}

// Distance from the pelvis axis to the boundary of the union of two ellipses
// (half-axes rx,rz) centred at z = ±d, along the ray at azimuth a. d < rz keeps
// the union star-shaped about the axis, so this traces the outline exactly and
// — since each thigh ellipse is concentric with and smaller than its lobe — the
// shell provably contains both legs at every height. No hip hole is possible.
function lobeR(a, rx, rz, d) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const A = (ca * ca) / (rx * rx) + (sa * sa) / (rz * rz);
  const C = (d * d) / (rz * rz) - 1;
  let best = 0;
  for (let i = 0; i < 2; i++) {
    const sd = i ? -d : d;
    const B = (-2 * sd * sa) / (rz * rz);
    const disc = B * B - 4 * A * C;
    if (disc <= 0) continue;
    const t = (-B + Math.sqrt(disc)) / (2 * A);
    if (t > best) best = t;
  }
  return best;
}

function buildShorts(acc, s, bw, bd) {
  startPart(acc);
  const seg = 30;
  const rows = [];
  for (let k = SHORTS_RINGS.length - 1; k >= 0; k--) {   // bottom → top
    const [y, Rx, Rz, d, wT, hemK] = SHORTS_RINGS[k];
    const rx = Rx * bd * s, rz = Rz * bw * s, dd = d * s;
    const row = [];
    for (let c = 0; c <= seg; c++) {
      const t = c / seg;
      const a = lerp(TAU, 0, t);                          // decreasing → outward
      const r = lobeR(a, rx, rz, dd);
      const x = r * Math.cos(a), z = r * Math.sin(a);
      const yy = y * s + hemK * shortsHem(a) * s;
      // cloth follows the thigh on the lobes and the pelvis at the crotch
      const wt = wT * smooth01((Math.abs(z) / (dd + rz)) * 1.7);
      const bone = z < 0 ? BI.thighL : BI.thighR;
      const [u, v] = cellUVg(CELL.leg, 1 - t, shortsV(y));
      row.push(pushVert(acc, x, yy, z, Math.cos(a), 0, Math.sin(a), u, v,
        bone, wt, BI.hips, 1 - wt));
    }
    rows.push(row);
  }
  connectRows(acc, rows);
}

function buildArm(acc, s, bw, bd, side, roleMap) {
  startPart(acc);
  const rings = ARM_RINGS.map(([y, r, lat, cx, ra, wa, rb, wb]) => ({
    y: y * s, rx: r * bd * s, rz: r * bw * s,
    cx: cx * s, cz: side * lat * s, w: [roleMap[ra], wa, roleMap[rb], wb],
  }));
  const av = (y) => armV(y / s);
  // capBottom: the wrist end is buried in the palm — an open ring there shows
  // as a black speck through the hand at closeup range.
  buildTubeY(acc, rings, 12, TAU, 0, CELL.arm, av, (t) => 1 - t,
    { capTop: true, capBottom: true });
}

// Swept tube along a path in the X = const plane (digits curl in Y/Z only).
// Rows run base → tip with φ increasing, which yields outward-facing triangles.
function sweptDigit(acc, pts, radii, seg, uv, w) {
  const rows = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const pa = pts[Math.max(0, i - 1)], pb = pts[Math.min(n - 1, i + 1)];
    let ty = pb[1] - pa[1], tz = pb[2] - pa[2];
    const tl = Math.hypot(ty, tz) || 1; ty /= tl; tz /= tl;
    const row = [];
    for (let c = 0; c <= seg; c++) {
      const f = (c / seg) * TAU;
      const cf = Math.cos(f), sf = Math.sin(f);
      // n1 = X axis, n2 = T × n1
      const x = p[0] + radii[i] * cf;
      const y = p[1] + radii[i] * sf * tz;
      const z = p[2] - radii[i] * sf * ty;
      row.push(pushVert(acc, x, y, z, cf, sf * tz, -sf * ty,
        uv[0] + (c / seg) * uv[2], uv[1], w[0], w[1], w[2], w[3]));
    }
    rows.push(row);
  }
  connectRows(acc, rows);
  const tip = pts[n - 1];
  fanRing(acc, rows[n - 1], tip[0], tip[1] - radii[n - 1] * 0.55, tip[2],
    0, -1, 0, [uv[0] + uv[2] * 0.5, uv[1]], w, false);
}

function buildHand(acc, s, bw, side, roleMap) {
  const lat = J.wristLat;
  const cz0 = side * lat * s;
  const w = [roleMap.hand, 1, roleMap.farm, 0];
  const seg = 14;
  // ---- palm slab ----
  startPart(acc);
  const rows = [];
  const knuckleY = PALM_RINGS[5][0];
  for (let k = 0; k < PALM_RINGS.length; k++) {
    const [ry, hx, hz, cx, cin] = PALM_RINGS[k];
    const row = [];
    const kb = gs(ry, knuckleY, 0.011);            // knuckle bump envelope
    for (let c = 0; c <= seg; c++) {
      const f = (c / seg) * TAU;
      const cf = Math.cos(f), sf = Math.sin(f);
      const bx = se(cf, 0.70), bz = se(sf, 0.70);  // rounded slab section
      // knuckles ride the DORSAL face only (dorsum faces +side·Z)
      const dorsal = bz * side > 0 ? Math.abs(bz) : 0;
      const bpx = hx * bx;
      const bump = kb * dorsal * 0.0040 *
        (gs(bpx, 0.0322, 0.010) + gs(bpx, 0.0108, 0.010) +
         gs(bpx, -0.0108, 0.010) + gs(bpx, -0.0316, 0.009));
      const x = (cx + bpx) * s;
      const z = cz0 - side * cin * s + (hz * bw + bump) * s * bz;
      const [u, v] = cellUVg(CELL.arm, 0.42 + 0.16 * (c / seg), armV(ry));
      row.push(pushVert(acc, x, ry * s, z, bx, 0, bz, u, v, w[0], w[1], w[2], w[3]));
    }
    rows.push(row);
  }
  connectRows(acc, rows);
  { // web cap the digits grow out of
    const [ry, , , cx] = PALM_RINGS[PALM_RINGS.length - 1];
    const [u, v] = cellUVg(CELL.arm, 0.5, armV(ry));
    fanRing(acc, rows[rows.length - 1], cx * s, ry * s, cz0, 0, -1, 0, [u, v], w, false);
  }
  // ---- four digits, resting cascade ----
  for (let i = 0; i < FINGERS.length; i++) {
    const [fx, fr, fl, curl] = FINGERS[i];
    startPart(acc);
    const nseg = 4;
    const pts = [], radii = [];
    let y = (knuckleY + 0.006) * s, z = cz0 - side * 0.008 * s, ang = 0;
    const step = (fl / nseg) * s;
    for (let k = 0; k <= nseg; k++) {
      if (k > 0) {
        ang += (curl / nseg) * (0.55 + 0.55 * (k / nseg));
        y -= step * Math.cos(ang);
        z -= side * step * Math.sin(ang);
      }
      // splay: tips fan slightly apart
      pts.push([(fx * (1 + 0.10 * (k / nseg))) * s, y, z]);
      radii.push(fr * (k === 0 ? 1.06 : 1 - 0.16 * (k / nseg)) * s);
    }
    const uvv = cellUVg(CELL.arm, 0.5, armV(0.775));
    sweptDigit(acc, pts, radii, 8, [uvv[0] - 0.010, uvv[1], 0.020], w);
  }
  // ---- opposed thumb: rotated out of the shorts seam and forward ----
  {
    startPart(acc);
    const pts = [], radii = [];
    let x = 0.014 * s, y = 0.872 * s, z = cz0 + side * 0.002 * s;
    const dirs = [[0.62, -0.70, 0.16], [0.80, -0.52, 0.12], [0.86, -0.42, 0.06]];
    const rs = [0.0118, 0.0104, 0.0086, 0.0058];
    pts.push([x, y, z]); radii.push(rs[0] * s);
    for (let k = 0; k < 3; k++) {
      const d = dirs[k], L = 0.021 * s;
      x += d[0] * L; y += d[1] * L; z += side * d[2] * L;
      pts.push([x, y, z]); radii.push(rs[k + 1] * s);
    }
    const uvv = cellUVg(CELL.arm, 0.62, armV(0.800));
    sweptDigit(acc, pts, radii, 8, [uvv[0] - 0.008, uvv[1], 0.016], w);
  }
}

function buildLeg(acc, s, bw, bd, side, roleMap) {
  startPart(acc);
  const rings = LEG_RINGS.map(([y, rx, rz, cx, ra, wa, rb, wb]) => ({
    y: y * s, rx: rx * bd * s, rz: rz * bw * s,
    cx: cx * s, cz: side * J.hipLat * s, w: [roleMap[ra], wa, roleMap[rb], wb],
  }));
  const lv = (y) => legV(y / s);
  buildTubeY(acc, rings, 14, TAU, 0, CELL.leg, lv, (t) => 1 - t,
    { capTop: true, capBottom: true });
}

// One boot = soleplate slab + rounded upper (separate parts so the welt stays a
// hard edge) + conical studs + a rolled ankle collar that the sock disappears
// into. The collar's topline turns inward and ends INSIDE the sock, so the boot
// is a closed volume — no open ring, nothing to see the pitch through.
function buildBoot(acc, s, bw, side, footBone) {
  const cz0 = side * J.hipLat * s;
  const w4 = [footBone, 1, 0, 0];
  const n = BOOT_STATIONS.length;
  const mk = (kind) => {
    const seg = kind === 'sole' ? 10 : 16;
    startPart(acc);
    const rows = [];
    for (let k = 0; k < n; k++) {
      const [x, yb, ys, yt, hw] = BOOT_STATIONS[k];
      const sole = kind === 'sole';
      const y0 = sole ? yb : ys - 0.010;
      const y1 = sole ? ys : yt;
      const halfW = (sole ? hw - 0.0015 : hw) * bw;
      const yc = (y0 + y1) * 0.5 * s, ry = Math.max(0.0015, (y1 - y0) * 0.5) * s;
      const rz = Math.max(0.002, halfW) * s;
      const p = sole ? 0.40 : 0.86;
      const row = [];
      for (let c = 0; c <= seg; c++) {
        const a = (c / seg) * TAU;
        const y = yc + ry * se(Math.cos(a), p);
        const z = cz0 + rz * se(Math.sin(a), p);
        // v: 0 at the underside (a = π), 1 at the top (a = 0)
        const vv = sole ? lerp(0.01, 0.155, (1 + Math.cos(a)) * 0.5)
          : lerp(0.19, 0.99, (1 + Math.cos(a)) * 0.5);
        const [uu, vvv] = cellUVg(CELL.boot, 0.04 + 0.92 * (k / (n - 1)), vv);
        row.push(pushVert(acc, x * s, y, z, 0, Math.cos(a), Math.sin(a), uu, vvv, w4[0], w4[1], w4[2], w4[3]));
      }
      rows.push(row);
    }
    connectRows(acc, rows); // rows ascending x, a increasing ⇒ outward
    // heel cap faces −X, toe cap faces +X
    const first = BOOT_STATIONS[0], last = BOOT_STATIONS[n - 1];
    const cc = (st) => {
      const sole = kind === 'sole';
      const y0 = sole ? st[1] : st[2] - 0.010;
      const y1 = sole ? st[2] : st[3];
      return [st[0] * s, (y0 + y1) * 0.5 * s];
    };
    const [hx, hy] = cc(first), [tx, ty] = cc(last);
    const uvH = cellUVg(CELL.boot, 0.06, kind === 'sole' ? 0.08 : 0.6);
    const uvT = cellUVg(CELL.boot, 0.94, kind === 'sole' ? 0.08 : 0.6);
    fanRing(acc, rows[0], hx, hy, cz0, -1, 0, 0, uvH, w4, false);
    fanRing(acc, rows[n - 1], tx, ty, cz0, 1, 0, 0, uvT, w4, true);
  };
  mk('sole');
  mk('upper');

  // ---- studs: short cones under the outsole ----
  const soleYAt = (x) => {
    for (let k = 0; k < n - 1; k++) {
      if (x <= BOOT_STATIONS[k + 1][0] || k === n - 2) {
        const a = BOOT_STATIONS[k], b = BOOT_STATIONS[k + 1];
        const t = clamp((x - a[0]) / (b[0] - a[0]), 0, 1);
        return lerp(a[1], b[1], t);
      }
    }
    return 0.01;
  };
  const uvS = cellUVg(CELL.boot, 0.5, 0.055);
  for (const [sx, sz, sr] of BOOT_STUDS) {
    const zs = sz === 0 ? [0] : [-sz, sz];
    for (const zz of zs) {
      startPart(acc);
      const top = soleYAt(sx) * s, bot = STUD_Y * s;
      const cx = sx * s, cz = cz0 + zz * bw * s;
      const rows = [];
      for (const [yy, rr] of [[top + 0.001 * s, sr], [bot, sr * 0.56]]) {
        const row = [];
        for (let c = 0; c <= 6; c++) {
          const f = (c / 6) * TAU;
          row.push(pushVert(acc, cx + rr * s * Math.cos(f), yy, cz + rr * s * Math.sin(f),
            Math.cos(f), -0.35, Math.sin(f), uvS[0], uvS[1], w4[0], w4[1], w4[2], w4[3]));
        }
        rows.push(row);
      }
      connectRows(acc, rows);
      fanRing(acc, rows[1], cx, bot - 0.0008 * s, cz, 0, -1, 0, uvS, w4, false);
    }
  }

  // ---- lace bars across the vamp ----
  const uvL = cellUVg(CELL.boot, 0.42, 0.96);
  for (let i = 0; i < 4; i++) {
    startPart(acc);
    const lx = (0.014 + i * 0.020) * s;
    const ly = lerp(0.086, 0.070, i / 3) * s;
    const lh = (0.020 - i * 0.0015) * bw * s;
    const rows = [];
    for (const [dx, dy] of [[-0.0035, -0.0020], [0, 0.0022], [0.0035, -0.0020]]) {
      const row = [];
      for (const t of [-1, -0.5, 0.5, 1]) {
        row.push(pushVert(acc, lx + dx * s, ly + dy * s - Math.abs(t) * 0.004 * s,
          cz0 + t * lh, dx, dy, 0, uvL[0], uvL[1], w4[0], w4[1], w4[2], w4[3]));
      }
      rows.push(row);
    }
    connectRows(acc, rows);
  }

  // ---- ankle collar: rolled topline, tucked inside the sock ----
  startPart(acc);
  const collar = [
    [0.082, 0.0455, 0.0430],
    [0.100, 0.0448, 0.0422],
    [0.118, 0.0430, 0.0405],
    [0.130, 0.0400, 0.0378],   // topline rim
    [0.126, 0.0330, 0.0312],   // rolls inward…
    [0.114, 0.0292, 0.0276],   // …and ends inside the sock (leg r ≈ 0.031)
  ];
  const crows = [];
  for (let k = 0; k < collar.length; k++) {
    const [cy, crx, crz] = collar[k];
    const row = [];
    for (let c = 0; c <= 14; c++) {
      const a = lerp(TAU, 0, c / 14);
      const ca = Math.cos(a), sa = Math.sin(a);
      const [uu, vv] = cellUVg(CELL.boot, 0.12 + 0.24 * (c / 14), lerp(0.62, 0.99, (cy - 0.082) / 0.048));
      row.push(pushVert(acc, -0.010 * s + crx * s * ca, cy * s, cz0 + crz * bw * s * sa,
        ca, 0, sa, uu, vv, w4[0], w4[1], w4[2], w4[3]));
    }
    crows.push(row);
  }
  connectRows(acc, crows);
}

// --- Head ------------------------------------------------------------------
// Horizontal radius multiplier `k`, forward offset `fx` (units of R) and
// vertical multiplier `ky`, as a function of (theta from crown, azimuth a
// where a=0 faces +X). Keeping the VERTICAL scale nearly azimuth-independent
// matters: if the jaw taper shrank ry too, the open bottom of the head shell
// became a ragged, tilted rim that no longer met the neck (visible hole at
// the nape).
function headProfile(th, a) {
  const cf = Math.cos(a);                 // +1 face, −1 back of skull
  const sf = Math.abs(Math.sin(a));       // 1 at the sides
  const fa = Math.abs(a);
  let k = 1, fx = 0;

  k += 0.024 * gs(th, 0.80, 0.50) * Math.max(0, -cf);   // occiput
  k -= 0.042 * gs(th, 1.15, 0.32) * sf;                 // temple flats

  const brow = gs(th, 1.42, 0.115) * Math.max(0, cf);
  k += 0.058 * brow; fx += 0.048 * brow;                // brow ridge
  k -= 0.020 * gs(th, 1.35, 0.055) * gs(a, 0, 0.16);    // glabella dip

  // eye: socket recess with the globe sitting in it and a lid fold above
  const eyeA = gs(fa, 0.42, 0.155);
  k -= 0.072 * gs(th, 1.575, 0.105) * eyeA * Math.max(0, cf);
  k += 0.040 * gs(th, 1.605, 0.062) * gs(fa, 0.42, 0.115) * Math.max(0, cf);
  k -= 0.022 * gs(th, 1.508, 0.038) * eyeA * Math.max(0, cf); // lid crease

  // nose: bridge → tip → alar wings → nostril undercut
  const bridge = gs(th, 1.60, 0.17) * gs(a, 0, 0.155);
  const tip = gs(th, 1.855, 0.105) * gs(a, 0, 0.185);
  fx += 0.072 * bridge + 0.250 * tip;
  k += 0.034 * tip;
  const alar = gs(th, 1.905, 0.070) * gs(fa, 0.24, 0.105);
  fx += 0.090 * alar; k += 0.046 * alar;
  // Nostril undercut: SHALLOW. A deep notch here makes a down-facing cave that
  // the floodlights never reach — it fills with green ground bounce and prints
  // a black-olive smudge under the nose that reads as a smeared moustache.
  fx -= 0.038 * gs(th, 1.972, 0.055) * gs(fa, 0.19, 0.150);

  k += 0.048 * gs(th, 1.74, 0.155) * gs(fa, 0.70, 0.235);     // zygomatic arch

  // mouth: philtrum groove, upper and lower lip volume, a shadow line between
  fx -= 0.028 * gs(th, 2.030, 0.035) * gs(a, 0, 0.085);       // philtrum
  fx += 0.052 * gs(th, 2.085, 0.048) * gs(a, 0, 0.30);        // upper lip
  fx -= 0.040 * gs(th, 2.130, 0.024) * gs(a, 0, 0.30);        // lip line
  fx += 0.055 * gs(th, 2.180, 0.052) * gs(a, 0, 0.27);        // lower lip
  fx -= 0.020 * gs(th, 2.255, 0.058) * gs(a, 0, 0.30);        // mentolabial fold

  // jaw taper: sides narrow most, the occiput tucks under toward the neck
  const jt = smooth01((th - 1.70) / 0.95);
  k -= 0.215 * jt * (0.28 + 0.68 * sf + 0.62 * Math.max(0, -cf));
  k += 0.072 * gs(th, 2.03, 0.135) * gs(fa, 1.02, 0.27);      // gonial angle
  k += 0.030 * gs(th, 2.20, 0.20) * gs(fa, 0.72, 0.30);       // mandible ramus

  const chin = gs(th, 2.42, 0.20) * gs(a, 0, 0.36);
  fx += 0.150 * chin; k += 0.075 * chin;                      // chin plane
  return [k, fx, 1 + 0.10 * chin];
}

// A real ear: outer contour on the skull, a helix rim rolled forward, a concha
// bowl deep enough to hold an occlusion shadow, and a free lobe. ~120 tris.
// [rx, ry, z, yOff]: rx/ry/yOff in units of headR, z in units of the head's
// lateral half-width (so 1.0 sits exactly on the skull, >1 stands proud).
// [rx, ry, z, yOff, xOff] — the bowl is deliberately NOT concentric: it sits
// low and back inside the helix, the way a real concha does.
const EAR_RINGS = [
  [0.186, 0.300, 0.970, 0.000, 0.000],
  [0.170, 0.278, 1.085, 0.012, 0.006],  // helix rim, rolled forward
  [0.126, 0.206, 1.045, -0.018, -0.020], // antihelix
  [0.076, 0.122, 0.995, -0.034, -0.030], // concha rim
  [0.030, 0.050, 0.940, -0.040, -0.032], // concha floor
];

function buildEar(acc, s, spec, side) {
  startPart(acc);
  const cy = J.headC * s, R = J.headR * s, cx0 = HEAD_CX * s;
  const RZ = R * HEAD_SZ * 0.985;
  const ecx = cx0 - 0.215 * R, ecy = cy - 0.130 * R;
  const seg = 14;
  const rows = [];
  for (let k = 0; k < EAR_RINGS.length; k++) {
    const [rx, ry, ez, yo, xo] = EAR_RINGS[k];
    const row = [];
    for (let c = 0; c <= seg; c++) {
      const f = side * (c / seg) * TAU;
      const cf = Math.cos(f), sf = Math.sin(f);
      // lobe: hangs free at the bottom, a touch forward, clear of the jaw
      const lobe = Math.max(0, -sf) * (0.45 + 0.55 * cf) *
        Math.max(0, 1 - 1.5 * k / (EAR_RINGS.length - 1));
      const x = ecx + xo * R + rx * R * cf * (1 + 0.08 * lobe);
      const y = ecy + yo * R + ry * R * sf - lobe * 0.050 * R;
      const z = side * (ez + 0.030 * lobe) * RZ;
      const [uu, vv] = cellUVg(SW_EAR, 0.5 + 0.46 * cf * (1 - 0.18 * k),
        0.5 + 0.46 * sf * (1 - 0.18 * k));
      row.push(pushVert(acc, x, y, z, -0.25 * cf, 0.25 * sf, side, uu, vv,
        BI.head, 1, BI.neck, 0));
    }
    rows.push(row);
  }
  connectRows(acc, rows);
  const last = EAR_RINGS[EAR_RINGS.length - 1];
  const [cu, cv] = cellUVg(SW_EAR, 0.5, 0.5);
  fanRing(acc, rows[rows.length - 1], ecx + last[4] * R, ecy + last[3] * R,
    side * (last[2] - 0.030) * RZ, 0, 0, side, [cu, cv],
    [BI.head, 1, BI.neck, 0], side < 0);
}

function buildHead(acc, s, spec) {
  startPart(acc);
  const cy = J.headC * s, R = J.headR * s, cx0 = HEAD_CX * s;
  const latSeg = 26, lonSeg = 30;
  const rows = [];
  for (let li = latSeg; li >= 0; li--) {
    const th = (li / latSeg) * HEAD_TH_MAX;
    const st = Math.sin(th), ct = Math.cos(th);
    const row = [];
    for (let c = 0; c <= lonSeg; c++) {
      const u = c / lonSeg;
      const a = (0.5 - u) * TAU;
      const [k, fx, ky] = headProfile(th, a);
      const rx = R * HEAD_SX * k, ry = R * HEAD_SY * ky, rz = R * HEAD_SZ * k;
      const x = cx0 + rx * st * Math.cos(a) + fx * R * Math.max(0, Math.cos(a) * 0.6 + 0.4);
      const y = cy + ry * ct;
      const z = rz * st * Math.sin(a);
      const [uu, vv] = cellUVg(CELL.head, u, 1 - th / Math.PI);
      row.push(pushVert(acc, x, y, z, st * Math.cos(a), ct, st * Math.sin(a), uu, vv,
        BI.head, 1, BI.neck, 0));
    }
    rows.push(row);
  }
  connectRows(acc, rows);

  for (const side of [-1, 1]) buildEar(acc, s, spec, side);
}

function hairEdge(spec, a) {
  const wf = 0.5 - 0.5 * Math.cos(a);           // 0 at the face, 1 at the back
  const t = smooth01(wf);
  const fa = Math.abs(a);
  // jagged, per-player boundary — a perfectly smooth rim is what reads as a
  // swimming cap. Deterministic from the cast phases, ~1 cm of break-up.
  const jag = spec.hairJag * (0.45 * Math.sin(3.0 * a + spec.hairPh[0]) +
    0.32 * Math.sin(5.0 * a + spec.hairPh[1]) +
    0.23 * Math.sin(9.0 * a + spec.hairPh[2]));
  return lerp(spec.hairFront, spec.hairBack, t)
    - spec.hairPeak * gs(a, 0, 0.55)            // brow-line lift (widow's peak)
    + 0.07 * gs(fa, 1.22, 0.17)                 // sideburn, in FRONT of the ear
    - 0.40 * gs(fa, 1.86, 0.36)                 // clears the ear entirely
    + jag;
}

function buildHair(acc, s, spec) {
  if (spec.bald) return;
  startPart(acc);
  const cy = J.headC * s, R = J.headR * s, cx0 = HEAD_CX * s;
  const latSeg = 10, lonSeg = 28;
  const rows = [];
  for (let li = latSeg + 1; li >= 0; li--) {
    const tuck = li > latSeg;
    const row = [];
    for (let c = 0; c <= lonSeg; c++) {
      const u = c / lonSeg;
      const a = (0.5 - u) * TAU;
      const e = hairEdge(spec, a);
      const th = tuck ? e + 0.10 : (e * li) / latSeg;
      const [k, fx, ky] = headProfile(th, a);
      let kk;
      if (tuck) kk = k - 0.055;
      else {
        // feather the shell to almost nothing at the hairline so the rim is soft
        const rim = 0.22 + 0.78 * smooth01((e - th) / (0.45 + 0.4 * spec.hairT * 6));
        // a fade thins the shell over the temples/sides while the top keeps its
        // mass — the single strongest silhouette difference between styles.
        const sideK = 1 - spec.hairFade * gs(Math.abs(a), 1.62, 0.66);
        kk = k + spec.hairT * rim * sideK + spec.hairVol * gs(th, 0.32, 0.60);
        // quiff: extra mass swept up over the front of the crown
        kk += spec.hairQuiff * gs(th, 0.72, 0.34) * gs(a, 0, 0.80);
        if (spec.hairCurl) {
          kk += spec.hairCurl * rim * (0.026 * Math.sin(th * 6.3) * Math.sin(a * 5.0)
            + 0.020 * Math.sin(th * 10.4 + 1.7) * Math.sin(a * 8.0 + 0.6));
        }
      }
      const rx = R * HEAD_SX * kk, rz = R * HEAD_SZ * kk;
      const ry = R * HEAD_SY * ky * (tuck ? kk / Math.max(0.2, k) : 1 + (kk - k) * 0.6);
      const st = Math.sin(th), ct = Math.cos(th);
      const x = cx0 + rx * st * Math.cos(a) + fx * R * Math.max(0, Math.cos(a) * 0.6 + 0.4);
      const [uu, vv] = cellUVg(CELL.hair, u, clamp(1 - th / Math.PI, 0, 1));
      row.push(pushVert(acc, x, cy + ry * ct, rz * st * Math.sin(a),
        st * Math.cos(a), ct, st * Math.sin(a), uu, vv, BI.head, 1, BI.neck, 0));
    }
    rows.push(row);
  }
  connectRows(acc, rows);
}

function buildBodyGeometry(s, spec) {
  const acc = newAcc();
  const bw = spec.build;                    // lateral/width factor
  const bd = lerp(1, spec.build, 0.6);      // depth follows a bit

  buildTorso(acc, s, bw, bd);
  buildShorts(acc, s, bw, bd);
  for (const side of [-1, 1]) {
    const roleMap = side < 0
      ? { chest: BI.chest, uarm: BI.uarmL, farm: BI.farmL, hand: BI.handL }
      : { chest: BI.chest, uarm: BI.uarmR, farm: BI.farmR, hand: BI.handR };
    buildArm(acc, s, bw, bd, side, roleMap);
    buildHand(acc, s, bw, side, roleMap);
  }
  for (const side of [-1, 1]) {
    const roleMap = side < 0
      ? { hips: BI.hips, thigh: BI.thighL, shin: BI.shinL, foot: BI.footL }
      : { hips: BI.hips, thigh: BI.thighR, shin: BI.shinR, foot: BI.footR };
    buildLeg(acc, s, bw, bd, side, roleMap);
    buildBoot(acc, s, bw, side, side < 0 ? BI.footL : BI.footR);
  }
  buildHead(acc, s, spec);
  buildHair(acc, s, spec);
  recomputeNormals(acc);
  return acc;
}

function buildAthleteMesh(spec, tex) {
  const s = spec.height / 1.80;
  const acc = buildBodyGeometry(s, spec);
  const geo = accToGeometry(acc);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, roughnessMap: spec.maps.rough, roughness: 1.0, metalness: 0.0,
    normalMap: spec.maps.norm, normalScale: new THREE.Vector2(0.85, 0.85),
  });
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const bones = buildSkeleton(s);
  mesh.add(bones[BI.hips]);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones)); // bind() recomputes inverses from current world matrices
  return { mesh, bones, s };
}

// ---------------------------------------------------------------------------
// Actions: keyframed pose layers. Track = channel → [[u, value]...] (u 0..1
// of duration, smoothstep-eased between keys). lock: how locomotion behaves.
// head: 0..1 how much ball head-look survives during the action.
// hips_p* are METERS (canonical, scaled by s on apply).
// ---------------------------------------------------------------------------
function sampleTrack(keys, u) {
  if (u <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (u >= last[0]) return last[1];
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i], k1 = keys[i + 1];
    if (u <= k1[0]) {
      const t = (u - k0[0]) / Math.max(1e-6, k1[0] - k0[0]);
      return lerp(k0[1], k1[1], smooth01(t));
    }
  }
  return last[1];
}

function mirrorChannelName(name) {
  return name.replace(/([a-z]+)(L|R)_/, (m, base, side) => base + (side === 'L' ? 'R' : 'L') + '_');
}
function mirrorSign(name) {
  if (name === 'hips_pz') return -1;
  if (name === 'hips_px' || name === 'hips_py') return 1;
  if (name.endsWith('_x') || name.endsWith('_y')) return -1;
  return 1;
}
function mirrorAction(def) {
  const tracks = {};
  for (const ch in def.tracks) {
    const sgnv = mirrorSign(ch);
    tracks[mirrorChannelName(ch)] = def.tracks[ch].map(([t, v]) => [t, v * sgnv]);
  }
  return { ...def, tracks };
}

const ACT_PASS = {
  dur: 0.55, lock: 'free', head: 0.55,
  tracks: {
    thighR_z: [[0, 0.05], [0.16, -0.55], [0.30, 0.78], [0.42, 0.45], [1, 0.1]],
    shinR_z: [[0, -0.1], [0.16, -0.95], [0.30, -0.12], [0.5, -0.35], [1, -0.2]],
    thighR_y: [[0, 0], [0.14, -0.35], [0.34, -0.55], [0.6, -0.25], [1, 0]],
    footR_z: [[0, 0], [0.25, 0.28], [0.55, 0.1], [1, 0]],
    thighL_z: [[0, 0], [0.2, -0.12], [0.6, -0.06], [1, 0]],
    shinL_z: [[0, 0], [0.2, -0.3], [0.6, -0.18], [1, -0.05]],
    hips_py: [[0, 0], [0.25, -0.06], [0.6, -0.03], [1, 0]],
    spine_z: [[0, 0], [0.3, -0.14], [1, -0.02]],
    chest_y: [[0, 0], [0.18, 0.18], [0.35, -0.15], [1, 0]],
    uarmL_x: [[0, 0.1], [0.3, 0.55], [0.7, 0.2], [1, 0.08]],
    uarmR_x: [[0, -0.1], [0.3, -0.35], [1, -0.08]],
    uarmL_z: [[0, 0], [0.3, 0.35], [1, 0]],
    uarmR_z: [[0, 0], [0.3, -0.3], [1, 0]],
  },
};

const ACT_SHOOT = {
  dur: 0.85, lock: 'free', head: 0.35,
  tracks: {
    thighR_z: [[0, 0.05], [0.24, -0.9], [0.40, 1.05], [0.58, 0.85], [1, 0.15]],
    shinR_z: [[0, -0.1], [0.24, -1.55], [0.40, -0.18], [0.6, -0.12], [1, -0.3]],
    footR_z: [[0, 0], [0.3, -0.5], [0.55, -0.45], [1, 0]],
    thighL_z: [[0, 0], [0.24, -0.15], [0.55, -0.05], [1, 0]],
    shinL_z: [[0, 0], [0.24, -0.35], [0.6, -0.2], [1, -0.05]],
    hips_py: [[0, 0], [0.24, -0.10], [0.5, -0.02], [0.62, 0.03], [1, 0]],
    hips_rz: [[0, 0], [0.28, 0.1], [0.45, -0.12], [1, 0]],
    spine_z: [[0, 0], [0.26, 0.16], [0.45, -0.28], [0.7, -0.18], [1, -0.04]],
    chest_y: [[0, 0], [0.24, 0.32], [0.45, -0.35], [0.75, -0.15], [1, 0]],
    uarmL_x: [[0, 0.1], [0.4, 0.9], [0.75, 0.3], [1, 0.08]],
    uarmL_z: [[0, 0], [0.4, 0.6], [1, 0]],
    uarmR_x: [[0, -0.1], [0.4, -0.55], [1, -0.08]],
    uarmR_z: [[0, 0], [0.3, -0.5], [0.6, 0.3], [1, 0]],
    farmL_z: [[0, 0.2], [0.4, 0.5], [1, 0.2]],
  },
};

const ACT_TACKLE = {
  dur: 1.3, lock: 'slide', head: 0.3,
  tracks: {
    tilt_z: [[0, 0], [0.12, 0.42], [0.55, 0.5], [0.8, 0.25], [1, 0]],
    tilt_x: [[0, 0], [0.15, 0.3], [0.6, 0.35], [0.85, 0.1], [1, 0]],
    hips_py: [[0, 0], [0.12, -0.42], [0.5, -0.58], [0.75, -0.45], [1, -0.02]],
    thighR_z: [[0, 0.1], [0.15, 1.15], [0.6, 1.1], [0.85, 0.4], [1, 0.05]],
    shinR_z: [[0, -0.2], [0.15, -0.15], [0.6, -0.1], [0.85, -0.5], [1, -0.1]],
    footR_z: [[0, 0], [0.2, -0.3], [0.7, -0.3], [1, 0]],
    thighL_z: [[0, 0], [0.15, 0.5], [0.6, 0.55], [0.9, 0.1], [1, 0]],
    thighL_y: [[0, 0], [0.15, 0.5], [0.6, 0.5], [1, 0]],
    shinL_z: [[0, 0], [0.15, -1.95], [0.6, -1.9], [0.9, -0.4], [1, -0.05]],
    spine_z: [[0, 0], [0.15, 0.18], [0.6, 0.2], [1, 0]],
    chest_y: [[0, 0], [0.15, -0.25], [0.6, -0.25], [1, 0]],
    uarmL_x: [[0, 0.1], [0.15, 1.0], [0.6, 1.1], [1, 0.08]],
    uarmR_x: [[0, -0.1], [0.15, -0.9], [0.5, -0.5], [1, -0.08]],
    uarmR_z: [[0, 0], [0.15, 0.7], [0.6, 0.6], [1, 0]],
    farmR_z: [[0, 0.2], [0.2, 0.9], [1, 0.2]],
  },
};

// GK dive to the keeper's LEFT (−Z). Right version is mirrored.
const ACT_GK_DIVE_L = {
  dur: 1.55, lock: 'stop', head: 0.15,
  tracks: {
    hips_py: [[0, 0], [0.10, -0.18], [0.22, 0.12], [0.38, -0.35], [0.52, -0.60], [0.75, -0.62], [0.9, -0.35], [1, -0.02]],
    hips_pz: [[0, 0], [0.12, -0.1], [0.45, -0.75], [0.7, -0.95], [0.9, -0.35], [1, 0]],
    tilt_x: [[0, 0], [0.10, -0.2], [0.4, -1.05], [0.62, -1.32], [0.82, -0.85], [1, 0]],
    tilt_z: [[0, 0], [0.12, -0.15], [0.5, -0.1], [1, 0]],
    uarmL_x: [[0, 0.1], [0.12, 0.6], [0.35, 2.75], [0.7, 2.85], [0.88, 0.9], [1, 0.08]],
    uarmR_x: [[0, -0.1], [0.12, -0.4], [0.38, -2.55], [0.7, -2.65], [0.88, -0.7], [1, -0.08]],
    uarmL_z: [[0, 0], [0.35, 0.15], [1, 0]],
    uarmR_z: [[0, 0], [0.38, 0.2], [1, 0]],
    farmL_z: [[0, 0.2], [0.35, 0.12], [1, 0.2]],
    farmR_z: [[0, 0.2], [0.38, 0.12], [1, 0.2]],
    thighL_z: [[0, 0], [0.12, 0.9], [0.3, 0.25], [0.6, 0.15], [1, 0]],
    shinL_z: [[0, 0], [0.12, -1.1], [0.35, -0.25], [1, -0.05]],
    thighR_z: [[0, 0], [0.15, 0.5], [0.4, 0.3], [0.65, 0.35], [1, 0]],
    thighR_x: [[0, 0], [0.4, 0.35], [0.7, 0.4], [1, 0]],
    shinR_z: [[0, 0], [0.15, -0.7], [0.5, -0.3], [1, -0.05]],
    spine_z: [[0, 0], [0.12, -0.2], [0.5, 0.05], [1, 0]],
    head_x: [[0, 0], [0.4, 0.5], [0.8, 0.3], [1, 0]],
  },
};

const ACT_GK_CATCH = {
  dur: 0.9, lock: 'stop', head: 0.4,
  tracks: {
    hips_py: [[0, 0], [0.25, -0.16], [0.7, -0.1], [1, 0]],
    spine_z: [[0, 0], [0.25, -0.3], [0.7, -0.15], [1, 0]],
    uarmL_x: [[0, 0.1], [0.25, 0.35], [0.6, 0.2], [1, 0.08]],
    uarmR_x: [[0, -0.1], [0.25, -0.35], [0.6, -0.2], [1, -0.08]],
    uarmL_z: [[0, 0], [0.22, 1.05], [0.6, 0.8], [1, 0]],
    uarmR_z: [[0, 0], [0.22, 1.05], [0.6, 0.8], [1, 0]],
    farmL_z: [[0, 0.2], [0.25, 1.1], [0.65, 1.25], [1, 0.2]],
    farmR_z: [[0, 0.2], [0.25, 1.1], [0.65, 1.25], [1, 0.2]],
    thighL_z: [[0, 0], [0.25, 0.3], [1, 0]],
    shinL_z: [[0, 0], [0.25, -0.45], [1, -0.05]],
    thighR_z: [[0, 0], [0.25, 0.3], [1, 0]],
    shinR_z: [[0, 0], [0.25, -0.45], [1, -0.05]],
  },
};

const ACT_CELEBRATE = {
  dur: 1.9, lock: 'stop', head: 0.0,
  tracks: {
    uarmL_x: [[0, 0.1], [0.16, 2.55], [0.55, 2.6], [0.68, 2.2], [0.8, 2.6], [0.92, 2.3], [1, 0.15]],
    uarmR_x: [[0, -0.1], [0.16, -2.55], [0.55, -2.6], [0.68, -2.2], [0.8, -2.6], [0.92, -2.3], [1, -0.15]],
    farmL_z: [[0, 0.2], [0.2, 0.35], [1, 0.2]],
    farmR_z: [[0, 0.2], [0.2, 0.35], [1, 0.2]],
    hips_py: [[0, 0], [0.18, -0.14], [0.28, 0.32], [0.36, 0.38], [0.46, -0.06], [0.55, 0], [1, 0]],
    thighL_z: [[0, 0], [0.28, 0.55], [0.38, 0.5], [0.48, 0], [1, 0]],
    shinL_z: [[0, 0], [0.28, -0.95], [0.38, -0.9], [0.48, -0.1], [1, -0.05]],
    thighR_z: [[0, 0], [0.28, 0.55], [0.38, 0.5], [0.48, 0], [1, 0]],
    shinR_z: [[0, 0], [0.28, -0.95], [0.38, -0.9], [0.48, -0.1], [1, -0.05]],
    spine_z: [[0, 0], [0.2, 0.22], [0.6, 0.18], [1, 0]],
    head_z: [[0, 0], [0.2, 0.35], [0.6, 0.3], [1, 0]],
  },
};

const ACT_THROW_IN = {
  dur: 1.0, lock: 'stop', head: 0.3,
  tracks: {
    uarmL_x: [[0, 0.1], [0.3, 2.8], [0.62, 2.75], [0.85, 1.6], [1, 0.1]],
    uarmR_x: [[0, -0.1], [0.3, -2.8], [0.62, -2.75], [0.85, -1.6], [1, -0.1]],
    uarmL_z: [[0, 0], [0.35, 0.4], [0.55, 0.45], [0.72, -0.7], [1, 0]],
    uarmR_z: [[0, 0], [0.35, 0.4], [0.55, 0.45], [0.72, -0.7], [1, 0]],
    farmL_z: [[0, 0.2], [0.35, 1.25], [0.55, 1.3], [0.75, 0.2], [1, 0.2]],
    farmR_z: [[0, 0.2], [0.35, 1.25], [0.55, 1.3], [0.75, 0.2], [1, 0.2]],
    spine_z: [[0, 0], [0.35, 0.28], [0.55, 0.3], [0.75, -0.32], [1, 0]],
    hips_py: [[0, 0], [0.4, -0.05], [0.7, -0.1], [1, 0]],
    thighL_z: [[0, 0], [0.55, 0.1], [0.75, 0.45], [1, 0]],
    shinL_z: [[0, 0], [0.75, -0.35], [1, -0.05]],
    hips_px: [[0, 0], [0.55, -0.04], [0.78, 0.08], [1, 0]],
  },
};

const ACT_NOD = { // graceful fallback for unknown action names
  dur: 0.4, lock: 'free', head: 0.5,
  tracks: { head_z: [[0, 0], [0.4, -0.25], [1, 0]], spine_z: [[0, 0], [0.4, -0.05], [1, 0]] },
};

const ACTIONS = {
  pass: ACT_PASS,
  shoot: ACT_SHOOT,
  tackle: ACT_TACKLE,
  celebrate: ACT_CELEBRATE,
  gk_dive_left: ACT_GK_DIVE_L,
  gk_dive_right: mirrorAction(ACT_GK_DIVE_L),
  gk_catch: ACT_GK_CATCH,
  throw_in: ACT_THROW_IN,
};

// ---------------------------------------------------------------------------
// Player factory
// ---------------------------------------------------------------------------
const POSE_CHANNELS = [
  'hips_px', 'hips_py', 'hips_pz', 'hips_rx', 'hips_ry', 'hips_rz',
  'spine_x', 'spine_y', 'spine_z', 'chest_x', 'chest_y', 'chest_z',
  'neck_x', 'neck_y', 'neck_z', 'head_x', 'head_y', 'head_z',
  'tilt_x', 'tilt_z',
  'uarmL_x', 'uarmL_y', 'uarmL_z', 'farmL_z', 'handL_z',
  'uarmR_x', 'uarmR_y', 'uarmR_z', 'farmR_z', 'handR_z',
  'thighL_x', 'thighL_y', 'thighL_z', 'shinL_z', 'footL_z',
  'thighR_x', 'thighR_y', 'thighR_z', 'shinR_z', 'footR_z',
];

// Sole sample points in foot-bone local X (heel, ball of the foot).
const CONTACT_X = [-0.048, 0.098];
const _cp = new THREE.Vector3();

function getBallPos() {
  if (typeof window === 'undefined') return null;
  const app = window.__APP;
  return app && app.ball && app.ball.pos ? app.ball.pos : null;
}

function createPlayer(ctx, spec) {
  const tex = makeKitTexture(spec, ctx.rng, ctx.quality === 'low' ? 512 : 1024);
  const { mesh, bones, s } = buildAthleteMesh(spec, tex);

  const group = new THREE.Group();
  const tilt = new THREE.Group();
  group.add(tilt);
  tilt.add(mesh);
  ctx.scene.add(group);

  const pos = new THREE.Vector3(spec.x0, 0, spec.z0);
  const vel = new THREE.Vector3();
  const velPrev = new THREE.Vector3();
  const accSm = new THREE.Vector3();
  const target = new THREE.Vector3();
  let hasTarget = false;
  let targetSpeed01 = 1;
  let faceOverride = spec.facing0;
  let facing = spec.facing0;
  let turnSm = 0;
  let phase = ctx.rng() * TAU;
  let tIdle = ctx.rng() * 20;
  const idleRate = 0.85 + ctx.rng() * 0.3;
  let action = null;
  let lookYaw = 0, lookPitch = 0;
  const legLen = J.hip - J.ankle;
  const footWorld = [new THREE.Vector3(), new THREE.Vector3()];
  // contact[f] = (worldX, heightAboveGrass, worldZ) for the AO patches
  const contact = [new THREE.Vector3(0, 9, 0), new THREE.Vector3(0, 9, 0)];

  const pose = {};
  const resetPose = () => { for (let i = 0; i < POSE_CHANNELS.length; i++) pose[POSE_CHANNELS[i]] = 0; };
  resetPose();

  const B = bones;

  function computeLocomotionPose(speed, runK, moveW, af) {
    // base stance (never mannequin-straight)
    pose.uarmL_x = 0.11; pose.uarmR_x = -0.11;
    pose.farmL_z = 0.22; pose.farmR_z = 0.22;
    pose.handL_z = 0.12; pose.handR_z = 0.12;
    pose.spine_z = -0.03;
    pose.thighL_z = 0.03; pose.thighR_z = 0.03;
    pose.shinL_z = -0.07; pose.shinR_z = -0.07;
    pose.footL_z = 0.035; pose.footR_z = 0.035;

    // ---- idle layer ----
    const iw = 1 - moveW;
    if (iw > 0.001) {
      const sway = Math.sin(tIdle * 0.55);
      const breathe = Math.sin(tIdle * 1.5);
      pose.hips_pz += iw * 0.030 * sway;
      pose.hips_rx += iw * -0.035 * sway;
      pose.spine_x += iw * 0.045 * sway;
      pose.spine_z += iw * (-0.012 + 0.014 * breathe);
      pose.chest_z += iw * 0.012 * breathe;
      pose.hips_py += iw * (-0.008 + 0.004 * Math.sin(tIdle * 1.5 + 1));
      pose.uarmL_z += iw * 0.035 * Math.sin(tIdle * 0.8 + 1.3);
      pose.uarmR_z += iw * 0.035 * Math.sin(tIdle * 0.74);
      pose.shinL_z += iw * -0.03 * (0.5 + 0.5 * sway);
      pose.shinR_z += iw * -0.03 * (0.5 - 0.5 * sway);
    }

    // ---- gait layer ----
    if (moveW > 0.001) {
      const cL = Math.cos(phase), sL = Math.sin(phase);
      const cR = -cL, sR = -sL;
      const thighAmp = (0.30 + 0.60 * runK) * moveW;
      pose.thighL_z += thighAmp * cL;
      pose.thighR_z += thighAmp * cR;
      const kneeSwing = (0.6 + 1.1 * runK) * moveW;
      const stanceFlex = (0.10 + 0.26 * runK) * moveW;
      const swL = Math.pow(Math.max(0, -sL), 1.25), swR = Math.pow(Math.max(0, -sR), 1.25);
      pose.shinL_z += -(kneeSwing * swL + stanceFlex * Math.max(0, sL));
      pose.shinR_z += -(kneeSwing * swR + stanceFlex * Math.max(0, sR));
      // feet: level sole during stance (plant), toe-down through swing
      const stL = smooth01(sL * 1.6), stR = smooth01(sR * 1.6);
      const swingFootL = -0.45 * moveW * swL + 0.28 * moveW * Math.max(0, -Math.sin(phase + 0.7));
      const swingFootR = -0.45 * moveW * swR + 0.28 * moveW * Math.max(0, -Math.sin(phase + Math.PI + 0.7));
      pose.footL_z += lerp(swingFootL, -(pose.thighL_z + pose.shinL_z) * 0.85, stL);
      pose.footR_z += lerp(swingFootR, -(pose.thighR_z + pose.shinR_z) * 0.85, stR);
      // pelvis: bob + crouch that keeps stance feet near the grass
      const crouch = legLen * (1 - Math.cos(thighAmp)) * 0.45;
      const bobAmp = (0.012 + 0.030 * runK) * moveW;
      pose.hips_py += -crouch + bobAmp * Math.sin(2 * phase + 1.1);
      pose.hips_pz += moveW * (1 - runK) * 0.018 * sL;
      // counter-rotation
      pose.hips_ry += -0.085 * (0.5 + 0.5 * runK) * moveW * cL;
      pose.chest_y += 0.125 * (0.5 + 0.6 * runK) * moveW * cL;
      // lean into speed / acceleration / turns
      const baseLean = (0.05 + 0.24 * runK) * moveW;
      pose.spine_z += -baseLean * 0.45;
      pose.chest_z += -baseLean * 0.4;
      pose.tilt_z += -(baseLean * 0.35 + clamp(af * 0.05, -0.18, 0.30));
      pose.tilt_x += clamp(turnSm * speed * 0.045, -0.32, 0.32);
      // arms counter-swing
      const armAmp = (0.25 + 0.62 * runK) * moveW;
      pose.uarmL_z += -armAmp * cL;
      pose.uarmR_z += armAmp * cL;
      pose.uarmL_x += -(0.04 + 0.08 * runK) * moveW;
      pose.uarmR_x += (0.04 + 0.08 * runK) * moveW;
      // NOTE: sprinters carry the arms closer to the ribs; elbows pump.
      pose.farmL_z += (0.15 + 0.95 * runK) * moveW + 0.3 * armAmp * (0.5 - 0.5 * cL);
      pose.farmR_z += (0.15 + 0.95 * runK) * moveW + 0.3 * armAmp * (0.5 + 0.5 * cL);
      pose.handL_z += 0.18 * moveW; pose.handR_z += 0.18 * moveW;
    }
  }

  function applyActionLayer() {
    if (!action) return;
    const u = action.t / action.dur;
    const w = smooth01(u / 0.10) * (1 - smooth01((u - 0.88) / 0.12));
    const tracks = action.def.tracks;
    for (const ch in tracks) {
      pose[ch] = lerp(pose[ch], sampleTrack(tracks[ch], u), w);
    }
  }

  function applyHeadLook(dt) {
    const bp = getBallPos();
    let ty = 0, tp = 0;
    if (bp) {
      const dx = bp.x - pos.x, dz = bp.z - pos.z;
      const distH = Math.hypot(dx, dz);
      const relYaw = wrapPI(Math.atan2(dz, dx) - facing);
      if (distH > 0.5 && distH < 45 && Math.abs(relYaw) < 1.5) {
        ty = clamp(relYaw * 0.85, -1.0, 1.0);
        // Downward look is capped well short of the true line to the ball: a
        // player 2 m from the ball would otherwise pitch his head 37° down and
        // present nothing but the underside of his jaw to a low camera. Real
        // players track a close ball mostly with their eyes.
        tp = clamp(Math.atan2(bp.y - J.headC * s, distH), -0.40, 0.35);
      }
    }
    const hw = action ? action.def.head : 1;
    lookYaw = damp(lookYaw, ty * hw, 5.5, dt);
    lookPitch = damp(lookPitch, tp * hw, 5.5, dt);
    pose.neck_y += -lookYaw * 0.35;
    pose.head_y += -lookYaw * 0.65;
    pose.neck_z += lookPitch * 0.35;
    pose.head_z += lookPitch * 0.65;
  }

  // Anatomical limits. A knee never hyperextends and never folds past ~140°;
  // an ankle in locomotion stays inside ±25° dorsi/plantarflexion. Enforcing
  // this every frame is what stops a reach pose from collapsing the shin+foot
  // chain into the thigh (the "capped stump" keeper).
  function clampJoints(inAction) {
    const ankle = inAction ? 0.72 : 0.44;
    pose.shinL_z = clamp(pose.shinL_z, -2.44, 0.03);
    pose.shinR_z = clamp(pose.shinR_z, -2.44, 0.03);
    pose.footL_z = clamp(pose.footL_z, -ankle, ankle);
    pose.footR_z = clamp(pose.footR_z, -ankle, ankle);
    pose.farmL_z = clamp(pose.farmL_z, -0.05, 2.60);
    pose.farmR_z = clamp(pose.farmR_z, -0.05, 2.60);
  }

  function writePose() {
    B[BI.hips].position.set(pose.hips_px * s, (J.hipsBone + pose.hips_py) * s, pose.hips_pz * s);
    B[BI.hips].rotation.set(pose.hips_rx, pose.hips_ry, pose.hips_rz);
    B[BI.spine].rotation.set(pose.spine_x, pose.spine_y, pose.spine_z);
    B[BI.chest].rotation.set(pose.chest_x, pose.chest_y, pose.chest_z);
    B[BI.neck].rotation.set(pose.neck_x, pose.neck_y, pose.neck_z);
    B[BI.head].rotation.set(pose.head_x, pose.head_y, pose.head_z);
    B[BI.uarmL].rotation.set(pose.uarmL_x, pose.uarmL_y, pose.uarmL_z);
    B[BI.uarmR].rotation.set(pose.uarmR_x, pose.uarmR_y, pose.uarmR_z);
    B[BI.farmL].rotation.set(0, 0, pose.farmL_z);
    B[BI.farmR].rotation.set(0, 0, pose.farmR_z);
    B[BI.handL].rotation.set(0, 0, pose.handL_z);
    B[BI.handR].rotation.set(0, 0, pose.handR_z);
    B[BI.thighL].rotation.set(pose.thighL_x, pose.thighL_y, pose.thighL_z);
    B[BI.thighR].rotation.set(pose.thighR_x, pose.thighR_y, pose.thighR_z);
    B[BI.shinL].rotation.set(0, 0, pose.shinL_z);
    B[BI.shinR].rotation.set(0, 0, pose.shinR_z);
    B[BI.footL].rotation.set(0, 0, pose.footL_z);
    B[BI.footR].rotation.set(0, 0, pose.footR_z);
    tilt.rotation.set(pose.tilt_x, 0, pose.tilt_z);
    group.position.copy(pos);
    group.rotation.y = -facing;
  }

  const player = {
    id: spec.id,
    team: spec.team,
    number: spec.number,
    name: spec.displayName,
    role: spec.role,
    group,
    pos,
    vel,
    facing,
    maxSpeed: spec.maxSpeed,
    star: !!spec.star,          // match.js: this one never misses

    moveTo(targetV3, speed01) {
      target.set(targetV3.x, 0, targetV3.z);
      hasTarget = true;
      targetSpeed01 = clamp(speed01 === undefined ? 1 : speed01, 0.05, 1);
    },
    stop() { hasTarget = false; },
    face(t) {
      if (typeof t === 'number') faceOverride = t;
      else if (t && t.isVector3) faceOverride = Math.atan2(t.z - pos.z, t.x - pos.x);
    },
    playAction(name) {
      const def = ACTIONS[name] || ACT_NOD;
      action = { def, name, t: 0, dur: def.dur };
      return def.dur;
    },
    actionBusy() { return !!action && action.t < action.dur; },

    update(dt) {
      if (!(dt > 0)) return;
      // ---- action clock ----
      if (action) {
        action.t += dt;
        if (action.t >= action.dur) action = null;
      }
      const lock = action ? action.def.lock : 'free';

      // ---- locomotion integration ----
      velPrev.copy(vel);
      if (lock === 'free') {
        let dvx = -vel.x, dvz = -vel.z; // default: brake to zero
        let aMax = 9;
        if (hasTarget) {
          const tx = target.x - pos.x, tz = target.z - pos.z;
          const dist = Math.hypot(tx, tz);
          if (dist < 0.12 && vel.length() < 0.4) {
            hasTarget = false;
            vel.set(0, 0, 0);
          } else {
            const cap = targetSpeed01 * spec.maxSpeed;
            const desSpeed = Math.min(cap, Math.sqrt(2 * 6.5 * Math.max(0, dist - 0.05)));
            const inv = dist > 1e-5 ? 1 / dist : 0;
            const dx = tx * inv * desSpeed, dz = tz * inv * desSpeed;
            dvx = dx - vel.x; dvz = dz - vel.z;
            aMax = (dx * dx + dz * dz < vel.lengthSq()) ? 9 : 6;
          }
        }
        const dvl = Math.hypot(dvx, dvz);
        if (dvl > 1e-6) {
          const k = Math.min(1, (aMax * dt) / dvl);
          vel.x += dvx * k; vel.z += dvz * k;
        }
      } else {
        const dec = lock === 'slide' ? 4.5 : 10;
        const sp = vel.length();
        const ns = Math.max(0, sp - dec * dt);
        if (sp > 1e-4) vel.multiplyScalar(ns / sp);
      }
      vel.y = 0;
      pos.x += vel.x * dt;
      pos.z += vel.z * dt;
      pos.y = 0;

      // ---- facing with turn-rate limit ----
      const speed = vel.length();
      let desiredFacing = facing;
      if (speed > 0.5) desiredFacing = Math.atan2(vel.z, vel.x);
      else if (faceOverride !== null) desiredFacing = faceOverride;
      const maxTurn = 3.4 + 7.0 * (1 - clamp(speed / 8, 0, 1));
      const nf = approachAngle(facing, desiredFacing, maxTurn * dt);
      const tr = wrapPI(nf - facing) / dt;
      turnSm = damp(turnSm, tr, 6, dt);
      facing = nf;
      player.facing = facing;

      // ---- smoothed acceleration (for lean) ----
      accSm.x = damp(accSm.x, (vel.x - velPrev.x) / dt, 4, dt);
      accSm.z = damp(accSm.z, (vel.z - velPrev.z) / dt, 4, dt);
      const af = accSm.x * Math.cos(facing) + accSm.z * Math.sin(facing);

      // ---- gait phase locked to ground speed (feet plant, no skating) ----
      const runK = clamp(speed / 8, 0, 1);
      const moveW = smooth01(speed / 0.7);
      const stepLen = clamp(0.55 + 0.21 * speed, 0.6, 2.35) * s;
      if (moveW > 0.001) phase += TAU * (speed / (2 * stepLen)) * dt;
      tIdle += dt * idleRate;

      // ---- pose stack ----
      resetPose();
      computeLocomotionPose(speed, runK, moveW, af);
      applyActionLayer();
      applyHeadLook(dt);
      clampJoints(!!action);
      writePose();

      // ---- ground lock: the lowest sole is pinned to the pitch ----
      // A walk is never double-float. One cheap analytic pass: measure both
      // soles in world space and shift the pelvis so the lower one is exactly
      // on the grass. Skipped for dives/tackles/celebrations, which are meant
      // to leave the ground.
      const gk = !action ? 1 : (action.def.lock === 'free' ? 0.75 : 0);
      group.updateMatrixWorld(true);
      let lowest = Infinity;
      for (let i = 0; i < 4; i++) {
        const bi = i < 2 ? BI.footL : BI.footR;
        _cp.set(CONTACT_X[i & 1] * s, (STUD_Y - J.ankle) * s, 0);
        B[bi].localToWorld(_cp);
        if (_cp.y < lowest) lowest = _cp.y;
        if (i === 1 || i === 3) {
          const f = i === 1 ? 0 : 1;
          footWorld[f].set(_cp.x, _cp.y, _cp.z);
        }
      }
      if (gk > 0 && lowest < 1e5) {
        pose.hips_py -= clamp(lowest, -0.16, 0.16) * gk / s;
        writePose();
        group.updateMatrixWorld(true);
        for (let f = 0; f < 2; f++) {
          _cp.set(CONTACT_X[1] * s, (STUD_Y - J.ankle) * s, 0);
          B[f ? BI.footR : BI.footL].localToWorld(_cp);
          footWorld[f].copy(_cp);
        }
      }
      // contact-patch state consumed by the shared AO instances
      for (let f = 0; f < 2; f++) {
        const h = Math.max(0, footWorld[f].y);
        contact[f].set(footWorld[f].x, h, footWorld[f].z);
      }
    },
  };

  player.contact = contact;
  return player;
}

// ---------------------------------------------------------------------------
// Team assembly
// ---------------------------------------------------------------------------
function kitFor(teamKey, isGK, isRef) {
  if (isRef) {
    return {
      shirt: '#141414', trim: '#ffd400', shorts: '#141414', socks: '#141414',
      numFill: '#ffd400', numStroke: '#141414', crest: '#141414',
    };
  }
  const T = TEAMS[teamKey];
  if (isGK) {
    if (teamKey === 'home') {
      return { shirt: T.gk, trim: '#0e2f18', shorts: '#101014', socks: T.gk, numFill: '#ffffff', numStroke: '#0e2f18', crest: T.primary };
    }
    return { shirt: T.gk, trim: '#20222c', shorts: '#1a1a1e', socks: T.gk, numFill: '#20222c', numStroke: '#f7e3b2', crest: T.secondary };
  }
  if (teamKey === 'home') {
    return { shirt: T.shirt, trim: T.shirt2, shorts: T.shorts, socks: T.socks, numFill: '#c6ff2e', numStroke: '#0b0f14', crest: T.primary };
  }
  return { shirt: T.shirt, trim: T.shirt2, shorts: T.shorts, socks: T.socks, numFill: T.shirt2, numStroke: '#f2f4f7', crest: T.secondary };
}

const BOOT_FLASHES = ['#e63946', '#00b4d8', '#ffd166', '#80ed99', '#f72585', '#f8f9fa'];
// Uppers stay dark: a pale upper over a white sock, foreshortened head-on,
// disappears completely — the foot reads as an amputated stump.
const BOOT_UPPERS = ['#141418', '#101014', '#1c1a22', '#241014', '#10202e', '#1b1408'];
const BOOT_SOLES = ['#6e706d', '#7d7e79', '#5f666e', '#7d7030', '#575a5e'];
const SPONSOR = { home: 'PIT WALL', away: 'MERIDIAN' };

const hexRGB = (hex) => {
  const c = new THREE.Color(hex);
  return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
};

function castSpec(ctx, teamKey, sq, idx, xSign) {
  const rng = ctx.rng;
  const isRef = teamKey === null;
  const isGK = !isRef && sq.role === 'GK';
  const role = isRef ? 'REF' : sq.role;
  let height = 1.80, maxSpeed = 8.0;
  if (role === 'GK') { height = 1.88 + (rng() - 0.5) * 0.05; maxSpeed = 7.6; }
  else if (role === 'DF') { height = 1.84 + (rng() - 0.5) * 0.07; maxSpeed = 8.0 + rng() * 0.3; }
  else if (role === 'MF') { height = 1.78 + (rng() - 0.5) * 0.06; maxSpeed = 8.2 + rng() * 0.3; }
  else if (role === 'FW') { height = 1.80 + (rng() - 0.5) * 0.09; maxSpeed = 8.4 + rng() * 0.3; }
  else { height = 1.78; maxSpeed = 7.2; }
  // The Acher family. Every rng draw below happens unconditionally so that
  // flagging one never shifts any other player's appearance.
  const acher = isRef ? null : acherFor(teamKey, sq.n);
  const isStar = !!(acher && acher.superStar);   // full cheat, match.js reads it
  if (acher) maxSpeed *= acher.speedMult;
  const skin = SKIN_TONES[Math.floor(rng() * SKIN_TONES.length)];
  const rolledHair = HAIR_COLORS[Math.floor(rng() * HAIR_COLORS.length)];
  const hair = acher && acher.hair ? acher.hair : rolledHair;
  // Baldness is CAST, not rolled: with a shared rng a lucky streak used to put
  // seven shaved heads on the pitch. Exactly two men are bald.
  const bald = !isRef && ((teamKey === 'home' && idx === 3) || (teamKey === 'away' && idx === 7));
  const style = HAIR_STYLES[Math.floor(rng() * HAIR_STYLES.length)];
  // hairT = shell thickness over the scalp (units of headR); hairVol = crown
  // lift; fade = how far the sides are cut back; quiff = front-top lift;
  // curl = surface break-up amplitude.
  const STYLE = {
    buzz: { t: 0.040, vol: 0.004, front: 1.09, back: 2.06, peak: 0.03, fade: 0.30 },
    short: { t: 0.074, vol: 0.022, front: 1.03, back: 2.10, peak: 0.06, fade: 0.12 },
    crop: { t: 0.100, vol: 0.055, front: 0.99, back: 2.06, peak: 0.07, fade: 0.16 },
    fade: { t: 0.112, vol: 0.060, front: 1.00, back: 2.02, peak: 0.05, fade: 0.66 },
    quiff: { t: 0.086, vol: 0.030, front: 1.00, back: 2.08, peak: 0.11, fade: 0.34, quiff: 0.105 },
    curly: { t: 0.132, vol: 0.052, front: 1.07, back: 2.04, peak: 0.05, fade: 0.10, curl: 1.0 },
    afro: { t: 0.205, vol: 0.095, front: 1.10, back: 1.99, peak: 0.02, fade: 0.05, curl: 0.55 },
    long: { t: 0.094, vol: 0.028, front: 1.03, back: 2.34, peak: 0.07, fade: 0.04 },
  }[style];
  const bootUpper = BOOT_UPPERS[Math.floor(rng() * BOOT_UPPERS.length)];
  const bootSole = BOOT_SOLES[Math.floor(rng() * BOOT_SOLES.length)];
  const bootFlash = BOOT_FLASHES[Math.floor(rng() * BOOT_FLASHES.length)];
  const spot = isRef ? [3, 8] : FORMATION_433[idx];
  const x0 = isRef ? spot[0] : spot[0] * xSign;
  const z0 = spot[1];
  return {
    id: isRef ? 'referee' : `${teamKey}-${sq.n}`,
    team: teamKey,
    number: isRef ? 0 : sq.n,
    name: isRef ? 'GUILLOU' : sq.name,
    displayName: isRef ? 'GUILLOU' : sq.name,
    star: isStar,
    role,
    height: clamp(height, 1.72, 1.93),
    build: 0.96 + rng() * 0.13,
    maxSpeed,
    skin, hair, bald,
    hairRGB: hexRGB(hair),
    browRGB: hexRGB(hair),
    irisColor: EYE_COLORS[Math.floor(rng() * EYE_COLORS.length)],
    stubble: rng() < 0.38,
    hairStyle: style,
    hairT: STYLE.t + rng() * 0.02,
    hairVol: STYLE.vol,
    hairFront: STYLE.front + (rng() - 0.5) * 0.14,
    hairBack: STYLE.back + (rng() - 0.5) * 0.14,
    hairPeak: STYLE.peak,
    hairFade: STYLE.fade || 0,
    hairQuiff: STYLE.quiff || 0,
    hairCurl: STYLE.curl || 0,
    hairJag: 0.05 + rng() * 0.05,
    hairPh: [rng() * TAU, rng() * TAU, rng() * TAU],
    kit: kitFor(teamKey, isGK, isRef),
    isGK, isRef,
    gloveColor: teamKey === 'home' ? '#e8e6e0' : '#1d2330',
    sponsor: isRef ? '' : SPONSOR[teamKey],
    sponsorColor: teamKey === 'home' ? '#ffffff' : (isGK ? '#20222c' : '#1c3f94'),
    bootFlash: bootFlash,
    bootUpper: bootUpper,
    bootSole: bootSole,
    maps: sharedMaps(rng),
    x0, z0,
    facing0: isRef ? Math.atan2(-z0, -x0) : (teamKey === 'home' ? 0 : Math.PI),
  };
}

// Tight contact AO under each sole: darkest at the sole, with a faint lit ring
// where the sward is pressed flat. One InstancedMesh for all 46 feet — this is
// what gives a planted foot weight, separately from the cast shadow.
function makeContactPatches(ctx, count) {
  const tex = makeCanvasTexture(128, 128, (g, W, H) => {
    const im = g.createImageData(W, H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5) / W - 0.5, dy = (y + 0.5) / H - 0.5;
        const r = Math.hypot(dx, dy) * 2;
        const core = Math.pow(Math.max(0, 1 - r / 0.80), 2.2);
        const ring = Math.exp(-Math.pow((r - 0.74) / 0.30, 2));
        const i = (y * W + x) * 4;
        im.data[i] = 14 + 110 * ring;
        im.data[i + 1] = 16 + 120 * ring;
        im.data[i + 2] = 10 + 70 * ring;
        im.data[i + 3] = Math.min(255, 255 * (0.86 * core + 0.05 * ring));
      }
    }
    g.putImageData(im, 0, 0);
  }, { wrap: THREE.ClampToEdgeWrapping });
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, depthWrite: false, opacity: 0.85,
    toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2,
  });
  const im = new THREE.InstancedMesh(geo, mat, count);
  im.frustumCulled = false;
  im.renderOrder = 2;
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  ctx.scene.add(im);
  return im;
}

export function createTeams(ctx) {
  const home = [];
  const away = [];
  for (let i = 0; i < 11; i++) {
    home.push(createPlayer(ctx, castSpec(ctx, 'home', HOME_SQUAD[i], i, 1)));
  }
  for (let i = 0; i < 11; i++) {
    away.push(createPlayer(ctx, castSpec(ctx, 'away', AWAY_SQUAD[i], i, -1)));
  }
  const referee = createPlayer(ctx, castSpec(ctx, null, null, 0, 1));
  const players = [...home, ...away, referee];

  const patches = makeContactPatches(ctx, players.length * 2);
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _p = new THREE.Vector3();
  const _sc = new THREE.Vector3();
  const _up = new THREE.Vector3(0, 1, 0);

  function updatePatches() {
    let n = 0;
    for (let i = 0; i < players.length; i++) {
      const pl = players[i];
      _q.setFromAxisAngle(_up, -pl.facing);
      for (let f = 0; f < 2; f++) {
        const c = pl.contact[f];
        // shrink out as the foot lifts — a planted sole gets a tight dark core
        const r = Math.max(0, 0.30 - 1.45 * c.y);
        _p.set(c.x, 0.013, c.z);
        _sc.set(r * 1.5, 1, r * 1.05);
        _m.compose(_p, _q, _sc);
        patches.setMatrixAt(n++, _m);
      }
    }
    patches.instanceMatrix.needsUpdate = true;
  }

  return {
    players,
    home,
    away,
    referee,
    update(dt) {
      for (let i = 0; i < players.length; i++) players[i].update(dt);
      updatePatches();
    },
  };
}
