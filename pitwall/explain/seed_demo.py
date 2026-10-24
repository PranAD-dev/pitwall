"""Demo work-item fixtures so the Explainer has real Tiger rows to narrate before
the full System of Work (M1) and x402 layer (M3) are built. Each fixture mirrors
the shape those milestones will produce: a work item, an append-only audit trail
(including a DENIED attempt), attached evidence, an x402 payment, and a policy.

These reference the deterministic world (fraud-1 = cp-northgate / tr-in-fr-1).
Idempotent: skips a fixture whose work item already exists (audit log is
append-only, so we never delete)."""

from __future__ import annotations

from datetime import datetime, timezone

from psycopg.types.json import Json
from rich.console import Console

from ..db import connect

console = Console()


def _ts(y, m, d, hh, mm) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc)


def _exists(cur, wi: str) -> bool:
    cur.execute("SELECT 1 FROM work.work_item WHERE id = %s", (wi,))
    return cur.fetchone() is not None


def _insert_work_item(cur, **v) -> None:
    cols = ["id", "kind", "state", "subject_refs", "proposal", "proposed_by", "approved_by",
            "evidence", "confidence_checks", "failing_check", "created_at", "updated_at"]
    jsonc = {"subject_refs", "proposal", "evidence", "confidence_checks"}
    vals = [Json(v[c]) if c in jsonc and v.get(c) is not None else v.get(c) for c in cols]
    cur.execute(
        f"INSERT INTO work.work_item ({','.join(cols)}) VALUES ({','.join(['%s'] * len(cols))})",
        vals,
    )


def _audit(cur, at, actor, action, subject, allowed, reason, to_state=None, evidence=None,
           policy_id=None, policy_version=None) -> None:
    diff = {"to_state": to_state} if to_state else {}
    cur.execute(
        "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, diff, evidence, "
        "policy_id, policy_version) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (at, actor, action, subject, allowed, reason, Json(diff),
         Json(evidence) if evidence is not None else None, policy_id, policy_version),
    )


def _x402(cur, at, wi, seller, evidence_type, amount, response, tx_hash) -> None:
    cur.execute(
        "INSERT INTO work.x402_payment (at, tx_hash, network, seller, evidence_type, amount_usdc, "
        "work_item_id, request, response, simulated) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
        (at, tx_hash, "base-sepolia", seller, evidence_type, amount, wi,
         Json({}), Json(response), True),
    )


def _policy(cur, pid, version, rule, text, valid_from, approved_by) -> None:
    cur.execute("SELECT 1 FROM work.policy WHERE id=%s AND version=%s", (pid, version))
    if cur.fetchone():
        return
    cur.execute(
        "INSERT INTO work.policy (id, version, rule, text, evidence_count, status, auto_approve, "
        "approved_by, valid_from) VALUES (%s,%s,%s,%s,%s,'approved',false,%s,%s)",
        (pid, version, Json(rule), text, 0, approved_by, valid_from),
    )


# --------------------------------------------------------------------------- #
def _seed_fraud_hold(cur) -> bool:
    WI = "WI-5602"
    if _exists(cur, WI):
        return False
    inst = cur.execute(
        "SELECT i.amount, i.currency FROM golden.installment i WHERE i.id='tr-in-fr-1-i4'"
    ).fetchone()
    amount = float(inst[0]) if inst else 2_750_000.0
    ccy = inst[1] if inst else "EUR"
    prior = cur.execute(
        "SELECT count(*) FROM golden.installment WHERE transfer_id='tr-in-fr-1' AND status='paid'"
    ).fetchone()[0]

    _policy(cur, "pol-011", 2,
            {"kind": "fraud_hold_release", "requires": ["cfo", "second_approver"]},
            "Release of a fraud hold requires two approvers, including the CFO.",
            _ts(2026, 1, 1, 0, 0), "controller:Dana")

    evidence = [
        {"key": "email", "at": _ts(2026, 5, 5, 9, 15).isoformat(),
         "from_domain": "northgate-rangers.fr", "legit_domain": "northgaterangers.fr",
         "amount": amount, "currency": ccy, "note": "bank-detail change request"},
        {"key": "history", "at": _ts(2026, 5, 5, 8, 1).isoformat(),
         "payee": "Northgate Rangers", "prior_payments": int(prior)},
        {"key": "bank_check", "at": _ts(2026, 5, 5, 9, 20).isoformat(),
         "result": "mismatch", "cost_usdc": 0.04, "network": "base-sepolia",
         "tx_hash": "0xSIMULATED5a3f91bankcheck", "seller": "bank-account-verify (SIMULATED)"},
        {"key": "rule", "at": _ts(2026, 5, 5, 9, 21).isoformat(),
         "policy_id": "pol-011", "policy_version": 2,
         "requirement": "two approvers including the CFO"},
    ]
    _insert_work_item(
        cur, id=WI, kind="pay_installment", state="HELD",
        subject_refs={"installment_id": "tr-in-fr-1-i4", "counterparty_id": "cp-northgate",
                      "inbox_id": "msg-fr-1"},
        proposal={"action": "HOLD", "amount": amount, "currency": ccy, "payee": "Northgate Rangers"},
        proposed_by="ai_agent", approved_by=None, evidence=evidence,
        confidence_checks=[
            {"check": "counterparty_bank_details_verified", "passed": False,
             "detail": "claimed IBAN does not match verified owner"},
            {"check": "lookalike_domain", "passed": False, "detail": "edit-distance 1 from legit"},
            {"check": "change_window", "passed": False, "detail": "change < 72h before due date"},
        ],
        failing_check="counterparty_bank_details_verified",
        created_at=_ts(2026, 5, 5, 8, 0), updated_at=_ts(2026, 5, 6, 10, 10),
    )
    _audit(cur, _ts(2026, 5, 5, 8, 0), "sync", "create", WI, True,
           "installment tr-in-fr-1-i4 due 2026-05-08", to_state="NEW")
    _audit(cur, _ts(2026, 5, 5, 8, 1), "ai_agent", "propose", WI, True,
           "routine payable; counterparty paid to verified IBAN before", to_state="PROPOSED")
    _audit(cur, _ts(2026, 5, 5, 9, 20), "ai_agent", "buy_evidence", WI, True,
           "risk high: lookalike domain + bank-detail change <72h before due",
           evidence=[evidence[2]])
    _audit(cur, _ts(2026, 5, 5, 9, 21), "ai_agent", "hold", WI, True,
           "bank-account check returned mismatch; suspected fraud", to_state="HELD",
           evidence=evidence, policy_id="pol-011", policy_version=2)
    _audit(cur, _ts(2026, 5, 6, 10, 6), "sporting_director", "release", WI, False,
           "DENIED: separation of duties — fraud-hold release needs the CFO as second approver",
           policy_id="pol-011", policy_version=2)
    _audit(cur, _ts(2026, 5, 6, 10, 10), "ai_agent", "ask", WI, True,
           "routed release request to human_cfo for second approval")
    _x402(cur, _ts(2026, 5, 5, 9, 20), WI, "bank-account-verify (SIMULATED)",
          "bank-account-verify", 0.04,
          {"result": "mismatch", "owner": "NAME MISMATCH / UNVERIFIED"},
          "0xSIMULATED5a3f91bankcheck")
    return True


def _seed_addon_reject(cur) -> bool:
    WI = "WI-5611"
    if _exists(cur, WI):
        return False
    evidence = [
        {"key": "clause", "at": _ts(2026, 4, 2, 9, 1).isoformat(), "clause_id": "cl-mo-addon",
         "threshold": 25, "competitions": "league"},
        {"key": "match", "at": _ts(2026, 4, 2, 9, 1).isoformat(),
         "observed_league": 24, "observed_cup": 3,
         "note": "the 25th appearance was an excluded cup game"},
    ]
    _insert_work_item(
        cur, id=WI, kind="addon_claim", state="REJECTED",
        subject_refs={"invoice_id": "inv-addon-mo", "clause_id": "cl-mo-addon",
                      "counterparty_id": "cp-montara", "player_id": "pl-mo"},
        proposal={"action": "REJECT", "amount": 500000, "currency": "EUR",
                  "reason": "appearance threshold not met in counted competition"},
        proposed_by="ai_agent", approved_by="human_accountant", evidence=evidence,
        confidence_checks=[
            {"check": "appearances_vs_threshold", "passed": False,
             "detail": "24 league < 25 required (cup excluded)"},
        ],
        failing_check=None,
        created_at=_ts(2026, 4, 2, 9, 0), updated_at=_ts(2026, 4, 2, 9, 30),
    )
    _audit(cur, _ts(2026, 4, 2, 9, 0), "sync", "create", WI, True,
           "invoice inv-addon-mo claims a 25-appearance add-on", to_state="NEW")
    _audit(cur, _ts(2026, 4, 2, 9, 1), "ai_agent", "propose", WI, True,
           "match data shows 24 league appearances; clause counts league only", to_state="PROPOSED",
           evidence=evidence)
    _audit(cur, _ts(2026, 4, 2, 9, 30), "gateway", "reject", WI, True,
           "rejected: add-on not triggered; cited clause cl-mo-addon + match ids", to_state="REJECTED")
    return True


def seed() -> None:
    conn = connect("superuser")
    try:
        with conn.cursor() as cur:
            seeded = []
            if _seed_fraud_hold(cur):
                seeded.append("WI-5602 (fraud hold)")
            if _seed_addon_reject(cur):
                seeded.append("WI-5611 (add-on reject)")
        conn.commit()
    finally:
        conn.close()
    if seeded:
        console.print("[green]seeded demo work items:[/] " + ", ".join(seeded))
    else:
        console.print("[dim]demo work items already present — nothing to seed[/]")
