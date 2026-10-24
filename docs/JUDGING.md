# Judging map — Hyphenate track

> *"Judges see hundreds of projects, so put the evidence up front."* — the track brief.
> This maps **every criterion** to the exact evidence: a file, a command, or the gap
> that closes it. Status: ✅ done & verified · 🟡 partial · ⏳ planned milestone.

**Seats (one line):** *Pit Wall fills the transfer payables & receivables and
squad-cost compliance seats at a football club: it pays and collects transfer fees,
checks every add-on claim against match data, and keeps squad spending inside the
league's limits.*

**Company:** Harbourside FC — a fictional mid-table top-division club. Corner of the
finance team: the accountant who applies/collects transfer installments + the
controller/CFO who sign off. Rules modeled on real football-finance regulations,
simplified (said so in the README).

---

## The four judging questions

### ① Is it real enough?  *(realistic data · messy problem · proof it works)*
| Evidence | Where | Status |
|---|---|---|
| 24-month deterministic world: ~48 counterparties, 18 transfers, 171 invoices, 2 seasons of match events, multi-currency bank lines, FX series | `pitwall/world/generate.py` · `make cloud-reset` | ✅ |
| Messy corner = **21 planted issues across 12 types** (fraud, add-on disputes, solidarity vs unexplained shortfalls, one-wire-many-invoices, duplicate invoices, threshold-evasion split, stale FX, ambiguous sell-on, extension amortization) | `world/out/answer_key.json` · `pitwall world answer-key` | ✅ |
| **Proof = a score**: precision on auto-completed work, automation rate, escalation quality, **must-not-auto-complete violations = 0**, planted-issue recall | `pitwall eval run` → `docs/RESULTS.md` | ⏳ **M6** |
| What's real vs simulated, and how we know | `README.md` (table) | ✅ |

### ② Would you hire it?  *(which seats · limited access · clean record · knows when to ask)*
| Evidence | Where | Status |
|---|---|---|
| Which seats, in one line | README / above | ✅ |
| **Limited access, in the database** — agent role `permission denied` on journal + salaries; only the gateway posts | `db/schema/20_grants.sql` · proven in `sow walk` | ✅✅ |
| **Separation of duties** — whoever proposes cannot approve | `pitwall/sow/roles.py` `can()` · live denial in `sow walk` | ✅✅ |
| **Clean record of every call** — append-only audit, every transition a diff, **denied attempts logged too** | `pitwall/sow/gateway.py` · `pitwall sow audit <id>` | ✅✅ |
| **Knows when to ask** — hard-check gate escalates low-confidence items to the right human with the failing check named | `pitwall/agent/` hard-check gate | ⏳ **M2** |
| **Handles a "no"** — model-played controller/CFO can reject; fraud-hold release needs a 2nd approver incl. CFO | model-played humans + `release` transition (CFO-gated) | 🟡 transition done (M1); humans = **M2** |

### ③ Did we see something new?
| Evidence | Status |
|---|---|
| **Domain**: football-club transfer finance — not another SaaS/Stripe demo | ✅ |
| **Signature mechanic**: *sporting results move money* — one final-matchday result cascades across transfers, sponsor bonuses, player bonuses, squad-cost ratio, cash | 🟡 data + cascade design; live cascade panel = **M5** |
| **Approach**: agent *buys evidence* when unsure (x402 micro-payments) and books the spend to the ledger; narrated "build-it-live" Explainer | x402 = **M3** · Explainer ✅ (M7) |

### ④ The moment  *(catches what others missed · recovers · defends when questioned)*
| Moment | Where | Status |
|---|---|---|
| **Defends a decision when questioned** — "why did you hold this payment?" → grounded narration + **rewind** to only what it knew then (`world_as_of`) | `pitwall explain plan WI-5602 --as-of …` · `web/index.html` | ✅✅ (M7) |
| **Catches what others missed** — fraud: lookalike domain + bank-detail change → buy bank check → mismatch → HOLD → route to CFO | data + explainer ✅; agent catches it autonomously = **M2** |
| **Recovers from something going wrong** — a reversal is a new logged transition, never a delete | `POSTED→reverse` in `transitions.py` | 🟡 path exists; exercised in **M2** |

---

## The five "what makes it hard"
1. **Sources disagree** — bank vs ledger vs contract; data carries the disagreements (short pays, FX gaps). Agent must say which to trust and why → **M2**.
2. **Time** — hypertables + `world_as_of()` rewind ✅ (M7); continuous aggregates + compression on closed periods ("parc fermé") = **M4**.
3. **Working with others** — question/approval tables ✅ (M1); model-played humans who sometimes say no = **M2**.
4. **Limits** — SoD in `can()` + 4 DB roles + gateway one-door, **in code AND the database** ✅✅ (M1).
5. **Explainable & accountable** — append-only audit ("why?" is one query) ✅ (M1) + the Explainer ✅ (M7). Traces to data, rule, person, months later.

---

## Strong-vs-weak self-check (workshop slide 19)
| Strong | Us |
|---|---|
| A real company with a messy corner, **and an answer key** | ✅ 21 planted issues + `answer_key.json` |
| A few roles done deep, **named in one line** | ✅ seats line; transfer seat deep |
| **Asks at the right moment, and handles a no** | ⏳ M2 |
| **Limits enforced in code; a record of every call** | ✅✅ DB roles + SoD + append-only audit |
| **A moment on stage, and a score to back it** | 🟡 moment ✅ (Explainer); score ⏳ M6 |

We are explicitly **not** the weak column: not a chatbot over a spreadsheet (it's a
System of Work with a gateway), not happy-path only (planted errors + answer key),
not an admin key + "the prompt says not to" (limits in DB roles), not memory that
ends with the context window (policies/precedents/audit live in Postgres).

---

## What to submit — checklist
- [ ] **Demo video that opens with the moment** (moment #1: "It spent four cents to save millions") → **M8**
- [x] **Live demo running for real** — `sow walk`, `explain plan`, `web/index.html` run live; judges can inject their own scenario via the scenario injector (**M5**)
- [x] **One line on the seats** — README + this doc
- [ ] **Proof it works** — real vs simulated (README ✅) + the eval **score** (**M6**)

---

## Remaining milestones, mapped to the criteria they close
| Milestone | Closes |
|---|---|
| **M2** agent loop + hard-check gate + model-played humans + self-learning + self-improving | ② knows-when-to-ask/handles-no · ④ catches-fraud · hard-parts #1 #3 · "learns & improves" |
| **M3** x402 evidence + reusable skill | ③ new approach · the 4¢ in the moment · Coinbase track |
| **M4** Tiger caggs + compression + perf | hard-part #2 (time) · MLH Tiger Data track |
| **M5** black-terminal UI + scenario injector + final-whistle panel | live demo · "their own scenario" · the cascade (new) |
| **M6** eval vs answer key → RESULTS.md | ① proof-it-works · "a score to back it" |
| **M8** README + video + Devpost | all submission artifacts |
