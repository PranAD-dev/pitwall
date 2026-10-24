"""Pit Wall retrieval — Moss semantic search over text that points back to Tiger.

Moss FINDS; Tiger is the TRUTH. Every document's id is a Tiger primary key; after
a hit, callers refetch the record from Tiger before acting or speaking. Payroll is
never indexed. Retrieval is optional: when Moss is unconfigured the agent falls
back to Tiger's structured lookups and the rest of the system is unchanged.
"""

from __future__ import annotations

from .client import (
    as_of_filter,
    epoch_str,
    f_and,
    f_eq,
    f_gte,
    f_in,
    f_lte,
    f_ne,
    hits,
    is_available,
    meta,
    ms,
    query,
)

# The five indexes (short names; client builds the prefixed full name).
INDEXES = ("clauses", "policies", "decisions", "precedents", "questions")

__all__ = [
    "INDEXES",
    "as_of_filter",
    "epoch_str",
    "f_and",
    "f_eq",
    "f_gte",
    "f_in",
    "f_lte",
    "f_ne",
    "hits",
    "is_available",
    "meta",
    "ms",
    "query",
]
