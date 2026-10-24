"""Tiger → Moss sync. Moss is a derived index; Tiger is the source of truth, so a
Moss failure must NEVER block a finance write. Two entry points:

  build_all()            — full (re)build of all five indexes (the `make reset` path)
  upsert(kind, tiger_id) — refresh ONE document AFTER a gateway txn has committed

If Moss is unreachable during an upsert we append to work.moss_outbox and return;
`drain_outbox()` retries later. Every (re)index writes an informational row to the
audit log as actor='retrieval' — bookkeeping, never a finance action.
"""

from __future__ import annotations

from datetime import datetime, timezone

from ..config import get_settings
from ..db import connect
from . import client as R
from . import documents as docs
from .client import is_available

KINDS = ("clauses", "policies", "decisions", "precedents", "questions")


def _now() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# telemetry writes (retrieval role: may append audit rows + its outbox only)
# --------------------------------------------------------------------------- #
def _audit_index(kind: str, index: str, n: int, note: str) -> None:
    try:
        conn = connect("retrieval")
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason) "
                    "VALUES (%s,'retrieval','index',%s,true,%s)",
                    (_now(), f"moss:{index}", f"{note} {n} {kind} document(s)"))
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass  # telemetry must never break a build


def _enqueue(kind: str, tiger_id: str, op: str, err: str) -> None:
    conn = connect("retrieval")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO work.moss_outbox (kind, tiger_id, op, attempts, last_error) "
                "VALUES (%s,%s,%s,1,%s)", (kind, tiger_id, op, err[:500]))
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# build_all — the make-reset path
# --------------------------------------------------------------------------- #
def build_all(*, use_llm: bool = False) -> dict:
    """(Re)build every index from Tiger. Idempotent; safe to re-run. Returns per-kind
    counts (or an 'error' per kind that failed, without aborting the rest)."""
    if not is_available():
        return {"skipped": "Moss not configured (set MOSS_PROJECT_ID/MOSS_PROJECT_KEY)"}
    s = get_settings()
    llm = docs.llm_opts() if use_llm else None
    out: dict[str, object] = {}
    for kind in KINDS:
        index = s.moss_index(kind)
        try:
            built = docs.build_index_docs(kind, llm=llm)
            res = R.rebuild_index(index, built)
            out[kind] = res["docs"]
            _audit_index(kind, index, res["docs"], "rebuilt")
        except Exception as e:  # one bad index never sinks the others
            out[kind] = {"error": str(e)[:160]}
    return out


# --------------------------------------------------------------------------- #
# upsert — the post-commit path (never inside a finance txn)
# --------------------------------------------------------------------------- #
def upsert(kind: str, tiger_id: str, *, op: str = "upsert", use_llm: bool = False) -> dict:
    """Refresh one document. Called by the gateway AFTER commit. A Moss outage is
    swallowed into the outbox so the finance write it follows is never at risk."""
    if not is_available():
        return {"skipped": "moss off"}
    s = get_settings()
    index = s.moss_index(kind)
    try:
        if op == "delete":
            R.delete_docs(index, [tiger_id])
            _audit_index(kind, index, 1, "deleted")
            return {"ok": True, "op": "delete", "id": tiger_id}
        doc = docs.build_one_doc(kind, tiger_id, llm=docs.llm_opts() if use_llm else None)
        if doc is None:
            return {"skipped": f"no {kind} row {tiger_id}"}
        R.upsert_docs(index, [doc])
        _audit_index(kind, index, 1, "upserted")
        return {"ok": True, "op": "upsert", "id": tiger_id}
    except Exception as e:
        _enqueue(kind, tiger_id, op, str(e))
        return {"queued": True, "error": str(e)[:160]}


# --------------------------------------------------------------------------- #
# drain_outbox — retry what failed while Moss was down
# --------------------------------------------------------------------------- #
def drain_outbox(limit: int = 200) -> dict:
    if not is_available():
        return {"skipped": "moss off"}
    conn = connect("retrieval")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, kind, tiger_id, op FROM work.moss_outbox "
                "WHERE done_at IS NULL ORDER BY enqueued_at LIMIT %s", (limit,))
            pending = cur.fetchall()
        done, failed = 0, 0
        for row_id, kind, tiger_id, op in pending:
            r = upsert(kind, tiger_id, op=op)
            with conn.cursor() as cur:
                if r.get("ok"):
                    cur.execute("UPDATE work.moss_outbox SET done_at=now() WHERE id=%s", (row_id,))
                    done += 1
                else:
                    cur.execute(
                        "UPDATE work.moss_outbox SET attempts=attempts+1, last_error=%s WHERE id=%s",
                        (str(r.get("error", "unknown"))[:500], row_id))
                    failed += 1
            conn.commit()
        return {"pending": len(pending), "indexed": done, "still_failing": failed}
    finally:
        conn.close()
