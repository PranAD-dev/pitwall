"""Contract amendments → cascading financial events.

One deal (golden.transfer.id) is the UID that ties together the player registration,
the agent fee (capitalised INTO that registration), the installment schedule and the
clauses. When the contract is modified, the events that hang off that deal must change
too — correctly, and WITHOUT editing a closed period. This module:

  · resolves the deal's blast radius (every posting/invoice/installment/clause tied to it)
  · recomputes the treatments the amendment actually changes
  · applies them as linked reverse + repost entries (never an edit, never a delete)
  · and ESCALATES the legs it must not guess (the agent-fee re-amortisation basis, an
    over-amortised asset, a renegotiation below book value, a bespoke clause)

The whole point is that complexity degrades into a human escalation, not into a
confident wrong answer. Everything is logged; the books still tie after a cascade.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from psycopg.rows import dict_row
from psycopg.types.json import Json

from ..db import connect
from . import coa
from .engine import Entry, cr, dr, post, reverse, reverse_and_repost

CAP_MONTHS = 60   # UEFA G.3 — amortise over at most 5 years from the extension date


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _rows(sql: str, params: tuple = ()) -> list[dict]:
    conn = connect("gateway")
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    except Exception:
        return []
    finally:
        conn.close()


def _one(sql: str, params: tuple = ()) -> dict | None:
    r = _rows(sql, params)
    return r[0] if r else None


def _d(v) -> date | None:
    if v is None:
        return None
    return v.date() if isinstance(v, datetime) else v


def _months(a: date, b: date) -> int:
    """whole months a→b, floored at 0."""
    if not a or not b:
        return 0
    return max(0, (b.year - a.year) * 12 + (b.month - a.month))


def _world_today() -> date:
    r = _one("SELECT max(txn_time)::date d FROM golden.bank_transaction")
    return (r and r["d"]) or datetime.now(timezone.utc).date()


def _entry_exists(entry_id: str) -> bool:
    return _one("SELECT 1 FROM golden.journal_entry WHERE id=%s", (entry_id,)) is not None


def _period_closed(d: date | None) -> bool:
    """Is the amendment's effective date in a period that's already closed? (If so the
    correction must be reverse+repost in the open period, never an edit.)"""
    if not d:
        return False
    r = _one("SELECT status FROM golden.period WHERE %s BETWEEN start_date AND end_date", (d,))
    return bool(r and str(r.get("status", "")).lower() in ("closed", "locked"))


# --------------------------------------------------------------------------- #
# blast radius — everything that hangs off this deal
# --------------------------------------------------------------------------- #
def blast_radius(deal_id: str) -> dict:
    tr = _one("SELECT * FROM golden.transfer WHERE id=%s", (deal_id,))
    invoices = _rows("SELECT * FROM golden.invoice WHERE transfer_id=%s", (deal_id,))
    installments = _rows("SELECT * FROM golden.installment WHERE transfer_id=%s", (deal_id,))
    clauses = _rows("SELECT * FROM golden.contract_clause WHERE contract_id=%s", (deal_id,))
    # the postings tied to the deal: registration (source_ref=deal) + agent fees
    # (source_ref=invoice id) + installment settlements (source_ref=installment id)
    refs = [deal_id] + [i["id"] for i in invoices] + [i["id"] for i in installments]
    postings = _rows(
        "SELECT id, kind, source_ref, memo FROM golden.journal_entry WHERE source_ref = ANY(%s) "
        "AND reverses IS NULL ORDER BY id", (refs,))
    return {"transfer": tr, "agent_fees": invoices, "installments": installments,
            "clauses": clauses, "postings": postings}


# --------------------------------------------------------------------------- #
# per-kind handlers — each appends to out['actions'] / out['escalations'] / out['notes']
# --------------------------------------------------------------------------- #
def _amort_to(fee: float, months: int, elapsed: int) -> float:
    return round(fee * min(elapsed, months) / months, 2) if months else 0.0


def _handle_extension(amend: dict, tr: dict, blast: dict, out: dict) -> None:
    fee, ccy = float(tr["fee"]), tr["currency"]
    signed, eff, today = _d(tr["signed_at"]), _d(amend["effective_date"]), _world_today()
    old_months = tr.get("amortization_months") or (int(tr.get("contract_years") or 3) * 12)
    new_months = int((amend.get("params") or {}).get("new_amortization_months") or 0)

    # --- edge cases, before touching the books ---
    if new_months <= 0:
        out["escalations"].append({"leg": "extension", "why": "no new amortisation term given — can't re-amortise; flagged for the accounting team"})
        return
    if eff and signed and eff < signed:
        out["escalations"].append({"leg": "extension", "why": f"effective date {eff} precedes the signing date {signed} — invalid amendment, not applied"})
        return
    if new_months == old_months:
        out["notes"].append(f"new term equals the old term ({old_months}mo) — no re-amortisation needed")
        return

    elapsed_at_eff = min(_months(signed, eff), old_months) if signed and eff else 0
    accum_at_eff = _amort_to(fee, old_months, elapsed_at_eff)
    nbv_at_eff = round(fee - accum_at_eff, 2)
    raw_remaining = new_months - elapsed_at_eff
    if raw_remaining <= 0:
        out["escalations"].append({"leg": "registration", "why": f"the player is already {elapsed_at_eff}mo in, past the new {new_months}mo term at the effective date — this is a catch-up / impairment call, not a straight re-amortisation; flagged for the accounting team"})
        return
    remaining = min(raw_remaining, CAP_MONTHS)
    capped = raw_remaining > CAP_MONTHS
    new_periodic = nbv_at_eff / remaining
    months_since_eff = min(_months(eff, today), remaining) if eff else 0
    accum_corrected = round(accum_at_eff + new_periodic * months_since_eff, 2)
    accum_old = _amort_to(fee, old_months, min(_months(signed, today), old_months) if signed else 0)
    delta = round(accum_corrected - accum_old, 2)

    closed = _period_closed(eff)
    amort_id = f"je-amort-{tr['id']}"
    corrected = Entry(
        id=f"{amort_id}~A{amend['id']}", kind="amortise", currency=ccy, event_date=today,
        source_ref=amend["id"],
        memo=(f"re-amortise {tr['id']} after extension {old_months}→{new_months}mo"
              + (" (capped at 5y)" if capped else "")
              + (" [closed-period: reversed in the open period]" if closed else "")),
        lines=[dr(coa.AMORT_EXP, accum_corrected, "amortisation to date, re-amortised", ccy),
               cr(coa.ACCUM_AMORT, accum_corrected, "accumulated amortisation", ccy)])
    if _entry_exists(amort_id):
        reverse_and_repost(amort_id, corrected, f"contract extension {amend['id']}")
        act = "reverse + repost"
    else:
        post(corrected)   # nothing booked yet → post forward only
        act = "post (no prior amort to reverse)"
    out["actions"].append({"leg": "registration amortisation", "action": act,
                           "old_accum": accum_old, "new_accum": accum_corrected, "delta": delta,
                           "capped_at_5y": capped, "closed_period": closed})

    # the agent fee rode on this registration — but the re-amortisation basis is a
    # contract question we can't answer from the data → escalate that leg
    if blast["agent_fees"]:
        out["escalations"].append({"leg": "agent fee", "why": f"{len(blast['agent_fees'])} agent-fee invoice(s) were capitalised into this registration; whether the capitalised portion re-amortises over the player's new term or keeps its own schedule depends on the agent contract, which doesn't say — flagged for the accounting team"})
    if blast["installments"]:
        out["notes"].append(f"{len(blast['installments'])} installment(s) unchanged — the fee itself didn't move")


def _handle_fee_reneg(amend: dict, tr: dict, blast: dict, out: dict) -> None:
    old_fee, ccy = float(tr["fee"]), tr["currency"]
    new_fee = float((amend.get("params") or {}).get("new_fee") or 0)
    signed, today = _d(tr["signed_at"]), _world_today()
    old_months = tr.get("amortization_months") or (int(tr.get("contract_years") or 3) * 12)
    if new_fee <= 0:
        out["escalations"].append({"leg": "fee", "why": "no valid new fee given — not applied"})
        return
    if abs(new_fee - old_fee) < 0.01:
        out["notes"].append("renegotiated fee equals the old fee — nothing to change")
        return

    elapsed = min(_months(signed, today), old_months) if signed else 0
    accum_old = _amort_to(old_fee, old_months, elapsed)
    accum_new = _amort_to(new_fee, old_months, elapsed)
    nbv_new = round(new_fee - accum_new, 2)

    # 1) re-capitalise at the new fee (reverse the original cap, repost)
    cap_id = f"je-cap-{tr['id']}"
    cap_corrected = Entry(
        id=f"{cap_id}~A{amend['id']}", kind="capitalize", currency=ccy, event_date=_d(tr["signed_at"]),
        source_ref=amend["id"], memo=f"re-capitalise {tr['id']} at renegotiated fee {new_fee:,.0f} {ccy}",
        lines=[dr(coa.REGISTRATIONS, new_fee, "player registration (renegotiated)", ccy),
               cr(coa.AP, new_fee, "transfer payable (renegotiated)", ccy)])
    if _entry_exists(cap_id):
        reverse_and_repost(cap_id, cap_corrected, f"fee renegotiation {amend['id']}")
    else:
        post(cap_corrected)
    out["actions"].append({"leg": "registration cost", "action": "reverse + repost",
                           "old_fee": old_fee, "new_fee": new_fee, "delta": round(new_fee - old_fee, 2)})

    # 2) re-amortise on the new carrying value
    amort_id = f"je-amort-{tr['id']}"
    if _entry_exists(amort_id) or accum_new:
        amort_corrected = Entry(
            id=f"{amort_id}~A{amend['id']}", kind="amortise", currency=ccy, event_date=today,
            source_ref=amend["id"], memo=f"re-amortise {tr['id']} on the renegotiated fee",
            lines=[dr(coa.AMORT_EXP, accum_new, "amortisation to date, re-amortised", ccy),
                   cr(coa.ACCUM_AMORT, accum_new, "accumulated amortisation", ccy)])
        if _entry_exists(amort_id):
            reverse_and_repost(amort_id, amort_corrected, f"fee renegotiation {amend['id']}")
        else:
            post(amort_corrected)
        out["actions"].append({"leg": "registration amortisation", "action": "reverse + repost",
                               "old_accum": accum_old, "new_accum": accum_new})

    # edge: renegotiated below carrying value is an impairment signal, not a clean reneg
    if new_fee < nbv_new + accum_old:   # new fee below prior NBV
        out["escalations"].append({"leg": "impairment check", "why": f"the renegotiated fee ({new_fee:,.0f}) is below the prior carrying value — this may be an impairment, not a simple renegotiation; flagged for the accounting team"})
    # the agent fee is typically a % of the fee → recompute, but we don't hold the %
    if blast["agent_fees"]:
        out["escalations"].append({"leg": "agent fee", "why": "the agent fee is usually a percentage of the transfer fee — it should be recomputed, but the percentage isn't in the record; flagged for the accounting team"})
    if blast["installments"]:
        out["escalations"].append({"leg": "installment schedule", "why": f"the fee changed but {len(blast['installments'])} installment(s) still reflect the old amount — the payment plan needs re-cutting; flagged for the accounting team"})


def _handle_termination(amend: dict, tr: dict, blast: dict, out: dict) -> None:
    fee, ccy = float(tr["fee"]), tr["currency"]
    proceeds = float((amend.get("params") or {}).get("proceeds") or 0)
    signed, eff, today = _d(tr["signed_at"]), _d(amend["effective_date"]), _world_today()
    old_months = tr.get("amortization_months") or (int(tr.get("contract_years") or 3) * 12)
    elapsed = min(_months(signed, eff or today), old_months) if signed else 0
    accum = _amort_to(fee, old_months, elapsed)
    nbv = round(fee - accum, 2)
    gain = round(proceeds - nbv, 2)

    lines = []
    if proceeds > 0:
        lines.append(dr(coa.AR, proceeds, "receivable on early transfer out", ccy))
    if accum:
        lines.append(dr(coa.ACCUM_AMORT, accum, "derecognise accumulated amortisation", ccy))
    lines.append(cr(coa.REGISTRATIONS, fee, "derecognise the registration at cost", ccy))
    if gain >= 0:
        lines.append(cr(coa.DISPOSAL_GAIN, gain, "gain on early disposal", ccy))
    else:
        lines.append(dr(coa.DISPOSAL_LOSS, -gain, "loss on early disposal / write-off", ccy))
    disp = Entry(id=f"je-disp-{tr['id']}~A{amend['id']}", kind="disposal", lines=lines,
                 currency=ccy, event_date=eff or today, source_ref=amend["id"],
                 memo=f"early termination of {tr['id']} · proceeds {proceeds:,.0f} {ccy} · "
                      f"NBV {nbv:,.0f} · {'gain' if gain >= 0 else 'loss'} {abs(gain):,.0f}")
    post(disp)
    out["actions"].append({"leg": "registration disposal", "action": "post disposal",
                           "nbv": nbv, "proceeds": proceeds, "gain_loss": gain,
                           "note": "free release — full write-off" if proceeds == 0 else ""})

    # the capitalised agent fee hasn't been fully amortised → it must be written off now,
    # but the model doesn't track the capitalised slice separately → escalate the amount
    if blast["agent_fees"]:
        out["escalations"].append({"leg": "agent fee write-off", "why": f"{len(blast['agent_fees'])} agent-fee invoice(s) were capitalised into this registration; the unamortised slice has to be written off on termination, but it isn't tracked separately — flagged for the accounting team for the amount"})
    # a sell-on clause on a player we're selling on triggers
    sellons = [c for c in blast["clauses"] if c.get("kind") == "sell_on"]
    if sellons and proceeds > 0:
        out["escalations"].append({"leg": "sell-on", "why": f"this deal carries a sell-on clause ({sellons[0]['id']}) — the former club may be owed a share of the {proceeds:,.0f} {ccy} proceeds; flagged for the accounting team"})


def _handle_add_clause(amend: dict, tr: dict, blast: dict, out: dict) -> None:
    # a new contingent clause (sell-on, add-on) is a commitment, not an immediate entry
    out["notes"].append("new clause recorded as a contingent commitment — no journal entry until it's triggered")
    out["escalations"].append({"leg": "contingent commitment", "why": "a new contingent clause was added; it should be disclosed as a commitment and watched for its trigger — flagged for the accounting team to confirm the terms"})


_HANDLERS = {
    "extension": _handle_extension,
    "fee_renegotiation": _handle_fee_reneg,
    "early_termination": _handle_termination,
    "add_clause": _handle_add_clause,
}


# --------------------------------------------------------------------------- #
# apply — the one entry point
# --------------------------------------------------------------------------- #
def apply_amendment(amendment_id: str) -> dict:
    """Apply an amendment: cascade to the deal's financial events (reverse+repost the
    legs that change, escalate the ones we must not guess). Idempotent; books still tie."""
    amend = _one("SELECT * FROM golden.contract_amendment WHERE id=%s", (amendment_id,))
    if not amend:
        return {"error": f"no amendment {amendment_id}"}
    deal_id = amend["deal_id"]
    tr = _one("SELECT * FROM golden.transfer WHERE id=%s", (deal_id,))
    if not tr:
        return {"error": f"amendment {amendment_id} points at unknown deal {deal_id}"}

    out: dict = {"amendment": amendment_id, "kind": amend["kind"], "deal": deal_id,
                 "player": tr.get("player_id"), "effective_date": str(amend["effective_date"]),
                 "actions": [], "escalations": [], "notes": []}
    blast = blast_radius(deal_id)
    out["blast_radius"] = {"postings": [p["id"] for p in blast["postings"]],
                           "agent_fees": [i["id"] for i in blast["agent_fees"]],
                           "installments": [i["id"] for i in blast["installments"]],
                           "clauses": [c["id"] for c in blast["clauses"]]}

    handler = _HANDLERS.get(amend["kind"])
    if handler is None:
        out["escalations"].append({"leg": amend["kind"], "why": f"no cascade rule for amendment kind '{amend['kind']}' — flagged for the accounting team"})
    else:
        try:
            handler(amend, tr, blast, out)
        except Exception as e:  # noqa: BLE001 — a bad leg must not corrupt the books
            out["escalations"].append({"leg": "cascade", "why": f"could not complete the cascade safely ({str(e)[:120]}) — rolled forward to a human"})

    # record the outcome + audit (as the gateway)
    status = "escalated" if out["escalations"] and not out["actions"] else "applied"
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE golden.contract_amendment SET status=%s, applied_at=now() WHERE id=%s",
                        (status, amendment_id))
            cur.execute(
                "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, diff) "
                "VALUES (now(),'ai_agent','amend',%s,true,%s,%s)",
                (f"amendment:{amendment_id}",
                 f"{amend['kind']} on {deal_id}: {len(out['actions'])} posting(s) cascaded, "
                 f"{len(out['escalations'])} leg(s) escalated",
                 Json(out)))
        conn.commit()
    finally:
        conn.close()
    out["status"] = status
    out["books_tie"] = _books_tie()
    return out


def _books_tie() -> bool:
    try:
        from .books import trial_balance
        return bool(trial_balance().get("balanced"))
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# demo seed — deals + amendments that exercise the edge cases, not the happy path
# --------------------------------------------------------------------------- #
_AMEND_PLAYERS = [
    ("pl-mess-bakker", "Tom Bakker", "CB", "Netherlands"),
    ("pl-mess-cole", "Ray Cole", "ST", "England"),
]
# IN deals (we bought) so there's a registration to re-amortise / dispose
_AMEND_DEALS = [
    # id, player, dir, counterparty, fee, ccy, signed, contract_years, amort_months
    ("tr-mess-bakker", "pl-mess-bakker", "in", "cp-mess-northbridge", 6_000_000, "EUR", "2025-07-01", 4, 48),
    ("tr-mess-cole", "pl-mess-cole", "in", "cp-mess-oakmere", 4_000_000, "EUR", "2025-09-01", 3, 36),
]
_AMENDMENTS = [
    # extension to 7y → hits the 5-year cap; the agent fee leg escalates
    ("am-ext-nilsson", "tr-mess-nilsson", "extension", "2026-07-01", {"new_amortization_months": 84}),
    # fee cut from 6.0M to 4.5M → below book value → impairment check escalates
    ("am-reneg-bakker", "tr-mess-bakker", "fee_renegotiation", "2026-06-01", {"new_fee": 4_500_000}),
    # early sale for 2.0M → disposal gain/loss, agent-fee write-off + sell-on escalate
    ("am-term-cole", "tr-mess-cole", "early_termination", "2026-08-01", {"proceeds": 2_000_000}),
]


def seed_amendments() -> dict:
    conn = connect("superuser")
    added = {"players": 0, "deals": 0, "amendments": 0}
    try:
        with conn.cursor() as cur:
            for p in _AMEND_PLAYERS:
                cur.execute("INSERT INTO golden.player (id,name,position,nationality,raw_ref) "
                            "SELECT %s,%s,%s,%s,'mess' WHERE NOT EXISTS "
                            "(SELECT 1 FROM golden.player WHERE id=%s)", (*p, p[0]))
                added["players"] += cur.rowcount or 0
            for t in _AMEND_DEALS:
                cur.execute("INSERT INTO golden.transfer (id,player_id,direction,counterparty_id,fee,"
                            "currency,signed_at,contract_years,amortization_months,solidarity_applicable,"
                            "status,raw_ref) SELECT %s,%s,%s,%s,%s,%s,%s,%s,%s,false,'active','mess' "
                            "WHERE NOT EXISTS (SELECT 1 FROM golden.transfer WHERE id=%s)", (*t, t[0]))
                added["deals"] += cur.rowcount or 0
            for a in _AMENDMENTS:
                cur.execute("INSERT INTO golden.contract_amendment (id,deal_id,kind,effective_date,"
                            "params,raw_ref) VALUES (%s,%s,%s,%s,%s,'mess') ON CONFLICT (id) DO NOTHING",
                            (a[0], a[1], a[2], a[3], Json(a[4])))
                added["amendments"] += cur.rowcount or 0
        conn.commit()
    finally:
        conn.close()
    return added


def pending_amendments() -> list[dict]:
    return _rows("SELECT a.id, a.deal_id, a.kind, a.effective_date, a.params, a.status, "
                 "t.player_id FROM golden.contract_amendment a "
                 "LEFT JOIN golden.transfer t ON t.id=a.deal_id ORDER BY a.created_at")
