"""The clause guard — the agent's standing check against a deal's contract terms.

Completeness first: a deal's UID (golden.transfer.id) owns a set of clauses, and the
player's employment contract owns more. The #1 real-world failure is MISSING a clause
nobody tracked. So the guard ENUMERATES every clause on the UID (and the player's
employment contract), CHECKS each against the live facts with the trigger detectors,
AUTO-clears the unambiguous ones, and for anything that needs a judgment it routes a
human — handing them BOTH:

  · a plain-English explanation (the detector's grounded reasoning), and
  · the verbatim terms (the kind + params + any ambiguity note that was actually written),

so the human verifies the reading against the source instead of trusting a paraphrase.
It never resolves the judgment itself — it guarantees nothing is missed and nothing is
silently guessed.
"""

from __future__ import annotations

from . import detectors as D
from . import read

# detector action → a human-readable status + whether a human is needed
_CLEAR = {D.MONITOR_OBLIGATION, D.OBLIGATION_LAPSED, *D.AUTO}


def _status(action: str) -> str:
    if action in D.AUTO:
        return "clear"
    if action == D.MONITOR_OBLIGATION:
        return "monitoring"
    if action == D.OBLIGATION_LAPSED:
        return "lapsed"
    if action.startswith("WARN"):
        return "alert"
    if action.startswith("PROPOSE") or action.startswith("KEEP_PAYING"):
        return "action needed"
    return "review"


def _verbatim(cl: dict) -> dict:
    """What was actually written — so the human checks the reading against the source."""
    return {"clause_id": cl.get("id"), "kind": cl.get("kind"),
            "terms": cl.get("params") or {},
            "as_written": cl.get("ambiguity_note") or "",
            "competitions_counted": cl.get("competitions_counted")}


def _check_deal_clause(cl: dict) -> dict:
    kind, cid = cl.get("kind"), cl.get("id")
    d = None
    try:
        if kind == "obligation_to_buy":
            d = D.detect_loan_to_buy(cid)
        elif kind == "sell_on":
            d = D.detect_sell_on(cid)
        elif kind == "extension":
            d = D.detect_extension(cid)
        elif kind in ("addon_appearances", "addon"):
            d = D.detect_addon_triggered(cl.get("contract_id"), cid)
    except Exception:  # noqa: BLE001
        d = None

    if d is None:
        # a clause kind the structured detectors don't recognise → surface + escalate,
        # never silently ignore (this is the Final-Whistle / bespoke-clause case)
        return {"clause_id": cid, "kind": kind, "status": "bespoke — needs review",
                "needs_human": True, "who": "human_accountant",
                "plain": "this is a bespoke clause I can't evaluate automatically — "
                         "I won't guess its effect. Routing it to the accounting team with the exact wording.",
                "verbatim": _verbatim(cl)}
    status = _status(d.action)
    return {"clause_id": cid, "kind": kind, "status": status, "action": d.action,
            "needs_human": d.action not in _CLEAR,
            "who": d.escalated_to or ("human_accountant" if d.action not in _CLEAR else None),
            "plain": d.reason, "exposure": (d.evidence or [{}])[0], "verbatim": _verbatim(cl)}


def _check_employment_clause(cl: dict) -> dict:
    """A standing condition on the player's contract (e.g. a pay-withholding right).
    Reported as a protection/risk that's relevant the moment the player is suspended."""
    kind = cl.get("kind")
    if kind == "suspension_withholding":
        plain = ("the contract grants an explicit right to withhold pay during a suspension "
                 "pending investigation — withholding would be permissible (with the accounting team's sign-off).")
        status, needs = "protection present", False
    elif kind == "termination":
        plain = "a termination is recorded on this contract — wages stop from the effective date."
        status, needs = "note", True
    else:
        plain = ("standard employment terms with NO explicit pay-withholding clause — if this player "
                 "is ever suspended, wages must keep being paid (cf. Mendy v Man City). Latent risk.")
        status, needs = "latent risk — no withholding clause", False
    return {"clause_id": cl.get("id"), "kind": kind, "status": status, "needs_human": needs,
            "who": "human_accountant" if needs else None, "plain": plain, "verbatim": _verbatim(cl)}


def scan(deal_id: str) -> dict:
    """Enumerate + check every clause tied to this deal's UID and the player's employment
    contract. Returns a per-clause report and the subset that needs a human."""
    tr = read.transfer(deal_id)
    player = (tr or {}).get("player_id")

    # all clauses whose contract_id is the deal UID
    deal = [_check_deal_clause(c) for c in _clauses_for(deal_id)]
    emp = [_check_employment_clause(c) for c in (read.employment_clauses(player) if player else [])]
    findings = deal + emp
    needs_human = [f for f in findings if f.get("needs_human")]
    return {"deal": deal_id, "player": player,
            "clauses_found": len(findings),
            "needs_human": len(needs_human),
            "findings": findings,
            "escalations": needs_human}


def _clauses_for(deal_id: str) -> list[dict]:
    # every clause whose contract_id is this deal (transfer clauses)
    return read._rows("SELECT * FROM golden.contract_clause WHERE contract_id=%s ORDER BY id", (deal_id,))
