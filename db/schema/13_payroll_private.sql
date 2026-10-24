-- 13 — private payroll. Pit Wall computes bonus accruals from clauses + match
-- events and hands them to the human payroll seat; it must NEVER read salaries.
-- Enforced by withholding schema USAGE from pitwall_agent (see 20_grants.sql).
CREATE TABLE IF NOT EXISTS payroll_private.salary (
    player_id   text PRIMARY KEY,
    base_wage   numeric(14,2) NOT NULL,
    currency    text NOT NULL,
    bonuses     jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- Non-playing staff pay — same wall as player salary (agent denied). The agent only
-- ever sees the aggregate wage bill in golden.payroll_cost.
CREATE TABLE IF NOT EXISTS payroll_private.staff_salary (
    staff_id   text PRIMARY KEY,
    base_wage  numeric(14,2) NOT NULL,
    currency   text NOT NULL,
    bonuses    jsonb NOT NULL DEFAULT '{}'::jsonb
);
