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
    return {
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
