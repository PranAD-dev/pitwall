"""Read-only facts the agent gathers. Runs as the `pitwall_agent` DB role — SELECT
on golden + work only; no journal writes, no payroll. These never mutate anything;
all writes go through the gateway (sow/gateway.py)."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any

from psycopg.rows import dict_row

from ..db import connect

ROLE = "agent"


def _rows(sql: str, params: tuple = ()) -> list[dict[str, Any]]:
    conn = connect(ROLE)
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        conn.close()


def _one(sql: str, params: tuple = ()) -> dict[str, Any] | None:
    r = _rows(sql, params)
    return r[0] if r else None


def installment(iid: str) -> dict | None:
    return _one("SELECT * FROM golden.installment WHERE id = %s", (iid,))


def transfer(tid: str) -> dict | None:
    return _one("SELECT * FROM golden.transfer WHERE id = %s", (tid,))


def counterparty(cid: str) -> dict | None:
    return _one("SELECT * FROM golden.counterparty WHERE id = %s", (cid,))


def inbox_for_installment(iid: str) -> dict | None:
    return _one("SELECT * FROM golden.inbox_message WHERE about_installment_id = %s", (iid,))


def bank_txn(bid: str) -> dict | None:
    return _one("SELECT * FROM golden.bank_transaction WHERE id = %s", (bid,))


def inbox(mid: str) -> dict | None:
    return _one("SELECT * FROM golden.inbox_message WHERE id = %s", (mid,))


def paid_count(transfer_id: str) -> int:
    r = _one("SELECT count(*) n FROM golden.installment WHERE transfer_id=%s AND status='paid'",
             (transfer_id,))
    return r["n"] if r else 0


def clause(clid: str) -> dict | None:
    return _one("SELECT * FROM golden.contract_clause WHERE id = %s", (clid,))


def invoice(iid: str) -> dict | None:
    return _one("SELECT * FROM golden.invoice WHERE id = %s", (iid,))


def appearances(player_id: str, competition: str, until: date | None = None) -> int:
    """Official appearance count for a player in a competition (optionally as of a date)."""
    if until is None:
        r = _one("SELECT count(*) n FROM golden.match_event WHERE player_id=%s AND competition=%s "
                 "AND kind='appearance'", (player_id, competition))
    else:
        r = _one("SELECT count(*) n FROM golden.match_event WHERE player_id=%s AND competition=%s "
                 "AND kind='appearance' AND event_time <= %s", (player_id, competition, until))
    return r["n"] if r else 0


def fx_rate(pair: str, at: datetime) -> float | None:
    r = _one("SELECT rate FROM golden.fx_rate WHERE pair=%s AND at <= %s ORDER BY at DESC LIMIT 1",
             (pair, at))
    return float(r["rate"]) if r else None


def period_status(d: date) -> str | None:
    r = _one("SELECT status FROM golden.period WHERE %s BETWEEN start_date AND end_date", (d,))
    return r["status"] if r else None


def invoices_for_transfer(transfer_id: str, kind: str | None = None) -> list[dict]:
    if kind:
        return _rows("SELECT * FROM golden.invoice WHERE transfer_id=%s AND kind=%s ORDER BY issued_at",
                     (transfer_id, kind))
    return _rows("SELECT * FROM golden.invoice WHERE transfer_id=%s ORDER BY issued_at", (transfer_id,))


def history(situation: str | None = None) -> list[dict]:
    """The 12-month corpus of how past humans handled things (self-learning)."""
    if situation:
        return _rows("SELECT * FROM golden.historical_outcome WHERE situation=%s", (situation,))
    return _rows("SELECT * FROM golden.historical_outcome")


def history_counts() -> list[dict]:
    return _rows("SELECT situation, count(*) n FROM golden.historical_outcome GROUP BY situation "
                 "ORDER BY n DESC")
