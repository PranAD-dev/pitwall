"""Self-learning at onboarding. The agent queries 12 months of how past humans
handled things, finds the patterns, and drafts a policy for each with its evidence
count. The controller (model-played) approves or rejects — thin evidence gets a no.
Approved policies become the auto_approve rules the hard-check gate cites.

Every write goes through the gateway (the one door); the policy table is versioned
and never edited in place.  (Hyphenate deck, slide 12.)"""

from __future__ import annotations

from datetime import datetime, timezone

from psycopg.types.json import Json

from ..db import connect
from . import detectors as D
from . import humans, read

# situation (from golden.historical_outcome) -> drafted policy
DRAFTS = {
    "incoming_short_solidarity": {
        "id": "pol-001", "covers": D.COMPLETE_SOLIDARITY, "kind": "reconcile",
        "text": "Incoming international transfer short by ≈5% → the solidarity contribution was "
                "withheld; book to solidarity receivable, do not chase.",
        "rule": {"when": "incoming_short", "shortfall_pct": 5, "requires": "solidarity_applicable",
                 "then": "book_solidarity_receivable", "chase": False}},
    "one_wire_many_items": {
        "id": "pol-014", "covers": D.SPLIT, "kind": "reconcile",
        "text": "A single wire that reconciles to the cent across the invoices named in its memo → "
                "split one-to-many.",
        "rule": {"when": "one_wire", "requires": "reconciles_to_cent", "then": "split_one_to_many"}},
    "duplicate_agent_fee": {
        "id": "pol-021", "covers": D.REJECT_DUP, "kind": "invoice",
        "text": "A second invoice with the same amount and transfer as an earlier one (number "
                "reformatted) → reject as a duplicate.",
        "rule": {"when": "duplicate_invoice", "then": "reject_duplicate"}},
    "addon_invoiced_not_triggered": {
        "id": "pol-031", "covers": D.REJECT, "kind": "addon",
        "text": "An add-on invoice whose counted appearances are below the clause threshold → "
                "reject, citing the clause and match ids.",
        "rule": {"when": "addon_invoice", "requires": "observed_below_threshold", "then": "reject"}},
    "legitimate_bank_detail_change": {
        "id": "pol-041", "covers": D.COMPLETE_AFTER_EVIDENCE, "kind": "fraud",
        "text": "A bank-detail change from the verified domain → complete only after a bank check "
                "confirms the new owner matches.",
        "rule": {"when": "bank_change", "requires": "bank_check_match", "then": "complete"}},
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def draft_policies() -> list[dict]:
    """Mine history → one drafted policy per pattern, with its evidence count."""
    counts = {r["situation"]: r["n"] for r in read.history_counts()}
    drafts = []
    for situation, d in DRAFTS.items():
        n = counts.get(situation, 0)
        if n == 0:
            continue
        drafts.append({**d, "situation": situation, "evidence_count": n})
    return drafts


def _write_policy(cur, d: dict, status: str, auto_approve: bool, approved_by: str | None,
                  reason: str) -> None:
    rule = {**d["rule"], "covers": d["covers"], "kind": d["kind"]}
    cur.execute(
        "INSERT INTO work.policy (id, version, rule, text, evidence_count, status, auto_approve, "
        "approved_by, valid_from) VALUES (%s,1,%s,%s,%s,%s,%s,%s,%s) "
        "ON CONFLICT (id, version) DO UPDATE SET status=EXCLUDED.status, "
        "auto_approve=EXCLUDED.auto_approve, approved_by=EXCLUDED.approved_by, "
        "valid_from=EXCLUDED.valid_from",
        (d["id"], Json(rule), d["text"], d["evidence_count"], status, auto_approve,
         approved_by, _now() if status == "approved" else None))
    cur.execute(
        "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, policy_id, policy_version) "
        "VALUES (%s,%s,%s,%s,true,%s,%s,1)",
        (_now(), approved_by or "ai_agent",
         "approve" if status == "approved" else "reject" if status == "rejected" else "propose",
         f"policy:{d['id']}", reason, d["id"]))


def onboard() -> list[dict]:
    """Draft each policy (ai_agent proposes), have the controller review it, and write
    approved ones as auto_approve rules. Returns the outcomes."""
    drafts = draft_policies()
    outcomes = []
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            for d in drafts:
                # ai_agent proposes the policy (logged)
                cur.execute(
                    "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, policy_id) "
                    "VALUES (%s,'ai_agent','propose',%s,true,%s,%s)",
                    (_now(), f"policy:{d['id']}",
                     f"drafted from {d['evidence_count']} precedents of {d['situation']}", d["id"]))
                # controller reviews (model-played; thin evidence → no)
                dec = humans.controller_reviews_policy(d["id"], d["evidence_count"], d["rule"])
                if dec.approved:
                    _write_policy(cur, d, "approved", True, humans.CONTROLLER.id, dec.reason)
                else:
                    _write_policy(cur, d, "rejected", False, humans.CONTROLLER.id, dec.reason)
                outcomes.append({"policy": d["id"], "situation": d["situation"],
                                 "evidence": d["evidence_count"], "approved": dec.approved,
                                 "reason": dec.reason, "covers": d["covers"], "text": d["text"]})
        conn.commit()
    finally:
        conn.close()
    return outcomes


def covering(action: str) -> tuple[str, int] | None:
    """The approved, auto_approve policy that covers a given action (for the gate to cite)."""
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, version FROM work.policy WHERE status='approved' AND auto_approve "
                        "AND rule->>'covers' = %s ORDER BY version DESC LIMIT 1", (action,))
            r = cur.fetchone()
            return (r[0], r[1]) if r else None
    finally:
        conn.close()
