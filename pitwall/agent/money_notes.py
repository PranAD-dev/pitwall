"""Turn a money-moving DECISION into its real journal note — a balanced double-entry
built from the amounts the agent already computed (not a placeholder label).

The decision objects already carry the numbers in `evidence` (expected/received, the
reconciled components, the installment). This module writes them as two-sided money:
this much OUT of one pot, the same amount INTO another. Only decisions that actually
move money get an entry — rejections and escalations post nothing, because nothing
moved; the amount they concern still lives in the decision's reason for the report.
"""

from __future__ import annotations

from ..accounting import coa
from ..accounting.engine import cr, dr
from . import detectors as D
from . import read


def _ev(d, key: str) -> dict:
    for e in (getattr(d, "evidence", None) or []):
        if isinstance(e, dict) and e.get("key") == key:
            return e
    return {}


def _installment(iid) -> tuple[str, float]:
    try:
        inst = read.installment(iid) or {}
        return (inst.get("currency") or "EUR"), round(float(inst.get("amount") or 0), 2)
    except Exception:
        return "EUR", 0.0


def lines_for(case_type: str, d, sr: dict) -> list[dict] | None:
    """Balanced journal lines for the decision, or None when nothing is posted."""
    a = getattr(d, "action", None)

    # SOLD a player → collect the fee. An international sale short by ≈5% is the
    # solidarity contribution withheld: cash in + solidarity receivable = the fee owed.
    if a == D.COMPLETE_SOLIDARITY:
        amt = _ev(d, "amounts")
        expected = round(float(amt.get("expected") or 0), 2)
        received = round(float(amt.get("received") or 0), 2)
        if expected <= 0:
            return None
        ccy = _installment(sr.get("installment_id"))[0]
        withheld = round(expected - received, 2)
        lines = [dr(coa.CASH, received, "cash received from the buying club", ccy)]
        if withheld > 0:
            lines.append(dr(coa.SOLIDARITY_AR, withheld,
                            "solidarity contribution withheld — booked, not chased", ccy))
        lines.append(cr(coa.AR, expected, "clear the transfer receivable", ccy))
        return lines

    # BOUGHT a player → pay the selling club this installment (bank details verified).
    if a == D.COMPLETE_AFTER_EVIDENCE:
        ccy, amt = _installment(sr.get("installment_id"))
        if amt <= 0:
            return None
        return [dr(coa.AP, amt, "settle the transfer payable", ccy),
                cr(coa.CASH, amt, "cash out — installment paid", ccy)]

    # One incoming wire that reconciles to several receivable components.
    if a == D.SPLIT:
        rec = _ev(d, "reconcile")
        comps = [c for c in (rec.get("components") or []) if float(c.get("amount") or 0) > 0]
        total = round(sum(float(c["amount"]) for c in comps), 2)
        if total <= 0:
            return None
        ccy = "EUR"
        try:
            ccy = (read.bank_txn(sr.get("txn_id")) or {}).get("currency") or "EUR"
        except Exception:
            pass
        lines = [dr(coa.CASH, total, "one incoming wire, reconciled to the cent", ccy)]
        for c in comps:
            label = c.get("installment") or c.get("addon_clause") or "component"
            lines.append(cr(coa.AR, round(float(c["amount"]), 2), f"clear {label}", ccy))
        return lines

    return None  # rejections / escalations move no money → no entry
