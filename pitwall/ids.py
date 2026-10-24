"""Stable id helpers. raw_ref = md5(source|src_id) so re-sync never duplicates."""

from __future__ import annotations

import hashlib


def raw_ref(source: str, src_id: str) -> str:
    """Deterministic lineage id for a source fact."""
    return hashlib.md5(f"{source}|{src_id}".encode()).hexdigest()
