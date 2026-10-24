// Touch controls: a floating analog stick on the left, action pad on the right.
//
// Only mounts on coarse-pointer devices, so desktop is untouched. The stick is
// "floating": it appears wherever the thumb lands in the left half rather than
// at a fixed spot, which is what makes on-screen sticks usable without looking.
//
// Emits the same shape as the gamepad path in input.js: screen-space sx/sy plus
// edge-triggered action flags.

const STICK_R = 62;     // px, travel radius at scale 1
const KNOB_R = 30;

export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  try {
    // Primary pointer must be coarse. A touchscreen laptop reports a coarse
    // *any*-pointer while its primary pointer is a trackpad, and those users
    // have a keyboard — putting a thumbstick over their game would be wrong.
    if (window.matchMedia('(pointer: coarse)').matches) return true;
    return ('ontouchstart' in window) && navigator.maxTouchPoints > 0 &&
      !window.matchMedia('(any-pointer: fine)').matches;
  } catch (e) {
    return false;
  }
}

export function createTouchControls() {
  const state = {
    sx: 0, sy: 0, mag: 0,
    sprint: false,
    pass: false, shoot: false, through: false, lofted: false, switchPlayer: false,
    mounted: false,
  };
  if (typeof document === 'undefined') return { state, sample: () => state };

  const host = document.getElementById('hud') || document.body;
  const root = document.createElement('div');
  root.className = 'ft-root';
  root.innerHTML = `
    <div class="ft-stick" aria-hidden="true">
      <div class="ft-stick-base"></div><div class="ft-stick-knob"></div>
    </div>
    <div class="ft-pad">
      <button class="ft-btn ft-through" data-act="through">THRU</button>
      <button class="ft-btn ft-lob"     data-act="lofted">LOB</button>
      <button class="ft-btn ft-pass"    data-act="pass">PASS</button>
      <button class="ft-btn ft-shoot"   data-act="shoot">SHOOT</button>
    </div>
    <div class="ft-aux">
      <button class="ft-mini" data-act="switch">SWITCH</button>
      <button class="ft-mini ft-sprint" data-hold="sprint">SPRINT</button>
    </div>`;

  const style = document.createElement('style');
  style.textContent = `
  .ft-root{position:fixed;inset:0;pointer-events:none;z-index:20;
    font:600 13px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
    -webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
  .ft-stick{position:absolute;left:0;top:0;width:0;height:0;opacity:0;transition:opacity .12s}
  .ft-stick.on{opacity:1}
  .ft-stick-base,.ft-stick-knob{position:absolute;border-radius:50%;transform:translate(-50%,-50%)}
  .ft-stick-base{width:${STICK_R * 2}px;height:${STICK_R * 2}px;
    background:radial-gradient(circle,rgba(255,255,255,.10),rgba(255,255,255,.03) 70%);
    border:1.5px solid rgba(255,255,255,.30)}
  .ft-stick-knob{width:${KNOB_R * 2}px;height:${KNOB_R * 2}px;
    background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.92),rgba(226,232,240,.55));
    border:1px solid rgba(255,255,255,.55);box-shadow:0 3px 12px rgba(0,0,0,.45)}
  .ft-pad{position:absolute;right:max(18px,env(safe-area-inset-right));
    bottom:max(22px,env(safe-area-inset-bottom));width:186px;height:186px;pointer-events:auto}
  .ft-btn{position:absolute;width:62px;height:62px;border-radius:50%;border:1.5px solid rgba(255,255,255,.34);
    color:#fff;font:700 12px/1 inherit;letter-spacing:.04em;background:rgba(14,18,26,.62);backdrop-filter:blur(8px);
    -webkit-backdrop-filter:blur(8px);box-shadow:0 4px 14px rgba(0,0,0,.4);touch-action:none;padding:0}
  .ft-btn:active,.ft-btn.on{transform:scale(.93);background:rgba(255,255,255,.28)}
  .ft-through{left:0;top:62px;border-color:rgba(120,220,160,.6)}
  .ft-lob{left:62px;top:0;border-color:rgba(140,180,255,.6)}
  .ft-pass{left:62px;top:124px;border-color:rgba(255,205,110,.6)}
  .ft-shoot{left:124px;top:62px;border-color:rgba(255,120,130,.7)}
  .ft-aux{position:absolute;right:max(18px,env(safe-area-inset-right));
    bottom:max(216px,calc(env(safe-area-inset-bottom) + 216px));display:flex;gap:8px;pointer-events:auto}
  .ft-mini{height:34px;padding:0 13px;border-radius:17px;border:1.5px solid rgba(255,255,255,.30);
    color:#fff;font:700 11px/1 inherit;letter-spacing:.06em;background:rgba(14,18,26,.62);
    backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);touch-action:none}
  .ft-mini:active,.ft-mini.on{background:rgba(255,255,255,.3)}
  @media (max-height:420px){
    .ft-pad{width:158px;height:158px} .ft-btn{width:52px;height:52px;font-size:10px}
    .ft-through{top:52px} .ft-lob{left:52px} .ft-pass{left:52px;top:104px} .ft-shoot{left:104px;top:52px}
    .ft-aux{bottom:max(184px,calc(env(safe-area-inset-bottom) + 184px))}
  }`;
  document.head.appendChild(style);
  host.appendChild(root);
  state.mounted = true;

  const stick = root.querySelector('.ft-stick');
  const base = root.querySelector('.ft-stick-base');
  const knob = root.querySelector('.ft-stick-knob');

  // ---- floating stick (left half of the screen) ----------------------------
  let stickId = null, ox = 0, oy = 0;

  function place(el, x, y) { el.style.left = x + 'px'; el.style.top = y + 'px'; }

  function stickStart(t) {
    stickId = t.identifier;
    ox = t.clientX; oy = t.clientY;
    place(base, ox, oy); place(knob, ox, oy);
    stick.classList.add('on');
  }
  function stickMove(t) {
    let dx = t.clientX - ox, dy = t.clientY - oy;
    const d = Math.hypot(dx, dy);
    if (d > STICK_R) { dx = (dx / d) * STICK_R; dy = (dy / d) * STICK_R; }
    place(knob, ox + dx, oy + dy);
    const mag = Math.min(d / STICK_R, 1);
    state.mag = mag;
    if (mag > 0.001) { state.sx = dx / STICK_R; state.sy = -dy / STICK_R; }
    else { state.sx = 0; state.sy = 0; }
  }
  function stickEnd() {
    stickId = null; state.sx = 0; state.sy = 0; state.mag = 0;
    stick.classList.remove('on');
  }

  root.addEventListener('touchstart', (e) => {
    for (const t of e.changedTouches) {
      if (stickId === null && t.clientX < window.innerWidth * 0.5) { stickStart(t); e.preventDefault(); }
    }
  }, { passive: false });
  root.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) if (t.identifier === stickId) { stickMove(t); e.preventDefault(); }
  }, { passive: false });
  const endHandler = (e) => {
    for (const t of e.changedTouches) if (t.identifier === stickId) stickEnd();
  };
  root.addEventListener('touchend', endHandler);
  root.addEventListener('touchcancel', endHandler);
  // The stick layer must not swallow taps aimed at the buttons.
  root.style.pointerEvents = 'auto';
  root.querySelector('.ft-pad').style.pointerEvents = 'auto';

  // ---- buttons -------------------------------------------------------------
  for (const btn of root.querySelectorAll('[data-act],[data-hold]')) {
    const act = btn.dataset.act, hold = btn.dataset.hold;
    const on = (e) => {
      e.preventDefault(); e.stopPropagation();
      btn.classList.add('on');
      if (hold) state[hold] = true;
      else if (act === 'switch') state.switchPlayer = true;
      else state[act] = true;
    };
    const off = (e) => {
      e.stopPropagation();
      btn.classList.remove('on');
      if (hold) state[hold] = false;
    };
    btn.addEventListener('touchstart', on, { passive: false });
    btn.addEventListener('touchend', off);
    btn.addEventListener('touchcancel', off);
    // Mouse fallback so the layout can be exercised on a desktop browser.
    btn.addEventListener('mousedown', on);
    btn.addEventListener('mouseup', off);
    btn.addEventListener('mouseleave', off);
  }

  return {
    state,
    /** Read and clear edge-triggered actions. */
    sample() {
      const out = {
        sx: state.sx, sy: state.sy, mag: state.mag,
        sprint: state.sprint,
        pass: state.pass, shoot: state.shoot, through: state.through,
        lofted: state.lofted, switchPlayer: state.switchPlayer,
      };
      state.pass = state.shoot = state.through = state.lofted = state.switchPlayer = false;
      return out;
    },
  };
}
