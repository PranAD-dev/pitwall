"""The Final Whistle cascade — sporting results move money.

When a season's last result lands (relegation, European qualification, survival, a
finish position), many contracts can trigger at once. Structured data catches the
clauses whose `kind` the system already understands. But a contract can bury the
same economic trigger in bespoke prose the structured `kind` never captured — and
*that* is where money quietly leaks.

So for each result we run BOTH:
  1. the structured lookup (clauses whose recognized `kind` maps to this result), and
  2. a semantic Moss search over clause wording.

Any clause Moss surfaces whose `kind` the cascade does NOT recognize is flagged
NEEDS_INFO — "clause may be affected; wording unclassified" — and escalated through
the gateway, never auto-applied. This is a real catch: retrieval finds clauses the
structured data missed.
"""

from __future__ import annotations

from psycopg.rows import dict_row

from ..db import connect
from . import query as Q

# result type -> (natural-language trigger phrases, the structured kinds we recognize)
CASCADE = {
    "relegation": {
        "queries": ["relegation fee reduction", "drops to the second tier",
                    "fails to retain top-division status", "wages reduced if relegated"],
        "kinds": {"relegation_reduction", "relegation_wage_cut"},
    },
    "europe_qualification": {
        "queries": ["qualifies for Europe", "European competition qualification bonus"],
        "kinds": {"europe_bonus"},
    },
    "stays_up": {
        "queries": ["survival bonus", "stays up and avoids relegation",
                    "retains top-division status"],
        "kinds": {"stays_up"},
    },
    "finish_position": {
        "queries": ["final league position bonus", "finishing-place payment"],
        "kinds": {"win_bonus"},
    },
}

# The full structured clause vocabulary the system understands. A clause whose kind
# is NOT in here is "wording unclassified" — the system has no structured handling
# for it, so if Moss surfaces it for a result, a human must classify it.
KNOWN_CLAUSE_KINDS = {
    "addon_appearances", "addon_goals", "stays_up", "europe_bonus", "relegation_reduction",
    "relegation_wage_cut", "sell_on", "obligation_to_buy", "win_bonus", "extension",
}


def _structured(result_type: str) -> list[dict]:
    """Clauses whose recognized kind maps to this result (the easy half)."""
    kinds = CASCADE[result_type]["kinds"]
    if not kinds:
        return []
    conn = connect("retrieval")
    conn.row_factory = dict_row
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT id, kind, contract_id, contract_type FROM golden.contract_clause "
                "WHERE kind = ANY(%s)", (list(kinds),))
            return cur.fetchall()
    finally:
        conn.close()


def _kind_of(clause_id: str) -> str | None:
    conn = connect("retrieval")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT kind FROM golden.contract_clause WHERE id=%s", (clause_id,))
            r = cur.fetchone()
            return r[0] if r else None
    finally:
        conn.close()


def affected_clauses(result_type: str, *, min_score: float = 0.40) -> dict:
    """Union the structured lookup with Moss clause hits for one result. Returns:
      structured  — clauses the structured kinds already cover
      moss_only    — clauses Moss found that the structured lookup did NOT return
      needs_info   — the subset of moss_only whose kind is unrecognized (the catch)
    """
    if result_type not in CASCADE:
        raise ValueError(f"unknown result type {result_type!r}")
    structured = _structured(result_type)
    structured_ids = {c["id"] for c in structured}

    # semantic sweep over clause wording
    seen: dict[str, dict] = {}
    for phrase in CASCADE[result_type]["queries"]:
        for h in Q.find_clauses(phrase, top_k=5):
            if h["score"] < min_score:
                continue
            prev = seen.get(h["id"])
            if prev is None or h["score"] > prev["score"]:
                seen[h["id"]] = h

    moss_only, needs_info = [], []
    for cid, h in seen.items():
        if cid in structured_ids:
            continue  # already covered by the structured half
        kind = h["metadata"].get("clause_kind") or _kind_of(cid)
        entry = {"clause_id": cid, "kind": kind, "score": round(h["score"], 3),
                 "snippet": h["text"][:160],
                 "counterparty": h["metadata"].get("counterparty")}
        moss_only.append(entry)
        if kind not in KNOWN_CLAUSE_KINDS:  # Moss found it; system has no structured handling
            needs_info.append(entry)

    return {"result_type": result_type, "structured": structured,
            "moss_only": moss_only, "needs_info": needs_info}


def escalate_unclassified(result_type: str) -> list[dict]:
    """Run the cascade and raise a real, audited NEEDS_INFO work item for every
    unclassified clause (escalated to the controller — never auto-applied)."""
    from ..sow import gateway
    from ..sow.roles import AI_AGENT, SYNC

    res = affected_clauses(result_type)
    raised = []
    for item in res["needs_info"]:
        wi = f"WI-fw-{result_type}-{item['clause_id']}"
        gateway.create_work_item(
            SYNC, wi, "contract_review",
            {"clause_id": item["clause_id"], "result_type": result_type,
             "found_by": "moss", "clause_kind": item["kind"]},
            reason=f"final whistle ({result_type}): clause may be affected; wording unclassified")
        try:
            gateway.transition(
                AI_AGENT, wi, "propose",
                patch={"proposed_by": "ai_agent",
                       "proposal": {"action": "ESCALATE_UNCLASSIFIED_CLAUSE",
                                    "reason": f"Moss surfaced clause {item['clause_id']} for "
                                              f"'{result_type}' but its kind '{item['kind']}' is "
                                              f"not a recognized cascade trigger — wording "
                                              f"unclassified, do not auto-apply."},
                       "failing_check": "clause_kind_unrecognized"},
                reason="final-whistle semantic catch — escalating for human classification")
            gateway.transition(AI_AGENT, wi, "ask",
                               reason="escalated to human_controller: clause wording unclassified")
        except Exception:
            pass  # already past NEW on a re-run; the create above is idempotent
        raised.append({**item, "work_item": wi, "state": "NEEDS_INFO"})
    return raised


# --------------------------------------------------------------------------- #
# demo data: a bespoke clause whose relegation trigger hides in prose the
# structured `kind` never captured — this is what the catch finds. Idempotent.
# --------------------------------------------------------------------------- #
DEMO_CLAUSES = [
    {  # structured side: a normal, recognized relegation clause
        "id": "cl-fw-relegation-1", "contract_type": "transfer", "contract_id": "tr-in-vb",
        "kind": "relegation_reduction",
        "params": {"amount": 1500000,
                   "wording": "On relegation from the top division, the outstanding transfer "
                              "fee is reduced by EUR 1,500,000."},
        "competitions_counted": None, "ambiguity_note": None,
    },
    {  # the catch: economic relegation trigger buried under an unrecognized kind
        "id": "cl-fw-bespoke-1", "contract_type": "transfer", "contract_id": "tr-in-ext",
        "kind": "bespoke_relegation_terms",
        "params": {"amount": 1200000,
                   "wording": "Should the Club fail to retain its top-division status at the "
                              "conclusion of the season, EUR 1,200,000 of the agreed agent "
                              "commission shall be written off and the fee re-amortised."},
        "competitions_counted": None, "ambiguity_note": None,
    },
]


def seed_demo_clauses() -> list[str]:
    """Insert the bespoke final-whistle clauses into golden (idempotent). Returns the
    ids so the caller can (re)index them in Moss."""
    from psycopg.types.json import Json

    conn = connect("superuser")
    ids = []
    try:
        with conn.cursor() as cur:
            for c in DEMO_CLAUSES:
                cur.execute("SELECT 1 FROM golden.contract_clause WHERE id=%s", (c["id"],))
                if cur.fetchone():
                    ids.append(c["id"])
                    continue
                cur.execute(
                    "INSERT INTO golden.contract_clause (id, contract_type, contract_id, kind, "
                    "params, competitions_counted, ambiguity_note) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (c["id"], c["contract_type"], c["contract_id"], c["kind"], Json(c["params"]),
                     c["competitions_counted"], c["ambiguity_note"]))
                ids.append(c["id"])
        conn.commit()
    finally:
        conn.close()
    return ids
