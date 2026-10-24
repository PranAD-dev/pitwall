import * as THREE from 'three';
import { PITCH, GOAL, clamp, lerp, damp } from './util.js';

// ---------------------------------------------------------------------------
// cameraRig.js — broadcast camera package for the Stade Raoul Brulat.
//
// Modes: broadcast (TV master, default) · closeup · goal · stadium · replay.
//
// Every mode is COMPOSED, not eyeballed: the rig places the camera at a real
// physical position (gantry under the upper deck, behind-goal platform, low
// hero position on the TV side, corner crane) and then solves the tilt from
// the lens so a chosen world feature lands on a chosen screen line:
//   broadcast → lens solved from the METRES OF PITCH LENGTH the frame is to
//               span (~50 m, the TV master's real "zoom") and the bottom edge
//               pinned to the near limit of the PLAY rather than to the near
//               touchline, so no part of the picture is spent on grass nobody
//               is on: far touchline ~37% down, crowd banding the top ~35%,
//               ball riding 55–60%, a whole near-side man in the foreground.
//   goal      → crossbar pinned across the lower third and the FOV solved from
//               the goal width so the frame + net fill the foreground.
//   closeup   → subject's boots pinned near the bottom edge and the FOV
//               solved from the subject distance so he fills ~60% of height.
//   stadium   → tilted up off the pitch so the far roofline sits ~2/3 up with
//               night sky and floodlight pylons above it.
// All motion is exponentially damped (util.damp) so it converges under the
// screenshot warm-up loop and never jitters. Mode changes are hard TV cuts.
// On 'goal' events (broadcast only): brief tele punch-in, cut to a hero
// closeup of the scorer, cut back for the kickoff. camera.up is always +Y.
// ---------------------------------------------------------------------------

const HALF_LEN = PITCH.length / 2;  // 52.5 — goal lines
const HALF_WID = PITCH.width / 2;   // 34   — touchlines
const DEG = Math.PI / 180;

// --- TV master gantry ------------------------------------------------------
// Slung in the gap between the lower-tier crowd (terrace floor 7.6 m at this
// depth, an arms-up fan topping out at 9.8 m) and the upper deck's soffit and
// tier-divider fascia, which hang at 13.45 m. Everything below is solved
// against those two surfaces: the bottom of frame must clear the near crowd,
// the top of frame must stay under that soffit.
const TV_Y = 12.0;
const TV_Z = -52.0;

// --- master composition ----------------------------------------------------
// The master is framed on the PLAY, not on the paint. Pinning the near
// touchline near the bottom edge (any value, −0.95 or −1.15) is what made the
// old frame bottom-heavy: nobody in this match ever plays within ~6 m of the
// near touchline, so that strip is always empty grass, and being the nearest
// ground in shot it is also the most expensive — 6 m of it eats a THIRD of the
// picture height. So the bottom edge is pinned to the near limit of the play
// instead, TV_CROP_Z metres out from the middle, and the near touchline falls
// where it falls (≈ −1.5, i.e. well off the bottom edge). That buys the
// televised layout: far touchline 37–42% down, crowd banding the top ~35%,
// ball riding 55–58%, and no dead turf under the nearest man.
// The crop is given back the instant anything comes down there (below), so a
// near-side figure always enters WHOLE — never a scalp clipped by the edge.
const TV_ANCHOR = -1.0;             // screen line the crop plane sits on
const TV_CROP_Z = -27.5;            // default near limit of the picture
const TV_CROP_MIN = -HALF_WID;      // deepest tilt-down — the near touchline
                                    // itself; past it the front terrace rows
                                    // start raking into the bottom edge
// Metres of grass kept below the ball / below the nearest man's boots when
// they push the crop. Small on purpose: every metre given away down there is
// ~0.5° of extra tilt, and every degree of tilt lifts the far touchline about
// 3.5% of frame height — i.e. it is paid for out of the crowd band at the top.
const TV_CROP_BALL = 1.0;
const TV_CROP_MAN = 0.9;
// The master's real "zoom", expressed the way a director thinks about it: how
// many metres of pitch LENGTH the frame spans across the middle of the
// picture. ~50 m is the EA/TV master — a man at 25 m is ~125 px tall and his
// shirt number reads; at 70 m (a tactics camera) he is 90 px and it does not.
// The operator widens a little as play spreads out toward the boxes.
const TV_SPAN = 49;                 // play central
const TV_SPAN_WIDE = 52;            // play out by the penalty areas
const TV_SPAN_GOAL = 3;             // metres of punch-in while a goal confirms
// The gantry dollies with the ball but stays well inside the halfway third of
// the stand: past x ≈ ±34 the goal-end stand starts looming into frame edge.
// And the pan is capped — past ~8° off the stand normal the bottom corners of
// frame rake along the near terrace and pick up its own crowd. Between them
// the ball simply rides off-centre when play is in a corner, exactly as it
// does on a real master camera.
const TV_DOLLY = 0.86;
const TV_DOLLY_MAX = 34;
const TV_PAN_MAX = 7;               // metres of look-ahead offset at 55 m throw

// --- Behind-goal platform --------------------------------------------------
const GOAL_BACK = 7.2;              // metres behind the goal line
const GOAL_Y = 5.6;                 // above the crossbar, clear of the crowd
const GOAL_ANCHOR = -0.46;          // screen line the crossbar is pinned to

// --- Low hero (closeup) ----------------------------------------------------
const HERO_Y = 2.45;
const HERO_DIST = 9.6;
const HERO_H = 1.86;                // player height used for framing
const HERO_FILL = 0.60;             // fraction of frame height he occupies
const HERO_FEET = -0.78;            // screen line his boots are pinned to

// --- Corner crane (stadium) ------------------------------------------------
// z is kept well clear of the −Z roof lip (z = −37): the frame's left edge must
// not graze it or the roof underside swallows a third of the shot.
const CRANE = { x: -50, y: 29, z: -28.5, az: 32 * DEG, tilt: -14.1 * DEG, fov: 50 };

export function createCameraRig(ctx, { ball, teams, match }) {
  const aspect = (window.innerWidth || 1920) / (window.innerHeight || 1080);
  const camera = new THREE.PerspectiveCamera(35, aspect, 0.3, 1600);
  camera.up.set(0, 1, 0);

  // --- rig state -----------------------------------------------------------
  const VALID = ['broadcast', 'closeup', 'goal', 'stadium', 'replay'];
  let userMode = 'broadcast';
  let time = 0;            // accumulated rig time (drift/orbit phase)
  let replayA = Math.PI * 1.25; // replay orbit angle — starts on the TV side
  let pendingSnap = true;  // hard cut on next update
  let seq = null;          // goal auto-cut sequence: { phase:'hold'|'hero', t, hero }
  let goalSide = 1;        // which goal the 'goal' mode covers (+1 = x>0)
  let sideTimer = 0;       // hysteresis timer before goalSide flips

  // Smoothed camera state (what actually drives the camera every frame).
  const pos = new THREE.Vector3(0, TV_Y, TV_Z);
  const tgt = new THREE.Vector3(0, 2.1, 0);
  let fovCur = 35;

  // Smoothed ball tracking — the "camera operator's eye". Damping here keeps
  // kicks/bounces from ever reaching the lens raw.
  const ballSm = new THREE.Vector3(0, 0.11, 0);
  const velSm = new THREE.Vector3();

  // Scratch (zero allocation per frame).
  const _lead = new THREE.Vector3();
  const _subj = new THREE.Vector3();
  const _zero = new THREE.Vector3();
  const des = { p: new THREE.Vector3(), t: new THREE.Vector3(), fov: 35, posL: 2.5, tgtL: 3.5, fovL: 2 };

  // --- helpers -------------------------------------------------------------
  function sstep(x, a, b) {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function dampV3(cur, target, lambda, dt) {
    const k = 1 - Math.exp(-lambda * dt);
    cur.x += (target.x - cur.x) * k;
    cur.y += (target.y - cur.y) * k;
    cur.z += (target.z - cur.z) * k;
  }

  function ballPos() {
    return ball && ball.pos && ball.pos.isVector3 ? ball.pos : _zero;
  }
  function ballVel() {
    return ball && ball.vel && ball.vel.isVector3 ? ball.vel : _zero;
  }
  function safeAspect() {
    const a = camera.aspect;
    return Number.isFinite(a) && a > 0.2 ? a : 16 / 9;
  }

  /**
   * Aim: write out.t from a horizontal heading (hx,hz — need not be unit) and
   * a tilt in radians. Keeps yaw and pitch independent so composition math is
   * exact; lookAt(out.t) then reproduces it.
   */
  function aim(out, px, py, pz, hx, hz, tilt, dist) {
    const hl = Math.hypot(hx, hz) || 1;
    const k = (Math.cos(tilt) * dist) / hl;
    out.t.set(px + hx * k, py + Math.sin(tilt) * dist, pz + hz * k);
  }

  /**
   * Tilt (rad, negative = down) that puts a ground feature `horiz` metres
   * ahead and `drop` metres below the lens on screen line `s` (−1 = bottom).
   */
  function anchorTilt(drop, horiz, fovDeg, s) {
    const a = -Math.atan2(drop, Math.max(horiz, 0.5));
    return a + Math.atan(-s * Math.tan(fovDeg * DEG * 0.5));
  }

  /** Vertical FOV (deg) whose HORIZONTAL half-angle frames `halfW` at `dist`. */
  function fovForWidth(halfW, dist, frac) {
    const tanH = halfW / Math.max(dist, 0.5) / clamp(frac, 0.05, 1);
    return 2 * Math.atan(tanH / safeAspect()) / DEG;
  }

  // Gantry geometry, resolved once: depression to the pitch centre and the
  // throw to it — the depth the master's span is measured at.
  const TV_B_MID = -Math.atan2(TV_Y, -TV_Z);
  const TV_D_MID = Math.hypot(TV_Z, TV_Y);

  /**
   * Vertical FOV (deg) that makes the master frame span `span` metres of pitch
   * LENGTH across the middle of the picture, when the bottom edge is pinned to
   * the crop plane at `zc`. Lens and tilt are coupled (the tilt is solved from
   * the lens, the span is measured on the tilted axis), so this is a fixed
   * point — the coupling runs through a cosine near 1, so three passes land
   * inside 0.01°.
   */
  function fovForSpan(span, zc) {
    const bCrop = -Math.atan2(TV_Y, zc - TV_Z);
    const k = span / (2 * TV_D_MID * safeAspect());
    let t = 0.26;
    for (let i = 0; i < 3; i++) {
      t = k / Math.cos(TV_B_MID - (bCrop - Math.atan(TV_ANCHOR * t)));
    }
    return 2 * Math.atan(t) / DEG;
  }

  /**
   * Z of the near-most player standing inside the master's horizontal window —
   * the man the bottom edge has to respect. Returns 0 (i.e. "nobody down
   * there") when the near half is empty, so the crop stays at its default.
   */
  function nearSideZ(px) {
    const ps = teams && teams.players;
    if (!ps || !ps.length) return 0;
    let z = 0;
    for (const p of ps) {
      if (!p || !p.pos || !p.pos.isVector3) continue;
      // The frame's bottom edge reaches ~16 m either side of the gantry; look
      // 22 m out so a man is already accounted for a good second before he
      // walks into shot, and the reframe never happens under the viewer's nose.
      if (Math.abs(p.pos.x - px) > 22) continue;
      // Lead a man who is driving AT the camera by a third of a second, so the
      // damped tilt has already made room by the time he gets there instead of
      // slicing his legs off for half a second.
      const vz = p.vel && p.vel.isVector3 ? Math.min(0, p.vel.z) : 0;
      const pz = p.pos.z + vz * 0.34;
      if (pz < z) z = pz;
    }
    return z;
  }

  // Which goal is under attack (+1 → goal at x=+52.5). Possession-aware with
  // a ball-side fallback so the mode works even before match.js lands.
  function attackSide() {
    const s = match && match.state;
    if (s && (s.possession === 'home' || s.possession === 'away')) {
      const d = s.attackDirHome >= 0 ? 1 : -1;
      return s.possession === 'home' ? d : -d;
    }
    return ballSm.x + velSm.x * 0.5 >= 0 ? 1 : -1;
  }

  // Nearest player to the ball, optionally restricted to one team's
  // outfielders (so a goal hero shot never lands on the conceding keeper).
  function nearestPlayer(team) {
    const ps = teams && teams.players;
    if (!ps || !ps.length) return null;
    let best = null, bd = Infinity;
    for (const p of ps) {
      if (!p || !p.pos || !p.pos.isVector3) continue;
      if (team && (p.team !== team || p.role === 'GK')) continue;
      if (!team && p.role === 'REF') continue;
      const dx = p.pos.x - ballSm.x, dz = p.pos.z - ballSm.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  // Which team scored, from event data if present, else geometry: the goal
  // sits at sign(ballX); home scored iff that matches home's attack direction.
  function scoringTeam(data) {
    let t = data && (data.team || (data.scorer && data.scorer.team));
    if (t !== 'home' && t !== 'away') {
      const s = match && match.state;
      const d = s && s.attackDirHome >= 0 ? 1 : -1;
      t = (ballSm.x >= 0 ? 1 : -1) === d ? 'home' : 'away';
    }
    return t;
  }

  // --- mode desired-state functions ---------------------------------------

  // TV master. Fixed gantry height/depth on the −Z main stand; dollies in X
  // with the ball and pans the rest. Lens and tilt are both SOLVED, not dialled
  // in: the lens from how much pitch length the frame is to carry, the tilt so
  // the crop plane lands on TV_ANCHOR whatever the lens is doing. That pair is
  // what makes the framing read as televised football instead of a floating
  // orbit cam — players big enough to read a number on, no dead turf along the
  // bottom, far touchline about a third down with the bowl stacked above it.
  function desireBroadcast(out) {
    _lead.copy(velSm).multiplyScalar(0.6);
    _lead.y = 0;
    if (_lead.lengthSq() > 64) _lead.setLength(8); // cap the pan-ahead at 8 m

    const aimX = clamp(ballSm.x + _lead.x, -54, 54);
    const px = clamp(aimX * TV_DOLLY, -TV_DOLLY_MAX, TV_DOLLY_MAX);
    out.p.set(px, TV_Y, TV_Z);

    // 49 m of pitch across the frame with play mid-pitch, 52 m out by the
    // boxes (a real operator widens as play spreads). Punch in while a goal
    // is being confirmed.
    let span = lerp(TV_SPAN, TV_SPAN_WIDE, sstep(Math.abs(ballSm.x), 14, 40));
    if (seq && seq.phase === 'hold') span -= TV_SPAN_GOAL;

    // Near limit of the picture: the default crop, given back to whichever of
    // the ball or the nearest man has come closest to the near touchline. The
    // giving-back is what guarantees the foreground: the bottom edge is always
    // at least TV_CROP_MAN below the nearest pair of boots, so a near-side
    // player is framed whole instead of being sliced into a floating head.
    let zc = TV_CROP_Z;
    if (ballSm.z - TV_CROP_BALL < zc) zc = ballSm.z - TV_CROP_BALL;
    const nz = nearSideZ(px) - TV_CROP_MAN;
    if (nz < zc) zc = nz;
    zc = clamp(zc, TV_CROP_MIN, TV_CROP_Z);

    // Dropping the camera onto the near line costs the crowd band at the top
    // of frame — the tilt takes it away. Widen a touch to buy some of it back,
    // which is exactly what an operator does when he has to tilt down.
    span = Math.min(span + (TV_CROP_Z - zc) * 0.9, TV_SPAN_WIDE + 4);

    const f = fovForSpan(span, zc);
    out.fov = f;

    const tilt = anchorTilt(TV_Y, zc - TV_Z, f, TV_ANCHOR);
    // Pan: heading toward the ball's X, measured against a fixed 55 m throw so
    // the yaw stays gentle and the horizon stays level.
    const panX = clamp((aimX - px) * 0.45, -TV_PAN_MAX, TV_PAN_MAX);
    aim(out, px, TV_Y, TV_Z, panX, 55, tilt, 60);

    out.posL = 2.5; out.tgtL = 3.5; out.fovL = 2.0;
  }

  // Low hero camera on the TV side. Subject is the scorer during a goal cut,
  // otherwise the player closest to the ball. FOV is solved from the true
  // (post-clamp) distance so he always fills ~60% of frame height, and the
  // tilt pins his boots near the bottom edge — no dead grass under him.
  function desireCloseup(out) {
    let hero = seq && seq.hero && seq.hero.pos && seq.hero.pos.isVector3 ? seq.hero : null;
    if (!hero) hero = nearestPlayer(null);
    const hp = hero && hero.pos && hero.pos.isVector3 ? hero.pos : ballPos();
    const hv = hero && hero.vel && hero.vel.isVector3 ? hero.vel : velSm;

    // Lead the subject so he sits off dead-centre with room in front of him,
    // plus a small static bias toward mid-pitch for a stationary subject.
    _lead.set(hv.x, 0, hv.z).multiplyScalar(0.20);
    if (_lead.lengthSq() > 2.56) _lead.setLength(1.6);
    _lead.x -= Math.sign(hp.x) * 0.45;
    _subj.set(hp.x, 0, hp.z);

    // Sit toward the TV side, angled slightly toward mid-pitch so the action
    // plays across frame rather than flat-on.
    const dx = clamp(-_subj.x * 0.014, -0.45, 0.45);
    const dl = Math.hypot(dx, 1);
    let cx = _subj.x + (dx / dl) * HERO_DIST;
    let cz = _subj.z - (1 / dl) * HERO_DIST;
    // Stay on the grass apron, in front of the LED boards (|x| 55.5 / z 37.5).
    cx = clamp(cx, -54.5, 54.5);
    cz = clamp(cz, -36.6, 36.6);
    out.p.set(cx, HERO_Y, cz);

    const d = Math.max(Math.hypot(_subj.x - cx, _subj.z - cz), 2.5);
    // tan(halfFov) that makes a HERO_H tall man cover HERO_FILL of the frame.
    out.fov = clamp(2 * Math.atan(HERO_H / (d * HERO_FILL * 2)) / DEG, 15, 36);
    const tilt = anchorTilt(HERO_Y, d, out.fov, HERO_FEET);
    aim(out, cx, HERO_Y, cz, _subj.x + _lead.x - cx, _subj.z + _lead.z - cz, tilt, d);

    out.posL = 3.4; out.tgtL = 4.6; out.fovL = 3.0;
  }

  // Behind the attacked goal, centred on the posts, 5.6 m up on a platform
  // clear of the first rows. FOV is solved so the posts sit at ~72–82% of
  // half-width and the tilt pins the crossbar across the lower third: frame
  // and net own the foreground, the pitch runs away to the far crowd band.
  function desireGoal(out) {
    // Dead centre on the posts. At 7 m range even a metre of lateral offset
    // swings the frame 8°, so this one does not drift with the ball at all.
    const px = goalSide * (HALF_LEN + GOAL_BACK);
    out.p.set(px, GOAL_Y, 0);

    // Tighter when play is at the far end (distant action stays readable),
    // a touch wider when the attack arrives in the box.
    const dGoal = Math.abs(ballSm.x - goalSide * HALF_LEN);
    const frac = lerp(0.72, 0.82, sstep(dGoal, 18, 62));
    out.fov = clamp(fovForWidth(GOAL.width / 2 + GOAL.postR, GOAL_BACK, frac), 30, 52);

    const tilt = anchorTilt(GOAL_Y - GOAL.height, GOAL_BACK, out.fov, GOAL_ANCHOR);
    // Heading is straight down the pitch with a whisper of pan on ball Z
    // (≤ 3°, i.e. the posts never move more than ~5% of the goal width).
    const lat = clamp(ballSm.z * 0.0016, -0.052, 0.052);
    aim(out, px, GOAL_Y, 0, -goalSide, lat, tilt, 60);

    out.posL = 2.2; out.tgtL = 3.0; out.fovL = 2.2;
  }

  // Corner crane, establishing. Hovers over the near pitch corner below the
  // roof line (nothing is built above the pitch, so it can never clip), aimed
  // across the diagonal and tilted UP off the grass: lit pitch in the lower
  // half, the far bowl behind it, then roofline, pylons and night sky in the
  // top third. Slow sway/bob keeps it alive without ever losing the framing.
  function desireStadium(out) {
    const px = CRANE.x + 1.6 * Math.sin(time * 0.045);
    const py = CRANE.y + 0.9 * Math.sin(time * 0.031);
    const pz = CRANE.z - 1.2 * Math.sin(time * 0.037);
    out.p.set(px, py, pz);

    const az = CRANE.az + 0.035 * Math.sin(time * 0.026);
    const tilt = CRANE.tilt + 0.012 * Math.sin(time * 0.043);
    out.fov = CRANE.fov;
    aim(out, px, py, pz, Math.cos(az), Math.sin(az), tilt, 120);

    out.posL = 1.8; out.tgtL = 1.8; out.fovL = 1.5;
  }

  // Slow orbital dolly around the ball, chest-height, composed like the hero
  // shot: subject a real size in frame, ball around the lower third, no acre
  // of empty grass under it.
  const REPLAY_R = 8.5;
  function desireReplay(out) {
    const cx = clamp(ballSm.x + Math.cos(replayA) * REPLAY_R, -54.5, 54.5);
    const cz = clamp(ballSm.z + Math.sin(replayA) * REPLAY_R, -36.6, 36.6);
    out.p.set(cx, 2.1, cz);

    const d = Math.max(Math.hypot(ballSm.x - cx, ballSm.z - cz), 2.5);
    out.fov = clamp(2 * Math.atan(HERO_H / (d * 0.46 * 2)) / DEG, 16, 40);
    const tilt = anchorTilt(2.1 - clamp(ballSm.y, 0, 2.5), d, out.fov, -0.55);
    aim(out, cx, 2.1, cz, ballSm.x - cx, ballSm.z - cz, tilt, d);

    out.posL = 4.0; out.tgtL = 5.0; out.fovL = 3.0;
  }

  const DESIRE = {
    broadcast: desireBroadcast,
    closeup: desireCloseup,
    goal: desireGoal,
    stadium: desireStadium,
    replay: desireReplay,
  };

  // --- goal-event auto-cut -------------------------------------------------
  if (match && typeof match.onEvent === 'function') {
    try {
      match.onEvent((type, data) => {
        if (type === 'goal') {
          if (userMode !== 'broadcast') return; // never override an explicit mode
          let hero = data && (data.scorer || data.player || data.by);
          if (!(hero && hero.pos && hero.pos.isVector3)) hero = null; // resolve at cut time
          seq = { phase: 'hold', t: 0, hero, team: scoringTeam(data) };
        } else if (type === 'kickoff') {
          if (seq && seq.phase === 'hero') pendingSnap = true; // cut back for restart
          seq = null;
        }
      });
    } catch (_) { /* match may not support events yet — rig still works */ }
  }

  // --- public API ----------------------------------------------------------
  function setMode(m) {
    userMode = VALID.indexOf(m) >= 0 ? m : 'broadcast';
    seq = null;
    sideTimer = 0;
    if (userMode === 'goal') goalSide = attackSide();
    pendingSnap = true; // every mode change is a hard TV cut
  }

  function update(dt) {
    if (!(dt > 0)) dt = 0;
    time += dt;
    replayA += dt * 0.28;

    // Operator-smoothed ball state (position λ6 kills bounce chatter,
    // velocity λ3 gives human anticipation ramp on kicks).
    const bp = ballPos(), bv = ballVel();
    if (Number.isFinite(bp.x) && Number.isFinite(bp.z)) dampV3(ballSm, bp, 6, dt);
    if (Number.isFinite(bv.x) && Number.isFinite(bv.z)) dampV3(velSm, bv, 3, dt);

    // Goal-mode side hysteresis: only recommit after 1.2 s, then cut.
    if (userMode === 'goal') {
      const want = attackSide();
      if (want !== goalSide) {
        sideTimer += dt;
        if (sideTimer >= 1.2) { goalSide = want; sideTimer = 0; pendingSnap = true; }
      } else {
        sideTimer = 0;
      }
    }

    // Goal auto-cut sequence timing.
    if (seq) {
      seq.t += dt;
      if (seq.phase === 'hold' && seq.t >= 0.9) {
        seq.phase = 'hero'; seq.t = 0; pendingSnap = true;   // cut to scorer
        if (!seq.hero) seq.hero = nearestPlayer(seq.team);   // celebrator, never the beaten GK
      } else if (seq.phase === 'hero' && seq.t >= 3.4) {
        seq = null; pendingSnap = true;                       // cut back to master
      }
    }

    const activeMode = seq && seq.phase === 'hero' ? 'closeup' : userMode;
    (DESIRE[activeMode] || desireBroadcast)(des);

    if (pendingSnap) {
      pos.copy(des.p);
      tgt.copy(des.t);
      fovCur = des.fov;
      pendingSnap = false;
    } else {
      dampV3(pos, des.p, des.posL, dt);
      dampV3(tgt, des.t, des.tgtL, dt);
      fovCur = damp(fovCur, des.fov, des.fovL, dt);
    }

    if (pos.y < 0.6) pos.y = 0.6; // absolute floor — never sink into the grass

    camera.position.copy(pos);
    camera.up.set(0, 1, 0); // level horizon, always
    camera.lookAt(tgt);
    if (Math.abs(camera.fov - fovCur) > 1e-4) {
      camera.fov = fovCur;
      camera.updateProjectionMatrix();
    }
  }

  // Prime the camera so the very first rendered frame is composed.
  desireBroadcast(des);
  pos.copy(des.p); tgt.copy(des.t); fovCur = des.fov;
  camera.position.copy(pos);
  camera.lookAt(tgt);
  camera.fov = fovCur;
  camera.updateProjectionMatrix();
  pendingSnap = false;

  return { camera, update, setMode };
}
