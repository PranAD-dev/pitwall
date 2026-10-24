# Pit Wall Explainer (M7 · voice)

When anyone asks *"why did Pit Wall do this?"*, it produces a **30–90s narrated
explanation**: a calm finance-analyst voice explains the decision while the black
terminal **builds the evidence on screen like a lesson** (Opennote-style) — a
table of installments whose account suddenly changed, the hard-checks ticking, the
appearance calc falling short. No avatar, no stock video: voice + our own tables.

## Hard rules (enforced, not promised)
- **Read-only.** Every query runs as the `voice_readonly` Postgres role (SELECT on
  `work` + `golden`, **no** `payroll_private`, no writes). The agent can never
  propose/approve/pay/post. A spoken "yes" is never an approval — writes go through
  the gateway under a human's identity.
- **Never speaks a number a tool didn't return.** Code builds each scene's facts +
  canvas from tool output; the model only writes the one-sentence `say` lines; then
  code validates that every number spoken appears in that scene's facts or on the
  canvas (`pitwall/explain/plan.py` → `validate_scene`). Fails → regenerate once →
  fall back to a template.
- **Only what was known then.** Past decisions are rebuilt with `world_as_of(t)` +
  the policy version in force at `t`; "what I've learned since" is said separately.

## Run it offline (no keys) — this is the demo today
```bash
make reset                      # world + Tiger
uv run pitwall explain seed-demo        # seed WI-5602 (fraud hold) + WI-5611 (add-on reject)
uv run pitwall explain plan WI-5602                     # terminal playback, grounded
uv run pitwall explain plan WI-5602 --as-of 2026-05-05T09:19   # the rewind
uv run pitwall explain export WI-5602 -o voice/plan.js         # then open voice/replay.html
```
`voice/replay.html` is the audio-fallback player: double-click it to watch the
explanation build live (captions + canvas), no server required.

## Turn on voice (LiveKit, data-channel wiring)
`agent.py` follows the proven **classic-worker + data-channel** pattern from
`Steve-Dusty/virtualhelper` (`cli.run_app(WorkerOptions(entrypoint_fnc=…))`,
`room.on("data_received")`, `publish_data(topic=…)`). It's **request/response** —
your UI button sends an explain-request, the agent builds the grounded plan and
streams the scenes back:

| topic | dir | payload |
|---|---|---|
| `lk.explain-request` | UI → agent | `{requestId, subject, as_of?}` |
| `lk.explain-processing` | agent → UI | `{requestId, status:"processing"}` |
| `lk.explain-plan` | agent → UI | `{requestId, plan}` (full grounded plan) |
| `lk.explain-scene` | agent → UI | `{requestId, index, total, scene}` (paced, build-live) |
| `lk.explain-error` | agent → UI | `{requestId, error}` |

Pick the data with `EXPLAIN_SOURCE` (`json:<dir>` | `pitwall` | unset=sample).

```bash
cd backend && npm install && npm start        # token + room + agent dispatch (:3001)
uv pip install -r voice/requirements.txt
EXPLAIN_SOURCE=json:/your/requests  uv run python voice/agent.py dev
```
Frontend: `GET /token?room=…` to join, then
`room.on('dataReceived', (p, part, kind, topic) => …)` for the scenes and
`publishData(encode({requestId, subject}), {topic:'lk.explain-request', reliable:true})`
on the button. Speak each scene with Cartesia or the browser's speech synthesis.
(`voice/token_server.py` is a Python-only token minter if you prefer; the Node
`backend/` is the reference wiring and also dispatches the agent.)

## Files
- `pitwall/explain/tools.py` — read-only tools (voice_readonly role)
- `pitwall/explain/plan.py` — grounded plan builder + `draw` canvas + validation
- `pitwall/explain/seed_demo.py` — demo work items
- `agent.py` — LiveKit voice agent (keys-gated) · `token_server.py` — join tokens
- `replay.html` — offline scene + canvas player · `plan.js` — exported plan (generated)
See [`../docs/CARTESIA.md`](../docs/CARTESIA.md) for the Cartesia track write-up.
