"""Build 4 — the Gateway: the ONE door. Every write to a record goes through here
and is checked. Every transition is logged as a diff, in the SAME commit as the
change, and denied attempts are logged too. Months later, "why?" is one query.
(Hyphenate deck, slides 9 + 18.)

The gateway is the only thing that runs with write credentials: it connects as the
`gateway` Postgres role (the only role that may INSERT journal entries, mark
installments paid, and append to the audit log). Agents and humans never write the
DB directly — they call these functions; `can()` gates the logical action and the
DB grants are the backstop.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Json

from ..db import connect
from .roles import Actor, can
from .transitions import Denied, next_state

# work_item columns the gateway may patch via a transition
_PATCHABLE = {"proposal", "proposed_by", "approved_by", "evidence",
              "confidence_checks", "failing_check", "subject_refs"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _snapshot(item: dict) -> dict:
    """The audit-relevant fields of a work item, for diffing."""
    keys = ("state", "proposal", "proposed_by", "approved_by", "failing_check")
    return {k: item.get(k) for k in keys}


def _diff(before: dict, after: dict) -> dict:
    """Field-level diff {field: {from, to}} — what the deck stores as `diff`."""
    out: dict[str, Any] = {}
    for k in set(before) | set(after):
        if before.get(k) != after.get(k):
            out[k] = {"from": before.get(k), "to": after.get(k)}
    return out


def read_work_item(cur, item_id: str) -> dict | None:
    cur.execute("SELECT * FROM work.work_item WHERE id = %s", (item_id,))
    return cur.fetchone()


def transition(actor: Actor, item_id: str, action: str, *, patch: dict | None = None,
               reason: str = "", evidence: list | None = None) -> dict:
    """Apply `action` to work item `item_id` as `actor`. Writes the work-item change
    and the audit row in one transaction; a denied attempt is committed to the audit
    log (allowed=false) and then raises Denied. Returns the updated work item.

    This mirrors the deck's transition() exactly — the raise happens AFTER the
    commit, so denied attempts are never lost."""
    conn = connect("gateway")
    conn.row_factory = dict_row
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            item = read_work_item(cur, item_id)
            if item is None:
                raise Denied(action, item_id, "no such work item")

            to = next_state(item["state"], action)
            ok = to is not None and can(actor, action, item)
            why = (
                "" if ok
                else f"state {item['state']} cannot {action}" if to is None
                else f"{actor.role} may not {action} (or separation of duties)"
            )

            before = _snapshot(item)
            after = dict(before)
            if ok:
                for k, v in (patch or {}).items():
                    if k in _PATCHABLE:
                        item[k] = v
                item["state"] = to
                after = _snapshot(item)

            # one transaction: the change (if allowed) + the audit row (always)
            if ok:
                sets, vals = [], []
                for k in (_PATCHABLE & set(patch or {})):
                    sets.append(f"{k} = %s")
                    vals.append(Json(patch[k]) if isinstance(patch[k], (dict, list)) else patch[k])
                sets.append("state = %s")
                vals.append(to)
                sets.append("updated_at = %s")
                vals.append(_now())
                vals.append(item_id)
                cur.execute(f"UPDATE work.work_item SET {', '.join(sets)} WHERE id = %s", vals)

            cur.execute(
                "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, diff, "
                "evidence, policy_id, policy_version) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (_now(), actor.id, action, item_id, ok, reason or why,
                 Json(_diff(before, after)),
                 Json(evidence if evidence is not None else item.get("evidence")),
                 (patch or {}).get("policy_id"), (patch or {}).get("policy_version")),
            )
        conn.commit()
    finally:
        conn.close()

    if not ok:
        raise Denied(action, item_id, why)  # logged, then raised — never lost
    return item


def create_work_item(actor: Actor, item_id: str, kind: str, subject_refs: dict,
                     *, reason: str = "") -> dict:
    """Create a NEW work item (the only non-transition write). Goes through the one
    door: `can(actor, 'create', ...)` must pass (only the sync role may create), and
    a NEW audit row is written in the same commit. Idempotent on item_id."""
    resource = {"kind": "work_item"}
    if not can(actor, "create", resource):
        # log the denied create, then raise
        conn = connect("gateway")
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason) "
                    "VALUES (%s,%s,'create',%s,false,%s)",
                    (_now(), actor.id, item_id, f"{actor.role} may not create work items"))
            conn.commit()
        finally:
            conn.close()
        raise Denied("create", item_id, f"{actor.role} may not create work items")

    conn = connect("gateway")
    conn.row_factory = dict_row
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT id FROM work.work_item WHERE id = %s", (item_id,))
            if cur.fetchone():
                cur.execute("SELECT * FROM work.work_item WHERE id = %s", (item_id,))
                return cur.fetchone()
            cur.execute(
                "INSERT INTO work.work_item (id, kind, state, subject_refs) "
                "VALUES (%s,%s,'NEW',%s)", (item_id, kind, Json(subject_refs)))
            cur.execute(
                "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, diff) "
                "VALUES (%s,%s,'create',%s,true,%s,%s)",
                (_now(), actor.id, item_id, reason or f"synced {kind}",
                 Json({"state": {"from": None, "to": "NEW"}})))
            conn.commit()
            cur.execute("SELECT * FROM work.work_item WHERE id = %s", (item_id,))
            return cur.fetchone()
    finally:
        conn.close()


def post(actor: Actor, item_id: str, *, journal_lines: list[dict] | None = None,
         period_id: str | None = None, mark_installment: str | None = None,
         reason: str = "") -> dict:
    """Gateway posts an APPROVED item to the record: flips it to POSTED, writes the
    journal entry, and marks the installment paid — all in the transition's commit
    discipline. Only actor.role == 'gateway' passes can('post')."""
    item = transition(actor, item_id, "post", reason=reason or "posted to record")
    if journal_lines or mark_installment:
        conn = connect("gateway")
        try:
            with conn.cursor() as cur:
                if journal_lines:
                    je_id = f"je-{item_id}"
                    cur.execute(
                        "INSERT INTO golden.journal_entry (id, period_id, lines, source_work_item, "
                        "posted_by) VALUES (%s,%s,%s,%s,'gateway') ON CONFLICT (id) DO NOTHING",
                        (je_id, period_id, Json(journal_lines), item_id))
                if mark_installment:
                    cur.execute(
                        "UPDATE golden.installment SET status = 'paid' WHERE id = %s",
                        (mark_installment,))
            conn.commit()
        finally:
            conn.close()
    return item


def audit_trail(subject: str) -> list[dict]:
    """"Why?" is one query. Returns every transition on a subject, denied ones too."""
    conn = connect("gateway")
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT at, actor, action, allowed, reason, diff, policy_id, policy_version "
                "FROM work.audit_log WHERE subject = %s ORDER BY at", (subject,))
            return cur.fetchall()
    finally:
        conn.close()
