-- 17 — double-entry accounting support.
--
-- golden.journal_entry is the SYSTEM OF RECORD (the ledger). The System of Work
-- posts BALANCED entries into it through the one-door gateway, and may only correct
-- a CLOSED period by reverse + repost (never delete) — so these columns carry the
-- entry's kind, a human memo, the economic event date, a link back to the source
-- record, and `reverses` (the id of the entry a reversal cancels).

ALTER TABLE golden.journal_entry
    ADD COLUMN IF NOT EXISTS kind        text,       -- capitalize|pay|amortise|disposal|collect|…
    ADD COLUMN IF NOT EXISTS memo        text,
    ADD COLUMN IF NOT EXISTS event_date  date,       -- when the economic event happened
    ADD COLUMN IF NOT EXISTS source_ref  text,       -- the golden.* row this books
    ADD COLUMN IF NOT EXISTS reverses    text;        -- id of the entry this one reverses

CREATE INDEX IF NOT EXISTS je_kind_idx       ON golden.journal_entry (kind);
CREATE INDEX IF NOT EXISTS je_event_date_idx ON golden.journal_entry (event_date);
CREATE INDEX IF NOT EXISTS je_reverses_idx   ON golden.journal_entry (reverses);
