-- 18 — payroll run (the authorized aggregate).
--
-- Individual salaries live in payroll_private.salary / staff_salary, readable by NO
-- application role (the "limits in the DB" demo). A privileged payroll job aggregates
-- them — plus match-triggered performance bonuses — into this ONE per-period total.
-- The accounting agent books wages + bonus accruals from HERE, and so never sees a
-- single player's salary. (Watch it get `permission denied` on payroll_private.)

CREATE TABLE IF NOT EXISTS golden.payroll_run (
    id                       text PRIMARY KEY,            -- payrun-<period>
    period_id                text REFERENCES golden.period(id),
    currency                 text NOT NULL DEFAULT 'EUR',
    gross_wages              numeric(14,2) NOT NULL,       -- monthly gross (players + staff)
    earned_appearance_bonus  numeric(14,2) NOT NULL DEFAULT 0,
    earned_goal_bonus        numeric(14,2) NOT NULL DEFAULT 0,
    headcount                int,
    computed_at              timestamptz NOT NULL DEFAULT now()
);

-- the aggregate is readable by the accounting roles; the SOURCE (payroll_private)
-- stays denied to every one of them.
GRANT SELECT ON golden.payroll_run TO pitwall_agent, gateway, retrieval, voice_readonly;
