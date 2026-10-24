-- 20 — least-privilege grants. Limits live in the DATABASE, not the prompt.
-- Roles themselves are created by `pitwall db migrate` from .env passwords.

-- ---- schema usage --------------------------------------------------------
GRANT USAGE ON SCHEMA golden, work, raw TO sync;
GRANT USAGE ON SCHEMA golden, work TO pitwall_agent, gateway, voice_readonly;
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

-- ---- explicit denials that we demo on stage -------------------------------
-- Agent cannot touch salaries (no schema usage) or post to the ledger (no grant).
REVOKE ALL ON SCHEMA payroll_private FROM pitwall_agent, voice_readonly, sync;
REVOKE ALL ON ALL TABLES IN SCHEMA payroll_private FROM pitwall_agent, voice_readonly, sync;

-- Audit log is append-only: no role may UPDATE or DELETE (trigger is the backstop).
REVOKE UPDATE, DELETE ON work.audit_log FROM PUBLIC;
REVOKE UPDATE, DELETE ON work.audit_log FROM pitwall_agent, gateway, sync, voice_readonly;
GRANT INSERT, SELECT ON work.audit_log TO gateway;   -- gateway may only append + read
