-- 10 — golden (canonical) tables. Every row carries raw_ref back to raw.raw_record.
-- Stable ids (md5(source|src_id)) so re-sync never duplicates.

-- ---- relational ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS golden.counterparty (
    id                  text PRIMARY KEY,
    name                text NOT NULL,
    kind                text NOT NULL CHECK (kind IN ('club','agent','sponsor','vendor')),
    country             text,
    verified_iban       text,
    iban_last_changed_at timestamptz,
    email_domain        text,
    raw_ref             text
);

CREATE TABLE IF NOT EXISTS golden.player (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    position      text,
    dob           date,
    nationality   text,
    raw_ref       text
    -- NOTE: no salary columns. Pay lives in payroll_private.salary.
);

CREATE TABLE IF NOT EXISTS golden.transfer (
    id                   text PRIMARY KEY,
    player_id            text REFERENCES golden.player(id),
    direction            text NOT NULL CHECK (direction IN ('in','out')),
    counterparty_id      text REFERENCES golden.counterparty(id),
    fee                  numeric(14,2) NOT NULL,
    currency             text NOT NULL,
    signed_at            timestamptz NOT NULL,
    contract_years       int NOT NULL,
    amortization_months  int NOT NULL,          -- changes on extension
    solidarity_applicable boolean NOT NULL DEFAULT false,
    sell_on_pct          numeric(5,2),          -- % owed to a previous club, if any
    sell_on_basis        text CHECK (sell_on_basis IN ('gross','profit','ambiguous')),
    status               text NOT NULL DEFAULT 'active',
    raw_ref              text
);

CREATE TABLE IF NOT EXISTS golden.installment (
    id               text PRIMARY KEY,
    transfer_id      text REFERENCES golden.transfer(id),
    seq              int NOT NULL,
    due_date         date NOT NULL,
    amount           numeric(14,2) NOT NULL,
    currency         text NOT NULL,
    status           text NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','invoiced','paid','held','disputed','short_paid')),
    paid_txn_id      text,       -- golden.bank_transaction.id once reconciled
    raw_ref          text
);

CREATE TABLE IF NOT EXISTS golden.contract_clause (
    id                  text PRIMARY KEY,
    contract_type       text NOT NULL CHECK (contract_type IN ('transfer','sponsor','player')),
    contract_id         text NOT NULL,
    kind                text NOT NULL,   -- addon_appearances|addon_goals|stays_up|europe_bonus|
                                         -- relegation_reduction|relegation_wage_cut|sell_on|
                                         -- obligation_to_buy|win_bonus
    params              jsonb NOT NULL DEFAULT '{}'::jsonb,
    competitions_counted text[],         -- which competitions trigger the add-on
    ambiguity_note      text,            -- non-null => must escalate, never auto-complete
    raw_ref             text
);

CREATE TABLE IF NOT EXISTS golden.invoice (
    id               text PRIMARY KEY,
    counterparty_id  text REFERENCES golden.counterparty(id),
    amount           numeric(14,2) NOT NULL,
    currency         text NOT NULL,
    claims_clause_id text,                -- clause the invoice claims against, if any
    transfer_id      text,
    issued_at        timestamptz NOT NULL,
    number           text,                -- counterparty invoice number (dupes reformat this)
    kind             text NOT NULL DEFAULT 'other'
                     CHECK (kind IN ('installment','addon','agent_fee','consultancy','other')),
    status           text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received','accepted','rejected','disputed','paid')),
    raw_ref          text
);

CREATE TABLE IF NOT EXISTS golden.sponsor_contract (
    id            text PRIMARY KEY,
    counterparty_id text REFERENCES golden.counterparty(id),
    season        text,
    base_amount   numeric(14,2),
    currency      text,
    owner_linked  boolean DEFAULT false,  -- flag for fair-value review
    raw_ref       text
);

CREATE TABLE IF NOT EXISTS golden.period (
    id          text PRIMARY KEY,         -- e.g. 2025-07
    start_date  date NOT NULL,
    end_date    date NOT NULL,
    status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed'))
);

CREATE TABLE IF NOT EXISTS golden.journal_entry (
    id              text PRIMARY KEY,
    period_id       text REFERENCES golden.period(id),
    posted_at       timestamptz NOT NULL DEFAULT now(),
    lines           jsonb NOT NULL,       -- [{account, debit, credit, currency, memo}]
    source_work_item text,
    posted_by       text NOT NULL DEFAULT 'gateway',
    raw_ref         text
);

-- 12 months of how past accountants handled things — the corpus self-learning
-- mines at onboarding (M2). Populated in a later generator pass.
CREATE TABLE IF NOT EXISTS golden.historical_outcome (
    id            text PRIMARY KEY,
    at            timestamptz NOT NULL,
    situation     text NOT NULL,          -- short tag e.g. 'incoming_short_solidarity'
    subject_refs  jsonb NOT NULL DEFAULT '{}'::jsonb,
    handled_as    jsonb NOT NULL,         -- how it was booked / actioned
    actor         text,                   -- which human
    raw_ref       text
);

-- Matchday + season ticket sales — the club's gate-receipt revenue line (a slice of
-- total revenue; feeds the forecast and the Revenue/Receivables seat). Deterministic,
-- loaded by scripts/seed_tickets_forecast.py (no full world-regen needed).
CREATE TABLE IF NOT EXISTS golden.ticket_sale (
    id            text PRIMARY KEY,
    kind          text NOT NULL CHECK (kind IN ('matchday','season')),
    season        text NOT NULL,                  -- e.g. '2025/26'
    match_id      text,                            -- null for season tickets
    matchday      date,                            -- fixture date (null for season)
    competition   text CHECK (competition IN ('league','cup','europe')),
    opponent      text,
    section       text NOT NULL,                   -- North Stand, Away End, Hospitality…
    qty           int NOT NULL,
    unit_price    numeric(10,2) NOT NULL,
    gross         numeric(14,2) NOT NULL,           -- qty * unit_price
    currency      text NOT NULL DEFAULT 'EUR',
    sold_at       date NOT NULL,
    raw_ref       text
);
CREATE INDEX IF NOT EXISTS ticket_sale_season_idx ON golden.ticket_sale (season, matchday);

-- The forecast system of record (deck slide 7's 5th system) — monthly projections the
-- agent can query and reconcile against. squad_cost_ratio is % of total revenue; the
-- league limit is 70% (mirrors pitwall.agent.forecast). Loaded by the same script.
CREATE TABLE IF NOT EXISTS golden.forecast_snapshot (
    id                text PRIMARY KEY,
    as_of             date NOT NULL,
    horizon           text NOT NULL,                -- e.g. 'FY2025/26'
    projected_cash    numeric(14,2) NOT NULL,
    revenue_ytd       numeric(14,2) NOT NULL,
    revenue_forecast  numeric(14,2) NOT NULL,       -- full-year total revenue
    wage_bill         numeric(14,2) NOT NULL,
    squad_cost_ratio  numeric(5,2) NOT NULL,         -- % of revenue (league limit 70)
    ticket_revenue    numeric(14,2) NOT NULL DEFAULT 0,
    note              text,
    raw_ref           text
);
CREATE INDEX IF NOT EXISTS forecast_as_of_idx ON golden.forecast_snapshot (as_of);

-- ---- hypertables (time-series) -------------------------------------------
CREATE TABLE IF NOT EXISTS golden.bank_transaction (
    id                   text NOT NULL,
    source               text NOT NULL,
    account              text NOT NULL,
    txn_time             timestamptz NOT NULL,
    amount               numeric(14,2) NOT NULL,   -- signed: + inbound, - outbound
    currency             text NOT NULL,
    memo                 text,
    counterparty_iban    text,
    direction            text CHECK (direction IN ('in','out')),
    matched_installment_id text,
    raw_ref              text,
    PRIMARY KEY (id, txn_time)
);

CREATE TABLE IF NOT EXISTS golden.match_event (
    id            text NOT NULL,
    match_id      text NOT NULL,
    competition   text NOT NULL,          -- league|cup|europe  (eligibility matters)
    player_id     text,
    event_time    timestamptz NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('appearance','goal','minutes','result')),
    value         numeric,                -- minutes, goal count, or result code
    season        text,
    raw_ref       text,
    PRIMARY KEY (id, event_time)
);

CREATE TABLE IF NOT EXISTS golden.fx_rate (
    pair    text NOT NULL,                -- e.g. 'EURGBP'
    at      timestamptz NOT NULL,
    rate    numeric(14,8) NOT NULL,
    PRIMARY KEY (pair, at)
);

SELECT create_hypertable('golden.bank_transaction', 'txn_time', if_not_exists => TRUE);
SELECT create_hypertable('golden.match_event',      'event_time', if_not_exists => TRUE);
SELECT create_hypertable('golden.fx_rate',          'at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS bank_txn_acct_idx ON golden.bank_transaction (account, txn_time DESC);
CREATE INDEX IF NOT EXISTS bank_txn_iban_idx ON golden.bank_transaction (counterparty_iban);
CREATE INDEX IF NOT EXISTS match_player_idx  ON golden.match_event (player_id, competition, event_time DESC);
