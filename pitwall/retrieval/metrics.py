"""Retrieval latency metrics → work.retrieval_metric (Tiger hypertable). Written by
the least-privilege `retrieval` role. Telemetry only: a failure here is swallowed so
it can never affect a query result or a finance write."""

from __future__ import annotations

from ..db import connect


def record(surface: str, index_name: str, query_kind: str, retrieval_ms: int, *,
           top_k: int | None = None, hit_count: int | None = None,
           top_score: float | None = None, work_item_id: str | None = None,
           full_turn_ms: int | None = None) -> None:
    try:
        conn = connect("retrieval")
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO work.retrieval_metric (surface, index_name, query_kind, "
                    "retrieval_ms, full_turn_ms, top_k, hit_count, top_score, work_item_id) "
                    "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (surface, index_name, query_kind, int(retrieval_ms),
                     full_turn_ms, top_k, hit_count,
                     round(top_score, 4) if top_score is not None else None, work_item_id))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass
