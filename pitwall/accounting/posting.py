"""Posting rules — the accounting policy for a football club, one balanced entry per
economic event, read from the system of record (golden.*).

`build_books()` walks the records and posts the whole general ledger: it turns raw
transfers / installments / sponsor deals / invoices into capitalised assets,
amortisation, disposals with gain/loss, cash, receivables, payables and revenue —
a trial balance that ties out. Idempotent: re-running posts nothing new.

The planted anomalies (short pays, duplicates, fraud holds) are NOT force-booked
here — those are the agent's per-case decisions, which *choose* which entry to post
(or to hold). This pass lays down the clean baseline the agent works on top of.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from psycopg.rows import dict_row

from ..db import connect
from . import coa
from .engine import Entry, cr, dr, post_many


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


def _world_today() -> date:
    r = _rows("SELECT max(txn_time)::date d FROM golden.bank_transaction")
    return (r and r[0]["d"]) or datetime.now(timezone.utc).date()


def _months_between(a: date, b) -> int:
    """whole months from a → b (b may be date/datetime), floored at 0."""
    if b is None:
        return 0
    bd = b.date() if isinstance(b, datetime) else b
    return max(0, (bd.year - a.year) * 12 + (bd.month - a.month))


def _ed(v):
    return v.date() if isinstance(v, datetime) else v


# --------------------------------------------------------------------------- #
# builders — each returns a balanced Entry (or None)
# --------------------------------------------------------------------------- #
def build_books() -> dict:
    """Read the SoR and post the full general ledger. Returns a summary."""
    today = _world_today()
    entries: list[Entry] = []

    # refresh the authorized payroll aggregate first (privileged; reads the sealed
    # salaries, writes only the per-period total the books are allowed to see)
    try:
        from .payroll import run_payroll

        run_payroll()
    except Exception:
        pass

    transfers = _rows("SELECT * FROM golden.transfer")
    tx_by_id = {t["id"]: t for t in transfers}
    # player_id -> their most recent IN purchase (for derecognition on sale)
    in_by_player: dict[str, dict] = {}
    for t in transfers:
        if t["direction"] == "in" and t.get("player_id"):
            in_by_player.setdefault(t["player_id"], t)

    # A) capitalise purchases + C) cumulative amortisation to date
    for t in transfers:
        if t["direction"] != "in":
            continue
        ccy, fee = t["currency"], float(t["fee"])
        entries.append(Entry(
            id=f"je-cap-{t['id']}", kind="capitalize", currency=ccy, event_date=_ed(t["signed_at"]),
            source_ref=t["id"], memo=f"capitalise registration · {t['id']}",
            lines=[dr(coa.REGISTRATIONS, fee, "player registration", ccy),
                   cr(coa.AP, fee, "transfer payable", ccy)]))
        months = t.get("amortization_months") or (int(t.get("contract_years") or 3) * 12)
        elapsed = min(_months_between(_ed(t["signed_at"]) or today, today), months)
        if months and elapsed > 0:
            amt = round(fee * elapsed / months, 2)
            entries.append(Entry(
                id=f"je-amort-{t['id']}", kind="amortise", currency=ccy, event_date=today,
                source_ref=t["id"], memo=f"amortisation to date · {elapsed}/{months} months",
                lines=[dr(coa.AMORT_EXP, amt, "amortisation expense", ccy),
                       cr(coa.ACCUM_AMORT, amt, "accumulated amortisation", ccy)]))

    # E) disposals (sales): derecognise book value, book gain/loss
    for t in transfers:
        if t["direction"] != "out":
            continue
        ccy, fee = t["currency"], float(t["fee"])
        orig = in_by_player.get(t.get("player_id"))
        cost = accum = 0.0
        if orig and orig["currency"] == ccy:  # same-currency derecognition only
            cost = float(orig["fee"])
            m = orig.get("amortization_months") or (int(orig.get("contract_years") or 3) * 12)
            el = min(_months_between(_ed(orig["signed_at"]) or today,
                                     _ed(t["signed_at"]) or today), m)
            accum = round(cost * el / m, 2) if m else 0.0
        nbv = round(cost - accum, 2)
        gain = round(fee - nbv, 2)
        lines = [dr(coa.AR, fee, "receivable from buying club", ccy)]
        if accum:
            lines.append(dr(coa.ACCUM_AMORT, accum, "remove accumulated amortisation", ccy))
        if cost:
            lines.append(cr(coa.REGISTRATIONS, cost, "derecognise registration at cost", ccy))
        if gain >= 0:
            lines.append(cr(coa.DISPOSAL_GAIN, gain, "profit on disposal (net transfer income)", ccy))
        else:
            lines.append(dr(coa.DISPOSAL_LOSS, -gain, "loss on disposal", ccy))
        entries.append(Entry(id=f"je-disp-{t['id']}", kind="disposal", currency=ccy,
                             event_date=_ed(t["signed_at"]), source_ref=t["id"],
                             memo=f"sale of {t.get('player_id')} · gain {gain:,.0f} {ccy}",
                             lines=lines))

    # B) pay installments (purchases) · D) collect installments (sales), where paid
    insts = _rows("SELECT i.*, t.direction FROM golden.installment i "
                  "JOIN golden.transfer t ON t.id=i.transfer_id WHERE i.status='paid'")
    for i in insts:
        ccy, amt = i["currency"], float(i["amount"])
        if i["direction"] == "in":   # we bought → paying the selling club
            entries.append(Entry(id=f"je-pay-{i['id']}", kind="pay_installment", currency=ccy,
                                 event_date=_ed(i["due_date"]), source_ref=i["id"],
                                 memo=f"pay installment {i['id']}",
                                 lines=[dr(coa.AP, amt, "settle transfer payable", ccy),
                                        cr(coa.CASH, amt, "cash out", ccy)]))
        else:                        # we sold → collecting from the buyer
            entries.append(Entry(id=f"je-collect-{i['id']}", kind="collect", currency=ccy,
                                 event_date=_ed(i["due_date"]), source_ref=i["id"],
                                 memo=f"collect receivable {i['id']}",
                                 lines=[dr(coa.CASH, amt, "cash in", ccy),
                                        cr(coa.AR, amt, "clear receivable", ccy)]))

    # F) sponsor deferred revenue + G) recognition to date
    for s in _rows("SELECT * FROM golden.sponsor_contract WHERE base_amount IS NOT NULL"):
        ccy, base = s["currency"] or "EUR", float(s["base_amount"])
        entries.append(Entry(id=f"je-spon-{s['id']}", kind="sponsor_cash", currency=ccy,
                             source_ref=s["id"], memo=f"sponsor prepayment · {s['id']}",
                             lines=[dr(coa.CASH, base, "sponsor cash received", ccy),
                                    cr(coa.DEFERRED_REV, base, "deferred sponsorship revenue", ccy)]))
        # recognise 100% to date (season assumed elapsed in this snapshot world)
        entries.append(Entry(id=f"je-sponrec-{s['id']}", kind="sponsor_recognise", currency=ccy,
                             event_date=today, source_ref=s["id"],
                             memo=f"recognise sponsorship revenue · {s['id']}",
                             lines=[dr(coa.DEFERRED_REV, base, "release deferred revenue", ccy),
                                    cr(coa.SPONSOR_REV, base, "sponsorship revenue earned", ccy)]))

    # H) matchday revenue (aggregate per currency, if the table exists)
    md = _rows("SELECT currency, coalesce(sum(gross),0) g FROM golden.ticket_sale GROUP BY currency")
    for m in md:
        g = float(m["g"] or 0)
        if g:
            entries.append(Entry(id=f"je-matchday-{m['currency']}", kind="matchday",
                                 currency=m["currency"], event_date=today, memo="matchday revenue",
                                 lines=[dr(coa.CASH, g, "gate + season cash", m["currency"]),
                                        cr(coa.MATCHDAY_REV, g, "matchday revenue", m["currency"])]))

    # I+J) the three squad-cost roles, deep — wages (accrue+pay, player/staff split),
    # bonuses (accrue by type + pay), agent fees (GFC6 club/player split). The shallow
    # first-pass entries are cleared so we don't double-count.
    from . import squad_cost

    squad_cost.clear_shallow()
    entries += squad_cost.all_entries()

    res = post_many(entries)
    # tally by kind for the summary
    by_kind: dict[str, int] = {}
    for e in entries:
        by_kind[e.kind] = by_kind.get(e.kind, 0) + 1
    res["by_kind"] = by_kind
    return res
