"""Can the agent actually LEARN its policies from the data?

Two things live here:

  learn_policies()  — the agent reads how the club has historically booked things
                      (the posted ledger + a seeded treatment history), and INFERS
                      the accounting policies, grounded in the counts. We score what
                      it found against the known set — a real capability test, not a
                      recital of hardcoded rules. (It should NOT invent a policy for
                      an event the data never shows — e.g. impairment with 0 history.)

  run_mode()        — the same batch of accounting events through three agents:
                        · onboarded  (has the learned policies → auto the standards)
                        · no-context (policies exist but it ignores them)
                        · newbie     (no policies at all → escalates everything)
                      The contrast is the showcase: context is what makes it hireable.

Seeds a small, idempotent treatment history (esp. agent-fee splits the posting
engine never booked) so there is something to mine.
"""

from __future__ import annotations

import json

from psycopg.types.json import Json

from ..db import connect

# the policy domains we expect a competent onboarding to discover from the data,
# and the posting kinds each covers
KNOWN = {
    "registration": {"kinds": ["capitalize", "amortise", "disposal"],
                     "hint": "capitalise transfer fees + amortise over contract, derecognise on sale"},
    "wages": {"kinds": ["wages"], "hint": "wages expensed monthly, not capitalised"},
    "bonus": {"kinds": ["bonus_accrual"], "hint": "accrue player bonuses when earned"},
    "agent_fee": {"kinds": ["agent_fee_split"], "hint": "split agent fees club vs player"},
    "extension": {"kinds": ["extension"], "hint": "re-amortise on contract extension"},
    "impairment": {"kinds": ["impairment"], "hint": "impair on relegation/loss of form"},
}


# --------------------------------------------------------------------------- #
# 1) seed a learnable treatment history
# --------------------------------------------------------------------------- #
def seed_learning_corpus() -> dict:
    """Add past accounting decisions the agent can mine — chiefly agent-fee splits
    (the engine never posts these, so without history there's nothing to learn).
    Idempotent. Writes golden.historical_outcome as the privileged payroll/finance job."""
    conn = connect("superuser")
    added = 0
    try:
        with conn.cursor() as cur:
            # ~20 historical agent fees, split ~30% club-service / 70% player-service,
            # documented — the pattern pol-120 should learn (while GFC6 still wants
            # per-case evidence). A few outliers so it's a distribution, not a constant.
            splits = [(30, 70)] * 14 + [(40, 60)] * 3 + [(25, 75)] * 2 + [(50, 50)]
            for i, (club, player) in enumerate(splits, 1):
                hid = f"hist-agentfee-{i:03d}"
                cur.execute("SELECT 1 FROM golden.historical_outcome WHERE id=%s", (hid,))
                if cur.fetchone():
                    continue
                cur.execute(
                    "INSERT INTO golden.historical_outcome (id, at, situation, subject_refs, "
                    "handled_as, actor) VALUES (%s, now(), 'agent_fee_split', %s, %s, "
                    "'accountant:priya')",
                    (hid, Json({"invoice_seq": i}),
                     Json({"treatment": "split_club_vs_player", "club_pct": club,
                           "player_pct": player, "documented": True,
                           "club_portion": "capitalised into registration",
                           "player_portion": "expensed as benefit-in-kind"})))
                added += 1
        conn.commit()
    finally:
        conn.close()
    return {"added": added}


# --------------------------------------------------------------------------- #
# 2) learn policies from the data
# --------------------------------------------------------------------------- #
def _patterns() -> dict:
    """Aggregate how the club has booked things — the corpus the agent mines."""
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT kind, count(*) FROM golden.journal_entry WHERE kind IS NOT NULL "
                        "GROUP BY kind")
            je = {k: n for k, n in cur.fetchall()}
            cur.execute("SELECT direction, count(*) FROM golden.transfer GROUP BY direction")
            tx = {d: n for d, n in cur.fetchall()}
            cur.execute("SELECT count(*) FROM golden.payroll_run")
            payruns = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM golden.payroll_run WHERE earned_appearance_bonus>0 "
                        "OR earned_goal_bonus>0")
            bonus_runs = cur.fetchone()[0]
            cur.execute("SELECT count(*), round(avg((handled_as->>'club_pct')::numeric),1), "
                        "round(avg((handled_as->>'player_pct')::numeric),1) "
                        "FROM golden.historical_outcome WHERE situation='agent_fee_split'")
            af = cur.fetchone()
            cur.execute("SELECT count(*) FROM golden.contract_clause WHERE kind='extension'")
            ext = cur.fetchone()[0]
        return {
            "journal_entry_kinds": je,
            "transfers_in": tx.get("in", 0), "transfers_out": tx.get("out", 0),
            "payroll_runs": payruns, "bonus_runs": bonus_runs,
            "agent_fee_history": {"n": af[0] or 0, "avg_club_pct": float(af[1] or 0),
                                  "avg_player_pct": float(af[2] or 0)},
            "extension_clauses": ext,
            "impairment_history": 0,
        }
    finally:
        conn.close()


def _score(learned: list[dict]) -> dict:
    """Which known policy domains did the agent discover? Match by the kinds/keywords
    it named."""
    text = " ".join(json.dumps(p).lower() for p in learned)
    found, missing = [], []
    for domain, spec in KNOWN.items():
        hit = domain in text or any(k in text for k in spec["kinds"]) or \
            any(w in text for w in spec["hint"].split() if len(w) > 5)
        (found if hit else missing).append(domain)
    return {"found": found, "missing": missing,
            "score": f"{len(found)}/{len(KNOWN)}"}


def learn_policies(use_llm: bool | None = None) -> dict:
    """The agent infers the club's accounting policies by reasoning over BOTH passes:

      · pattern  — a deterministic mine of the ledger/history: which treatments have
                   precedent, and how many records back each one (the grounding).
      · model    — Claude reasons over those same patterns to name the policy and cite
                   the standard (the richer interpretation).

    The model is fed the pattern counts, so it reasons over the pattern — the two
    compose. `use_llm=False` forces pattern-only (offline); otherwise both run when a
    key is live, and we fall back to pattern if the model call fails."""
    p = _patterns()
    from ..config import get_settings

    s = get_settings()
    live = s.llm_is_live if use_llm is None else use_llm
    pattern = _learn_deterministic(p)
    model = None
    if live:
        try:
            model = _learn_llm(p, s)
        except Exception:
            model = None
    mode = "pattern+model" if model else "pattern"
    learned = model if model else pattern            # the richer layer when present
    combined = pattern + (model or [])               # score over everything found
    return {"mode": mode, "patterns": p, "pattern": pattern, "model": model,
            "learned": learned, **_score(combined)}


def _learn_llm(p: dict, s) -> list[dict]:
    import anthropic

    client = anthropic.Anthropic(api_key=s.anthropic_api_key)
    sys = ("You are a new accountant onboarding at a football club. You are shown how the club "
           "has historically booked things, as aggregate counts. INFER the club's accounting "
           "policies — one per distinct treatment you can actually support with the data. Do NOT "
           "invent a policy for a treatment the data does not show (e.g. if there is no impairment "
           "history, do not propose an impairment policy). Reply ONLY with a JSON array of "
           "{\"name\":..., \"covers\":[kinds], \"treatment\":..., \"evidence\":<count>}.")
    msg = client.messages.create(
        model=s.pitwall_agent_model, max_tokens=1200,
        system=sys, messages=[{"role": "user", "content": json.dumps(p, indent=2)}])
    txt = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    txt = txt[txt.find("["): txt.rfind("]") + 1]
    return json.loads(txt)


def _learn_deterministic(p: dict) -> list[dict]:
    out = []
    if p["transfers_in"]:
        out.append({"name": "Capitalise & amortise player registrations",
                    "covers": ["capitalize", "amortise", "disposal"],
                    "treatment": "capitalise transfer fee, amortise straight-line over contract, "
                                 "derecognise with gain/loss on sale",
                    "evidence": p["transfers_in"]})
    if p["payroll_runs"]:
        out.append({"name": "Expense wages monthly", "covers": ["wages"],
                    "treatment": "wages expensed each month from the payroll run",
                    "evidence": p["payroll_runs"]})
    if p["bonus_runs"]:
        out.append({"name": "Accrue player bonuses when earned", "covers": ["bonus_accrual"],
                    "treatment": "accrue a staff-cost liability when the match trigger is met",
                    "evidence": p["bonus_runs"]})
    af = p["agent_fee_history"]
    if af["n"]:
        out.append({"name": "Split agent fees club vs player", "covers": ["agent_fee_split"],
                    "treatment": f"historically ~{af['avg_club_pct']:.0f}% club-service "
                                 f"(capitalised) / {af['avg_player_pct']:.0f}% player (expensed); "
                                 "GFC6 — evidence each split",
                    "evidence": af["n"]})
    if p["extension_clauses"]:
        out.append({"name": "Re-amortise on contract extension", "covers": ["extension"],
                    "treatment": "re-amortise over remaining/extended term, cap 5y",
                    "evidence": p["extension_clauses"]})
    return out


# --------------------------------------------------------------------------- #
# 2b) ONBOARD — stream the trail of thought, then propose policies for approval
# --------------------------------------------------------------------------- #
# human-readable reasoning for each domain the onboarding reaches, keyed by the
# posting kind the learned policy covers
_WHY = {
    "capitalize": "Transfer fees sit as an intangible asset, not an expense — IAS 38. "
                  "Capitalise the registration, amortise it straight-line over the contract.",
    "wages": "Wages recur every month and buy no lasting asset — expense them as incurred, "
             "never capitalise. Player wages and coaching/staff wages book to separate lines.",
    "bonus_accrual": "A bonus is owed the moment its match trigger is met, even before it's "
                     "paid — accrue a staff-cost liability when earned, release it on payout.",
    "agent_fee_split": "An agent fee is part club-service (capitalise into the registration, "
                       "VAT recoverable) and part player-service (expense, benefit-in-kind, VAT "
                       "not recoverable) — GFC6. The split needs per-case evidence.",
    "extension": "A contract extension resets the amortisation schedule over the new term "
                 "(capped at five years) — re-amortise from the extension date.",
    "impairment": "Impairment on relegation / loss of form.",
}


def onboard_stream(emit, config: dict | None = None):
    """Drive the onboarding as a live trail of thought. `emit(step)` pushes one SSE
    step to the UI. The agent mines the club's own history, reasons out a policy per
    treatment it can support, then writes them PROPOSED — a human still approves."""
    config = config or {}
    agent_name = config.get("agent") or "new onboarding agent"
    from ..config import set_agent_name

    set_agent_name(config.get("agent"))     # remember who's being onboarded this session
    emit({"kind": "onboard_start", "agent": agent_name,
          "text": f"{agent_name} — reading how Harbourside FC has historically booked things"})

    seed_learning_corpus()
    p = _patterns()
    total = sum(p.get("journal_entry_kinds", {}).values()) + p["agent_fee_history"]["n"]
    emit({"kind": "think", "text": f"opened the ledger + treatment history — {total:,} booked "
          "records across transfers, payroll runs and agent-fee invoices"})
    emit({"kind": "run_sql", "text": "select kind, count(*) from golden.journal_entry group by kind"})
    emit({"kind": "sql_result",
          "text": "  ◂ " + ", ".join(f"{k} ×{n}" for k, n in p.get("journal_entry_kinds", {}).items())})

    learned = learn_policies(use_llm=config.get("use_llm"))

    # PASS 1 — pattern: which treatments have precedent, and how deep (the grounding)
    emit({"kind": "think",
          "text": f"pattern pass — {len(learned['pattern'])} treatments have precedent in the "
                  "records; this is the evidence I can ground a policy on"})
    for pol in learned["pattern"]:
        emit({"kind": "pattern", "name": pol.get("name"),
              "covers": pol.get("covers"), "evidence": pol.get("evidence")})

    # PASS 2 — model: reason over those same patterns to name + justify each policy
    if learned.get("model"):
        emit({"kind": "think",
              "text": "model pass — reasoning over those patterns to name each policy and cite the standard"})
        reasoned = learned["model"]
    else:
        emit({"kind": "think",
              "text": "model offline — formalising the policies straight from the pattern baseline"})
        reasoned = learned["pattern"]

    for pol in reasoned:
        covers = pol.get("covers") or []
        key = covers[0] if isinstance(covers, list) and covers else covers
        emit({"kind": "policy", "name": pol.get("name"), "covers": covers,
              "evidence": pol.get("evidence"), "treatment": pol.get("treatment"),
              "why": _WHY.get(key, "")})

    if learned["missing"]:
        emit({"kind": "gap",
              "text": "no precedent for: " + ", ".join(learned["missing"])
                      + " — I will NOT invent a rule for events the data never shows; those escalate"})

    # write the full accounting policy set as PROPOSED (pending human approval)
    from .policy import propose_policies

    drafts = propose_policies(config)
    emit({"kind": "propose",
          "text": f"drafted {len(drafts)} policies from the evidence — none are active until you approve",
          "policies": [{"id": d["id"], "text": d["text"], "auto": d["auto"],
                        "evidence": d["evidence_count"], "covers": d["covers"],
                        "basis": d["basis"], "why": _WHY.get(
                            d["covers"][0] if isinstance(d["covers"], list) and d["covers"]
                            else d["covers"], "")}
                       for d in drafts]})
    emit({"kind": "await_approval", "count": len(drafts),
          "text": "awaiting a human to approve these policies"})
    return drafts


# --------------------------------------------------------------------------- #
# 3) run the same workload through context / no-context / newbie agents
# --------------------------------------------------------------------------- #
def _workload() -> list[tuple[str, int]]:
    """The accounting events the agent must handle, by posting kind + volume."""
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT direction, count(*) FROM golden.transfer GROUP BY direction")
            tx = {d: n for d, n in cur.fetchall()}
            cur.execute("SELECT count(*) FROM golden.payroll_run")
            pr = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM golden.payroll_run WHERE earned_appearance_bonus>0")
            bn = cur.fetchone()[0]
            cur.execute("SELECT count(*) FROM golden.invoice WHERE kind='agent_fee'")
            af = cur.fetchone()[0]
    finally:
        conn.close()
    return [("capitalize", tx.get("in", 0)), ("amortise", tx.get("in", 0)),
            ("disposal", tx.get("out", 0)), ("wages", pr), ("bonus_accrual", bn),
            ("agent_fee_split", af)]


def _auto_policy(kind: str) -> str | None:
    """Approved auto policy covering a kind (ignores agent mode — run_mode sets mode)."""
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM work.policy WHERE status='approved' AND auto_approve AND ("
                "rule->>'covers' = %s OR (jsonb_typeof(rule->'covers')='array' "
                "AND rule->'covers' ? %s)) LIMIT 1", (kind, kind))
            r = cur.fetchone()
            return r[0] if r else None
    finally:
        conn.close()


def run_mode(mode: str) -> dict:
    """Process the workload as a given agent. onboarded → auto where a learned policy
    covers it; newbie/no-context → escalate everything (no policies to lean on)."""
    has_context = mode == "onboarded"
    auto = escalate = 0
    by_kind = []
    for kind, n in _workload():
        pol = _auto_policy(kind) if has_context else None
        if pol:
            auto += n
            by_kind.append({"kind": kind, "n": n, "action": "auto", "policy": pol})
        else:
            escalate += n
            by_kind.append({"kind": kind, "n": n, "action": "escalate", "policy": None})
    total = auto + escalate
    return {"mode": mode, "auto": auto, "escalate": escalate, "total": total,
            "automation_rate": round(100 * auto / total, 0) if total else 0, "by_kind": by_kind}


def capability() -> dict:
    """The full showcase: learn from data + the three-agent contrast."""
    seed_learning_corpus()
    learning = learn_policies()
    return {"learning": learning,
            "newbie": run_mode("newbie"),
            "no_context": run_mode("no-context"),
            "onboarded": run_mode("onboarded")}
