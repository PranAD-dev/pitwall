# Pit Wall

> **Pit Wall fills the transfer payables & receivables and squad-cost compliance
> seats at a football club: it pays and collects transfer fees, checks every
> add-on claim against match data, and keeps squad spending inside the league's
> limits.**

An autonomous finance system that owns the **transfer payables and receivables**
function of a fictional football club, **Harbourside FC**. It pays and collects
transfer installments, checks add-on/bonus claims against match data, cascades
sporting results through every affected contract, guards against bank-detail
fraud, and keeps the club inside its squad-cost limit — completing only the work
it can **verify to the cent**, and escalating everything else to the right
(model-played) human with a reason.

When it is unsure, it **buys evidence** (bank-account checks, official match data,
FX rates) via **Coinbase x402** micropayments and books that spend to the ledger
like any other expense. Every action — including denied attempts — is written to
an append-only audit log in **Tiger Data** (TimescaleDB) in the same transaction
as the change, so any decision can be replayed *"as of"* the moment it was made.

Built for **Cal Hacks 13.0** (Oct 23–25, 2026). Targets: Hyphenate (primary),
Coinbase Payment Agents, MLH Best Use of Tiger Data, and (stretch) Cartesia.

---

## What's real vs simulated

| Layer | Status |
|---|---|
| Systems of record (bank, ledger, contracts, match data, inbox) | **Simulated**, each its own schema, deterministic generator + answer key |
| System of Work (work items, policies, precedents, audit log) | **Real** — this is the product |
| Gateway (only writer to records, checks role + transition + SoD) | **Real** |
| Hard-check confidence gate (reconcile to the cent, policy, evidence…) | **Real** |
| DB-enforced limits (agent role can't touch journal or salaries) | **Real** — demo a live `permission denied` |
| LLM agent | Real Claude when `ANTHROPIC_API_KEY` is set; otherwise a **deterministic mock** so the loop/eval run offline |
| x402 evidence purchases | **Simulated sellers**; mock settlement emits clearly-labeled `SIMULATED` tx hashes until a CDP wallet is provided (then real testnet USDC on Base Sepolia) |
| Voice | Off until LiveKit + Cartesia keys are set; never on the core path |

> Rules are **modeled on real football-finance regulations, simplified** — not a
> reproduction of any real league's handbook. All clubs, agents and sponsors are
> fictional.

## Quickstart

```bash
make venv      # uv virtualenv + deps (Python pinned to 3.12)
make reset     # wipe + start TimescaleDB + migrate + generate the world
make eval      # run Pit Wall over the timeline, score vs the answer key
make demo      # run the final-whistle cascade scenario
```

No API keys required — everything above runs in fully-simulated mode. Drop keys
into `.env` to upgrade the LLM, x402 settlement, or voice. See
[`DECISIONS.md`](./DECISIONS.md) for every default chosen and why.

## The demo — the scenario control room

```bash
make fc                 # FastAPI backend + control-room UI at http://localhost:4055
```

Open **http://localhost:4055**, type a finance situation (or hit a preset), and watch
the agent work it live — the exact loop from the Hyphenate deck (slide 12):

1. **think → run_sql** — it recalls 12 months of precedents and locates the real
   golden rows (Claude `opus-4-8` perceives + narrates; it has *read-only* SQL only).
2. **propose → gate** — it proposes a classification; **code decides** — the
   hard-check gate (`pitwall/agent/detectors.py`) makes the call, so precision holds.
3. **post** — the Gateway posts the transition (the one writer) → a verdict card.
4. **forecast** — the decision ripples into the 5th system (deck slide 7):
   *"protected €2.75M of next-quarter cash from a fraudulent payee."*
5. **audit** — every transition as an append-only diff; *"why? is one query."*
6. **report** — a grounded, spoken report (▶ Speak) of what it did and why.

Side panels show the **forecast** (cash pipeline + squad-cost gauge) and the agent's
**memory** — the policies it **learned** at onboarding and **self-improved** from
corrections, with the one the current decision used highlighted.

Prefer the terminal?
```bash
uv run pitwall agent scenario "a lookalike-domain email asks us to pay the next installment to a new IBAN"
uv run pitwall eval run         # 21/21 planted issues · 100% precision · 0 violations
uv run pitwall agent onboard    # self-learning: mine history → draft policies
uv run pitwall agent improve    # self-improving: corrections → a generalized policy
```

## Repo layout

```
db/        SQL schema, roles, caggs, migrations (the Tiger Data story)
world/     deterministic world generator + answer_key.json
pitwall/   Python core: config, db, System of Work, gateway, agent, eval, cli
sellers/   x402-protected evidence sellers (Node/TS, M3)
skill/     reusable x402-verify package (Coinbase "ease of reuse", M3)
web/       black terminal dashboard (Vite + React, M5)
voice/     LiveKit + Cartesia read-only explainer (M7)
eval/      scoring harness output lives in docs/
docs/      RESULTS.md, TIGER_PERF.md, COINBASE_FEEDBACK.md
```

## Status

- **System of Work** — sync → work-item state machine → gateway → append-only audit: **real** (deck builds 1–4).
- **Self-learning + self-improving** — `agent onboard` / `agent improve`; policies are the agent's memory in the DB (learned + generalized from precedents).
- **The scenario control room** — free-text → live `think → run_sql → propose → gate → post → audit → forecast → report` (Claude `opus-4-8` perceives; **code decides**).
- **Forecast** — the 5th system; every post ripples into projected cash + squad-cost with per-decision impact attribution.
- **Eval** — `make eval` → **21/21** planted issues, **100%** precision on auto-completes, **0** must-not-auto-complete violations (`docs/RESULTS.md`).
- **Stretch:** LiveKit video report (browser Web-Speech covers the spoken report today), x402 testnet settlement (CDP creds wired, sellers service pending).
