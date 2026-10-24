"""Build 1 — the environment: systems of record -> one shape, statefully, and a
work item per bank line. (Hyphenate deck, slides 15 + 17: "sync creates a work
item per bank line".)

Change-only sync with a cursor per source, so a re-sync never duplicates. Stable
ids mean late bank posts re-read cleanly. Here the 'source' we materialize work
from is the golden bank feed: every *incoming* receipt that isn't yet reconciled
becomes a NEW work item for the agent to propose a match on.

The raw->standardised->golden landing itself is done by the world generator (every
golden row already carries raw_ref); this module demonstrates the cursor + the
work-item creation that the deck puts at the heart of Build 1."""

from __future__ import annotations

from psycopg.rows import dict_row

from ..db import connect
from .gateway import create_work_item
from .roles import SYNC

CURSOR_SOURCE = "workgen:bank-receipts"


def _cursor(cur) -> str:
    cur.execute("SELECT cursor FROM raw.sync_cursor WHERE source = %s", (CURSOR_SOURCE,))
    row = cur.fetchone()
    return row["cursor"] if row and row["cursor"] else "1970-01-01T00:00:00+00:00"


def _advance(source: str, cursor: str) -> None:
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO raw.sync_cursor (source, cursor, at) VALUES (%s,%s, now()) "
                "ON CONFLICT (source) DO UPDATE SET cursor = EXCLUDED.cursor, at = now()",
                (source, cursor))
        conn.commit()
    finally:
        conn.close()


def sync_bank_receipts(limit: int = 50) -> list[str]:
    """Create a work item per unreconciled incoming bank line past the cursor.
    Returns the ids created. Idempotent: re-running creates nothing new."""
    conn = connect("gateway")
    created: list[str] = []
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            since = _cursor(cur)
            cur.execute(
                "SELECT id, txn_time, amount, currency, memo, counterparty_iban "
                "FROM golden.bank_transaction "
                "WHERE direction = 'in' AND matched_installment_id IS NULL AND txn_time > %s "
                "ORDER BY txn_time LIMIT %s",
                (since, limit))
            rows = cur.fetchall()
    finally:
        conn.close()

    newest = None
    for r in rows:
        item_id = f"WI-{r['id']}"
        create_work_item(
            SYNC, item_id, "reconcile_receipt",
            {"txn_id": r["id"], "amount": float(r["amount"]), "currency": r["currency"],
             "memo": r["memo"], "counterparty_iban": r["counterparty_iban"]},
            reason=f"incoming receipt {r['currency']} {r['amount']} — needs a match")
        created.append(item_id)
        newest = r["txn_time"].isoformat()

    if newest:
        _advance(CURSOR_SOURCE, newest)
    return created
