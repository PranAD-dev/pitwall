import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PITCH, GOAL, makeCanvasTexture, makeRng, lerp, clamp } from './util.js';

// ---------------------------------------------------------------------------
// createPitch(ctx) → { group, update(dt, matchState) }
//
// Broadcast-quality grass field for the Stade Raoul Brulat.
//
// ONE ground surface. There is no second coplanar plane anywhere: the blade
// detail, the mowing stripes and the wear are all folded into the grass
// material via onBeforeCompile, so nothing can ever z-fight with the paint.
//
//  - map          field-scale albedo (2048px): macro moisture/dry tonality,
//                 apron, goalmouth scuffs, contact darkening at the posts.
//                 NO stripes — stripes are a shading phenomenon, see below.
//  - roughnessMap field-scale sheen base (damp/dry, worn = matte).
//  - uBlade       ONE packed blade texture (rg = tangent-space normal xy,
//                 b = tuft albedo multiplier), sampled TWICE with a uv that is
//                 STRETCHED 1.8:1 along the mow axis: a mid tile (2.55 m,
//                 world-aligned) that always runs, and a near tile (1.13 m,
//                 lattice TURNED 22.5°) that blends in inside 50 m so the
//                 broadcast foreground shows clumped tufts instead of velvet.
//                 Nothing in the pack is bigger than 1/13 of a tile, the two
//                 scales are incommensurate and the lattices are not parallel:
//                 there is no periodicity left for the eye to lock onto, and
//                 all field-scale tonality comes from the non-repeating map.
//  - uWear        tiling divot/stud-scar/soil/clippings sheet, masked in world
//                 space to the goalmouths, centre circle and penalty spots
//                 (+ a low scatter everywhere).
//
// MOWING STRIPES are driven by roughness + an anisotropic normal tilt, not by
// albedo.  Bands are 5.25 m of constant X (the mower drives along Z), the
// transition is ~8 cm, the boundary wanders like a real roller, the grass
// normal leans ±Z per band, and the band value flips with the horizontal view
// vector — a band mown toward the lens is darker and glossier, and that
// relationship inverts when the camera swings.  That is the actual physics of
// a stripe, and it means the contrast peaks when you look down the stripe axis.
//
// MARKINGS are painted, not drawn: 12 cm of warm-grey paint with a ragged
// blade-bitten edge and a darker wet line where the paint meets turf, carried
// on merged strip geometry with proper across-the-line UVs.
//
// GOALS: elliptical posts with a flat rear face, taped seams + clips at every
// attachment, a taut ~7.4 cm diamond net on 2.1 mm cord, translucent
// so the back mesh reads denser than the front, and ground pegs. The net and
// the frame both cast (see netDepthMat) — whether that shadow actually lands
// depends on lighting.js's shadow-camera coverage near the goal lines.
// ---------------------------------------------------------------------------

const HL = PITCH.length / 2; // 52.5 — goal lines at ±HL
const HW = PITCH.width / 2; // 34   — touchlines at ±HW
const FIELD_W = PITCH.length + PITCH.margin * 2; // 117
const FIELD_D = PITCH.width + PITCH.margin * 2; // 80
const STRIPE = 5.25; // mowing band width along X
const STRIPE_EDGE = 0.08; // roller edge width (m) — crisp, not a 1 m ramp
const BLADE_MID = 2.55; // metres per blade tile at mid range
const BLADE_NEAR = 1.13; // metres per blade tile in the near field
const BLADE_AX = 0.75; // blade tile aspect: finer across the mow axis…
const BLADE_AZ = 1.35; // …stretched along it
const NEAR_ROT = 0.3927; // 22.5° lattice rotation on the near layer
const WEAR_TILE = 6.5; // metres per divot/scar tile

const PAINT_TILE = 4.0; // metres of line covered by one paint texture tile
const PAINT_W = PITCH.lineWidth * 1.9; // strip incl. wet edge + ragged fringe
const PAINT_HW = PAINT_W / 2;

const POST_D = 0.068; // post half-depth (front bulge); rear face is flat
const NET_S = 0.052; // cord spacing in the un-rotated square frame
const NET_CELLS = 5; // cords per texture tile
const NET_TILE = NET_S * NET_CELLS; // world size of one net texture tile
const NET_R = 0.7071067811865476 / NET_TILE; // 45° UV rotation → diamond mesh

const WIND_YAW = -0.48; // constant stadium breeze, +X / +Z-ish
const TAU = Math.PI * 2;

/** mergeGeometries needs a consistent index-ness across the batch. */
const mergeAll = (list) => mergeGeometries(list.map((g) => (g.index ? g.toNonIndexed() : g)));

export function createPitch(ctx) {
  const { scene, quality } = ctx;
  const hi = quality !== 'low';
  // Private stream: draw ONE value from the shared rng, then run our own so
  // retuning the turf never reshuffles the crowd/players downstream.
  const rng = makeRng(((ctx.rng() * 4294967296) >>> 0) ^ 0x9e3779b9);
  const group = new THREE.Group();
  group.name = 'pitch';

  // =========================================================================
  // Grass — one surface, everything folded into its material
  // =========================================================================
  const bladeSize = hi ? 1024 : 256;
  const bladeTex = makeCanvasTexture(bladeSize, bladeSize, (c, w, h) => drawBladePack(c, w, h, rng), {
    colorSpace: THREE.NoColorSpace,
    anisotropy: 16,
  });

  const wearSize = hi ? 1024 : 512;
  const wearTex = makeCanvasTexture(wearSize, wearSize, (c, w, h) => drawWearSheet(c, w, h, rng), {
    anisotropy: 8,
  });

  const texW = hi ? 2048 : 1024;
  const texH = Math.round((texW * FIELD_D) / FIELD_W / 2) * 2;
  const grassTex = makeCanvasTexture(texW, texH, (g, W, H) => drawGrassAlbedo(g, W, H, rng, hi), {
    anisotropy: 16,
    wrap: THREE.ClampToEdgeWrapping,
  });

  const rw = hi ? 1024 : 512;
  const rh = Math.round((rw * FIELD_D) / FIELD_W / 2) * 2;
  const roughTex = makeCanvasTexture(rw, rh, (g, W, H) => drawGrassRoughness(g, W, H, rng), {
    colorSpace: THREE.NoColorSpace,
    anisotropy: 8,
    wrap: THREE.ClampToEdgeWrapping,
  });

  const grassGeo = new THREE.PlaneGeometry(FIELD_W, FIELD_D, 1, 1);
  grassGeo.rotateX(-Math.PI / 2);
  const grassMat = new THREE.MeshStandardMaterial({
    map: grassTex,
    roughnessMap: roughTex,
    roughness: 1.0,
    metalness: 0,
  });
  grassMat.name = 'grassMat';
  grassMat.onBeforeCompile = (shader) => {
    shader.uniforms.uBlade = { value: bladeTex };
    shader.uniforms.uWear = { value: wearTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GRASS_DECL}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${GRASS_SURFACE}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${GRASS_ROUGH}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${GRASS_NORMAL}`);
  };
  // Keep the shader variant distinct from any other MeshStandardMaterial.
  grassMat.customProgramCacheKey = () => 'fifacher-turf-v3';

  const grass = new THREE.Mesh(grassGeo, grassMat);
  grass.name = 'grass';
  grass.receiveShadow = true;
  group.add(grass);

  // Dark surround beyond the grass so there is never a void to the stands.
  // Sits at y=-0.04: any stadium concourse floor at y>=0 wins cleanly.
  const surShape = new THREE.Shape();
  surShape.moveTo(-88, -70);
  surShape.lineTo(88, -70);
  surShape.lineTo(88, 70);
  surShape.lineTo(-88, 70);
  surShape.closePath();
  const surHole = new THREE.Path();
  surHole.moveTo(-FIELD_W / 2, -FIELD_D / 2);
  surHole.lineTo(FIELD_W / 2, -FIELD_D / 2);
  surHole.lineTo(FIELD_W / 2, FIELD_D / 2);
  surHole.lineTo(-FIELD_W / 2, FIELD_D / 2);
  surHole.closePath();
  surShape.holes.push(surHole);
  const surGeo = new THREE.ShapeGeometry(surShape, 1);
  surGeo.rotateX(-Math.PI / 2);
  const surround = new THREE.Mesh(
    surGeo,
    new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.96, metalness: 0 })
  );
  surround.name = 'surround';
  surround.position.y = -0.04;
  surround.receiveShadow = true;
  group.add(surround);

  // =========================================================================
  // Markings — painted strips with across-the-line UVs
  // =========================================================================
  const lw = PITCH.lineWidth;
  const parts = [];

  /** Straight painted strip A→B. u runs along the line, v across it. */
  const strip = (x0, z0, x1, z1) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const ux = dx / len;
    const uz = dz / len;
    const px = -uz * PAINT_HW;
    const pz = ux * PAINT_HW;
    const u0 = rng() * 7;
    const u1 = u0 + len / PAINT_TILE;
    const pos = new Float32Array([
      x0 - px, 0, z0 - pz,
      x0 + px, 0, z0 + pz,
      x1 - px, 0, z1 - pz,
      x1 + px, 0, z1 + pz,
    ]);
    const uv = new Float32Array([u0, 0, u0, 1, u1, 0, u1, 1]);
    parts.push(flatGeo(pos, uv, [0, 1, 2, 1, 3, 2]));
  };

  /** Painted arc. phi measured from +X toward +Z. k=0 outer, k=1 inner. */
  const arc = (cx, cz, r, phi0, phiLen, segs) => {
    const n = (segs + 1) * 2;
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const idx = [];
    const u0 = rng() * 7;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const phi = phi0 + phiLen * t;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const uu = u0 + (r * phiLen * t) / PAINT_TILE;
      for (let k = 0; k < 2; k++) {
        const rr = r + (k === 0 ? PAINT_HW : -PAINT_HW);
        const o = i * 2 + k;
        pos[o * 3] = cx + c * rr;
        pos[o * 3 + 2] = cz + s * rr;
        uv[o * 2] = uu;
        uv[o * 2 + 1] = k;
      }
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    parts.push(flatGeo(pos, uv, idx));
  };

  /** Solid paint disc (spots). Samples the paint body, no fringe needed. */
  const spot = (cx, cz, r) => {
    const segs = 28;
    const pos = new Float32Array((segs + 1) * 3);
    const uv = new Float32Array((segs + 1) * 2);
    const idx = [];
    pos[0] = cx;
    pos[2] = cz;
    uv[0] = rng() * 7;
    uv[1] = 0.5;
    for (let i = 0; i < segs; i++) {
      const phi = (i / segs) * TAU;
      const o = i + 1;
      pos[o * 3] = cx + Math.cos(phi) * r;
      pos[o * 3 + 2] = cz + Math.sin(phi) * r;
      uv[o * 2] = uv[0] + (phi * r) / PAINT_TILE;
      uv[o * 2 + 1] = 0.5;
      idx.push(0, ((i + 1) % segs) + 1, i + 1);
    }
    parts.push(flatGeo(pos, uv, idx));
  };

  strip(-HL, -(HW - lw / 2), HL, -(HW - lw / 2)); // touchlines
  strip(-HL, HW - lw / 2, HL, HW - lw / 2);
  strip(-(HL - lw / 2), -HW, -(HL - lw / 2), HW); // goal lines
  strip(HL - lw / 2, -HW, HL - lw / 2, HW);
  strip(0, -HW, 0, HW); // halfway line
  for (const s of [-1, 1]) {
    const paX = s * (HL - PITCH.penAreaDepth); // ±36
    const paZ = PITCH.penAreaWidth / 2; // 20.16
    strip(paX, -paZ, paX, paZ);
    strip(s * HL, -paZ, paX, -paZ);
    strip(s * HL, paZ, paX, paZ);
    const sbX = s * (HL - PITCH.sixBoxDepth); // ±47
    const sbZ = PITCH.sixBoxWidth / 2; // 9.16
    strip(sbX, -sbZ, sbX, sbZ);
    strip(s * HL, -sbZ, sbX, -sbZ);
    strip(s * HL, sbZ, sbX, sbZ);
    spot(s * (HL - PITCH.penSpotDist), 0, 0.14);
    // penalty arc — the part of the 9.15 circle outside the penalty area
    const alpha = Math.acos((PITCH.penAreaDepth - PITCH.penSpotDist) / PITCH.penArcR);
    const facing = s > 0 ? Math.PI : 0; // bulges toward pitch center
    arc(s * (HL - PITCH.penSpotDist), 0, PITCH.penArcR, facing - alpha, alpha * 2, 48);
  }
  arc(0, 0, PITCH.centerCircleR, 0, TAU, 160); // center circle
  spot(0, 0, 0.15); // center spot
  arc(-HL, -HW, PITCH.cornerArcR, 0, Math.PI / 2, 12); // corner arcs
  arc(-HL, HW, PITCH.cornerArcR, -Math.PI / 2, Math.PI / 2, 12);
  arc(HL, -HW, PITCH.cornerArcR, Math.PI / 2, Math.PI / 2, 12);
  arc(HL, HW, PITCH.cornerArcR, Math.PI, Math.PI / 2, 12);

  const paintTex = makeCanvasTexture(1024, 64, (c, w, h) => drawPaint(c, w, h, rng), {
    anisotropy: 16,
  });
  paintTex.wrapS = THREE.RepeatWrapping;
  paintTex.wrapT = THREE.ClampToEdgeWrapping;

  const lineMat = new THREE.MeshStandardMaterial({
    map: paintTex,
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  const lines = new THREE.Mesh(mergeAll(parts), lineMat);
  lines.name = 'markings';
  lines.position.y = 0.011;
  lines.renderOrder = 2;
  lines.receiveShadow = true;
  group.add(lines);

  // =========================================================================
  // Goals — elliptical flat-backed frame, taped/clipped diamond net
  // =========================================================================
  // Real aluminium goal frame, not a light source. Mid-value paint + a real
  // roughness so the elliptical section actually rolls off into a terminator
  // instead of clipping to blown white across its whole width.
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xb9c1c9,
    roughness: 0.55,
    metalness: 0.12,
  });
  const netTexSize = hi ? 1024 : 512;
  const netTex = makeCanvasTexture(netTexSize, netTexSize, drawNetGrid, { anisotropy: 16 });
  const netMat = new THREE.MeshStandardMaterial({
    map: netTex,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: 0xdfe5ee,
    roughness: 0.62,
    metalness: 0,
    emissive: 0x9fb0c6,
    emissiveIntensity: 0.05,
  });
  // Shadow pass gets a hard-cut, DELIBERATELY COARSER lattice. The floodlight
  // shadow maps run ~6 cm/texel across the pitch, so a 3 mm cord at 12 cm
  // pitch cannot survive rasterisation — it would blur to a flat grey smudge.
  // A 30 cm lattice with fat cords resolves cleanly and reads as exactly what
  // it is: net shadow raking across the goalmouth. Nobody counts the cells.
  const netShadowTex = makeCanvasTexture(256, 256, drawNetShadowGrid, {
    colorSpace: THREE.NoColorSpace,
    anisotropy: 4,
  });
  const netDepthMat = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: netShadowTex,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });

  const zn = GOAL.width / 2 + GOAL.postR; // post centers: 7.32 between faces
  const gh = GOAL.height; // 2.44 to crossbar underside
  const barY = gh + GOAL.postR; // 2.50 crossbar center
  const topRailD = 0.85; // net frame depth at the top
  const D = (t) => GOAL.depth - (GOAL.depth - topRailD) * Math.pow(Math.max(t, 0), 1.8);
  const dip = (u) => 0.085 * Math.sin(Math.PI * u); // top cord catenary between fixings

  const buildGoal = (sign) => {
    const gx = sign * HL;
    const white = [];

    // --- posts: elliptical section, flat rear face -------------------------
    for (const zs of [-1, 1]) {
      const post = postExtrude(POST_D, GOAL.postR, barY + GOAL.postR);
      if (sign > 0) post.rotateY(Math.PI);
      post.translate(gx, 0, zs * zn);
      white.push(post);
      // net clips up the inside face of the post
      for (let y = 0.25; y < gh - 0.05; y += 0.42) {
        const clip = new THREE.TorusGeometry(GOAL.postR + 0.016, 0.011, 6, 14);
        clip.rotateX(Math.PI / 2);
        clip.translate(gx, y, zs * zn);
        white.push(clip);
      }
      // stanchion: post top → sweep back and down along the net profile
      const pts = [
        new THREE.Vector3(gx, barY, zs * zn),
        new THREE.Vector3(sign * (HL + 0.4), barY - 0.04, zs * zn),
      ];
      for (const t of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
        pts.push(new THREE.Vector3(sign * (HL + D(t)), Math.max(gh * t, 0.02), zs * zn));
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.03, 10);
      white.push(tube);
    }

    // --- crossbar: same section, flat face to the rear ---------------------
    const bar = postExtrude(POST_D, GOAL.postR, zn * 2);
    bar.rotateX(Math.PI / 2); // lay the extrusion axis along +Z, flat face rear
    bar.translate(0, 0, -zn);
    if (sign > 0) bar.rotateY(Math.PI);
    bar.translate(gx, barY, 0);
    white.push(bar);
    // taped seam + clips along the crossbar where the top course terminates
    for (let z = -zn + 0.22; z <= zn - 0.2; z += 0.44) {
      const clip = new THREE.TorusGeometry(GOAL.postR + 0.018, 0.011, 6, 14);
      clip.translate(gx, barY, z);
      white.push(clip);
    }

    // --- top back rail: the net's top course dies on this, not in mid air --
    const railPts = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12;
      railPts.push(new THREE.Vector3(sign * (HL + topRailD), gh - dip(u), lerp(-zn, zn, u)));
    }
    white.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts), 26, 0.021, 8));

    // --- back ground bar + pegs -------------------------------------------
    const backBar = new THREE.CylinderGeometry(0.022, 0.022, zn * 2, 10);
    backBar.rotateX(Math.PI / 2);
    backBar.translate(sign * (HL + GOAL.depth), 0.028, 0);
    white.push(backBar);
    const peg = (x, z) => {
      const p = new THREE.CylinderGeometry(0.014, 0.008, 0.16, 8);
      p.translate(x, 0.045, z);
      white.push(p);
      const hook = new THREE.TorusGeometry(0.03, 0.008, 5, 10);
      hook.rotateY(Math.PI / 2);
      hook.translate(x, 0.115, z);
      white.push(hook);
    };
    for (let i = 0; i <= 6; i++) peg(sign * (HL + GOAL.depth), lerp(-zn + 0.15, zn - 0.15, i / 6));
    for (const zs of [-1, 1]) {
      peg(sign * (HL + GOAL.depth * 0.62), zs * zn);
      peg(sign * (HL + GOAL.depth * 0.3), zs * zn);
    }

    const frame = new THREE.Mesh(mergeAll(white), frameMat);
    frame.name = `goalFrame${sign > 0 ? 'E' : 'W'}`;
    frame.castShadow = true;
    frame.receiveShadow = true;
    group.add(frame);

    // --- net panels: taut diamond, gentle sag only between fixings ---------
    const panels = [];
    // back panel — a small ball pocket low down, nothing floppy up top
    panels.push(
      netPanel(30, 16, (u, v, p) => {
        const belly = 0.17 * Math.sin(Math.PI * u) * Math.pow(Math.max(Math.sin(Math.PI * v), 0), 1.5);
        const d = Math.max(D(v) - belly, 0.06);
        p.set(sign * (HL + d), v * (gh - dip(u)), lerp(-zn, zn, u));
      }, zn * 2, 2.7)
    );
    for (const zs of [-1, 1]) {
      panels.push(
        netPanel(14, 12, (u, v, p) => {
          const zoff = 0.05 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
          p.set(sign * (HL + u * D(v)), v * gh, zs * (zn - zoff));
        }, GOAL.depth, gh)
      );
    }
    panels.push(
      netPanel(30, 8, (u, v, p) => {
        const sag = 0.03 * Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
        p.set(sign * (HL + v * topRailD), gh - dip(u) * v - sag, lerp(-zn, zn, u));
      }, zn * 2, topRailD)
    );
    const net = new THREE.Mesh(mergeAll(panels), netMat);
    net.name = `goalNet${sign > 0 ? 'E' : 'W'}`;
    net.renderOrder = 4;
    net.castShadow = true;
    net.customDepthMaterial = netDepthMat;
    group.add(net);
  };
  buildGoal(-1);
  buildGoal(1);

  // =========================================================================
  // Corner flags
  // =========================================================================
  const clothMat = new THREE.MeshStandardMaterial({
    color: 0xf5c400,
    emissive: 0xf5c400,
    emissiveIntensity: 0.06,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const poleMat = new THREE.MeshStandardMaterial({
    color: 0x2c2e33,
    roughness: 0.5,
    metalness: 0.4,
  });
  const clothBase = new THREE.PlaneGeometry(0.52, 0.34, 10, 5);
  clothBase.translate(0.28, 0, 0); // fixed edge near the pole, free end at +X
  const flags = [];
  const poleParts = [];
  for (const cx of [-HL, HL]) {
    for (const cz of [-HW, HW]) {
      const holder = new THREE.Group();
      holder.position.set(cx, 0, cz);
      holder.rotation.y = WIND_YAW;
      const geo = clothBase.clone();
      const cloth = new THREE.Mesh(geo, clothMat);
      cloth.position.y = 1.31;
      holder.add(cloth);
      group.add(holder);
      flags.push({ geo, base: geo.attributes.position.array.slice(), phase: rng() * TAU });
      const pole = new THREE.CylinderGeometry(0.017, 0.022, 1.5, 10);
      pole.translate(cx, 0.75, cz);
      poleParts.push(pole);
      const knob = new THREE.SphereGeometry(0.032, 10, 8);
      knob.translate(cx, 1.5, cz);
      poleParts.push(knob);
    }
  }
  const poles = new THREE.Mesh(mergeAll(poleParts), poleMat);
  poles.name = 'cornerPoles';
  poles.castShadow = true;
  group.add(poles);

  scene.add(group);

  // =========================================================================
  // update — flag flutter (time accumulates from dt; deterministic)
  // =========================================================================
  let time = 0;
  return {
    group,
    update(dt, matchState) { // eslint-disable-line no-unused-vars
      time += dt;
      for (const f of flags) {
        const pos = f.geo.attributes.position;
        const b = f.base;
        for (let i = 0; i < pos.count; i++) {
          const x = b[i * 3];
          const y = b[i * 3 + 1];
          const s = clamp((x - 0.02) / 0.52, 0, 1);
          const w1 = Math.sin(x * 7.5 - time * 7.0 + f.phase);
          const w2 = Math.sin(x * 15 - time * 11.3 + f.phase * 1.7);
          const droop = 0.085 * s * s * (0.85 + 0.15 * Math.sin(time * 0.9 + f.phase));
          pos.setXYZ(i, x, y - droop, (w1 * 0.075 + w2 * 0.02) * Math.pow(s, 1.2));
        }
        pos.needsUpdate = true;
        f.geo.computeVertexNormals();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Turf shader injections
// ---------------------------------------------------------------------------

const GRASS_DECL = /* glsl */ `
uniform sampler2D uBlade;
uniform sampler2D uWear;
varying vec3 vWPos;
float gSq;      // mow band, -1 / +1 with a crisp roller edge
float gLay;     // signed "blades pointing away from lens" term
float gWear;    // wear coverage at this pixel
float gNearW;   // near-field blade blend
vec4  gMid;     // blade pack, mid tile
vec4  gNear;    // blade pack, near tile
`;

const GRASS_SURFACE = /* glsl */ `
{
  vec2 wp = vWPos.xz;

  // ---- mowing bands ------------------------------------------------------
  // The roller wanders: stripe edges are never mathematically parallel.
  float wander = 0.30 * sin(wp.y * 0.038) + 0.15 * sin(wp.y * 0.117 + 1.9)
               + 0.06 * sin(wp.y * 0.34 + 0.7);
  float scH = (wp.x + 52.5 + wander) / ${(STRIPE * 2).toFixed(3)};
  float hp = fract(scH);
  float eh = clamp(max(${(STRIPE_EDGE / (STRIPE * 2)).toFixed(6)}, fwidth(scH) * 0.6), 0.0, 0.24);
  gSq = -1.0 + 2.0 * smoothstep(0.0, eh, hp) - 2.0 * smoothstep(0.5, 0.5 + eh, hp);

  // ---- retroreflection: THE stripe ---------------------------------------
  // Blades in a band lean ±Z. Looking the way they lean you see bright tips
  // (lighter); looking into them you see shaded stems (darker). Peaks when the
  // camera looks down the stripe axis, inverts as it swings across.
  vec2 vdxz = wp - cameraPosition.xz;
  float vlen = max(length(vdxz), 1e-4);
  gLay = clamp((vdxz.y / vlen) * gSq, -1.0, 1.0);

  diffuseColor.rgb *= 1.0 + gSq * 0.016 + gLay * 0.070;
  diffuseColor.rgb *= mix(vec3(1.008, 1.0, 0.986), vec3(0.993, 1.0, 1.011), gSq * 0.5 + 0.5);

  // ---- blade relief / albedo streaks -------------------------------------
  // The blade tile is sampled with a STRETCHED uv (1.8:1 along Z) so every
  // tuft is elongated in the mow direction. That anisotropy is what gives the
  // turf a lay instead of the isotropic stucco a square tile produces.
  //
  // ANTI-TILING. The pack carries NOTHING above ~1/13 of a tile (see
  // drawBladePack) so there is no blob big enough to recognise, and the two
  // layers are deliberately incommensurate: 2.55 m axis-aligned + 1.13 m
  // turned 22.5°. Two lattices at an irrational ratio AND a non-right angle
  // cannot beat into a readable grid — there is no common period to find.
  // Everything at field scale (moisture, wear, dry patches) comes from the
  // 2048 px non-repeating map instead, where repetition is impossible.
  gMid = texture2D(uBlade, wp * vec2(${(1 / (BLADE_MID * BLADE_AX)).toFixed(6)}, ${(
  1 / (BLADE_MID * BLADE_AZ)
).toFixed(6)}));
  diffuseColor.rgb *= 1.0 + (gMid.b - 0.5) * 0.30;

  float dist = length(vViewPosition);
  // Runs to 50 m: the broadcast master's "near 20 m of pitch" sits ~27–36 m
  // from a camera at z=-46/y=24, and that foreground is exactly where the turf
  // has to stop being velvet. A 1.13 m tile still covers 12+ px out there.
  gNearW = 1.0 - smoothstep(5.0, 50.0, dist);
  gNear = vec4(0.5, 0.5, 0.5, 1.0);
  if (gNearW > 0.002) {
    vec2 ns = wp * vec2(${(1 / (BLADE_NEAR * BLADE_AX)).toFixed(6)}, ${(
  1 / (BLADE_NEAR * BLADE_AZ)
).toFixed(6)});
    // stretch first, THEN rotate: the tufts still lie along the mow axis, but
    // the tile lattice is skewed off world axes.
    gNear = texture2D(uBlade, vec2(
      ns.x * ${Math.cos(NEAR_ROT).toFixed(6)} - ns.y * ${Math.sin(NEAR_ROT).toFixed(6)},
      ns.x * ${Math.sin(NEAR_ROT).toFixed(6)} + ns.y * ${Math.cos(NEAR_ROT).toFixed(6)}));
    diffuseColor.rgb *= 1.0 + (gNear.b - 0.5) * 0.62 * gNearW;
  }

  // ---- wear: goalmouths, centre circle, penalty spots, scatter -----------
  float m = 1.0 - smoothstep(0.2, 1.0, length(vec2((abs(wp.x) - 50.6) / 3.5, wp.y / 5.6)));
  m = max(m, (1.0 - smoothstep(0.5, 1.05, length(wp) / 9.15)) * 0.5);
  m = max(m, (1.0 - smoothstep(0.25, 1.0, length(vec2(abs(wp.x) - 41.5, wp.y)) / 1.7)) * 0.75);
  m = max(m, 0.24);
  vec4 wr = texture2D(uWear, wp * ${(1 / WEAR_TILE).toFixed(6)});
  gWear = wr.a * m;
  diffuseColor.rgb = mix(diffuseColor.rgb, wr.rgb, gWear);
}
`;

const GRASS_ROUGH = /* glsl */ `
// Toward-lens bands go glossier (you are looking into a wall of leaf faces),
// away-bands go matte. This is the sheen inversion the stripe actually is.
roughnessFactor += gLay * 0.062 - gSq * 0.020 + gWear * 0.14;
roughnessFactor -= (gNear.b - 0.5) * gNearW * 0.16;
roughnessFactor = clamp(roughnessFactor, 0.14, 1.0);
`;

const GRASS_NORMAL = /* glsl */ `
{
  vec3 wx = normalize((viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
  vec3 wz = normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  // the near layer's tangent xy come out of a lattice turned 22.5°, so turn
  // them back before they are added to the world-aligned mid layer.
  vec2 nn = (gNear.rg - 0.5);
  nn = vec2(nn.x * ${Math.cos(NEAR_ROT).toFixed(6)} + nn.y * ${Math.sin(NEAR_ROT).toFixed(6)},
            -nn.x * ${Math.sin(NEAR_ROT).toFixed(6)} + nn.y * ${Math.cos(NEAR_ROT).toFixed(6)});
  vec2 nrm = (gMid.rg - 0.5) * 1.05 + nn * (2.4 * gNearW);
  nrm.y += gSq * 0.135; // anisotropic lay along the mow axis
  normal = normalize(normal + wx * nrm.x + wz * nrm.y);
}
`;

// ---------------------------------------------------------------------------
// Field-scale albedo
// ---------------------------------------------------------------------------

/** World → texel mappers for a canvas covering the whole grass plane. */
function fieldMap(W, H) {
  const sx = W / FIELD_W;
  const sy = H / FIELD_D;
  return {
    sx,
    sy,
    px: (x) => (x + FIELD_W / 2) * sx,
    pz: (z) => (z + FIELD_D / 2) * sy,
  };
}

function drawGrassAlbedo(g, W, H, rng, hi) {
  const { sx, sy, px, pz } = fieldMap(W, H);

  // Flat base. NO stripes here — the mow bands are a shading phenomenon and
  // live in the material, where they can be 8 cm crisp and view-dependent.
  // Deeper and a shade less saturated than a "video game green": under a warm
  // 5600K rig ACES pushes a bright saturated turf straight into astroturf.
  g.fillStyle = 'hsl(115, 37%, 18.5%)';
  g.fillRect(0, 0, W, H);

  // --- apron: deeper tone + perpendicular cross-mow behind the goals --------
  g.fillStyle = 'rgba(6, 22, 12, 0.20)';
  g.fillRect(0, 0, px(-HL), H);
  g.fillRect(px(HL), 0, W - px(HL), H);
  g.fillRect(px(-HL), 0, px(HL) - px(-HL), pz(-HW));
  g.fillRect(px(-HL), pz(HW), px(HL) - px(-HL), H - pz(HW));
  for (let z = -FIELD_D / 2; z < FIELD_D / 2; z += 3) {
    const light = Math.round((z + FIELD_D / 2) / 3) % 2 === 0;
    g.fillStyle = light ? 'rgba(228, 250, 214, 0.045)' : 'rgba(0, 12, 0, 0.05)';
    const h3 = pz(z + 3) - pz(z);
    g.fillRect(0, pz(z), px(-HL), h3);
    g.fillRect(px(HL), pz(z), W - px(HL), h3);
  }

  // --- low-frequency tonality: moisture, shade, dry patches ----------------
  const blob = (x, z, r, color) => {
    const rp = r * sx;
    const grd = g.createRadialGradient(px(x), pz(z), 0, px(x), pz(z), rp);
    grd.addColorStop(0, color);
    grd.addColorStop(0.6, color.replace(/([\d.]+)\)$/, (m, a) => `${parseFloat(a) * 0.45})`));
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(px(x) - rp, pz(z) - rp, rp * 2, rp * 2);
  };
  const macro = [
    [-33, -15, 34, 'rgba(16, 54, 44, 0.20)'],
    [26, 17, 38, 'rgba(14, 50, 40, 0.17)'],
    [-4, 27, 30, 'rgba(158, 172, 96, 0.11)'],
    [44, -21, 30, 'rgba(150, 168, 92, 0.09)'],
    [-49, 8, 26, 'rgba(12, 48, 38, 0.15)'],
    [12, -30, 26, 'rgba(148, 166, 92, 0.08)'],
    [52, 12, 24, 'rgba(14, 50, 40, 0.13)'],
    [-18, 2, 22, 'rgba(160, 174, 98, 0.07)'],
  ];
  for (const [x, z, r, c] of macro) blob(x, z, r, c);
  for (let i = 0; i < 16; i++) {
    const x = (rng() * 2 - 1) * 56;
    const z = (rng() * 2 - 1) * 38;
    const warm = rng() < 0.5;
    blob(x, z, 13 + rng() * 17, warm ? 'rgba(166,184,100,0.07)' : 'rgba(14,52,40,0.09)');
  }
  const nBlob = hi ? 110 : 50;
  for (let i = 0; i < nBlob; i++) {
    const x = (rng() * 2 - 1) * 58;
    const z = (rng() * 2 - 1) * 39.5;
    const warm = rng() < 0.5;
    const a = (0.035 + rng() * 0.055).toFixed(3);
    blob(x, z, 2.2 + rng() * 6, warm ? `rgba(172,190,104,${a})` : `rgba(16,54,36,${a})`);
  }

  // --- wear: goalmouths, kickoff, penalty spots, flank channels ------------
  const wear = (x, z, rx, rz, alpha, col) => {
    g.save();
    g.translate(px(x), pz(z));
    g.scale(rx * sx, rz * sy);
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    grd.addColorStop(0, `rgba(${col},${alpha})`);
    grd.addColorStop(0.55, `rgba(${col},${(alpha * 0.55).toFixed(3)})`);
    grd.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = grd;
    g.fillRect(-1, -1, 2, 2);
    g.restore();
  };
  const SOIL = '138,116,78';
  wear(-51.3, 0, 3.6, 5.8, 0.26, SOIL);
  wear(51.3, 0, 3.6, 5.8, 0.26, SOIL);
  wear(0, 0, 3.0, 3.0, 0.13, SOIL);
  wear(0, 0, 1.0, 1.0, 0.14, SOIL);
  wear(-(HL - PITCH.penSpotDist), 0, 1.1, 1.1, 0.2, SOIL);
  wear(HL - PITCH.penSpotDist, 0, 1.1, 1.1, 0.2, SOIL);
  wear(-20, -26, 26, 4.5, 0.055, SOIL);
  wear(20, 26, 26, 4.5, 0.055, SOIL);
  // contact darkening at the goal frame feet and along the net's ground line
  for (const s of [-1, 1]) {
    for (const zs of [-1, 1]) wear(s * HL, zs * (GOAL.width / 2 + GOAL.postR), 0.45, 0.45, 0.5, '5,12,8');
    wear(s * (HL + GOAL.depth * 0.9), 0, 0.7, GOAL.width / 2 + 0.2, 0.3, '5,12,8');
  }
  // stippled scuffs inside the goalmouths
  for (const sgn of [-1, 1]) {
    const nDab = hi ? 80 : 34;
    for (let i = 0; i < nDab; i++) {
      const x = sgn * (52.4 - rng() * 5.5);
      const z = (rng() * 2 - 1) * 5.5;
      g.fillStyle = `rgba(${118 + ((rng() * 40) | 0)},${98 + ((rng() * 34) | 0)},58,${(
        0.05 +
        rng() * 0.09
      ).toFixed(3)})`;
      g.beginPath();
      g.ellipse(px(x), pz(z), 2 + rng() * 6, 1.5 + rng() * 4, rng() * Math.PI, 0, Math.PI * 2);
      g.fill();
    }
  }

  // --- mid-frequency mow texture: long soft streaks ALONG the mow direction.
  // Deliberately LOW frequency: anything near the texel limit here turns into
  // a shimmering canvas weave at grazing incidence, and the fine grain is the
  // blade tile's job — it has proper mips and 16x aniso to fall back on.
  g.globalCompositeOperation = 'overlay';
  const nStreak = hi ? 1100 : 450;
  for (let i = 0; i < nStreak; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const len = (26 + rng() * 90) * (H / 1400);
    const up = rng() < 0.5;
    const v = up ? 178 : 74;
    g.strokeStyle = `rgba(${v},${v},${v},${(0.03 + rng() * 0.05).toFixed(3)})`;
    g.lineWidth = 3 + rng() * 6;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rng() * 2 - 1) * 5, y + len);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';

  // --- gentle darkening toward the apron edges (grounds the field) ---------
  const edge = 3.2;
  const dark = 'rgba(4, 11, 7, 0.24)';
  const clear = 'rgba(4, 11, 7, 0)';
  const fade = (x0, y0, x1, y1, rx, ry, rw, rh) => {
    const grd = g.createLinearGradient(x0, y0, x1, y1);
    grd.addColorStop(0, dark);
    grd.addColorStop(1, clear);
    g.fillStyle = grd;
    g.fillRect(rx, ry, rw, rh);
  };
  fade(0, 0, edge * sx, 0, 0, 0, edge * sx, H);
  fade(W, 0, W - edge * sx, 0, W - edge * sx, 0, edge * sx, H);
  fade(0, 0, 0, edge * sy, 0, 0, W, edge * sy);
  fade(0, H, 0, H - edge * sy, 0, H - edge * sy, W, edge * sy);
}

/**
 * Field-scale roughness BASE. 255 = fully rough. The stripe sheen is applied
 * in the shader (it has to be view dependent); this map only carries damp/dry
 * variation and the matte response of worn ground.
 */
function drawGrassRoughness(g, W, H, rng) {
  const { sx, px, pz } = fieldMap(W, H);
  g.fillStyle = 'rgb(206,206,206)'; // ~0.81
  g.fillRect(0, 0, W, H);
  // apron is mown across the other way and walked on — flatter response
  g.fillStyle = 'rgba(230,230,230,0.75)';
  g.fillRect(0, 0, px(-HL), H);
  g.fillRect(px(HL), 0, W - px(HL), H);
  g.fillRect(px(-HL), 0, px(HL) - px(-HL), pz(-HW));
  g.fillRect(px(-HL), pz(HW), px(HL) - px(-HL), H - pz(HW));

  // Broad damp/dry variation: the damp lanes are where the mast beams cross
  // and throw a wet sheen band across the grass.
  for (let i = 0; i < 60; i++) {
    const x = (rng() * 2 - 1) * 58;
    const z = (rng() * 2 - 1) * 39;
    const r = (4 + rng() * 20) * sx;
    const v = rng() < 0.5 ? 238 : 168;
    const grd = g.createRadialGradient(px(x), pz(z), 0, px(x), pz(z), r);
    grd.addColorStop(0, `rgba(${v},${v},${v},0.3)`);
    grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
    g.fillStyle = grd;
    g.fillRect(px(x) - r, pz(z) - r, r * 2, r * 2);
  }
  // worn ground is matte
  const matte = (x, z, rx, rz, a) => {
    g.save();
    g.translate(px(x), pz(z));
    g.scale(rx * sx, rz * (H / FIELD_D));
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    grd.addColorStop(0, `rgba(250,250,250,${a})`);
    grd.addColorStop(1, 'rgba(250,250,250,0)');
    g.fillStyle = grd;
    g.fillRect(-1, -1, 2, 2);
    g.restore();
  };
  matte(-51.3, 0, 3.8, 6.0, 0.85);
  matte(51.3, 0, 3.8, 6.0, 0.85);
  matte(0, 0, 3.2, 3.2, 0.55);
  matte(-(HL - PITCH.penSpotDist), 0, 1.3, 1.3, 0.7);
  matte(HL - PITCH.penSpotDist, 0, 1.3, 1.3, 0.7);
}

// ---------------------------------------------------------------------------
// Blade pack — rg = normal xy, b = albedo multiplier, a = loose cuttings
// ---------------------------------------------------------------------------

/** Seamless tileable value noise, `cells` lattice points across the tile. */
function tileNoise(size, cells, rng) {
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const out = new Float32Array(size * size);
  const s = cells / size;
  for (let y = 0; y < size; y++) {
    const fy = y * s;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const wy = ty * ty * (3 - 2 * ty);
    const r0 = (((y0 % cells) + cells) % cells) * cells;
    const r1 = ((((y0 + 1) % cells) + cells) % cells) * cells;
    for (let x = 0; x < size; x++) {
      const fx = x * s;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const wx = tx * tx * (3 - 2 * tx);
      const c0 = ((x0 % cells) + cells) % cells;
      const c1 = (((x0 + 1) % cells) + cells) % cells;
      const top = g[r0 + c0] + (g[r0 + c1] - g[r0 + c0]) * wx;
      const bot = g[r1 + c0] + (g[r1 + c1] - g[r1 + c0]) * wx;
      out[y * size + x] = top + (bot - top) * wy;
    }
  }
  return out;
}

function drawBladePack(c, w, h, rng) {
  const size = w;
  const hcv = document.createElement('canvas');
  hcv.width = hcv.height = size;
  const hc = hcv.getContext('2d');

  // wrapped draw so the tile is seamless
  const wrapped = (x, y, r, fn) => {
    for (let ox = -1; ox <= 1; ox++) {
      const X = x + ox * size;
      if (X + r < 0 || X - r > size) continue;
      for (let oy = -1; oy <= 1; oy++) {
        const Y = y + oy * size;
        if (Y + r < 0 || Y - r > size) continue;
        fn(X, Y);
      }
    }
  };

  // 1. CLUMP FIELD. Built from tileable value noise rather than a pile of
  //    overlapping radial gradients — 60 stacked gradients regress to the mean
  //    and the tufting washes out, which is exactly how turf ends up reading
  //    as stucco.
  //
  //    THE OCTAVES START AT 1/13 OF THE TILE, not 1/6. A blob that spans a
  //    sixth of the tile is a landmark: the eye finds it, finds it again one
  //    tile over, and the whole pitch snaps into a grid. Capping the lowest
  //    octave at 1/13 (≈ 9 cm on the near layer, 20 cm on the mid) leaves
  //    nothing recognisable enough to pair up. All the large-scale tonality
  //    lives in the 2048 px field map, which never repeats.
  {
    const n1 = tileNoise(size, 13, rng);
    const n2 = tileNoise(size, 27, rng);
    const n3 = tileNoise(size, 59, rng);
    const img = hc.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < size * size; i++) {
      const v = 0.47 + 0.22 * (n1[i] * 2 - 1) + 0.115 * (n2[i] * 2 - 1) + 0.05 * (n3[i] * 2 - 1);
      const b = clamp(v * 255, 0, 255);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;
    }
    hc.putImageData(img, 0, 0);
  }

  // 2. BLADES — varied length, near-vertical (canvas Y maps to the world mow
  //    axis), bright at the tip. These ride on the clump field.
  hc.lineCap = 'round';
  const blades = Math.round(size * 26);
  for (let i = 0; i < blades; i++) {
    const x = rng() * size;
    const y = rng() * size;
    // varied blade length: most short, a scatter of long stragglers
    const lr = rng();
    // fractions are of the TILE, and the tile is now 1.13 m near / 2.55 m mid,
    // so these are ~1.2–4.6 cm blades with a scatter of 5–10 cm stragglers.
    const len = size * (0.011 + (lr < 0.86 ? rng() * 0.03 : 0.036 + rng() * 0.045));
    const lean = (rng() * 2 - 1) * len * 0.42;
    const wdt = Math.max(0.7, (size / 420) * (0.5 + rng() * 1.5));
    const tip = rng() < 0.5 ? 168 + rng() * 84 : 78 - rng() * 56;
    const r = len + wdt;
    wrapped(x, y, r, (X, Y) => {
      const grd = hc.createLinearGradient(X, Y, X + lean, Y - len);
      grd.addColorStop(0, 'rgba(120,120,120,0)');
      grd.addColorStop(0.3, `rgba(${tip | 0},${tip | 0},${tip | 0},0.24)`);
      grd.addColorStop(1, `rgba(${tip | 0},${tip | 0},${tip | 0},0.72)`);
      hc.strokeStyle = grd;
      hc.lineWidth = wdt;
      hc.beginPath();
      hc.moveTo(X, Y);
      hc.lineTo(X + lean, Y - len);
      hc.stroke();
    });
  }

  // 3. micro grain so the normal still has bite between blades
  {
    const img = hc.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < size * size; i++) {
      const n = (rng() * 2 - 1) * 12;
      const v = clamp(d[i * 4] + n, 0, 255);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    }
    hc.putImageData(img, 0, 0);
  }

  // 4. Blurred copy of the height field. The ALBEDO channel comes from this,
  //    not from the sharp field: blade-scale albedo mips straight back to grey
  //    at 4 m, clump-scale albedo does not, and clump-scale is what has to
  //    carry the tufting once a blade is thinner than a pixel.
  const bcv = document.createElement('canvas');
  const bs = Math.max(8, size >> 4);
  bcv.width = bcv.height = bs;
  const bc = bcv.getContext('2d');
  bc.drawImage(hcv, 0, 0, bs, bs);
  const bfull = document.createElement('canvas');
  bfull.width = bfull.height = size;
  const bfc = bfull.getContext('2d');
  bfc.imageSmoothingEnabled = true;
  bfc.drawImage(bcv, 0, 0, size, size);
  const blur = bfc.getImageData(0, 0, size, size).data;

  // 5. Sobel the sharp field → tangent normal; pack the tuft albedo.
  const src = hc.getImageData(0, 0, size, size).data;
  const out = c.createImageData(w, h);
  const o = out.data;
  const at = (x, y) => src[((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4] / 255;
  const strength = 3.4;
  let bSum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br - tl - 2 * l - bl) * 0.25 * strength;
      const dy = (bl + 2 * b + br - tl - 2 * t - tr) * 0.25 * strength;
      const i = (y * size + x) * 4;
      // r → world +X, g → world +Z. Canvas +Y is world −Z, hence the sign.
      o[i] = clamp((-dx * 0.5 + 0.5) * 255, 0, 255);
      o[i + 1] = clamp((dy * 0.5 + 0.5) * 255, 0, 255);
      // albedo multiplier: proud tufts catch light, hollows go dark.
      const bv = 0.5 + (blur[i] / 255 - 0.47) * 1.35 + (src[i] / 255 - 0.47) * 0.35;
      o[i + 2] = clamp(bv * 255, 30, 250);
      bSum += o[i + 2];
      o[i + 3] = 255;
    }
  }
  // Normalise the albedo channel to mean 0.5 so blending the near layer in and
  // out can never shift the overall exposure of the turf — otherwise the
  // distance fade shows up as a hard tonal seam across the pitch.
  const shift = 127.5 - bSum / (size * size);
  if (Math.abs(shift) > 0.5) {
    for (let i = 0; i < size * size; i++) o[i * 4 + 2] = clamp(o[i * 4 + 2] + shift, 0, 255);
  }
  c.putImageData(out, 0, 0);
}

// ---------------------------------------------------------------------------
// Wear sheet — divot flaps with exposed soil, stud scars, scuffs
// ---------------------------------------------------------------------------

function drawWearSheet(g, W, H, rng) {
  g.clearRect(0, 0, W, H);
  const wrapped = (x, y, r, fn) => {
    for (let ox = -1; ox <= 1; ox++) {
      const X = x + ox * W;
      if (X + r < 0 || X - r > W) continue;
      for (let oy = -1; oy <= 1; oy++) {
        const Y = y + oy * H;
        if (Y + r < 0 || Y - r > H) continue;
        fn(X, Y);
      }
    }
  };
  const mPerPx = WEAR_TILE / W;

  // divots: a torn flap of turf with soil showing behind it
  const nDiv = 16;
  for (let i = 0; i < nDiv; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const rr = (0.07 + rng() * 0.12) / mPerPx; // 7–19 cm
    const ang = rng() * TAU;
    wrapped(x, y, rr * 2, (X, Y) => {
      g.save();
      g.translate(X, Y);
      g.rotate(ang);
      // exposed soil
      g.fillStyle = `rgba(${68 + ((rng() * 24) | 0)},${52 + ((rng() * 18) | 0)},38,${(
        0.46 +
        rng() * 0.24
      ).toFixed(2)})`;
      g.beginPath();
      g.ellipse(0, 0, rr, rr * 0.62, 0, 0, TAU);
      g.fill();
      // damp rim
      g.strokeStyle = 'rgba(38,28,18,0.5)';
      g.lineWidth = Math.max(1, rr * 0.09);
      g.stroke();
      // the flap itself, kicked forward and still green on top
      g.fillStyle = 'rgba(46,62,32,0.85)';
      g.beginPath();
      g.ellipse(rr * 0.85, rr * 0.1, rr * 0.62, rr * 0.42, 0.3, 0, TAU);
      g.fill();
      g.restore();
    });
  }

  // stud scars — paired cleat clusters, the signature of a turning boot
  const nStud = 34;
  for (let i = 0; i < nStud; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const ang = rng() * TAU;
    const sc = (0.13 + rng() * 0.09) / mPerPx; // boot length
    wrapped(x, y, sc, (X, Y) => {
      g.save();
      g.translate(X, Y);
      g.rotate(ang);
      const a = (0.2 + rng() * 0.3).toFixed(2);
      g.fillStyle = `rgba(104,88,52,${a})`;
      for (let k = 0; k < 7; k++) {
        const ky = (k / 6 - 0.5) * sc;
        const kx = (k < 4 ? -0.16 : 0.16) * sc + (rng() - 0.5) * sc * 0.1;
        g.beginPath();
        g.ellipse(kx, ky, sc * 0.075, sc * 0.05, 0, 0, TAU);
        g.fill();
      }
      g.restore();
    });
  }

  // long boot skids
  for (let i = 0; i < 14; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const ang = rng() * TAU;
    const len = (0.3 + rng() * 0.7) / mPerPx;
    wrapped(x, y, len, (X, Y) => {
      g.save();
      g.translate(X, Y);
      g.rotate(ang);
      const grd = g.createLinearGradient(0, 0, len, 0);
      grd.addColorStop(0, 'rgba(96,84,50,0)');
      grd.addColorStop(0.35, `rgba(108,94,56,${(0.2 + rng() * 0.22).toFixed(2)})`);
      grd.addColorStop(1, 'rgba(96,84,50,0)');
      g.fillStyle = grd;
      g.fillRect(0, -len * 0.035, len, len * 0.07);
      g.restore();
    });
  }

  // loose cuttings — pale clippings lying flat where the mower threw them.
  // They live on THIS sheet (6.5 m tile) rather than the blade tile: at a
  // 0.3–0.7 m tile a scatter this sparse reads as an obvious repeating stamp.
  g.lineCap = 'round';
  for (let i = 0; i < 90; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const a = rng() * TAU;
    const len = (0.025 + rng() * 0.05) / mPerPx;
    wrapped(x, y, len, (X, Y) => {
      g.strokeStyle = `rgba(${162 + ((rng() * 40) | 0)},${164 + ((rng() * 34) | 0)},${
        96 + ((rng() * 30) | 0)
      },${(0.5 + rng() * 0.5).toFixed(2)})`;
      g.lineWidth = Math.max(0.9, 0.004 / mPerPx);
      g.beginPath();
      g.moveTo(X, Y);
      g.quadraticCurveTo(
        X + Math.cos(a) * len * 0.5 + len * 0.14,
        Y + Math.sin(a) * len * 0.5,
        X + Math.cos(a) * len,
        Y + Math.sin(a) * len
      );
      g.stroke();
    });
  }

  // seed-line / thin-sward patches: pale, low alpha, large
  for (let i = 0; i < 10; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const rr = (0.5 + rng() * 1.1) / mPerPx;
    wrapped(x, y, rr, (X, Y) => {
      const grd = g.createRadialGradient(X, Y, 0, X, Y, rr);
      grd.addColorStop(0, `rgba(120,120,78,${(0.05 + rng() * 0.07).toFixed(2)})`);
      grd.addColorStop(1, 'rgba(120,120,78,0)');
      g.fillStyle = grd;
      g.fillRect(X - rr, Y - rr, rr * 2, rr * 2);
    });
  }
}

// ---------------------------------------------------------------------------
// Line paint — 12 cm of warm grey with a ragged edge and a wet line
// ---------------------------------------------------------------------------

function drawPaint(g, W, H, rng) {
  // Seamless per-column noise: integer harmonics wrap exactly at the tile.
  const mkNoise = (freqs) => {
    const terms = freqs.map((f) => [f, rng() * TAU, 1 / Math.pow(f, 0.62)]);
    const wsum = terms.reduce((s, t) => s + t[2], 0);
    return (u) => {
      let s = 0;
      for (const [f, p, a] of terms) s += a * Math.sin(u * TAU * f + p);
      return s / wsum;
    };
  };
  const ragTop = mkNoise([3, 7, 13, 29, 61, 127]);
  const ragBot = mkNoise([5, 11, 23, 47, 97, 151]);
  const body = mkNoise([2, 5, 9, 19]);

  const core = PITCH.lineWidth / PAINT_W / 2; // half-core in v units (0.263)
  const ampV = 0.016 / PAINT_W; // ±1.6 cm of blade bite
  const wetM = 0.036; // wet-edge reach in metres

  const img = g.createImageData(W, H);
  const d = img.data;
  for (let x = 0; x < W; x++) {
    const u = x / W;
    const et = 0.5 - core + ragTop(u) * ampV; // paint starts here
    const eb = 0.5 + core - ragBot(u) * ampV; // paint ends here
    const bv = body(u);
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      const i = (y * W + x) * 4;
      let R;
      let G;
      let B;
      let A;
      if (v > et && v < eb) {
        // paint body: warm grey, never flat white, with a little chalk mottle
        const speck = (rng() - 0.5) * 10;
        R = 214 + bv * 7 + speck;
        G = 210 + bv * 6 + speck;
        B = 197 + bv * 5 + speck;
        A = 255;
        // blades lying over the paint bite into the first centimetre
        const dIn = Math.min(v - et, eb - v) * PAINT_W;
        if (dIn < 0.016) {
          const bite = 1 - dIn / 0.016;
          if (rng() < bite * 0.5) {
            R -= 60 * bite;
            G -= 44 * bite;
            B -= 62 * bite;
            A = 255 - 90 * bite * rng();
          }
        }
      } else {
        // wet edge: paint bleeds into the turf and holds moisture there
        const dOut = (v < et ? et - v : v - eb) * PAINT_W;
        const k = clamp(1 - dOut / wetM, 0, 1);
        const soft = k * k;
        R = 52;
        G = 60;
        B = 42;
        A = 255 * soft * 0.6 * (0.75 + 0.5 * rng());
        // stray flecks of overspray just outside the line
        if (dOut < 0.02 && rng() < 0.05) {
          R = 210;
          G = 208;
          B = 198;
          A = 150 * soft;
        }
      }
      d[i] = clamp(R, 0, 255);
      d[i + 1] = clamp(G, 0, 255);
      d[i + 2] = clamp(B, 0, 255);
      d[i + 3] = clamp(A, 0, 255);
    }
  }
  g.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Flat (y-up) indexed geometry from a position/uv pair. */
function flatGeo(pos, uv, idx) {
  const g = new THREE.BufferGeometry();
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/**
 * Goal post / crossbar section: an ellipse with the rear third replaced by a
 * flat face. Local +X is the pitch-facing front, local +Y lateral, extruded
 * along +Z then stood up. The flat back gives the cylinder a real terminator
 * instead of a uniform blown-white sausage.
 */
function postExtrude(depthR, latR, height) {
  const s = new THREE.Shape();
  const a0 = -Math.PI * 0.62;
  const a1 = Math.PI * 0.62;
  const N = 26;
  s.moveTo(depthR * Math.cos(a0), latR * Math.sin(a0));
  for (let i = 1; i <= N; i++) {
    const a = lerp(a0, a1, i / N);
    s.lineTo(depthR * Math.cos(a), latR * Math.sin(a));
  }
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: height, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2); // extrusion axis +Z → +Y
  return g;
}

// ---------------------------------------------------------------------------
// Goal net
// ---------------------------------------------------------------------------

/**
 * Taut square cord lattice. The panels rotate their UVs 45°, so on the goal
 * this reads as an even ~7.4 cm diamond mesh with no wandering courses. Real
 * nets are fine twine, not macrame: 2.1 mm cord on a 5.2 cm square pitch.
 */
function drawNetGrid(c, w, h) {
  c.clearRect(0, 0, w, h);
  const cells = NET_CELLS;
  const step = w / cells;
  const lwPx = Math.max(1.0, (0.0021 / NET_TILE) * w); // 2.1 mm cord
  c.lineCap = 'butt';
  const pass = (width, style) => {
    c.strokeStyle = style;
    c.lineWidth = width;
    for (let i = 0; i < cells; i++) {
      const o = (i + 0.5) * step;
      c.beginPath();
      c.moveTo(o, 0);
      c.lineTo(o, h);
      c.stroke();
      c.beginPath();
      c.moveTo(0, o);
      c.lineTo(w, o);
      c.stroke();
    }
  };
  pass(lwPx * 1.8, 'rgba(126,140,158,0.26)'); // soft halo: survives mip-down
  pass(lwPx, 'rgba(236,242,250,0.94)');
  // knots
  c.fillStyle = 'rgba(246,250,255,0.94)';
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      c.beginPath();
      c.arc((i + 0.5) * step, (j + 0.5) * step, lwPx * 0.62, 0, TAU);
      c.fill();
    }
  }
}

/** Coarse fat-cord lattice for the shadow pass only (see netDepthMat). */
function drawNetShadowGrid(c, w, h) {
  c.clearRect(0, 0, w, h);
  const cells = 2; // 0.15 m square spacing → ~21 cm diamond
  const step = w / cells;
  const lwPx = (0.038 / NET_TILE) * w;
  c.strokeStyle = 'rgb(255,255,255)';
  c.lineWidth = lwPx;
  for (let i = 0; i < cells; i++) {
    const o = (i + 0.5) * step;
    c.beginPath();
    c.moveTo(o, 0);
    c.lineTo(o, h);
    c.stroke();
    c.beginPath();
    c.moveTo(0, o);
    c.lineTo(w, o);
    c.stroke();
  }
}

/**
 * Indexed parametric grid; fn(u,v,outVec3) in world space. UVs are the panel's
 * metric coordinates rotated 45° so the square texture reads as a diamond.
 */
function netPanel(cols, rows, fn, physW, physH) {
  const pts = new Float32Array((cols + 1) * (rows + 1) * 3);
  const uvs = new Float32Array((cols + 1) * (rows + 1) * 2);
  const idx = [];
  const p = new THREE.Vector3();
  let k = 0;
  let m = 0;
  for (let r = 0; r <= rows; r++) {
    const v = r / rows;
    for (let cIdx = 0; cIdx <= cols; cIdx++) {
      const u = cIdx / cols;
      fn(u, v, p);
      pts[k++] = p.x;
      pts[k++] = p.y;
      pts[k++] = p.z;
      const A = u * physW;
      const B = v * physH;
      uvs[m++] = (A + B) * NET_R;
      uvs[m++] = (B - A) * NET_R;
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const a = r * (cols + 1) + cIdx;
      const b = a + 1;
      const d2 = a + cols + 1;
      const e = d2 + 1;
      idx.push(a, d2, b, b, d2, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
