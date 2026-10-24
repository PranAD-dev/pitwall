# DECISIONS.md

Running log of defaults chosen without blocking the user, per the build prompt
(§5: "pick a sensible default, write it down, keep going"). Newest first.

## Conventions
- **D-###** id · date · decision · why · how to revisit.

---

### D-011 — 2026-10-23 — Running on Tiger Cloud (hosted Postgres+TimescaleDB)
`PITWALL_DATABASE_URL` points at a Tiger Cloud service (PostgreSQL 18.6, timescaledb
+ timescaledb_toolkit). Migrations run as `tsdbadmin`; the app connects as the
least-privilege roles (userinfo swapped, `sslmode=require` preserved). Verified: full
schema + 24mo world + demo items loaded, `sow walk` works, DB limits hold over SSL.
**Why:** survives restarts, shareable with teammates, and it's the MLH Tiger Data
prize surface. Local docker still works — comment the URL out to use it.
**Cloud commands:** `make cloud-reset` (migrate+generate+seed, no docker); NOT
`make reset` (that spins up local docker). Gotcha seen: fresh service DNS has a
negative-cache window (~45s) — retry if first connect says "failed to resolve host".
The URL is a live credential, in gitignored `.env` only; rotate after the hackathon.

### D-010 — 2026-10-23 — Fully-simulated mode is the default, keys are adapters
We have no API keys yet, so every external dependency is a pluggable adapter with
a mock implementation selected by env flags: `PITWALL_LLM_MODE=auto` (mock LLM when
no `ANTHROPIC_API_KEY`), `PITWALL_X402_MODE=mock` (SIMULATED tx hashes, no CDP
wallet), voice disabled when LiveKit/Cartesia keys absent.
**Why:** the whole system must run and be demoed with zero credentials, and the live
hackathon demo must be deterministic/reproducible anyway (prompt §13). Keys only
*upgrade* an adapter; they never change behaviour the judges see on the queue.
**Revisit:** drop keys into `.env`; adapters switch to live automatically.

### D-009 — 2026-10-23 — Mock LLM is deterministic and seeded, not random
The mock LLM returns rule-derived proposals so the agent loop, demo, and eval all
run offline and reproducibly. The *decision* is always made by hard checks in code
(prompt §7 "code decides"); the LLM only proposes + explains, so a deterministic
stand-in loses no architectural fidelity.
**Revisit:** set `ANTHROPIC_API_KEY` + `PITWALL_LLM_MODE=live` for real narration.

### D-008 — 2026-10-23 — Python core package `pitwall/`; prompt's /gateway /agent /world /eval live inside it
The prompt lists these as top-level dirs. We keep them as submodules of one
installable `pitwall` package (`pitwall/gateway`, `pitwall/agent`, `pitwall/world`,
`pitwall/eval`) for clean imports and a single `pitwall` CLI. `/db` (SQL), `/sellers`
(Node x402 service), `/skill` (standalone reusable package), `/web`, `/voice` stay
top-level because they are separate runtimes/artifacts.
**Why:** avoids sys.path gymnastics across four sibling dirs; one `uv sync`.
**Revisit:** only if a judge specifically wants the literal dir layout.

### D-007 — 2026-10-23 — Local TimescaleDB (`timescaledb-ha:pg16`) mirrors Tiger Cloud
We develop against the `-ha` image because it bundles `timescaledb_toolkit`
(hyperfunctions). Switching to Tiger Cloud is a single `PITWALL_DATABASE_URL`.
**Why:** no Tiger Cloud key yet; identical extension surface so nothing is rewritten.
**Revisit:** set `PITWALL_DATABASE_URL`; `make migrate` targets the cloud.

### D-006 — 2026-10-23 — Python pinned to 3.12 via `.python-version`
System Python is 3.14 (very new); `psycopg[binary]` and friends may lack 3.14
wheels. `uv` fetches 3.12 for a clean, binary-wheel install.
**Revisit:** bump when the dependency wheels catch up to 3.14.

### D-005 — 2026-10-23 — Full schema ships in M0, logic fills in later
M0 creates the *entire* schema (golden + System of Work + SoR source schemas +
payroll_private + roles + append-only trigger), even though the gateway/agent that
use `work.*` arrive in M1/M2. One coherent migration beats piecemeal DDL.

### D-004 — 2026-10-23 — raw_ref lineage now, formal raw->std->golden sync in M1
The M0 generator lands a `raw.raw_record` row per source fact (stable
`raw_ref = md5(source|src_id)`) and writes canonical `golden.*` rows carrying that
`raw_ref`. The dedicated sync module (standardise + golden materialisation + cursors)
is built in M1. This gives us lineage + idempotent re-sync from day one.

### D-003 — 2026-10-23 — Append-only audit log enforced by trigger + grants, not just convention
`work.audit_log` has a BEFORE UPDATE/DELETE trigger that raises, plus UPDATE/DELETE
revoked from every role. Even a buggy gateway cannot rewrite history.
**Why:** prompt §13 non-negotiable; makes the "months later, why?" query trustworthy.

### D-002 — 2026-10-23 — Four least-privilege DB roles, limits in the database
`pitwall_agent` (SELECT on golden + work views, **no** payroll_private, **no** journal
writes), `gateway` (only writer of journal entries / installment status / audit_log),
`sync` (writes raw/std/golden), `voice_readonly` (SELECT on audit + as-of views).
Limits live in grants, not prompts (prompt §13). We can demo a real `permission denied`.

### D-001 — 2026-10-23 — Repo at ~/pitwall, `uv` for Python, `make` as the one front door
`make reset` wipes+rebuilds the world; `make demo` runs the scenario; `make eval`
scores it. Everything deterministic and seeded (`PITWALL_SEED`).
