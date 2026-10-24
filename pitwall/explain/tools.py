"""Read-only tools the Explainer stands on. Every query runs as `voice_readonly`,
which has SELECT on work + golden and NO access to payroll_private. These are the
only ways the voice agent touches Tiger — it can never propose, approve, or post."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from psycopg.rows import dict_row

from ..db import connect

ROLE = "voice"  # -> pitwall voice_readonly Postgres role


def _rows(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    conn = connect(ROLE)
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        conn.close()


def _one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    rows = _rows(sql, params)
    return rows[0] if rows else None


def get_work_item(work_item_id: str) -> dict[str, Any] | None:
    return _one("SELECT * FROM work.work_item WHERE id = %s", (work_item_id,))


def audit_trail(subject: str, until: datetime | None = None) -> list[dict[str, Any]]:
    if until is None:
        return _rows(
            "SELECT at, actor, action, allowed, reason, diff, evidence, policy_id, policy_version "
            "FROM work.audit_log WHERE subject = %s ORDER BY at",
            (subject,),
        )
    return _rows(
        "SELECT at, actor, action, allowed, reason, diff, evidence, policy_id, policy_version "
        "FROM work.audit_log WHERE subject = %s AND at <= %s ORDER BY at",
        (subject, until),
    )


def x402_payments(work_item_id: str) -> list[dict[str, Any]]:
    return _rows(
        "SELECT at, tx_hash, network, seller, evidence_type, amount_usdc, response, simulated "
        "FROM work.x402_payment WHERE work_item_id = %s ORDER BY at",
        (work_item_id,),
    )


def policy(policy_id: str, version: int | None = None) -> dict[str, Any] | None:
    if version is None:
        return _one(
            "SELECT * FROM work.policy WHERE id = %s AND status='approved' "
            "ORDER BY version DESC LIMIT 1",
            (policy_id,),
        )
    return _one("SELECT * FROM work.policy WHERE id = %s AND version = %s", (policy_id, version))


def state_as_of(subject: str, t: datetime) -> str | None:
    row = _one("SELECT work.work_item_state_as_of(%s, %s) AS s", (subject, t))
    return row["s"] if row else None


def policy_version_as_of(policy_id: str, t: datetime) -> int | None:
    row = _one("SELECT work.policy_version_as_of(%s, %s) AS v", (policy_id, t))
    return row["v"] if row else None


# --- draws: content for the "build it live" canvas (all values tool-sourced) ---
def installment_history(installment_id: str) -> list[dict[str, Any]]:
    """All installments of the installment's transfer + the IBAN each was paid to."""
    tr = _one("SELECT transfer_id FROM golden.installment WHERE id = %s", (installment_id,))
    if not tr:
        return []
    return _rows(
        "SELECT i.seq, i.status, b.counterparty_iban "
        "FROM golden.installment i LEFT JOIN golden.bank_transaction b ON b.id = i.paid_txn_id "
        "WHERE i.transfer_id = %s ORDER BY i.seq",
        (tr["transfer_id"],),
    )


def fraud_ibans(installment_id: str, inbox_id: str) -> tuple[str | None, str | None]:
    """(counterparty's verified IBAN, the IBAN the suspicious email asked us to use)."""
    cp = _one(
        "SELECT c.verified_iban FROM golden.installment i "
        "JOIN golden.transfer t ON t.id = i.transfer_id "
        "JOIN golden.counterparty c ON c.id = t.counterparty_id WHERE i.id = %s",
        (installment_id,),
    )
    msg = _one("SELECT claims_new_iban FROM golden.inbox_message WHERE id = %s", (inbox_id,))
    return (cp["verified_iban"] if cp else None, msg["claims_new_iban"] if msg else None)
