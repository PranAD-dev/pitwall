"""The double-entry engine — the System of Work's hand on the ledger.

Every economic event becomes a BALANCED journal entry (debits == credits, per
currency, to the cent). `post()` enforces that invariant in code before it writes a
single row — the gateway refuses an unbalanced entry, the same way it refuses an
agent writing the journal directly. Corrections to a closed period are done by
`reverse()` + repost, linked to the original; records are never deleted.

Writes go in as the `gateway` Postgres role (the only writer of golden.journal_entry)
and every post/reversal is mirrored to the append-only audit log. Limits in the DB,
a record of every call — the Hyphenate pillars, applied to the books.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from psycopg.types.json import Json

from ..db import connect
from . import coa

CENT = 0.01


class Unbalanced(Exception):
    """Raised when debits != credits — the entry is refused, never posted."""


def _m(x) -> float:
    return round(float(x or 0), 2)


def dr(code: str, amount, memo: str = "", currency: str = "EUR") -> dict:
    """A debit line."""
    return {"account": coa.label(code), "code": code, "debit": _m(amount),
            "credit": 0.0, "currency": currency, "memo": memo}


def cr(code: str, amount, memo: str = "", currency: str = "EUR") -> dict:
    """A credit line."""
    return {"account": coa.label(code), "code": code, "debit": 0.0,
            "credit": _m(amount), "currency": currency, "memo": memo}


@dataclass
class Entry:
    id: str
    kind: str
    lines: list[dict]
    memo: str = ""
    event_date: date | None = None
    source_ref: str | None = None
    period_id: str | None = None
    reverses: str | None = None
    currency: str = "EUR"
    _meta: dict = field(default_factory=dict)


def imbalance(lines: list[dict]) -> dict[str, float]:
    """Per-currency (Σdebit − Σcredit). All zero ⇒ balanced."""
    out: dict[str, float] = {}
    for ln in lines:
        c = ln.get("currency", "EUR")
        out[c] = round(out.get(c, 0.0) + _m(ln.get("debit")) - _m(ln.get("credit")), 2)
    return out


def is_balanced(lines: list[dict]) -> bool:
    return all(abs(v) < CENT for v in imbalance(lines).values())


def _now() -> datetime:
    return datetime.now(timezone.utc)


def post(entry: Entry, *, actor: str = "accounting") -> dict:
    """Post a balanced entry to the ledger (idempotent on id). Refuses — raises
    Unbalanced — if debits != credits. Writes as the gateway role + audits."""
    if not entry.lines:
        return {"skipped": "empty", "id": entry.id}
    if not is_balanced(entry.lines):
        raise Unbalanced(f"{entry.id}: debits != credits {imbalance(entry.lines)}")

    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO golden.journal_entry "
                "(id, period_id, lines, source_work_item, posted_by, kind, memo, event_date, "
                " source_ref, reverses) "
                "VALUES (%s,%s,%s,%s,'gateway',%s,%s,%s,%s,%s) "
                "ON CONFLICT (id) DO NOTHING RETURNING id",
                (entry.id, entry.period_id, Json(entry.lines), entry._meta.get("work_item"),
                 entry.kind, entry.memo, entry.event_date, entry.source_ref, entry.reverses))
            inserted = cur.fetchone() is not None
            if inserted:
                cur.execute(
                    "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, diff) "
                    "VALUES (%s,%s,%s,%s,true,%s,%s)",
                    (_now(), actor, "reverse_entry" if entry.reverses else "post_entry",
                     entry.id, entry.memo or entry.kind,
                     Json({"kind": entry.kind, "lines": entry.lines,
                           "reverses": entry.reverses})))
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "id": entry.id, "posted": inserted, "kind": entry.kind,
            "balanced": True}


def post_many(entries: list[Entry], *, actor: str = "accounting") -> dict:
    """Post many entries over ONE gateway connection (the books-build path). Each is
    balance-checked; an unbalanced entry is skipped and reported, never written."""
    posted = skipped = unbalanced = 0
    rejected: list[str] = []
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            for e in entries:
                if not e.lines:
                    skipped += 1
                    continue
                if not is_balanced(e.lines):
                    unbalanced += 1
                    rejected.append(e.id)
                    continue
                cur.execute(
                    "INSERT INTO golden.journal_entry "
                    "(id, period_id, lines, source_work_item, posted_by, kind, memo, event_date, "
                    " source_ref, reverses) VALUES (%s,%s,%s,%s,'gateway',%s,%s,%s,%s,%s) "
                    "ON CONFLICT (id) DO NOTHING RETURNING id",
                    (e.id, e.period_id, Json(e.lines), e._meta.get("work_item"), e.kind,
                     e.memo, e.event_date, e.source_ref, e.reverses))
                if cur.fetchone() is not None:
                    posted += 1
                    cur.execute(
                        "INSERT INTO work.audit_log (at, actor, action, subject, allowed, reason, diff) "
                        "VALUES (%s,%s,'post_entry',%s,true,%s,%s)",
                        (_now(), actor, e.id, e.memo or e.kind,
                         Json({"kind": e.kind, "lines": e.lines})))
        conn.commit()
    finally:
        conn.close()
    return {"posted": posted, "skipped": skipped, "unbalanced": unbalanced,
            "rejected": rejected, "n": len(entries)}


def _read_entry(entry_id: str) -> dict | None:
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, lines, memo, event_date, source_ref, kind FROM "
                        "golden.journal_entry WHERE id=%s", (entry_id,))
            r = cur.fetchone()
            if not r:
                return None
            return {"id": r[0], "lines": r[1], "memo": r[2], "event_date": r[3],
                    "source_ref": r[4], "kind": r[5]}
    finally:
        conn.close()


def reverse(entry_id: str, reason: str, *, actor: str = "accounting") -> dict:
    """Cancel an entry by posting its mirror image (debits↔credits), linked via
    `reverses`. The original row is left untouched — you never delete the books."""
    orig = _read_entry(entry_id)
    if orig is None:
        return {"error": f"no entry {entry_id}"}
    swapped = [{**ln, "debit": _m(ln.get("credit")), "credit": _m(ln.get("debit"))}
               for ln in (orig["lines"] or [])]
    rev = Entry(id=f"{entry_id}~rev", kind="reversal", lines=swapped,
                memo=f"reversal of {entry_id}: {reason}", event_date=orig.get("event_date"),
                source_ref=orig.get("source_ref"), reverses=entry_id)
    return post(rev, actor=actor)


def reverse_and_repost(entry_id: str, corrected: Entry, reason: str,
                       *, actor: str = "accounting") -> dict:
    """Closed-period correction, the lawful way: reverse the wrong entry, then post
    the corrected one (tagged as correcting the original). Returns both results."""
    r1 = reverse(entry_id, reason, actor=actor)
    corrected._meta["corrects"] = entry_id
    corrected.memo = (corrected.memo + f"  [corrects {entry_id}]").strip()
    r2 = post(corrected, actor=actor)
    return {"reversal": r1, "repost": r2}
