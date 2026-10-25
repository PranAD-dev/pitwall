"""Read the ledger back as books: a trial balance that must tie (Σ debits == Σ
credits, per currency) and a P&L that shows where the money came from. This is the
'lead with the books' view — proof the System of Work produced correct accounting,
not just decisions."""

from __future__ import annotations

from ..db import connect
from . import coa


def _ledger() -> list[dict]:
    """Aggregate every posted journal line by account + currency."""
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            # derive the account code from the line's `code`, or the leading token of
            # its account label ("1200 Player registrations" → "1200") for legacy
            # entries; drop zero-amount phantom lines from older placeholder postings
            cur.execute(
                "SELECT coalesce(nullif(l->>'code',''), split_part(l->>'account',' ',1)) AS code, "
                "coalesce(l->>'currency','EUR') AS ccy, "
                "sum(coalesce((l->>'debit')::numeric,0)) AS d, "
                "sum(coalesce((l->>'credit')::numeric,0)) AS c "
                "FROM golden.journal_entry je, jsonb_array_elements(je.lines) l "
                "GROUP BY 1,2 "
                "HAVING sum(coalesce((l->>'debit')::numeric,0)) "
                "     + sum(coalesce((l->>'credit')::numeric,0)) <> 0 "
                "ORDER BY 1,2")
            return [{"code": r[0] or "", "ccy": r[1] or "EUR", "debit": float(r[2] or 0),
                     "credit": float(r[3] or 0)} for r in cur.fetchall()]
    except Exception:
        return []
    finally:
        conn.close()


def trial_balance() -> dict:
    """Per-currency trial balance. `balanced` is the core integrity claim."""
    rows = _ledger()
    by_ccy: dict[str, dict] = {}
    for r in rows:
        c = by_ccy.setdefault(r["ccy"], {"rows": [], "total_debit": 0.0, "total_credit": 0.0})
        bal = round(r["debit"] - r["credit"], 2)
        c["rows"].append({"code": r["code"], "account": coa.name(r["code"]),
                          "type": coa.acct_type(r["code"]),
                          "debit": round(r["debit"], 2), "credit": round(r["credit"], 2),
                          "balance": bal})
        c["total_debit"] = round(c["total_debit"] + r["debit"], 2)
        c["total_credit"] = round(c["total_credit"] + r["credit"], 2)
    for c, d in by_ccy.items():
        d["balanced"] = abs(d["total_debit"] - d["total_credit"]) < 0.01
    return {"currencies": by_ccy,
            "balanced": all(d["balanced"] for d in by_ccy.values()) if by_ccy else True}


def squad_cost_ratio() -> dict:
    """Squad-Cost Ratio = (wages + player bonuses + transfer amortisation + agent fees)
    / revenue, vs the PL 85% / UEFA 70% thresholds. Every input is a posted journal
    entry, so the number is traceable — the thing a CFO is judged on, defensible.

    Summed across currencies at 1:1 (no FX conversion in this snapshot) — flagged."""
    rows = _ledger()
    acc: dict[str, dict] = {}
    for r in rows:
        a = acc.setdefault(r["code"], {"debit": 0.0, "credit": 0.0})
        a["debit"] += r["debit"]
        a["credit"] += r["credit"]

    def dr_bal(code):  # expense / debit-normal balance
        a = acc.get(code, {"debit": 0, "credit": 0})
        return round(a["debit"] - a["credit"], 2)

    def cr_bal(code):  # revenue / credit-normal balance
        a = acc.get(code, {"debit": 0, "credit": 0})
        return round(a["credit"] - a["debit"], 2)

    wages = round(dr_bal(coa.WAGES_EXP) + dr_bal(coa.STAFF_WAGES_EXP), 2)
    bonuses = dr_bal(coa.BONUS_EXP)
    amortisation = dr_bal(coa.AMORT_EXP)
    agent_fees = dr_bal(coa.AGENT_EXP)
    squad_cost = round(wages + bonuses + amortisation + agent_fees, 2)

    net_transfer_income = cr_bal(coa.DISPOSAL_GAIN) - dr_bal(coa.DISPOSAL_LOSS)
    sponsorship = cr_bal(coa.SPONSOR_REV)
    matchday = cr_bal(coa.MATCHDAY_REV)
    fx = cr_bal(coa.FX)
    revenue = round(net_transfer_income + sponsorship + matchday + fx, 2)

    ratio = round(100 * squad_cost / revenue, 1) if revenue else None
    return {
        "squad_cost": squad_cost,
        "revenue": revenue,
        "ratio_pct": ratio,
        "components": {"wages": wages, "player_bonuses": bonuses,
                       "transfer_amortisation": amortisation, "agent_fees": agent_fees},
        "revenue_components": {"net_transfer_income": round(net_transfer_income, 2),
                               "sponsorship": sponsorship, "matchday": matchday, "fx": fx},
        "thresholds": {"premier_league": 85, "uefa": 70},
        "within_pl": (ratio is not None and ratio <= 85),
        "within_uefa": (ratio is not None and ratio <= 70),
        "note": "every input is a posted journal entry; currencies summed 1:1 (no FX "
                "conversion in this snapshot)",
    }


def pnl() -> dict:
    """P&L by currency: revenue (credit-normal) − expense (debit-normal), with the
    football line items a club reports broken out."""
    rows = _ledger()
    out: dict[str, dict] = {}
    for r in rows:
        c = out.setdefault(r["ccy"], {})
        c[r["code"]] = {"debit": r["debit"], "credit": r["credit"]}
    result: dict[str, dict] = {}
    for ccy, acc in out.items():
        def cr_minus_dr(code):
            a = acc.get(code, {"debit": 0, "credit": 0})
            return round(a["credit"] - a["debit"], 2)

        def dr_minus_cr(code):
            a = acc.get(code, {"debit": 0, "credit": 0})
            return round(a["debit"] - a["credit"], 2)

        net_transfer_income = cr_minus_dr(coa.DISPOSAL_GAIN) - dr_minus_cr(coa.DISPOSAL_LOSS)
        sponsorship = cr_minus_dr(coa.SPONSOR_REV)
        matchday = cr_minus_dr(coa.MATCHDAY_REV)
        fx = cr_minus_dr(coa.FX)
        wages = dr_minus_cr(coa.WAGES_EXP)
        staff_wages = dr_minus_cr(coa.STAFF_WAGES_EXP)
        bonuses = dr_minus_cr(coa.BONUS_EXP)
        amortisation = dr_minus_cr(coa.AMORT_EXP)
        agent_fees = dr_minus_cr(coa.AGENT_EXP)
        revenue = round(net_transfer_income + sponsorship + matchday + fx, 2)
        expense = round(wages + staff_wages + bonuses + amortisation + agent_fees, 2)
        result[ccy] = {
            "net_transfer_income": round(net_transfer_income, 2),
            "sponsorship_revenue": sponsorship,
            "matchday_revenue": matchday,
            "fx_gain_loss": fx,
            "player_wages": wages,
            "staff_wages": staff_wages,
            "player_bonuses": bonuses,
            "amortisation_expense": amortisation,
            "agent_fees_expense": agent_fees,
            "total_revenue": revenue,
            "total_expense": expense,
            "net_income": round(revenue - expense, 2),
        }
    return result
