-- 01 — schemas. The sync layering (raw -> standardised -> golden) and the two
-- special schemas (System of Work; private payroll the agent can never read).
CREATE SCHEMA IF NOT EXISTS raw;        -- landing: one row per source fact, with raw_ref
CREATE SCHEMA IF NOT EXISTS golden;     -- canonical, deduped business truth the agent reads
CREATE SCHEMA IF NOT EXISTS work;       -- the System of Work (ours): work items, policy, audit
CREATE SCHEMA IF NOT EXISTS payroll_private;  -- salaries; pitwall_agent gets NO usage here

-- Systems of record, each its own schema. The M1 sync reads these; M0 lands
-- canonical rows directly in golden with raw_ref lineage (see DECISIONS D-004).
CREATE SCHEMA IF NOT EXISTS sor_bank;
CREATE SCHEMA IF NOT EXISTS sor_ledger;
CREATE SCHEMA IF NOT EXISTS sor_contracts;
CREATE SCHEMA IF NOT EXISTS sor_matchdata;
CREATE SCHEMA IF NOT EXISTS sor_inbox;
