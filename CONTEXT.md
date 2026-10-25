# Pit Wall — Project Context

> Autonomous **transfer-finance agent** for a fictional football club, **Harbourside FC**.
> Cal Hacks 13.0 · Hyphenate "Beyond Agentic Harnesses" track (+ Coinbase x402, MLH Tiger
> Data, Cartesia). Fully simulated (a deterministic ~24-month world) but the system —
> gateway, least-privilege DB roles, append-only audit, double-entry books, learning — is real.

**One line:** *Pit Wall turns every money event at a football club into correct, balanced
double-entry accounting — with an audit of why. It auto-handles the routine, and escalates
the judgment calls to its accounting team (you), learning from every call you make.*

**The framing (the Hyphenate pivot):** `golden.*` = the **System of Record**; we build the
**System of Work** on top. The headline is the **accounting impact** (what journal entries an
event becomes), not "is this claim valid" — claims/fraud/clause checks are *inputs that pick
the entry (or hold it)*. Precision-first: be right on what you auto-complete, escalate the rest.

---

## 1. Architecture

```
Systems of record (simulated)  →  golden.*  (one shape, raw_ref traceable)
                                     │
   perceive (Claude)  →  decide (CODE: hard-check gate)  →  post (gateway only)  →  audit
     ai_agent             detectors.py returns an action      golden.journal_entry   append-only
   proposes, never        (100%-precision guarantee)          balanced double-entry   log
      posts
```

- **Perceive = LLM, Decide = code.** The scenario agent (Claude `claude-opus-4-8`, tool loop:
  `recall_memory → run_sql → propose`) only *classifies* + *locates the real rows*. The
  **hard-check gate** (`pitwall/agent/detectors.py`) makes the call from the data, so the LLM
  can't move money or break the score, and can't state a number that didn't come from a queried row.
- **Gateway is the one door** (`pitwall/sow/gateway.py`): `create_work_item → transition` (state
  machine) → `post`/`auto_complete`. Only the gateway writes the ledger + work state.
- **Separation of duties** (`pitwall/sow/roles.py`): whoever proposes can't approve; the agent
  can't `post`. Enforced in code **and** in the database (grants).
- State machine: `NEW → PROPOSED → (ask → NEEDS_INFO → answer → PROPOSED) → APPROVED → POSTED`
  (+ `HELD`). A correction is reverse+repost, never a delete.

---

## 2. The accounting engine (the deep field — DONE)

`pitwall/accounting/` turns the SoR into a general ledger that **ties to the cent**.

- **`engine.py`** — `Entry` + `dr()/cr()`; `post()` REFUSES an unbalanced entry (`Unbalanced`);
  `reverse()` + `reverse_and_repost()` link corrections via `reverses`/`source_ref` (never delete).
- **`coa.py`** — football chart of accounts (cash, VAT recoverable, transfer receivable/payable,
  solidarity AR, registrations + accumulated amortisation, wages/staff-wages/bonus/agent expense,
  disposal gain/loss, FX, deferred/sponsor/matchday revenue…).
- **`posting.py` `build_books()`** — walks the SoR and posts the whole GL idempotently:
  capitalise registrations, amortise, disposals with gain/loss, pay/collect installments,
  sponsor + matchday revenue, and the **three squad-cost roles** (below).
- **`squad_cost.py`** — the chosen deep roles, each a full sub-ledger lifecycle:
  **wages** (accrue player + staff → pay), **bonuses** (accrue by type → pay), **agent fees**
  (GFC6 split: club-service capitalised + recoverable VAT / player-service expensed, BIK,
  non-recoverable VAT; the split is *learned* from history). `books.squad_cost_ratio()` =
  (wages + bonuses + amortisation + agent fees) / revenue vs PL 85% / UEFA 70%.
- **Real money notes for decisions** — `pitwall/agent/money_notes.py`: a money-moving decision
  (pay installment, collect/solidarity, split wire) now posts a **balanced** double-entry with
  the amounts the agent already computed (not a placeholder label). Governed by pol-100's
  `transfer_settlement` clause. (This closed the old "journal lines are stubs" gap.)

**Contract-amendment cascade** (`pitwall/accounting/amend.py` + `golden.contract_amendment`):
a deal's UID (`transfer.id`) links the registration + agent fee + installments + clauses. An
amendment (extension / fee renegotiation / early termination) resolves the blast radius and
**reverse+reposts** the legs that change (lineage preserved), while **escalating** the legs it
must not guess. Edge cases handled: UEFA 5-year cap, impairment-below-book, invalid effective
date, over-amortised, closed-period → reverse+repost, agent-fee re-amort basis → escalate.
Endpoints `/api/amendments`, `/api/amend/apply?id=`. **Books tie through every cascade.**

---

## 3. The agent lifecycle — onboard, work, learn

- **Onboarding (self-learning)** — `pitwall/agent/policy.py` + `capability.py`: the agent mines
  the club's own history and **discovers** the accounting policies (pattern pass → grounded
  counts; model pass → Claude reasons over them). It proposes 6 IFRS/UEFA/GFC6 policies
  (pol-100..120), a **human approves** them (nothing is active until approved), and they index
  into Moss. The stadium onboarding is interactive (see §5).
- **Human-in-the-loop** — when the agent escalates (it won't guess), the case goes to the
  **accounting team (you)** in the Teamwork Terminal; you make the call, and it's recorded.
  Every escalation (incl. fraud holds) opens the HITL bar — the conversation continues, it
  doesn't dead-end.
- **Self-improving** — `pitwall/agent/improve.py`: your call becomes a **precedent**; once enough
  alike accumulate the agent **proposes a generalized policy** (the team evidence-gates it), so
  the same correction isn't needed twice. HITL goes down over time. All counts are real/dynamic.
- **Clause-trigger family** (`detectors.py`) — real-world edge cases as detectors, each a
  logic gate → proximity/risk alert → escalation (never auto):
  - **Wage suspension** (Mendy v Man City): suspended ≠ terminated; no withholding clause ⇒
    keep paying (unlawful-deduction risk); has clause ⇒ propose-with-sign-off.
  - **Loan-to-buy** (CAS): minute-accurate qualifying appearances (89th-min subs don't count),
    proximity warning, mandatory-purchase commitment, deadline-lapse, relegation-void.
  - **Article 15 sporting just cause**: <10% participation ⇒ zero-fee-loss risk + the 15-day
    post-season window (open/closed flips the risk).
- **Clause guard** (`pitwall/agent/clause_guard.py`, `/api/deal/{id}/clause-scan`): enumerates
  EVERY clause on a deal's UID + the player's employment contract, checks each, auto-clears the
  clear, and hands the human each flagged clause with **a plain-English read AND the verbatim
  terms** (so they verify vs source; a bespoke/unknown kind is surfaced + escalated, never ignored).
- **Clause-analyst subagent** (`pitwall/agent/clause_analyst.py`): on a clause-based escalation
  the agent **delegates the clause to a focused subagent** that reads it closely and returns a
  short grounded report (summary, interpretations, financial implication, risk, recommendation).
  The report rides along with the HITL prompt.
- **Clause registry** (`pitwall/accounting/clauses.py`, `POST /api/clause`): clauses + their
  trigger conditions are **data** — add one and the detectors evaluate it immediately.

---

## 4. Data model (Postgres / TimescaleDB on Tiger Cloud)

Schemas: `golden` (canonical SoR), `work` (system of work), `raw` (landing), `payroll_private`
(walled), `explain`, `retrieval` (Moss).

**golden.*** core: `counterparty, player, transfer, installment, contract_clause, invoice,
sponsor_contract, period, journal_entry, historical_outcome, ticket_sale, forecast_snapshot,
payroll_cost, payroll_run, staff` + hypertables `bank_transaction, match_event, fx_rate`.

**New this session:**
- `golden.contract_amendment` (migration 21) — the modification event the cascade reads.
- `golden.player_wage_run` (migration 22) — per player, per month: **paid / unpaid / pending**
  (the salary *amount* stays sealed; the *status* is operational).
- `golden.player_obligation` (migration 22) — what we still **owe** a player (wage / bonus /
  agent_fee / image_rights / loyalty), outstanding vs settled — e.g. on departure.
- `golden.player.status` / `leaving_date` — active / **leaving** / departed / suspended.

**work.*** — `work_item, audit_log` (append-only), `policy` (versioned), `precedent, question,
x402_payment, explanation, moss_outbox, retrieval_metric`.

**payroll_private.*** — `salary`, `staff_salary`. **The agent is denied schema USAGE** → it can
see wage payment *status* + outstanding *AP*, but never an individual salary *rate*. Verified
live (`permission denied for schema payroll_private`).

### Roles (`db/schema/*_grants.sql`) — limits in the DB
`superuser` (migrations/seeds) · `pitwall_agent` (SELECT golden+work only) · `gateway` (the only
ledger/work writer; appends audit) · `sync` (raw→golden) · `voice_readonly` (explainer) ·
`retrieval` (Moss; writes only its telemetry). No role may UPDATE/DELETE `work.audit_log`.

---

## 5. The stadium (frontend — `web/fc/`, served at http://localhost:4055/)

Procedural three.js stadium (volt-green `#c6ff2e`), one page, FastAPI serves it (no CORS).
**No crowd/commentary audio** (removed) — only the Cartesia report narration speaks.

**Menu cards:** **01 Control room** (→ Teamwork Terminal) · **02 Blueprint board** ·
**03 Onboard** (agent roster + create/onboard) · **04 History**. Billboards default to clean
**cover cards** (not repeated slides): Onboarding · History · Teamwork Terminal · The Books ·
Autonomous Run · Audit Log.

- **Teamwork Terminal** (billboard 0): "the agent is on duty — hand it a case." Type (or **⌘V
  paste**) a scenario → live trail with receipts (every `run_sql` prints the real rows). A
  **📄 FULL REPORT** button opens the run's report on a billboard. When the agent escalates, the
  **amber HITL bar** drops in (your call, as the accounting team) — with the **clause subagent's
  report** when the case turns on a clause — and your decision is recorded as a precedent.
- **Onboard**: a roster of onboarded agents (expand to see each one's policies) + **Create new
  agent** (name + reasoning engine only — it *discovers* the policies). Onboarding streams its
  trail of thought on a billboard → a human approves the proposed policies → "saved to memory".
- **History** (billboard): fast list of real transactions in a **Topics rail**; click one and
  its **full report builds ON a billboard** (≥4 scenes ending on the *append-only audit trail*).
  A HUD there: **▶ Play** (reads it out via Cartesia + auto-advances), **← →**, **⬇ Download**
  (markdown, in-stadium), and **ask the agent about this event** (grounded Q&A).
- **The Books / Autonomous Run / Audit Log** billboards; nav bar: AUTO RUN · LOGS · VIEW BOARD ·
  ← → · OVERVIEW · ⛶. **👁 FIELD** = clean view.

Key files: `main.js` (orchestration + all surfaces + the in-stadium report/HITL/onboard),
`reporter.js` (scene renderer), `terminal.js` (terminal/logs), `cover.js` (billboard covers),
`index.html` (menu + all the HUD bars/overlays).

---

## 6. Backend API (`api/app.py`, FastAPI :4055)

- `GET /api/scenario/stream?text=` — SSE scenario trail (think/recall/run_sql/propose/post/
  escalate/forecast/report/**clause_report**/**await_human**/done).
- `POST /api/scenario/resolve?wi=&situation=&decision=` — HITL: record the human's call as a
  precedent, apply it, and try to generalize a policy. `GET /api/ask?wi=&q=` — grounded Q&A.
- `POST /api/agent/prime` — **train/context-load in one call**: seed data (messy + edge cases +
  amendments + player finance) + onboard + precedents + build books + Moss index + mode.
  `POST /api/agent/reset` — wipe learned memory (precedents + policies) → newbie.
- Onboarding: `GET /api/agents`, `GET /api/agent/mode`, `GET /api/agent/onboard/stream`,
  `GET /api/agent/policies/pending`, `POST /api/agent/policy/approve`.
- Clauses/amendments: `POST /api/clause`, `GET /api/clauses`, `GET /api/deal/{id}/clause-scan`,
  `GET /api/amendments`, `POST /api/amend/apply?id=`.
- Books/score: `GET /api/books`, `/api/score`, `/api/finreport`, `/api/forecast`, `/api/report`,
  `/api/policies`, `/api/metrics`, `/api/queue`, `/api/feed`, `/api/environment`.
- History/audit: `GET /api/history` (fast, batched), `/api/explain/{wi}`, `/api/audit/{subject}`,
  `/api/audit-recent`, `/api/denials`.
- Reports/voice: `/txreport`, `/scenario-report` (legacy pages), `GET /api/voice?text=` (Cartesia
  MP3), `GET /api/report-video?wi=` (narrated MP4), `GET /api/livekit/token`.
- Dev: `POST /api/dev/seed-mess`, `/api/dev/seed-amendments`, `/api/history/fill`.

---

## 7. The score (proof it works)

`pitwall eval run` runs the decision gate over **21 planted issues / 12 types** as the
read-only agent role vs the answer key: **100% precision on auto-completed work · 0
must-not-auto-complete violations · 21/21 recall.** Held through every change this session.

---

## 8. How to run

`.env` holds live secrets (`PITWALL_DATABASE_URL`, `ANTHROPIC_API_KEY`, `CARTESIA_*`, `MOSS_*`,
`LIVEKIT_*`) — gitignored. Python via `uv`.

```
make cloud-reset   # reset Tiger Cloud: migrate + generate world + seed + Moss index
make fc            # the stadium + backend at :4055 (uvicorn --reload)
make eval          # score vs the answer key
```

**Demo path:** `make fc` → `POST /api/agent/prime` (trains the agent + loads all the deep data)
→ open `/` → **Onboard** (watch it learn + approve) → **Control room / Teamwork Terminal** (type
a case, see it decide or escalate → make the call → it learns) → **History** (open a report on a
billboard, ▶ Play, ask it a question). Curated prompts with expected outcomes: **`docs/DEMO_SCRIPT.md`**.

**Player names in the DB to use:** Felix Moreau (sold, solidarity case, *leaving* with unpaid
obligations), Niko Novak (sold, ambiguous sell-on, *leaving*), Kai Falk, Finn Falk (extension),
Andre Mendez, Bruno Petrov. Try *"Did we pay Felix Moreau this month?"* or *"Niko Novak is
leaving — do we still owe him anything?"*.

---

## 9. Current state

**Done & working:** the System of Work (gateway, roles, SoD, append-only audit); the
double-entry accounting engine (books tie; real money notes for decisions; squad-cost; the
amendment cascade with reverse+repost); onboarding (learn + human-approve policies);
human-in-the-loop with self-improving precedents→policy; the clause-trigger family + clause
guard + clause-analyst subagent + clause registry; deep per-player finance (payment status,
leaving, outstanding obligations) with the salary still sealed; Moss memory/recall; the full
stadium with in-stadium reports (view/play/ask/download), the onboarding flow, and the HITL bar;
Cartesia report narration (crowd/commentary audio removed); eval 100%/0/21.

**Still queued (from the "would you hire it" list):** large-scale synthetic validation harness;
policy backtest-before-promote; a formal accountant sign-off gate; messy-record entity resolution.

**Operational:** no `Co-Authored-By: Claude` trailer in commits; don't auto-open the browser;
after a `reset`, run `/api/agent/prime` (or `/api/dev/seed-mess`) to reseed the deep data.
