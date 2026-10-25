"""Self-improving, every day (Hyphenate deck, slide 13).

A human correction on a work item becomes a **precedent**. When enough similar
precedents accumulate, the agent searches them, spots the pattern, and PROPOSES a
generalized policy citing the precedent ids. The controller (model-played) reviews
it — thin evidence gets a 'no' and the agent keeps escalating by hand; enough
evidence gets a 'yes' and it becomes a new `auto_approve` rule, so the same
correction is never needed twice.

Every step is written through the gateway and logged in the append-only audit log.
Precedents and the policy are the agent's memory in the DB, not the context window.
Deterministic + idempotent so the demo and eval reproduce.
"""

from __future__ import annotations

from datetime import datetime, timezone

from psycopg.types.json import Json

from ..db import connect
from ..sow import gateway
from ..sow.roles import SYNC
from . import humans

MIN_TO_PROPOSE = 3   # agent drafts once it has this many alike (deck: "≥3 alike")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# A pattern the agent can generalize once the corrections pile up. Keyed by the
# `situation` tag stored on each precedent.
IMPROVE_DRAFTS = {
    "one_wire_many_invoices": {
        "id": "pol-200", "covers": "SPLIT_ONE_TO_MANY", "kind": "reconcile",
        "text": "A single wire that names several invoice numbers in its memo and reconciles to the "
                "cent → split one-to-many across those invoices (learned from accountant corrections).",
        "rule": {"when": "one_wire", "requires": "reconciles_to_cent", "then": "split_one_to_many"},
    },
    # learned from Teamwork-Terminal HITL — once the controller/accountant has made the
    # same call ≥3 times, the agent generalizes it so it won't ask again.
    "ambiguous_sell_on": {
        "id": "pol-201", "covers": "ESCALATE_AMBIGUOUS_DO_NOT_GUESS", "kind": "sell_on",
        "text": "Apply the sell-on basis (gross fee vs profit over book value) the controller has "
                "settled on for materially identical clauses (learned from HITL decisions).",
        "rule": {"when": "ambiguous_sell_on", "then": "apply_decided_basis"},
    },
    "stale_fx_rate": {
        "id": "pol-202", "covers": "PROPOSE_FX_GAIN_LOSS", "kind": "fx",
        "text": "Book the FX gain/loss between the signing rate and the payment rate, as the accountant "
                "has decided before (learned from HITL decisions).",
        "rule": {"when": "stale_fx_rate", "then": "book_fx_gain_loss"},
    },
    "addon_triggered_not_booked": {
        "id": "pol-203", "covers": "PROPOSE_ACCRUAL_LIABILITY", "kind": "accrual",
        "text": "When a match-triggered add-on is met, accrue the contingent liability, as the "
                "accountant has approved before (learned from HITL decisions).",
        "rule": {"when": "addon_triggered", "then": "accrue_liability"},
    },
    "contract_extension_amortization": {
        "id": "pol-204", "covers": "PROPOSE_AMORTIZATION_ADJUSTMENT", "kind": "registration",
        "text": "On a contract extension, re-amortise over the new term, as the controller has "
                "approved before (learned from HITL decisions).",
        "rule": {"when": "extension", "then": "re_amortise_new_term"},
    },
    "incoming_short_unexplained": {
        "id": "pol-205", "covers": "CHASE_OR_ESCALATE", "kind": "collection",
        "text": "An unexplained short receipt is chased for the balance, as the accountant has "
                "handled before (learned from HITL decisions).",
        "rule": {"when": "short_unexplained", "then": "chase_balance"},
    },
}


def record_correction(work_item_id: str, situation: str, correction: dict,
                      actor: str = "accountant:priya") -> str:
    """A human corrected the agent's handling → store it as a precedent (+ audit). Idempotent."""
    pid = f"prec-{situation}-{work_item_id}"
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO work.precedent (id, work_item_id, situation, correction, actor) "
                "VALUES (%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING RETURNING id",
                (pid, work_item_id, situation, Json(correction), actor))
            if cur.fetchone():  # only log when it was actually new
                cur.execute(
                    "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, diff) "
                    "VALUES (%s,%s,'correct',%s,true,%s,%s)",
                    (_now(), actor, work_item_id, f"human correction stored as precedent {pid}",
                     Json(correction)))
        conn.commit()
    finally:
        conn.close()
    return pid


def similar_precedents(situation: str) -> list[dict]:
    """Search memory for corrections of the same shape."""
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, work_item_id, correction, actor, at FROM work.precedent "
                "WHERE situation=%s ORDER BY at", (situation,))
            return [{"id": r[0], "work_item_id": r[1], "correction": r[2],
                     "actor": r[3], "at": r[4].isoformat()} for r in cur.fetchall()]
    finally:
        conn.close()


def propose_from_precedents(situation: str) -> dict:
    """If ≥MIN_TO_PROPOSE similar precedents exist, draft a generalized policy citing them,
    have the controller review it, and write the outcome (versioned, logged). Idempotent."""
    precs = similar_precedents(situation)
    draft = IMPROVE_DRAFTS.get(situation)
    base = {"situation": situation, "precedents": [p["id"] for p in precs], "count": len(precs),
            "min_to_propose": MIN_TO_PROPOSE}
    if not draft:
        return {**base, "status": "no_template", "reason": f"no generalization template for {situation}"}
    if len(precs) < MIN_TO_PROPOSE:
        return {**base, "status": "waiting",
                "reason": f"only {len(precs)} precedents — need {MIN_TO_PROPOSE} before generalizing"}

    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            # already generalized at this evidence level? → no-op (keeps re-runs clean)
            cur.execute("SELECT version FROM work.policy WHERE id=%s AND status='approved' "
                        "AND evidence_count>=%s ORDER BY version DESC LIMIT 1",
                        (draft["id"], len(precs)))
            existing = cur.fetchone()
            if existing:
                return {**base, "status": "already_active", "policy": f"{draft['id']} v{existing[0]}",
                        "reason": "policy already generalized from these precedents"}

            cur.execute("SELECT COALESCE(MAX(version),0)+1 FROM work.policy WHERE id=%s", (draft["id"],))
            version = cur.fetchone()[0]
            prec_ids = [p["id"] for p in precs]

            # ai_agent proposes the generalized policy, citing the precedent ids (logged)
            cur.execute(
                "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, policy_id, "
                "policy_version, evidence) VALUES (%s,'ai_agent','propose',%s,true,%s,%s,%s,%s)",
                (_now(), f"policy:{draft['id']}",
                 f"generalized from {len(precs)} precedents of {situation}", draft["id"], version,
                 Json(prec_ids)))

            # controller reviews (model-played, evidence-gated — handles a 'no')
            dec = humans.controller_reviews_policy(draft["id"], len(precs), draft["rule"])
            status = "approved" if dec.approved else "rejected"
            rule = {**draft["rule"], "covers": draft["covers"], "kind": draft["kind"],
                    "precedents": prec_ids}
            cur.execute(
                "INSERT INTO work.policy (id, version, rule, text, evidence_count, status, auto_approve, "
                "approved_by, valid_from) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "ON CONFLICT (id, version) DO UPDATE SET status=EXCLUDED.status, "
                "auto_approve=EXCLUDED.auto_approve, approved_by=EXCLUDED.approved_by, "
                "valid_from=EXCLUDED.valid_from",
                (draft["id"], version, Json(rule), draft["text"], len(precs), status, dec.approved,
                 humans.CONTROLLER.id, _now() if dec.approved else None))
            cur.execute(
                "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, policy_id, "
                "policy_version) VALUES (%s,%s,%s,%s,true,%s,%s,%s)",
                (_now(), humans.CONTROLLER.id, status, f"policy:{draft['id']}", dec.reason,
                 draft["id"], version))
        conn.commit()
    finally:
        conn.close()
    return {**base, "status": status, "policy": f"{draft['id']} v{version}", "reason": dec.reason,
            "covers": draft["covers"], "text": draft["text"]}


# Deterministic demo: several clubs pay one wire across two installments; the
# accountant splits each by hand; the agent generalizes the rule. Re-runnable.
DEMO_CORRECTIONS = [
    ("WI-combined-wire-1", {"did": "split one wire across 2 installments", "club": "Castleton City"}),
    ("WI-combined-wire-2", {"did": "split one wire across 2 installments + add-on", "club": "Fenwick Rovers"}),
    ("WI-improve-rialto",  {"did": "split one wire across 2 installments", "club": "FC Rialto"}),
    ("WI-improve-oakmere", {"did": "split one wire across 3 invoices", "club": "Oakmere United"}),
    ("WI-improve-dunmore", {"did": "split one wire across 2 invoices", "club": "Dunmore Athletic"}),
]


def improve_demo() -> dict:
    """Record the corrections, then let the agent generalize. Returns the whole loop."""
    sit = "one_wire_many_invoices"
    # make sure each corrected item exists (sync creates them; idempotent)
    for wi, corr in DEMO_CORRECTIONS:
        gateway.create_work_item(SYNC, wi, "reconcile_receipt",
                                 {"club": corr.get("club")}, reason="historical combined wire")
    recorded = [record_correction(wi, sit, corr) for wi, corr in DEMO_CORRECTIONS]
    outcome = propose_from_precedents(sit)
    return {"situation": sit, "recorded": recorded, "precedents": similar_precedents(sit),
            "outcome": outcome}
