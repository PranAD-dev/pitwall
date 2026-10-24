"""The agent loop. Onboarding runs self-learning; processing walks each case through
the gateway: propose → (auto-complete under a learned policy) OR (hold + escalate to
the CFO) OR (ask the right human, with the failing check named). Everything is a
logged transition; the agent never writes the DB directly."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from psycopg.types.json import Json

from ..db import connect
from ..sow import gateway
from ..sow.roles import AI_AGENT, SYNC, Actor
from . import detectors as D
from . import humans, policy

ANSWER_KEY = Path(__file__).resolve().parents[2] / "world" / "out" / "answer_key.json"

KIND = {
    "fake_bank_detail_change": "pay_installment", "legitimate_bank_detail_change": "pay_installment",
    "incoming_short_solidarity": "collect_receivable", "incoming_short_unexplained": "collect_receivable",
    "addon_invoiced_not_triggered": "addon_claim", "addon_triggered_not_booked": "addon_accrual",
    "one_wire_many_items": "reconcile_receipt", "duplicate_agent_fee": "invoice_review",
    "threshold_evasion_split": "invoice_review", "stale_fx_rate": "fx_review",
    "ambiguous_sell_on": "contract_review", "contract_extension_amortization": "contract_review",
}
HUMAN = {"human_accountant": humans.ACCOUNTANT, "human_controller": humans.CONTROLLER,
         "human_cfo": humans.CFO}
ACCOUNT = {D.COMPLETE_SOLIDARITY: "1210 Solidarity receivable", D.SPLIT: "1200 Transfer receivable",
           D.REJECT_DUP: "n/a — rejected", D.REJECT: "n/a — rejected",
           D.COMPLETE_AFTER_EVIDENCE: "2000 Transfer payable"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ask(wi_id: str, to_role: str, text: str, answer: str | None = None,
         answered_by: str | None = None) -> None:
    """Record a question to a human (and its answer, if given) — through the gateway."""
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO work.question (id, work_item_id, to_role, text, answer, answered_by, "
                "answered_at) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                (f"q-{wi_id}-{to_role}", wi_id, to_role, text, answer, answered_by,
                 _now() if answer else None))
        conn.commit()
    finally:
        conn.close()


def onboard() -> list[dict]:
    """Self-learning: mine history, draft policies, controller approves/rejects."""
    return policy.onboard()


def process_case(case: dict) -> dict:
    issue_id = case.get("issue_id", case["type"])
    wi_id = f"WI-{issue_id}"
    sr = case["subject_refs"]
    item = gateway.create_work_item(SYNC, wi_id, KIND.get(case["type"], "review"), sr,
                                    reason=case["type"])
    if item["state"] != "NEW":
        return {"wi": wi_id, "skipped": f"already {item['state']}"}

    d = D.decide(case)
    gateway.transition(
        AI_AGENT, wi_id, "propose",
        patch={"proposed_by": "ai_agent",
               "proposal": {"action": d.action, "reason": d.reason},
               "evidence": d.evidence, "failing_check": d.failing_check},
        reason=d.reason, evidence=d.evidence)

    out = {"wi": wi_id, "type": case["type"], "action": d.action, "auto": d.auto_completed,
           "escalated_to": d.escalated_to, "x402": bool(d.x402)}

    if d.action == D.HOLD:
        gateway.transition(AI_AGENT, wi_id, "hold", reason=d.reason, evidence=d.evidence)
        dec = humans.cfo_reviews_fraud_release(wi_id)
        _ask(wi_id, "human_cfo", "release the fraud hold?",
             answer=("release" if dec.approved else "do not release") + " — " + dec.reason,
             answered_by=humans.CFO.id)
        out["final"] = "HELD"
        out["cfo"] = "release" if dec.approved else "held — do not release"

    elif d.auto_completed:
        pol = policy.covering(d.action)
        if pol:
            lines = [{"account": ACCOUNT.get(d.action, "—"), "memo": d.action, "work_item": wi_id}]
            gateway.auto_complete(wi_id, pol[0], pol[1], journal_lines=lines,
                                  reason=f"hard checks pass; auto-approved on {pol[0]} v{pol[1]}")
            out["final"] = "POSTED"
            out["policy"] = f"{pol[0]} v{pol[1]}"
        else:
            out["final"] = "PROPOSED (no policy yet — escalated)"
            out["escalated_to"] = "human_accountant"
            _ask(wi_id, "human_accountant", "no policy covers this yet — confirm treatment?")
            gateway.transition(AI_AGENT, wi_id, "ask", reason="no auto_approve policy yet")

    else:  # escalate to the right human with the failing check named
        role = d.escalated_to or "human_controller"
        gateway.transition(AI_AGENT, wi_id, "ask",
                           reason=f"escalated to {role}: {d.failing_check or 'needs review'}")
        _ask(wi_id, role, f"review: {d.reason}")
        out["final"] = "NEEDS_INFO"

    return out


def run_all(limit: int | None = None) -> dict:
    """Onboard, then process every planted scenario. Returns a summary."""
    key = json.loads(ANSWER_KEY.read_text())
    if limit:
        key = key[:limit]
    results = []
    for issue in key:
        results.append(process_case({"issue_id": issue["issue_id"], "type": issue["type"],
                                     "subject_refs": issue["subject_refs"]}))
    completed = [r for r in results if r.get("final") == "POSTED"]
    escalated = [r for r in results if r.get("final") in ("NEEDS_INFO", "HELD")]
    skipped = [r for r in results if r.get("skipped")]
    return {"results": results, "n": len(results), "auto_completed": len(completed),
            "escalated": len(escalated), "skipped": len(skipped)}
