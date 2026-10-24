// Keyboard + gamepad input, unified into game intents.
//
// Movement is read in SCREEN space and converted to world axes for the
// broadcast camera (on −Z looking toward +Z): that camera's right vector is
// world −X, and screen-up on the ground plane is world +Z.
//
// Gamepad face buttons are addressed by POSITION, not by letter, because the
// Gamepad API's "standard" mapping indexes them by physical position while
// Nintendo prints the letters in a different arrangement than Xbox:
//   buttons[0] = bottom   -> Switch B   (Xbox A)
//   buttons[1] = right    -> Switch A   (Xbox B)
//   buttons[2] = left     -> Switch Y   (Xbox X)
//   buttons[3] = top      -> Switch X   (Xbox Y)
// So the labels below are Switch labels; the behaviour is position-based and
// works on an Xbox/PS pad too.

import { createTouchControls, isTouchDevice } from './touch.js';

const BTN = {
  bottom: 0,   // Switch B — short pass / (defending) press-tackle
  right: 1,    // Switch A — shoot / (defending) slide tackle
  left: 2,     // Switch Y — through ball
  top: 3,      // Switch X — lofted through ball
  L: 4,        // switch player
  R: 5,        // switch player (alt)
  ZL: 6,       // — reserved
  ZR: 7,       // sprint
  minus: 8,
  plus: 9,
};

const DEADZONE = 0.24;

export function createInput() {
  const down = new Set();
  const pressed = new Set();

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    down.add(e.code);
    pressed.add(e.code);
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => down.delete(e.code));
  window.addEventListener('blur', () => down.clear());

  // Gamepad edge detection: the API only exposes level state, so we diff it.
  let padPrev = [];
  let padName = null;
  window.addEventListener('gamepadconnected', (e) => { padName = e.gamepad.id; });
  window.addEventListener('gamepaddisconnected', () => { padName = null; padPrev = []; });

  function readPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) { padPrev = []; return null; }
    padName = pad.id;

    const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    const edge = (i) => btn(i) && !padPrev[i];

    // Left stick, with a radial deadzone and rescaling so slow walks are
    // possible right outside the deadzone rather than snapping to full speed.
    let ax = pad.axes[0] || 0, ay = pad.axes[1] || 0;
    let mag = Math.hypot(ax, ay);
    if (mag < DEADZONE) { ax = 0; ay = 0; mag = 0; }
    else {
      const scaled = (mag - DEADZONE) / (1 - DEADZONE);
      ax = (ax / mag) * scaled; ay = (ay / mag) * scaled;
      mag = scaled;
    }
    // D-pad falls back to the stick when the stick is idle.
    if (mag === 0) {
      if (btn(12)) ay = -1; if (btn(13)) ay = 1;
      if (btn(14)) ax = -1; if (btn(15)) ax = 1;
      mag = Math.hypot(ax, ay);
      if (mag > 1) { ax /= mag; ay /= mag; mag = 1; }
    }

    const out = {
      // stick +x = screen-right, stick +y = screen-DOWN (API convention)
      sx: ax, sy: -ay, mag,
      sprint: btn(BTN.ZR) || (pad.buttons[7] && pad.buttons[7].value > 0.4),
      pass: edge(BTN.bottom),
      shoot: edge(BTN.right),
      through: edge(BTN.left),
      lofted: edge(BTN.top),
      switchPlayer: edge(BTN.L) || edge(BTN.R),
      name: pad.id,
    };
    padPrev = pad.buttons.map((b) => b.pressed);
    return out;
  }

  const touch = isTouchDevice() ? createTouchControls() : null;

  return {
    get padName() { return padName; },
    get hasTouch() { return !!touch; },

    /** Call once per sim tick; press-events are consumed. */
    sample() {
      const pad = readPad();
      const tc = touch ? touch.sample() : null;

      let sx = 0, sy = 0, mag = 0;
      if (down.has('KeyA') || down.has('ArrowLeft')) sx -= 1;
      if (down.has('KeyD') || down.has('ArrowRight')) sx += 1;
      if (down.has('KeyW') || down.has('ArrowUp')) sy += 1;
      if (down.has('KeyS') || down.has('ArrowDown')) sy -= 1;
      mag = Math.hypot(sx, sy);
      if (mag > 1) { sx /= mag; sy /= mag; mag = 1; }

      // Gamepad, then touch, win whenever their stick is actually deflected.
      if (pad && pad.mag > 0) { sx = pad.sx; sy = pad.sy; mag = pad.mag; }
      else if (tc && tc.mag > 0) { sx = tc.sx; sy = tc.sy; mag = tc.mag; }

      // screen-right = world −X, screen-up = world +Z (camera on the −Z side)
      const x = -sx, z = sy;

      const out = {
        moveVec: { x, z },
        magnitude: mag,
        active: mag > 0,
        sprint: down.has('ShiftLeft') || down.has('ShiftRight') ||
          !!(pad && pad.sprint) || !!(tc && tc.sprint),
        passPressed: pressed.has('KeyX') || pressed.has('KeyZ') ||
          !!(pad && pad.pass) || !!(tc && tc.pass),
        shootPressed: pressed.has('Space') || !!(pad && pad.shoot) || !!(tc && tc.shoot),
        throughPressed: pressed.has('KeyC') || !!(pad && pad.through) || !!(tc && tc.through),
        loftedPressed: pressed.has('KeyV') || !!(pad && pad.lofted) || !!(tc && tc.lofted),
        switchPressed: pressed.has('KeyQ') || pressed.has('Tab') ||
          !!(pad && pad.switchPlayer) || !!(tc && tc.switchPlayer),
      };
      pressed.clear();
      return out;
    },
  };
}
