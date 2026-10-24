"""The agent's read-only retrieval tools. Each one asks Moss *where to look*, times
the lookup, and returns ids + snippets + scores. The agent then refetches the real
row from Tiger (pitwall/agent/read.py) before it acts or speaks — Moss never
supplies a number that goes into a decision. All of these degrade to [] when Moss
is unconfigured, so the agent simply falls back to structured Tiger lookups."""

from __future__ import annotations

from datetime import datetime

from ..config import get_settings
from . import client as R
from . import metrics


def _run(kind: str, text: str, *, query_kind: str, surface: str = "worker", top_k: int = 5,
         alpha: float = 0.8, filter: dict | None = None, work_item_id: str | None = None) -> list[dict]:
    if not R.is_available():
        return []
    idx = get_settings().moss_index(kind)
    res = R.query(idx, text, top_k=top_k, alpha=alpha, filter=filter)
    hs = R.hits(res)
    metrics.record(surface, idx, query_kind, R.ms(res), top_k=top_k, hit_count=len(hs),
                   top_score=hs[0]["score"] if hs else None, work_item_id=work_item_id)
    for h in hs:
        h["retrieval_ms"] = R.ms(res)
    return hs


def find_clauses(query: str, *, counterparty: str | None = None, contract_type: str | None = None,
                 top_k: int = 5, as_of: datetime | None = None) -> list[dict]:
    """Semantic clause search. alpha=0.6 so exact refs ('clause 7.2') still match on
    keywords. Optional counterparty/contract_type narrow it; as_of rewinds validity."""
    flt = R.f_and(
        R.f_eq("counterparty", counterparty) if counterparty else None,
        R.f_eq("contract_type", contract_type) if contract_type else None,
        R.as_of_filter("valid_from", as_of),
    )
    return _run("clauses", query, query_kind="find_clauses", top_k=top_k, alpha=0.6, filter=flt)


def find_precedents(description: str, *, top_k: int = 5) -> list[dict]:
    """Find human corrections of the same shape (the self-improving loop's memory)."""
    return _run("precedents", description, query_kind="find_precedents", top_k=top_k, alpha=0.8)


def find_prior_answers(question: str, to_role: str | None = None, *, top_k: int = 5,
                       as_of: datetime | None = None) -> list[dict]:
    """Was this question already answered? (Check before asking a human again.)"""
    flt = R.f_and(
        R.f_eq("to_role", to_role) if to_role else None,
        R.as_of_filter("answered_at", as_of),
    )
    return _run("questions", question, query_kind="find_prior_answers", top_k=top_k, alpha=0.7,
                filter=flt)


def find_policy(description: str, *, as_of: datetime | None = None, top_k: int = 5) -> list[dict]:
    """The policy that governs this situation, as of a moment (valid_from ≤ as_of <
    valid_to|∞). Confirm against Tiger before applying; hard checks still decide."""
    flt = R.f_and(
        R.as_of_filter("valid_from", as_of),
        R.f_gte("valid_to", R.epoch_str(as_of)) if as_of else None,
    )
    return _run("policies", description, query_kind="find_policy", top_k=top_k, alpha=0.7, filter=flt)


def find_decisions(utterance: str, *, as_of: datetime | None = None, top_k: int = 5,
                   surface: str = "worker", work_item_id: str | None = None) -> list[dict]:
    """Resolve a spoken/typed reference to past decisions → work-item ids. Powers the
    voice agent's resolve_reference; as_of enforces rewind honesty."""
    flt = R.as_of_filter("decided_at", as_of)
    return _run("decisions", utterance, query_kind="resolve_reference", top_k=top_k, alpha=0.8,
                filter=flt, surface=surface, work_item_id=work_item_id)


# --------------------------------------------------------------------------- #
# convenience: reuse a prior answer instead of re-asking a human
# --------------------------------------------------------------------------- #
def reuse_prior_answer(question: str, to_role: str | None = None, *, min_score: float = 0.6,
                       as_of: datetime | None = None) -> dict | None:
    """The best already-answered question above `min_score`, or None. The agent cites
    this ('Reused answer from the sporting director, 12 Mar') instead of asking again."""
    hits = find_prior_answers(question, to_role, top_k=1, as_of=as_of)
    if hits and hits[0]["score"] >= min_score:
        return hits[0]
    return None
