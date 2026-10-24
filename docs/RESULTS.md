# Pit Wall — Evaluation Results

_Generated 2026-10-24 09:34 UTC by `pitwall eval run` against `world/out/answer_key.json` (21 planted issues)._

The agent's decision gate (hard checks in code — `pitwall/agent/detectors.py`) is run over every planted issue, reading the real golden facts as the read-only `agent` DB role. The agent never sees the answer key; the verdict is derived from the data, then compared.

## Headline

| Metric | Result | Target |
|---|---|---|
| **Precision on auto-completed work** | **100%** (10/10) | 100% |
| **Must-not-auto-complete violations** | **0** | 0 |
| Planted-issue recall (right action) | 100% (21/21) | — |
| Automation rate | 48% (10/21) | — |
| Escalation quality | 100% (11/11) | — |

## Recall by issue type

| Type | Correct | n |
|---|---|---|
| `addon_invoiced_not_triggered` | 2 | 2 |
| `addon_triggered_not_booked` | 1 | 1 |
| `ambiguous_sell_on` | 1 | 1 |
| `contract_extension_amortization` | 1 | 1 |
| `duplicate_agent_fee` | 2 | 2 |
| `fake_bank_detail_change` | 3 | 3 |
| `incoming_short_solidarity` | 3 | 3 |
| `incoming_short_unexplained` | 2 | 2 |
| `legitimate_bank_detail_change` | 1 | 1 |
| `one_wire_many_items` | 2 | 2 |
| `stale_fx_rate` | 2 | 2 |
| `threshold_evasion_split` | 1 | 1 |

## Per-issue detail

| Issue | Type | Expected | Agent action | Auto | ✓ |
|---|---|---|---|:--:|:--:|
| `fraud-1` | `fake_bank_detail_change` | `HOLD_BUY_EVIDENCE_ESCALATE_CFO` | `HOLD_BUY_EVIDENCE_ESCALATE_CFO` | escalate | ✅ |
| `fraud-2` | `fake_bank_detail_change` | `HOLD_BUY_EVIDENCE_ESCALATE_CFO` | `HOLD_BUY_EVIDENCE_ESCALATE_CFO` | escalate | ✅ |
| `fraud-3` | `fake_bank_detail_change` | `HOLD_BUY_EVIDENCE_ESCALATE_CFO` | `HOLD_BUY_EVIDENCE_ESCALATE_CFO` | escalate | ✅ |
| `fraud-legit-1` | `legitimate_bank_detail_change` | `COMPLETE_AFTER_EVIDENCE` | `COMPLETE_AFTER_EVIDENCE` | auto | ✅ |
| `addon-trig-1` | `addon_triggered_not_booked` | `PROPOSE_ACCRUAL_LIABILITY` | `PROPOSE_ACCRUAL_LIABILITY` | escalate | ✅ |
| `addon-false-1` | `addon_invoiced_not_triggered` | `REJECT_WITH_CLAUSE_AND_MATCH_IDS` | `REJECT_WITH_CLAUSE_AND_MATCH_IDS` | auto | ✅ |
| `addon-false-2` | `addon_invoiced_not_triggered` | `REJECT_WITH_CLAUSE_AND_MATCH_IDS` | `REJECT_WITH_CLAUSE_AND_MATCH_IDS` | auto | ✅ |
| `solidarity-1` | `incoming_short_solidarity` | `COMPLETE_DO_NOT_CHASE` | `COMPLETE_DO_NOT_CHASE` | auto | ✅ |
| `solidarity-2` | `incoming_short_solidarity` | `COMPLETE_DO_NOT_CHASE` | `COMPLETE_DO_NOT_CHASE` | auto | ✅ |
| `solidarity-3` | `incoming_short_solidarity` | `COMPLETE_DO_NOT_CHASE` | `COMPLETE_DO_NOT_CHASE` | auto | ✅ |
| `short-unexplained-1` | `incoming_short_unexplained` | `CHASE_OR_ESCALATE` | `CHASE_OR_ESCALATE` | escalate | ✅ |
| `short-unexplained-2` | `incoming_short_unexplained` | `CHASE_OR_ESCALATE` | `CHASE_OR_ESCALATE` | escalate | ✅ |
| `combined-wire-1` | `one_wire_many_items` | `SPLIT_ONE_TO_MANY` | `SPLIT_ONE_TO_MANY` | auto | ✅ |
| `combined-wire-2` | `one_wire_many_items` | `SPLIT_ONE_TO_MANY` | `SPLIT_ONE_TO_MANY` | auto | ✅ |
| `duplicate-invoice-1` | `duplicate_agent_fee` | `REJECT_DUPLICATE` | `REJECT_DUPLICATE` | auto | ✅ |
| `duplicate-invoice-2` | `duplicate_agent_fee` | `REJECT_DUPLICATE` | `REJECT_DUPLICATE` | auto | ✅ |
| `threshold-evasion-1` | `threshold_evasion_split` | `ESCALATE_THRESHOLD_EVASION` | `ESCALATE_THRESHOLD_EVASION` | escalate | ✅ |
| `stale-fx-1` | `stale_fx_rate` | `PROPOSE_FX_GAIN_LOSS` | `PROPOSE_FX_GAIN_LOSS` | escalate | ✅ |
| `stale-fx-2` | `stale_fx_rate` | `PROPOSE_FX_GAIN_LOSS` | `PROPOSE_FX_GAIN_LOSS` | escalate | ✅ |
| `sell-on-ambiguous-1` | `ambiguous_sell_on` | `ESCALATE_AMBIGUOUS_DO_NOT_GUESS` | `ESCALATE_AMBIGUOUS_DO_NOT_GUESS` | escalate | ✅ |
| `extension-amort-1` | `contract_extension_amortization` | `PROPOSE_AMORTIZATION_ADJUSTMENT` | `PROPOSE_AMORTIZATION_ADJUSTMENT` | escalate | ✅ |

