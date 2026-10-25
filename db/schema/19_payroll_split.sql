-- 19 — split the payroll aggregate into player vs coaching/staff gross. The
-- Squad-Cost Ratio counts first-team wages + the head coach, not all staff, so the
-- books post player wages and staff wages to separate accounts — and the agent still
-- never sees an individual salary, only these two period totals.

ALTER TABLE golden.payroll_run
    ADD COLUMN IF NOT EXISTS player_gross numeric(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS staff_gross  numeric(14,2) NOT NULL DEFAULT 0;
