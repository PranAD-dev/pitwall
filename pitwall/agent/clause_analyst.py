"""A clause-analyst SUBAGENT.

When a case turns on an ambiguous or bespoke contract clause, the main agent delegates
that one clause to this focused reasoner. It reads the clause closely and returns a
SHORT report for the accounting team to decide on — grounded strictly in the terms it's
given (it will not invent figures, dates, or facts). The report rides along with the
human-in-the-loop prompt, so the team gets a specialist read + the verbatim terms before
they make the call.

Runs on Claude when a key is live; falls back to a deterministic template otherwise.
"""

from __future__ import annotations

import json

from ..config import get_settings

_SYS = (
    "You are a football-finance contract-clause analyst — a focused subagent the main Pit "
    "Wall agent delegates ONE clause to. Read the clause and return a SHORT report for the "
    "club's accounting team, who make the final call. Ground EVERYTHING strictly in the terms "
    "provided; do NOT invent figures, dates, parties, or facts that are not present. Be concrete "
    "and brief. Reply ONLY as compact JSON with exactly these keys: "
    "{\"summary\": str, \"interpretations\": [str, ...], \"financial_implication\": str, "
    "\"risk\": str, \"recommendation\": str}."
)


def analyze(situation: str, clause: dict, reason: str = "") -> dict:
    """Return a short grounded report on one clause."""
    s = get_settings()
    if not getattr(s, "llm_is_live", False):
        return _template(situation, clause, reason)
    try:
        import anthropic

        client = anthropic.Anthropic(api_key=s.anthropic_api_key)
        payload = {"situation": situation, "clause": clause, "why_escalated": reason}
        msg = client.messages.create(
            model=s.pitwall_agent_model, max_tokens=800, system=_SYS,
            messages=[{"role": "user", "content": json.dumps(payload, default=str, indent=2)}])
        txt = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        txt = txt[txt.find("{"): txt.rfind("}") + 1]
        rep = json.loads(txt)
        # keep only the expected shape + tag the author
        out = {k: rep.get(k) for k in ("summary", "interpretations", "financial_implication",
                                       "risk", "recommendation")}
        out["by"] = "clause-analyst subagent"
        return out
    except Exception:  # noqa: BLE001 — never let the subagent break the escalation
        return _template(situation, clause, reason)


def _template(situation: str, clause: dict, reason: str) -> dict:
    cl = clause or {}
    kind = cl.get("kind") or (cl.get("clauses") or [{}])[0].get("kind") or situation
    written = cl.get("as_written") or (cl.get("clauses") or [{}])[0].get("as_written") or ""
    return {
        "summary": f"{kind} clause — {reason or 'needs a human judgment.'}",
        "interpretations": [written] if written else ["the terms are not fully specified in the record"],
        "financial_implication": "depends on the reading chosen — see the terms.",
        "risk": "choosing the wrong basis could materially mis-state the obligation.",
        "recommendation": "confirm the basis with the accounting team before booking anything.",
        "by": "clause-analyst (offline template)",
    }
