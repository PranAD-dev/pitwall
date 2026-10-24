import * as THREE from 'three';
import { PITCH, GOAL, clamp, v3 } from './util.js';

// ---------------------------------------------------------------------------
// match.js — deterministic football brain.
// Drives players (via moveTo/face/playAction) and the ball (via controlledBy /
// kick / place). Fires broadcast events, manages score/clock/excitement.
// ---------------------------------------------------------------------------

const HALF_X = PITCH.length / 2; // 52.5
const HALF_Z = PITCH.width / 2;  // 34

// 4-3-3 slots in attack-normalized coords (team attacks +X). Index:
// 0 LB, 1 LCB, 2 RCB, 3 RB, 4 LCM, 5 CDM, 6 RCM, 7 LW, 8 ST, 9 RW
const F433 = [
  { x: -34, z: -23 }, { x: -37, z: -8.5 }, { x: -37, z: 8.5 }, { x: -34, z: 23 },
  { x: -15, z: -13 }, { x: -21, z: 0 }, { x: -15, z: 13 },
  { x: 3, z: -25 }, { x: 7, z: 0 }, { x: 3, z: 25 },
];

export function createMatch(ctx, { ball, teams, pitch }) {
  const rng = ctx.rng;

  // ---- squads --------------------------------------------------------------
  const listOf = (t) => (Array.isArray(t) ? t : (t && t.players) || []);
  const referee =
    (teams.players || []).find((p) => p && (p.role === 'REF' || !p.team)) || null;

  function buildSquad(list, side) {
    const gk = list.find((p) => p.role === 'GK') || list[0];
    const out = list.filter((p) => p !== gk);
    const pr = { DF: 0, MF: 1, FW: 2 };
    out.sort((a, b) => (pr[a.role] ?? 1) - (pr[b.role] ?? 1));
    return { side, gk, out, all: list };
  }
  const squads = {
    home: buildSquad(listOf(teams.home), 'home'),
    away: buildSquad(listOf(teams.away), 'away'),
  };
  const meta = new Map(); // player -> { tackleCd }
  for (const s of ['home', 'away'])
    for (const p of squads[s].all) meta.set(p, { tackleCd: 0 });

  // ---- state ---------------------------------------------------------------
  const state = {
    phase: 'kickoff',
    score: { home: 0, away: 0 },
    clockSec: 0,
    half: 1,
    possession: null,
    excitement: 0.15,
    attackDirHome: 1,
  };

  const listeners = [];
  const emit = (type, data) => {
    for (const cb of listeners) { try { cb(type, data); } catch (e) { /* HUD errors must not kill sim */ } }
  };

  // ---- runtime -------------------------------------------------------------
  let controller = null;      // player currently dribbling
  let lastKicker = null;
  let lastTouchSide = 'home';
  let lockPlayer = null, kickLock = 0;   // kicker can't instantly re-claim
  let decisionT = 0, settleT = 0, touchPhase = 0;
  let kickoffT = 0, kickoffSide = 'home', kickoffNext = 'home';
  let goalT = 0;
  let passTarget = null, passT = 0;
  let restart = null;         // { taker, x, z, t, throwIn }
  let shot = null;            // { shooter, side, aimZ, aimY, willSave, gk }
  let sinceShot = 0;
  let pending = [];           // [{ t, fn }] delayed kicks / dives
  let userInput = null, userT = 0, ctrlPickT = 0;
  let manualPick = null, manualT = 0;   // manual player switch hold
  let endWhistled = false;

  const other = (s) => (s === 'home' ? 'away' : 'home');
  const dirFor = (s) => (s === 'home' ? state.attackDirHome : -state.attackDirHome);

  const TMP = v3(), TMP2 = v3();
  // Per-player target vectors: moveTo/face implementations may keep the
  // reference, so never hand the same temp vector to two players.
  const tgtMap = new Map();
  const tgtOf = (p) => {
    let t = tgtMap.get(p);
    if (!t) { t = v3(); tgtMap.set(p, t); }
    return t;
  };

  const d2 = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);
  const pdist = (a, b) => d2(a.pos.x, a.pos.z, b.pos.x, b.pos.z);
  const ballDist = (p) => d2(p.pos.x, p.pos.z, ball.pos.x, ball.pos.z);
  const ballSpeed = () => Math.hypot(ball.vel.x, ball.vel.z);

  function nearestOpp(p) {
    let best = null, bd = 1e9;
    for (const o of squads[other(p.team)].all) {
      const d = pdist(p, o);
      if (d < bd) { bd = d; best = o; }
    }
    return { opp: best, d: bd };
  }

  // opponents within ~1.5 m of the segment from→to (pass/shot lane)
  function laneBlockers(fx, fz, tx, tz, oppSide, skipGK) {
    let n = 0;
    const dx = tx - fx, dz = tz - fz;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1) return 0;
    for (const o of squads[oppSide].all) {
      if (skipGK && o.role === 'GK') continue;
      const t = ((o.pos.x - fx) * dx + (o.pos.z - fz) * dz) / len2;
      if (t < 0.07 || t > 0.93) continue;
      const px = fx + dx * t, pz = fz + dz * t;
      if (d2(o.pos.x, o.pos.z, px, pz) < 1.6) n++;
    }
    return n;
  }

  function spaceAhead(p) {
    const dir = dirFor(p.team);
    let best = 30;
    for (const o of squads[other(p.team)].all) {
      const fwd = (o.pos.x - p.pos.x) * dir;
      if (fwd < -1 || fwd > 12) continue;
      if (Math.abs(o.pos.z - p.pos.z) > 5) continue;
      const d = pdist(p, o);
      if (d < best) best = d;
    }
    return best;
  }

  // ---- formation spots -----------------------------------------------------
  // Block slides with ball x, leans toward ball z, compacts when defending.
  function spotFor(side, i, out) {
    const dir = dirFor(side);
    const poss = state.possession === side;
    const bx = ball.pos.x * dir, bz = ball.pos.z;
    const s = F433[Math.min(i, F433.length - 1)];
    let x = s.x + clamp(bx * 0.4, -13, 20) + (poss ? 6.5 : -5);
    x = clamp(x, -49, 46);
    // Lateral slide. A real block shuttles hard toward the ball's side: the
    // far full-back tucks central rather than holding his touchline, which is
    // what made him look stranded 40 m from play. Out of possession the block
    // also narrows, so the whole unit stays connected.
    const width = poss ? 1.0 : 0.62;
    const lean = poss ? 0.3 : 0.52;
    let z = s.z * width + bz * lean;
    // Never let anyone sit more than this far off the ball's line — the far
    // winger keeps some width in attack, defenders keep almost none.
    const maxOff = poss ? (s.x > 0 ? 26 : 20) : 15;
    z = clamp(z, bz - maxOff, bz + maxOff);
    z = clamp(z, -31.5, 31.5);
    return out.set(dir * x, 0, z);
  }

  // ---- ball control --------------------------------------------------------
  function gainControl(p) {
    controller = p;
    ball.controlledBy = p;
    state.possession = p.team;
    lastTouchSide = p.team;
    lastKicker = p;
    passTarget = null;
    shot = null;
    settleT = 0.3 + rng() * 0.25;
    decisionT = 0.18;
    ball.vel.multiplyScalar(0.2);
    if (ball.spin) ball.spin.multiplyScalar(0.3);
    if (ball.pos.y > 0.6) ball.pos.y = 0.4;
  }

  function releaseBall() {
    controller = null;
    ball.controlledBy = null;
  }

  // Delayed kick synced to the leg swing. Velocity/spin are snapshotted NOW
  // (callers pass reused temp vectors); the kick cancels if the ball is lost
  // during the wind-up.
  function kickBall(p, vel, spin, action, delay, after) {
    if (action && !p.actionBusy()) p.playAction(action);
    const v = vel.clone();
    const s = spin ? spin.clone() : null;
    const hadBall = controller === p;
    const doIt = () => {
      if (hadBall && controller !== p) return; // tackled during wind-up
      if (controller === p) releaseBall();
      ball.kick(v, s || undefined);
      lastKicker = p;
      lastTouchSide = p.team;
      lockPlayer = p;
      kickLock = 0.55;
      if (after) after();
    };
    if (delay > 0) pending.push({ t: delay, fn: doIt });
    else doIt();
  }

  // ---- passing -------------------------------------------------------------
  function bestPass(p) {
    const side = p.team, dir = dirFor(side);
    const oppSide = other(side);
    let best = null, bestScore = -1e9, bestAx = 0, bestAz = 0;
    const urg = clamp((sinceShot - 12) / 8, 0, 1);
    for (const m of squads[side].all) {
      if (m === p || m.role === 'GK') continue;
      // lead the runner + pull them toward goal
      const ax = m.pos.x + m.vel.x * 0.45 + dir * (m.role === 'FW' ? 4 : 2);
      const az = m.pos.z + m.vel.z * 0.45;
      const d = d2(p.pos.x, p.pos.z, ax, az);
      if (d < 5.5 || d > 32) continue;
      const progress = (ax - p.pos.x) * dir;
      let score = 0.4 + progress * 0.05 * (1 + urg * 0.8);
      // space around receiver
      let space = 20;
      for (const o of squads[oppSide].all) {
        const od = d2(o.pos.x, o.pos.z, ax, az);
        if (od < space) space = od;
      }
      score += Math.min(space, 9) * 0.09;
      score -= laneBlockers(p.pos.x, p.pos.z, ax, az, oppSide, false) * 0.85;
      if (m.role === 'FW') score += 0.28;
      if (m.star) score += 2.2;   // everyone looks for him first
      if (d > 25) score -= 0.3;
      if (progress < -13) score -= 0.7;
      if (score > bestScore) { bestScore = score; best = m; bestAx = ax; bestAz = az; }
    }
    return { target: best, score: bestScore, ax: bestAx, az: bestAz };
  }

  function doPass(p, target, ax, az, loftBias) {
    const dx = ax - ball.pos.x, dz = az - ball.pos.z;
    const dist = Math.hypot(dx, dz);
    const speed = clamp(dist * 0.62 + 7, 11, 18);
    const t = dist / speed;
    const vy = dist > 17 || loftBias ? 4.905 * t * (0.45 + (loftBias ? 0.3 : 0)) : 0.2;
    TMP.set((dx / dist) * speed, vy, (dz / dist) * speed);
    kickBall(p, TMP, null, 'pass', 0.12);
    passTarget = target;
    passT = 0;
  }

  // ---- shooting & saves ----------------------------------------------------
  function doShoot(p) {
    const dir = dirFor(p.team);
    const gx = dir * HALF_X;
    // The star is a cheat code: he picks a corner the keeper cannot reach and
    // the save roll is skipped entirely below.
    const cheat = !!p.star;
    // Close in, the keeper's body blocks a low corner however hard it is hit,
    // so the cheat lifts it over him instead and keeps the angle sane.
    const closeIn = cheat && Math.abs(gx - ball.pos.x) < 13;
    const aimZ = cheat
      ? (rng() < 0.5 ? -1 : 1) * (closeIn ? 1.9 + rng() * 0.7 : 2.9 + rng() * 0.45)
      : (rng() * 2 - 1) * 2.7;
    // Aim LOW for the cheat. Drag stretches the real flight time beyond the
    // flat solve below, so the ball always lands under where it was aimed; a
    // low target keeps it inside the frame even when that error is largest,
    // and a fast low ball that skips once still crosses the line.
    const aimY = cheat
      ? (closeIn ? 1.45 + rng() * 0.55 : 0.45 + rng() * 0.45)
      : 0.35 + rng() * 1.35;
    const dx = gx - ball.pos.x, dz = aimZ - ball.pos.z;
    const flat = Math.hypot(dx, dz);
    // A rocket, so the ballistic solve stays accurate from any distance and the
    // ball is past the keeper before he can get down. Ball clamps at 46 m/s.
    const speed = cheat
      ? clamp(33 + flat * 0.16, 33, 44)
      : clamp(21 + flat * 0.28 + rng() * 3, 22, 30);
    const t = flat / speed;
    // 0.8 under-compensates gravity on purpose for normal shots (it keeps them
    // dipping). The cheat over-compensates instead, to cancel the extra fall
    // that drag-lengthened flight time introduces — but the gravity term scales
    // with t while the drag error does not, so a flat 1.3 that lands sweetly
    // from 6 m sends a 55 m shot a clear metre over the bar. Taper it.
    const gFactor = cheat ? clamp(1.32 - flat * 0.008, 1.0, 1.32) : 0.8;
    const vy = (aimY - ball.pos.y) / t + 4.905 * t * gFactor;
    TMP.set((dx / flat) * speed, vy, (dz / flat) * speed);
    const curl = (rng() - 0.5) * 9;
    const gk = squads[other(p.team)].gk;
    const saveP = clamp(
      0.52 + (flat - 12) * 0.022 - (Math.abs(aimZ) / 3.6) * 0.32 - (aimY > 1.6 ? 0.12 : 0),
      0.15, 0.85);
    const willSave = cheat ? false : rng() < saveP;
    const side = p.team;
    kickBall(p, TMP, TMP2.set(0, curl, 0), 'shoot', 0.14, () => {
      shot = { shooter: p, side, aimZ, aimY, willSave, gk };
      sinceShot = 0;
      state.excitement = Math.max(state.excitement, 0.55);
      // schedule the keeper's dive just before arrival
      const sGoal = Math.sign(gx);
      const diveAct = (aimZ - gk.pos.z) * sGoal > 0 ? 'gk_dive_left' : 'gk_dive_right';
      const lead = Math.max(0, t - 0.42);
      pending.push({ t: lead, fn: () => { if (!gk.actionBusy()) gk.playAction(diveAct); } });
    });
  }

  function monitorShot() {
    if (!shot) return;
    // The star's shot is a cheat: the keeper is a spectator. Returning before
    // the catch branch as well as the save branch is what makes "any shot is a
    // goal" hold at point-blank range, where a body in the way beats any aim.
    if (shot.shooter && shot.shooter.star) {
      if (ballSpeed() < 5) shot = null;
      return;
    }
    const gk = shot.gk;
    const sp = ballSpeed();
    if (sp < 5) { shot = null; return; } // died en route → loose ball
    const gd = ballDist(gk);
    // clean catch on slow, close shots
    if (sp < 11 && gd < 1.7 && ball.pos.y < 2.1) {
      const s = shot; shot = null;
      if (!gk.actionBusy()) gk.playAction('gk_catch');
      gainControl(gk);
      settleT = 1.1;
      state.excitement = Math.max(state.excitement, 0.6);
      emit('save', { gk: { number: gk.number, name: gk.name }, shooter: s.shooter && s.shooter.number, side: s.side, catch: true });
      return;
    }
    if (!shot.willSave) return;
    const nearLine = Math.abs(ball.pos.x) > HALF_X - 1.35;
    if (nearLine || gd < 1.35) {
      const s = shot; shot = null;
      const sGoal = dirFor(s.side);
      ball.controlledBy = null;
      TMP.set(-sGoal * (4 + rng() * 4), 2 + rng() * 3,
        Math.sign(s.aimZ || rng() - 0.5) * (4 + rng() * 5));
      ball.kick(TMP.clone());
      lastTouchSide = other(s.side);
      lastKicker = gk;
      lockPlayer = gk; kickLock = 0.5;
      state.excitement = Math.max(state.excitement, 0.75);
      emit('save', { gk: { number: gk.number, name: gk.name }, shooter: s.shooter && s.shooter.number, side: s.side, catch: false });
    }
  }

  // ---- carrier brain -------------------------------------------------------
  function decide(p) {
    const dir = dirFor(p.team);
    const gx = dir * HALF_X;
    const distG = d2(p.pos.x, p.pos.z, gx, 0);
    const urg = clamp((sinceShot - 12) / 8, 0, 1);
    const near = nearestOpp(p);
    // shoot
    let uShoot = -1;
    // The star shoots from anywhere inside his own half's edge and always
    // fancies it — he cannot miss, so hesitating would be out of character.
    const range = p.star ? 60 : 21 + 9 * urg;
    if (distG < range) {
      const blockers = laneBlockers(p.pos.x, p.pos.z, gx, 0, other(p.team), true);
      uShoot = 1.15 * (1 - distG / 36) + 0.9 * urg - 0.45 * blockers +
        (p.role === 'FW' ? 0.15 : 0);
      if (p.star) uShoot = 3.0 - distG * 0.012; // blockers are irrelevant to him
    }
    if (urg >= 1 && distG < 34) uShoot = 99; // late-window forcing: get a shot away
    // pass
    const bp = bestPass(p);
    let uPass = bp.target
      ? 0.42 + bp.score * 0.5 + (near.d < 2.6 ? 0.4 : 0) + urg * 0.1
      : -1;
    // dribble
    const ahead = spaceAhead(p);
    let uDrib = 0.55 + clamp(ahead - 3, 0, 6) * 0.07 - (near.d < 2.1 ? 0.45 : 0) - urg * 0.2;
    if (p.pos.x * dir > 40) uDrib -= 0.35;

    if (uShoot >= uPass && uShoot >= uDrib) doShoot(p);
    else if (uPass >= uDrib && bp.target) doPass(p, bp.target, bp.ax, bp.az, false);
    // else keep dribbling
  }

  function dribbleMove(p) {
    const dir = dirFor(p.team);
    // steer at goal, veer around the nearest defender in the path
    let tx = dir * HALF_X, tz = p.pos.z * 0.4;
    let sx = tx - p.pos.x, sz = tz - p.pos.z;
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl; sz /= sl;
    const near = nearestOpp(p);
    if (near.opp && near.d < 5) {
      const fwd = (near.opp.pos.x - p.pos.x) * dir;
      if (fwd > -0.5) {
        const side = Math.sign(p.pos.z - near.opp.pos.z) || (rng() < 0.5 ? 1 : -1);
        sz += side * (1.2 - near.d * 0.18); // veer off the defender's shoulder
        const l2 = Math.hypot(sx, sz) || 1;
        sx /= l2; sz /= l2;
      }
    }
    const t = tgtOf(p).set(p.pos.x + sx * 6, 0, clamp(p.pos.z + sz * 6, -HALF_Z + 1, HALF_Z - 1));
    p.moveTo(t, near.d < 3.5 ? 0.95 : 0.8);
    if (Math.hypot(p.vel.x, p.vel.z) > 0.8) p.face(Math.atan2(p.vel.z, p.vel.x));
  }

  function glueBall(p, dt) {
    touchPhase += (Math.hypot(p.vel.x, p.vel.z) * 2.0 + 2.0) * dt;
    const lead = 0.4 + 0.13 * Math.max(0, Math.sin(touchPhase)); // knock-on touches
    const fx = Math.cos(p.facing), fz = Math.sin(p.facing);
    ball.pos.x = p.pos.x + fx * lead;
    ball.pos.z = p.pos.z + fz * lead;
    ball.vel.x = p.vel.x;
    ball.vel.z = p.vel.z;
  }

  function gkCarrier(p, dt) {
    p.stop();
    p.face(dirFor(p.team) > 0 ? 0 : Math.PI); // open up the field
    settleT -= dt;
    if (settleT > 0) return;
    // distribute long to the most advanced open runner
    const dir = dirFor(p.team);
    let best = null, bs = -1e9, bax = 0, baz = 0;
    for (const m of squads[p.team].out) {
      const ax = m.pos.x + m.vel.x * 0.6 + dir * 5;
      const az = m.pos.z + m.vel.z * 0.6;
      const d = d2(p.pos.x, p.pos.z, ax, az);
      if (d < 12 || d > 46) continue;
      let s = (ax - p.pos.x) * dir * 0.05;
      let space = 20;
      for (const o of squads[other(p.team)].all) space = Math.min(space, d2(o.pos.x, o.pos.z, ax, az));
      s += Math.min(space, 10) * 0.08;
      if (s > bs) { bs = s; best = m; bax = ax; baz = az; }
    }
    if (best) {
      const dx = bax - ball.pos.x, dz = baz - ball.pos.z;
      const dist = Math.hypot(dx, dz);
      const speed = clamp(dist * 0.5 + 8, 14, 22);
      const t = dist / speed;
      TMP.set((dx / dist) * speed, 4.905 * t * 0.75, (dz / dist) * speed);
      kickBall(p, TMP, null, 'pass', 0.14);
      passTarget = best; passT = 0;
    } else settleT = 0.4;
  }

  function carrierTick(p, dt) {
    glueBall(p, dt);
    if (p.role === 'GK') { gkCarrier(p, dt); return; }
    if (p === match.controlledPlayer && userT > 0) { userCarrier(p); return; }
    settleT -= dt;
    decisionT -= dt;
    if (settleT > 0) {
      p.face(Math.atan2(-p.pos.z, dirFor(p.team) * HALF_X - p.pos.x));
      const t = tgtOf(p).set(
        p.pos.x + Math.cos(p.facing) * 1.2, 0, p.pos.z + Math.sin(p.facing) * 1.2);
      p.moveTo(t, 0.3);
      return;
    }
    dribbleMove(p);
    if (decisionT <= 0) {
      decisionT = 0.32 + rng() * 0.22;
      decide(p);
    }
  }

  // ---- user control --------------------------------------------------------
  function pickControlled(dt) {
    // A manual switch has to survive the carrier rule below. Without this the
    // selection snapped straight back to whoever had the ball on the very next
    // tick, and since Draguignan dominate possession the switch button looked
    // completely dead. Holding the choice briefly lets you leave the carrier to
    // the AI and go make a run.
    manualT = Math.max(0, manualT - dt);
    if (manualT > 0 && manualPick) {
      match.controlledPlayer = manualPick;
      return;
    }
    if (controller && controller.team === 'home' && controller.role !== 'GK') {
      match.controlledPlayer = controller;
      return;
    }
    ctrlPickT -= dt;
    if (ctrlPickT > 0 && match.controlledPlayer) return;
    ctrlPickT = 0.3;
    const cur = match.controlledPlayer;
    // While the user is actively steering, hold onto their player. Yanking the
    // selection to whoever drifted nearest the ball mid-run makes the keyboard
    // feel like it does nothing. Possession changes still reassign, above.
    if (userT > 0 && cur && ballDist(cur) < 34) return;
    let best = null, bd = 1e9;
    for (const p of squads.home.out) {
      const d = ballDist(p);
      if (d < bd) { bd = d; best = p; }
    }
    if (cur && cur !== best && ballDist(cur) < bd + 1.5) return; // hysteresis
    match.controlledPlayer = best;
  }

  function userMove(p) {
    const m = userInput.moveVec || { x: 0, z: 0 };
    const len = Math.hypot(m.x, m.z);
    if (len > 0.05) {
      const t = tgtOf(p).set(p.pos.x + (m.x / len) * 4, 0, p.pos.z + (m.z / len) * 4);
      // Analog sticks give a real jog/run range; the keyboard is always full tilt.
      const tilt = clamp(userInput.magnitude != null ? userInput.magnitude : 1, 0, 1);
      const speed = userInput.sprint ? 1 : clamp(0.35 + tilt * 0.45, 0.35, 0.8);
      p.moveTo(t, speed);
      p.face(Math.atan2(m.z, m.x));
    } else {
      p.stop();
      p.face(ball.pos);
    }
  }

  // Defending: the pass button presses/contains, the shoot button commits to a
  // slide. Mirrors what those buttons do in a football game when you're off the
  // ball, so the pad never feels dead.
  function userDefend(p, dt) {
    if (!userInput) return;
    if (userInput.passPressed || userInput.throughPressed) tryTackle(p, dt);
    if (userInput.shootPressed) {
      const m = meta.get(p);
      if (m && m.tackleCd <= 0 && controller && controller.team !== p.team &&
          pdist(p, controller) < 2.6) {
        m.tackleCd = 1.9;
        if (!p.actionBusy()) p.playAction('tackle');
        if (pdist(p, controller) < 1.5 && rng() < 0.62) {
          const dir = dirFor(p.team);
          releaseBall();
          TMP.set(dir * (2.5 + rng() * 3) + (rng() - 0.5) * 3, 1 + rng(), (rng() - 0.5) * 5);
          ball.kick(TMP.clone());
          lastTouchSide = p.team; lastKicker = p;
        }
      }
    }
  }

  function userCarrier(p) {
    userMove(p);
    if (userInput.shootPressed) { doShoot(p); return; }
    if (userInput.throughPressed) { doThroughBall(p, false); return; }
    if (userInput.loftedPressed) { doThroughBall(p, true); return; }
    if (userInput.passPressed) {
      const bp = bestPass(p);
      if (bp.target) doPass(p, bp.target, bp.ax, bp.az, false);
    }
  }

  // Through ball: unlike a normal pass this ignores feet and plays the ball
  // into the SPACE a runner is attacking, biased toward whichever direction the
  // stick is pushed. Lofted variant chips the same ball over the last line.
  function doThroughBall(p, lofted) {
    const side = p.team, dir = dirFor(side);
    const m = (userInput && userInput.moveVec) || { x: 0, z: 0 };
    const aimLen = Math.hypot(m.x, m.z);
    let best = null, bestScore = -1e9, bx = 0, bz = 0;
    for (const t of squads[side].all) {
      if (t === p || t.role === 'GK') continue;
      // Lead the runner hard into space ahead of him.
      const lead = lofted ? 11 : 8.5;
      const ax = t.pos.x + t.vel.x * 0.7 + dir * lead;
      const az = t.pos.z + t.vel.z * 0.7;
      if (Math.abs(ax) > HALF_X - 1.5 || Math.abs(az) > HALF_Z - 1) continue;
      const d = d2(p.pos.x, p.pos.z, ax, az);
      if (d < 7 || d > 42) continue;
      const progress = (ax - p.pos.x) * dir;
      if (progress < 2) continue;                       // must actually go forward
      let score = progress * 0.09;
      // Space at the landing spot matters more than for a normal pass.
      let space = 25;
      for (const o of squads[other(side)].all) {
        const od = d2(o.pos.x, o.pos.z, ax, az);
        if (od < space) space = od;
      }
      score += Math.min(space, 12) * 0.13;
      // A lofted ball can clear bodies; a grounded one cannot.
      score -= laneBlockers(p.pos.x, p.pos.z, ax, az, other(side), false) * (lofted ? 0.35 : 1.1);
      if (t.role === 'FW') score += 0.5;
      // Honour the stick: reward targets in the direction the player is aiming.
      if (aimLen > 0.2) {
        const tx = (ax - p.pos.x) / d, tz = (az - p.pos.z) / d;
        score += ((tx * m.x + tz * m.z) / aimLen) * 1.6;
      }
      if (score > bestScore) { bestScore = score; best = t; bx = ax; bz = az; }
    }
    if (!best) {                                        // nothing on — safe pass
      const bp = bestPass(p);
      if (bp.target) doPass(p, bp.target, bp.ax, bp.az, lofted);
      return;
    }
    const dx = bx - ball.pos.x, dz = bz - ball.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const speed = lofted ? clamp(dist * 0.5 + 9, 13, 21) : clamp(dist * 0.7 + 9, 14, 23);
    const t = dist / speed;
    const vy = lofted ? 4.905 * t * 1.15 : (dist > 20 ? 4.905 * t * 0.35 : 0.15);
    TMP.set((dx / dist) * speed, vy, (dz / dist) * speed);
    kickBall(p, TMP, null, 'pass', lofted ? 0.16 : 0.12);
    passTarget = best;
    passT = 0;
  }

  // Manual player switch (L / R on a pad, Q or Tab on the keyboard): cycle to
  // the next-best candidate by distance to the ball, skipping the current one.
  // Switch to the outfielder NEAREST THE BALL, excluding whoever is already
  // selected. Not a cycle through the whole squad: walking down a
  // distance-sorted list sends you further from the action on every press,
  // which is the opposite of what the button is for.
  function switchControlled() {
    const cur = match.controlledPlayer;
    let best = null, bd = Infinity;
    for (const p of squads.home.out) {
      if (p === cur) continue;
      const d = ballDist(p);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    match.controlledPlayer = best;
    manualPick = best;
    manualT = 4;      // survives the carrier rule in pickControlled
    ctrlPickT = 0.6;
  }

  // ---- off-ball movement ---------------------------------------------------
  function offBall(dt) {
    // predicted loose-ball point
    const lx = ball.pos.x + ball.vel.x * 0.4;
    const lz = ball.pos.z + ball.vel.z * 0.4;
    for (const side of ['home', 'away']) {
      const sq = squads[side];
      const oppHasBall = controller && controller.team !== side;
      const loose = !controller && state.phase === 'play'; // no swarming dead balls
      // choose pressers/chasers: nearest 1-2 only, everyone else keeps shape
      let p1 = null, p2 = null, d1 = 1e9, d2v = 1e9;
      for (const p of sq.out) {
        const d = d2(p.pos.x, p.pos.z, lx, lz);
        if (d < d1) { p2 = p1; d2v = d1; p1 = p; d1 = d; }
        else if (d < d2v) { p2 = p; d2v = d; }
      }
      for (let i = 0; i < sq.out.length; i++) {
        const p = sq.out[i];
        if (p === controller) continue;
        if (p === passTarget) { // run to meet the pass
          const t = tgtOf(p).set(
            ball.pos.x + ball.vel.x * 0.35, 0, ball.pos.z + ball.vel.z * 0.35);
          p.moveTo(t, 1);
          p.face(ball.pos);
          continue;
        }
        if (p === match.controlledPlayer && userT > 0) {
          userMove(p); tryTackle(p, dt); userDefend(p, dt); continue;
        }
        if (restart && p === restart.taker) continue; // handled by restart flow
        const press1 = (oppHasBall || loose) && p === p1;
        const press2 = oppHasBall && p === p2 && d2v < 11;
        if (press1 || press2) {
          // press goal-side of the ball
          const dir = dirFor(side);
          const t = tgtOf(p).set(lx - dir * 0.9, 0, lz);
          p.moveTo(t, press1 ? 1 : 0.9);
          p.face(ball.pos);
          tryTackle(p, dt);
          continue;
        }
        const t = spotFor(side, i, tgtOf(p));
        const d = d2(p.pos.x, p.pos.z, t.x, t.z);
        if (d > 0.6) p.moveTo(t, clamp(d / 9, 0.25, 0.85));
        else p.stop();
        p.face(ball.pos);
      }
      gkTick(sq, dt);
    }
    refTick();
  }

  function tryTackle(p, dt) {
    if (!controller || controller.team === p.team) return;
    const m = meta.get(p);
    if (!m || m.tackleCd > 0) return;
    if (pdist(p, controller) > 1.15) return;
    m.tackleCd = 1.6;
    if (!p.actionBusy()) p.playAction('tackle');
    if (rng() < 0.55) {
      const dir = dirFor(p.team);
      const victim = controller;
      releaseBall();
      TMP.set(dir * (2.5 + rng() * 3) + (rng() - 0.5) * 3, 1 + rng(), (rng() - 0.5) * 5);
      ball.kick(TMP.clone());
      lastTouchSide = p.team;
      lastKicker = p;
      lockPlayer = victim; kickLock = 0.6;
    }
  }

  function gkTick(sq, dt) {
    const gk = sq.gk;
    if (gk === controller) return;
    const dir = dirFor(sq.side);
    const gx = -dir * HALF_X; // own goal
    const tbx = ball.pos.x - gx, tbz = ball.pos.z;
    const d = Math.hypot(tbx, tbz) || 1;
    const off = clamp(d * 0.1, 0.7, 4);
    let px = gx + (tbx / d) * off;
    let pz = clamp((tbz / d) * off * 1.6 + ball.pos.z * 0.06, -3.3, 3.3);
    px = clamp(px, Math.min(gx + dir * 0.5, gx + dir * 5), Math.max(gx + dir * 0.5, gx + dir * 5));
    const t = tgtOf(gk).set(px, 0, pz);
    const gd = d2(gk.pos.x, gk.pos.z, px, pz);
    if (gd > 0.25) gk.moveTo(t, clamp(gd / 3, 0.25, 0.85));
    else gk.stop();
    gk.face(ball.pos);
    // sweep up slow loose balls in the box
    if (!controller && !shot && ballDist(gk) < 1.5 && ballSpeed() < 6 && ball.pos.y < 1.2) {
      if (!gk.actionBusy()) gk.playAction('gk_catch');
      gainControl(gk);
      settleT = 1.1;
    }
  }

  function refTick() {
    if (!referee) return;
    const t = tgtOf(referee).set(
      clamp(ball.pos.x * 0.78, -46, 46), 0, clamp(ball.pos.z * 0.5 + 4, -27, 27));
    const d = d2(referee.pos.x, referee.pos.z, t.x, t.z);
    if (d > 3) referee.moveTo(t, clamp(d / 14, 0.35, 0.8));
    else referee.stop();
    referee.face(ball.pos);
  }

  // ---- claims (loose balls / receptions) -----------------------------------
  function claims() {
    if (controller) return;
    const sp = ballSpeed();
    if (ball.pos.y > 1.25) return;
    let best = null, bd = 1e9;
    for (const side of ['home', 'away']) {
      for (const p of squads[side].all) {
        if (p === lockPlayer && kickLock > 0) continue;
        if (p.role === 'GK' && ballDist(p) > 14) continue;
        const d = ballDist(p);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (!best || bd > 1.05) return;
    // A keeper may normally pluck a fast ball out of the air — that is the
    // point-blank stop. Not against the star: his shots are uncatchable.
    if (shot && shot.shooter && shot.shooter.star && best.role === 'GK') return;
    // fast balls can only be trapped by the intended receiver (or GK)
    if (sp > 12 && best !== passTarget && best.role !== 'GK') return;
    gainControl(best);
  }

  // ---- bounds / goals / restarts -------------------------------------------
  function checkBounds() {
    const r = ball.radius || 0.11;
    const bx = ball.pos.x, bz = ball.pos.z, by = ball.pos.y;
    if (Math.abs(bx) > HALF_X + r * 0.6) {
      const inFrame = Math.abs(bz) < GOAL.width / 2 - 0.03 && by < GOAL.height - 0.03;
      if (inFrame && Math.abs(bx) < HALF_X + GOAL.depth + 1) onGoal(bx > 0);
      else onOut(bx, bz, true);
      return true;
    }
    if (Math.abs(bz) > HALF_Z + r * 0.6) { onOut(bx, bz, false); return true; }
    return false;
  }

  function onGoal(plusX) {
    const side = plusX === (state.attackDirHome > 0) ? 'home' : 'away';
    state.score[side]++;
    state.phase = 'goal';
    goalT = 4.3;
    state.excitement = 1;
    shot = null; passTarget = null;
    pending.length = 0;
    releaseBall();
    ball.vel.multiplyScalar(0.22); // net catches it
    kickoffNext = other(side);
    const scorer =
      lastKicker && lastKicker.team === side
        ? lastKicker
        : squads[side].out[Math.min(8, squads[side].out.length - 1)];
    emit('goal', {
      team: side,
      scorer: scorer ? { number: scorer.number, name: scorer.name } : null,
      score: { home: state.score.home, away: state.score.away },
    });
    if (scorer) scorer.playAction('celebrate');
    // two nearest teammates join in, slightly staggered
    const mates = squads[side].out
      .filter((p) => p !== scorer)
      .sort((a, b) => pdist(a, scorer) - pdist(b, scorer))
      .slice(0, 2);
    mates.forEach((m, i) =>
      pending.push({ t: 0.25 + i * 0.2, fn: () => { if (!m.actionBusy()) m.playAction('celebrate'); } }));
  }

  function onOut(bx, bz, goalLine) {
    const restartSide = other(lastTouchSide || 'home');
    const throwIn = !goalLine;
    let x = clamp(bx, -HALF_X + 1.2, HALF_X - 1.2);
    let z = clamp(bz, -HALF_Z + 1.2, HALF_Z - 1.2);
    let taker = null;
    // goal-line out behind the restart side's own goal → goal-kick style from the GK
    const dirR = dirFor(restartSide);
    if (goalLine && Math.sign(bx) === -dirR) {
      x = -dirR * (HALF_X - 6);
      z = clamp(z, -9, 9);
      taker = squads[restartSide].gk;
    } else {
      let bd = 1e9;
      for (const p of squads[restartSide].out) {
        const d = d2(p.pos.x, p.pos.z, x, z);
        if (d < bd) { bd = d; taker = p; }
      }
    }
    ball.place(x, z);
    if (ball.stopDead) ball.stopDead();
    shot = null; passTarget = null;
    pending.length = 0;
    releaseBall();
    state.phase = 'out';
    state.possession = restartSide;
    restart = { taker, x, z, t: 3, throwIn };
    emit('out', { team: restartSide, x, z, throwIn });
  }

  function updateRestart(dt) {
    if (!restart) { state.phase = 'play'; return; }
    const { taker } = restart;
    restart.t -= dt;
    const t = tgtOf(taker).set(restart.x, 0, restart.z);
    const d = d2(taker.pos.x, taker.pos.z, restart.x, restart.z);
    if (d > 1.3 && restart.t > 0) {
      taker.moveTo(t, 1);
      taker.face(ball.pos);
      return;
    }
    if (restart.throwIn && !taker.actionBusy()) taker.playAction('throw_in');
    gainControl(taker);
    settleT = taker.role === 'GK' ? 0.9 : 0.45;
    restart = null;
    state.phase = 'play';
  }

  // ---- kickoff -------------------------------------------------------------
  function placeKickoff(side) {
    state.phase = 'kickoff';
    kickoffSide = side;
    kickoffT = 0.8;
    releaseBall();
    passTarget = null; shot = null; restart = null;
    pending.length = 0;
    ball.place(0, 0);
    if (ball.stopDead) ball.stopDead();
    for (const s of ['home', 'away']) {
      const sq = squads[s];
      const dir = dirFor(s);
      const kicking = s === side;
      sq.gk.pos.set(dir * -50.5, 0, 0);
      sq.gk.vel.set(0, 0, 0);
      sq.gk.stop();
      sq.gk.face(ball.pos);
      sq.out.forEach((p, i) => {
        const base = F433[Math.min(i, F433.length - 1)];
        let x = base.x * 0.82, z = base.z * 0.85;
        x = Math.min(x, -3.2);
        if (!kicking && Math.hypot(x, z) < 10.2)
          x = -Math.sqrt(Math.max(1, 104 - z * z)) - 0.6;
        if (kicking && i === 8) { x = -1.1; z = 0.25; }   // ST takes it
        if (kicking && i === 7) { x = -1.9; z = -2.8; }   // LW stands in support
        p.pos.set(dir * x, 0, z);
        p.vel.set(0, 0, 0);
        p.stop();
        p.face(ball.pos);
      });
    }
    if (referee) {
      referee.pos.set(-2.5, 0, -7);
      referee.vel.set(0, 0, 0);
      referee.stop();
      referee.face(ball.pos);
    }
    emit('whistle', { reason: 'kickoff', half: state.half });
  }

  function updateKickoff(dt) {
    kickoffT -= dt;
    if (kickoffT > 0) return;
    const sq = squads[kickoffSide];
    const taker = sq.out[Math.min(8, sq.out.length - 1)];
    const cdm = sq.out[Math.min(5, sq.out.length - 1)];
    state.phase = 'play';
    state.possession = kickoffSide;
    sinceShot = 0;
    state.excitement = Math.max(state.excitement, 0.3);
    const ax = cdm.pos.x, az = cdm.pos.z;
    const dx = ax - ball.pos.x, dz = az - ball.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const speed = clamp(dist * 0.62 + 7, 11, 16);
    TMP.set((dx / dist) * speed, 0.2, (dz / dist) * speed);
    lockPlayer = taker; kickLock = 0.4; // taker must not re-claim during wind-up
    kickBall(taker, TMP, null, 'pass', 0.12, () => { passTarget = cdm; passT = 0; });
    passTarget = cdm; passT = 0;
    emit('kickoff', { team: kickoffSide, half: state.half });
  }

  // ---- public --------------------------------------------------------------
  function setUserInput(input) {
    userInput = input || null;
    if (!input) return;
    const m = input.moveVec || { x: 0, z: 0 };
    if (Math.hypot(m.x, m.z) > 0.05 || input.passPressed || input.shootPressed ||
        input.throughPressed || input.loftedPressed || input.switchPressed)
      userT = 3;
    if (input.switchPressed) switchControlled();
  }

  function update(dt) {
    // timers
    kickLock = Math.max(0, kickLock - dt);
    userT = Math.max(0, userT - dt);
    for (const m of meta.values()) m.tackleCd = Math.max(0, m.tackleCd - dt);
    for (let i = pending.length - 1; i >= 0; i--) {
      pending[i].t -= dt;
      if (pending[i].t <= 0) { const f = pending[i].fn; pending.splice(i, 1); f(); }
    }
    // excitement
    state.excitement = clamp(state.excitement - 0.3 * dt, 0.12, 1);
    if (state.phase === 'goal') state.excitement = Math.max(state.excitement, 0.95);
    // clock (6x speed while ball is in play-flow)
    if (state.phase === 'play' || state.phase === 'out') {
      state.clockSec = Math.min(state.clockSec + 6 * dt, 5400);
      if (state.half === 1 && state.clockSec >= 2700) {
        state.half = 2;
        state.attackDirHome *= -1;
        emit('whistle', { reason: 'halftime' });
        placeKickoff('away');
        return;
      }
      if (state.clockSec >= 5400 && !endWhistled) {
        endWhistled = true;
        emit('whistle', { reason: 'fulltime' });
      }
    }
    if (state.phase === 'play') sinceShot += dt;

    switch (state.phase) {
      case 'kickoff':
        updateKickoff(dt);
        break;
      case 'goal':
        goalT -= dt;
        // non-celebrating players drift back into shape
        for (const s of ['home', 'away'])
          squads[s].out.forEach((p, i) => {
            if (p.actionBusy()) return;
            p.moveTo(spotFor(s, i, tgtOf(p)), 0.3);
          });
        if (goalT <= 0) placeKickoff(kickoffNext);
        break;
      case 'out':
        updateRestart(dt);
        if (state.phase === 'out') { offBall(dt); pickControlled(dt); }
        break;
      case 'play': {
        if (checkBounds()) break;
        monitorShot();
        if (controller) {
          carrierTick(controller, dt);
        } else {
          passT += dt;
          if (passTarget && (passT > 4 || ballSpeed() < 2)) {
            if (ballSpeed() < 2 && ballDist(passTarget) > 6) passTarget = null;
            else if (passT > 4) passTarget = null;
          }
          claims();
        }
        offBall(dt);
        pickControlled(dt);
        break;
      }
    }
    updateIndicator(dt);
  }

  // ---- "you are this player" marker ----------------------------------------
  // Without this the game reads as a pure attract mode: input works, but with
  // 22 identical-sized figures on screen you cannot tell which one answers to
  // the keyboard. Ring on the grass + chevron above the head, exactly the
  // affordance every football game uses.
  const indicator = new THREE.Group();
  indicator.visible = false;
  {
    const ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(2.2, 0.35, 0.45),
      transparent: true, opacity: 0.9, toneMapped: false,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.58, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    ring.renderOrder = 3;
    indicator.add(ring);

    const chevMat = new THREE.MeshBasicMaterial({
      // Near-white so it stays legible above a red shirt as well as a white one.
      color: new THREE.Color().setRGB(2.6, 2.5, 2.2),
      transparent: true, opacity: 0.95, toneMapped: false,
      depthWrite: false, side: THREE.DoubleSide,
    });
    // Downward-pointing triangle, billboarded each frame toward the camera.
    const tri = new THREE.Shape();
    tri.moveTo(-0.17, 0.25); tri.lineTo(0.17, 0.25); tri.lineTo(0, 0);
    const chev = new THREE.Mesh(new THREE.ShapeGeometry(tri), chevMat);
    chev.position.y = 2.12;
    chev.renderOrder = 3;
    indicator.add(chev);
    indicator.userData = { ring, chev, ringMat, chevMat, t: 0 };
  }
  ctx.scene.add(indicator);

  function updateIndicator(dt) {
    const p = match.controlledPlayer;
    if (!p) { indicator.visible = false; return; }
    indicator.visible = true;
    const u = indicator.userData;
    u.t += dt;
    indicator.position.set(p.pos.x, 0, p.pos.z);
    // Bob the chevron and pulse the ring; brighter while the user is actually
    // driving, dimmer when the AI has taken back over.
    const active = userT > 0;
    const pulse = 0.82 + 0.18 * Math.sin(u.t * (active ? 6 : 2.4));
    u.chev.position.y = 2.12 + Math.sin(u.t * 3) * 0.05;
    u.ringMat.opacity = (active ? 0.95 : 0.45) * pulse;
    u.chevMat.opacity = (active ? 1.0 : 0.5) * pulse;
    u.ring.scale.setScalar(active ? 1 : 0.9);
    if (ctx.camera) u.chev.quaternion.copy(ctx.camera.quaternion);
  }

  const match = {
    state,
    update,
    onEvent(cb) { listeners.push(cb); },
    setUserInput,
    controlledPlayer: null,
  };

  // initial setup: everyone in position, whistle, kickoff within ~1 s
  placeKickoff('home');
  pickControlled(1);

  return match;
}
