# Pit Wall — demo script (prompts + known outcomes)

**Before the demo — train/prime the agent (one call):**

```
POST /api/agent/prime
```

Loads the data (messy traps + clause edge cases + amendments), onboards the agent (learns +
approves the accounting policies), seeds its precedents (memory), posts the books, and indexes
everything into Moss. After this the agent orients on **policy + precedent + similar past
decisions** on every question — so it reads "looks-wrong-but-fine" correctly, and handles novel
judge questions by routing to the right check or escalating safely.

Type the prompts into the **Teamwork Terminal**. Watch the trail: `think → recall memory →
run_sql (real rows) → propose → verdict → forecast`. Each `run_sql` prints the actual rows it
pulled, so every number is checkable.

---

## A. "Looks wrong on the surface — fine once the agent applies policy" (the context win)

| # | Type this | What it does | Desired outcome | Why (the context it uses) |
|---|-----------|--------------|-----------------|---------------------------|
| 1 | *"Montara paid about 5% short on the Varga sale — do we chase it?"* | finds the installment + receipt | **Auto-completes** · posts a real 3-line note (Dr Cash + Dr Solidarity receivable / Cr Transfer receivable) · **do not chase** | international sale, ~5%, explanatory memo → policy says it's the **solidarity contribution** withheld at source. Short on the surface, correct underneath. |
| 2 | *"The next Nilsson installment is going to a new IBAN, but the email is from Northbridge's verified domain — pay it?"* | runs the bank check | **Completes after evidence** — verified domain + bank-check owner matches | looks like a payee change (risky) but the $0.04 check confirms the owner → fine. |

## B. "Looks fine — actually a trap" (caught)

| # | Type this | Desired outcome | Why |
|---|-----------|-----------------|-----|
| 3 | *"Dunmore's payment for Okafor came in about 8% short."* | **Escalate / chase** — won't auto-complete | domestic, 8%, no memo, no solidarity basis → unexplained. *Contrast with #1 — same shape, different answer.* |
| 4 | *"An email from a lookalike domain wants the next Northgate installment paid to a brand-new IBAN we've never used."* | **HELD** · buys a bank check ($0.04) · mismatch · routed to the CFO | lookalike domain + unverified IBAN + 3 prior payments to the verified account = fraud. |
| 5 | *"We got a second invoice from Rialto for the same agent fee, just a reformatted number."* | **Rejected — duplicate** | same amount + transfer, different number → duplicate, refuse to pay twice. |

## C. Judgment calls → it stops and asks YOU (human-in-the-loop, and it learns)

| # | Type this | Desired outcome | Why |
|---|-----------|-----------------|-----|
| 6 | *"Is the sell-on on the Mendez sale based on the gross fee or our profit over his book value?"* | **HITL bar pops** — it won't guess | the clause doesn't state the basis; the two differ materially. Decide → it records a precedent. |
| 7 | *"We agreed Nilsson's installment months ago and the exchange rate moved by the time we paid."* | **HITL** — propose booking the FX gain/loss, needs sign-off | FX difference between signing and payment rate. |
| 8 | *"Marcus Vane is suspended pending a criminal investigation — can we stop his wages?"* | **HITL** — "**keep paying**, no withholding clause; stopping = unlawful deduction (cf. Mendy £11.5m)" | suspended ≠ terminated + NO pay-withholding clause → he's still entitled. The trap. |
| 9 | *"Theo Brandt is suspended too — can we withhold his pay?"* | **HITL** — "may withhold, the contract has an explicit clause — but confirm the trigger, legal sign-off" | contrast with #8: Brandt's contract *has* a withholding clause. |
| 10 | *"Where are we on Niko Sauer's loan-to-buy obligation?"* | **Alert to CFO** — 12/15 (80%) qualifying; €10m auto-unlocks if it hits; 6 late-sub appearances **don't count** | minute-accurate — subbing on in the 89th minute can't game the trigger. |
| 11 | *"Is Owen Fisk a sporting-just-cause risk?"* | **Alert** — 3/40 (7.5%) < 10%, could walk for **zero fee**, 15-day window is open | Article 15 FIFA RSTP participation + the post-season window. |

## D. Contract amendments → the cascade (reverse + repost, never edit)

Run via `POST /api/amend/apply?id=…` (or the amendments list `GET /api/amendments`):

| # | Amendment | Desired outcome |
|---|-----------|-----------------|
| 12 | `am-ext-nilsson` (extend to 7y) | re-amortises, **capped at 5 years**; the agent-fee leg **escalates** (contract-ambiguous); **books tie** |
| 13 | `am-reneg-bakker` (fee 6.0M → 4.5M) | reverse+repost cost & amortisation; **impairment check escalates** (below book value); books tie |
| 14 | `am-term-cole` (early sale, €2m) | posts a disposal (NBV 2.78M, €0.78m loss); books tie |

## E. The clause guard — never miss a clause

| # | Call | Desired outcome |
|---|------|-----------------|
| 15 | `GET /api/deal/tr-loan-sauer/clause-scan` | enumerates every clause on the deal, auto-clears the clear ones, and hands the human each flagged clause with **a plain-English read AND the verbatim terms** |

## F. History & reports

| # | Do this | Desired outcome |
|---|---------|-----------------|
| 16 | **History** → click a transaction | opens its full report: the agent's thinking, what it touched, the human input, + **Make it a video** |
| 17 | In the report, **"Ask the agent about this event"** | grounded Q&A — answers only from that transaction's record (no invention) |
| 18 | *"Show me the financial report"* in the terminal | offloads to the reports billboard (narrated) |

## G. Judge curveballs (novel questions) — why it still holds up

Because it's primed (recall + the hard-check gate + escalate-when-unsure), rephrasings route to the
right check, and genuinely novel ones escalate instead of guessing:

- Reword #1: *"Varga's fee came up a bit light from the Spanish club — is that a problem?"* → still solidarity → complete.
- Reword #8: *"One of our players got arrested — do we keep paying him?"* → still the suspension/withholding gate.
- Something with no basis: *"A €50m payment for a player named Zxqwor came in short."* → queries, gets **zero rows**, and **escalates** ("I won't guess") instead of inventing a sale.

## The contrast slide (if you want to show the value of training)

- `POST /api/agent/reset` → the agent is a **newbie** (0 policies). Re-run #1 → it **escalates** (no policy to lean on).
- `POST /api/agent/prime` → **onboarded** with context → re-run #1 → it **auto-completes correctly**.
  Same data, same question — context is the difference between "escalate everything" and "handle the routine, flag the rest."
