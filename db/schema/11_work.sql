-- 11 — the System of Work. Work items, versioned policy, precedents, questions,
-- the append-only audit log, and x402 evidence purchases.

CREATE TABLE IF NOT EXISTS work.work_item (
    id                text PRIMARY KEY,
    kind              text NOT NULL,      -- pay_installment|collect_receivable|addon_claim|...
    state             text NOT NULL DEFAULT 'NEW',
    subject_refs      jsonb NOT NULL DEFAULT '{}'::jsonb,
    proposal          jsonb,
    proposed_by       text,
    approved_by       text,
    evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
    confidence_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
    failing_check     text,               -- the hard check that forced escalation, if any
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_item_state_idx ON work.work_item (state);

-- Versioned policy; never edited in place. valid_from/valid_to drive as-of replay.
CREATE TABLE IF NOT EXISTS work.policy (
    id            text NOT NULL,
    version       int  NOT NULL,
    rule          jsonb NOT NULL,
    text          text NOT NULL,
    evidence_count int NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'proposed'
                  CHECK (status IN ('proposed','approved','rejected')),
    auto_approve  boolean NOT NULL DEFAULT false,  -- gateway may approve-on-policy
    approved_by   text,
    valid_from    timestamptz,
    valid_to      timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS work.precedent (
    id            text PRIMARY KEY,
    work_item_id  text REFERENCES work.work_item(id),
    situation     text,                   -- tag used to find "similar" corrections
    correction    jsonb NOT NULL,
    actor         text NOT NULL,
    at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS work.question (
    id            text PRIMARY KEY,
    work_item_id  text REFERENCES work.work_item(id),
    to_role       text NOT NULL,
    text          text NOT NULL,
    answer        text,
    answered_by   text,
    asked_at      timestamptz NOT NULL DEFAULT now(),
    answered_at   timestamptz,
    transcript_ref text                   -- voice call transcript, if any
);

-- Append-only audit log. Every transition writes one row in the SAME txn as the
-- change; denied attempts are logged with allowed=false. Hypertable on `at`.
CREATE TABLE IF NOT EXISTS work.audit_log (
    id             uuid NOT NULL DEFAULT gen_random_uuid(),
    at             timestamptz NOT NULL DEFAULT now(),
    actor          text NOT NULL,
    action         text NOT NULL,
    subject        text,
    allowed        boolean NOT NULL,
    reason         text,
    diff           jsonb,
    evidence       jsonb,
    policy_id      text,
    policy_version int,
    PRIMARY KEY (id, at)
);
SELECT create_hypertable('work.audit_log', 'at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS audit_subject_idx ON work.audit_log (subject, at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx   ON work.audit_log (actor, at DESC);

-- Hard append-only guarantee: block UPDATE/DELETE for everyone, even the owner.
CREATE OR REPLACE FUNCTION work.deny_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'append-only table %: % is forbidden', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_append_only ON work.audit_log;
CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON work.audit_log
    FOR EACH ROW EXECUTE FUNCTION work.deny_mutation();

-- Evidence bought via x402. Hypertable on `at`; links to work item + tx hash.
CREATE TABLE IF NOT EXISTS work.x402_payment (
    id             uuid NOT NULL DEFAULT gen_random_uuid(),
    at             timestamptz NOT NULL DEFAULT now(),
    tx_hash        text NOT NULL,
    network        text NOT NULL,
    seller         text NOT NULL,
    evidence_type  text NOT NULL,
    amount_usdc    numeric(12,6) NOT NULL,
    work_item_id   text,
    request        jsonb,
    response       jsonb,
    simulated      boolean NOT NULL DEFAULT true,   -- honesty flag for the UI
    PRIMARY KEY (id, at)
);
SELECT create_hypertable('work.x402_payment', 'at', if_not_exists => TRUE);
