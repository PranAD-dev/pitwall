# FIFACHER — Architecture Contract

Broadcast-quality football (soccer) game in Three.js. Night match under floodlights at
**Armor Park**: **Breizh FC** (red/black) vs **Gallia United** (white/blue), "Ligue Fable".
The visual bar is the EA FC / FIFA broadcast camera look: warm floodlit grass with mowing
stripes, dense animated crowd in dark stands, volumetric-feeling light, clean broadcast HUD.

## Ground rules (every module)

- ES modules, browser-only, `import * as THREE from 'three'` and
  `from 'three/addons/...'` (import map is set up in `index.html`, three r166).
- **No external assets. No network fetches. No image/model/font files.** Everything is
  procedural: geometry from code, textures via `makeCanvasTexture` from `src/util.js`.
- **Never use `Math.random()` or `Date.now()` in simulation or generation** — use
  `ctx.rng` (seeded) so screenshots are deterministic. Time comes from `dt` arguments.
- Units are meters, +Y up. Pitch center is world origin.
- Color management: renderer uses `SRGBColorSpace` output + ACES tone mapping (set up in
  main). Color textures must set `colorSpace = THREE.SRGBColorSpace` (makeCanvasTexture
  does this by default). Use `MeshStandardMaterial`/`MeshPhysicalMaterial` for lit surfaces.
- Performance budget: 60 fps on an Apple-Silicon laptop. Crowd MUST be instanced.
  At most 3 shadow-casting lights in the whole scene (owned by `lighting.js`). Textures
  ≤ 2048px. Prefer merged/instanced geometry over thousands of Meshes.
- Every `create*` factory receives the same context object:
  `ctx = { scene, renderer, rng, quality }` (`quality` is `'high'|'low'`; degrade crowd
  count / texture sizes on `'low'`). Factories ADD their objects to `ctx.scene` themselves
  and return their public API object.

## Coordinate system & shared constants (`src/util.js` — already written, READ IT)

- Pitch: 105 × 68 m. Length along **X** (goals at x = ±52.5), width along **Z**
  (touchlines z = ±34). Home defends the x = −52.5 goal, attacks +X in the 1st half.
- TV/main stand is on the **−Z** side; broadcast camera lives there looking toward +Z.
- `util.js` exports: `PITCH`, `GOAL`, `STANDS`, `TIERS`, `forEachSeat(cb)`, `TEAMS`,
  `VENUE`, `makeRng(seed)`, `makeCanvasTexture(w,h,draw,opts)`, `clamp`, `lerp`, `damp`,
  `angleLerp`, `v3`. Stadium terraces and crowd seats are BOTH derived from
  `STANDS`/`TIERS`/`forEachSeat` so they line up exactly.

## Modules & exact APIs

### `src/pitch.js` — `export function createPitch(ctx) → { group, update(dt, matchState) }`
Grass field (pitch + ~6 m apron) with procedural texture: alternating mowing stripes
along X (≈ 5.25 m each, subtle two-green difference), low-frequency color mottling, fine
noise. Slightly rough (roughness ~0.85–0.95), no visible tiling at broadcast distance.
All line markings (touch/goal lines, halfway, center circle + spot, penalty areas, six-yard
boxes, penalty spots + arcs, corner arcs) as crisp white — either in the texture at high
resolution or as separate thin geometry slightly above grass (avoid z-fighting). Two goals
with white round posts/crossbar (radius ~0.06), stanchions, and visible nets (double-sided,
semi-transparent fine grid — canvas texture on curved net surfaces, or LineSegments).
Corner flags (yellow flag, dark pole). Optional: subtle worn patches at goalmouths/center.

### `src/stadium.js` — `export function createStadium(ctx) → { group }`
Four rectangular grandstands (English-style tight ground) built EXACTLY on `STANDS`/
`TIERS` geometry so crowd seats sit on the terraces: concrete terrace steps per row, dark
seat-back rows visible where crowd is sparse is NOT needed (crowd covers seats), tier
facades, mid-tier walkway, perimeter wall ~1.1 m behind ad boards. Cantilever roofs over
each stand (dark underside with structural ribs/trusses), corner infill structures or
corner floodlight masts. LED ad boards around the pitch perimeter (≈ 90 cm tall, emissive
canvas texture, FICTIONAL brands only, e.g. "VOLTA ENERGY", "ARMOR TELECOM", "KROAZ AIR";
`update` not required — static emissive is fine but a slow scroll via texture offset is a
nice touch, if so return `{ group, update(dt) }`). Four floodlight towers/roof rigs with
emissive lamp arrays (the actual lights are in lighting.js — make the fixtures LOOK bright
via emissive + these are what bloom picks up). Dugouts + tunnel mouth on the −Z stand.
Dark night sky visible above roofline is handled by lighting.js — don't add a sky here.

### `src/crowd.js` — `export function createCrowd(ctx) → { group, update(dt, excitement) }`
Instanced crowd filling `forEachSeat` seats (~25–30k). Each fan: a camera-facing-ish quad
(or two crossed quads) sampling a procedural sprite ATLAS (canvas: ≥ 8×4 cells of varied
seated/standing fans — silhouettes with heads, shirts in varied colors). Home sections wear
red/black, one away corner block white/blue, plus neutral scatter (scarves/skin/hair color
noise). Fans bob/sway subtly at idle (vertex-shader time offset via InstancedMesh +
onBeforeCompile or a custom ShaderMaterial); `excitement` (0..1) scales amplitude — at 1.0
(goal) fans jump. Must read as a dense living crowd at broadcast distance, not confetti.
Unfilled seats: none — sold out. Keep overdraw sane (alphaTest, not blending).

### `src/lighting.js` — `export function createLighting(ctx) → { update(dt) }`
Night-match rig: very dark blue night sky (large sky dome with subtle gradient + faint
stars, fog `scene.fog` tuned so far stands soften but pitch stays crisp). Base fill:
hemisphere (cool sky / green-ish ground bounce, low intensity) + low ambient. Four
floodlight SpotLights from tower positions (warm-white ~5600K feel), only 2–3 cast
shadows: `mapSize` 2048, tight shadow camera fitted to the pitch, bias tuned (no acne, no
peter-panning). Aim for the classic look: bright even pitch (~soft cross-shadows under
players), stands falling off into darkness, sky nearly black. Set `scene.environment`
via `RoomEnvironment`+PMREM at LOW intensity if it helps materials, optional.

### `src/ball.js` — `export function createBall(ctx) → ball`
`ball = { mesh, pos /*Vector3 == mesh.position*/, vel, spin /*Vector3 rad/s*/, radius:0.11,
controlledBy /*player|null, set by match*/, update(dt), kick(velocity /*Vector3 m/s*/,
spin?), place(x,z), stopDead() }`.
Physics in `update`: gravity 9.81, air drag (quadratic, cd tuned so a 25 m/s shot carries
realistically), **Magnus force** from `spin` (visible curl on curled shots), ground bounce
(restitution ≈ 0.62, loses spin), rolling friction so passes die out naturally, ball
rotation matches roll direction/rate visually. Visual: classic white ball with dark
pentagon-style accents (procedural texture), slight clearcoat sheen, `castShadow`. When
`controlledBy` is set, match/dribbler positions the ball each tick — physics still applies
gravity/ground so keep it stable at feet.

### `src/players.js` — `export function createTeams(ctx) → { players, home, away, update(dt) }`
The make-or-break module: 22 procedural athletes + referee that look GOOD at broadcast
distance and hold up in closeups. Each player is a `SkinnedMesh` humanoid (~8-head athletic
proportions, ~1.78–1.90 m tall) with a code-built skeleton: pelvis, spine, chest, neck,
head, L/R shoulder→upperArm→foreArm→hand, L/R thigh→shin→foot. Build the body mesh
procedurally (smooth-skinned: capsule/lathe-based torso with chest/shoulder mass, real
neck, arms with elbow taper, legs with calf/thigh shape, boots) — weights blended across
joints so elbows/knees bend without cracking. NO blocky robots, no visible seams at
broadcast distance.
Kits from `TEAMS` via canvas texture per team: shirt body/sleeves in team colors, **shirt
number on the back** (big, correct font weight), subtle front crest + fictional sponsor,
shorts + socks per spec, GK in distinct kit, referee in black/yellow. Vary skin tones and
hair (simple cap/short geometry variants, a few bald) via `ctx.rng`.
Procedural animation (no clip files): state machine per player —
idle (weight shift, breathing), walk, run, sprint (arm counter-swing, torso lean into
acceleration/turns, stride frequency & length from speed, feet plant without skating),
plus actions: `pass` (side-foot swing), `shoot` (full swing + follow-through), `tackle`
(slide), `celebrate`, `gk_dive_left/right`, `gk_catch`, `throw_in`. Head tracks the ball
subtly. Root motion: locomotion moves `player.pos`; actions play in place over the current
motion.
Player public API (match.js drives this — keep names EXACT):
`{ id, team /*'home'|'away'|null(ref)*/, number, name, role /*'GK'|'DF'|'MF'|'FW'|'REF'*/,
group, pos /*Vector3, y=0*/, vel /*Vector3*/, facing /*rad, 0=+X*/, maxSpeed,
moveTo(targetV3, speed01), stop(), face(targetV3orRad), playAction(name) → durationSec,
actionBusy() → bool, update(dt) }`.
`moveTo` handles accel (~6 m/s²), decel, turn-rate limits; `update(dt)` integrates and
animates. `createTeams` positions everyone in a 4-3-3 at sensible default spots initially.
Shadows: castShadow on body meshes.

### `src/match.js` — `export function createMatch(ctx, { ball, teams, pitch }) → match`
`match = { state, update(dt), onEvent(cb /*(type, data)=>{} — types: 'kickoff','goal',
'out','save','whistle'*/), setUserInput(input), controlledPlayer }`.
`state = { phase /*'kickoff'|'play'|'goal'|'out'*/, score:{home,away}, clockSec,
half:1|2, possession /*'home'|'away'|null*/, excitement /*0..1, decays*/,
attackDirHome /*+1|-1*/ }`.
Simulation (deterministic via ctx.rng):
- 4-3-3 formations; each player has a home spot that shifts with ball position
  (compact block, push up in possession); off-ball players `moveTo` their spot.
- Ball carrier dribbles (ball glued ~0.4 m ahead of feet via `ball.controlledBy`,
  small touches), decides via simple utility: pass to best open teammate (lead the
  runner), through ball, dribble on, or shoot when within ~22 m with sight of goal.
  Kicks use `ball.kick` with realistic speeds (pass 12–18, shot 22–30 m/s, slight
  curl on shots) and trigger `playAction('pass'|'shoot')`.
- Defenders: nearest presses ball, others mark space; simple tackle when in range.
- GKs: hold line, narrow angle, `gk_dive_*` on on-target shots — saves sometimes,
  concedes sometimes; catches slow balls.
- Rules kept simple: goals (ball fully over line inside frame → 'goal' event,
  celebration ~4 s, excitement=1, kickoff restart), ball out of bounds → quick restart
  for the other team at the spot (no ref stoppage, keeps play flowing). Clock runs
  during play, 45 min halves at ~6× speed so things happen (i.e. clock advances 6 s
  per real second — HUD shows match clock).
- USER CONTROL: `setUserInput({ moveVec:{x,z}, sprint, passPressed, shootPressed })`
  called by main each tick. Nearest home outfielder to the ball becomes
  `match.controlledPlayer`; input overrides its AI (move/pass/shoot). Zero input for
  N seconds → full AI (attract mode / screenshots). Passes/shots from the user pick
  sensible targets (nearest forward teammate / goal).

### `src/cameraRig.js` — `export function createCameraRig(ctx, { ball, teams, match }) → { camera, update(dt), setMode(m) }`
Creates its own `PerspectiveCamera`. Modes:
- `broadcast` (default): elevated main-stand camera at z ≈ −46, y ≈ 24, x tracks ball
  with smoothing + velocity lead, clamped so pitch framing stays composed; FOV ~24–34
  (slight zoom-in when play is central, wider near boxes). This must look EXACTLY like
  a TV master camera: stable, damped, never jittery.
- `closeup`: lower (y≈3.5), tighter FOV, nearer sideline — for player detail shots.
- `goal`: behind-goal view of the attacked goal. `stadium`: high wide establishing
  shot showing bowl + pitch. `replay`: slow orbital dolly around the ball.
On 'goal' events, optionally auto-cut: closeup on scorer → back to broadcast.
`update(dt)` does all smoothing (use `damp`), and must converge when called repeatedly
in fast-forward (screenshot mode calls it during warm-up).

### `src/hud.js` — `export function createHud({ match }) → { update(dt) }`
DOM inside `#hud` (already in index.html, pointer-events:none). Broadcast package,
ORIGINAL design (don't copy EA/FIFA layouts exactly): top-left score bug — dark glass
rounded bar with two team color chips, "BRZ 0 — 0 GAL", match clock (from
`state.clockSec`, MM:SS), small "LIGUE FABLE · ARMOR PARK" microtext. Goal moment: animated
lower-third banner (team color sweep, "GOAL — BREIZH FC", scorer number), auto-dismiss.
Kickoff: brief center card with team names/crests (procedural CSS crests fine). Bottom-right
faint controls hint (WASD/arrows · X pass · SPACE shoot). Everything crisp at 1080p,
system-ui/SF font stack, subtle CSS transitions. Update cheaply (only touch DOM on change,
clock at 2 Hz).

### `src/postfx.js` — `export function createPostFX(ctx, { camera }) → { composer, update(dt), resize(w,h) }`
EffectComposer chain: RenderPass → UnrealBloomPass (threshold ≈ 0.85, strength ≈ 0.3,
radius ≈ 0.4 — floodlights/ad boards glow, grass must NOT bloom) → subtle custom grade
ShaderPass (very light: −5% lift in a cool direction on shadows, +5% saturation, gentle
vignette 0.25) → SMAAPass → OutputPass (needed on r166 for correct color/tonemapping).
Main calls `composer.render()`; `resize` wires sizes/pixelRatio.

## Wiring (main.js — already written, READ IT)

Main builds ctx, calls factories in order (lighting, pitch, stadium, crowd, ball, teams,
match, cameraRig, hud, postfx), runs a fixed 120 Hz sim step + rAF render, forwards input,
and implements screenshot mode via URL params (`?cam=broadcast&t=12&seed=7`): fast-forwards
t seconds of simulation deterministically, renders one frame, sets `window.__SHOT_READY`.
Anything you need that main doesn't pass — derive it from ctx or your own imports of util.

## Definition of done (per module)

`node --check src/<file>.js` passes; exports match this contract EXACTLY; no console
errors when integrated; visual quality at broadcast camera reads as televised football,
not a tech demo. You will be reviewed by a hostile art director with screenshots.
