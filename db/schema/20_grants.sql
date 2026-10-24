-- 20 — least-privilege grants. Limits live in the DATABASE, not the prompt.
-- Roles themselves are created by `pitwall db migrate` from .env passwords.

-- ---- schema usage --------------------------------------------------------
GRANT USAGE ON SCHEMA golden, work, raw TO sync;
GRANT USAGE ON SCHEMA golden, work TO pitwall_agent, gateway, voice_readonly, retrieval;
-- payroll_private USAGE is deliberately granted to NO application role.

-- ---- pitwall_agent: read-only on golden + work, nothing else --------------
GRANT SELECT ON ALL TABLES IN SCHEMA golden TO pitwall_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA work   TO pitwall_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA golden GRANT SELECT ON TABLES TO pitwall_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA work   GRANT SELECT ON TABLES TO pitwall_agent;

-- ---- gateway: the ONLY writer of the ledger + work state ------------------
GRANT SELECT ON ALL TABLES IN SCHEMA golden TO gateway;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA work TO gateway;
GRANT INSERT ON golden.journal_entry TO gateway;
GRANT UPDATE (status, paid_txn_id) ON golden.installment TO gateway;
GRANT INSERT, UPDATE ON golden.invoice TO gateway;
-- the gateway materializes work from bank receipts and tracks its own sync cursor
GRANT USAGE ON SCHEMA raw TO gateway;
GRANT SELECT, INSERT, UPDATE ON raw.sync_cursor TO gateway;

-- ---- sync: writes the pipeline (raw -> golden) ----------------------------
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA raw    TO sync;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA golden TO sync;

-- ---- voice_readonly: read audit + work + golden only ----------------------
GRANT SELECT ON ALL TABLES IN SCHEMA work   TO voice_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA golden TO voice_readonly;

-- ---- retrieval (Moss indexer): read to build docs, write ONLY telemetry ----
-- It reads golden + work to build the index documents, and writes its own two
-- bookkeeping tables + its own audit rows. It can NOT post to the ledger, mark
-- installments, touch invoices, or read salaries — a Moss indexer that gets
-- popped still can't move a cent. Limits in the database, not the prompt.
GRANT SELECT ON ALL TABLES IN SCHEMA golden TO retrieval;
GRANT SELECT ON ALL TABLES IN SCHEMA work   TO retrieval;
ALTER DEFAULT PRIVILEGES IN SCHEMA golden GRANT SELECT ON TABLES TO retrieval;
ALTER DEFAULT PRIVILEGES IN SCHEMA work   GRANT SELECT ON TABLES TO retrieval;
-- its own scratch queue (may update/clear) + append-only metric stream
GRANT SELECT, INSERT, UPDATE, DELETE ON work.moss_outbox     TO retrieval;
GRANT SELECT, INSERT                 ON work.retrieval_metric TO retrieval;
-- may append its own informational audit rows (actor='retrieval'); the append-only
-- trigger still blocks any UPDATE/DELETE, same as every other writer
GRANT INSERT, SELECT ON work.audit_log TO retrieval;

-- ---- explicit denials that we demo on stage -------------------------------
-- Agent (and the Moss indexer) cannot touch salaries (no schema usage) or post to
-- the ledger (no grant). Payroll is never indexed and never readable off-record.
REVOKE ALL ON SCHEMA payroll_private FROM pitwall_agent, voice_readonly, sync, retrieval;
REVOKE ALL ON ALL TABLES IN SCHEMA payroll_private FROM pitwall_agent, voice_readonly, sync, retrieval;

-- Audit log is append-only: no role may UPDATE or DELETE (trigger is the backstop).
REVOKE UPDATE, DELETE ON work.audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE ON work.audit_log FROM pitwall_agent, gateway, sync, voice_readonly;
GRANT INSERT, SELECT ON work.audit_log TO gateway;   -- gateway may only append + read
