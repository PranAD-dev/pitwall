// ---------------------------------------------------------------------------
// src/hud.js — broadcast graphics package for FIFACHER.
// Original TV-football design: top-left score bug (competition mark, procedural
// club crests, dark glass panel, integrated possession bar, clock pill),
// animated goal lower-third with wipe, kickoff matchup card, auto-fading
// controls hint (never shown in capture builds).
// All DOM lives inside #hud (pointer-events: none). No canvas. DOM is only
// touched on change; the clock repaints at 2 Hz. Every animation is driven by
// accumulated dt (NOT CSS animations / wall clock) so screenshot fast-forward
// renders the exact same frame deterministically.
// ---------------------------------------------------------------------------

import { TEAMS, VENUE, clamp, lerp, damp } from './util.js';

// ---- tiny helpers ----------------------------------------------------------

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInCubic = (t) => t * t * t;

function setText(node, s) {
  if (node.__txt !== s) { node.__txt = s; node.textContent = s; }
}
function setStyle(node, prop, value) {
  const bag = node.__sty || (node.__sty = {});
  if (bag[prop] !== value) { bag[prop] = value; node.style[prop] = value; }
}
function el(cls, parent, tag = 'div') {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (parent) parent.appendChild(d);
  return d;
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex) {
  const [r, g, b] = hexRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}
/** amt in [-1,1]: negative darkens toward black, positive lightens toward white. */
function shade(hex, amt) {
  const [r, g, b] = hexRgb(hex);
  const to = amt < 0 ? 0 : 255;
  const t = Math.abs(amt);
  const m = (c) => Math.round(lerp(c, to, t));
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

/** Defensive extraction of goal-event payload — shape is owned by match.js. */
function extractGoalInfo(d) {
  const info = { team: null, name: '', number: null };
  if (d && typeof d === 'object') {
    const side = d.team || d.side;
    if (side === 'home' || side === 'away') info.team = side;
    const p = d.scorer || d.player || d.by ||
      ((typeof d.name === 'string' || typeof d.number === 'number') ? d : null);
    if (p && typeof p === 'object') {
      if (!info.team && (p.team === 'home' || p.team === 'away')) info.team = p.team;
      if (typeof p.name === 'string') info.name = p.name;
      if (typeof p.number === 'number') info.number = p.number;
    }
    if (!info.name && typeof d.scorerName === 'string') info.name = d.scorerName;
  }
  return info;
}

// Screen-friendly derivations of the kit colours (used for the possession
// pill / bar, where a near-white away primary would blow out).
const POSS_COLOR = {
  home: shade(TEAMS.home.primary, 0.04),
  away: shade(TEAMS.away.secondary, 0.14),
};

// ---- stylesheet ------------------------------------------------------------

const CSS = `
.fh-root { position:absolute; inset:0; overflow:hidden; color:#eef2f8;
  font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Segoe UI",Inter,system-ui,sans-serif;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; user-select:none; }
.fh-glass { background:linear-gradient(180deg, rgba(25,31,46,.80) 0%, rgba(8,11,18,.90) 100%);
  -webkit-backdrop-filter:blur(12px) saturate(1.3); backdrop-filter:blur(12px) saturate(1.3);
  border:1px solid rgba(255,255,255,.13);
  box-shadow:0 14px 38px rgba(0,0,0,.62), 0 3px 10px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.10); }

/* ---- score bug (top-left) ---- */
.fh-bug-wrap { position:absolute; top:26px; left:30px; transform-origin:top left; }
.fh-bug-main { position:relative; border-radius:11px; overflow:hidden; }
.fh-bug-row { display:flex; align-items:stretch; height:46px; }

/* competition mark */
.fh-comp { display:flex; align-items:center; padding:0 11px;
  border-right:1px solid rgba(255,255,255,.11);
  background:linear-gradient(180deg, rgba(255,255,255,.075) 0%, rgba(255,255,255,.015) 100%); }
.fh-comp-mark { position:relative; width:27px; height:27px; border-radius:7px; overflow:hidden;
  display:flex; align-items:center; justify-content:center;
  background:linear-gradient(152deg,#3a4a7d 0%, #1b2547 52%, #0e1530 100%);
  border:1px solid rgba(255,255,255,.24);
  box-shadow:0 2px 5px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.18); }
.fh-comp-mark b { font-size:11.5px; font-weight:900; letter-spacing:.01em; line-height:1;
  color:#f4cd72; text-shadow:0 1px 2px rgba(0,0,0,.55); transform:translateY(-1px); }
.fh-comp-mark i { position:absolute; left:4px; right:4px; bottom:3.5px; height:2px; border-radius:1px;
  background:linear-gradient(90deg,#f4cd72,#c78f22); }

/* team block */
.fh-teams { display:flex; align-items:center; padding:0 13px; }
.fh-crest-drop { flex:none; filter:drop-shadow(0 2px 3px rgba(0,0,0,.6)); }
.fh-crest { position:relative; }
.fh-crest, .fh-crest-inner { clip-path:polygon(0 0, 100% 0, 100% 63%, 50% 100%, 0 63%); }
.fh-crest-inner { position:absolute; }
.fh-crest-band { position:absolute; left:0; right:0;
  display:flex; align-items:center; justify-content:center; box-shadow:0 1px 4px rgba(0,0,0,.3); }
.fh-crest-abbr { font-weight:900; letter-spacing:.06em; text-indent:.06em; line-height:1; }

/* both sides always carry a tab, so the bug stays symmetric; the tab of the
   team on the ball fills with its kit colour — no floating underline */
.fh-abbr { position:relative; display:inline-block; padding:6px 8px 7px; border-radius:6px;
  background:rgba(255,255,255,.055); box-shadow:inset 0 0 0 1px rgba(255,255,255,.07); }
.fh-abbr b { position:relative; display:block; font-size:15px; font-weight:600;
  letter-spacing:.10em; text-indent:.10em; line-height:1; }
.fh-poss { position:absolute; inset:0; border-radius:6px; opacity:0;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.22), 0 1px 3px rgba(0,0,0,.35); }
.fh-score { font-size:21px; font-weight:800; line-height:1; font-variant-numeric:tabular-nums;
  display:inline-block; min-width:13px; text-align:center; }
.fh-dash { font-size:21px; font-weight:700; line-height:1; color:rgba(238,242,248,.42); }

/* clock block */
.fh-clockseg { display:flex; align-items:center; gap:9px; padding:0 13px;
  border-left:1px solid rgba(255,255,255,.11); background:rgba(255,255,255,.055); }
.fh-halfpill { padding:3.5px 6px 4.5px; border-radius:5px; background:rgba(255,255,255,.16);
  border:1px solid rgba(255,255,255,.15); font-size:9.5px; font-weight:800;
  letter-spacing:.13em; text-indent:.13em; line-height:1; color:rgba(246,249,255,.96); }
.fh-clock { font-size:18px; font-weight:700; font-variant-numeric:tabular-nums;
  letter-spacing:.03em; line-height:1; }
.fh-added { display:none; padding:3.5px 5px 4.5px; border-radius:5px; line-height:1;
  background:linear-gradient(180deg,#f8ce5f,#dfa227); color:#241a05;
  font-size:9.5px; font-weight:900; letter-spacing:.03em;
  box-shadow:0 1px 3px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.45); }

/* possession bar welded to the bottom edge of the panel */
.fh-possbar { position:absolute; left:0; right:0; bottom:0; height:3px;
  display:flex; background:rgba(255,255,255,.10); }
.fh-possbar i { display:block; height:100%; }

/* venue sub-tab — flush left with the panel, right edge on the clock divider */
.fh-bug-sub { display:block; padding:4.5px 0 5.5px; text-align:center;
  font-size:10px; font-weight:700; letter-spacing:.2em; text-indent:.2em;
  color:rgba(226,234,248,.74); background:rgba(6,8,14,.78);
  border:1px solid rgba(255,255,255,.10); border-top:none; border-radius:0 0 8px 8px;
  box-shadow:0 8px 18px rgba(0,0,0,.45); }

/* ---- goal lower-third ---- */
.fh-banner-wrap { position:absolute; left:64px; bottom:84px; transform-origin:bottom left; display:none; }
.fh-banner { position:relative; display:flex; align-items:stretch; height:80px; min-width:560px;
  border-radius:10px; overflow:hidden; will-change:transform,opacity; }
.fh-banner-slab { position:absolute; top:-8px; bottom:-8px; left:-36px; width:242px;
  transform:skewX(-16deg); box-shadow:6px 0 20px rgba(0,0,0,.35); }
.fh-goalcell { position:relative; width:200px; display:flex; align-items:center;
  justify-content:center; gap:11px; }
.fh-goaltxt { font-size:31px; font-weight:900; font-style:italic; letter-spacing:.03em; line-height:1;
  text-shadow:0 2px 10px rgba(0,0,0,.28); }
.fh-banner-body { position:relative; display:flex; flex-direction:column; justify-content:center;
  gap:9px; padding:0 34px 0 18px; }
.fh-banner-row { display:flex; align-items:center; gap:10px; }
.fh-num { padding:3px 6px 4px; border-radius:4px; font-size:11px; font-weight:900;
  line-height:1; font-variant-numeric:tabular-nums; }
.fh-banner-scorer { font-size:21px; font-weight:800; letter-spacing:.06em; line-height:1; white-space:nowrap; }
.fh-banner-team { font-size:11.5px; font-weight:700; letter-spacing:.17em; text-indent:.17em;
  color:rgba(228,235,246,.74); line-height:1; white-space:nowrap; }
.fh-min { padding:3px 6px 4px; border-radius:4px; background:rgba(255,255,255,.17);
  border:1px solid rgba(255,255,255,.14); font-size:10.5px; font-weight:800;
  letter-spacing:.04em; line-height:1; color:rgba(246,249,255,.95); }
.fh-bscore { position:relative; margin-left:auto; display:flex; flex-direction:column;
  justify-content:center; gap:8px; padding:0 22px; border-left:1px solid rgba(255,255,255,.13);
  background:rgba(255,255,255,.045); }
.fh-bscore-row { display:flex; align-items:center; gap:14px; }
.fh-bscore-tick { width:3px; height:13px; border-radius:1.5px; }
.fh-bscore-ab { font-size:11px; font-weight:700; letter-spacing:.15em; text-indent:.15em;
  line-height:1; min-width:34px; }
.fh-bscore-n { font-size:15px; font-weight:800; line-height:1; font-variant-numeric:tabular-nums;
  margin-left:auto; }
.fh-banner-line { position:absolute; left:0; right:0; bottom:0; height:3px; }
.fh-banner-wipe { position:absolute; top:0; bottom:0; left:0; right:0;
  border-right:3px solid rgba(255,255,255,.95); will-change:transform; }
.fh-banner-sweep { position:absolute; top:-12px; bottom:-12px; left:0; width:110px; opacity:0;
  background:linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.85), rgba(255,255,255,0)); }

/* ---- kickoff card (center) ---- */
.fh-card-wrap { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; }
.fh-card-scale { transform-origin:center; }
.fh-card { position:relative; width:680px; border-radius:16px; padding:26px 36px 22px; overflow:hidden;
  text-align:center; will-change:transform,opacity;
  background:radial-gradient(130% 150% at 50% 0%, rgba(32,40,58,.85) 0%, rgba(9,12,19,.92) 72%);
  border:1px solid rgba(255,255,255,.14);
  box-shadow:0 18px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.08);
  -webkit-backdrop-filter:blur(14px) saturate(1.2); backdrop-filter:blur(14px) saturate(1.2); }
.fh-card-topline { position:absolute; top:0; left:0; right:0; height:3px; }
.fh-card-comp { display:flex; align-items:center; justify-content:center; gap:11px;
  font-size:10.5px; font-weight:700; letter-spacing:.24em; text-indent:.24em; color:rgba(226,232,244,.62); }
.fh-card-row { display:flex; align-items:center; justify-content:center; gap:30px; margin:22px 0 20px; }
.fh-card-team { display:flex; flex-direction:column; align-items:center; gap:13px; width:215px; }
.fh-card-name { font-size:20px; font-weight:800; letter-spacing:.07em; line-height:1.15; }
.fh-card-bar { width:30px; height:3px; border-radius:1.5px; margin-top:-4px; }
.fh-card-vs { display:flex; flex-direction:column; align-items:center; gap:7px; }
.fh-vs-big { font-size:23px; font-weight:300; letter-spacing:.18em; color:rgba(238,242,248,.5);
  text-indent:.18em; line-height:1; }
.fh-vs-tag { font-size:8.5px; font-weight:700; letter-spacing:.26em; color:rgba(226,232,244,.45); text-indent:.26em; }
.fh-card-venue { display:flex; align-items:center; justify-content:center; gap:14px; }
.fh-card-venue i { display:block; width:46px; height:1px; background:rgba(255,255,255,.22); }
.fh-card-venue span { font-size:11px; font-weight:700; letter-spacing:.3em; text-indent:.3em;
  color:rgba(230,236,246,.72); }

/* ---- controls hint (bottom-right, auto-fading, never in capture) ---- */
.fh-ctrl-wrap { position:absolute; right:26px; bottom:22px; transform-origin:bottom right; opacity:0;
  display:flex; align-items:center; gap:11px; padding:7px 13px 8px; border-radius:9px;
  background:linear-gradient(180deg, rgba(20,26,38,.62), rgba(6,9,15,.7));
  border:1px solid rgba(255,255,255,.10);
  -webkit-backdrop-filter:blur(7px); backdrop-filter:blur(7px);
  box-shadow:0 6px 18px rgba(0,0,0,.4); color:#e6ecf6; }
.fh-ctrl-item { display:flex; align-items:center; gap:6px; }
.fh-key { padding:2px 6px 3px; border:1px solid rgba(255,255,255,.42); border-bottom-width:2px;
  border-radius:4px; font-size:9.5px; font-weight:700; letter-spacing:.05em; line-height:1; }
.fh-ctrl-label { font-size:10px; font-weight:600; letter-spacing:.14em; color:rgba(230,237,247,.8); }
.fh-ctrl-sep { font-size:10px; opacity:.4; }
`;

// ---- factory ---------------------------------------------------------------

export function createHud({ match } = {}) {
  const host = document.getElementById('hud') || document.body;
  const H = TEAMS.home, A = TEAMS.away;

  // Capture builds (?t=… screenshot mode) carry no input prompts at all.
  let CAPTURE = false;
  try {
    const q = new URLSearchParams(location.search);
    CAPTURE = (q.has('t') && q.get('live') !== '1') || q.get('nohint') === '1';
  } catch (e) { /* non-browser-ish host: keep the hint */ }

  const style = document.createElement('style');
  style.textContent = CSS;
  host.appendChild(style);

  const root = el('fh-root', host);

  /**
   * Procedural club crest: shield clip-path, diagonal kit-coloured field,
   * secondary band carrying the abbreviation (or a monogram at small sizes).
   */
  function buildCrest(parent, T, w, opts = {}) {
    const h = Math.round(w * 1.16);
    const rim = Math.max(1, Math.round(w * 0.05));
    const bandH = opts.bandH || Math.max(7, Math.round(h * 0.3));
    const drop = el('fh-crest-drop', parent);
    const crest = el('fh-crest', drop);
    crest.style.width = w + 'px';
    crest.style.height = h + 'px';
    // light shirts get a dark rim so the badge silhouette still reads on glass
    crest.style.background = luminance(T.primary) > 0.6 ? '#161d30' : 'rgba(238,243,252,.92)';
    const inner = el('fh-crest-inner', crest);
    inner.style.inset = rim + 'px';
    inner.style.background =
      `linear-gradient(118deg, ${shade(T.primary, 0.1)} 0%, ${T.primary} 49.5%, ` +
      `${shade(T.primary, -0.2)} 50.5%, ${shade(T.primary, -0.32)} 100%)`;
    const band = el('fh-crest-band', inner);
    band.style.background = T.secondary;
    band.style.height = bandH + 'px';
    band.style.top = `calc(50% - ${(bandH / 2).toFixed(1)}px)`;
    const abbr = el('fh-crest-abbr', band, 'span');
    abbr.style.fontSize = (opts.fontSize || Math.round(bandH * 0.62)) + 'px';
    abbr.style.color = luminance(T.secondary) > 0.6 ? '#10141c' : '#ffffff';
    // Both clubs abbreviate to an S-word, so a single-letter monogram reads as
    // the same badge twice. Always show the full abbreviation, just tighter.
    setText(abbr, T.abbr);
    if (opts.mono) abbr.style.fontSize = Math.max(6, Math.round(bandH * 0.46)) + 'px';
    return drop;
  }

  // ---- score bug ----
  const bugWrap = el('fh-bug-wrap', root);
  const bugMain = el('fh-bug-main fh-glass', bugWrap);
  const bugRow = el('fh-bug-row', bugMain);

  // competition mark (leads the package, like every real broadcast bug)
  const compSeg = el('fh-comp', bugRow);
  const compMark = el('fh-comp-mark', compSeg);
  setText(el('', compMark, 'b'), 'LF');
  el('', compMark, 'i');

  // team block: crest · abbr · score – score · abbr · crest
  const teamsSeg = el('fh-teams', bugRow);
  // one optical gap drives the whole internal rhythm: every neighbouring pair
  // (crest|tab, tab|score, score|dash, dash|score, score|tab, tab|crest) is G apart.
  const G = 10;
  const DASH_G = 8; // the en-dash carries ~2px of side bearing of its own

  buildCrest(teamsSeg, H, 26, { mono: true, bandH: 11, fontSize: 10 });

  const abbrH = el('fh-abbr', teamsSeg, 'span');
  abbrH.style.margin = `0 ${G}px`;
  const possH = el('fh-poss', abbrH, 'i');
  possH.style.background = POSS_COLOR.home;
  setText(el('', abbrH, 'b'), H.abbr);

  const scoreHEl = el('fh-score', teamsSeg, 'span');
  const dashEl = el('fh-dash', teamsSeg, 'span');
  dashEl.textContent = '–';
  dashEl.style.margin = `0 ${DASH_G}px`;
  const scoreAEl = el('fh-score', teamsSeg, 'span');

  const abbrA = el('fh-abbr', teamsSeg, 'span');
  abbrA.style.margin = `0 ${G}px`;
  const possA = el('fh-poss', abbrA, 'i');
  possA.style.background = POSS_COLOR.away;
  setText(el('', abbrA, 'b'), A.abbr);

  buildCrest(teamsSeg, A, 26, { mono: true, bandH: 11, fontSize: 10 });

  // clock block
  const clockSeg = el('fh-clockseg', bugRow);
  const halfEl = el('fh-halfpill', clockSeg, 'span');
  const clockEl = el('fh-clock', clockSeg, 'span');
  const addedEl = el('fh-added', clockSeg, 'span');

  // possession bar, welded into the bottom edge of the panel
  const possBar = el('fh-possbar', bugMain);
  const possFillH = el('', possBar, 'i');
  possFillH.style.background = `linear-gradient(180deg, ${shade(H.primary, 0.22)}, ${H.primary})`;
  const possFillA = el('', possBar, 'i');
  possFillA.style.background = `linear-gradient(180deg, ${shade(A.secondary, 0.4)}, ${shade(A.secondary, 0.14)})`;

  const subEl = el('fh-bug-sub', bugWrap);
  setText(subEl, `${VENUE.competition} · ${VENUE.city}`.toUpperCase());

  setText(scoreHEl, '0');
  setText(scoreAEl, '0');
  setText(clockEl, '00:00');
  setText(halfEl, '1ST');

  // ---- goal lower-third ----
  const bannerWrap = el('fh-banner-wrap', root);
  const bannerEl = el('fh-banner fh-glass', bannerWrap);
  const slabEl = el('fh-banner-slab', bannerEl);
  const goalCell = el('fh-goalcell', bannerEl);
  const bannerCrestSlot = el('', goalCell);
  let bannerCrest = null;
  const goalTxt = el('fh-goaltxt', goalCell, 'span');
  setText(goalTxt, 'GOAL');
  const bodyEl = el('fh-banner-body', bannerEl);
  const row1 = el('fh-banner-row', bodyEl);
  const numEl = el('fh-num', row1, 'span');
  const bScorerEl = el('fh-banner-scorer', row1, 'span');
  const row2 = el('fh-banner-row', bodyEl);
  const bTeamEl = el('fh-banner-team', row2, 'span');
  const minEl = el('fh-min', row2, 'span');

  // updated scoreline rides the tail of the plate
  const bScoreCell = el('fh-bscore', bannerEl);
  function bScoreRow(T) {
    const r = el('fh-bscore-row', bScoreCell);
    const tick = el('fh-bscore-tick', r, 'i');
    tick.style.background = `linear-gradient(180deg, ${shade(T.primary, 0.15)}, ${T.secondary})`;
    const ab = el('fh-bscore-ab', r, 'span');
    setText(ab, T.abbr);
    const n = el('fh-bscore-n', r, 'span');
    return { ab, n };
  }
  const bScoreH = bScoreRow(H);
  const bScoreA = bScoreRow(A);

  const lineEl = el('fh-banner-line', bannerEl);
  const wipeEl = el('fh-banner-wipe', bannerEl);
  const sweepEl = el('fh-banner-sweep', bannerEl);

  // ---- kickoff card ----
  const cardWrap = el('fh-card-wrap', root);
  const cardScale = el('fh-card-scale', cardWrap);
  const cardEl = el('fh-card', cardScale);
  const topline = el('fh-card-topline', cardEl);
  topline.style.background =
    `linear-gradient(90deg, ${H.primary} 0%, rgba(0,0,0,0) 38%, rgba(0,0,0,0) 62%, ${A.secondary} 100%)`;
  const compRow = el('fh-card-comp', cardEl);
  setText(el('', compRow, 'span'), `${VENUE.competition} · ${VENUE.matchday}`.toUpperCase());

  const row = el('fh-card-row', cardEl);
  function makeCrestColumn(T) {
    const col = el('fh-card-team', row);
    buildCrest(col, T, 64, { bandH: 22, fontSize: 13 });
    setText(el('fh-card-name', col), T.name.toUpperCase());
    const bar = el('fh-card-bar', col);
    bar.style.background = `linear-gradient(90deg, ${T.primary}, ${T.secondary})`;
    return col;
  }
  makeCrestColumn(H);
  const vs = el('fh-card-vs', row);
  setText(el('fh-vs-big', vs), 'VS');
  setText(el('fh-vs-tag', vs), 'KICK-OFF');
  makeCrestColumn(A);

  const venueRow = el('fh-card-venue', cardEl);
  el('', venueRow, 'i');
  setText(el('', venueRow, 'span'), `${VENUE.name} · ${VENUE.city}`.toUpperCase());
  el('', venueRow, 'i');

  // ---- controls hint ----
  let ctrlWrap = null;
  let padHinted = false;
  // Keyboard scheme, and the Switch-labelled pad scheme we swap to the moment a
  // controller is seen. Pad labels are Nintendo's; the code binds by physical
  // button position, so an Xbox/PS pad works with its own letters shuffled.
  const CTRL_KB = [
    ['WASD', 'MOVE'], ['SHIFT', 'SPRINT'], ['X', 'PASS'],
    ['C', 'THROUGH'], ['V', 'LOB'], ['SPACE', 'SHOOT'], ['Q', 'SWITCH'],
  ];
  const CTRL_PAD = [
    ['STICK', 'MOVE'], ['ZR', 'SPRINT'], ['B', 'PASS'],
    ['Y', 'THROUGH'], ['X', 'LOB'], ['A', 'SHOOT'], ['L', 'SWITCH'],
  ];
  function drawCtrl(list) {
    if (!ctrlWrap) return;
    while (ctrlWrap.firstChild) ctrlWrap.removeChild(ctrlWrap.firstChild);
    list.forEach(([key, label], i) => {
      if (i > 0) setText(el('fh-ctrl-sep', ctrlWrap, 'span'), '·');
      const item = el('fh-ctrl-item', ctrlWrap);
      setText(el('fh-key', item, 'span'), key);
      setText(el('fh-ctrl-label', item, 'span'), label);
    });
  }
  if (!CAPTURE) {
    ctrlWrap = el('fh-ctrl-wrap', root);
    drawCtrl(CTRL_KB);
    // Swap to pad labels on connect. Chrome only surfaces a pad after the first
    // input, so this fires exactly when the player actually starts using it.
    window.addEventListener('gamepadconnected', () => {
      if (padHinted) return;
      padHinted = true;
      drawCtrl(CTRL_PAD);
    });
  }

  // ---- responsive scale (crisp 1:1 at 1080p) ----
  let curScale = 0;
  function applyScale() {
    // Floor is low enough that a 390 px-tall landscape phone gets a scorebug
    // proportional to its screen rather than one eating a third of the frame.
    const s = clamp((window.innerHeight || 1080) / 1080, 0.46, 1.6);
    if (Math.abs(s - curScale) < 0.001) return;
    curScale = s;
    const t = `scale(${s.toFixed(4)})`;
    setStyle(bugWrap, 'transform', t);
    if (ctrlWrap) setStyle(ctrlWrap, 'transform', t);
    setStyle(bannerWrap, 'transform', t);
    setStyle(cardScale, 'transform', t);
  }
  window.addEventListener('resize', applyScale);
  applyScale();

  // ---- runtime state ---------------------------------------------------------

  const lastScore = { h: 0, a: 0 };
  let clockAcc = 1;      // force first paint
  let slowAcc = 1;       // 2 Hz bucket for the possession bar / added time
  let subFitted = false; // venue tab measured against the clock divider yet?

  // possession: live pill (who has it now) + match-share bar (accumulated)
  let possTarget = { home: 0, away: 0 };  // pill opacity targets
  let possOpa = { home: 0, away: 0 };
  let ballTime = { home: 0, away: 0 };
  let possMix = 0.5;

  // stoppage-time estimate, derived from what the HUD actually observed
  let goalsSeen = 0, stopsSeen = 0;

  // kickoff card timeline
  const CARD_FADE_START = 1.3, CARD_FADE_DUR = 0.7;
  let cardT = 0, cardDone = false;

  // goal banner timeline
  const B_IN = 0.5, B_HOLD = 3.5, B_OUT = 0.55, B_MAXHOLD = 8;
  const SLIDE_X = -880;
  let banner = null;      // { stage:'in'|'hold'|'out', t, holdT, outT, e, side }
  let pendingGoal = null; // { info, age } — from onEvent, awaiting score confirm
  let pulse = null;       // { el, t } — score digit pop

  // controls hint fade
  const HINT_HOLD = 5, HINT_FADE = 0.8, HINT_OPA = 0.5;
  let hintIdle = 0;
  if (ctrlWrap) {
    const poke = () => { hintIdle = 0; };
    window.addEventListener('keydown', poke, { passive: true });
    window.addEventListener('keyup', poke, { passive: true });
    window.addEventListener('mousedown', poke, { passive: true });
  }

  function triggerBanner(info, st) {
    const side = info.team === 'away' ? 'away' : 'home';
    if (banner && banner.side === side && banner.e < 3) return; // already showing this goal
    const T = TEAMS[side];
    // a near-white kit would bleach the slab (and swallow the crest on it), so
    // light-shirted sides run their slab in the secondary colour
    const light = luminance(T.primary) > 0.6;
    const slab = light ? T.secondary : T.primary;
    const trim = light ? T.primary : T.secondary;
    setStyle(slabEl, 'background',
      `linear-gradient(115deg, ${shade(slab, 0.14)} 0%, ${slab} 55%, ${shade(slab, -0.28)} 100%)`);
    setStyle(goalTxt, 'color', luminance(slab) > 0.6 ? '#10141c' : '#ffffff');
    setStyle(lineEl, 'background',
      `linear-gradient(90deg, rgba(0,0,0,0) 0%, ${shade(slab, 0.1)} 30%, ` +
      `${shade(trim, 0.32)} 74%, rgba(0,0,0,0) 100%)`);
    setStyle(wipeEl, 'background',
      `linear-gradient(100deg, ${shade(slab, 0.12)} 0%, ${shade(slab, -0.3)} 100%)`);

    // crest of the scoring side rides the coloured slab
    if (bannerCrest) bannerCrestSlot.removeChild(bannerCrest);
    bannerCrest = buildCrest(bannerCrestSlot, T, 34, { mono: true, bandH: 14, fontSize: 12 });

    setText(bScorerEl, (info.name || T.name).toUpperCase());
    if (typeof info.number === 'number') {
      setStyle(numEl, 'display', 'inline-block');
      setStyle(numEl, 'background', slab);
      setStyle(numEl, 'color', luminance(slab) > 0.6 ? '#10141c' : '#ffffff');
      setText(numEl, String(info.number));
    } else {
      setStyle(numEl, 'display', 'none');
    }
    setText(bTeamEl, T.name.toUpperCase());
    setText(minEl, Math.min(90 + 9, Math.floor((st.clockSec || 0) / 60) + 1) + '′');

    // updated scoreline, scorer's row highlighted
    const sc = st.score || { home: 0, away: 0 };
    setText(bScoreH.n, String(sc.home | 0));
    setText(bScoreA.n, String(sc.away | 0));
    for (const [k, r] of [['home', bScoreH], ['away', bScoreA]]) {
      const on = k === side;
      setStyle(r.ab, 'color', on ? 'rgba(246,249,255,.95)' : 'rgba(226,234,246,.5)');
      setStyle(r.n, 'color', on ? '#ffffff' : 'rgba(238,244,252,.55)');
    }

    banner = { stage: 'in', t: 0, holdT: 0, outT: 0, e: 0, side };
    setStyle(bannerWrap, 'display', 'block');
    setStyle(bannerEl, 'transform', `translateX(${SLIDE_X}px)`);
    setStyle(bannerEl, 'opacity', '0');
    setStyle(wipeEl, 'transform', 'translateX(0%)');
    pulse = { el: side === 'home' ? scoreHEl : scoreAEl, t: 0 };
  }

  function renderBanner(dt, phase) {
    if (!banner) return;
    const b = banner;
    b.e += dt;
    let x = 0, op = 1;
    if (b.stage === 'in') {
      b.t += dt;
      const p = Math.min(1, b.t / B_IN);
      x = lerp(SLIDE_X, 0, easeOutCubic(p));
      op = Math.min(1, p * 2.2);
      if (p >= 1) { b.stage = 'hold'; b.holdT = 0; }
    } else if (b.stage === 'hold') {
      b.holdT += dt;
      // hold at least 3.5 s; keep held while the match is still celebrating
      if ((b.holdT >= B_HOLD && phase !== 'goal') || b.holdT >= B_MAXHOLD) b.stage = 'out';
    } else if (b.stage === 'out') {
      b.outT += dt;
      const p = Math.min(1, b.outT / B_OUT);
      x = lerp(0, SLIDE_X, easeInCubic(p));
      op = clamp(1 - p * 1.3, 0, 1);
      if (p >= 1) {
        banner = null;
        setStyle(bannerWrap, 'display', 'none');
        return;
      }
    }
    setStyle(bannerEl, 'transform', `translateX(${x.toFixed(1)}px)`);
    setStyle(bannerEl, 'opacity', op.toFixed(3));
    // colour wipe travels off to the right, revealing the plate
    const wp = clamp((b.e - 0.22) / 0.4, 0, 1);
    setStyle(wipeEl, 'transform', `translateX(${(easeOutCubic(wp) * 101).toFixed(2)}%)`);
    setStyle(wipeEl, 'opacity', wp >= 1 ? '0' : '1');
    // glare sweep across the plate just behind the wipe
    const sp = clamp((b.e - 0.5) / 0.7, 0, 1);
    setStyle(sweepEl, 'transform', `translateX(${lerp(-190, 820, sp).toFixed(1)}px) skewX(-16deg)`);
    setStyle(sweepEl, 'opacity', (Math.sin(Math.PI * sp) * 0.4).toFixed(3));
  }

  function renderCard(dt, phase) {
    if (cardDone) return;
    cardT += dt;
    // respect the match: once the ball is in play, start dismissing immediately
    if (phase === 'play' && cardT < CARD_FADE_START) cardT = CARD_FADE_START;
    const fadeP = clamp((cardT - CARD_FADE_START) / CARD_FADE_DUR, 0, 1);
    if (fadeP >= 1) {
      cardDone = true;
      setStyle(cardWrap, 'display', 'none');
      return;
    }
    const inP = clamp(cardT / 0.45, 0, 1);
    const e = easeOutCubic(inP);
    setStyle(cardEl, 'transform', `translateY(${lerp(10, 0, e).toFixed(2)}px) scale(${lerp(0.962, 1, e).toFixed(4)})`);
    setStyle(cardEl, 'opacity', (Math.min(1, inP * 2.4) * (1 - fadeP)).toFixed(3));
  }

  // events from the match (goal may fire before or after the score increments)
  if (match && typeof match.onEvent === 'function') {
    try {
      match.onEvent((type, data) => {
        if (type === 'goal') { pendingGoal = { info: extractGoalInfo(data), age: 0 }; goalsSeen++; }
        else if (type === 'out' || type === 'save' || type === 'whistle') stopsSeen++;
      });
    } catch (e) { /* score-diff fallback below keeps the HUD functional */ }
  }

  // ---- per-frame update ------------------------------------------------------

  function update(dt) {
    dt = clamp(dt || 0, 0, 0.25);
    const st = (match && match.state) || {};
    const phase = st.phase;
    const clockSec = st.clockSec || 0;
    const half = (st.half | 0) >= 2 ? 2 : 1;

    // one-shot: pin the venue tab's right edge onto the clock divider
    if (!subFitted) {
      const w = clockSeg.offsetLeft;
      if (w > 40) { subEl.style.width = (w + 1) + 'px'; subFitted = true; }
    }

    // clock + half pill at 2 Hz
    clockAcc += dt;
    if (clockAcc >= 0.5) {
      clockAcc %= 0.5;
      setText(clockEl, fmtClock(clockSec));
      setText(halfEl, half === 2 ? '2ND' : '1ST');
      // clock dims while the ball is not in play — a live indicator, not a REC dot
      const live = phase === 'play' || phase === 'out';
      setStyle(clockEl, 'opacity', live ? '1' : '0.62');
    }

    // score + goal detection (event payload enriches; score diff is the truth)
    const sc = st.score || lastScore;
    const sh = sc.home | 0, sa = sc.away | 0;
    if (sh !== lastScore.h || sa !== lastScore.a) {
      const side = sh > lastScore.h ? 'home' : sa > lastScore.a ? 'away' : null;
      setText(scoreHEl, String(sh));
      setText(scoreAEl, String(sa));
      if (side) {
        const info = (pendingGoal && pendingGoal.age < 2) ? pendingGoal.info : {};
        if (info.team !== 'home' && info.team !== 'away') info.team = side;
        triggerBanner(info, st);
      }
      lastScore.h = sh; lastScore.a = sa;
      pendingGoal = null;
    } else if (pendingGoal) {
      pendingGoal.age += dt;
      if (pendingGoal.age > 0.35) { // event arrived but score never moved — trust it
        triggerBanner(pendingGoal.info, st);
        pendingGoal = null;
      }
    }

    // possession: filled pill behind the abbreviation of the team on the ball
    const poss = (st.possession === 'home' || st.possession === 'away') ? st.possession : null;
    possTarget.home = poss === 'home' ? 1 : 0;
    possTarget.away = poss === 'away' ? 1 : 0;
    for (const side of ['home', 'away']) {
      const o = damp(possOpa[side], possTarget[side], 11, dt);
      possOpa[side] = o;
      setStyle(side === 'home' ? possH : possA, 'opacity', o.toFixed(2));
    }
    if (poss && phase === 'play') ballTime[poss] += dt;

    // match possession share, on the bar under the panel (2 Hz DOM writes)
    slowAcc += dt;
    if (slowAcc >= 0.5) {
      const tot = ballTime.home + ballTime.away;
      possMix = damp(possMix, tot > 6 ? ballTime.home / tot : 0.5, 1.6, slowAcc);
      const pct = clamp(possMix, 0.1, 0.9) * 100; // always readable as a split
      setStyle(possFillH, 'width', pct.toFixed(1) + '%');
      setStyle(possFillA, 'width', (100 - pct).toFixed(1) + '%');

      // added time: shown in the closing minute of a half, like a fourth-official board
      const halfEnd = half === 2 ? 5400 : 2700;
      const show = clockSec > halfEnd - 60 && clockSec < halfEnd + 1 && phase !== 'kickoff';
      if (show) {
        setText(addedEl, '+' + clamp(1 + Math.floor(goalsSeen * 0.8 + stopsSeen * 0.05), 1, 9));
        setStyle(addedEl, 'display', 'inline-block');
      } else {
        setStyle(addedEl, 'display', 'none');
      }
      slowAcc = 0;
    }

    // score digit pop after a goal
    if (pulse) {
      pulse.t += dt;
      const p = Math.min(1, pulse.t / 0.5);
      if (p >= 1) {
        setStyle(pulse.el, 'transform', 'none');
        pulse = null;
      } else {
        setStyle(pulse.el, 'transform', `scale(${(1 + Math.sin(Math.PI * p) * 0.3).toFixed(3)})`);
      }
    }

    // controls hint: fades itself out after five idle seconds
    if (ctrlWrap) {
      hintIdle += dt;
      const o = HINT_OPA * (1 - clamp((hintIdle - HINT_HOLD) / HINT_FADE, 0, 1));
      setStyle(ctrlWrap, 'opacity', o.toFixed(3));
    }

    renderCard(dt, phase);
    renderBanner(dt, phase);
  }

  return { update };
}
