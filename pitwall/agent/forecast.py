"""Forecast — the 5th system (deck slide 7: "one event touches five systems →
Forecast: next quarter's numbers shift").

A simulated forecast system of record our Gateway ripples into. It projects the
transfer-installment cash pipeline and the squad-cost ratio from golden, and — the
demo point — attributes the £/€ each agent decision moved ("this hold protected €3M
of next-quarter cash"). Read-only and defensive: any query that fails falls back,
so a scenario never dies on the forecast step.

Wages are the HUMAN payroll seat — Pit Wall's role can't read individual salaries
(by design), so the wage figure here is a non-salary aggregate a privileged job
would supply. The agent computes the parts it is allowed to see (amortization,
agent fees) and shows the ratio.
"""

from __future__ import annotations

from ..db import connect

SQUAD_COST_LIMIT = 70            # % — the league's squad-cost limit
WAGE_AGG_ANNUAL = 44_000_000     # non-salary wage aggregate (payroll seat supplies this)
OTHER_REVENUE_ANNUAL = 105_000_000  # broadcast + matchday + commercial, on top of sponsors


def _scalar(sql: str, params: tuple = (), default: float = 0.0) -> float:
    conn = connect("agent")
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            r = cur.fetchone()
            return float(r[0]) if r and r[0] is not None else default
    except Exception:
        return default
    finally:
        conn.close()


def _rows(sql: str, params: tuple = ()) -> list[tuple]:
    conn = connect("agent")
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    except Exception:
        return []
    finally:
        conn.close()


# months elapsed between `signed_at` and a reference instant, in SQL. `ref` is a
# COALESCE(%s::timestamptz, now()) expression so callers pass the world's clock.
def _months(ref: str, col: str) -> str:
    return (f"(EXTRACT(YEAR FROM age({ref}, {col}))*12 "
            f"+ EXTRACT(MONTH FROM age({ref}, {col})))")


def _world_today():
    """The world's 'present' — its latest recorded activity — so carrying amounts and
    receivable aging reflect the simulation's clock, not the real wall clock."""
    conn = connect("agent")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT max(txn_time) FROM golden.bank_transaction")
            r = cur.fetchone()
            return r[0] if r and r[0] else None
    except Exception:
        return None
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# The annual-report view — our golden.* rows rolled up in the SHAPE a real club
# reports them (BVB's IFRS notes: 17 net transfer income, 1 player registrations,
# 21 amortisation, 34 purchase commitments). Modeled, read-only, each part guarded.
# --------------------------------------------------------------------------- #
def club_report() -> dict:
    ref = _world_today()  # bound as %s::timestamptz below; COALESCE falls back to now()
    REF = "COALESCE(%s::timestamptz, now())"

    # Note 17 — net transfer income = gross proceeds − transfer costs − residual carrying
    gross = _scalar("SELECT sum(fee) FROM golden.transfer WHERE direction='out'")
    costs = _scalar(
        "SELECT sum(iv.amount) FROM golden.invoice iv JOIN golden.transfer t ON t.id=iv.transfer_id "
        "WHERE t.direction='out' AND iv.kind IN ('agent_fee','consultancy')")
    # unamortised book value of a sold player's original purchase, written off on sale
    residual = _scalar(
        "SELECT sum(GREATEST(0, i.fee * (i.amortization_months - "
        + _months("o.signed_at", "i.signed_at") +
        ") / NULLIF(i.amortization_months,0))) "
        "FROM golden.transfer o JOIN golden.transfer i "
        "ON i.player_id=o.player_id AND i.direction='in' "
        "WHERE o.direction='out'")
    net_transfer_income = gross - costs - residual

    # Notes 1 & 21 — player registrations (carrying amount) + annual amortisation charge
    registrations = _scalar(
        "SELECT sum(GREATEST(0, fee * (amortization_months - "
        + _months(REF, "signed_at") +
        ") / NULLIF(amortization_months,0))) FROM golden.transfer WHERE direction='in'",
        (ref, ref))  # _months expands REF twice (year + month extract)
    amort_annual = _scalar(
        "SELECT sum(fee*12.0/NULLIF(amortization_months,0)) FROM golden.transfer "
        "WHERE direction='in' AND amortization_months > " + _months(REF, "signed_at"),
        (ref, ref))

    # Note 34 — purchase commitments = contingent add-on fees NOT yet triggered
    # (the payable is params.fee; some clauses carry params.triggered = true)
    commit_row = _rows(
        "SELECT coalesce(sum(coalesce((params->>'fee')::numeric,0)),0), count(*) "
        "FROM golden.contract_clause "
        "WHERE kind IN ('addon_appearances','addon_goals','obligation_to_buy','win_bonus') "
        "AND coalesce((params->>'triggered')::boolean, false) = false")
    contingent, n_commit = (float(commit_row[0][0] or 0), int(commit_row[0][1] or 0)) if commit_row else (0.0, 0)

    return {
        "net_transfer_income": {
            "gross_proceeds": round(gross),
            "transfer_costs": round(costs),
            "residual_carrying": round(residual),
            "net": round(net_transfer_income),
        },
        "intangibles": {
            "player_registrations": round(registrations),
            "amortisation_annual": round(amort_annual),
        },
        "commitments": {"contingent_addons": round(contingent), "count": n_commit},
        "basis": "modeled from golden.* in the shape of a club's IFRS notes "
                 "(17 net transfer income · 1 player registrations · 21 amortisation · 34 commitments)",
    }


# --------------------------------------------------------------------------- #
# Receivables aging — open money owed to us (unpaid installments on OUTgoing
# transfers), bucketed and allowanced the way a club reports trade receivables
# (BVB Notes 5 & 26). The incoming-short planted issues feed the allowance.
# --------------------------------------------------------------------------- #
def receivables_aging() -> dict:
    ref = _world_today()  # age against the world's present, not the real wall clock
    D = "COALESCE(%s::timestamptz::date, CURRENT_DATE)"
    rows = _rows(
        "SELECT CASE "
        f"  WHEN i.due_date >= {D} THEN 'not_due' "
        f"  WHEN {D} - i.due_date < 30 THEN 'd0_30' "
        f"  WHEN {D} - i.due_date < 90 THEN 'd30_89' "
        "  ELSE 'd90' END AS bucket, "
        "coalesce(sum(i.amount),0), count(*) "
        "FROM golden.installment i JOIN golden.transfer t ON t.id=i.transfer_id "
        "WHERE t.direction='out' AND i.status <> 'paid' GROUP BY 1",
        (ref, ref, ref))
    by = {b: (float(a or 0), int(n or 0)) for b, a, n in rows}
    order = [("not_due", "not yet due"), ("d0_30", "< 30 days past due"),
             ("d30_89", "30–89 days past due"), ("d90", "≥ 90 days past due")]
    buckets = [{"key": k, "label": lbl, "amount": round(by.get(k, (0, 0))[0]),
                "count": by.get(k, (0, 0))[1]} for k, lbl in order]
    gross = sum(b["amount"] for b in buckets)
    allowance = _scalar(
        "SELECT coalesce(sum(i.amount),0) FROM golden.installment i "
        "JOIN golden.transfer t ON t.id=i.transfer_id "
        "WHERE t.direction='out' AND i.status IN ('disputed','short_paid')")
    return {
        "buckets": buckets,
        "gross": round(gross),
        "allowance": round(allowance),
        "net": round(gross - allowance),
        "basis": "open receivables (unpaid installments on outgoing transfers), aged like Notes 5 & 26",
    }


def snapshot() -> dict:
    """Current projected position — for the forecast panel / KPI tiles."""
    cash_now = _scalar("SELECT sum(amount) FROM golden.bank_transaction")
    pipe_in = _scalar("SELECT sum(i.amount) FROM golden.installment i JOIN golden.transfer t "
                      "ON t.id = i.transfer_id WHERE t.direction = 'out' AND i.status <> 'paid'")
    pipe_out = _scalar("SELECT sum(i.amount) FROM golden.installment i JOIN golden.transfer t "
                       "ON t.id = i.transfer_id WHERE t.direction = 'in' AND i.status <> 'paid'")
    amort = _scalar("SELECT sum(fee / NULLIF(contract_years, 0)) FROM golden.transfer WHERE direction = 'in'")
    agent_fees = _scalar("SELECT sum(iv.amount) FROM golden.invoice iv JOIN golden.counterparty c "
                         "ON c.id = iv.counterparty_id WHERE c.kind = 'agent'")
    sponsor_rev = _scalar("SELECT sum(base_amount) FROM golden.sponsor_contract")
    revenue = sponsor_rev + OTHER_REVENUE_ANNUAL
    cost_base = amort + agent_fees + WAGE_AGG_ANNUAL
    ratio = round(100 * cost_base / revenue, 1) if revenue else 0.0
    out = {
        "cash_now": round(cash_now),
        "pipeline_net": round(pipe_in - pipe_out),
        "pipeline_in": round(pipe_in),
        "pipeline_out": round(pipe_out),
        "squad_cost_ratio": ratio,
        "squad_cost_limit": SQUAD_COST_LIMIT,
        "amort": round(amort),
        "agent_fees": round(agent_fees),
        "revenue": round(revenue),
    }
    # the annual-report view (IFRS notes) + receivables aging — each guarded so the
    # forecast panel never dies on them
    try:
        out["report"] = club_report()
    except Exception:
        pass
    try:
        out["receivables"] = receivables_aging()
    except Exception:
        pass
    return out


def _inst_amt(iid: str) -> float:
    return _scalar("SELECT amount FROM golden.installment WHERE id = %s", (iid,))


def _inv_amt(iid: str) -> float:
    return _scalar("SELECT amount FROM golden.invoice WHERE id = %s", (iid,))


def impact(stype: str, sr: dict | None) -> dict:
    """The £/€ this one decision moved — the attribution line the forecast panel shows."""
    sr = sr or {}
    if stype in ("fake_bank_detail_change",):
        a = _inst_amt(sr.get("installment_id"))
        return {"amount": round(a), "currency": "EUR", "kind": "protected",
                "line": f"protected €{a:,.0f} of next-quarter cash from a fraudulent payee — held, not paid"}
    if stype == "addon_invoiced_not_triggered":
        a = _inv_amt(sr.get("invoice_id"))
        return {"amount": round(a), "currency": "EUR", "kind": "avoided",
                "line": f"avoided a €{a:,.0f} add-on that wasn't owed"}
    if stype == "duplicate_agent_fee":
        a = _inv_amt(sr.get("duplicate_invoice_id"))
        return {"amount": round(a), "currency": "EUR", "kind": "avoided",
                "line": f"rejected a €{a:,.0f} duplicate agent fee"}
    if stype == "threshold_evasion_split":
        a = sum(_inv_amt(i) for i in (sr.get("invoice_ids") or []))
        return {"amount": round(a), "currency": "EUR", "kind": "held",
                "line": f"held €{a:,.0f} of split invoices — threshold-evasion, routed up"}
    if stype == "incoming_short_solidarity":
        a = _inst_amt(sr.get("installment_id"))
        return {"amount": round(a), "currency": "EUR", "kind": "booked",
                "line": f"booked the €{a:,.0f} receipt; the ~5% solidarity shortfall is not chased"}
    if stype == "incoming_short_unexplained":
        a = _inst_amt(sr.get("installment_id"))
        return {"amount": round(a), "currency": "EUR", "kind": "chase",
                "line": f"flagged the short €{a:,.0f} receipt to chase — not written off"}
    if stype == "stale_fx_rate":
        a = _inst_amt(sr.get("installment_id"))
        return {"amount": round(a), "currency": "EUR", "kind": "flagged",
                "line": f"flagged an FX difference on the €{a:,.0f} installment — propose a gain/loss entry"}
    return {"amount": 0, "currency": "", "kind": "none",
            "line": "proposal recorded; no direct cash impact on the forecast"}
