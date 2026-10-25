-- 21_amendments.sql — contract amendments.
--
-- A single deal (golden.transfer.id) is the UID that links the player registration,
-- the agent fee (capitalised INTO that registration), the installment schedule and the
-- clauses. When the contract is modified, the financial events that hang off that deal
-- have to change too — correctly, and without editing a closed period. This table is
-- the modification EVENT; the cascade engine (pitwall/accounting/amend.py) turns it into
-- linked reverse+repost journal entries, and escalates the legs it must not guess.

CREATE TABLE IF NOT EXISTS golden.contract_amendment (
  id             text PRIMARY KEY,
  deal_id        text NOT NULL,        -- the transfer UID (links player + agent fee + clauses)
  kind           text NOT NULL,        -- extension | fee_renegotiation | early_termination | add_clause
  effective_date date NOT NULL,
  params         jsonb NOT NULL DEFAULT '{}',
  before         jsonb,
  after          jsonb,
  status         text NOT NULL DEFAULT 'pending',   -- pending | applied | escalated
  applied_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  raw_ref        text
);
CREATE INDEX IF NOT EXISTS ix_amendment_deal ON golden.contract_amendment(deal_id);

-- app roles read it; the gateway (the one ledger writer) records + marks it applied
GRANT SELECT ON golden.contract_amendment TO pitwall_agent, retrieval, voice_readonly, sync;
GRANT SELECT, INSERT, UPDATE ON golden.contract_amendment TO gateway;
