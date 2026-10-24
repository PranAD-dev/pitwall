"""Moss client — the retrieval runtime. A thin, sync-friendly facade over the
async `moss` SDK so the (entirely synchronous) Pit Wall core can call it without
turning itself inside out.

Moss FINDS; Tiger is the TRUTH. Everything here returns document ids + text +
scores; callers refetch the real record from Tiger before acting or speaking. We
never store a number here that isn't also a Tiger id or a copy of indexed text.

Design notes (verified against moss==1.21.0 on 2026-10-24):
  * All MossClient methods are coroutines, and the client holds in-memory loaded
    indexes, so it must live on ONE event loop for its whole life. We run a single
    client on a dedicated daemon-thread event loop and marshal every call onto it
    with run_coroutine_threadsafe — safe to call from any sync code or FastAPI.
  * Document metadata values must be STRINGS. We stringify everything and store
    timestamps as 10-digit epoch strings so Moss's lexicographic `$lte/$gte`
    range filters compare them correctly (every date 2001..2286 is 10 digits).
  * Query filters use the shape {"field","condition":{"$op":v}} or {"$and":[…]} —
    NOT the flat dict the public docs show. The helpers below build that shape.
"""

from __future__ import annotations

import asyncio
import threading
from datetime import datetime, timezone
from typing import Any, Callable, Coroutine, Optional

from ..config import get_settings

# epoch sentinel for an open-ended validity window (sorts above any real epoch)
OPEN_ENDED = "9999999999"


# --------------------------------------------------------------------------- #
# metadata / filter helpers (string-only metadata; confirmed operator syntax)
# --------------------------------------------------------------------------- #
def epoch_str(dt: datetime | None, *, default: str = OPEN_ENDED) -> str:
    """A 10-digit epoch-seconds string for metadata + range filters. 10 digits so
    lexicographic comparison in Moss equals numeric comparison for all real dates."""
    if dt is None:
        return default
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return str(int(dt.timestamp())).zfill(10)


def meta(**kv: Any) -> dict[str, str]:
    """Build a Moss metadata dict: drop None, stringify everything (strings only)."""
    return {k: str(v) for k, v in kv.items() if v is not None}


def f_eq(field: str, value: Any) -> dict:
    return {"field": field, "condition": {"$eq": str(value)}}


def f_ne(field: str, value: Any) -> dict:
    return {"field": field, "condition": {"$ne": str(value)}}


def f_lte(field: str, value: Any) -> dict:
    return {"field": field, "condition": {"$lte": str(value)}}


def f_gte(field: str, value: Any) -> dict:
    return {"field": field, "condition": {"$gte": str(value)}}


def f_in(field: str, values: list) -> dict:
    return {"field": field, "condition": {"$in": [str(v) for v in values]}}


def f_and(*clauses: Optional[dict]) -> dict | None:
    cs = [c for c in clauses if c]
    if not cs:
        return None
    return cs[0] if len(cs) == 1 else {"$and": cs}


def as_of_filter(field: str, as_of: datetime | None) -> dict | None:
    """Rewind honesty: only documents valid at/before `as_of` (field holds an
    epoch_str). None => no constraint (present-day)."""
    if as_of is None:
        return None
    return f_lte(field, epoch_str(as_of))


# --------------------------------------------------------------------------- #
# the single-loop async bridge
# --------------------------------------------------------------------------- #
class _Bridge:
    """Owns one asyncio loop (daemon thread) and one MossClient on it."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._client: Any = None
        self._lock = threading.RLock()  # reentrant: _ensure_client calls _ensure_loop under it

    def _ensure_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            with self._lock:
                if self._loop is None:
                    loop = asyncio.new_event_loop()
                    t = threading.Thread(target=loop.run_forever, name="moss-loop", daemon=True)
                    t.start()
                    self._loop, self._thread = loop, t
        return self._loop

    def _ensure_client(self) -> Any:
        if self._client is None:
            with self._lock:
                if self._client is None:
                    s = get_settings()
                    if not s.moss_is_live:
                        raise RuntimeError(
                            "Moss is not configured — set MOSS_PROJECT_ID/MOSS_PROJECT_KEY "
                            "(or PITWALL_MOSS_MODE=off to silence retrieval)."
                        )
                    loop = self._ensure_loop()

                    async def _make():
                        from moss import MossClient

                        return MossClient(s.moss_project_id, s.moss_project_key)

                    self._client = asyncio.run_coroutine_threadsafe(_make(), loop).result(30)
        return self._client

    def run(self, make_coro: Callable[[Any], Coroutine], *, timeout: float = 60.0) -> Any:
        """Schedule `make_coro(client)` on the Moss loop and block for its result."""
        client = self._ensure_client()
        loop = self._ensure_loop()
        return asyncio.run_coroutine_threadsafe(make_coro(client), loop).result(timeout)

    def shutdown(self) -> None:
        """Close the Moss client and stop the loop (frees the native runtime so a
        process can exit cleanly). Safe to call more than once / when never used."""
        with self._lock:
            if self._client is not None and self._loop is not None:
                try:
                    asyncio.run_coroutine_threadsafe(self._client.close(), self._loop).result(10)
                except Exception:
                    pass
            if self._loop is not None:
                try:
                    self._loop.call_soon_threadsafe(self._loop.stop)
                except Exception:
                    pass
            self._client = None


_bridge = _Bridge()


def is_available() -> bool:
    """True iff retrieval is configured. Callers degrade to Tiger-only when False."""
    try:
        return get_settings().moss_is_live
    except Exception:
        return False


def shutdown() -> None:
    """Release the Moss runtime (call on process teardown / at the end of a CLI cmd)."""
    _bridge.shutdown()


# --------------------------------------------------------------------------- #
# low-level ops (name is the FULL index name, e.g. 'pitwall_clauses')
# --------------------------------------------------------------------------- #
def rebuild_index(name: str, docs: list) -> dict:
    """Delete + recreate an index from scratch (the `make reset` path). Idempotent.
    Returns {index, docs}. An empty doc set just clears the index."""

    async def _op(c):
        try:
            await c.delete_index(name)
        except Exception:
            pass  # not-found is fine
        if not docs:
            return {"index": name, "docs": 0}
        res = await c.create_index(name, docs)
        return {"index": name, "docs": getattr(res, "doc_count", len(docs))}

    return _bridge.run(_op, timeout=300.0)


def upsert_docs(name: str, docs: list) -> dict:
    """Add/replace docs by id. Creates the index first if it doesn't exist yet."""
    if not docs:
        return {"index": name, "docs": 0}

    async def _op(c):
        from moss import MutationOptions

        try:
            res = await c.add_docs(name, docs, MutationOptions(upsert=True))
        except Exception:
            # index may not exist yet → create it with these docs
            res = await c.create_index(name, docs)
        return {"index": name, "docs": getattr(res, "doc_count", len(docs))}

    return _bridge.run(_op, timeout=120.0)


def delete_docs(name: str, doc_ids: list[str]) -> None:
    if not doc_ids:
        return

    async def _op(c):
        try:
            await c.delete_docs(name, doc_ids)
        except Exception:
            pass

    _bridge.run(_op, timeout=60.0)


def load(name: str) -> None:
    """Load an index into process memory so queries are local + sub-10ms."""
    _bridge.run(lambda c: c.load_index(name), timeout=120.0)


def load_many(names: list[str]) -> None:
    for n in names:
        try:
            load(n)
        except Exception:
            pass


def query(
    name: str,
    text: str,
    *,
    top_k: int = 5,
    alpha: float = 0.8,
    min_score: float | None = None,
    filter: dict | None = None,
) -> Any:
    """Semantic/keyword/hybrid search. Returns the raw moss SearchResult
    (.docs[*].{id,text,score,metadata}, .time_taken_ms). Loads the index on demand."""
    from moss import QueryOptions

    opts: dict[str, Any] = {"top_k": top_k, "alpha": alpha}
    if min_score is not None:
        opts["min_score"] = min_score
    if filter is not None:
        opts["filter"] = filter

    async def _op(c):
        try:
            return await c.query(name, text, QueryOptions(**opts))
        except Exception:
            # not loaded yet → load once, retry
            await c.load_index(name)
            return await c.query(name, text, QueryOptions(**opts))

    return _bridge.run(_op, timeout=60.0)


def list_indexes() -> list[str]:
    async def _op(c):
        try:
            return [getattr(i, "name", getattr(i, "index_name", "")) for i in await c.list_indexes()]
        except Exception:
            return []

    return _bridge.run(_op, timeout=60.0)


# --------------------------------------------------------------------------- #
# result normalizers (callers never touch the SDK's result types directly)
# --------------------------------------------------------------------------- #
def hits(result: Any) -> list[dict]:
    """Normalize a SearchResult to [{id, text, score, metadata}], best first."""
    out = []
    for d in getattr(result, "docs", None) or []:
        out.append(
            {
                "id": d.id,
                "text": d.text,
                "score": float(d.score),
                "metadata": dict(getattr(d, "metadata", None) or {}),
            }
        )
    return out


def ms(result: Any) -> int:
    """Server-reported retrieval latency in whole milliseconds."""
    return int(getattr(result, "time_taken_ms", 0) or 0)
