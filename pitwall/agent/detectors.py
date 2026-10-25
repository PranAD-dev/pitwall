"""Per-scenario decision logic — the agent's judgment, in CODE. Each detector reads
golden facts, runs the hard checks, and returns the action it would take. It never
reads the answer key; the verdict is derived from the data.

A detector returns a Decision:
  action          one of the action codes below (the agent's call)
  auto_completed  True = the hard-check gate cleared it to complete; False = escalate
  reason          plain-English why
  evidence        fact/evidence ids behind the call
  escalated_to    role the item was routed to (None if auto-completed)
  failing_check   the hard check that forced the escalation (None if auto)
  x402            bank-check evidence, if bought
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import checks, read

# action codes (match world/generate.py A)
HOLD = "HOLD_BUY_EVIDENCE_ESCALATE_CFO"
COMPLETE_AFTER_EVIDENCE = "COMPLETE_AFTER_EVIDENCE"
REJECT = "REJECT_WITH_CLAUSE_AND_MATCH_IDS"
PROPOSE_ACCRUAL = "PROPOSE_ACCRUAL_LIABILITY"
COMPLETE_SOLIDARITY = "COMPLETE_DO_NOT_CHASE"
CHASE = "CHASE_OR_ESCALATE"
SPLIT = "SPLIT_ONE_TO_MANY"
REJECT_DUP = "REJECT_DUPLICATE"
ESCALATE_THRESHOLD = "ESCALATE_THRESHOLD_EVASION"
PROPOSE_FX = "PROPOSE_FX_GAIN_LOSS"
ESCALATE_SELLON = "ESCALATE_AMBIGUOUS_DO_NOT_GUESS"
PROPOSE_AMORT = "PROPOSE_AMORTIZATION_ADJUSTMENT"
# wage suspension — the "ready, willing & able" trap (Mendy v Man City)
KEEP_PAYING_SUSPENSION = "KEEP_PAYING_READY_WILLING_ABLE"
PROPOSE_SUSPEND_PAY = "PROPOSE_SUSPEND_PAY_PER_CLAUSE"
STOP_WAGES_TERMINATED = "STOP_WAGES_LAWFUL_TERMINATION"
# conditional loan-to-buy mandatory purchase trigger (CAS / FIFA)
PROPOSE_MANDATORY_PURCHASE = "PROPOSE_MANDATORY_PURCHASE_OBLIGATION"
WARN_OBLIGATION_NEAR = "WARN_MANDATORY_PURCHASE_APPROACHING"
MONITOR_OBLIGATION = "MONITOR_OBLIGATION"
OBLIGATION_LAPSED = "OBLIGATION_LAPSED_NO_PURCHASE"
# sporting just cause — Article 15 FIFA RSTP
WARN_SPORTING_JUST_CAUSE = "WARN_SPORTING_JUST_CAUSE_RISK"

# which actions the hard-check gate may auto-complete, and who the rest route to
AUTO = {COMPLETE_AFTER_EVIDENCE, REJECT, COMPLETE_SOLIDARITY, SPLIT, REJECT_DUP}
# the agent works WITH a team of accountants — every escalation goes to the team (you),
# never "up" to a CFO / controller / sporting director
_TEAM = "human_accountant"
ESCALATE_TO = {
    HOLD: _TEAM, PROPOSE_ACCRUAL: _TEAM, CHASE: _TEAM,
    ESCALATE_THRESHOLD: _TEAM, PROPOSE_FX: _TEAM,
    ESCALATE_SELLON: _TEAM, PROPOSE_AMORT: _TEAM,
    KEEP_PAYING_SUSPENSION: _TEAM, PROPOSE_SUSPEND_PAY: _TEAM, STOP_WAGES_TERMINATED: _TEAM,
    PROPOSE_MANDATORY_PURCHASE: _TEAM, WARN_OBLIGATION_NEAR: _TEAM, WARN_SPORTING_JUST_CAUSE: _TEAM,
}


@dataclass
class Decision:
    action: str
    reason: str
    auto_completed: bool = False
    evidence: list = field(default_factory=list)
    escalated_to: str | None = None
    failing_check: str | None = None
    x402: dict | None = None

    def finalize(self) -> "Decision":
        self.auto_completed = self.action in AUTO
        if not self.auto_completed:
            self.escalated_to = ESCALATE_TO.get(self.action)
        return self


# --------------------------------------------------------------------------- #
def detect_bank_change(installment_id: str, inbox_id: str) -> Decision:
    inst = read.installment(installment_id)
    tr = read.transfer(inst["transfer_id"])
    cp = read.counterparty(tr["counterparty_id"])
    msg = read.inbox(inbox_id)
    prior = read.paid_count(inst["transfer_id"])
    lookalike = checks.is_lookalike(msg["from_domain"], cp["email_domain"])
    # value-of-information: high amount + a changed payee is always worth verifying
    chk = checks.buy_bank_check(msg["claims_new_iban"])
    ev = [{"key": "email", "from_domain": msg["from_domain"], "legit_domain": cp["email_domain"],
           "lookalike": lookalike, "claimed_iban": msg["claims_new_iban"]},
          {"key": "history", "prior_payments_to_verified": prior, "verified_iban": cp["verified_iban"]},
          {"key": "bank_check", **chk}]
    if chk["status"] == "mismatch":
        return Decision(HOLD, evidence=ev, x402=chk,
                        reason=(f"payee-change email from {msg['from_domain']} "
                                f"({'lookalike of ' + cp['email_domain'] if lookalike else 'unverified'}); "
                                f"counterparty paid the verified account {prior}× before; bought a bank "
                                f"check (${chk['cost_usdc']}) → mismatch. Hold, and bring it to the accounting team to release."),
                        failing_check="counterparty_bank_details_verified").finalize()
    return Decision(COMPLETE_AFTER_EVIDENCE, evidence=ev, x402=chk,
                    reason=(f"bank-detail change from the verified domain {cp['email_domain']}; bought a "
                            f"bank check (${chk['cost_usdc']}) → owner matches. Verified, then complete.")
                    ).finalize()


def detect_short_receipt(installment_id: str, txn_id: str) -> Decision:
    inst = read.installment(installment_id)
    tr = read.transfer(inst["transfer_id"])
    txn = read.bank_txn(txn_id)
    expected = float(inst["amount"])
    received = abs(float(txn["amount"]))
    short = checks.shortfall_pct(expected, received)
    ev = [{"key": "amounts", "expected": expected, "received": received, "shortfall_pct": short,
           "solidarity_applicable": tr["solidarity_applicable"]}]
    if short <= 0.05:
        return Decision(COMPLETE_SOLIDARITY, evidence=ev,
                        reason="received in full; complete.").finalize()
    if abs(short - 5.0) <= 0.3 and tr["solidarity_applicable"]:
        return Decision(COMPLETE_SOLIDARITY, evidence=ev,
                        reason=(f"international sale short by {short}% ≈ the 5% solidarity contribution "
                                "withheld; book to solidarity receivable, do not chase."),
                        ).finalize()
    return Decision(CHASE, evidence=ev,
                    reason=(f"domestic receipt short by {short}% with no solidarity basis and no stated "
                            "reason; chase / escalate — do not auto-complete."),
                    failing_check="unexplained_shortfall").finalize()


def detect_addon_invoice(invoice_id: str) -> Decision:
    inv = read.invoice(invoice_id)
    cl = read.clause(inv["claims_clause_id"])
    tr = read.transfer(cl["contract_id"])
    comps = cl["competitions_counted"] or []
    threshold = int(cl["params"]["threshold"])
    observed = sum(read.appearances(tr["player_id"], c) for c in comps)
    ev = [{"key": "clause", "clause_id": cl["id"], "threshold": threshold, "competitions": comps},
          {"key": "match", "observed_counted": observed}]
    if observed < threshold:
        return Decision(REJECT, evidence=ev,
                        reason=(f"invoice claims a {threshold}-appearance add-on in {comps}; official "
                                f"match data shows {observed} — below the threshold. Reject with clause "
                                f"{cl['id']} + match ids.")).finalize()
    return Decision(PROPOSE_ACCRUAL, evidence=ev,
                    reason=f"threshold met ({observed}≥{threshold}); propose the liability.",
                    failing_check="needs_accrual_approval").finalize()


def detect_addon_triggered(transfer_id: str, clause_id: str) -> Decision:
    cl = read.clause(clause_id)
    tr = read.transfer(transfer_id)
    comps = cl["competitions_counted"] or []
    threshold = int(cl["params"]["threshold"])
    observed = sum(read.appearances(tr["player_id"], c) for c in comps)
    ev = [{"key": "clause", "clause_id": clause_id, "threshold": threshold, "competitions": comps},
          {"key": "match", "observed_counted": observed}]
    if observed >= threshold:
        return Decision(PROPOSE_ACCRUAL, evidence=ev,
                        reason=(f"player reached {observed} {comps} appearances (≥{threshold}); the add-on "
                                "has triggered but no liability is booked. Propose the accrual."),
                        failing_check="needs_accrual_approval").finalize()
    return Decision(REJECT, evidence=ev, reason="threshold not met; nothing owed.").finalize()


def detect_combined_wire(txn_id: str, installment_ids: list, clause_id: str | None) -> Decision:
    txn = read.bank_txn(txn_id)
    received = abs(float(txn["amount"]))
    parts = []
    total = 0.0
    for iid in installment_ids:
        inst = read.installment(iid)
        if inst:
            parts.append({"installment": iid, "amount": float(inst["amount"])})
            total += float(inst["amount"])
    addon = 0.0
    if clause_id:
        cl = read.clause(clause_id)
        if cl and cl["params"].get("triggered"):
            addon = float(cl["params"].get("fee", 0))
            parts.append({"addon_clause": clause_id, "amount": addon})
            total += addon
    ev = [{"key": "reconcile", "received": received, "components": parts, "component_total": round(total, 2)}]
    if checks.reconciles_to_cent(total, received):
        return Decision(SPLIT, evidence=ev,
                        reason=(f"one wire of {received:,.0f} reconciles to the cent as "
                                f"{len(parts)} items; split one-to-many.")).finalize()
    return Decision(CHASE, evidence=ev,
                    reason=f"wire {received:,.0f} doesn't reconcile to the components ({total:,.0f}); escalate.",
                    failing_check="does_not_reconcile").finalize()


def detect_duplicate(original_invoice_id: str, duplicate_invoice_id: str) -> Decision:
    a = read.invoice(original_invoice_id)
    b = read.invoice(duplicate_invoice_id)
    same = (a and b and float(a["amount"]) == float(b["amount"])
            and a["transfer_id"] == b["transfer_id"] and a["number"] != b["number"])
    ev = [{"key": "duplicate", "original": original_invoice_id, "duplicate": duplicate_invoice_id,
           "amount": float(b["amount"]), "number_a": a["number"], "number_b": b["number"]}]
    if same:
        return Decision(REJECT_DUP, evidence=ev,
                        reason=(f"same agent, same amount ({float(b['amount']):,.0f}), same transfer, "
                                f"reformatted number ({a['number']} vs {b['number']}); reject the duplicate.")
                        ).finalize()
    return Decision(CHASE, evidence=ev, reason="not a clear duplicate; escalate.",
                    failing_check="not_a_clear_duplicate").finalize()


def detect_threshold(invoice_ids: list, threshold: float) -> Decision:
    invs = [read.invoice(i) for i in invoice_ids]
    invs = [i for i in invs if i]
    amounts = [float(i["amount"]) for i in invs]
    combined = sum(amounts)
    each_under = all(a <= threshold for a in amounts)
    ev = [{"key": "split", "amounts": amounts, "combined": round(combined, 2), "threshold": threshold}]
    if each_under and combined > threshold:
        return Decision(ESCALATE_THRESHOLD, evidence=ev,
                        reason=(f"{len(invs)} invoices each under the {threshold:,.0f} approval limit but "
                                f"{combined:,.0f} combined to the same transfer — looks like threshold "
                                "evasion. Escalate, do not pay piecemeal."),
                        failing_check="threshold_evasion").finalize()
    return Decision(CHASE, evidence=ev, reason="no threshold evasion detected.").finalize()


def detect_stale_fx(installment_id: str, txn_id: str) -> Decision:
    inst = read.installment(installment_id)
    tr = read.transfer(inst["transfer_id"])
    txn = read.bank_txn(txn_id)
    amt = float(inst["amount"])
    sign_rate = read.fx_rate("EURGBP", tr["signed_at"])
    pay_rate = read.fx_rate("EURGBP", txn["txn_time"])
    if sign_rate is None or pay_rate is None:
        return Decision(CHASE, reason="missing FX rates; escalate.", failing_check="no_fx").finalize()
    gbp_signed = round(amt * sign_rate, 2)
    gbp_paid = round(amt * pay_rate, 2)
    diff = round(gbp_paid - gbp_signed, 2)
    ev = [{"key": "fx", "amount": amt, "signing_rate": sign_rate, "payment_rate": pay_rate,
           "gbp_at_signing": gbp_signed, "gbp_paid": gbp_paid, "fx_diff": diff}]
    return Decision(PROPOSE_FX, evidence=ev,
                    reason=(f"installment booked at the signing rate ({sign_rate}) but paid at {pay_rate}; "
                            f"£{abs(diff):,.0f} FX {'loss' if diff > 0 else 'gain'}. Propose an FX gain/loss entry."),
                    failing_check="fx_difference").finalize()


def detect_sell_on(clause_id: str) -> Decision:
    cl = read.clause(clause_id)
    ev = [{"key": "clause", "clause_id": clause_id, "ambiguity": cl.get("ambiguity_note"),
           "params": cl["params"]}]
    return Decision(ESCALATE_SELLON, evidence=ev,
                    reason=("sell-on clause is ambiguous (gross fee vs profit over book value) — the two "
                            "bases differ materially. Bring it to the accounting team; do not guess."),
                    failing_check="ambiguous_clause").finalize()


def detect_extension(clause_id: str) -> Decision:
    cl = read.clause(clause_id)
    p = cl["params"]
    ev = [{"key": "clause", "clause_id": clause_id, "old_months": p.get("old_amortization_months"),
           "new_months": p.get("new_amortization_months")}]
    return Decision(PROPOSE_AMORT, evidence=ev,
                    reason=(f"contract extended; amortization must change "
                            f"{p.get('old_amortization_months')}→{p.get('new_amortization_months')} months. "
                            "Propose the adjustment."),
                    failing_check="amortization_adjustment").finalize()


# --------------------------------------------------------------------------- #
# clause-trigger family: a contract term / status with a legal trigger → a logic
# gate → a proximity/risk alert → escalation. The agent quantifies the exposure and
# refuses to guess the legal call.
# --------------------------------------------------------------------------- #
def detect_wage_suspension(player_id: str) -> Decision:
    """The 'ready, willing & able' trap (Mendy v Manchester City, £11.5m). A suspended
    player who is NOT terminated remains entitled to pay unless the contract explicitly
    allows withholding. Suspended ≠ terminated — a strict logic gate."""
    pl = read.player(player_id)
    clauses = read.employment_clauses(player_id)
    kinds = [c["kind"] for c in clauses]
    has_withholding = "suspension_withholding" in kinds
    terminated = "termination" in kinds
    ev = [{"key": "contract", "player": player_id, "player_name": (pl or {}).get("name"),
           "employment_clauses": kinds, "has_suspension_withholding_clause": has_withholding,
           "status": "terminated" if terminated else "suspended_not_terminated"}]
    if terminated:
        return Decision(STOP_WAGES_TERMINATED, evidence=ev,
                        reason="the contract has been lawfully terminated — wages stop from the "
                               "termination date. Confirm the effective date before closing payroll.",
                        failing_check="confirm_termination_effective_date").finalize()
    if not has_withholding:
        return Decision(KEEP_PAYING_SUSPENSION, evidence=ev,
                        reason=("the player is suspended but NOT terminated, and the employment contract "
                                "has NO explicit 'suspension & pay-withholding' clause. Stopping wages would "
                                "be an unlawful deduction — a suspended player under contract is 'ready, "
                                "willing and able' and must be paid (cf. Mendy v Manchester City, £11.5m). "
                                "KEEP paying / keep accruing the wage liability; do NOT withhold without an "
                                "explicit clause or a completed lawful dismissal. Flagging it for the accounting team."),
                        failing_check="no_wage_withholding_clause").finalize()
    return Decision(PROPOSE_SUSPEND_PAY, evidence=ev,
                    reason=("the employment contract HAS an explicit suspension & pay-withholding clause — "
                            "withholding may be permitted for the suspension period, but confirm its trigger "
                            "conditions are met and formal disciplinary process is followed. Escalating for "
                            "the accounting team to confirm before any deduction."),
                    failing_check="withholding_needs_legal_signoff").finalize()


def detect_loan_to_buy(clause_id: str) -> Decision:
    """Conditional obligation to purchase (CAS 2025 / FIFA). A loan with a mandatory buy
    once the player makes N QUALIFYING appearances (≥ X minutes). Counts only ≥X-minute
    games, so an 89th-minute sub can't inflate the count. Warns at 70–80% of threshold;
    recognises the commitment once triggered; flags relegation/deadline edge cases."""
    cl = read.clause(clause_id)
    if not cl:
        return Decision(CHASE, reason=f"no clause {clause_id}", failing_check="missing_clause").finalize()
    p = cl.get("params") or {}
    tr = read.transfer(cl.get("contract_id"))
    player = (tr or {}).get("player_id")
    comps = cl.get("competitions_counted") or p.get("competitions") or ["league"]
    threshold = int(p.get("threshold_qualifying_appearances") or p.get("threshold") or 15)
    min_minutes = int(p.get("min_minutes") or 45)
    season = p.get("season")
    fee = float(p.get("fee") or 0)
    ccy = p.get("currency") or (tr or {}).get("currency") or "EUR"
    deadline = p.get("deadline")

    qualifying = read.qualifying_appearances(player, comps, min_minutes, season) if player else 0
    total = read.total_appearances(player, comps, season) if player else 0
    pct = round(100 * qualifying / threshold, 1) if threshold else 0
    today = read.world_today()
    past_deadline = bool(deadline) and str(today) > str(deadline)
    ev = [{"key": "obligation", "clause": clause_id, "player": player, "fee": fee, "currency": ccy,
           "threshold": threshold, "min_minutes": min_minutes, "qualifying_appearances": qualifying,
           "total_appearances": total, "non_qualifying": total - qualifying,
           "pct_to_trigger": pct, "deadline": str(deadline) if deadline else None,
           "relegation_voids": bool(p.get("relegation_voids"))}]

    if qualifying >= threshold:
        return Decision(PROPOSE_MANDATORY_PURCHASE, evidence=ev,
                        reason=(f"the mandatory-purchase trigger is MET: {qualifying}/{threshold} qualifying "
                                f"appearances (≥{min_minutes}min). A €{fee:,.0f} {ccy} obligation to buy is now "
                                f"unlocked — recognise the commitment/liability and plan the cash. Escalating "
                                f"for the accounting team to sign off (large, now-mandatory spend)."),
                        failing_check="mandatory_purchase_triggered").finalize()
    if past_deadline:
        return Decision(OBLIGATION_LAPSED, evidence=ev,
                        reason=(f"the trigger deadline ({deadline}) has passed at {qualifying}/{threshold} "
                                f"qualifying appearances — the obligation to buy has LAPSED; no purchase, "
                                f"derecognise any contingent commitment."),
                        failing_check=None).finalize()
    if pct >= 70:
        return Decision(WARN_OBLIGATION_NEAR, evidence=ev,
                        reason=(f"approaching the mandatory-purchase trigger: {qualifying}/{threshold} "
                                f"({pct}%) qualifying appearances. If it hits, a €{fee:,.0f} {ccy} spend auto-"
                                f"unlocks. Flagging it for the accounting team. Note: {total - qualifying} of "
                                f"{total} appearances were under {min_minutes}min and do NOT count."
                                + (" Relegation would void/renegotiate this — watch it." if p.get("relegation_voids") else "")),
                        failing_check="mandatory_purchase_approaching").finalize()
    return Decision(MONITOR_OBLIGATION, evidence=ev,
                    reason=(f"loan-to-buy at {qualifying}/{threshold} ({pct}%) qualifying appearances — "
                            f"monitoring; no commitment to recognise yet.")).finalize()


def detect_sporting_just_cause(player_id: str, established: bool = True) -> Decision:
    """Article 15 FIFA RSTP. An established player who features in <10% of the club's
    official matches can terminate for Sporting Just Cause — losing the club the asset
    for ZERO fee — but only within 15 days of the season's final official match."""
    pl = read.player(player_id)
    season = "DEMO/26"
    # infer the player's season from their appearances if not the demo season
    appr_season = read._one("SELECT season FROM golden.match_event WHERE player_id=%s "
                            "ORDER BY event_time DESC LIMIT 1", (player_id,))
    if appr_season and appr_season.get("season"):
        season = appr_season["season"]
    club_total = read.club_matches(season)
    player_app = read.total_appearances(player_id, season=season)
    ratio = round(100 * player_app / club_total, 1) if club_total else 0
    last_match = read.club_last_match(season)
    today = read.world_today()
    days_since_season_end = (today - last_match).days if last_match else None
    window_open = days_since_season_end is not None and 0 <= days_since_season_end <= 15
    ev = [{"key": "participation", "player": player_id, "player_name": (pl or {}).get("name"),
           "season": season, "club_matches": club_total, "player_appearances": player_app,
           "participation_pct": ratio, "established": established,
           "season_last_match": str(last_match) if last_match else None,
           "days_since_season_end": days_since_season_end,
           "art15_window_open": window_open}]
    if established and club_total and ratio < 10:
        win = ("the 15-day post-season window is OPEN — the player could walk NOW for free"
               if window_open else
               (f"the 15-day window has passed ({days_since_season_end} days since the last match) — "
                "a termination now would be UNLAWFUL, exposing the player/new club instead"
                if days_since_season_end is not None and days_since_season_end > 15 else
                "the window opens at the season's final match — set a timer"))
        return Decision(WARN_SPORTING_JUST_CAUSE, evidence=ev,
                        reason=(f"Article 15 risk: this established player featured in only {player_app}/"
                                f"{club_total} official matches ({ratio}%), below the 10% Sporting-Just-Cause "
                                f"threshold. The club risks losing the asset for ZERO transfer fee. {win}. "
                                f"Flagging it for the accounting team."),
                        failing_check="sporting_just_cause_exposure").finalize()
    return Decision(MONITOR_OBLIGATION, evidence=ev,
                    reason=(f"participation {ratio}% ({player_app}/{club_total}) — above the 10% Article 15 "
                            f"threshold; no Sporting-Just-Cause exposure.")).finalize()


# --------------------------------------------------------------------------- #
# router: given a planted/case descriptor, pick the detector and decide
# --------------------------------------------------------------------------- #
def decide(case: dict[str, Any]) -> Decision:
    t = case["type"]
    sr = case.get("subject_refs", case)
    if t in ("fake_bank_detail_change", "legitimate_bank_detail_change"):
        return detect_bank_change(sr["installment_id"], sr["inbox_id"])
    if t in ("incoming_short_solidarity", "incoming_short_unexplained"):
        return detect_short_receipt(sr["installment_id"], sr["txn_id"])
    if t == "addon_invoiced_not_triggered":
        return detect_addon_invoice(sr["invoice_id"])
    if t == "addon_triggered_not_booked":
        return detect_addon_triggered(sr["transfer_id"], sr["clause_id"])
    if t == "one_wire_many_items":
        return detect_combined_wire(sr["txn_id"], sr["installment_ids"], sr.get("clause_id"))
    if t == "duplicate_agent_fee":
        return detect_duplicate(sr["original_invoice_id"], sr["duplicate_invoice_id"])
    if t == "threshold_evasion_split":
        return detect_threshold(sr["invoice_ids"], float(sr.get("threshold", 250000)))
    if t == "stale_fx_rate":
        return detect_stale_fx(sr["installment_id"], sr["txn_id"])
    if t == "ambiguous_sell_on":
        return detect_sell_on(sr["sell_on_clause_id"])
    if t == "contract_extension_amortization":
        return detect_extension(sr["clause_id"])
    if t == "suspension_wage_withholding":
        return detect_wage_suspension(sr["player_id"])
    if t == "loan_to_buy_obligation":
        return detect_loan_to_buy(sr["clause_id"])
    if t == "sporting_just_cause":
        return detect_sporting_just_cause(sr["player_id"], bool(sr.get("established", True)))
    return Decision(CHASE, reason=f"unclassified scenario {t}; escalate.",
                    failing_check="unclassified").finalize()
