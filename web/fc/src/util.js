import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Shared constants — the single source of truth for world layout.
// Pitch center = world origin. Length along X (goals at ±52.5), width along Z.
// TV/main stand on −Z. +Y up. Units: meters.
// ---------------------------------------------------------------------------

export const PITCH = {
  length: 105,
  width: 68,
  lineWidth: 0.12,
  centerCircleR: 9.15,
  penAreaDepth: 16.5,
  penAreaWidth: 40.32,
  sixBoxDepth: 5.5,
  sixBoxWidth: 18.32,
  penSpotDist: 11,
  penArcR: 9.15,
  cornerArcR: 1,
  margin: 6, // grass apron beyond the lines
};

export const GOAL = {
  width: 7.32,
  height: 2.44,
  depth: 2.0,
  postR: 0.06,
};

// Four rectangular grandstands (English-style ground). Corners are filled by
// stadium.js with structure, not seats.
// axis: which world axis the stand's outward normal lies on; sign: direction.
export const STANDS = [
  { id: 'west', axis: 'x', sign: -1, length: PITCH.width + 14 },
  { id: 'east', axis: 'x', sign: 1, length: PITCH.width + 14 },
  { id: 'north', axis: 'z', sign: -1, length: PITCH.length + 14 }, // main/TV stand
  { id: 'south', axis: 'z', sign: 1, length: PITCH.length + 14 },
];

// Tier profiles shared by stadium terraces and crowd seat placement.
// baseDist: distance from world center to the FIRST row, per stand axis
// (x-stands sit behind the goals, z-stands behind the touchlines).
export const TIERS = [
  { rows: 22, seatPitch: 0.55, rowDepth: 0.85, rowRise: 0.45, baseY: 1.8, baseDist: { x: 58, z: 41 } },
  { rows: 15, seatPitch: 0.55, rowDepth: 0.85, rowRise: 0.58, baseY: 15.0, baseDist: { x: 62, z: 45 } },
];

/**
 * Iterate every seat in the stadium. cb receives:
 * { pos: THREE.Vector3, yaw, standId, tierIdx, row, seatIdx, u }
 * yaw: rotation about Y so the fan faces the pitch (0 faces +X).
 * u: 0..1 position along the stand length.
 */
export function forEachSeat(cb) {
  const pos = new THREE.Vector3();
  for (const stand of STANDS) {
    for (let t = 0; t < TIERS.length; t++) {
      const tier = TIERS[t];
      const base = tier.baseDist[stand.axis];
      const seats = Math.floor(stand.length / tier.seatPitch);
      for (let r = 0; r < tier.rows; r++) {
        const dist = base + r * tier.rowDepth;
        const y = tier.baseY + r * tier.rowRise;
        for (let s = 0; s < seats; s++) {
          const along = (s + 0.5) * tier.seatPitch - stand.length / 2;
          let x, z, yaw;
          if (stand.axis === 'x') {
            x = stand.sign * dist;
            z = along;
            yaw = stand.sign > 0 ? Math.PI : 0;
          } else {
            z = stand.sign * dist;
            x = along;
            yaw = stand.sign > 0 ? -Math.PI / 2 : Math.PI / 2;
          }
          pos.set(x, y, z);
          cb({ pos, yaw, standId: stand.id, tierIdx: t, row: r, seatIdx: s, u: (s + 0.5) / seats });
        }
      }
    }
  }
}

// Crests are ORIGINAL designs in each club's colours, drawn procedurally — the
// clubs' real badges are their own property and are not reproduced here.
export const TEAMS = {
  home: {
    name: 'Harbourside FC', short: 'Harbourside', abbr: 'HAR',
    primary: '#c6ff2e', secondary: '#0b0f14',
    shirt: '#0b0f14', shirt2: '#c6ff2e', shorts: '#0b0f14', socks: '#0b0f14',
    gk: '#ff8a3d', accent: '#c6ff2e',
    crestInitials: 'HFC', founded: 1898,
  },
  away: {
    name: 'Castleton City', short: 'Castleton', abbr: 'CAS',
    primary: '#eef2f6', secondary: '#1b2a44',
    shirt: '#eef2f6', shirt2: '#1b2a44', shorts: '#1b2a44', socks: '#eef2f6',
    gk: '#ffcf33', accent: '#1b2a44',
    crestInitials: 'CTC', founded: 1921,
  },
};

export const VENUE = {
  name: 'Harbourside Arena',
  short: 'Harbourside',
  city: 'Harbourside',
  competition: 'Ligue Fable',
  matchday: 'Matchday 34',
};

// The Acher family XI — all eleven, goalkeeper included.
// `shout` overrides the name the hype voice yells; defaults to `first`.
//
// `superStar: true` is the full cheat — double pace AND every shot is a goal
// (match.js reads player.star for that). The rest of the family get signature
// hair, a first-name shirt and a modest edge, but no goal guarantee: making all
// ten unstoppable turns every match into a 30-0 formality with nothing to play.
// To promote anyone, add `superStar: true` to their row — nothing else changes.
export const ACHERS = [
  // — the two supers —
  { team: 'home', number: 10, shirtName: 'G. ACHER', first: 'Gabriel',
    spoken: 'Gabriel Acher', speedMult: 2.0, superStar: true, hair: '#f2c14e' },
  { team: 'home', number: 7, shirtName: 'M. ACHER', first: 'Mathieu',
    spoken: 'Mathieu Acher', speedMult: 2.0, superStar: true, hair: '#2f7de1' },
  // — the rest of the family —
  { team: 'home', number: 1, shirtName: 'FRANCETTE', first: 'Francette',
    spoken: 'Francette', speedMult: 1.06, hair: '#fbbf24' },
  { team: 'home', number: 9, shirtName: 'LÉA', first: 'Léa',
    spoken: 'Léa Acher', speedMult: 1.16, hair: '#d94f9a' },
  { team: 'home', number: 2, shirtName: 'ANAÉ', first: 'Anaé',
    spoken: 'Anaé Acher', shout: 'Anaé la Queen', speedMult: 1.16, hair: '#43c6b8' },
  { team: 'home', number: 3, shirtName: 'ROXANE', first: 'Roxane',
    spoken: 'Roxane Acher', speedMult: 1.16, hair: '#8b5cf6' },
  { team: 'home', number: 4, shirtName: 'ALAIN', first: 'Alain',
    spoken: 'Alain Acher', speedMult: 1.14, hair: '#9aa4b2' },
  { team: 'home', number: 5, shirtName: 'AUGUSTINE', first: 'Augustine',
    spoken: 'Augustine Acher', speedMult: 1.14, hair: '#e2e8f0' },
  { team: 'home', number: 6, shirtName: 'ADRIEN', first: 'Adrien',
    spoken: 'Adrien Acher', speedMult: 1.16, hair: '#f97316' },
  { team: 'home', number: 8, shirtName: 'ÉLISE', first: 'Élise',
    spoken: 'Élise Acher', speedMult: 1.16, hair: '#22c55e' },
  { team: 'home', number: 11, shirtName: 'CHLOÉ', first: 'Chloé',
    spoken: 'Chloé Acher Gonort', shout: 'Madame Chloé', speedMult: 1.16, hair: '#ef4444' },
];

/** Everyone with the full cheat. */
export const SUPER_STARS = ACHERS.filter((a) => a.superStar);

/** The Acher record for a given team/number, or null. */
export function acherFor(team, number) {
  for (const a of ACHERS) if (a.team === team && a.number === number) return a;
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic RNG (mulberry32). Returns () => [0,1). */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Procedural texture from a canvas. draw(ctx2d, w, h) paints it.
 * opts: { colorSpace (default SRGB), wrap (default Repeat for both),
 *         anisotropy (default 8), filter, flipY }
 */
export function makeCanvasTexture(w, h, draw, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const c2d = canvas.getContext('2d');
  draw(c2d, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = opts.colorSpace !== undefined ? opts.colorSpace : THREE.SRGBColorSpace;
  const wrap = opts.wrap !== undefined ? opts.wrap : THREE.RepeatWrapping;
  tex.wrapS = wrap; tex.wrapT = wrap;
  tex.anisotropy = opts.anisotropy !== undefined ? opts.anisotropy : 8;
  if (opts.filter) { tex.magFilter = opts.filter; tex.minFilter = opts.filter; }
  if (opts.flipY !== undefined) tex.flipY = opts.flipY;
  tex.needsUpdate = true;
  return tex;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

/** Frame-rate-independent exponential smoothing toward target. */
export const damp = (current, target, lambda, dt) =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));

/** Shortest-path angle interpolation (radians). */
export function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
