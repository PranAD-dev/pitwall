"""Self-learning at onboarding — the agent's *accounting* policies.

It mines the records and drafts the accounting treatments it will apply (how each
event books), grounded in IAS 38 / UEFA G.3 / HMRC GFC6. Clear-cut standards become
`auto_approve` rules the posting engine can act on; judgment calls (impairment, the
agent-fee split) are written but NOT auto — they escalate, and the self-improving
loop (agent/improve.py) turns human corrections into tightened policy over time.

Every write goes through the gateway; the policy table is versioned and never edited
in place. `onboard()` resets the policy set so the database reflects ONLY these
accounting policies — the old claim-decision rules are cleared.
"""

from __future__ import annotations

from datetime import datetime, timezone

from psycopg.types.json import Json

from ..db import connect
from . import humans

# The accounting policies the system holds. `covers` is the posting kind the engine
# checks; `auto` = may post without a human; `evidence_sql` counts the precedents the
# policy was learned from (the records it applies to).
ACCOUNTING_DRAFTS = {
    "pol-100": {
        "id": "pol-100", "covers": ["capitalize", "amortise", "disposal", "transfer_settlement"],
        "kind": "registration", "auto": True,
        "basis": "IAS 38 ¶27, 97-99",
        "text": "Capitalise a transfer fee (plus directly-attributable agent fees) as a player "
                "registration intangible asset, and amortise it straight-line over the contract term; "
                "settle the transfer payable and collect the receivable in cash as installments clear.",
        "rule": {"when": "transfer_in", "treatment": "capitalise_then_amortise_straight_line",
                 "over": "contract_term"},
        "evidence_sql": "SELECT count(*) FROM golden.transfer WHERE direction='in'"},
    "pol-101": {
        "id": "pol-101", "covers": "extension", "kind": "registration", "auto": True,
        "basis": "UEFA G.3",
        "text": "On a contract extension, re-amortise the carrying value plus new attributable "
                "costs over the remaining original term or the extended term, capped at 5 years "
                "from the extension date.",
        "rule": {"when": "extension", "treatment": "re_amortise", "cap_years": 5,
                 "escalate_if": "period_ambiguous"},
        "evidence_sql": "SELECT count(*) FROM golden.contract_clause WHERE kind='extension'"},
    "pol-102": {
        "id": "pol-102", "covers": "impairment", "kind": "registration", "auto": False,
        "basis": "UEFA annual impairment review",
        "text": "Review capitalised player values each year; on relegation or sustained loss of "
                "form, book an impairment charge. Judgment — escalate for sign-off.",
        "rule": {"when": "impairment_indicator", "treatment": "impair", "requires": "human_review"},
        "evidence_sql": "SELECT 0"},
    "pol-110": {
        "id": "pol-110", "covers": "wages", "kind": "payroll", "auto": True,
        "basis": "IAS 38 — wages expensed, not capitalised",
        "text": "Recognise wages as an operating expense each month from the authorised payroll "
                "run. Wages are never capitalised into a registration.",
        "rule": {"when": "payroll_run", "treatment": "expense_monthly", "source": "payroll_run"},
        "evidence_sql": "SELECT count(*) FROM golden.payroll_run"},
    "pol-111": {
        "id": "pol-111", "covers": "bonus_accrual", "kind": "payroll", "auto": True,
        "basis": "staff-cost accrual when earned",
        "text": "Accrue player performance bonuses as a staff-cost liability in the period the "
                "match trigger (appearance/goal) is met; recognise the expense then.",
        "rule": {"when": "bonus_triggered", "treatment": "accrue_liability", "trigger": "match_event"},
        "evidence_sql": "SELECT count(*) FROM golden.payroll_run WHERE earned_appearance_bonus>0 "
                        "OR earned_goal_bonus>0"},
    "pol-120": {
        "id": "pol-120", "covers": "agent_fee_split", "kind": "agent_fees", "auto": False,
        "basis": "IAS 38 ¶27 + HMRC GFC6 (2024)",
        "text": "Split each agent fee into club-service (capitalise into the registration and "
                "amortise) and player-service (expense as a benefit-in-kind). No default 50/50 — "
                "every split must be evidenced; escalate any unevidenced split.",
        "rule": {"when": "agent_fee", "treatment": "split_club_vs_player", "default_split": None,
                 "requires": "documented_evidence", "escalate_if": "no_evidence"},
        "evidence_sql": "SELECT count(*) FROM golden.invoice WHERE kind='agent_fee'"},
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _evidence(sql: str) -> int:
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            r = cur.fetchone()
            return int(r[0]) if r and r[0] is not None else 0
    except Exception:
        return 0
    finally:
        conn.close()


def draft_policies() -> list[dict]:
    """The accounting policies, each with the evidence count it was learned from."""
    out = []
    for d in ACCOUNTING_DRAFTS.values():
        out.append({**d, "evidence_count": _evidence(d["evidence_sql"])})
    return out


def _clear_old_policies() -> int:
    """Reset the policy table so it reflects ONLY the accounting policies (superuser —
    work.policy isn't granted DELETE to app roles). Keeps the books focused."""
    conn = connect("superuser")
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM work.policy WHERE id NOT LIKE 'pol-1%'")
            n = cur.rowcount
        conn.commit()
        return n
    finally:
        conn.close()


def _write_policy(cur, d: dict, status: str, auto_approve: bool, approved_by: str) -> None:
    rule = {**d["rule"], "covers": d["covers"], "kind": d["kind"], "basis": d["basis"]}
    cur.execute(
        "INSERT INTO work.policy (id, version, rule, text, evidence_count, status, auto_approve, "
        "approved_by, valid_from) VALUES (%s,1,%s,%s,%s,%s,%s,%s,%s) "
        "ON CONFLICT (id, version) DO UPDATE SET rule=EXCLUDED.rule, text=EXCLUDED.text, "
        "evidence_count=EXCLUDED.evidence_count, status=EXCLUDED.status, "
        "auto_approve=EXCLUDED.auto_approve, approved_by=EXCLUDED.approved_by, "
        "valid_from=EXCLUDED.valid_from",
        (d["id"], Json(rule), d["text"], d["evidence_count"], status, auto_approve,
         approved_by, _now()))
    cur.execute(
        "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, policy_id, policy_version) "
        "VALUES (%s,'ai_agent','propose',%s,true,%s,%s,1)",
        (_now(), f"policy:{d['id']}", f"drafted accounting policy from {d['evidence_count']} "
         f"records · {d['basis']}", d["id"]))
    cur.execute(
        "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, policy_id, policy_version) "
        "VALUES (%s,%s,%s,%s,true,%s,%s,1)",
        (_now(), approved_by, "approve" if status == "approved" else "propose", f"policy:{d['id']}",
         ("auto-approve accounting standard" if auto_approve else "written, escalates for judgment"),
         d["id"]))


def onboard() -> list[dict]:
    """Learn the accounting policies and write them as the ONLY policies in the DB.
    Clear-cut standards are approved + auto_approve; judgment calls are written but
    escalate. Returns the outcomes for the CLI."""
    cleared = _clear_old_policies()
    drafts = draft_policies()
    outcomes = []
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            for d in drafts:
                auto = bool(d["auto"])
                status = "approved"  # the treatments are standards the controller signs off
                _write_policy(cur, d, status, auto, humans.CONTROLLER.id)
                outcomes.append({
                    "policy": d["id"], "situation": d["basis"], "evidence": d["evidence_count"],
                    "approved": auto, "covers": d["covers"], "text": d["text"],
                    "reason": "auto-approve" if auto else "escalates (judgment)"})
        conn.commit()
    finally:
        conn.close()
    outcomes.append({"_cleared": cleared})
    return [o for o in outcomes if "_cleared" not in o]


def propose_policies(config: dict | None = None) -> list[dict]:
    """Learn the policies and write them as PROPOSED (status='proposed', not yet
    active) — a human still has to approve them. Clears the old set first so the DB
    reflects only these. `config` may narrow which policy domains to learn."""
    only = set((config or {}).get("roles") or [])
    _clear_old_policies()
    drafts = [d for d in draft_policies()
              if not only or d["kind"] in only or d["covers"] in only
              or (isinstance(d["covers"], list) and only & set(d["covers"]))]
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            for d in drafts:
                rule = {**d["rule"], "covers": d["covers"], "kind": d["kind"], "basis": d["basis"]}
                cur.execute(
                    "INSERT INTO work.policy (id, version, rule, text, evidence_count, status, "
                    "auto_approve, approved_by, valid_from) VALUES (%s,1,%s,%s,%s,'proposed',%s,NULL,NULL) "
                    "ON CONFLICT (id, version) DO UPDATE SET rule=EXCLUDED.rule, text=EXCLUDED.text, "
                    "evidence_count=EXCLUDED.evidence_count, status='proposed', "
                    "auto_approve=EXCLUDED.auto_approve, approved_by=NULL, valid_from=NULL",
                    (d["id"], Json(rule), d["text"], d["evidence_count"], bool(d["auto"])))
                cur.execute(
                    "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, "
                    "policy_id, policy_version) VALUES (%s,'ai_agent','propose',%s,true,%s,%s,1)",
                    (_now(), f"policy:{d['id']}",
                     f"learned from {d['evidence_count']} records · {d['basis']} — awaiting approval",
                     d["id"]))
        conn.commit()
    finally:
        conn.close()
    return drafts


def approve_policies(ids: list[str] | None = None, *, approver: str | None = None) -> dict:
    """A human approves proposed policies → they become active (auto_approve rules the
    engine can cite). Each approval is logged in the append-only audit."""
    who = approver or humans.CONTROLLER.id
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            if ids:
                cur.execute("SELECT id FROM work.policy WHERE status='proposed' AND id = ANY(%s)", (ids,))
            else:
                cur.execute("SELECT id FROM work.policy WHERE status='proposed'")
            pending = [r[0] for r in cur.fetchall()]
            for pid in pending:
                cur.execute("UPDATE work.policy SET status='approved', approved_by=%s, valid_from=%s "
                            "WHERE id=%s AND version=1", (who, _now(), pid))
                cur.execute(
                    "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, "
                    "policy_id, policy_version) VALUES (%s,%s,'approve',%s,true,%s,%s,1)",
                    (_now(), who, f"policy:{pid}", "controller approved the learned policy", pid))
        conn.commit()
    finally:
        conn.close()
    return {"approved": pending, "by": who}


def pending_policies() -> list[dict]:
    rows = []
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, text, evidence_count, auto_approve, rule FROM work.policy "
                        "WHERE status='proposed' ORDER BY id")
            for r in cur.fetchall():
                rule = r[4] or {}
                rows.append({"id": r[0], "text": r[1], "evidence": r[2], "auto": r[3],
                             "covers": rule.get("covers"), "basis": rule.get("basis")})
    finally:
        conn.close()
    return rows


def covering(action: str) -> tuple[str, int] | None:
    """The approved, auto_approve policy that covers a posting kind (for the engine to
    cite). A NEWBIE / no-context agent has no policies to lean on — it returns None, so
    the caller escalates everything. `covers` may be a single kind or a list."""
    from ..config import get_agent_mode

    if get_agent_mode() in ("newbie", "no-context", "none"):
        return None
    # the cash-settlement decisions (pay an installment, collect a receivable, split a
    # reconciled wire) are governed by the registration policy's settlement clause
    if action in ("COMPLETE_AFTER_EVIDENCE", "COMPLETE_DO_NOT_CHASE", "SPLIT_ONE_TO_MANY"):
        action = "transfer_settlement"
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, version FROM work.policy WHERE status='approved' AND auto_approve AND ("
                "  rule->>'covers' = %s "
                "  OR (jsonb_typeof(rule->'covers')='array' AND rule->'covers' ? %s)) "
                "ORDER BY version DESC LIMIT 1", (action, action))
            r = cur.fetchone()
            return (r[0], r[1]) if r else None
    finally:
        conn.close()
