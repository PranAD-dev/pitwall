# FIFACHER

A broadcast-presentation football game built in Three.js. Night match at the
**Stade Raoul Brulat, Draguignan**: **Sporting Club Draguignan** (white/black)
vs **Stade Saint-Aubinais** (red/black).

> Crests are **original designs** in each club's colours, generated in code. The
> clubs' real badges are their own property and are not reproduced here.

### The Acher family XI

Draguignan are **eleven Achers**, goalkeeper included. Shirts carry FIRST names,
because "ACHER" on eleven backs tells you nothing. Every Acher has a signature
hair colour.

| # | Player | Role | Hair | Top speed |
| --- | --- | --- | --- | --- |
| 1 | **Francette** | GK | amber | 8.1 |
| 2 | **Anaé** Acher | DF | teal | 9.5 |
| 3 | **Roxane** Acher | DF | violet | 9.4 |
| 4 | **Alain** Acher | DF | steel grey | 9.2 |
| 5 | **Augustine** Acher | DF | white | 9.4 |
| 6 | **Adrien** Acher | MF | orange | 9.6 |
| 8 | **Élise** Acher | MF | green | 9.7 |
| 11 | **Chloé** Acher Gonort | MF | red | 9.6 |
| 9 | **Léa** Acher | FW | pink | 9.9 |
| 7 | **Mathieu** Acher ★ | FW | electric blue | **17.3** |
| 10 | **Gabriel** Acher ★ | FW | platinum gold | **17.0** |

★ = **super star**: double pace *and* every shot is a goal. The rest of the
family get signature hair, a first-name shirt and a modest edge (~1.15×), but no
goal guarantee — ten unstoppable players turns every match into a 30-0 formality
with nothing left to play. **To promote anyone, add `superStar: true` to their
row in `ACHERS` (`src/util.js`)** — nothing else needs to change.

The two supers run at twice everyone else's top speed (~17 m/s against ~8.5), their
team-mates look for them ahead of any other pass, they shoot from anywhere
inside 60 m, and **every shot either of them takes is a goal** — the keeper is
removed from the equation entirely for their attempts, including the
point-blank stop where a keeper may normally pluck a fast ball out of the air.

Measured over three full matches (seeds 7, 21, 99): Draguignan won 9–0, 7–1 and
11–0, both supers scored in every match, and **not one of their shots was ever
saved**.

Both supers must be declared `FW`: roles drive the formation slot, and a fourth
declared forward gets pushed into central midfield — which is exactly where #10
ended up in an earlier build, 67 m from goal, never shooting.

### Commentary

Spoken with the browser's own speech synthesis — **no audio files**. Two casts:

- **Gabriel and Mathieu** get the full play-by-play voice: name plus a line of
  increasingly unreasonable praise, with personal lines each.
- **Everyone else in the family** gets their **first name only**, hurled by a
  second, deliberately more excitable voice (higher, faster).

The two voices are picked from the platform's installed French voices in an
explicit priority order — play-by-play prefers Thomas/Jacques/Nicolas, the hype
cast prefers a different one (Marie/Amélie), and novelty voices (Grandma,
Rocko…) are excluded. On macOS this resolves to **Thomas** and **Marie**. Rate
and pitch jitter a few percent per line, because identical prosody every time is
most of what reads as "robot".

**A listed voice can be silently mute.** Chrome on macOS offers
`Daniel (French (France))`, accepts it, and then never produces a sound — which
is exactly why the two supers were silent for a while when an earlier version
picked voices by regex over list order. Every utterance is now watched: if it
has not started within 900 ms, that voice is blacklisted for the session and the
line is retried with no explicit voice, falling back to the system default.

**A rotating spotlight names the players the ball never reaches.** Measured
selection time over 400 s: the two supers take 47%, the front six take nearly
all the rest, the centre-backs under 1% — Anaé was never selected once. Gating
every mention on selection meant half the family was simply never named, so a
separate timer periodically shouts whichever non-super Acher has waited longest.

It also comments on the **match**, not just on players: turnovers ("Cadeau ! Un
cadeau à l'adversaire !"), balls out of play, saves, and the atmosphere in the
Dracénie — fired off real match events and possession changes, on a slower
budget so it never talks over a player line.

"But" is spelled correctly rather than stretched: a synthesiser reads `BUUUT` as
a nonsense word. The drama comes from repetition and prosody instead.

A **subtitle** always appears, so the commentary is visible even on a muted
device or one with no French voice installed. Press **M** to mute.

Browsers refuse speech until you have interacted with the page, so the first
line arrives after your first tap or keypress.

> **Voice quality is bounded by the OS.** The Web Speech API only exposes voices
> the system already has; genuinely neural-sounding speech would mean either a
> model download or a cloud TTS call, and this project ships no assets and makes
> no network requests. Installing better French voices at OS level (macOS:
> System Settings → Accessibility → Spoken Content → System Voice → Manage
> Voices; Android: Google Text-to-speech) improves it immediately, with no code
> change.

Everything in the scene is generated in code — there is not a single image, model,
font or audio file in the project. Grass, kits, crowd sprites, advertising boards,
concrete and the night sky are all painted onto canvases at load time; the players
are procedurally-built skinned meshes animated by code rather than by animation
clips.

**Play it: <https://blog.mathieuacher.com/fifacher/>**

## Run it locally

```bash
npm run serve          # http://localhost:8017
```

### Install it on a phone

Open the site in Chrome on Android and choose **Add to Home screen**. The web
manifest gives it the FIFAcher name, icon and a landscape, fullscreen launch.
iOS: Share → Add to Home Screen. **Use the `https://` URL** — home-screen
install and some browser APIs require a secure context.

Any static server works — three.js is vendored into `vendor/`, so the site needs
no build step, no CDN and no `npm install` to run. `npm install` is only needed
for the headless tooling in `tools/`. Requires a WebGL2 browser.

## Controls

You control the Draguignan (white) outfielder marked by the **ring at his feet
and the chevron above his head**. Control passes automatically to whoever receives
the ball. Stop giving input for three seconds and the AI takes over, so the game
doubles as an attract mode.

| Action | Keyboard | Gamepad (Switch labels) |
| --- | --- | --- |
| Move | `WASD` / arrows | Left stick (analog: half-tilt jogs, full sprints) |
| Sprint | `Shift` | `ZR` |
| Short pass | `X` | `B` (bottom face button) |
| Through ball | `C` | `Y` (left face button) |
| Lofted through ball | `V` | `X` (top face button) |
| Shoot | `Space` | `A` (right face button) |
| Switch player | `Q` / `Tab` | `L` or `R` |

**Switch** picks the outfielder *nearest the ball*, excluding whoever is already
selected — not a cycle through the squad, which would send you further from the
action on every press. The choice then holds for four seconds even while your
own team has the ball; without that hold the selection snapped straight back to
the carrier on the very next tick, and since Draguignan dominate possession the
button looked completely dead.

Off the ball, pass/through presses **contain and tackle**, and shoot commits to a
**slide tackle** — so the buttons are never dead.

Gamepad buttons are bound by **physical position**, not by printed letter, using
the Gamepad API's standard mapping (`buttons[0]` = bottom, `[1]` = right,
`[2]` = left, `[3]` = top). The table shows Nintendo's labels; an Xbox or
PlayStation pad works identically with its own letters in those positions. The
on-screen hint switches to pad labels as soon as a controller is detected.

**Through ball vs. short pass:** a short pass finds a teammate's feet. A through
ball ignores feet and plays into the *space* ahead of a runner, weighted toward
whichever direction you're holding the stick — hold toward the player you want
and it will pick him. The lofted version chips the same ball over the last
defensive line.

### Mobile

On a phone or tablet the game mounts a **floating thumbstick** (appears wherever
your left thumb lands, so you never have to look for it) and a four-button pad
in the gamepad face-button diamond, labelled by **action** rather than by
console letter — PASS, SHOOT, THRU, LOB — plus SWITCH and SPRINT. Portrait shows
a rotate prompt: a 105 × 68 m pitch has nowhere to go in a 9:16 frame.

Mobile also auto-selects the low-cost path: reduced crowd count, smaller
textures, and device pixel ratio capped at 1.5 (phone panels report 3, which
would render four times the pixels for detail invisible at arm's length).
Override with `?quality=high` if you want to push it.

Touch controls mount only when the **primary** pointer is coarse, so a
touchscreen laptop keeps its keyboard controls and a clean screen.

## Stadium atmosphere

`audio.js` synthesises the sound live with Web Audio — **no audio files**, same
rule as everything else.

- **Brouhaha** — four decorrelated noise bands (body at 180 Hz, babble at
  520 Hz, movement at 1.25 kHz, air at 3.2 kHz), each with its own slow swell.
  One filtered noise source reads as radio static; independent drifting bands
  read as a crowd. Sparse single voices — whistles, shouts — cut through, because
  a steady bed with no transients still sounds synthetic.
- **Cicadas** — Draguignan is in Provence, and the mix is deliberately
  caricatural: the cicadas ARE the soundtrack and the stadium sits behind them.
  A cicada is a narrow noise band amplitude-modulated at 40–70 Hz — the buzz
  *is* the modulation. They wind up, hold and wind down individually, and
  **every 10 minutes a whole hillside goes up at once**: 16–26 overlapping
  singers entering on a staggered ramp so the wall builds rather than switching
  on, held, then dying away raggedly. Tune with `?cicada=25` to hear one without
  waiting, or `?cicada=0` to switch choruses off.
- **Chant** — kick, massed claps and a sung two-note figure, but only once the
  crowd is genuinely up. A drum loop over a quiet match is what made the first
  version sound like a toy.
- **Roar** with whistles on every goal, and an **original** walk-out fanfare at
  kickoff.

Patterns are scheduled on the AudioContext clock, never from
requestAnimationFrame — rAF jitter is audible as unsteady rhythm.

Speech synthesis plays *outside* this AudioContext, so nothing mixes the two for
us: a bed loud enough to be caricatural would simply bury the commentary. The
ambience therefore **ducks to 30% whenever the commentator is speaking**, fast
on the way down and slow on the way back.

> **Why not a real anthem?** Chants like *Aux armes* and songs like *Jump* are
> copyrighted recordings. Shipping them in a public repository would be
> redistributing someone else's work, so this project synthesises its own
> atmosphere instead. Wiring a local audio file is trivial if you want one for
> private use — but it should not be committed or deployed.

## URL parameters

| Param | Values | Meaning |
| --- | --- | --- |
| `cam` | `broadcast` `closeup` `goal` `stadium` `replay` | Camera mode |
| `t` | seconds | Fast-forward the sim deterministically, then render one frame |
| `seed` | integer | RNG seed — same seed gives byte-identical results |
| `quality` | `high` `low` | Crowd count and texture sizes |
| `live` | `1` | Keep animating after a `t=` warm-up instead of freezing |
| `cicada` | seconds | Gap between cicada choruses (default 600; `0` disables) |

`?t=` is what makes the screenshot tooling reproducible: it steps the fixed 120 Hz
simulation forward, settles the camera damping, renders once and sets
`window.__SHOT_READY`.

## Architecture

`src/main.js` builds a shared `ctx = { scene, renderer, rng, quality }`, calls each
factory in order, then runs a fixed 120 Hz simulation step decoupled from
requestAnimationFrame rendering.

| Module | Owns |
| --- | --- |
| `util.js` | World constants, seat iteration, seeded RNG, canvas-texture helper |
| `lighting.js` | Night sky, fog, four floodlights, shadows, exposure |
| `pitch.js` | Grass, markings, goals, nets, corner flags |
| `stadium.js` | Terraces, roofs, ad boards, pylons, dugouts, tunnel |
| `crowd.js` | ~27k instanced spectators in a single draw call |
| `ball.js` | Ball physics — drag, Magnus, bounce, roll |
| `players.js` | 22 players + referee: skeletons, kits, procedural animation |
| `match.js` | Formations, AI decisions, rules, scoring, user input |
| `cameraRig.js` | Five camera modes with damping |
| `hud.js` | Broadcast graphics package (DOM) |
| `postfx.js` | Bloom, grade, vignette, antialiasing |
| `input.js` | Keyboard + gamepad, unified into game intents |
| `touch.js` | Mobile thumbstick and action pad |
| `commentary.js` | Spoken French commentary for players and match events |
| `audio.js` | Synthesised stadium atmosphere (Web Audio, no files) |

Stadium terraces and crowd seats are both derived from `STANDS`/`TIERS` and
`forEachSeat()` in `util.js`, which is why spectators land exactly on the steps.

### Conventions

- Pitch is 105 × 68 m, centered on the origin. Length along **X** (goals at
  x = ±52.5), width along **Z**. The TV stand and broadcast camera are on **−Z**.
- Simulation never calls `Math.random()` or `Date.now()` — only `ctx.rng` and
  accumulated `dt`. This is what keeps `?seed=` reproducible.
- At most three shadow-casting lights, all owned by `lighting.js`.

## Tooling

```bash
node tools/shot.js "<url>" out.png     # headless 1080p screenshot, reports JS errors
tools/shots.sh shots/rN [seed]         # the ten-angle review set
node tools/simcheck.js [secs] [seed]   # headless gameplay stats: goals, shape, touches
node tools/perf.js [cam] [secs] --gpu  # frame timings + real WebGL renderer string
node tools/rendercost.mjs              # true render cost (gl.finish, ignores vsync)
node tools/makeicons.mjs               # rasterise icon.svg to the PNG icon set
node tools/voicediag.mjs               # real-browser check of the spoken commentary
node tools/inputcheck.js               # asserts the keyboard drives the controlled player
node tools/fakepad.mjs                 # injects a synthetic pad to verify button/stick mapping
```

`perf.js` reports wall-clock frame time, so a backgrounded window shows a
vsync-locked 30 or 60 fps regardless of load — tell them apart by the spread:
a GPU-bound scene has p95 well above p50, a throttled one has p95 ≈ p50. Use
`rendercost.mjs` when you need the real number.

`tools/critic-brief.md` is the review rubric used to score renders against
commercial football games.

## Measured

- **62.9 fps** mean at 1920×1080 on an Apple M4 Max (9.5 ms median frame).
- A 300-second headless match produced a goal, four saves, 16 distinct players
  touching the ball, a 29.9 m/s peak shot, and outfield shape holding a 15–22 m
  spread — formation discipline rather than ball-chasing.
