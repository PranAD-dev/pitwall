-- 22_player_finance.sql — deep per-player finance.
--
-- Operational, player-level money the agent can see and reason about:
--   · player.status / leaving_date  — is the player active, leaving, departed, suspended?
--   · player_wage_run               — per player, per month: WAS the wage paid? (status only —
--                                      the salary AMOUNT stays sealed in payroll_private)
--   · player_obligation             — what we still OWE a player (outstanding AP): unpaid
--                                      wages, bonuses, agent fees, image rights, loyalty — the
--                                      stuff you must settle before (or chase after) they leave.
--
-- The confidential comp RATE stays in payroll_private (agent denied). The PAYMENT STATUS and
-- the OUTSTANDING AP are operational — the agent needs them to do its job.

ALTER TABLE golden.player ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';   -- active|leaving|departed|suspended
ALTER TABLE golden.player ADD COLUMN IF NOT EXISTS leaving_date date;

CREATE TABLE IF NOT EXISTS golden.player_wage_run (
  id          text PRIMARY KEY,
  player_id   text NOT NULL,
  month       text NOT NULL,                      -- 'YYYY-MM'
  status      text NOT NULL DEFAULT 'paid',       -- paid | unpaid | pending | partial
  due_date    date,
  paid_at     date,
  currency    text DEFAULT 'EUR'
);
CREATE INDEX IF NOT EXISTS ix_wage_run_player ON golden.player_wage_run(player_id);

CREATE TABLE IF NOT EXISTS golden.player_obligation (
  id          text PRIMARY KEY,
  player_id   text NOT NULL,
  kind        text NOT NULL,                      -- wage | bonus | agent_fee | image_rights | loyalty | signing
  amount      numeric,
  currency    text DEFAULT 'EUR',
  status      text NOT NULL DEFAULT 'outstanding',-- outstanding | settled
  due_date    date,
  note        text
);
CREATE INDEX IF NOT EXISTS ix_obligation_player ON golden.player_obligation(player_id);

GRANT SELECT ON golden.player_wage_run, golden.player_obligation
  TO pitwall_agent, gateway, retrieval, voice_readonly, sync;
