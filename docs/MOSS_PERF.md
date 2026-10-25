# Pit Wall — Moss retrieval performance & accuracy

_Generated 2026-10-24 22:03 UTC by `pitwall eval retrieval`. Retrieval runs in-process over Moss; Tiger (TimescaleDB) stays the source of truth — every id below is a real work item, refetched from Tiger before the agent acts or speaks._

## Latency (Moss `time_taken_ms`, from `work.retrieval_metric`)

| Scope | queries | p50 | p95 | max |
|---|--:|--:|--:|--:|
| all | 122 | 0 ms | 1 ms | 19 ms |
| eval | 101 | 0 ms | 1 ms | |
| worker | 21 | 0 ms | 2 ms | |

## Retrieval accuracy — 30 natural-language questions → the right decision

Indexed 23 canonical decisions. Each question maps to the acceptable work-item id(s); a hit counts when a correct id is returned.

| Metric | No date filter | With date filter |
|---|--:|--:|
| **Top-1 accuracy** | 87% | 90% |
| **Top-3 accuracy** | 93% | 93% |
| Top-1 on the 4 month-named questions | 75% | 100% |

The date filter is the tiebreaker on near-duplicate decisions: naming the month narrows a group (e.g. three solidarity shortfalls) to the one that was decided then.

## Per-question detail

| ✓ | timed | question | returned (top-3) |
|:--:|:--:|---|---|
| ✅ |  | a lookalike-domain email asked us to change the payee's IBAN — what di | WI-fraud-1, WI-fraud-2, WI-fraud-3 |
| ✅ |  | we held a transfer payment on suspected bank-detail fraud | WI-fraud-1, WI-fraud-3, WI-fraud-2 |
| ✅ |  | the payment to Northgate Rangers that we put on hold | WI-5602, WI-fraud-1, WI-fraud-2 |
| ❌ |  | a bank-account change that turned out legitimate after a bank check | WI-fraud-1, WI-fraud-3, WI-fraud-2 |
| ✅ |  | an add-on bonus invoice we rejected because appearances were below the | WI-addon-false-1, WI-addon-false-2, WI-5611 |
| ✅ |  | the Montara add-on claim we turned down | WI-5611, WI-addon-trig-1, WI-addon-false-1 |
| ✅ |  | an add-on that actually triggered but had not been booked — we propose | WI-addon-trig-1, WI-addon-false-1, WI-addon-false-2 |
| ✅ |  | an incoming transfer came in short because the solidarity contribution | WI-solidarity-3, WI-solidarity-1, WI-solidarity-2 |
| ✅ |  | a receipt that was short for no clear reason — we chased or escalated  | WI-short-unexplained-2, WI-short-unexplained-1, WI-solidarity-3 |
| ✅ |  | one wire that paid several installments at once — we split it one-to-m | WI-combined-wire-1, WI-combined-wire-2, WI-stale-fx-1 |
| ✅ |  | a duplicate agent-fee invoice we rejected | WI-duplicate-invoice-2, WI-duplicate-invoice-1, WI-addon-false-1 |
| ✅ |  | a consultancy fee split into pieces to stay under the approval limit | WI-combined-wire-2, WI-combined-wire-1, WI-threshold-evasion-1 |
| ✅ |  | a stale FX rate on a cross-currency installment — we proposed an FX ga | WI-stale-fx-2, WI-stale-fx-1, WI-combined-wire-2 |
| ✅ |  | an ambiguous sell-on clause we refused to guess on and escalated | WI-sell-on-ambiguous-1, WI-short-unexplained-1, WI-short-unexplained-2 |
| ✅ |  | a contract extension that changed the amortization — we proposed an ad | WI-extension-amort-1, WI-addon-trig-1, WI-sell-on-ambiguous-1 |
| ❌ |  | why did we complete a bank-detail change without holding it? | WI-fraud-2, WI-fraud-3, WI-fraud-1 |
| ✅ |  | an invoice claiming an appearance milestone the player never reached i | WI-5611, WI-addon-false-1, WI-addon-false-2 |
| ✅ |  | money arrived about five percent short on an international incoming tr | WI-solidarity-3, WI-solidarity-2, WI-solidarity-1 |
| ✅ |  | a second invoice with the same amount and transfer, number reformatted | WI-duplicate-invoice-2, WI-duplicate-invoice-1, WI-threshold-evasion-1 |
| ✅ |  | a combined payment across two installments that reconciled to the cent | WI-combined-wire-2, WI-combined-wire-1, WI-stale-fx-2 |
| ✅ |  | the euro/sterling rate was out of date when we booked the receipt | WI-stale-fx-2, WI-stale-fx-1, WI-short-unexplained-1 |
| ✅ |  | the sell-on basis was unclear — gross or profit — so we asked a human | WI-sell-on-ambiguous-1, WI-stale-fx-2, WI-stale-fx-1 |
| ✅ |  | the agent commission we wrote off and re-amortised after a contract ex | WI-extension-amort-1, WI-fraud-2, WI-fraud-1 |
| ✅ |  | a shortfall we could not explain and routed for chasing | WI-short-unexplained-2, WI-short-unexplained-1, WI-solidarity-3 |
| ✅ |  | a held payment escalated to the CFO for a second approval | WI-fraud-2, WI-fraud-3, WI-fraud-1 |
| ✅ |  | payments structured just under the approval limit (threshold evasion) | WI-threshold-evasion-1, WI-5611, WI-short-unexplained-1 |
| ✅ | 🕑 | the incoming transfer shortfall we handled in September 2025 | WI-solidarity-3, WI-solidarity-2, WI-short-unexplained-2 |
| ✅ | 🕑 | a rejected counterparty invoice from March 2026 | WI-addon-false-1, WI-duplicate-invoice-2, WI-addon-false-2 |
| ✅ | 🕑 | a rejected counterparty invoice from April 2026 | WI-addon-false-1, WI-duplicate-invoice-2, WI-addon-false-2 |
| ✅ | 🕑 | a payment we held and escalated in May 2026 | WI-5602, WI-fraud-1, WI-threshold-evasion-1 |

