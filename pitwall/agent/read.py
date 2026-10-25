"""Read-only facts the agent gathers. Runs as the `pitwall_agent` DB role — SELECT
on golden + work only; no journal writes, no payroll. These never mutate anything;
all writes go through the gateway (sow/gateway.py)."""

from __future__ import annotations

from datetime import date, datetime, timezone
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


def player(pid: str) -> dict | None:
    return _one("SELECT * FROM golden.player WHERE id = %s", (pid,))


def employment_clauses(player_id: str) -> list[dict]:
    """The player's EMPLOYMENT contract clauses (contract_type='player', keyed on the
    player id) — where a 'suspension & pay-withholding' right would live, if at all."""
    return _rows("SELECT * FROM golden.contract_clause WHERE contract_type='player' "
                 "AND contract_id=%s", (player_id,))


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


def qualifying_appearances(player_id: str, competitions: list[str], min_minutes: int = 45,
                           season: str | None = None) -> int:
    """MINUTE-ACCURATE: matches where the player actually played ≥ min_minutes, in the
    given competitions. This is what a loan-to-buy 'qualifying appearance' trigger needs
    — subbing a player on in the 89th minute does NOT count, so it can't be gamed."""
    comps = competitions or []
    params: list = [player_id, comps, min_minutes]
    sql = ("SELECT count(DISTINCT match_id) n FROM golden.match_event WHERE player_id=%s "
           "AND kind='minutes' AND competition = ANY(%s) AND value >= %s")
    if season:
        sql += " AND season=%s"
        params.append(season)
    r = _one(sql, tuple(params))
    return r["n"] if r else 0


def total_appearances(player_id: str, competitions: list[str] | None = None,
                      season: str | None = None) -> int:
    """All appearances regardless of minutes (to contrast with qualifying — exposes the
    89th-minute-sub gap)."""
    sql = "SELECT count(DISTINCT match_id) n FROM golden.match_event WHERE player_id=%s AND kind='appearance'"
    params: list = [player_id]
    if competitions:
        sql += " AND competition = ANY(%s)"
        params.append(competitions)
    if season:
        sql += " AND season=%s"
        params.append(season)
    r = _one(sql, tuple(params))
    return r["n"] if r else 0


def club_matches(season: str) -> int:
    """Total official matches the club played in a season (distinct match ids)."""
    r = _one("SELECT count(DISTINCT match_id) n FROM golden.match_event WHERE season=%s", (season,))
    return r["n"] if r else 0


def club_last_match(season: str) -> date | None:
    r = _one("SELECT max(event_time)::date d FROM golden.match_event WHERE season=%s", (season,))
    return (r and r["d"]) or None


def world_today() -> date:
    r = _one("SELECT max(txn_time)::date d FROM golden.bank_transaction")
    return (r and r["d"]) or datetime.now(timezone.utc).date()


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
