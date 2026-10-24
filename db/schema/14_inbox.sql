-- 14 — inbox (counterparty emails). The fraud scenario lives here: a lookalike
-- domain emails a "change of bank details" just before an installment is due.
CREATE TABLE IF NOT EXISTS golden.inbox_message (
    id                   text PRIMARY KEY,
    received_at          timestamptz NOT NULL,
    from_name            text,
    from_domain          text,
    subject              text,
    body                 text,
    counterparty_id      text REFERENCES golden.counterparty(id),
    claims_new_iban      text,           -- non-null => asserts a new payee IBAN
    about_installment_id text,
    raw_ref              text
);
CREATE INDEX IF NOT EXISTS inbox_cp_idx ON golden.inbox_message (counterparty_id, received_at DESC);
