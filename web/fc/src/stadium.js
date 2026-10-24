import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STANDS, TIERS, TEAMS, VENUE, makeCanvasTexture } from './util.js';

// ---------------------------------------------------------------------------
// Stade Raoul Brulat, Draguignan — a tight two-tier bowl.
//
// Every terrace step is derived from STANDS/TIERS so that the seats produced by
// forEachSeat() land exactly on the treads. crowd.js anchors a fan's feet at
// (seat.y - FOOT_DROP), so a tread's top surface must be at that same height.
//
// Nothing here casts shadows: the floodlights sit above the roof line, and the
// shadow cameras are fitted tightly to the pitch. Letting roofs into those maps
// would drop a hard fake shadow across the grass.
//
// Lighting note: the spot rig aims at the pitch, so every surface that faces
// away from the grass (roof soffits, the back of the perimeter wall, the corner
// infills) receives almost no direct light. Those surfaces therefore carry a
// small emissive term — enough to read as concrete/steel in the dark rather
// than as a hole punched in the picture. The roof soffit additionally carries a
// baked vertex-colour AO/bounce gradient so the trusses sit IN the ceiling.
// ---------------------------------------------------------------------------

const FOOT_DROP = 0.05;      // crowd.js: fan feet sit this far below seat.y
const TREAD_GAP = 0.02;      // overlap so stepped boxes never show a seam

// Roof shell, per stand axis: distance from world center to the front/back edge.
const ROOF = {
  x: { front: 54, back: 80 },
  z: { front: 37, back: 63 },
  yFront: 31,
  yBack: 34,
  thickness: 0.55,
};

const BACK_WALL_DIST = { x: 78.5, z: 61.5 };
const AD_DIST = { x: 55.5, z: 37.5 };      // LED boards, ~3 m off the lines
// Perimeter parapet. The x value clears the behind-goal camera (x = ±56.8),
// which sits in the strip between the boards and the wall.
const WALL_DIST = { x: 57.15, z: 38.8 };

// Corner infill footprint (absolute values; signs applied per corner). Kept
// just OUTSIDE both stands so it never buries seats or stands proud of the
// stand fronts — that overhang is what used to read as a black cliff.
const CORNER = { x0: 59.6, x1: BACK_WALL_DIST.x, z0: 41.0, z1: BACK_WALL_DIST.z, h: 29 };
const CORNER_CHAMFER = 8.4;  // 45° screen face cut into the inner corner

const TOWERS = [
  [1, 1], [1, -1], [-1, 1], [-1, -1],
].map(([sx, sz]) => new THREE.Vector3(sx * 70, 44, sz * 54));

// Pit Wall financial ticker across the perimeter LED boards. Static figures for
// now — wire these to live Pit Wall data (squad-cost cagg, cash position) later.
const AD_BRANDS = [
  'PIT WALL', 'SQUAD COST 68% / 70%', 'CASH £14.2M', 'TRANSFER PAYABLES £8.4M',
  'AUTONOMOUS FINANCE', 'FFP HEADROOM £2.1M', 'EVIDENCE SPEND $0.42', 'HARBOURSIDE FC',
];
const AD_HUES = [75, 82, 68, 75, 88, 75, 160, 75]; // volt-green family, one teal accent

const AD_H = 0.9;            // board face height (m)
const AD_SEG = 8.6;          // nominal panel width (m)
const AD_TILT = 0.10;        // top leans toward the pitch, for the high cameras
const AD_DEPTH = 0.35;       // housing depth
const AD_CUT = 5.0;          // corner return: 45° mitre, this far in from each corner

export function createStadium(ctx) {
  const { scene, renderer, rng, quality } = ctx;
  const low = quality === 'low';
  const group = new THREE.Group();
  group.name = 'stadium';

  // -- materials ------------------------------------------------------------
  const concreteMap = makeConcreteTexture(rng, low ? 512 : 1024);
  concreteMap.repeat.set(24, 24);
  const wallMap = concreteMap.clone();
  wallMap.needsUpdate = true;
  wallMap.repeat.set(90, 1);

  const matConcrete = new THREE.MeshStandardMaterial({
    color: 0x6e7178, map: concreteMap, roughness: 0.94, metalness: 0.0,
  });
  const matRiser = new THREE.MeshStandardMaterial({
    color: 0x35383d, roughness: 0.92, metalness: 0.0,
  });
  const matFacade = new THREE.MeshStandardMaterial({
    color: 0x3b4148, map: concreteMap, roughness: 0.9, metalness: 0.02,
    emissive: 0x0d1014,
  });
  const matSteel = new THREE.MeshStandardMaterial({
    color: 0x474e58, roughness: 0.62, metalness: 0.25, emissive: 0x14181e,
  });
  const matRoofUnder = new THREE.MeshStandardMaterial({
    color: 0x353c45, roughness: 0.86, metalness: 0.06, emissive: 0x161a21,
    vertexColors: true,
  });
  // The corner blocks face away from the rig and are the only thing the bowl
  // sees through the notch between stands, so they carry their own lift.
  const matCorner = new THREE.MeshStandardMaterial({
    color: 0x646c76, map: concreteMap, roughness: 0.92, metalness: 0.0,
    emissive: 0x3a424e, vertexColors: true,
  });
  const matDark = new THREE.MeshStandardMaterial({
    color: 0x23272d, roughness: 0.85, metalness: 0.1, emissive: 0x080a0d,
  });
  // Parapet / frontage concrete. Vertex-coloured: the floodlight wash is
  // strongest low down where it skims off the turf, so the strip gets a real
  // vertical gradient and the faces that turn away from the pitch go dark —
  // without that every box in the perimeter returned the same grey and the
  // whole band read as one slab.
  const matWall = new THREE.MeshStandardMaterial({
    color: 0x666d76, map: wallMap, roughness: 0.9, metalness: 0.0,
    emissive: 0x131720, vertexColors: true,
  });
  const matWallPlain = matWall.clone();
  matWallPlain.vertexColors = false;
  const matCap = new THREE.MeshStandardMaterial({
    color: 0x70777f, roughness: 0.78, metalness: 0.05, emissive: 0x161a20,
  });
  // Parapet handrail: powder-coated galvanised tube, NOT chrome. Low metalness
  // so it takes a soft diffuse top highlight from the rig instead of mirroring
  // the black sky and reading as a scaffolding pole.
  const matRail = new THREE.MeshStandardMaterial({
    color: 0x6e7784, roughness: 0.55, metalness: 0.06, emissive: 0x11151b,
  });
  // Padded sleeve on the goal-end rail runs + the club-vinyl wrap collars.
  const matPad = new THREE.MeshStandardMaterial({
    color: 0x1b2740, roughness: 0.88, metalness: 0.0, emissive: 0x0a0e18,
  });
  // Fixture housings / glare hoods: near-black so the emissive lens sits in a
  // recess rather than floating on a white domino tile.
  const matFixDark = new THREE.MeshStandardMaterial({
    color: 0x191d23, roughness: 0.8, metalness: 0.15, emissive: 0x05070a,
  });
  // LED board carcass: matte black bezel/hood/plinth.
  const matAdCase = new THREE.MeshStandardMaterial({
    color: 0x14161a, roughness: 0.72, metalness: 0.12, emissive: 0x090a0d,
  });

  // Geometry buckets, merged once at the end — the whole bowl is a handful of
  // draw calls rather than a few thousand.
  const B = {
    concrete: [], riser: [], facade: [], steel: [], roof: [], dark: [],
    wall: [], cap: [], rail: [], corner: [], pad: [], fixdark: [], adcase: [],
  };
  const box = (bucket, w, h, d, x, y, z) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    B[bucket].push(g);
  };

  // Emissive collections (own meshes, built after the opaque merge).
  const litGeos = [];        // hospitality glazing / vomitories / press boxes
  const haloGeos = [];       // soft spill halo around each lit opening
  const ribbonGeos = [];     // tier-divider LED ribbon
  const signGeos = [];       // concrete signage banding
  const fasciaGeos = [];     // warm bounce band along the roof leading edge
  const screenGeos = [];     // big LED screens (corners + goal ends)
  const screenViews = [];    // { pos, w, h, nx, nz } per screen — camera targets for in-world nav

  const interiorTex = makeInteriorTexture(rng, low ? 512 : 1024);
  const ATLAS_X = 4, ATLAS_Y = 2;

  /** Lit opening: recessed emissive quad + a dim halo bleeding onto the wall. */
  function litQuad(w, h, x, y, z, yaw, cell, bright) {
    const g = new THREE.PlaneGeometry(w, h);
    atlasUV(g, cell % ATLAS_X, Math.floor(cell / ATLAS_X), ATLAS_X, ATLAS_Y);
    g.rotateY(yaw);
    g.translate(x, y, z);
    setColor(g, bright, bright * 0.965, bright * 0.9);
    litGeos.push(g);

    const hg = new THREE.PlaneGeometry(w * 1.7, h * 2.1);
    hg.rotateY(yaw);
    hg.translate(x + Math.sin(yaw) * 0.02, y, z + Math.cos(yaw) * 0.02);
    setColor(hg, bright * 0.30, bright * 0.26, bright * 0.19);
    haloGeos.push(hg);
  }

  // -- terraces -------------------------------------------------------------
  // One stepped box per row; the box hangs down by a full rowRise so the risers
  // close themselves and the whole tier reads as poured concrete.
  for (const stand of STANDS) {
    const len = stand.length;
    const isX = stand.axis === 'x';

    for (let t = 0; t < TIERS.length; t++) {
      const tier = TIERS[t];
      const base = tier.baseDist[stand.axis];

      for (let r = 0; r < tier.rows; r++) {
        const dist = base + r * tier.rowDepth;
        const top = tier.baseY + r * tier.rowRise - FOOT_DROP;
        const h = tier.rowRise + TREAD_GAP;
        const cd = stand.sign * (dist + tier.rowDepth / 2);
        const bucket = r === 0 ? 'facade' : 'concrete';

        if (isX) box(bucket, tier.rowDepth, h, len, cd, top - h / 2, 0);
        else box(bucket, len, h, tier.rowDepth, 0, top - h / 2, cd);

        // Thin dark lip at the front of each tread: reads as the seat-row shadow
        // line and stops the terrace from looking like a smooth ramp.
        const lipY = top - 0.06;
        const ld = stand.sign * (dist + 0.06);
        if (isX) box('riser', 0.12, 0.13, len, ld, lipY, 0);
        else box('riser', len, 0.13, 0.12, 0, lipY, ld);
      }

      const backDist = base + tier.rows * tier.rowDepth;

      if (t === 0) {
        // -- stand frontage -------------------------------------------------
        // Everything from here to the parapet is the strip that a low camera
        // sees between the LED boards and the first crowd row. Flat boxes made
        // it read as one dark slab, so the whole profile is modelled: a stepped
        // base, a proud coping on every horizontal edge with a shadow reveal
        // under it, pilaster ribs, club lettering banded across the face, and
        // warm aisle lights under the deck nosing.
        const frontY = tier.baseY - FOOT_DROP;
        const fd = stand.sign * (base - 0.25);
        if (isX) box('wall', 0.5, frontY, len, fd, frontY / 2, 0);
        else box('wall', len, frontY, 0.5, 0, frontY / 2, fd);

        const sgn = stand.sign;
        const fyaw = isX ? (sgn > 0 ? -Math.PI / 2 : Math.PI / 2)
          : (sgn > 0 ? Math.PI : 0);
        // Place a box in a stand-relative frame. d = distance of the box CENTRE
        // from the world centre (smaller d = closer to the pitch), w = thickness
        // across the stand, hh = height, a/aLen = position and size along it.
        const put = (bucket, d, y, hh, w, a, aLen) => {
          const p = sgn * d;
          if (isX) box(bucket, w, hh, aLen, p, y, a);
          else box(bucket, aLen, hh, w, a, y, p);
        };
        // Pale coping over a horizontal edge whose face sits at df and whose
        // body is w thick, plus the dark drip reveal that makes the nose read.
        const coping = (df, y, w) => {
          put('cap', df + w / 2 - 0.03, y + 0.045, 0.09, w + 0.1, 0, len);
          put('fixdark', df - 0.02, y - 0.055, 0.07, 0.09, 0, len);
        };

        // Two shallow steps up from the walkway to the first row — real grounds
        // never have a sheer face here and the step edges catch spill light.
        for (let s = 0; s < 2; s++) {
          const sy = frontY * (0.34 + 0.33 * s);
          const sd = base - 0.5 - 0.32 * (1 - s);
          put('wall', sd, sy / 2, sy, 0.34, 0, len);
          coping(sd - 0.17, sy, 0.34);
        }
        // Deck edge at the top of the frontage.
        coping(base - 0.5, frontY, 0.5);

        // Pilaster ribs on the frontage face with a shadow reveal under the
        // deck nose and a plinth course at their feet. Only ~0.55 m of this
        // face clears the parapet from a low camera, so the rhythm has to come
        // from tone (nose highlight / reveal / lit face / plinth), not detail.
        const faceD = base - 0.5;
        const topY = frontY - 0.11;
        const botY = frontY * 0.67 + 0.06;      // clear of the upper step's coping
        const panY = (topY + botY) / 2, panH = topY - botY;
        const nRib = Math.max(4, Math.round(len / 4.4));
        for (let i = 0; i <= nRib; i++) {
          const a = -len / 2 + (i * len) / nRib;
          put('wall', faceD - 0.06, panY, panH, 0.2, a, 0.3);
        }
        // Plinth course tying the feet of the ribs together.
        put('wall', faceD - 0.045, botY + 0.05, 0.1, 0.16, 0, len);

        // Club/competition vinyl banded along the frontage between the ribs —
        // the thing that stops this face being a blank grey run at close range.
        const vg = new THREE.PlaneGeometry(len - 3, 0.3);
        scaleUV(vg, (len - 3) / 30, 1);
        vg.rotateY(fyaw);
        vg.translate(isX ? sgn * (faceD - 0.02) : 0, panY + 0.03,
          isX ? 0 : sgn * (faceD - 0.02));
        signGeos.push(vg);

        // Aisle lights under the deck nosing: small warm sources with a soft
        // spill, the depth cue that stops the strip reading as one flat value.
        for (let i = 0; i < nRib; i += 2) {
          const a = -len / 2 + ((i + 0.5) * len) / nRib;
          const gx = isX ? sgn * (faceD - 0.13) : a;
          const gz = isX ? a : sgn * (faceD - 0.13);
          litQuad(0.3, 0.15, gx, panY + 0.06, gz, fyaw, 6, 1.1);
        }

        const fillDepth = backDist - base;
        const fillC = stand.sign * (base + fillDepth / 2);
        if (isX) box('dark', fillDepth, tier.baseY, len, fillC, tier.baseY / 2, 0);
        else box('dark', len, tier.baseY, fillDepth, 0, tier.baseY / 2, fillC);

        // Concourse walkway across the back of the lower tier.
        const wy = tier.baseY + tier.rows * tier.rowRise - FOOT_DROP;
        const wc = stand.sign * (backDist + 1.6);
        if (isX) box('concrete', 3.2, 0.4, len, wc, wy - 0.2, 0);
        else box('concrete', len, 0.4, 3.2, 0, wy - 0.2, wc);
      } else {
        // Upper tier: soffit slab, front fascia and support columns. The tier
        // cantilevers over the lower bowl, so its underside is very visible
        // from the broadcast camera on the opposite side.
        const depth = backDist - base + 2.5;
        const cd2 = stand.sign * (base + depth / 2 - 1.2);
        if (isX) box('roof', depth, 0.6, len, cd2, tier.baseY - 1.1, 0);
        else box('roof', len, 0.6, depth, 0, tier.baseY - 1.1, cd2);

        // --- tier-divider fascia --------------------------------------------
        // The single most valuable band in the bowl: every modern ground runs a
        // wraparound LED ribbon here. Dark bezel above and below, emissive
        // ribbon between, so the divider is no longer a bare grey ribbon.
        const fdz = stand.sign * (base - 1.2);
        if (isX) box('steel', 0.45, 2.4, len, fdz, tier.baseY - 0.35, 0);
        else box('steel', len, 2.4, 0.45, 0, tier.baseY - 0.35, fdz);

        const face = fdz - stand.sign * 0.235;      // pitch-facing surface
        const ribY = tier.baseY - 0.5;
        const ribH = 0.92;
        const yaw = isX ? (stand.sign > 0 ? -Math.PI / 2 : Math.PI / 2)
          : (stand.sign > 0 ? Math.PI : 0);
        const rg = new THREE.PlaneGeometry(len - 1.2, ribH);
        // One full artwork cycle per ~46 m, so each block is a readable ~11 m
        // rather than a strobing rainbow.
        scaleUV(rg, (len - 1.2) / 46, 1);
        rg.rotateY(yaw);
        rg.translate(isX ? face : 0, ribY, isX ? 0 : face);
        ribbonGeos.push(rg);

        // Dark bezel lips top and bottom of the ribbon so it reads as inset.
        for (const s of [-1, 1]) {
          const by = ribY + s * (ribH / 2 + 0.13);
          if (isX) box('fixdark', 0.16, 0.24, len, face - stand.sign * 0.02, by, 0);
          else box('fixdark', len, 0.24, 0.16, 0, by, face - stand.sign * 0.02);
        }

        const cols = Math.round(len / 9);
        for (let i = 0; i <= cols; i++) {
          const a = -len / 2 + (i * len) / cols;
          const colD = stand.sign * (backDist + 0.5);
          const x = isX ? colD : a;
          const z = isX ? a : colD;
          box('steel', 0.7, tier.baseY - 1.4, 0.7, x, (tier.baseY - 1.4) / 2, z);
        }
      }
    }

    // -- back wall ------------------------------------------------------------
    // Was a flat black void above the top crowd row. Now: cladding banding with
    // a shadow line, vertical expansion joints, a run of vomitory openings with
    // concourse glow behind them, glazed press boxes, and tier lettering.
    const bw = BACK_WALL_DIST[stand.axis];
    const bwY = 30;
    const bwd = stand.sign * bw;
    if (isX) box('facade', 1.0, bwY, len, bwd, bwY / 2, 0);
    else box('facade', len, bwY, 1.0, 0, bwY / 2, bwd);

    const inner = bwd - stand.sign * 0.5;           // pitch-facing wall surface
    const yaw = isX ? (stand.sign > 0 ? -Math.PI / 2 : Math.PI / 2)
      : (stand.sign > 0 ? Math.PI : 0);
    const nrm = stand.sign * -1;                    // toward the pitch, as a sign

    // Horizontal cladding ribs with a shadow line under each.
    for (let i = 0; i < 7; i++) {
      const y = 3.4 + i * 4.1;
      if (isX) box('steel', 0.34, 0.34, len, inner + nrm * 0.12, y, 0);
      else box('steel', len, 0.34, 0.34, 0, y, inner + nrm * 0.12);
      if (isX) box('fixdark', 0.2, 0.16, len, inner + nrm * 0.05, y - 0.28, 0);
      else box('fixdark', len, 0.16, 0.2, 0, y - 0.28, inner + nrm * 0.05);
    }
    // Vertical expansion joints / stair-tower pilasters.
    const nJ = Math.round(len / 7.5);
    for (let i = 0; i <= nJ; i++) {
      const a = -len / 2 + (i * len) / nJ;
      const isTower = i % 3 === 1;
      const w = isTower ? 3.0 : 0.7;
      const d = isTower ? 1.5 : 0.45;
      const x = isX ? inner + nrm * (d / 2) : a;
      const z = isX ? a : inner + nrm * (d / 2);
      box(isTower ? 'facade' : 'fixdark', isX ? d : w, bwY, isX ? w : d, x, bwY / 2, z);
      if (isTower) {
        // Lit external stair run: a diagonal ladder of small warm panels.
        for (let s = 0; s < 7; s++) {
          const sy = 3.0 + s * 3.6;
          if (sy > bwY - 2) break;
          const off = ((s % 2) - 0.5) * 1.05;
          const px = isX ? inner + nrm * (d + 0.06) : a + off;
          const pz = isX ? a + off : inner + nrm * (d + 0.06);
          litQuad(0.85, 0.5, px, sy, pz, yaw, 6, 0.55);
        }
      }
    }
    // Vomitory openings + glazed press boxes above the top crowd row.
    const topY = TIERS[1].baseY + (TIERS[1].rows - 1) * TIERS[1].rowRise;
    const nV = isX ? 6 : 8;
    for (let i = 0; i < nV; i++) {
      const a = (-len / 2) + ((i + 0.5) * len) / nV;
      const px = isX ? inner + nrm * 0.55 : a;
      const pz = isX ? a : inner + nrm * 0.55;
      // recess box so the opening has depth rather than being a sticker
      box('fixdark', isX ? 1.2 : 3.6, 3.5, isX ? 3.6 : 1.2,
        isX ? inner + nrm * 0.1 : a, topY + 2.1, isX ? a : inner + nrm * 0.1);
      litQuad(3.1, 2.9, px, topY + 2.1, pz, yaw, 6, 0.62);
      // press / exec box between vomitories
      if (i < nV - 1) {
        const b = (-len / 2) + ((i + 1) * len) / nV;
        const qx = isX ? inner + nrm * 0.5 : b;
        const qz = isX ? b : inner + nrm * 0.5;
        litQuad(4.2, 1.5, qx, topY + 1.6, qz, yaw, i % 6, 0.5 + 0.1 * ((i * 7) % 3));
      }
    }
    // Tier lettering band across the top of the wall.
    const sg = new THREE.PlaneGeometry(len - 4, 1.5);
    scaleUV(sg, (len - 4) / 26, 1);
    sg.rotateY(yaw);
    sg.translate(isX ? inner + nrm * 0.6 : 0, bwY - 1.6, isX ? 0 : inner + nrm * 0.6);
    signGeos.push(sg);

  }

  // -- roofs ----------------------------------------------------------------
  for (const stand of STANDS) {
    const key = stand.axis;
    const isX = key === 'x';
    const front = ROOF[key].front, back = ROOF[key].back;
    const span = back - front;
    const rise = ROOF.yBack - ROOF.yFront;
    const slabLen = Math.hypot(span, rise);
    const angle = Math.atan2(rise, span);
    const cd = stand.sign * (front + span / 2);
    const cy = (ROOF.yFront + ROOF.yBack) / 2;
    const len = stand.length + 6;

    const slab = new THREE.BoxGeometry(
      isX ? slabLen : len, ROOF.thickness, isX ? len : slabLen
    );
    // Slope rises away from the pitch; sign flips with the stand's side.
    if (isX) slab.rotateZ(-stand.sign * angle);
    else slab.rotateX(stand.sign * angle);
    slab.translate(isX ? cd : 0, cy, isX ? 0 : cd);
    B.roof.push(slab);

    // Primary trusses across the span with diagonal web bracing, plus purlins
    // running the length of the stand: the ribbed underside catches the light
    // spilling off the pitch and gives the bowl its scale.
    const ribs = Math.round(len / 6);
    for (let i = 0; i <= ribs; i++) {
      const a = -len / 2 + (i * len) / ribs;
      const rib = new THREE.BoxGeometry(isX ? slabLen : 0.35, 0.9, isX ? 0.35 : slabLen);
      if (isX) rib.rotateZ(-stand.sign * angle);
      else rib.rotateX(stand.sign * angle);
      rib.translate(isX ? cd : a, cy - ROOF.thickness / 2 - 0.47, isX ? a : cd);
      B.steel.push(rib);

      // Lower chord + zig-zag web: this is what makes it read as a truss.
      if (i % 2 === 0) {
        const chord = new THREE.BoxGeometry(isX ? slabLen * 0.92 : 0.22, 0.26, isX ? 0.22 : slabLen * 0.92);
        if (isX) chord.rotateZ(-stand.sign * angle);
        else chord.rotateX(stand.sign * angle);
        chord.translate(isX ? cd : a, cy - ROOF.thickness / 2 - 1.9, isX ? a : cd);
        B.steel.push(chord);
        const nW = 7;
        for (let w = 0; w < nW; w++) {
          const f = (w + 0.5) / nW;
          const dd = stand.sign * (front + span * f);
          const yy = ROOF.yFront + rise * f - ROOF.thickness / 2 - 1.2;
          const diag = new THREE.BoxGeometry(isX ? 1.6 : 0.18, 1.5, isX ? 0.18 : 1.6);
          diag.rotateY(isX ? 0 : 0);
          if (isX) diag.rotateZ((w % 2 ? 1 : -1) * 0.72);
          else diag.rotateX((w % 2 ? 1 : -1) * 0.72);
          diag.translate(isX ? dd : a, yy, isX ? a : dd);
          B.steel.push(diag);
        }
      }
    }
    for (let p = 1; p <= 4; p++) {
      const f = p / 5;                       // 0..1 front → back along the span
      const dd = stand.sign * (front + span * f);
      const py = ROOF.yFront + rise * f - ROOF.thickness / 2 - 0.30;
      const purlin = new THREE.BoxGeometry(isX ? 0.26 : len, 0.4, isX ? len : 0.26);
      purlin.translate(isX ? dd : 0, py, isX ? 0 : dd);
      B.steel.push(purlin);
    }

    // --- roof leading edge: deep fascia, gutter, catwalk, handrail ----------
    const fasciaD = stand.sign * front;
    if (isX) box('steel', 0.6, 2.1, len, fasciaD, ROOF.yFront - 0.75, 0);
    else box('steel', len, 2.1, 0.6, 0, ROOF.yFront - 0.75, fasciaD);
    // Warm-lit fascia band: catches the bounce off the pitch and gives the top
    // quarter of every master shot a horizon line instead of a void.
    const fyaw = isX ? (stand.sign > 0 ? -Math.PI / 2 : Math.PI / 2)
      : (stand.sign > 0 ? Math.PI : 0);
    const fq = new THREE.PlaneGeometry(len - 2, 0.62);
    scaleUV(fq, (len - 2) / 30, 1);
    fq.rotateY(fyaw);
    fq.translate(isX ? fasciaD - stand.sign * 0.33 : 0, ROOF.yFront - 0.42,
      isX ? 0 : fasciaD - stand.sign * 0.33);
    fasciaGeos.push(fq);
    // Gutter profile + drip edge.
    if (isX) box('fixdark', 0.5, 0.34, len, fasciaD - stand.sign * 0.42, ROOF.yFront - 1.95, 0);
    else box('fixdark', len, 0.34, 0.5, 0, ROOF.yFront - 1.95, fasciaD - stand.sign * 0.42);
    // Maintenance catwalk with handrail, full length behind the fascia.
    const cwD = stand.sign * (front + 1.5);
    if (isX) box('steel', 1.6, 0.12, len, cwD, ROOF.yFront - 2.6, 0);
    else box('steel', len, 0.12, 1.6, 0, ROOF.yFront - 2.6, cwD);
    for (const rr of [0.55, 1.05]) {
      const rd = stand.sign * (front + 0.75);
      const g = new THREE.CylinderGeometry(0.035, 0.035, len, 6);
      g.rotateZ(Math.PI / 2);
      if (isX) g.rotateY(Math.PI / 2);
      g.translate(isX ? rd : 0, ROOF.yFront - 2.6 + rr, isX ? 0 : rd);
      B.rail.push(g);
    }
    const nCw = Math.round(len / 4);
    for (let i = 0; i <= nCw; i++) {
      const a = -len / 2 + (i * len) / nCw;
      const rd = stand.sign * (front + 0.75);
      box('rail', isX ? 0.06 : 0.06, 1.05, 0.06, isX ? rd : a, ROOF.yFront - 2.08, isX ? a : rd);
    }
    // Speaker clusters + camera platforms hung off the fascia.
    const nSp = isX ? 4 : 6;
    for (let i = 0; i < nSp; i++) {
      const a = -len / 2 + ((i + 0.5) * len) / nSp;
      const sd = stand.sign * (front + 0.4);
      box('fixdark', isX ? 1.1 : 1.7, 1.3, isX ? 1.7 : 1.1,
        isX ? sd : a, ROOF.yFront - 3.6, isX ? a : sd);
      box('fixdark', 0.14, 1.0, 0.14, isX ? sd : a - 0.6, ROOF.yFront - 2.65, isX ? a - 0.6 : sd);
      box('fixdark', 0.14, 1.0, 0.14, isX ? sd : a + 0.6, ROOF.yFront - 2.65, isX ? a + 0.6 : sd);
    }
    if (!isX) {
      for (const a of [-30, 30]) {
        const sd = stand.sign * (front + 2.6);
        box('steel', 2.6, 0.16, 2.2, a, ROOF.yFront - 3.2, sd);
        box('fixdark', 0.9, 0.6, 0.7, a, ROOF.yFront - 2.7, sd - stand.sign * 0.7);
        for (const c of [-1, 1]) {
          box('rail', 0.06, 0.95, 0.06, a + c * 1.2, ROOF.yFront - 2.6, sd + stand.sign * 1.0);
        }
      }
    }

    // Roof-hung goal-end scoreboard: the screen that actually falls inside a
    // behind-goal framing, slung off the cantilever above each goal.
    if (isX) {
      const sw = 12.5, sh = sw * 0.5625;
      const sxp = stand.sign * (front - 1.0);
      const syp = 23.0;
      box('fixdark', 0.7, sh + 1.1, sw + 1.1, sxp + stand.sign * 0.3, syp, 0);
      const scr = new THREE.PlaneGeometry(sw, sh);
      scr.rotateY(fyaw);
      scr.translate(sxp - stand.sign * 0.1, syp, 0);
      screenGeos.push(scr);
      screenViews.push({ pos: new THREE.Vector3(sxp - stand.sign * 0.1, syp, 0), w: sw, h: sh, nx: -stand.sign, nz: 0 });
      for (const s of [-1, 1]) {
        box('steel', 0.3, 3.4, 0.3, sxp + stand.sign * 0.5, syp + sh / 2 + 1.9, s * (sw / 2 - 1.4));
        box('steel', 0.22, 0.22, 2.2, sxp + stand.sign * 1.1, syp + sh / 2 + 0.4, s * (sw / 2 - 1.4));
      }
    }

    // Rear roof columns down to the back wall.
    const nCol = Math.round(len / 10);
    for (let i = 0; i <= nCol; i++) {
      const a = -len / 2 + (i * len) / nCol;
      const cdd = stand.sign * (back - 1.5);
      const x = isX ? cdd : a;
      const z = isX ? a : cdd;
      box('steel', 0.8, ROOF.yBack, 0.8, x, ROOF.yBack / 2, z);
    }
  }

  // -- corner infill --------------------------------------------------------
  // A real building in each corner: recessed glazing behind piers and spandrel
  // bands (so the windows have reveals and mullion shadow), a warm interior with
  // silhouetted figures, a lit stair tower, club signage banding, and a 45°
  // chamfer carrying a big LED screen aimed at the pitch centre.
  const screenAnchors = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const { x1, z1, h } = CORNER;
      const x0 = CORNER.x0 + 0.35;   // outer face line of the piers
      const z0 = CORNER.z0 + 0.35;
      const REV = 0.55;              // glazing recess depth
      const bx = x0 + REV, bz = z0 + REV;   // block face (glazing plane)
      const lx = x1 - bx, lz = z1 - bz;
      const CUT = CORNER_CHAMFER;
      // L-shaped mass: the corner square is left to the 45° screen face below,
      // otherwise the block's own two faces would stand in front of the screen.
      box('corner', lx, h, lz - CUT, sx * (bx + x1) / 2, h / 2, sz * (bz + CUT + z1) / 2);
      box('corner', lx - CUT, h, CUT, sx * (bx + CUT + x1) / 2, h / 2, sz * (bz + CUT / 2));

      // Window band layout, shared by both inner faces.
      // The 45° screen face eats the first CORNER_CHAMFER metres of each inner
      // face, so the piers/spandrels/glazing must start beyond it — otherwise
      // they stand in front of the screen and hide it completely.
      const cut = CORNER_CHAMFER;
      const bands = [[9.2, 1.75], [15.4, 1.75], [21.6, 1.75]];
      const faces = [
        { along: 'z', L: lz - cut, s0: bz + cut, fixed: bx, sgnA: sz, sgnF: sx },
        { along: 'x', L: lx - cut, s0: bx + cut, fixed: bz, sgnA: sx, sgnF: sz },
      ];
      for (const f of faces) {
        const nBay = Math.max(3, Math.round(f.L / 3.1));
        const bayW = f.L / nBay;
        const yawF = f.along === 'z'
          ? (f.sgnF > 0 ? -Math.PI / 2 : Math.PI / 2)
          : (f.sgnF > 0 ? Math.PI : 0);
        // piers
        for (let i = 0; i <= nBay; i++) {
          const a = f.s0 + i * bayW;
          const px = f.along === 'z' ? f.sgnF * (bx - REV / 2) : f.sgnA * a;
          const pz = f.along === 'z' ? f.sgnA * a : f.sgnF * (bz - REV / 2);
          box('corner', f.along === 'z' ? REV + 0.1 : 0.6, h, f.along === 'z' ? 0.6 : REV + 0.1,
            px, h / 2, pz);
        }
        // spandrels between the window bands
        const edges = [0];
        for (const [y, bh] of bands) { edges.push(y - bh / 2, y + bh / 2); }
        edges.push(h);
        for (let i = 0; i < edges.length; i += 2) {
          const y0 = edges[i], y1b = edges[i + 1];
          if (y1b - y0 < 0.1) continue;
          const cx2 = f.along === 'z' ? f.sgnF * (bx - REV / 2) : f.sgnA * (f.s0 + f.L / 2);
          const cz2 = f.along === 'z' ? f.sgnA * (f.s0 + f.L / 2) : f.sgnF * (bz - REV / 2);
          box('corner', f.along === 'z' ? REV + 0.1 : f.L, y1b - y0, f.along === 'z' ? f.L : REV + 0.1,
            cx2, (y0 + y1b) / 2, cz2);
        }
        // recessed glazing, one lit quad per bay per band
        for (const [y, bh] of bands) {
          for (let i = 0; i < nBay; i++) {
            const a = f.s0 + (i + 0.5) * bayW;
            const qx = f.along === 'z' ? f.sgnF * bx : f.sgnA * a;
            const qz = f.along === 'z' ? f.sgnA * a : f.sgnF * bz;
            const cell = Math.floor(rng() * 6);
            const bright = 0.42 + rng() * 0.5;
            litQuad(bayW * 0.82, bh * 0.86, qx, y, qz, yawF, cell, bright);
          }
        }
        // club / competition signage banded across the concrete
        const sgg = new THREE.PlaneGeometry(f.L * 0.9, 1.4);
        scaleUV(sgg, (f.L * 0.9) / 26, 1);
        sgg.rotateY(yawF);
        sgg.translate(
          f.along === 'z' ? f.sgnF * (bx - REV - 0.06) : f.sgnA * (f.s0 + f.L / 2),
          5.2,
          f.along === 'z' ? f.sgnA * (f.s0 + f.L / 2) : f.sgnF * (bz - REV - 0.06)
        );
        signGeos.push(sgg);
      }

      // Coping.
      box('cap', REV + 1.2, 0.9, lz - cut + 1.2, sx * (bx - REV / 2), h - 0.45,
        sz * (bz + cut + (lz - cut) / 2));
      box('cap', lx - cut + 1.2, 0.9, REV + 1.2, sx * (bx + cut + (lx - cut) / 2), h - 0.45,
        sz * (bz - REV / 2));

      // --- 45° chamfer + big LED screen -----------------------------------
      const c = CORNER_CHAMFER;
      const mx = bx + c / 2, mz = bz + c / 2;              // chamfer face midpoint
      const nx = -sx / Math.SQRT2, nz = -sz / Math.SQRT2;  // face normal → pitch
      const cyaw = Math.atan2(nx, nz);
      const chW = c * Math.SQRT2;
      const chD = c / Math.SQRT2 + 0.7;      // deep enough to close the corner
      const ch = new THREE.BoxGeometry(chW, h, chD);
      ch.rotateY(cyaw);
      ch.translate(sx * mx - nx * (chD / 2), h / 2, sz * mz - nz * (chD / 2));
      B.corner.push(ch);
      const pitchward = (d) => [sx * mx + nx * d, sz * mz + nz * d];
      const [scx, scz] = pitchward(0.26);
      screenAnchors.push({ x: scx, z: scz, yaw: cyaw, nx, nz, w: chW - 1.8 });
      // Screen surround / gantry, front face just behind the panel.
      const [frx, frz] = pitchward(-0.05);
      const fr = new THREE.BoxGeometry(chW - 0.9, 7.6, 0.5);
      fr.rotateY(cyaw);
      fr.translate(frx, 19.8, frz);
      B.fixdark.push(fr);

      // Glazing + signage banded across the chamfer, above and below the screen,
      // so the corner face is a building rather than a blank plate.
      const [gx, gz] = pitchward(0.03);
      for (const gy of [9.2, 24.4]) {
        for (let i = 0; i < 3; i++) {
          const off = (i - 1) * (chW / 3.4);
          const ox = gx + Math.cos(cyaw) * off, oz = gz - Math.sin(cyaw) * off;
          litQuad(chW / 4.2, 1.55, ox, gy, oz, cyaw, Math.floor(rng() * 6), 0.4 + rng() * 0.45);
        }
        // proud lips above and below each band → reveal + mullion shadow
        const [bx2, bz2] = pitchward(0.18);
        for (const s of [-1, 1]) {
          const bb = new THREE.BoxGeometry(chW - 0.5, 0.3, 0.42);
          bb.rotateY(cyaw);
          bb.translate(bx2, gy + s * 1.05, bz2);
          B.fixdark.push(bb);
        }
      }
      const [sgx, sgz] = pitchward(0.05);
      const csg = new THREE.PlaneGeometry(chW - 2.2, 1.4);
      scaleUV(csg, (chW - 2.2) / 24, 1);
      csg.rotateY(cyaw);
      csg.translate(sgx, 5.0, sgz);
      signGeos.push(csg);

      // Corner roof panel, tying the two cantilevers together so no sky leaks
      // through the notch above the corner block. Ribs carried through at the
      // same 6 m pitch as the cantilever trusses.
      const rw = x1 - CORNER.x0 + 3, rd = z1 - CORNER.z0 + 3;
      const rcx = sx * (CORNER.x0 - 3 + rw / 2);
      const rcz = sz * (CORNER.z0 - 3 + rd / 2);
      const rslab = new THREE.BoxGeometry(rw, 0.5, rd);
      rslab.translate(rcx, 30.6, rcz);
      B.roof.push(rslab);
      for (let i = 0; i < 4; i++) {
        const rr = new THREE.BoxGeometry(rw, 0.45, 0.32);
        rr.translate(rcx, 30.0, rcz + sz * (-7.5 + i * 5.9));
        B.steel.push(rr);
        const rr2 = new THREE.BoxGeometry(0.32, 0.45, rd);
        rr2.translate(rcx + sx * (-7.5 + i * 5.9), 30.0, rcz);
        B.steel.push(rr2);
      }
    }
  }

  // -- perimeter wall, parapet rail, walkway and stewards -------------------
  buildPerimeter(B, box);

  // -- assemble merged meshes ----------------------------------------------
  const matFor = {
    concrete: matConcrete, riser: matRiser, facade: matFacade,
    steel: matSteel, roof: matRoofUnder, dark: matDark,
    wall: matWall, cap: matCap, rail: matRail, corner: matCorner,
    pad: matPad, fixdark: matFixDark, adcase: matAdCase,
  };
  for (const key of Object.keys(B)) {
    if (!B[key].length) continue;
    const merged = mergeGeometries(B[key], false);
    if (key === 'roof') bakeSoffitAO(merged);
    if (key === 'corner') bakeCornerAO(merged);
    if (key === 'wall') bakeWallAO(merged);
    const mesh = new THREE.Mesh(merged, matFor[key]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = 'stadium_' + key;
    group.add(mesh);
    B[key].forEach((g) => g.dispose());
    B[key].length = 0;
  }

  // Lit glazing / vomitory strips: one merged emissive mesh for the whole bowl.
  if (litGeos.length) {
    const litMat = new THREE.MeshBasicMaterial({
      map: interiorTex, toneMapped: false, fog: true, vertexColors: true,
    });
    litMat.color.setRGB(1.25, 1.25, 1.25);
    const lit = new THREE.Mesh(mergeGeometries(litGeos, false), litMat);
    lit.name = 'stadium_lit';
    lit.renderOrder = 1;
    group.add(lit);
    litGeos.forEach((g) => g.dispose());
  }
  if (haloGeos.length) {
    const haloMat = new THREE.MeshBasicMaterial({
      map: makeSoftGlowTexture(), transparent: true, depthWrite: false,
      toneMapped: false, blending: THREE.AdditiveBlending, fog: true,
      vertexColors: true,
    });
    const halo = new THREE.Mesh(mergeGeometries(haloGeos, false), haloMat);
    halo.name = 'stadium_litglow';
    halo.renderOrder = 2;
    group.add(halo);
    haloGeos.forEach((g) => g.dispose());
  }

  // Tier-divider LED ribbon board.
  //
  // The ribbon runs the full perimeter at 14.5 m, which is exactly the height
  // band the behind-goal lens throws against the top edge of frame. Seen from
  // that lens the two TOUCHLINE ribbons are ~70° off their own normal and used
  // to smear a second, brighter strip of text right across the top of the
  // picture, above the far stand's ribbon — the "ghost band". Real LED panels
  // are strongly directional (a ribbon viewed edge-on reads as dark glass), so
  // the fix is the physical one: an angular falloff, applied per fragment.
  // Face-on (the far stand from behind the goal, the far touchline from the TV
  // gantry) is untouched; grazing runs fall away to nothing.
  let ribbonTex = null;
  if (ribbonGeos.length) {
    ribbonTex = makeRibbonTexture(low ? 512 : 1024);
    if (renderer) ribbonTex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    const rmat = new THREE.MeshBasicMaterial({ map: ribbonTex, toneMapped: false, fog: true });
    rmat.color.setRGB(0.82, 0.82, 0.82);
    ledDirectional(rmat, 3.2, 0.02);
    const rib = new THREE.Mesh(mergeGeometries(ribbonGeos, false), rmat);
    rib.name = 'tier_ribbon';
    rib.renderOrder = 1;
    group.add(rib);
    ribbonGeos.forEach((g) => g.dispose());
  }

  // Concrete signage bands.
  if (signGeos.length) {
    const stex = makeSignageTexture(low ? 512 : 1024);
    const smat = new THREE.MeshBasicMaterial({
      map: stex, transparent: true, depthWrite: false, toneMapped: false, fog: true,
    });
    smat.color.setRGB(0.8, 0.75, 0.66);
    const sm = new THREE.Mesh(mergeGeometries(signGeos, false), smat);
    sm.name = 'stadium_signage';
    sm.renderOrder = 1;
    group.add(sm);
    signGeos.forEach((g) => g.dispose());
  }

  // Warm bounce band along the roof leading edge: gives the top quarter of every
  // master shot a lit horizon instead of a black void.
  if (fasciaGeos.length) {
    const ftex = makeFasciaTexture();
    const fmat = new THREE.MeshBasicMaterial({
      map: ftex, transparent: true, depthWrite: false, toneMapped: false, fog: true,
    });
    fmat.color.setRGB(1.05, 0.88, 0.62);
    const fm = new THREE.Mesh(mergeGeometries(fasciaGeos, false), fmat);
    fm.name = 'roof_fascia_band';
    fm.renderOrder = 1;
    group.add(fm);
    fasciaGeos.forEach((g) => g.dispose());
  }

  // Big LED screens — one behind each goal, one in each corner.
  const screenTex = makeScreenTexture(low ? 512 : 1024);
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false, fog: true });
  screenMat.color.setRGB(1.35, 1.35, 1.35);
  for (const a of screenAnchors) {
    const w = Math.min(10.6, a.w);
    const g = new THREE.PlaneGeometry(w, w * 0.5625);
    g.rotateY(a.yaw);
    g.translate(a.x, 19.8, a.z);
    screenGeos.push(g);
    screenViews.push({ pos: new THREE.Vector3(a.x, 19.8, a.z), w, h: w * 0.5625, nx: a.nx, nz: a.nz });
  }
  // One mesh PER screen (not merged), each with its own material, so each big
  // screen can show a different Pit Wall pillar. Share the default texture until
  // the field view overrides each one.
  screenGeos.forEach((g, i) => {
    const mat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false, fog: true });
    mat.color.setRGB(1.35, 1.35, 1.35);
    const m = new THREE.Mesh(g, mat);
    m.name = 'big_screen_' + i;
    m.renderOrder = 1;
    group.add(m);
  });

  // -- pitchside population -------------------------------------------------
  buildStewards(group, rng, low);

  // -- LED advertising boards ----------------------------------------------
  const adW = low ? 512 : 1024;
  const adTextures = AD_BRANDS.map((b, i) =>
    makeBrandTexture(b, AD_HUES[i], adW, Math.round(adW / 10.2))
  );
  const adMats = adTextures.map((map) => {
    const m = new THREE.MeshBasicMaterial({ map, toneMapped: false, side: THREE.FrontSide });
    m.color.setRGB(1.34, 1.34, 1.34);
    return m;
  });
  const ads = buildAdBoards(group, B, box, adMats);

  // Merge the ad carcass (queued after the main merge pass).
  if (B.adcase.length) {
    const m = new THREE.Mesh(mergeGeometries(B.adcase, false), matAdCase);
    m.name = 'adboard_case';
    group.add(m);
    B.adcase.forEach((g) => g.dispose());
    B.adcase.length = 0;
  }

  // -- floodlight fixtures --------------------------------------------------
  // Two families: the four corner masts (where lighting.js's SpotLights live)
  // and clusters slung under the roof fascias, which are the ones that actually
  // fall inside the broadcast / wide framings. Every lamp is a recessed unit:
  // dark housing box → reflector bowl → emissive lens → glare hood, so the array
  // reads as depth rather than as a domino tile.
  const lampMats = [];
  const lampTint = [];
  const glowMats = [];
  const _b = new THREE.Matrix4();
  const _o = new THREE.Matrix4();
  const _r = new THREE.Matrix4();

  function lampArray(P, yaw, tilt, cols, rows, cw, ch, lw, lh, gain, glowW, glowH, glowZ) {
    _b.makeTranslation(P.x, P.y, P.z);
    _b.multiply(_r.makeRotationY(yaw));
    _b.multiply(_r.makeRotationX(tilt));
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = (c - (cols - 1) / 2) * cw;
        const y = (r - (rows - 1) / 2) * ch;
        // housing (dark, deep) — the recess
        const hs = new THREE.BoxGeometry(lw * 1.16, lh * 1.16, 0.34);
        hs.applyMatrix4(_b.clone().multiply(_o.makeTranslation(x, y, 0.16)));
        B.fixdark.push(hs);
        // reflector bowl, lighter, set inside the recess
        const rf = new THREE.BoxGeometry(lw * 0.96, lh * 0.96, 0.16);
        rf.applyMatrix4(_b.clone().multiply(_o.makeTranslation(x, y, 0.26)));
        B.steel.push(rf);
        // glare shield on the pitch-facing (lower) edge
        const hd = new THREE.BoxGeometry(lw * 1.18, 0.06, 0.3);
        hd.applyMatrix4(_b.clone().multiply(_o.makeTranslation(x, y - lh * 0.62, 0.30)));
        B.fixdark.push(hd);
        // emissive lens at the bottom of the recess
        _o.makeTranslation(x, y, 0.345);
        _o.multiply(_r.makeScale(lw * 0.74, lh * 0.74, 0.05));
        lampMats.push(_b.clone().multiply(_o));
        // ±8% brightness scatter, a few lamps running cool
        const v = gain * (0.92 + rng() * 0.16);
        const cool = rng() < 0.16;
        lampTint.push(cool ? [v * 0.90, v * 0.97, v * 1.10] : [v, v * 0.955, v * 0.885]);
      }
    }
    _o.makeTranslation(0, 0, glowZ);
    _o.multiply(_r.makeScale(glowW, glowH, 1));
    glowMats.push(_b.clone().multiply(_o));
    return _b.clone();
  }

  for (const t of TOWERS) {
    const yaw = Math.atan2(-t.x, -t.z);
    buildPylonMast(group, t, matSteel, matFixDark, matRail, B);
    const base = lampArray(t, yaw, 0.46, 10, 4, 1.02, 1.15, 0.74, 0.5, 1.0, 15, 9.5, 0.72);
    const frame = new THREE.BoxGeometry(11.2, 5.4, 0.5);
    frame.applyMatrix4(base);
    B.fixdark.push(frame);
    // Maintenance catwalk + handrail across the mast head.
    const gantry = new THREE.BoxGeometry(12.6, 0.18, 1.2);
    gantry.applyMatrix4(base.clone().multiply(_o.makeTranslation(0, -3.3, 0.35)));
    B.steel.push(gantry);
    for (const rr of [0.5, 1.0]) {
      const hr = new THREE.BoxGeometry(12.6, 0.07, 0.07);
      hr.applyMatrix4(base.clone().multiply(_o.makeTranslation(0, -3.3 + rr, 0.9)));
      B.rail.push(hr);
    }
    for (let i = 0; i <= 8; i++) {
      const st = new THREE.BoxGeometry(0.07, 1.0, 0.07);
      st.applyMatrix4(base.clone().multiply(_o.makeTranslation(-6.3 + i * 1.575, -2.8, 0.9)));
      B.rail.push(st);
    }
  }

  // Roof-fascia clusters: 7 per touchline stand, 5 behind each goal.
  const ROOF_RIGS = [
    { axis: 'z', sign: -1, n: 7, span: 92 },
    { axis: 'z', sign: 1, n: 7, span: 92 },
    { axis: 'x', sign: -1, n: 5, span: 62 },
    { axis: 'x', sign: 1, n: 5, span: 62 },
  ];
  for (const rig of ROOF_RIGS) {
    const dist = ROOF[rig.axis].front - 1.1;
    for (let i = 0; i < rig.n; i++) {
      const a = -rig.span / 2 + (rig.span * i) / (rig.n - 1);
      const P = rig.axis === 'x'
        ? new THREE.Vector3(rig.sign * dist, 28.0, a)
        : new THREE.Vector3(a, 28.0, rig.sign * dist);
      const yaw = Math.atan2(-P.x, -P.z);
      const base = lampArray(P, yaw, 0.62, 4, 2, 0.86, 0.52, 0.62, 0.34, 0.62, 5.2, 3.4, 0.55);
      const housing = new THREE.BoxGeometry(3.9, 1.55, 0.5);
      housing.applyMatrix4(base);
      B.fixdark.push(housing);
      // Braced double-arm bracket + cable run back to the fascia.
      for (const s of [-1, 1]) {
        const arm = new THREE.BoxGeometry(0.16, 3.0, 0.16);
        arm.translate(0, 1.5, 0);
        arm.rotateZ(s * 0.13);
        arm.translate(P.x + (rig.axis === 'x' ? 0 : s * 1.3), 28.4,
          P.z + (rig.axis === 'x' ? s * 1.3 : 0));
        B.steel.push(arm);
        const br = new THREE.BoxGeometry(0.12, 1.5, 0.12);
        br.rotateX(rig.axis === 'x' ? 0 : 0.6);
        br.rotateZ(rig.axis === 'x' ? 0.6 : 0);
        br.translate(
          P.x + (rig.axis === 'x' ? rig.sign * 0.5 : s * 1.1), 29.6,
          P.z + (rig.axis === 'x' ? s * 1.1 : rig.sign * 0.5)
        );
        B.steel.push(br);
      }
      const tray = new THREE.BoxGeometry(
        rig.axis === 'x' ? 1.6 : 0.22, 0.18, rig.axis === 'x' ? 0.22 : 1.6
      );
      tray.translate(
        P.x + (rig.axis === 'x' ? rig.sign * 0.9 : 0), 31.0,
        P.z + (rig.axis === 'x' ? 0 : rig.sign * 0.9)
      );
      B.fixdark.push(tray);
    }
  }

  // Merge the fixture housings (queued after the main merge pass).
  for (const key of ['steel', 'fixdark', 'rail', 'pad']) {
    if (!B[key].length) continue;
    const merged = mergeGeometries(B[key], false);
    const mesh = new THREE.Mesh(merged, matFor[key]);
    mesh.name = 'stadium_fixtures_' + key;
    mesh.castShadow = false;
    group.add(mesh);
    B[key].forEach((g) => g.dispose());
    B[key].length = 0;
  }

  const lampGeo = new THREE.BoxGeometry(1, 1, 1);
  const lampMat = new THREE.MeshBasicMaterial({ toneMapped: false, fog: false });
  lampMat.color.setRGB(6.4, 6.05, 5.3);
  const lamps = new THREE.InstancedMesh(lampGeo, lampMat, lampMats.length);
  lamps.frustumCulled = false;
  lamps.name = 'floodlamps';
  const _c = new THREE.Color();
  for (let i = 0; i < lampMats.length; i++) {
    lamps.setMatrixAt(i, lampMats[i]);
    const t = lampTint[i];
    lamps.setColorAt(i, _c.setRGB(t[0], t[1], t[2]));
  }
  lamps.instanceMatrix.needsUpdate = true;
  if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  group.add(lamps);

  const glowTex = makeGlowTexture();
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
  });
  glowMat.color.setRGB(1.5, 1.36, 1.02);
  const glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMat, glowMats.length);
  glows.frustumCulled = false;
  glows.renderOrder = 3;
  glows.name = 'floodglow';
  for (let i = 0; i < glowMats.length; i++) glows.setMatrixAt(i, glowMats[i]);
  glows.instanceMatrix.needsUpdate = true;
  group.add(glows);

  // Aircraft warning lights on the mast heads.
  const warnMat = new THREE.MeshBasicMaterial({ toneMapped: false, fog: false });
  warnMat.color.setRGB(2.4, 0.16, 0.1);
  const warnGeos = TOWERS.map((t) => {
    const g = new THREE.SphereGeometry(0.34, 8, 6);
    g.translate(t.x, t.y + 3.6, t.z);
    return g;
  });
  const warn = new THREE.Mesh(mergeGeometries(warnGeos, false), warnMat);
  warn.name = 'mast_warn';
  group.add(warn);
  warnGeos.forEach((g) => g.dispose());

  // -- dugouts + tunnel on the TV stand (−Z) --------------------------------
  buildDugouts(group, matDark, matRail);
  buildTunnel(group, matWallPlain);

  // -- surrounding ground ---------------------------------------------------
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 1 })
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.12;
  group.add(surround);

  scene.add(group);

  let t = 0;
  let spillAcc = 0;
  return {
    group,
    screenViews,
    update(dt) {
      t += dt;
      // LED panels breathe very slightly out of phase — reads as live boards
      // without any texture crawl that could clip a brand mid-word.
      for (let i = 0; i < adMats.length; i++) {
        const k = 1.6 + 0.11 * Math.sin(t * 0.8 + i * 1.9);
        adMats[i].color.setRGB(k, k, k);
      }
      // The turf carpet in front of each board tracks its panel's brightness.
      spillAcc += dt;
      if (spillAcc > 0.07) { ads.updateSpill(t); spillAcc = 0; }
      if (ribbonTex) ribbonTex.offset.x = (t * 0.035) % 1;
      warnMat.color.setRGB(2.4 * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 2.2))), 0.16, 0.1);
    },
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Directional emission for LED surfaces on an unlit MeshBasicMaterial.
 *
 * An LED panel is a lambertian-ish emitter with a limited viewing cone: its
 * apparent luminance drops off hard as you move off its normal, and at grazing
 * incidence it goes black. A plain MeshBasicMaterial emits the same value at
 * every angle, which is why a 118 m ribbon seen almost exactly end-on stayed
 * fully lit and painted a bright smear of text across the top of the frame.
 *
 * Cheap: two varyings and one pow() in the fragment shader, applied before fog
 * so the falloff happens in radiance and the fog still mixes correctly.
 */
function ledDirectional(mat, power, floorAmt) {
  const P = power.toFixed(2), F = floorAmt.toFixed(4);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLedN;\nvarying vec3 vLedV;')
      .replace('#include <fog_vertex>',
        '#include <fog_vertex>\n\tvLedN = normalize(mat3(modelMatrix) * normal);'
        + '\n\tvLedV = cameraPosition - (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLedN;\nvarying vec3 vLedV;')
      .replace('#include <opaque_fragment>',
        '#include <opaque_fragment>\n\tfloat ledNdV = clamp(dot(normalize(vLedN), normalize(vLedV)), 0.0, 1.0);'
        + `\n\tgl_FragColor.rgb *= mix(${F}, 1.0, pow(ledNdV, ${P}));`);
  };
  mat.customProgramCacheKey = () => 'led_' + P + '_' + F;
  return mat;
}

function setColor(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

function atlasUV(geo, cx, cy, nx, ny) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    uv.setXY(i, (cx + 0.015 + u * 0.97) / nx, (cy + 0.015 + v * 0.97) / ny);
  }
  uv.needsUpdate = true;
}

function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
}

/**
 * Bake an AO / bounce gradient into the roof soffit's vertex colours: bright and
 * slightly warm at the leading edge where the pitch bounce hits it, falling into
 * shadow toward the back, with a soft coffer modulation at the truss pitch so
 * the ribs read as structure sitting IN the ceiling rather than bars painted on.
 */
function bakeSoffitAO(geo) {
  const p = geo.attributes.position;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const qx = Math.abs(x) / ROOF.x.front, qz = Math.abs(z) / ROOF.z.front;
    const q = Math.max(qx, qz);
    const f = Math.min(1, Math.max(0, (q - 0.95) / 0.55));
    let k = 1.72 - 1.02 * f;
    const along = qx > qz ? z : x;
    k *= 0.88 + 0.12 * Math.cos((along * Math.PI * 2) / 5.95);
    if (y < 20) k *= 0.9;                  // upper-tier soffits sit deeper in shade
    arr[i * 3] = k * 1.05;
    arr[i * 3 + 1] = k * 0.99;
    arr[i * 3 + 2] = k * 0.90;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/**
 * Perimeter concrete: bake the floodlight wash into vertex colours. The rig
 * skims the turf, so the strip between the ad boards and the first crowd row is
 * brightest at its foot and falls off with height; horizontal surfaces (deck,
 * step treads) catch a lift; anything whose normal turns away from the pitch
 * drops into shadow. Reads as modelled concrete rather than one grey value.
 */
function bakeWallAO(geo) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(x, z) || 1;
    // +1 when the face looks at the pitch, −1 when it looks away.
    const inward = -(n.getX(i) * x + n.getZ(i) * z) / r;
    const up = Math.max(0, n.getY(i));
    let k = 1.30 - 0.46 * Math.min(1, Math.max(0, (y - 0.15) / 2.4));
    k *= 0.44 + 0.56 * Math.min(1, Math.max(0, inward + 0.22));
    k *= 1 + 0.34 * up;
    arr[i * 3] = k * 1.02; arr[i * 3 + 1] = k; arr[i * 3 + 2] = k * 0.98;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

/** Corner blocks: vertical gradient so the mass has a base and a top. */
function bakeCornerAO(geo) {
  const p = geo.attributes.position;
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    const k = 0.62 + 0.55 * Math.min(1, Math.max(0, 1 - y / 30));
    arr[i * 3] = k * 1.02; arr[i * 3 + 1] = k; arr[i * 3 + 2] = k * 0.97;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

// Parapet wall, coping, handrail and the walkway floor behind the LED boards.
//
// The rail is the single thing that broke every close framing in the last pass:
// a CylinderGeometry starts along +Y, rotateZ(PI/2) puts it along +X, so it is
// the X-SIDE runs (which travel along Z) that need the corrective rotateY —
// the test used to be inverted, which threw a 114 m pipe straight down the
// halfway line and a 78 m pipe through both goalmouths.
function buildPerimeter(B, box) {
  const WH = 1.06;                 // wall height
  const RAIL_Y = 1.52;
  const R = 0.024;                 // 48 mm tube
  const SIDES = [
    { axis: 'x', sign: -1, len: 78 }, { axis: 'x', sign: 1, len: 78 },
    { axis: 'z', sign: -1, len: 114 }, { axis: 'z', sign: 1, len: 114 },
  ];
  for (const s of SIDES) {
    const d = s.sign * WALL_DIST[s.axis];
    const along = s.len;
    const X = s.axis === 'x';

    // Wall body + pale coping.
    if (X) box('wall', 0.32, WH, along, d, WH / 2, 0);
    else box('wall', along, WH, 0.32, 0, WH / 2, d);
    if (X) box('cap', 0.46, 0.12, along, d, WH + 0.06, 0);
    else box('cap', along, 0.12, 0.46, 0, WH + 0.06, d);

    // Walkway slab from the wall back to the stand frontage.
    const front = TIERS[0].baseDist[s.axis] - 0.55;
    const wallOuter = WALL_DIST[s.axis] + 0.16;
    const wDepth = Math.max(0.3, front - wallOuter);
    const wc = s.sign * (wallOuter + wDepth / 2);
    if (X) box('wall', wDepth, 0.1, along, wc, 0.05, 0);
    else box('wall', along, 0.1, wDepth, 0, 0.05, wc);

    // Pilasters.
    const nP = Math.round(along / 6);
    for (let i = 0; i <= nP; i++) {
      const a = -along / 2 + (i * along) / nP;
      const px = X ? d : a, pz = X ? a : d;
      box('wall', X ? 0.5 : 0.42, WH + 0.16, X ? 0.42 : 0.5, px, (WH + 0.16) / 2, pz);
    }

    // Stanchions every 3 m, each capped with a joint collar at rail height.
    const nR = Math.round(along / 3);
    const step = along / nR;
    for (let i = 0; i <= nR; i++) {
      const a = -along / 2 + i * step;
      const px = X ? d : a, pz = X ? a : d;
      const g = new THREE.CylinderGeometry(0.032, 0.032, RAIL_Y - WH, 8);
      g.translate(px, (RAIL_Y + WH) / 2, pz);
      B.rail.push(g);
      // collar: a visible joint where each rail run lands on its post
      const col = new THREE.CylinderGeometry(R * 1.45, R * 1.45, 0.11, 10);
      col.rotateZ(Math.PI / 2);
      if (X) col.rotateY(Math.PI / 2);
      col.translate(px, RAIL_Y, pz);
      B.pad.push(col);
    }

    // Handrail: ~6 m runs between collars rather than one continuous pipe.
    const runs = Math.max(1, Math.round(nR / 2));
    const runLen = along / runs;
    for (let i = 0; i < runs; i++) {
      const a = -along / 2 + (i + 0.5) * runLen;
      const px = X ? d : a, pz = X ? a : d;
      const rail = new THREE.CylinderGeometry(R, R, runLen - 0.14, 12);
      rail.rotateZ(Math.PI / 2);
      if (X) rail.rotateY(Math.PI / 2);          // <-- the fix: X-side runs go along Z
      rail.translate(px, RAIL_Y, pz);
      B.rail.push(rail);

      // Goal-end runs carry a padded sleeve; touchline runs get a club-vinyl
      // wrap every other run, so the rail is dressed rather than a bare pipe.
      if (X || i % 2 === 0) {
        const sleeveLen = X ? runLen - 0.3 : runLen * 0.55;
        const sl = new THREE.CylinderGeometry(R * 2.2, R * 2.2, sleeveLen, 10);
        sl.rotateZ(Math.PI / 2);
        if (X) sl.rotateY(Math.PI / 2);
        sl.translate(px, RAIL_Y, pz);
        B.pad.push(sl);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LED perimeter boards: physical units with a bezel, hood, plinth, ground
// shadow and mitred corner returns, plus a coloured light-spill carpet on the
// turf in front of every panel.
// ---------------------------------------------------------------------------
function buildAdBoards(group, B, box, adMats) {
  const X = AD_DIST.x, Z = AD_DIST.z, c = AD_CUT;
  // Closed perimeter polygon with 45° corner returns. Traversal order is chosen
  // so the inward normal is n = (-dz, dx).
  const P = [
    [-X + c, -Z], [X - c, -Z], [X, -Z + c], [X, Z - c],
    [X - c, Z], [-X + c, Z], [-X, Z - c], [-X, -Z + c],
  ];

  const adGeos = AD_BRANDS.map(() => []);
  const shadowGeos = [];
  const spillPos = [];
  const spillIdx = [];
  const spillCol = [];
  const spillPanels = [];
  let vBase = 0;
  let adIdx = 0;

  const adY = (AD_H / 2) * Math.cos(AD_TILT) + 0.05;
  // Light spill from the panels onto the turf. Kept short and desaturated: the
  // high establishing camera looks almost straight down on this strip, and a
  // long saturated carpet reads there as a painted rainbow ramp rather than as
  // coloured light. At pitch level it still tints the grass under each board.
  const SPILL_D = 1.85;            // how far the carpet reaches onto the turf
  const ROWS = [0, 0.26, 1.0];
  const FALL = [1.0, 0.34, 0.0];

  for (let k = 0; k < P.length; k++) {
    const a0 = P[k], a1 = P[(k + 1) % P.length];
    const dx = a1[0] - a0[0], dz = a1[1] - a0[1];
    const L = Math.hypot(dx, dz);
    const ux = dx / L, uz = dz / L;
    const nx = -uz, nz = ux;                  // inward (pitch-facing) normal
    const yaw = Math.atan2(nx, nz);
    const n = Math.max(1, Math.round(L / AD_SEG));
    const sl = L / n;

    for (let i = 0; i < n; i++) {
      const tmid = (i + 0.5) * sl;
      const cx = a0[0] + ux * tmid, cz = a0[1] + uz * tmid;
      const brand = adIdx % AD_BRANDS.length;

      // Emissive face, lifted a hair proud of the carcass.
      const g = new THREE.PlaneGeometry(sl - 0.04, AD_H);
      g.rotateX(AD_TILT);
      g.rotateY(yaw);
      g.translate(cx + nx * 0.012, adY, cz + nz * 0.012);
      adGeos[brand].push(g);

      // Carcass: extruded body behind the face, top hood, base plinth.
      const body = new THREE.BoxGeometry(sl, AD_H + 0.1, AD_DEPTH);
      body.rotateX(AD_TILT);
      body.rotateY(yaw);
      body.translate(cx - nx * (AD_DEPTH / 2), adY, cz - nz * (AD_DEPTH / 2));
      B.adcase.push(body);

      const hood = new THREE.BoxGeometry(sl, 0.07, 0.26);
      hood.rotateY(yaw);
      hood.translate(cx + nx * 0.06, adY + AD_H / 2 + 0.09, cz + nz * 0.06);
      B.adcase.push(hood);

      const plinth = new THREE.BoxGeometry(sl, 0.16, AD_DEPTH + 0.18);
      plinth.rotateY(yaw);
      plinth.translate(cx - nx * (AD_DEPTH / 2 - 0.05), 0.08, cz - nz * (AD_DEPTH / 2 - 0.05));
      B.adcase.push(plinth);

      // Contact shadow strip on the grass.
      const sh = new THREE.PlaneGeometry(sl, 0.16);
      sh.rotateX(-Math.PI / 2);
      sh.rotateY(yaw);
      sh.translate(cx + nx * 0.08, 0.022, cz + nz * 0.08);
      shadowGeos.push(sh);

      // Spill carpet: 3 rows x 2 cols, vertex-coloured, additive.
      const hw = sl / 2;
      for (let r = 0; r < 3; r++) {
        const off = ROWS[r] * SPILL_D;
        for (let s = -1; s <= 1; s += 2) {
          spillPos.push(cx + ux * hw * s + nx * off, 0.03, cz + uz * hw * s + nz * off);
          spillCol.push(0, 0, 0);
        }
      }
      for (let r = 0; r < 2; r++) {
        const b0 = vBase + r * 2;
        spillIdx.push(b0, b0 + 1, b0 + 2, b0 + 1, b0 + 3, b0 + 2);
      }
      spillPanels.push({ brand, v: vBase });
      vBase += 6;
      adIdx++;
    }
  }

  for (let i = 0; i < adGeos.length; i++) {
    if (!adGeos[i].length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(adGeos[i], false), adMats[i]);
    mesh.name = 'adboard_' + i;
    mesh.renderOrder = 1;
    group.add(mesh);
    adGeos[i].forEach((g) => g.dispose());
  }

  const shMat = new THREE.MeshBasicMaterial({
    map: makeContactShadowTexture(), transparent: true, depthWrite: false,
    color: 0x000000, opacity: 0.85,
  });
  const shMesh = new THREE.Mesh(mergeGeometries(shadowGeos, false), shMat);
  shMesh.name = 'adboard_shadow';
  shMesh.renderOrder = 1;
  group.add(shMesh);
  shadowGeos.forEach((g) => g.dispose());

  // Spill carpet mesh.
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.Float32BufferAttribute(spillPos, 3));
  const colAttr = new THREE.Float32BufferAttribute(spillCol, 3);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  sg.setAttribute('color', colAttr);
  sg.setIndex(spillIdx);
  const spillMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
    blending: THREE.AdditiveBlending, fog: true, side: THREE.DoubleSide,
  });
  const spill = new THREE.Mesh(sg, spillMat);
  spill.name = 'adboard_spill';
  spill.renderOrder = 2;
  spill.frustumCulled = false;
  group.add(spill);

  // Per-panel base colour from the brand hue.
  const tmp = new THREE.Color();
  const base = spillPanels.map((p) => {
    tmp.setHSL(AD_HUES[p.brand] / 360, 0.46, 0.55);
    return [tmp.r, tmp.g, tmp.b];
  });

  function updateSpill(time) {
    const arr = colAttr.array;
    for (let i = 0; i < spillPanels.length; i++) {
      const p = spillPanels[i];
      const b = base[i];
      const k = 0.125 * (1 + 0.12 * Math.sin(time * 0.8 + p.brand * 1.9));
      for (let r = 0; r < 3; r++) {
        const f = FALL[r] * k;
        for (let s = 0; s < 2; s++) {
          const v = (p.v + r * 2 + s) * 3;
          arr[v] = b[0] * f; arr[v + 1] = b[1] * f; arr[v + 2] = b[2] * f;
        }
      }
    }
    colAttr.needsUpdate = true;
  }
  updateSpill(0);

  return { updateSpill };
}

// ---------------------------------------------------------------------------
// Pitchside population: stewards with real silhouettes, photographers, ball
// boys, kit bags. Clustered at the vomitories with long gaps between, hi-vis
// desaturated to a floodlit sodium-lime so they sit UNDER the LED boards in the
// luminance hierarchy instead of being the brightest thing in the mid-ground.
// ---------------------------------------------------------------------------
function buildStewards(group, rng, low) {
  const WALK_Z = 38.15, WALK_X = 56.4;
  const spots = [];
  const push = (x, z, yaw) => spots.push({ x, z, yaw });

  // Touchline runs: clusters of 2-3 at each vomitory, 20 m gaps elsewhere.
  const clustersZ = low ? [-38, -6, 26] : [-46, -30, -8, 12, 34, 47];
  for (const sz of [-1, 1]) {
    for (const cxx of clustersZ) {
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const x = cxx + (i - (n - 1) / 2) * (1.6 + rng() * 1.4) + (rng() - 0.5) * 1.2;
        // a third of them turn to watch the pitch, the rest face the crowd
        const facePitch = rng() < 0.34;
        const base = sz > 0 ? 0 : Math.PI;      // facing the crowd (outward)
        push(x, sz * WALK_Z, (facePitch ? base + Math.PI : base) + (rng() - 0.5) * 0.5);
      }
    }
  }
  // Behind the goals: two small groups per end, clear of the goal camera.
  for (const sx of [-1, 1]) {
    for (const cz of [-22, 21]) {
      const n = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const z = cz + i * 1.8 + (rng() - 0.5) * 1.4;
        const base = sx > 0 ? -Math.PI / 2 : Math.PI / 2;
        const facePitch = rng() < 0.34;
        push(sx * WALK_X, z, (facePitch ? base + Math.PI : base) + (rng() - 0.5) * 0.5);
      }
    }
  }

  const n = spots.length;

  // --- steward figure: dark trousers + sleeves, tabard on the torso only ----
  const darkParts = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.CapsuleGeometry(0.085, 0.62, 3, 6);
    leg.scale(1, 1, 0.9);
    leg.translate(s * 0.095, 0.44, 0);
    darkParts.push(leg);
    const arm = new THREE.CapsuleGeometry(0.055, 0.44, 3, 6);
    arm.rotateZ(s * 0.10);
    arm.translate(s * 0.235, 1.16, 0.01);
    darkParts.push(arm);
    const shoe = new THREE.BoxGeometry(0.13, 0.07, 0.24);
    shoe.translate(s * 0.095, 0.035, 0.02);
    darkParts.push(shoe);
  }
  const hips = new THREE.BoxGeometry(0.3, 0.16, 0.19);
  hips.translate(0, 0.86, 0);
  darkParts.push(hips);
  const neck = new THREE.CylinderGeometry(0.055, 0.06, 0.08, 6);
  neck.translate(0, 1.50, 0);
  darkParts.push(neck);
  const darkGeo = mergeGeometries(darkParts, false);
  darkParts.forEach((g) => g.dispose());
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.92 });

  // Tabard: shorter than before (torso only) → ~70% less yellow area, and a
  // muted lime-grey rather than pure chroma.
  const tabParts = [];
  const chest = new THREE.CapsuleGeometry(0.165, 0.30, 4, 8);
  chest.scale(1.16, 1, 0.66);
  chest.translate(0, 1.19, 0);
  tabParts.push(chest);
  const shoulder = new THREE.BoxGeometry(0.42, 0.09, 0.2);
  shoulder.translate(0, 1.38, 0);
  tabParts.push(shoulder);
  const tabGeo = mergeGeometries(tabParts, false);
  tabParts.forEach((g) => g.dispose());
  const tabMat = new THREE.MeshStandardMaterial({
    color: 0x565c33, roughness: 0.86, metalness: 0.0,
  });

  const headGeo = new THREE.SphereGeometry(0.104, 8, 6);
  headGeo.scale(1, 1.1, 0.96);
  headGeo.translate(0, 1.60, 0);
  const headMat = new THREE.MeshStandardMaterial({ color: 0x7d6249, roughness: 0.85 });

  // Baseball cap: at pitchside range a bare skin-tone sphere is what makes a
  // small figure read as a doll, so most of them get a dark crown + peak. The
  // silhouette then breaks at the head instead of ending in a pale ball.
  const capParts = [];
  const crown = new THREE.SphereGeometry(0.112, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.52);
  crown.scale(1, 0.82, 1);
  crown.translate(0, 1.635, 0);
  capParts.push(crown);
  const peak = new THREE.BoxGeometry(0.19, 0.022, 0.12);
  peak.rotateX(-0.16);
  peak.translate(0, 1.645, 0.115);
  capParts.push(peak);
  const capGeo = mergeGeometries(capParts, false);
  capParts.forEach((g) => g.dispose());

  const capIdx = [];
  for (let i = 0; i < n; i++) if (rng() < 0.62) capIdx.push(i);

  const parts = [
    new THREE.InstancedMesh(darkGeo, darkMat, n),
    new THREE.InstancedMesh(tabGeo, tabMat, n),
    new THREE.InstancedMesh(headGeo, headMat, n),
  ];
  const caps = new THREE.InstancedMesh(capGeo, darkMat, capIdx.length);
  const m = new THREE.Matrix4();
  const r = new THREE.Matrix4();
  const mats = [];
  for (let i = 0; i < n; i++) {
    const s = spots[i];
    const sc = 0.92 + rng() * 0.16;
    m.makeTranslation(s.x, 0, s.z);
    m.multiply(r.makeRotationY(s.yaw));
    // A little weight shift + slouch so the row is not a line of identical
    // soldiers: lean sideways, and a few of them stand off their front foot.
    m.multiply(r.makeRotationZ((rng() - 0.5) * 0.15));
    m.multiply(r.makeRotationX((rng() - 0.5) * 0.1));
    m.multiply(r.makeScale(sc, sc * (0.96 + rng() * 0.09), sc));
    for (const p of parts) p.setMatrixAt(i, m);
    mats.push(m.clone());
  }
  for (let c = 0; c < capIdx.length; c++) caps.setMatrixAt(c, mats[capIdx[c]]);
  for (const p of [...parts, caps]) {
    p.instanceMatrix.needsUpdate = true;
    p.castShadow = false;
    p.receiveShadow = false;
    p.name = 'steward';
    group.add(p);
  }

  // --- photographers kneeling behind the goal-end boards -------------------
  const photo = [];
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 7; i++) {
      const z = -16 + (i * 32) / 6 + (rng() - 0.5) * 1.6;
      if (Math.abs(z) < 4.4) continue;          // keep the goalmouth clear
      photo.push({ x: sx * (AD_DIST.x + 0.75), z, yaw: sx > 0 ? -Math.PI / 2 : Math.PI / 2 });
    }
  }
  if (photo.length) {
    const pParts = [];
    const tor = new THREE.CapsuleGeometry(0.19, 0.32, 4, 8);
    tor.scale(1, 1, 0.8);
    tor.rotateX(0.35);
    tor.translate(0, 0.74, -0.05);
    pParts.push(tor);
    const thigh = new THREE.BoxGeometry(0.34, 0.2, 0.5);
    thigh.translate(0, 0.36, -0.1);
    pParts.push(thigh);
    const shin = new THREE.BoxGeometry(0.32, 0.44, 0.2);
    shin.translate(0, 0.22, 0.18);
    pParts.push(shin);
    const hd = new THREE.SphereGeometry(0.105, 8, 6);
    hd.translate(0, 1.06, 0.02);
    pParts.push(hd);
    const pg = mergeGeometries(pParts, false);
    pParts.forEach((g) => g.dispose());
    const pMat = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.9 });
    const pm = new THREE.InstancedMesh(pg, pMat, photo.length);

    const lensParts = [];
    const barrel = new THREE.CylinderGeometry(0.075, 0.095, 0.52, 8);
    barrel.rotateX(Math.PI / 2);
    barrel.translate(0, 0.99, 0.34);
    lensParts.push(barrel);
    const body = new THREE.BoxGeometry(0.16, 0.13, 0.13);
    body.translate(0, 0.99, 0.06);
    lensParts.push(body);
    const mono = new THREE.CylinderGeometry(0.022, 0.022, 0.95, 5);
    mono.rotateX(-0.12);
    mono.translate(0, 0.48, 0.5);
    lensParts.push(mono);
    const lg = mergeGeometries(lensParts, false);
    lensParts.forEach((g) => g.dispose());
    const lMat = new THREE.MeshStandardMaterial({ color: 0x0f1115, roughness: 0.55, metalness: 0.2 });
    const lm = new THREE.InstancedMesh(lg, lMat, photo.length);

    for (let i = 0; i < photo.length; i++) {
      const s = photo[i];
      m.makeTranslation(s.x, 0, s.z);
      m.multiply(r.makeRotationY(s.yaw + (rng() - 0.5) * 0.35));
      pm.setMatrixAt(i, m);
      lm.setMatrixAt(i, m);
    }
    pm.instanceMatrix.needsUpdate = true;
    lm.instanceMatrix.needsUpdate = true;
    for (const p of [pm, lm]) { p.castShadow = false; p.name = 'photographer'; group.add(p); }
  }

  // --- ball boys on stools + kit bags along the touchline ------------------
  const props = [];
  const stoolMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.9 });
  for (const sz of [-1, 1]) {
    for (const x of [-38, -14, 14, 38]) {
      const g = new THREE.Group();
      const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.46, 8), stoolMat);
      stool.position.y = 0.23;
      g.add(stool);
      const seated = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.17, 0.3, 4, 8),
        new THREE.MeshStandardMaterial({ color: 0x2f3a2a, roughness: 0.9 })
      );
      seated.position.set(0, 0.75, 0);
      seated.scale.set(1, 1, 0.75);
      g.add(seated);
      const hd = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0x7d6249, roughness: 0.85 })
      );
      hd.position.set(0, 1.06, 0);
      g.add(hd);
      const legs = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.42), stoolMat);
      legs.position.set(0, 0.4, 0.22);
      g.add(legs);
      g.position.set(x + (rng() - 0.5) * 2, 0, sz * (WALK_Z - 0.35));
      g.rotation.y = sz > 0 ? Math.PI : 0;
      props.push(g);
    }
  }
  // physio bags / water crates near the dugouts
  for (const x of [-9.5, 9.5, -16, 16]) {
    const g = new THREE.Group();
    const bag = new THREE.Mesh(
      new THREE.BoxGeometry(0.75, 0.34, 0.36),
      new THREE.MeshStandardMaterial({ color: 0x191c22, roughness: 0.9 })
    );
    bag.position.y = 0.17;
    g.add(bag);
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(0.78, 0.06, 0.38),
      new THREE.MeshStandardMaterial({ color: 0x2c3140, roughness: 0.8 })
    );
    lid.position.y = 0.36;
    g.add(lid);
    g.position.set(x, 0, -(WALK_Z - 0.5));
    g.rotation.y = (rng() - 0.5) * 0.5;
    props.push(g);
  }
  for (const p of props) {
    p.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
    group.add(p);
  }
}

function buildPylonMast(group, pos, matSteel, matFixDark, matRail, B) {
  const g = new THREE.Group();
  const legSpread = 3.2;
  const h = pos.y;

  // Four battered legs + cross bracing: a lattice mast reads as scale.
  for (const dx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      const top = new THREE.Vector3(dx * 1.1, h, dz * 1.1);
      const bot = new THREE.Vector3(dx * legSpread, 0, dz * legSpread);
      const dir = new THREE.Vector3().subVectors(top, bot);
      const len = dir.length();
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, len, 8), matSteel);
      leg.position.copy(bot).addScaledVector(dir, 0.5);
      leg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      g.add(leg);
      // Concrete base pad so the mast lands on the ground instead of vanishing.
      const pad = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.3, 1.5), matFixDark);
      pad.position.set(dx * legSpread, 0.55, dz * legSpread);
      g.add(pad);
    }
  }
  const braceGeos = [];
  for (let i = 1; i < 9; i++) {
    const f = i / 9;
    const y = f * h;
    const s = legSpread + (1.1 - legSpread) * f;
    for (const [ax, az, bx, bz] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) {
      const a = new THREE.Vector3(ax * s, y, az * s);
      const b = new THREE.Vector3(bx * s, y, bz * s);
      const d = new THREE.Vector3().subVectors(b, a);
      const bg = new THREE.CylinderGeometry(0.11, 0.11, d.length(), 5);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
      bg.applyQuaternion(q);
      bg.translate(a.x + d.x / 2, y, a.z + d.z / 2);
      braceGeos.push(bg);
      // diagonal web between the ring braces
      if (i < 8) {
        const y2 = ((i + 1) / 9) * h;
        const s2 = legSpread + (1.1 - legSpread) * ((i + 1) / 9);
        const a2 = new THREE.Vector3(ax * s, y, az * s);
        const b2 = new THREE.Vector3(bx * s2, y2, bz * s2);
        const d2 = new THREE.Vector3().subVectors(b2, a2);
        const dg = new THREE.CylinderGeometry(0.075, 0.075, d2.length(), 4);
        const q2 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d2.clone().normalize());
        dg.applyQuaternion(q2);
        dg.translate(a2.x + d2.x / 2, (y + y2) / 2, a2.z + d2.z / 2);
        braceGeos.push(dg);
      }
    }
  }
  const braces = new THREE.Mesh(mergeGeometries(braceGeos, false), matSteel);
  g.add(braces);
  braceGeos.forEach((x) => x.dispose());

  // Service ladder up one leg.
  const rungs = [];
  for (let i = 0; i < Math.floor(h / 0.5); i++) {
    const y = 1.2 + i * 0.5;
    if (y > h - 1) break;
    const f = y / h;
    const s = legSpread + (1.1 - legSpread) * f;
    const rg = new THREE.BoxGeometry(0.5, 0.05, 0.05);
    rg.translate(-s + 0.25, y, -s - 0.35);
    rungs.push(rg);
  }
  for (const side of [-1, 1]) {
    const rail = [];
    for (let i = 0; i < 9; i++) {
      const y0 = 1.2 + (i * (h - 2.2)) / 9;
      const y1 = 1.2 + ((i + 1) * (h - 2.2)) / 9;
      const f0 = y0 / h, f1 = y1 / h;
      const s0 = legSpread + (1.1 - legSpread) * f0;
      const s1 = legSpread + (1.1 - legSpread) * f1;
      const a = new THREE.Vector3(-s0 + 0.25 + side * 0.24, y0, -s0 - 0.35);
      const b = new THREE.Vector3(-s1 + 0.25 + side * 0.24, y1, -s1 - 0.35);
      const d = new THREE.Vector3().subVectors(b, a);
      const cg = new THREE.CylinderGeometry(0.035, 0.035, d.length(), 4);
      cg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 1, 0), d.clone().normalize()));
      cg.translate(a.x + d.x / 2, (y0 + y1) / 2, a.z + d.z / 2);
      rail.push(cg);
    }
    rungs.push(...rail);
  }
  const ladder = new THREE.Mesh(mergeGeometries(rungs, false), matRail);
  g.add(ladder);
  rungs.forEach((x) => x.dispose());

  g.position.set(pos.x, 0, pos.z);
  g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  group.add(g);
}

function buildDugouts(group, matDark, matRail) {
  // Recessed into the perimeter, between the parapet and the stand frontage —
  // never out on the grass in front of the LED boards.
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x2c343d, roughness: 0.18, metalness: 0.1,
    transparent: true, opacity: 0.5, side: THREE.DoubleSide,
  });
  const seatMat = new THREE.MeshStandardMaterial({
    color: 0x1d222a, roughness: 0.8, emissive: 0x0c0f14,
  });
  const backMat = new THREE.MeshStandardMaterial({
    color: 0x2e343d, roughness: 0.85, emissive: 0x171b22,
  });
  const stripMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  stripMat.color.setRGB(0.82, 0.71, 0.50);
  // Warm wash on the dugout back wall so the bench is a lit recess, not a slab
  // of black with a fluorescent tube floating in front of it.
  const washMat = new THREE.MeshBasicMaterial({
    map: makeCanvasTexture(64, 32, (c, w2, h2) => {
      const g2 = c.createLinearGradient(0, 0, 0, h2);
      g2.addColorStop(0, 'rgba(122,100,70,0.95)');
      g2.addColorStop(0.6, 'rgba(58,50,40,0.8)');
      g2.addColorStop(1, 'rgba(16,17,20,1)');
      c.fillStyle = '#0a0b0e';
      c.fillRect(0, 0, w2, h2);
      c.fillStyle = g2;
      c.fillRect(0, 0, w2, h2);
    }, { wrap: THREE.ClampToEdgeWrapping }),
    toneMapped: false,
  });
  const CZ = -39.55;                    // between the parapet and the terrace steps
  const seatGeos = [];
  for (let i = 0; i < 9; i++) {
    const g = new THREE.BoxGeometry(0.62, 0.52, 0.4);
    g.translate(-3.6 + i * 0.9, 0.78, -0.15);
    seatGeos.push(g);
  }
  const seatsGeo = mergeGeometries(seatGeos, false);
  seatGeos.forEach((g) => g.dispose());
  for (const sx of [-1, 1]) {
    const d = new THREE.Group();
    const back = new THREE.Mesh(new THREE.BoxGeometry(8.4, 2.1, 0.16), backMat);
    back.position.set(0, 1.05, -0.45);
    d.add(back);
    const wash = new THREE.Mesh(new THREE.PlaneGeometry(8.0, 1.9), washMat);
    wash.position.set(0, 1.1, -0.36);
    d.add(wash);
    d.add(new THREE.Mesh(seatsGeo, seatMat));
    // Strip light under the canopy: without it the bench is a black slot at
    // night and the dugout disappears into the perimeter.
    const strip = new THREE.Mesh(new THREE.BoxGeometry(7.6, 0.08, 0.12), stripMat);
    strip.position.set(0, 2.05, 0.16);
    d.add(strip);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(8.8, 0.14, 1.1), glass);
    roof.position.set(0, 2.25, 0);
    d.add(roof);
    const lip = new THREE.Mesh(new THREE.BoxGeometry(8.9, 0.1, 0.12), matRail);
    lip.position.set(0, 2.2, 0.5);
    d.add(lip);
    for (const s of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.1, 1.05), glass);
      side.position.set(s * 4.3, 1.1, 0);
      d.add(side);
    }
    d.position.set(sx * 12.5, 0, CZ);
    d.traverse((o) => { o.castShadow = false; });
    group.add(d);
  }
}

function buildTunnel(group, matWall) {
  const g = new THREE.Group();
  // The mouth stands just proud of the terrace steps so the opening reads as a
  // hole cut through the stand front rather than a panel stuck behind them.
  const zFront = -(TIERS[0].baseDist.z - 1.4);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(7.2, 3.4, 1.6), matWall);
  frame.position.set(0, 1.7, zFront - 0.8);
  g.add(frame);
  // Interior: a dim warm gradient receding into the tunnel, not a black hole.
  const innerTex = makeCanvasTexture(64, 64, (c, w2, h2) => {
    c.fillStyle = '#05070a';
    c.fillRect(0, 0, w2, h2);
    const gg = c.createRadialGradient(w2 / 2, h2 * 0.55, 1, w2 / 2, h2 * 0.55, w2 * 0.7);
    gg.addColorStop(0, 'rgba(226,186,126,1)');
    gg.addColorStop(0.35, 'rgba(140,108,68,0.9)');
    gg.addColorStop(0.75, 'rgba(46,36,26,0.85)');
    gg.addColorStop(1, 'rgba(6,7,10,1)');
    c.fillStyle = gg;
    c.fillRect(0, 0, w2, h2);
    // ceiling strip lights receding down the tunnel
    c.fillStyle = 'rgba(255,236,200,0.55)';
    c.fillRect(w2 * 0.42, h2 * 0.10, w2 * 0.16, h2 * 0.05);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fillRect(0, h2 * 0.82, w2, h2 * 0.18);
  }, { wrap: THREE.ClampToEdgeWrapping });
  const inner = new THREE.Mesh(
    new THREE.PlaneGeometry(5.2, 2.8),
    new THREE.MeshBasicMaterial({ map: innerTex, toneMapped: false })
  );
  inner.position.set(0, 1.4, zFront + 0.02);
  g.add(inner);
  // Reveal jambs so the mouth has depth.
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.0, 1.2), matWall);
    jamb.position.set(s * 2.75, 1.5, zFront - 0.55);
    g.add(jamb);
  }
  const rimMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  rimMat.color.setRGB(1.25, 1.02, 0.6);
  const rim = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.12, 0.1), rimMat);
  rim.position.set(0, 2.92, zFront + 0.04);
  g.add(rim);
  g.traverse((o) => { o.castShadow = false; });
  group.add(g);
}

// ---------------------------------------------------------------------------
// Textures
// ---------------------------------------------------------------------------

function makeConcreteTexture(rng, size) {
  return makeCanvasTexture(size, size, (c, w, h) => {
    c.fillStyle = '#8a8d93';
    c.fillRect(0, 0, w, h);
    // Broad blotches then fine grain: keeps large surfaces from banding.
    for (let i = 0; i < 220; i++) {
      const r = 20 + rng() * 90;
      const g = 120 + Math.floor(rng() * 40);
      c.fillStyle = `rgba(${g},${g + 2},${g + 6},${0.05 + rng() * 0.09})`;
      c.beginPath();
      c.arc(rng() * w, rng() * h, r, 0, Math.PI * 2);
      c.fill();
    }
    const img = c.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng() - 0.5) * 26;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    c.putImageData(img, 0, 0);
  });
}

/**
 * 4x2 atlas of lit interiors seen through glazing. Cells 0-5: hospitality boxes
 * with a warm ceiling wash, a rear wall, furniture and silhouetted figures.
 * Cell 6: a concourse vomitory glow. Cell 7: a dim/half-lit box.
 */
function makeInteriorTexture(rng, size) {
  return makeCanvasTexture(size, Math.round(size / 2), (c, W, H) => {
    const cw = W / 4, chh = H / 2;
    for (let cell = 0; cell < 8; cell++) {
      const ox = (cell % 4) * cw, oy = Math.floor(cell / 4) * chh;
      c.save();
      c.beginPath();
      c.rect(ox, oy, cw, chh);
      c.clip();

      const concourse = cell === 6;
      const dim = cell === 7;
      const warm = concourse ? [255, 226, 176] : [255, 208, 150];
      const top = dim ? 0.22 : concourse ? 1.0 : 0.62 + rng() * 0.3;

      const g = c.createLinearGradient(ox, oy, ox, oy + chh);
      g.addColorStop(0, `rgba(${warm[0]},${warm[1]},${warm[2]},${top})`);
      g.addColorStop(0.55, `rgba(${warm[0] * 0.72 | 0},${warm[1] * 0.62 | 0},${warm[2] * 0.48 | 0},${top * 0.75})`);
      g.addColorStop(1, `rgba(${warm[0] * 0.35 | 0},${warm[1] * 0.28 | 0},${warm[2] * 0.2 | 0},${top * 0.5})`);
      c.fillStyle = '#000';
      c.fillRect(ox, oy, cw, chh);
      c.fillStyle = g;
      c.fillRect(ox, oy, cw, chh);

      // ceiling line + rear wall band
      c.fillStyle = 'rgba(0,0,0,0.42)';
      c.fillRect(ox, oy, cw, chh * 0.13);
      if (!concourse) {
        c.fillStyle = 'rgba(0,0,0,0.28)';
        c.fillRect(ox, oy + chh * 0.62, cw, chh * 0.1);
      } else {
        // doorway silhouette so the vomitory reads as an opening with depth
        c.fillStyle = 'rgba(0,0,0,0.5)';
        c.fillRect(ox + cw * 0.08, oy + chh * 0.13, cw * 0.1, chh * 0.87);
        c.fillRect(ox + cw * 0.82, oy + chh * 0.13, cw * 0.1, chh * 0.87);
      }

      // silhouetted figures
      const nF = concourse ? 3 : 2 + Math.floor(rng() * 3);
      for (let i = 0; i < nF; i++) {
        const fx = ox + cw * (0.12 + rng() * 0.76);
        const fh = chh * (0.42 + rng() * 0.2);
        const fy = oy + chh - fh;
        const fw = fh * 0.34;
        c.fillStyle = `rgba(8,6,5,${0.55 + rng() * 0.35})`;
        c.beginPath();
        c.ellipse(fx, fy + fh * 0.62, fw * 0.5, fh * 0.42, 0, 0, Math.PI * 2);
        c.fill();
        c.beginPath();
        c.arc(fx, fy + fh * 0.12, fw * 0.27, 0, Math.PI * 2);
        c.fill();
      }

      // mullion / frame reveal so each pane has an edge shadow
      c.strokeStyle = 'rgba(0,0,0,0.85)';
      c.lineWidth = Math.max(2, cw * 0.045);
      c.strokeRect(ox + c.lineWidth / 2, oy + c.lineWidth / 2, cw - c.lineWidth, chh - c.lineWidth);
      if (!concourse) {
        c.lineWidth = Math.max(1, cw * 0.018);
        c.beginPath();
        c.moveTo(ox + cw / 2, oy); c.lineTo(ox + cw / 2, oy + chh);
        c.stroke();
      }
      c.restore();
    }
  }, { wrap: THREE.ClampToEdgeWrapping });
}

/** Wraparound tier-divider LED ribbon: colour blocks + competition wordmark. */
function makeRibbonTexture(W) {
  const H = Math.max(32, Math.round(W / 16));
  return makeCanvasTexture(W, H, (c, w, h) => {
    c.fillStyle = '#05070c';
    c.fillRect(0, 0, w, h);
    const blocks = [
      '◤ PIT WALL · AUTONOMOUS TRANSFER FINANCE',
      '100% PRECISION · 0 VIOLATIONS',
      'SQUAD-COST 68% / 70% · WITHIN LIMIT',
      'EVERY DECISION — WHY IS ONE QUERY',
    ];
    const bw = w / blocks.length;
    for (let i = 0; i < blocks.length; i++) {
      const txt = blocks[i];
      const g = c.createLinearGradient(i * bw, 0, i * bw, h);
      g.addColorStop(0, i % 2 ? '#13330d' : '#0c2416');
      g.addColorStop(1, '#04060a');
      c.fillStyle = g;
      c.fillRect(i * bw + h * 0.12, 0, bw - h * 0.24, h);
      c.fillStyle = '#c6ff2e';
      c.font = `800 ${Math.round(h * 0.42)}px "SF Pro Display","Helvetica Neue",Arial,sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(txt, i * bw + bw / 2, h * 0.5);
    }
    // LED texel structure
    c.globalAlpha = 0.22;
    c.fillStyle = '#000';
    for (let y = 0; y < h; y += 3) c.fillRect(0, y, w, 1);
    for (let x = 0; x < w; x += 3) c.fillRect(x, 0, 1, h);
    c.globalAlpha = 1;
  });
}

/**
 * Roof leading-edge band: a warm wash with a regular rhythm of brighter panels
 * where the fascia catches the uplight, plus a dark drip line along the bottom.
 */
function makeFasciaTexture() {
  return makeCanvasTexture(256, 32, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(255,226,178,0.10)');
    g.addColorStop(0.35, 'rgba(255,214,158,0.52)');
    g.addColorStop(0.8, 'rgba(190,150,104,0.30)');
    g.addColorStop(1, 'rgba(20,18,16,0.55)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) {
      c.fillStyle = 'rgba(255,236,200,0.22)';
      c.fillRect(i * 32 + 4, h * 0.28, 24, h * 0.4);
      c.fillStyle = 'rgba(0,0,0,0.45)';
      c.fillRect(i * 32, 0, 2.5, h);
    }
  });
}

/** Concrete signage banding. Alpha-cut. */
function makeSignageTexture(W) {
  const H = Math.max(32, Math.round(W / 20));
  return makeCanvasTexture(W, H, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(150,128,96,0.30)');
    g.addColorStop(0.5, 'rgba(196,170,128,0.42)');
    g.addColorStop(1, 'rgba(110,92,70,0.22)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,244,222,0.9)';
    c.font = `700 ${Math.round(h * 0.44)}px "SF Pro Display","Helvetica Neue",Arial,sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    try { c.letterSpacing = `${Math.round(h * 0.14)}px`; } catch (e) { /* older canvas */ }
    c.fillText(`${(VENUE.short || VENUE.name).toUpperCase()}   ·   ${VENUE.city.toUpperCase()}`, w / 2, h * 0.5);
  });
}

/** Corner big screen: crowd feed + score bug. */
function makeScreenTexture(W) {
  const H = Math.round(W * 0.5625);
  return makeCanvasTexture(W, H, (c, w, h) => {
    c.fillStyle = '#05070b';
    c.fillRect(0, 0, w, h);
    // "crowd feed": warm blobby noise in the top 74%
    const fh = h * 0.74;
    const bg = c.createLinearGradient(0, 0, 0, fh);
    bg.addColorStop(0, '#3a2f24');
    bg.addColorStop(1, '#14181f');
    c.fillStyle = bg;
    c.fillRect(0, 0, w, fh);
    let s = 12345;
    const r = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    for (let i = 0; i < 1400; i++) {
      const x = r() * w, y = r() * fh;
      const rr = 2 + r() * 5;
      const v = 60 + r() * 150;
      c.fillStyle = `rgba(${v},${v * 0.8 | 0},${v * 0.62 | 0},${0.25 + r() * 0.5})`;
      c.beginPath(); c.arc(x, y, rr, 0, Math.PI * 2); c.fill();
    }
    // a brighter band suggesting a lit block of fans
    c.fillStyle = 'rgba(210,40,60,0.20)';
    c.fillRect(w * 0.12, fh * 0.3, w * 0.32, fh * 0.5);
    // score bug
    c.fillStyle = '#0a0d13';
    c.fillRect(0, fh, w, h - fh);
    c.fillStyle = TEAMS.home.primary;
    c.fillRect(w * 0.18, fh + h * 0.045, w * 0.03, h * 0.145);
    c.fillStyle = TEAMS.away.secondary;
    c.fillRect(w * 0.76, fh + h * 0.045, w * 0.03, h * 0.145);
    c.fillStyle = '#ffffff';
    c.font = `800 ${Math.round(h * 0.15)}px "SF Pro Display","Helvetica Neue",Arial,sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(`${TEAMS.home.abbr}   0 - 0   ${TEAMS.away.abbr}`, w / 2, fh + (h - fh) * 0.5);
    c.font = `600 ${Math.round(h * 0.055)}px "SF Pro Display","Helvetica Neue",Arial,sans-serif`;
    c.fillStyle = 'rgba(255,255,255,0.6)';
    c.fillText(VENUE.competition.toUpperCase(), w / 2, h - h * 0.035);
    // LED texel grid
    c.globalAlpha = 0.2;
    c.fillStyle = '#000';
    for (let y = 0; y < h; y += 4) c.fillRect(0, y, w, 1);
    for (let x = 0; x < w; x += 4) c.fillRect(x, 0, 1, h);
    c.globalAlpha = 1;
  }, { wrap: THREE.ClampToEdgeWrapping });
}

// One brand per texture, drawn at the panel's own aspect ratio (≈10:1) so the
// artwork is never stretched and never tiled across a panel edge. Bright enough
// that the light areas cross the bloom threshold in scene-linear terms.
function makeBrandTexture(brand, hue, W, H) {
  return makeCanvasTexture(W, H, (c, w, h) => {
    const bg = c.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, `hsl(${hue}, 62%, 37%)`);
    bg.addColorStop(0.5, `hsl(${hue}, 66%, 26%)`);
    bg.addColorStop(1, `hsl(${hue}, 64%, 14%)`);
    c.fillStyle = bg;
    c.fillRect(0, 0, w, h);

    // 2 cm dark bezel at each end so panels abut cleanly instead of smearing.
    const bez = Math.max(2, h * 0.038);
    c.fillStyle = 'rgba(0,0,0,0.96)';
    c.fillRect(0, 0, bez, h);
    c.fillRect(w - bez, 0, bez, h);

    // Logo mark — near-white so it blooms.
    const mx = h * 0.22, mw = h * 0.62;
    const mg = c.createLinearGradient(mx, 0, mx + mw, h);
    mg.addColorStop(0, `hsl(${(hue + 14) % 360}, 96%, 78%)`);
    mg.addColorStop(1, `hsl(${(hue + 42) % 360}, 92%, 55%)`);
    c.fillStyle = mg;
    c.fillRect(mx, h * 0.19, mw, h * 0.62);
    c.fillStyle = `hsl(${hue}, 82%, 20%)`;
    c.beginPath();
    c.moveTo(mx + mw * 0.52, h * 0.19);
    c.lineTo(mx + mw, h * 0.19);
    c.lineTo(mx + mw * 0.48, h * 0.81);
    c.lineTo(mx, h * 0.81);
    c.closePath();
    c.fill();

    // Brand text, fitted to the remaining width.
    const left = mx + mw + h * 0.30;
    const maxW = w - left - h * 0.34;
    let size = Math.round(h * 0.44);
    const setFont = () => {
      c.font = `800 ${size}px "SF Pro Display", "Helvetica Neue", Arial, sans-serif`;
      try { c.letterSpacing = `${Math.max(1, Math.round(h * 0.035))}px`; } catch (e) { /* older canvas */ }
    };
    setFont();
    let tw = c.measureText(brand).width;
    if (tw > maxW) {
      size = Math.max(8, Math.floor((size * maxW) / tw));
      setFont();
      tw = c.measureText(brand).width;
    }
    c.textAlign = 'left';
    c.textBaseline = 'middle';
    c.shadowColor = 'rgba(255,246,225,0.55)';
    c.shadowBlur = h * 0.14;
    c.fillStyle = '#ffffff';
    c.fillText(brand, left, h * 0.5);
    c.shadowBlur = 0;

    // Accent rule along the foot — kept BELOW the panel's own peak value so it
    // no longer reads as a neon tube brighter than the board.
    c.fillStyle = `hsl(${(hue + 175) % 360}, 62%, 38%)`;
    c.fillRect(h * 0.10, h - Math.max(2, h * 0.075), w - h * 0.20, Math.max(2, h * 0.04));

    // LED pixel structure — vertical texel pitch visible at replay range.
    c.globalAlpha = 0.20;
    c.fillStyle = '#000';
    for (let y = 0; y < h; y += 3) c.fillRect(0, y, w, 1);
    for (let x = 0; x < w; x += 3) c.fillRect(x, 0, 1, h);
    c.globalAlpha = 1;
    // emitter falloff: slightly hotter across the middle of the panel
    const vg = c.createLinearGradient(0, 0, 0, h);
    vg.addColorStop(0, 'rgba(0,0,0,0.22)');
    vg.addColorStop(0.45, 'rgba(255,255,255,0.06)');
    vg.addColorStop(1, 'rgba(0,0,0,0.30)');
    c.fillStyle = vg;
    c.fillRect(0, 0, w, h);
  }, { wrap: THREE.ClampToEdgeWrapping });
}

// Soft radial flare used additively on every lamp head.
function makeGlowTexture() {
  return makeCanvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0.0, 'rgba(255,246,226,1)');
    g.addColorStop(0.18, 'rgba(255,238,205,0.55)');
    g.addColorStop(0.45, 'rgba(255,226,180,0.14)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }, { wrap: THREE.ClampToEdgeWrapping });
}

// Soft elliptical falloff, used for the glow bleeding around a lit window.
function makeSoftGlowTexture() {
  return makeCanvasTexture(64, 64, (c, w, h) => {
    c.fillStyle = '#000';
    c.fillRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0.0, 'rgba(255,238,210,0.85)');
    g.addColorStop(0.35, 'rgba(255,226,186,0.28)');
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }, { wrap: THREE.ClampToEdgeWrapping });
}

// Contact shadow under the LED board carcass: opaque at the board, gone by 16 cm.
function makeContactShadowTexture() {
  return makeCanvasTexture(8, 64, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.9)');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }, { wrap: THREE.ClampToEdgeWrapping });
}
