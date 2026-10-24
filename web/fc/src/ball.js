import * as THREE from 'three';
import { PITCH, GOAL, clamp, lerp, damp, makeCanvasTexture } from './util.js';

// ---------------------------------------------------------------------------
// ball.js — match ball: flight physics (gravity / quadratic drag / Magnus),
// bounce with spin exchange, rolling that visually locks to ground speed, and a
// proper football surface: the truncated-icosahedron panel set (12 charcoal
// pentagons, 20 white hexagons) with stitched seam grooves and moulded grip,
// generated in DIRECTION space (not painted into equirect UV) so the panels are
// geometrically right and nothing warps at the poles.
// Contract: createBall(ctx) -> { mesh, pos, vel, spin, radius, controlledBy,
//                                update(dt), kick(velocity, spin?), place(x,z),
//                                stopDead() }
// ---------------------------------------------------------------------------

const R = 0.11;              // ball radius (m) — the contract number
const SINK = 0.014;          // how deep the ball nestles into the sward (m)
const GROUND_Y = R - SINK;   // resting height of the ball centre
const DECAL_Y = 0.021;       // contact-shadow decal height above the turf

// --- Physics tuning ---------------------------------------------------------
// All tuned for "televised football" feel at broadcast distance:
//  * 28 m/s drive from 20 m arrives ~0.8 s later at ~22 m/s with visible dip.
//  * 55 rad/s of curl on a 24 m/s shot bends ~2.5-3 m over its flight.
//  * firm ground passes (12-16 m/s) roll out over ~18-27 m.
const GRAV = 9.81;
const DRAG_K = 0.0125;        // quadratic air drag: a = -k * |v| * v  (1/m)
const MAGNUS_K = 0.0052;      // a = k * (spin x vel)                  (m/rad)
const MAGNUS_MAX = 14;        // cap Magnus accel (m/s^2) — no silly banana
const RESTITUTION = 0.62;     // vertical bounce energy keep (velocity ratio)
const BOUNCE_MIN_VY = 0.75;   // below this impact speed the bounce is dead
const ROLL_DECEL = 3.2;       // grass rolling resistance (m/s^2)
const STOP_SPEED = 0.12;      // below this the rolling ball settles
const SLIP_TO_VEL = 0.28;     // bounce: contact slip -> horizontal velocity
const SLIP_TO_SPIN = 0.42;    // bounce: contact slip -> spin (hollow-sphere-ish)
const SPIN_KEEP_BOUNCE = 0.62;// spin retained through a bounce
const AIR_SPIN_LAMBDA = 0.2;  // slow spin decay in flight (1/s)
const ROLL_ALIGN_LAMBDA = 20; // how fast spin locks to rolling on the ground
const YAW_SPIN_GROUND_LAMBDA = 3.5; // vertical-axis spin dies on grass
const MAX_SPEED = 46;         // sanity clamp (m/s)

// --- Goal frame / net (derived from util constants; pitch.js builds visuals
// on the same numbers so "off the woodwork" lines up) -----------------------
const LINE_X = PITCH.length / 2;            // 52.5
const POST_Z = GOAL.width / 2 + GOAL.postR; // post center (inner face at 3.66)
const BAR_Y = GOAL.height + GOAL.postR;     // crossbar center (lower edge 2.44)
const HIT_R = R + GOAL.postR;               // ball-center-to-post-axis contact
const NET_BACK_X = LINE_X + GOAL.depth - 0.12;
const NET_SIDE_Z = POST_Z - 0.02;
const NET_TOP_Y = GOAL.height - 0.02;
const FRAME_E = 0.72;                       // woodwork is lively

// ===========================================================================
// SURFACE MODEL
// ===========================================================================
// A football is a truncated icosahedron: 12 pentagons + 20 hexagons. We get
// that layout EXACTLY as the spherical Voronoi diagram of 12 icosahedron
// vertices (-> the pentagons) plus the 20 icosahedron face centres (-> the
// hexagons). It is evaluated in DIRECTION space and only then written into the
// equirect texture, so the panels stay geometrically correct: no pinched
// pentagons at the poles, no smeared stripes, and — critically — no beach-ball
// swirl bands. Classic white ball, dark panels, ~2 mm seam grooves, moulded
// micro-grip.
// ---------------------------------------------------------------------------

// 32 panel centres. Indices 0..11 are pentagons, 12..31 hexagons.
const CEN = new Float64Array(32 * 3);
(function buildPanelLayout() {
  const PHI = (1 + Math.sqrt(5)) / 2;
  const v = [];
  for (const a of [-1, 1]) {
    for (const b of [-1, 1]) {
      v.push([0, a, b * PHI], [a, b * PHI, 0], [b * PHI, 0, a]);
    }
  }
  const d2 = (p, q) => {
    const x = p[0] - q[0], y = p[1] - q[1], z = p[2] - q[2];
    return x * x + y * y + z * z;
  };
  let e2 = Infinity;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) e2 = Math.min(e2, d2(v[i], v[j]));
  // pentagons first, then every icosahedral face centre (mutually-adjacent triple)
  const cen = v.map((p) => p.slice());
  for (let i = 0; i < 12; i++) {
    for (let j = i + 1; j < 12; j++) {
      if (Math.abs(d2(v[i], v[j]) - e2) > 1e-6) continue;
      for (let k = j + 1; k < 12; k++) {
        if (Math.abs(d2(v[i], v[k]) - e2) > 1e-6) continue;
        if (Math.abs(d2(v[j], v[k]) - e2) > 1e-6) continue;
        cen.push([v[i][0] + v[j][0] + v[k][0], v[i][1] + v[j][1] + v[k][1], v[i][2] + v[j][2] + v[k][2]]);
      }
    }
  }
  // tilt the whole set so no panel centre lands on an equirect pole
  const ca = Math.cos(0.42), sa = Math.sin(0.42);
  for (let i = 0; i < 32; i++) {
    const p = cen[i];
    let x = p[0];
    let y = p[1] * ca - p[2] * sa;
    let z = p[1] * sa + p[2] * ca;
    const l = Math.hypot(x, y, z) || 1;
    x /= l; y /= l; z /= l;
    const b = i * 3;
    CEN[b] = x; CEN[b + 1] = y; CEN[b + 2] = z;
  }
})();

const smooth01 = (t) => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

// Moulded grip: two high-frequency lattices, ~3-5 mm cells on a 22 cm ball.
function gripField(nx, ny, nz) {
  return 0.64 * Math.sin(151.3 * nx + 0.71) * Math.sin(157.1 * ny + 2.22) * Math.sin(163.9 * nz + 4.11)
       + 0.36 * Math.sin(223.7 * ny + 1.93) * Math.sin(211.3 * nz + 3.31) * Math.sin(229.1 * nx + 0.42);
}

// Plain Voronoi gives pentagons ~36% of the surface; a real truncated
// icosahedron is ~28%. This bias pushes the pentagon/hexagon bisector back so
// the ball stays predominantly WHITE at broadcast distance.
const PENT_BIAS = 0.030;

// Panel partition for a unit direction. Writes into `o`:
//   seam : ~angular distance to the nearest panel boundary (0 == on the seam)
//   face : 0..31 panel id
//   pent : 1 if this panel is one of the 12 pentagons
function panelField(nx, ny, nz, o) {
  let i1 = 0, i2 = 0, d1 = -2, dd2 = -2;
  for (let i = 0; i < 32; i++) {
    const b = i * 3;
    let d = nx * CEN[b] + ny * CEN[b + 1] + nz * CEN[b + 2];
    if (i < 12) d -= PENT_BIAS;
    if (d > d1) { dd2 = d1; i2 = i1; d1 = d; i1 = i; }
    else if (d > dd2) { dd2 = d; i2 = i; }
  }
  const b1 = i1 * 3, b2 = i2 * 3;
  const ex = CEN[b1] - CEN[b2], ey = CEN[b1 + 1] - CEN[b2 + 1], ez = CEN[b1 + 2] - CEN[b2 + 2];
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
  o.seam = (d1 - dd2) / el;   // perpendicular distance to the bisector great circle
  o.face = i1;
  o.pent = i1 < 12 ? 1 : 0;
}

// Palette. The hexagons are a *slightly* held-back white so a floodlit match
// ball's diffuse stays under the bloom threshold and doesn't halo around the
// whole silhouette; the dark pentagons then make it read white by contrast and
// the specular highlights still punch through.
const WHT_R = 208, WHT_G = 211, WHT_B = 206;    // hexagon white
const BLK_R = 33, BLK_G = 36, BLK_B = 44;       // pentagon charcoal (never pure black)
const SW_R = 150, SW_G = 154, SW_B = 150;       // seam groove shading on white
const SD_R = 15, SD_G = 17, SD_B = 22;          // seam groove shading on dark
const GRV_R = 62, GRV_G = 64, GRV_B = 68;       // the stitch line itself
const ACC_R = 138, ACC_G = 34, ACC_B = 44;      // Breizh red, logo accent only

const H_UNIT = 0.0110;   // height unit in ball-radius units (1 => ~1.2 mm)

/**
 * Evaluate colour / height / roughness over the whole equirect grid once.
 * Returns typed arrays consumed by the three texture painters below.
 */
function computeSurface(w, h, rng) {
  const n = w * h;
  const col = new Uint8ClampedArray(n * 3);
  const hgt = new Float32Array(n);
  const rgh = new Uint8ClampedArray(n);

  const sinP = new Float64Array(w), cosP = new Float64Array(w);
  for (let px = 0; px < w; px++) {
    const phi = ((px + 0.5) / w) * Math.PI * 2;
    sinP[px] = Math.sin(phi);
    cosP[px] = Math.cos(phi);
  }

  // deterministic per-panel moulding tone (a real ball is never perfectly flat)
  const tone = new Float64Array(32);
  for (let f = 0; f < 32; f++) tone[f] = (rng() - 0.5) * (f < 12 ? 4.0 : 5.0);

  const o = { seam: 0, face: 0, pent: 0 };

  let i = 0;
  for (let py = 0; py < h; py++) {
    const theta = ((py + 0.5) / h) * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let px = 0; px < w; px++, i++) {
      const nx = -cosP[px] * st, ny = ct, nz = sinP[px] * st;

      panelField(nx, ny, nz, o);
      const f = o.face;
      const pent = o.pent;
      const gp = gripField(nx, ny, nz);

      // seam masks: a tight dark core and a wider soft shading falloff
      const seamCore = Math.exp(-((o.seam / 0.0105) * (o.seam / 0.0105)));
      const seamSoft = 1 - smooth01(o.seam / 0.030);

      // ---- colour -------------------------------------------------------
      const t = tone[f] + gp * (pent ? 1.8 : 3.2);
      let r, gg, b;
      if (pent) { r = BLK_R + t; gg = BLK_G + t; b = BLK_B + t; }
      else { r = WHT_R + t; gg = WHT_G + t; b = WHT_B + t; }
      // panel edge falls into shadow as it curves down to the bond line...
      const ks = seamSoft * 0.34 + seamCore * 0.28;
      if (pent) {
        r = lerp(r, SD_R, ks); gg = lerp(gg, SD_G, ks); b = lerp(b, SD_B, ks);
      } else {
        r = lerp(r, SW_R, ks); gg = lerp(gg, SW_G, ks); b = lerp(b, SW_B, ks);
      }
      // ...and the stitch itself is one continuous line across both panel
      // colours, which also softens the hard white/charcoal boundary
      const kg = seamCore * 0.52;
      r = lerp(r, GRV_R, kg); gg = lerp(gg, GRV_G, kg); b = lerp(b, GRV_B, kg);
      const ci = i * 3;
      col[ci] = r; col[ci + 1] = gg; col[ci + 2] = b;

      // ---- height (for the normal map) -----------------------------------
      // panels dome slightly away from the stitch, seams cut a groove, grip
      // pebbles ride on top.
      hgt[i] = 0.34 * smooth01(o.seam / 0.14)
             - 1.10 * seamCore
             + 0.28 * gp;

      // ---- roughness ------------------------------------------------------
      // semi-matte body; the grip modulates it so the floodlights break into a
      // broad speckled sheen instead of one mirror blob.
      const ro = (pent ? 0.33 : 0.38) + gp * 0.15 + seamSoft * 0.24;
      rgh[i] = clamp(ro, 0.13, 0.95) * 255;
    }
  }
  return { col, hgt, rgh };
}

/**
 * Where to print the marks: the CENTRES of a few white hexagons, projected into
 * equirect UV, so a logo always sits square in the middle of a panel instead of
 * bleeding across a stitch or onto a dark pentagon.
 * The mapping matches computeSurface exactly —
 *   n = (-cos phi * sin theta, cos theta, sin phi * sin theta)
 *   u = phi / 2pi,  v = theta / pi
 * (canvas row 0 is the +Y pole: SphereGeometry UVs and CanvasTexture flipY
 * cancel out, which is why the panel field lands the right way up).
 */
function findMarkSpots(count) {
  const cands = [];
  for (let i = 12; i < 32; i++) {           // hexagons only
    const b = i * 3;
    const ny = CEN[b + 1];
    if (Math.abs(ny) > 0.5) continue;       // keep the equirect stretch under 1.16x
    const theta = Math.acos(clamp(ny, -1, 1));
    let phi = Math.atan2(CEN[b + 2], -CEN[b]);
    if (phi < 0) phi += Math.PI * 2;
    cands.push({ u: phi / (Math.PI * 2), v: theta / Math.PI, sinT: Math.sin(theta), lat: Math.abs(ny) });
  }
  cands.sort((a, b) => a.lat - b.lat);      // flattest panels first
  const out = [];
  for (const c of cands) {
    if (out.length >= count) break;
    if (out.some((p) => { const d = Math.abs(p.u - c.u); return Math.min(d, 1 - d) < 0.18; })) continue;
    out.push(c);
  }
  return out;
}

/** Height field -> tangent-space normal map, with equirect metric correction. */
function paintNormal(c, w, h, hgt) {
  const img = c.createImageData(w, h);
  const d = img.data;
  const dV = Math.PI / h;                    // arc per texel along theta
  let i = 0;
  for (let py = 0; py < h; py++) {
    const theta = ((py + 0.5) / h) * Math.PI;
    const st = Math.max(Math.sin(theta), 0.06);
    const dU = (Math.PI * 2 / w) * st;       // arc per texel along phi
    const rowUp = (py > 0 ? py - 1 : py) * w;
    const rowDn = (py < h - 1 ? py + 1 : py) * w;
    const row = py * w;
    for (let px = 0; px < w; px++, i++) {
      const xp = px === w - 1 ? 0 : px + 1;
      const xm = px === 0 ? w - 1 : px - 1;
      const dhU = (hgt[row + xp] - hgt[row + xm]) * 0.5 * H_UNIT;
      const dhV = (hgt[rowDn + px] - hgt[rowUp + px]) * 0.5 * H_UNIT;
      // +V in texture space points toward decreasing py (north), hence the sign
      const sU = dhU / dU;
      const sV = -dhV / dV;
      const inv = 1 / Math.sqrt(sU * sU + sV * sV + 1);
      const o = i * 4;
      d[o] = (-sU * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (-sV * inv * 0.5 + 0.5) * 255;
      d[o + 2] = (inv * 0.5 + 0.5) * 255;
      d[o + 3] = 255;
    }
  }
  c.putImageData(img, 0, 0);
}

/**
 * Small printed mark, centred on one white hexagon. `s` is in ARC pixels; the
 * 1/sinT scale undoes the equirect horizontal stretch at that latitude so the
 * lockup isn't smeared on the ball. Kept tiny on purpose: a match ball carries
 * a discreet logo, not a livery.
 */
function drawMark(c, w, h, spot, s, xShift) {
  c.save();
  c.translate(spot.u * w + xShift, spot.v * h);
  c.scale(1 / spot.sinT, 1);
  c.translate(-0.6 * s, 0);                // recentre the whole lockup
  c.lineJoin = 'round';
  c.globalAlpha = 0.8;
  c.fillStyle = `rgb(${ACC_R},${ACC_G},${ACC_B})`;
  c.beginPath();                       // small red chevron
  c.moveTo(-1.00 * s, 0.30 * s);
  c.lineTo(-0.38 * s, -0.44 * s);
  c.lineTo(-0.10 * s, -0.12 * s);
  c.lineTo(-0.72 * s, 0.44 * s);
  c.closePath();
  c.fill();
  c.fillStyle = '#2b2f37';
  c.font = `700 ${Math.max(5, Math.round(0.62 * s))}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText('KROAZ', 0.06 * s, -0.06 * s);
  c.globalAlpha = 0.45;
  c.font = `600 ${Math.max(4, Math.round(0.30 * s))}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  c.fillText('OMNI 24', 0.08 * s, 0.38 * s);
  c.restore();
}

// ===========================================================================
export function createBall(ctx) {
  const { scene, rng, quality } = ctx;
  const low = quality === 'low';

  // --- Surface --------------------------------------------------------------
  const texW = low ? 512 : 1024;
  const texH = texW / 2;
  const S = computeSurface(texW, texH, rng);
  const markSpots = findMarkSpots(3);

  const map = makeCanvasTexture(texW, texH, (c, w, h) => {
    const img = c.createImageData(w, h);
    const d = img.data;
    for (let i = 0, n = w * h; i < n; i++) {
      const ci = i * 3, o = i * 4;
      d[o] = S.col[ci]; d[o + 1] = S.col[ci + 1]; d[o + 2] = S.col[ci + 2]; d[o + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    // a few small marks spread around the ball, each centred in a white
    // hexagon, so one is nearly always facing camera
    const s = w * 0.017;   // whole lockup ~0.34 rad of arc: fits inside a hexagon
    for (const spot of markSpots) {
      drawMark(c, w, h, spot, s, 0);
      // repeat across the seam of the map so a mark near u=0/1 isn't clipped
      if (spot.u < 0.1) drawMark(c, w, h, spot, s, w);
      else if (spot.u > 0.9) drawMark(c, w, h, spot, s, -w);
    }
    // a match ball, not a shop-window ball: a few very faint grass scuffs
    for (let i = 0; i < 4; i++) {
      c.save();
      c.translate(rng() * w, h * (0.22 + rng() * 0.56));
      c.rotate(rng() * Math.PI);
      c.fillStyle = 'rgba(92,102,62,0.07)';
      c.beginPath();
      c.ellipse(0, 0, w * (0.025 + rng() * 0.03), h * (0.012 + rng() * 0.016), 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }
  });

  const normalMap = makeCanvasTexture(texW, texH, (c, w, h) => paintNormal(c, w, h, S.hgt),
    { colorSpace: THREE.NoColorSpace });

  const roughnessMap = makeCanvasTexture(texW, texH, (c, w, h) => {
    const img = c.createImageData(w, h);
    const d = img.data;
    for (let i = 0, n = w * h; i < n; i++) {
      const o = i * 4, v = S.rgh[i];
      d[o] = v; d[o + 1] = v; d[o + 2] = v; d[o + 3] = 255;
    }
    c.putImageData(img, 0, 0);
  }, { colorSpace: THREE.NoColorSpace });

  const material = new THREE.MeshPhysicalMaterial({
    map,
    normalMap,
    normalScale: new THREE.Vector2(1.0, 1.0),
    roughnessMap,
    roughness: 1.0,           // the map carries the actual values
    metalness: 0.0,
    // Semi-matte body + a thin lacquer: the clearcoat gives two or three crisp
    // mast highlights that punch past the bloom threshold, while the rough body
    // keeps a broad low sheen instead of one blown blob.
    clearcoat: 0.52,
    clearcoatRoughness: 0.11,
    clearcoatNormalMap: normalMap,
    clearcoatNormalScale: new THREE.Vector2(0.5, 0.5),
    // grazing-angle sheen reads as the floodlight rim on the silhouette —
    // kept modest so the rim stays a rim and does not bloom into a halo
    sheen: 0.3,
    sheenRoughness: 0.62,
    sheenColor: new THREE.Color(0xf6e6cf),
    envMapIntensity: 0.6,
  });

  const geo = new THREE.SphereGeometry(R, low ? 40 : 64, low ? 26 : 40);
  {
    // real (if shallow) seam geometry so the silhouette isn't a billiard ball
    const pa = geo.attributes.position;
    const o = { seam: 0, face: 0, pent: 0 };
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const l = Math.hypot(x, y, z) || 1;
      panelField(x / l, y / l, z / l, o);
      const groove = Math.exp(-((o.seam / 0.020) * (o.seam / 0.020)));
      const d = R - 0.0011 * groove + 0.0006 * smooth01(o.seam / 0.16);
      pa.setXYZ(i, (x / l) * d, (y / l) * d, (z / l) * d);
    }
    pa.needsUpdate = true;
  }

  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.position.set(0, GROUND_Y, 0);
  // deterministic "random" resting orientation
  mesh.quaternion.setFromEuler(new THREE.Euler(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2));
  scene.add(mesh);

  // --- Contact shadow / grass indent ---------------------------------------
  // The pitch shadow map is far too coarse to resolve a 22 cm sphere, so the
  // ball floated on top of the sward. This decal supplies the dark contact
  // patch and its soft penumbra, and scales/fades with height.
  const contactTex = makeCanvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    const gr = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    // near-solid out to the ball's own footprint, then a soft penumbra — so the
    // turf right at the contact point actually goes dark and the ball plants
    // instead of hovering over a detached blob.
    gr.addColorStop(0.00, '#ffffff');
    gr.addColorStop(0.26, '#f4f4f4');
    gr.addColorStop(0.44, '#cccccc');
    gr.addColorStop(0.60, '#8a8a8a');
    gr.addColorStop(0.78, '#3a3a3a');
    gr.addColorStop(0.92, '#0c0c0c');
    gr.addColorStop(1.00, '#000000');
    c.fillStyle = gr;
    c.beginPath();
    c.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2);
    c.fill();
  }, { colorSpace: THREE.NoColorSpace, wrap: THREE.ClampToEdgeWrapping });

  const contactMat = new THREE.MeshBasicMaterial({
    color: 0x131c0e,
    alphaMap: contactTex,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    toneMapped: false,
  });
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), contactMat);
  contact.rotation.x = -Math.PI / 2;
  contact.renderOrder = 3;
  contact.frustumCulled = false;
  scene.add(contact);

  function updateContact() {
    const p = mesh.position;
    const air = Math.max(0, p.y - GROUND_Y);
    const t = clamp(air / 3.2, 0, 1);
    if (t >= 0.999) { contact.visible = false; return; }
    contact.visible = true;
    // 0.40 m on the deck (≈ 1.8 ball widths) growing/fading with altitude
    const s = 0.40 * (1 + 2.6 * t);
    contact.scale.set(s, s, 1);
    contact.position.set(p.x, DECAL_Y, p.z);
    // deliberately not opaque: the floodlight shadow map already puts the dark
    // core down, this only fills the tight contact occlusion the map can't
    // resolve at 22 cm. Stacking both to solid black reads as a hole in the turf.
    contactMat.opacity = 0.46 * (1 - t) * (1 - 0.45 * t);
  }

  // --- State ----------------------------------------------------------------
  const vel = new THREE.Vector3();
  const spin = new THREE.Vector3(); // rad/s, world axes
  const lastPos = mesh.position.clone();

  // scratch
  const _acc = new THREE.Vector3();
  const _mag = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _axis = new THREE.Vector3();

  // --- Rotation from spin (world-axis premultiply) --------------------------
  function rotateBySpin(h) {
    const wLen = spin.length();
    if (wLen < 1e-4) return;
    _axis.copy(spin).multiplyScalar(1 / wLen);
    _q.setFromAxisAngle(_axis, wLen * h);
    mesh.quaternion.premultiply(_q).normalize();
  }

  // --- Goal frame: posts, crossbar, net catch -------------------------------
  // inNet flips true only when the ball crosses the goal line INSIDE the
  // frame; a ball passing just wide/over must never be caught by the net.
  let inNet = false;

  function collideGoalFrame(pos, prevAx) {
    const ax = Math.abs(pos.x);
    if (ax < LINE_X - 1.2 || ax > LINE_X + GOAL.depth + 1.0) { inNet = false; return; }
    const sx = pos.x >= 0 ? 1 : -1;
    const gx = sx * LINE_X;

    // posts — vertical cylinders at (gx, ±POST_Z)
    if (pos.y < BAR_Y + GOAL.postR + R) {
      for (const sz of [-1, 1]) {
        const dx = pos.x - gx, dz = pos.z - sz * POST_Z;
        const d2 = dx * dx + dz * dz;
        if (d2 < HIT_R * HIT_R && d2 > 1e-8) {
          const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
          pos.x = gx + nx * HIT_R;
          pos.z = sz * POST_Z + nz * HIT_R;
          const vn = vel.x * nx + vel.z * nz;
          if (vn < 0) {
            vel.x -= (1 + FRAME_E) * vn * nx;
            vel.z -= (1 + FRAME_E) * vn * nz;
            spin.multiplyScalar(0.85);
          }
        }
      }
    }
    // crossbar — horizontal cylinder along z at (gx, BAR_Y)
    if (Math.abs(pos.z) < POST_Z + GOAL.postR) {
      const dx = pos.x - gx, dy = pos.y - BAR_Y;
      const d2 = dx * dx + dy * dy;
      if (d2 < HIT_R * HIT_R && d2 > 1e-8) {
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        pos.x = gx + nx * HIT_R;
        pos.y = BAR_Y + ny * HIT_R;
        const vn = vel.x * nx + vel.y * ny;
        if (vn < 0) {
          vel.x -= (1 + FRAME_E) * vn * nx;
          vel.y -= (1 + FRAME_E) * vn * ny;
          spin.multiplyScalar(0.85);
        }
      }
    }
    // net — engages only after a genuine line crossing inside the frame:
    // soft catch, ball dies in the goal
    const ax2 = Math.abs(pos.x); // post/bar contact may have moved the ball
    if (!inNet && prevAx <= LINE_X + R && ax2 > LINE_X + R &&
        Math.abs(pos.z) < POST_Z - 0.02 && pos.y < BAR_Y - 0.02) {
      inNet = true;
    }
    if (inNet && ax2 < LINE_X) inNet = false; // bounced back out of the frame
    if (inNet) {
      if (ax2 > NET_BACK_X - R) {                      // back net
        pos.x = sx * (NET_BACK_X - R);
        vel.x *= -0.1;
        vel.y *= 0.35; vel.z *= 0.35;
        spin.multiplyScalar(0.35);
      }
      const az = Math.abs(pos.z);
      if (az > NET_SIDE_Z - R) {                       // side nets
        const szn = pos.z >= 0 ? 1 : -1;
        pos.z = szn * (NET_SIDE_Z - R);
        vel.z *= -0.1;
        vel.x *= 0.5; vel.y *= 0.5;
        spin.multiplyScalar(0.5);
      }
      if (pos.y > NET_TOP_Y - R) {                     // roof net
        pos.y = NET_TOP_Y - R;
        vel.y *= -0.1;
        vel.x *= 0.5; vel.z *= 0.5;
        spin.multiplyScalar(0.5);
      }
    }
  }

  // --- One physics substep --------------------------------------------------
  function integrate(h) {
    const pos = mesh.position;
    const airborne = pos.y > GROUND_Y + 0.05;

    // forces
    _acc.set(0, -GRAV, 0);
    const speed = vel.length();
    if (speed > 1e-4) {
      _acc.addScaledVector(vel, -DRAG_K * speed); // quadratic drag
      if (airborne && spin.lengthSq() > 1e-4) {
        _mag.crossVectors(spin, vel).multiplyScalar(MAGNUS_K);
        const m = _mag.length();
        if (m > MAGNUS_MAX) _mag.multiplyScalar(MAGNUS_MAX / m);
        _acc.add(_mag);
      }
    }
    vel.addScaledVector(_acc, h);
    if (vel.lengthSq() > MAX_SPEED * MAX_SPEED) vel.setLength(MAX_SPEED);
    const prevAx = Math.abs(pos.x); // for net line-crossing detection
    pos.addScaledVector(vel, h);

    // ground contact
    if (pos.y < GROUND_Y) {
      pos.y = GROUND_Y;
      if (vel.y < -BOUNCE_MIN_VY) {
        // bounce: restitution + contact-slip exchange between velocity & spin.
        // slip = velocity of the contact point: (vx + R*wz, vz - R*wx)
        const slipX = vel.x + R * spin.z;
        const slipZ = vel.z - R * spin.x;
        vel.y = -vel.y * RESTITUTION;
        vel.x -= SLIP_TO_VEL * slipX;
        vel.z -= SLIP_TO_VEL * slipZ;
        spin.z -= (SLIP_TO_SPIN * slipX) / R;
        spin.x += (SLIP_TO_SPIN * slipZ) / R;
        spin.multiplyScalar(SPIN_KEEP_BOUNCE);
        spin.y *= 0.7;
      } else {
        vel.y = 0;
      }
    }

    const grounded = pos.y <= GROUND_Y + 0.005 && Math.abs(vel.y) < 0.5;
    if (grounded) {
      // rolling resistance
      const hs = Math.hypot(vel.x, vel.z);
      if (hs > 1e-4) {
        const drop = ROLL_DECEL * h;
        const f = hs <= drop ? 0 : (hs - drop) / hs;
        vel.x *= f; vel.z *= f;
      }
      if (Math.hypot(vel.x, vel.z) < STOP_SPEED) { vel.x = 0; vel.z = 0; }
      // spin locks to true rolling: w = (vz/R, ~0, -vx/R) — no ice-skating.
      spin.x = damp(spin.x, vel.z / R, ROLL_ALIGN_LAMBDA, h);
      spin.z = damp(spin.z, -vel.x / R, ROLL_ALIGN_LAMBDA, h);
      spin.y = damp(spin.y, 0, YAW_SPIN_GROUND_LAMBDA, h);
      if (vel.x === 0 && vel.z === 0) {
        spin.x = damp(spin.x, 0, 10, h);
        spin.z = damp(spin.z, 0, 10, h);
        if (spin.lengthSq() < 0.01) spin.set(0, 0, 0);
      }
    } else {
      const decay = Math.exp(-AIR_SPIN_LAMBDA * h);
      spin.multiplyScalar(decay);
    }

    collideGoalFrame(pos, prevAx);
    rotateBySpin(h);
  }

  // --- Controlled (dribbling) update ---------------------------------------
  // match.js has already written pos this tick; our job is rock-stability at
  // the feet plus a visually correct roll derived from the observed motion.
  function controlledUpdate(dt) {
    const pos = mesh.position;
    pos.y = GROUND_Y;                           // nestled in the sward
    let ox = (pos.x - lastPos.x) / dt;
    let oz = (pos.z - lastPos.z) / dt;
    const os = Math.hypot(ox, oz);
    if (os > 14) { ox *= 14 / os; oz *= 14 / os; } // restart teleport guard
    // smooth observed velocity so the roll rate doesn't chatter frame to frame
    vel.x = damp(vel.x, ox, 18, dt);
    vel.z = damp(vel.z, oz, 18, dt);
    vel.y = 0;
    spin.x = damp(spin.x, vel.z / R, 14, dt);
    spin.z = damp(spin.z, -vel.x / R, 14, dt);
    spin.y = damp(spin.y, 0, 8, dt);
    rotateBySpin(dt);
  }

  // --- Public API -----------------------------------------------------------
  const ball = {
    mesh,
    pos: mesh.position, // same object, per contract
    vel,
    spin,
    radius: R,
    controlledBy: null,

    update(dt) {
      if (!(dt > 0)) return;
      if (ball.controlledBy) {
        controlledUpdate(dt);
      } else {
        // substep fast balls so posts/net/ground never tunnel at 120 Hz
        const steps = clamp(Math.ceil((vel.length() * dt) / 0.12), 1, 4);
        const h = dt / steps;
        for (let i = 0; i < steps; i++) integrate(h);
      }
      lastPos.copy(mesh.position);
      updateContact();
    },

    kick(velocity, kickSpin) {
      vel.copy(velocity);
      if (vel.lengthSq() > MAX_SPEED * MAX_SPEED) vel.setLength(MAX_SPEED);
      if (kickSpin) spin.copy(kickSpin); else spin.set(0, 0, 0);
      if (mesh.position.y < GROUND_Y) mesh.position.y = GROUND_Y;
      ball.controlledBy = null;
      inNet = false;
      lastPos.copy(mesh.position);
      updateContact();
    },

    place(x, z) {
      mesh.position.set(x, GROUND_Y, z);
      vel.set(0, 0, 0);
      spin.set(0, 0, 0);
      ball.controlledBy = null;
      inNet = false;
      lastPos.copy(mesh.position);
      updateContact();
    },

    stopDead() {
      vel.set(0, 0, 0);
      spin.set(0, 0, 0);
      if (mesh.position.y < GROUND_Y) mesh.position.y = GROUND_Y;
      lastPos.copy(mesh.position);
      updateContact();
    },
  };

  updateContact();
  return ball;
}
