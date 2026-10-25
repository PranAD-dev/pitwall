"""Deep accounting for the three squad-cost roles — wages, player bonuses, agent
fees — each with its full sub-ledger lifecycle, not a one-line expense.

  WAGES        accrue (player wages + coaching/staff wages → wages payable), then
               pay (wages payable → cash). Expense recognition is separated from
               cash settlement, and player vs staff is split because only first-team
               wages feed the Squad-Cost Ratio.

  BONUSES      accrue a staff-cost liability by type (appearance / goal) in the
               period the match trigger is met, then pay it (accrued bonus → cash).

  AGENT FEES   the GFC6 split: the club-service portion is CAPITALISED into the
               player registration (directly-attributable acquisition cost, IAS 38
               ¶27) with RECOVERABLE VAT; the player-service portion is EXPENSED as
               a benefit-in-kind with NON-recoverable VAT. The split is learned from
               history (pol-120) but — no default 50/50 under GFC6 — each is flagged
               for evidence.

Entries are posted through the engine (balanced to the cent) and the shallow
first-pass wage/bonus/agent entries are cleared first so the books aren't double-counted.
"""

from __future__ import annotations

from datetime import datetime

from psycopg.rows import dict_row

from ..db import connect
from . import coa
from .engine import Entry, cr, dr

VAT = 0.20  # UK VAT on agent services — recoverable on club-service, not on player


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    conn = connect("gateway")
    conn.row_factory = dict_row
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    except Exception:
        return []
    finally:
        conn.close()


def _ed(v):
    return v.date() if isinstance(v, datetime) else v


# --------------------------------------------------------------------------- #
# WAGES — accrue (player + staff) then pay
# --------------------------------------------------------------------------- #
def wage_entries() -> list[Entry]:
    out: list[Entry] = []
    for pr in _rows("SELECT pr.*, p.end_date FROM golden.payroll_run pr "
                    "LEFT JOIN golden.period p ON p.id=pr.period_id"):
        ccy = pr["currency"] or "EUR"
        player = float(pr["player_gross"] or 0)
        staff = float(pr["staff_gross"] or 0)
        total = round(player + staff, 2)
        if total <= 0:
            continue
        ed, per = _ed(pr.get("end_date")), pr["period_id"]
        out.append(Entry(
            id=f"je-wageaccr-{per}", kind="wages_accrue", currency=ccy, event_date=ed,
            period_id=per, memo=f"wages earned {per} (aggregate — no salary read)",
            lines=[dr(coa.WAGES_EXP, player, "first-team wages", ccy),
                   dr(coa.STAFF_WAGES_EXP, staff, "coaching & staff wages", ccy),
                   cr(coa.WAGES_PAYABLE, total, "wages payable", ccy)]))
        out.append(Entry(
            id=f"je-wagepay-{per}", kind="wages_pay", currency=ccy, event_date=ed,
            period_id=per, memo=f"wages paid {per}",
            lines=[dr(coa.WAGES_PAYABLE, total, "settle wages payable", ccy),
                   cr(coa.CASH, total, "cash out", ccy)]))
    return out


# --------------------------------------------------------------------------- #
# BONUSES — accrue by type when earned, then pay
# --------------------------------------------------------------------------- #
def bonus_entries() -> list[Entry]:
    out: list[Entry] = []
    for pr in _rows("SELECT pr.*, p.end_date FROM golden.payroll_run pr "
                    "LEFT JOIN golden.period p ON p.id=pr.period_id"):
        ccy = pr["currency"] or "EUR"
        appr = float(pr["earned_appearance_bonus"] or 0)
        goal = float(pr["earned_goal_bonus"] or 0)
        total = round(appr + goal, 2)
        if total <= 0:
            continue
        ed, per = _ed(pr.get("end_date")), pr["period_id"]
        lines = []
        if appr:
            lines.append(dr(coa.BONUS_EXP, appr, "appearance bonuses earned", ccy))
        if goal:
            lines.append(dr(coa.BONUS_EXP, goal, "goal bonuses earned", ccy))
        lines.append(cr(coa.ACCRUED_BONUS, total, "accrued player bonuses", ccy))
        out.append(Entry(id=f"je-bonusaccr-{per}", kind="bonus_accrue", currency=ccy,
                         event_date=ed, period_id=per,
                         memo=f"player bonuses earned {per} (match-triggered)", lines=lines))
        out.append(Entry(id=f"je-bonuspay-{per}", kind="bonus_pay", currency=ccy,
                         event_date=ed, period_id=per, memo=f"player bonuses paid {per}",
                         lines=[dr(coa.ACCRUED_BONUS, total, "settle accrued bonuses", ccy),
                                cr(coa.CASH, total, "cash out", ccy)]))
    return out


# --------------------------------------------------------------------------- #
# AGENT FEES — the GFC6 split (club-service capitalised, player-service expensed)
# --------------------------------------------------------------------------- #
def learned_split() -> tuple[float, float]:
    """The club/player split the agent LEARNED from history (pol-120), as fractions.
    Falls back to 30/70 if no precedent. GFC6: this is a learned default, not a rule —
    each fee should still be evidenced."""
    r = _rows("SELECT round(avg((handled_as->>'club_pct')::numeric),1) c, "
              "round(avg((handled_as->>'player_pct')::numeric),1) p "
              "FROM golden.historical_outcome WHERE situation='agent_fee_split'")
    if r and r[0]["c"] is not None:
        c = float(r[0]["c"]); p = float(r[0]["p"])
        if c + p > 0:
            return c / (c + p), p / (c + p)
    return 0.30, 0.70


def agent_fee_entries() -> list[Entry]:
    club_f, player_f = learned_split()
    out: list[Entry] = []
    for iv in _rows("SELECT * FROM golden.invoice WHERE kind='agent_fee' "
                    "AND status IN ('paid','accepted','received')"):
        ccy, net = iv["currency"], float(iv["amount"])
        club_net = round(net * club_f, 2)
        player_net = round(net * player_f, 2)
        club_vat = round(club_net * VAT, 2)                 # recoverable
        player_gross = round(player_net * (1 + VAT), 2)     # VAT non-recoverable → in expense
        ap = round(club_net + club_vat + player_gross, 2)   # what we owe the agent
        out.append(Entry(
            id=f"je-agfee-{iv['id']}", kind="agent_fee_split", currency=ccy,
            event_date=_ed(iv["issued_at"]), source_ref=iv["id"],
            memo=f"agent fee {iv.get('number') or iv['id']} · GFC6 split "
                 f"{club_f*100:.0f}% club / {player_f*100:.0f}% player (learned — evidence each)",
            lines=[dr(coa.REGISTRATIONS, club_net, "club-service: capitalise into registration", ccy),
                   dr(coa.VAT_RECOVERABLE, club_vat, "recoverable VAT on club-service", ccy),
                   dr(coa.AGENT_EXP, player_gross, "player-service: expense (BIK, VAT incl.)", ccy),
                   cr(coa.AP, ap, "owed to agent", ccy)]))
    return out


# --------------------------------------------------------------------------- #
# orchestration
# --------------------------------------------------------------------------- #
def clear_shallow() -> int:
    """Remove the first-pass one-line wage/bonus/agent entries so the deep set
    doesn't double-count (superuser — journal_entry isn't append-only)."""
    conn = connect("superuser")
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM golden.journal_entry WHERE kind IN "
                        "('wages','bonus_accrual','agent_fee')")
            n = cur.rowcount
        conn.commit()
        return n
    finally:
        conn.close()


def all_entries() -> list[Entry]:
    return wage_entries() + bonus_entries() + agent_fee_entries()
