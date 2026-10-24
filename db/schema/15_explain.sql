-- 15 — the Explainer (M7). A saved narration plan per work item, plus the
-- "as-of" replay functions the voice agent uses so it only ever speaks what was
-- known at a past moment (the rewind). Read-only to the agent; only the gateway
-- appends explanations (the one door).

CREATE TABLE IF NOT EXISTS work.explanation (
    id            text PRIMARY KEY,
    work_item_id  text REFERENCES work.work_item(id),
    plan          jsonb NOT NULL,          -- validated scene list (grounded)
    as_of         timestamptz,             -- null = "now"
    recording_url text,                     -- MP4 egress (stretch)
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- State of a work item as of time t: the last allowed transition at/under t
-- whose diff recorded a to_state. Powers "only what was known then".
CREATE OR REPLACE FUNCTION work.work_item_state_as_of(p_subject text, t timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT a.diff->>'to_state'
    FROM work.audit_log a
    WHERE a.subject = p_subject
      AND a.allowed
      AND a.at <= t
      AND a.diff ? 'to_state'
    ORDER BY a.at DESC
    LIMIT 1;
$$;

-- Which policy version was in force at time t (valid_from <= t < valid_to).
CREATE OR REPLACE FUNCTION work.policy_version_as_of(p_policy text, t timestamptz)
RETURNS int LANGUAGE sql STABLE AS $$
    SELECT p.version
    FROM work.policy p
    WHERE p.id = p_policy
      AND p.status = 'approved'
      AND (p.valid_from IS NULL OR p.valid_from <= t)
      AND (p.valid_to   IS NULL OR t < p.valid_to)
    ORDER BY p.version DESC
    LIMIT 1;
$$;

-- Every work item's reconstructed state as of t (the dashboard "rewind").
CREATE OR REPLACE FUNCTION work.world_as_of(t timestamptz)
RETURNS TABLE (work_item_id text, state_as_of text) LANGUAGE sql STABLE AS $$
    SELECT w.id, work.work_item_state_as_of(w.id, t)
    FROM work.work_item w
    WHERE w.created_at <= t;
$$;
