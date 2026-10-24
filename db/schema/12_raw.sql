-- 12 — raw landing + sync cursors. One row per source fact; golden rows point
-- back here via raw_ref. Stable raw_ref = md5(source|src_id) => idempotent re-sync.
CREATE TABLE IF NOT EXISTS raw.raw_record (
    raw_ref      text PRIMARY KEY,        -- md5(source|src_id)
    source       text NOT NULL,
    src_id       text NOT NULL,
    payload      jsonb NOT NULL,
    ingested_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS raw_record_source_idx ON raw.raw_record (source);

CREATE TABLE IF NOT EXISTS raw.sync_cursor (
    source  text PRIMARY KEY,
    cursor  text,
    at      timestamptz NOT NULL DEFAULT now()
);
