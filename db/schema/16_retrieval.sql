-- 16 — retrieval (Moss) support tables. Moss itself lives in its cloud; these two
-- tables are the Tiger-side bookkeeping: a durable outbox so a Moss outage never
-- blocks a finance write, and a metric hypertable for the latency story.
--
-- Moss is NOT a system of record. Nothing here is golden truth — it is the queue
-- and the stopwatch for the index that points back at golden/work ids.

-- Durable retry queue. The gateway's after-commit hook enqueues a (kind, tiger_id)
-- here when Moss is unreachable; `pitwall retrieval outbox` drains it later. Owned
-- by the least-privilege `retrieval` role (its own scratch space, not a record).
CREATE TABLE IF NOT EXISTS work.moss_outbox (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind        text NOT NULL,              -- clauses|policies|decisions|precedents|questions
    tiger_id    text NOT NULL,              -- the golden/work primary key to reindex
    op          text NOT NULL DEFAULT 'upsert' CHECK (op IN ('upsert','delete')),
    enqueued_at timestamptz NOT NULL DEFAULT now(),
    attempts    int NOT NULL DEFAULT 0,
    last_error  text,
    done_at     timestamptz                 -- set when the (re)index finally succeeds
);
CREATE INDEX IF NOT EXISTS moss_outbox_pending_idx
    ON work.moss_outbox (enqueued_at) WHERE done_at IS NULL;

-- Latency evidence for judges: one row per Moss query (worker agent + voice), plus
-- the full voice turn (question-end → first audio). Hypertable on `at` so p50/p95
-- come straight out of TimescaleDB like everything else time-series here.
CREATE TABLE IF NOT EXISTS work.retrieval_metric (
    id            uuid NOT NULL DEFAULT gen_random_uuid(),
    at            timestamptz NOT NULL DEFAULT now(),
    surface       text NOT NULL,            -- worker | voice | eval
    index_name    text NOT NULL,
    query_kind    text,                     -- find_clauses | resolve_reference | ...
    retrieval_ms  int NOT NULL,             -- Moss-reported time_taken_ms
    full_turn_ms  int,                      -- voice: question-end → first audio
    top_k         int,
    hit_count     int,
    top_score     numeric(6,4),
    work_item_id  text,
    PRIMARY KEY (id, at)
);
SELECT create_hypertable('work.retrieval_metric', 'at', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS retrieval_metric_surface_idx
    ON work.retrieval_metric (surface, at DESC);
