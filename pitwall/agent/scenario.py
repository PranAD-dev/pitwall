"""Free-scenario agent — the deck's slide 12, made real.

Type a plain-English scenario; watch the live trail:
  ai_agent think  →  ai_agent run_sql (recall history / locate the rows)
  →  ai_agent propose  →  [hard-check gate decides]  →  gateway posts  →  audit

Claude (opus-4-8) does PERCEPTION + NARRATION only: it reads the scenario, queries
the golden history read-only, locates the rows, and proposes a classification +
subject_refs. CODE then decides — `detectors.decide()` runs the hard checks and the
gateway posts the transition (so the 100%-precision guarantee is untouched; the LLM
never gets write access). Runs live when ANTHROPIC_API_KEY is set, with a
deterministic mock fallback so it works keyless.

Every trail step is streamed through an `emit(step)` callback, so the same engine
drives the terminal now and a websocket to the 3D screens later.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from psycopg.rows import dict_row

from ..config import get_settings
from ..db import connect
from . import detectors as D
from .run import KIND, process_case

# suggested quick-choices the human can tap in the Teamwork Terminal when the agent
# escalates a judgment call (free text is always allowed too)
_HITL_OPTIONS = {
    "ambiguous_sell_on": ["gross transfer-fee basis", "profit over book value"],
    "stale_fx_rate": ["book the FX difference as gain/loss", "hold — query the counterparty"],
    "addon_triggered_not_booked": ["approve the accrual", "reject — not yet probable"],
    "contract_extension_amortization": ["re-amortise over the new term", "keep the old schedule"],
    "incoming_short_unexplained": ["chase the balance", "write off the shortfall"],
    "duplicate_agent_fee": ["reject the duplicate", "pay it"],
    "fake_bank_detail_change": ["hold — do not release (confirmed fraud)", "release — it's legitimate", "verify with the counterparty first"],
    "legitimate_bank_detail_change": ["approve the new details", "hold — verify first"],
    "suspension_wage_withholding": ["keep paying — no withholding clause", "withhold per the clause (legal confirmed)", "wages stop — lawful termination"],
    "loan_to_buy_obligation": ["recognise the mandatory-purchase commitment", "hold — dispute the trigger", "monitor only"],
    "sporting_just_cause": ["open contract talks now", "accept the risk / sell in the window", "contest — player isn't established"],
}

ROOT = Path(__file__).resolve().parents[2]
ANSWER_KEY = ROOT / "world" / "out" / "answer_key.json"
MODEL = os.environ.get("PITWALL_REASONING_MODEL", "claude-opus-4-8")

# What subject_refs each known situation needs (mirrors detectors.decide()).
SITUATIONS = {
    "fake_bank_detail_change": ["installment_id", "inbox_id"],
    "legitimate_bank_detail_change": ["installment_id", "inbox_id"],
    "incoming_short_solidarity": ["installment_id", "txn_id"],
    "incoming_short_unexplained": ["installment_id", "txn_id"],
    "addon_invoiced_not_triggered": ["invoice_id"],
    "addon_triggered_not_booked": ["transfer_id", "clause_id"],
    "one_wire_many_items": ["txn_id", "installment_ids"],
    "duplicate_agent_fee": ["original_invoice_id", "duplicate_invoice_id"],
    "threshold_evasion_split": ["invoice_ids", "threshold"],
    "stale_fx_rate": ["installment_id", "txn_id"],
    "ambiguous_sell_on": ["sell_on_clause_id"],
    "contract_extension_amortization": ["clause_id"],
    "suspension_wage_withholding": ["player_id"],
    "loan_to_buy_obligation": ["clause_id"],
    "sporting_just_cause": ["player_id"],
}

SCHEMA_HINT = """golden.* tables (read-only) — the club's systems of record, synced into one shape:
  counterparty(id, name, kind[club|agent|sponsor|vendor], country, verified_iban, email_domain, iban_last_changed_at)
  transfer(id, player_id, direction[in|out], counterparty_id, fee, currency, signed_at, contract_years, solidarity_applicable)
  installment(id, transfer_id, due_date, amount, currency, status)
  bank_transaction(id, source, account, txn_time, amount, currency, memo, counterparty_iban)
  invoice(id, counterparty_id, transfer_id, amount, currency, number, claims_clause_id, issued_at)
  contract_clause(id, contract_type, contract_id, kind, params jsonb, competitions_counted, ambiguity_note)
  inbox_message(id, from_domain, claims_new_iban, subject, body)
  match_event(id, match_id, competition, player_id, event_time, kind, value)
  fx_rate(pair, at, rate) · sponsor_contract · journal_entry · period
  player(id, name, position, nationality, status[active|leaving|departed|suspended], leaving_date)
  player_wage_run(id, player_id, month 'YYYY-MM', status[paid|unpaid|pending|partial], due_date, paid_at)  -- did we pay this player that month? (amount is sealed in payroll_private)
  player_obligation(id, player_id, kind[wage|bonus|agent_fee|image_rights|loyalty|signing], amount, currency, status[outstanding|settled], due_date, note)  -- what we still OWE a player (e.g. on departure)
  historical_outcome(situation, ...)  -- 12 months of how past humans handled things
  ticket_sale(id, kind[matchday|season], season, match_id, matchday, competition, opponent, section, qty, unit_price, gross, currency)  -- gate-receipt revenue (a slice of total revenue)
  forecast_snapshot(as_of, horizon, projected_cash, revenue_ytd, revenue_forecast, wage_bill, squad_cost_ratio, ticket_revenue, note)  -- the forecast system of record; squad_cost_ratio is % of revenue, league limit 70%
  payroll_cost(month, headcount, base_wage_bill, bonus_accrual, employer_oncost, total, currency)  -- AGGREGATE wage bill only (feeds squad-cost); per-player salaries live in payroll_private and the agent is denied them
  staff(id, name, role, department, nationality, joined_at)  -- managers & coaching/medical/recruitment staff (names/roles only; individual pay is private, agent denied)"""

SYSTEM = f"""You are Pit Wall, the autonomous transfer-finance agent for Harbourside FC.
You handle the payables & receivables of a football club. You do NOT have write access
to any system of record — you PROPOSE, and code decides. Precision is everything:
when a case does not clearly match a known pattern, classify it as "unknown" and it
will be escalated to a human. Never guess.

Your job for one scenario:
1. Think briefly about what the scenario is.
2. Use recall_memory to see how Pit Wall handled SIMILAR situations before — past
   decisions, human precedents, and the policy that governs this. Treat it as a hint
   to orient you and to match the house style; it is NOT truth on its own.
3. Use run_sql to (a) confirm the relevant history and (b) LOCATE the exact golden rows
   the scenario refers to (so you can fill subject_refs with real ids).
4. Call propose exactly once with the situation_type, the subject_refs it needs, and a
   one-line reason. Do not try to compute the final accounting treatment — the hard-check
   gate does that from the data you located.

Memory (recall_memory) points back to real rows but can be stale or only similar —
always confirm a fact with run_sql before you rely on it, and never let memory
override what the data says. Code decides; memory just helps you see the case.

{SCHEMA_HINT}

Known situation_types and the subject_refs each one needs:
{json.dumps(SITUATIONS, indent=2)}
Use "unknown" with subject_refs {{}} if nothing fits — that escalates to a human."""


# --------------------------------------------------------------------------- #
def _run_sql(query: str) -> dict:
    """Execute a read-only SELECT against golden as the least-privilege agent role."""
    q = query.strip().rstrip(";").strip()
    low = q.lower()
    if not (low.startswith("select") or low.startswith("with")):
        return {"error": "only SELECT/WITH queries are allowed"}
    if ";" in q:
        return {"error": "one statement only"}
    conn = connect("agent")
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(q)
            rows = cur.fetchmany(50)
            cols = [d.name for d in cur.description] if cur.description else []
            return {"columns": cols, "rows": [dict(r) for r in rows]}
    except Exception as e:
        return {"error": str(e)[:240]}
    finally:
        conn.close()


def _recall(text: str, *, kinds=("decisions", "precedents", "policies"), top_k: int | None = None,
            min_score: float | None = None, as_of=None, work_item_id: str | None = None) -> dict:
    """Ask Moss for context like this situation — past decisions, human precedents, the
    governing policy (optionally clauses/prior answers). Returns {kind: [hits]}, empty
    when retrieval is off OR nothing clears the relevance floor. Hits are ids + snippets;
    facts get confirmed via run_sql.

    `top_k` and `min_score` default to the configured recall settings — so how many
    memories we pull and how similar they must be are knobs, not hardcoded, and a novel
    prompt returns {} instead of surfacing weak/irrelevant matches."""
    try:
        from ..retrieval import is_available
        from ..retrieval import query as RQ

        if not is_available():
            return {}
        s = get_settings()
        k = top_k if top_k is not None else s.pitwall_recall_top_k
        floor = min_score if min_score is not None else s.pitwall_recall_min_score
        out: dict[str, list] = {}
        if "decisions" in kinds:
            out["decisions"] = RQ.find_decisions(text, top_k=k, as_of=as_of,
                                                 surface="worker", work_item_id=work_item_id)
        if "precedents" in kinds:
            out["precedents"] = RQ.find_precedents(text, top_k=k)
        if "policies" in kinds:
            out["policies"] = RQ.find_policy(text, top_k=k, as_of=as_of)
        if "clauses" in kinds:
            out["clauses"] = RQ.find_clauses(text, top_k=k, as_of=as_of)
        if "questions" in kinds:
            out["questions"] = RQ.find_prior_answers(text, top_k=k, as_of=as_of)
        # drop weak matches, then drop kinds left empty — only genuinely-similar memory survives
        out = {kind: [h for h in hits if h.get("score", 0) >= floor] for kind, hits in out.items()}
        return {kind: hits for kind, hits in out.items() if hits}
    except Exception:
        return {}


def _recall_compact(recalled: dict) -> dict:
    """Trim recall hits to {kind: [{id, score, text}]} for a tool result / the model."""
    return {k: [{"id": h["id"], "score": round(h["score"], 3), "text": h["text"][:200]}
                for h in hits] for k, hits in recalled.items()}


def _recall_block(recalled: dict) -> str:
    """A short 'here's how we handled things like this' block for the model's first turn."""
    if not recalled:
        return ""
    lines = ["Relevant prior context from Pit Wall's memory (a HINT — confirm with run_sql, "
             "the hard-check gate still decides):"]
    for kind, hits in recalled.items():
        for h in hits[:3]:
            lines.append(f"  [{kind}] {h['id']} ({h['score']:.2f}): {h['text'][:150]}")
    return "\n".join(lines)


def _live_scenario(text: str, emit, api_key: str | None, recalled: dict | None = None) -> dict | None:
    """Claude opus-4-8 tool-use loop: think → recall_memory → run_sql → propose. The
    recalled context is seeded into the first turn; the model can recall again mid-reasoning."""
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    tools = [
        {"name": "recall_memory", "description": "Search Pit Wall's memory for situations like "
         "this one — past decisions, human precedents, the governing policy, prior answers, or "
         "contract clauses. Returns ids + snippets that point back to real rows; always confirm "
         "a fact with run_sql before relying on it.",
         "input_schema": {"type": "object", "properties": {
             "query": {"type": "string"},
             "kinds": {"type": "array", "items": {"type": "string", "enum":
                       ["decisions", "precedents", "policies", "clauses", "questions"]}}},
             "required": ["query"]}},
        {"name": "run_sql", "description": "Run one read-only SELECT over golden.* to confirm "
         "history or locate the rows this scenario refers to.",
         "input_schema": {"type": "object", "properties": {"query": {"type": "string"}},
                          "required": ["query"]}},
        {"name": "propose", "description": "Propose how to handle the scenario — once, after "
         "you've recalled memory and located the rows.",
         "input_schema": {"type": "object", "properties": {
             "situation_type": {"type": "string", "enum": [*SITUATIONS, "unknown"]},
             "subject_refs": {"type": "object"},
             "reason": {"type": "string"}},
             "required": ["situation_type", "subject_refs", "reason"]}},
    ]
    first = f"Scenario: {text}"
    block = _recall_block(recalled or {})
    if block:
        first += "\n\n" + block
    messages = [{"role": "user", "content": first}]
    for _ in range(8):
        resp = client.messages.create(
            model=MODEL, max_tokens=3000,
            thinking={"type": "adaptive", "display": "summarized"},
            system=SYSTEM, tools=tools, messages=messages)
        messages.append({"role": "assistant", "content": resp.content})
        for b in resp.content:
            if b.type == "thinking" and getattr(b, "thinking", ""):
                emit({"actor": "ai_agent", "kind": "think", "text": b.thinking})
            elif b.type == "text" and b.text.strip():
                emit({"actor": "ai_agent", "kind": "think", "text": b.text})
        tool_uses = [b for b in resp.content if b.type == "tool_use"]
        if not tool_uses:
            break
        results, proposal = [], None
        for tu in tool_uses:
            if tu.name == "recall_memory":
                q = tu.input.get("query", text)
                kinds = tuple(tu.input.get("kinds") or ("decisions", "precedents", "policies"))
                rc = _recall(q, kinds=kinds)
                emit({"actor": "ai_agent", "kind": "recall",
                      "text": f"searched memory for \"{q[:60]}\"", "data": rc})
                results.append({"type": "tool_result", "tool_use_id": tu.id,
                                "content": json.dumps(_recall_compact(rc), default=str)[:4000]})
            elif tu.name == "run_sql":
                emit({"actor": "ai_agent", "kind": "run_sql", "text": tu.input["query"]})
                out = _run_sql(tu.input["query"])
                emit({"actor": "db", "kind": "sql_result", "data": out})
                results.append({"type": "tool_result", "tool_use_id": tu.id,
                                "content": json.dumps(out, default=str)[:6000]})
            elif tu.name == "propose":
                proposal = tu.input
                emit({"actor": "ai_agent", "kind": "propose",
                      "text": proposal.get("reason", ""), "data": proposal})
                results.append({"type": "tool_result", "tool_use_id": tu.id,
                                "content": "proposal received"})
        messages.append({"role": "user", "content": results})
        if proposal:
            return proposal
    # the model reasoned but never called propose (narrated its conclusion, or ran out of
    # turns) → force a structured decision from everything it just worked out, so the trail
    # always ends in a verdict instead of "no proposal produced"
    try:
        messages.append({"role": "user", "content":
            "Call propose now with your best classification and the subject_refs you located. "
            "Use situation_type \"unknown\" with subject_refs {} only if truly nothing fits. "
            "Do not run any more tools."})
        resp = client.messages.create(
            model=MODEL, max_tokens=1200, system=SYSTEM,
            tools=[tools[-1]], tool_choice={"type": "tool", "name": "propose"}, messages=messages)
        for b in resp.content:
            if b.type == "tool_use" and b.name == "propose":
                emit({"actor": "ai_agent", "kind": "propose",
                      "text": b.input.get("reason", ""), "data": b.input})
                return b.input
    except Exception:  # noqa: BLE001
        pass
    return None


_MOCK_KW = {
    "fake_bank_detail_change": ["bank detail", "iban", "payee", "fraud", "lookalike"],
    "incoming_short_solidarity": ["solidarity", "short by 5"],
    "incoming_short_unexplained": ["short", "unexplained", "missing"],
    "addon_invoiced_not_triggered": ["add-on", "addon", "appearance", "bonus claim"],
    "addon_triggered_not_booked": ["triggered", "reached", "not booked"],
    "one_wire_many_items": ["one wire", "two installments", "combined", "split"],
    "duplicate_agent_fee": ["duplicate", "agent fee", "same invoice"],
    "threshold_evasion_split": ["threshold", "consultancy", "under the limit"],
    "stale_fx_rate": ["fx", "exchange rate", "eur", "gbp", "stale rate"],
    "ambiguous_sell_on": ["sell-on", "sell on", "ambiguous"],
    "contract_extension_amortization": ["extension", "amortization", "amortisation"],
}


def _mock_scenario(text: str, emit) -> dict | None:
    """Keyless fallback: keyword-match to the nearest planted issue, replay a scripted trail."""
    key = json.loads(ANSWER_KEY.read_text())
    low = text.lower()
    best, best_score = None, 0
    for issue in key:
        score = sum(1 for kw in _MOCK_KW.get(issue["type"], []) if kw in low)
        if score > best_score:
            best, best_score = issue, score
    if best is None:
        best = key[0]
    emit({"actor": "ai_agent", "kind": "think",
          "text": f"(mock) this reads like a '{best['type']}' case — let me recall how we booked these."})
    emit({"actor": "ai_agent", "kind": "run_sql",
          "text": "SELECT situation, count(*) AS n FROM golden.historical_outcome GROUP BY situation ORDER BY n DESC"})
    emit({"actor": "db", "kind": "sql_result",
          "data": _run_sql("SELECT situation, count(*) AS n FROM golden.historical_outcome "
                           "GROUP BY situation ORDER BY n DESC")})
    emit({"actor": "ai_agent", "kind": "propose", "text": best.get("note", ""), "data": best})
    return {"situation_type": best["type"], "subject_refs": best["subject_refs"],
            "reason": best.get("note", "")}


def _audit_trail(subject: str) -> list[dict]:
    conn = connect("gateway")
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute("SELECT to_char(at,'HH24:MI:SS') AS at, actor, action, allowed, reason "
                        "FROM work.audit_log WHERE subject=%s ORDER BY at", (subject,))
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


_VERDICT_SAY = {
    "POSTED": "I completed it and posted it to the ledger",
    "HELD": "I placed it on hold and routed it up",
    "NEEDS_INFO": "I escalated it to a human",
}


def _report(out: dict | None, imp: dict | None, trail: list[dict]) -> str:
    """A grounded, spoken-style report of the decision — the text LiveKit/Cartesia voices."""
    final = (out or {}).get("final", "escalated")
    lead = _VERDICT_SAY.get(final, "I escalated it to a human — I won't guess")
    reason = next((r["reason"] for r in trail if r["action"] == "propose"), "")
    parts = [f"Here is the decision. {lead}."]
    if reason:
        parts.append(reason if reason.endswith(".") else reason + ".")
    if imp and imp.get("kind") not in (None, "none") and imp.get("line"):
        parts.append("For the forecast, this " + imp["line"] + ".")
    if out and out.get("policy"):
        parts.append(f"It auto-completed under policy {out['policy']} — the hard checks in code made the call, not a prompt.")
    elif out and out.get("escalated_to"):
        who = out["escalated_to"].replace("human_", "").replace("_", " ")
        parts.append(f"It needs the {who}; the agent cannot approve its own work.")
    n = len(trail)
    if n:
        parts.append(f"Every step is in the append-only audit log, {n} {'entry' if n == 1 else 'entries'} "
                     "— so months from now, 'why?' is one query.")
    else:
        parts.append("The decision and its reason are written to the append-only audit log "
                     "— so months from now, 'why?' is one query.")
    return " ".join(parts)


def run_scenario(text: str, emit) -> dict:
    """Perceive (Claude) → decide (code) → post (gateway) → audit. Streams via emit."""
    s = get_settings()
    live = s.llm_is_live
    wi = "WI-scn-" + hashlib.md5(text.encode()).hexdigest()[:8]
    emit({"actor": "system", "kind": "scenario", "text": text, "mode": "live" if live else "mock"})

    # Moss recall FIRST — memory orients the reasoning (seeded into the model's first
    # turn) and shows in the UI 'memory' panel. It's a hint; the hard-check gate decides.
    recalled = _recall(text, work_item_id=wi)
    if recalled:
        dec, prec = recalled.get("decisions", []), recalled.get("precedents", [])
        emit({"actor": "ai_agent", "kind": "recall",
              "text": f"recalled {len(dec)} similar decision(s) and {len(prec)} precedent(s) "
                      f"from memory in a few milliseconds — using them to orient, not to decide",
              "data": recalled})
    else:
        emit({"actor": "ai_agent", "kind": "recall",
              "text": "no close match in memory — nothing similar enough to lean on, so I'll "
                      "work this from the data and first principles, not from precedent"})

    try:
        proposal = (_live_scenario(text, emit, s.anthropic_api_key, recalled) if live
                    else _mock_scenario(text, emit))
    except Exception as e:  # live reasoning failed (e.g. bad key) → fall back to mock
        emit({"actor": "system", "kind": "error", "text": f"live reasoning failed ({e}); using mock"})
        proposal = _mock_scenario(text, emit)

    if not proposal and live:
        emit({"actor": "system", "kind": "think",
              "text": "the model didn't commit to a structured call — falling back to a pattern match"})
        proposal = _mock_scenario(text, emit)
    if not proposal:
        emit({"actor": "system", "kind": "error", "text": "no proposal produced"})
        return {"ok": False}

    stype = proposal.get("situation_type", "unknown")
    sr = proposal.get("subject_refs", {}) or {}
    # the model occasionally returns subject_refs as a LIST (or other non-dict) instead of an
    # object — coerce to a dict so every downstream `.get`/indexing is safe. This was the source
    # of a `'list' object has no attribute 'get'` error that surfaced AFTER an otherwise-correct
    # decision (the suspension forecast renders without touching sr, so the glitch slipped past).
    if isinstance(sr, list):
        merged: dict = {}
        for it in sr:
            if isinstance(it, dict):
                merged.update(it)
        sr = merged
    if not isinstance(sr, dict):
        sr = {}

    out = None
    if stype in KIND and sr:
        try:
            out = process_case({"issue_id": wi.replace("WI-", ""), "type": stype, "subject_refs": sr})
            final = out.get("final") or out.get("skipped", "?")
            emit({"actor": "gateway", "kind": "post",
                  "text": f"{final} · {out.get('action', '')}"
                          + (f" · auto-approved on {out['policy']}" if out.get("policy") else ""),
                  "data": out})
        except Exception as e:
            emit({"actor": "system", "kind": "error", "text": f"gate/post failed: {e}"})
    else:
        emit({"actor": "ai_agent", "kind": "escalate",
              "text": "novel or incomplete — bringing in the accounting team (code refuses to guess)"})
        # log the escalation too — a routed-to-human decision is a call, and every call
        # is in the append-only audit log (so the trail is never empty on an escalation).
        try:
            from ..sow import gateway
            from ..sow.roles import AI_AGENT, SYNC

            gateway.create_work_item(SYNC, wi, "review", sr,
                                     reason="novel/incomplete — flagged for the accounting team")
            gateway.transition(AI_AGENT, wi, "propose",
                               reason=proposal.get("reason", "") or "flagged for the accounting team; code will not guess")
        except Exception as e:  # noqa: BLE001
            emit({"actor": "system", "kind": "error", "text": f"escalation log failed: {e}"})

    # forecast ripple (deck slide 7: the 5th system) — how this decision moved the numbers
    imp = None
    try:
        from .forecast import impact, snapshot
        imp = impact(stype, sr)
        emit({"actor": "forecast", "kind": "forecast", "data": {"snapshot": snapshot(), "impact": imp}})
    except Exception:
        pass

    trail = _audit_trail(wi)
    emit({"actor": "system", "kind": "audit", "data": trail})
    try:
        emit({"actor": "ai_agent", "kind": "report", "text": _report(out, imp, trail), "data": {"wi": wi}})
    except Exception:  # noqa: BLE001 — the decision is already posted + audited; a report glitch must never surface
        emit({"actor": "ai_agent", "kind": "report", "text": "Decision recorded and written to the audit log.", "data": {"wi": wi}})

    # HUMAN-IN-THE-LOOP: when the agent escalated (it won't guess), hand the call to the
    # human working with it — and the human's decision is recorded + learned from.
    final = (out or {}).get("final", "")
    escalated = (out is None) or str(final).startswith(("NEEDS_INFO", "PROPOSED (no policy", "HELD")) \
        or (stype not in KIND)
    if escalated:
        # the HITL hand-off is the important moment — make it bulletproof: enrich it with a
        # clause read when we can, but ALWAYS emit the await_human (with safe fallbacks) so a
        # glitch in the enrichment can never swallow the escalation or surface a raw error.
        clause_report, clause_terms = None, None
        try:
            clause_terms = _clause_terms(stype, sr)
            if clause_terms:
                # if it turns on a contract clause, DELEGATE that clause to a focused subagent
                emit({"actor": "ai_agent", "kind": "think",
                      "text": "this hinges on a contract clause — deploying a clause-analyst subagent to read it closely…"})
                try:
                    from .clause_analyst import analyze

                    clause_report = analyze(stype, clause_terms, proposal.get("reason", ""))
                    emit({"actor": "ai_agent", "kind": "clause_report",
                          "data": clause_report, "clause": clause_terms})
                except Exception as e:  # noqa: BLE001
                    emit({"actor": "system", "kind": "error", "text": f"clause subagent failed: {e}"})
        except Exception:  # noqa: BLE001 — enrichment is best-effort; never block the hand-off
            clause_report, clause_terms = None, None
        emit({"actor": "ai_agent", "kind": "await_human", "data": {
            "wi": wi, "situation": stype,
            "escalated_to": (out or {}).get("escalated_to") or "human_accountant",
            "question": proposal.get("reason") or "How should I handle this? I won't guess.",
            "options": _HITL_OPTIONS.get(stype, []),
            "clause_report": clause_report, "clause": clause_terms}})
    return {"ok": True, "wi": wi, "audit": trail}


# which escalations turn on a clause, and where its id lives in subject_refs
_CLAUSE_SIT = {
    "ambiguous_sell_on": "sell_on_clause_id", "contract_extension_amortization": "clause_id",
    "loan_to_buy_obligation": "clause_id", "addon_triggered_not_booked": "clause_id",
    "addon_invoiced_not_triggered": "invoice_id",
}


def _clause_terms(stype: str, sr: dict) -> dict | None:
    """Gather the verbatim clause terms for the subagent to read (None if not clause-based)."""
    from . import read

    try:
        if stype == "suspension_wage_withholding":
            cls = read.employment_clauses(sr.get("player_id")) or []
            if not cls:
                return None
            return {"scope": "employment contract", "player": sr.get("player_id"),
                    "clauses": [{"kind": c.get("kind"), "terms": c.get("params"),
                                 "as_written": c.get("ambiguity_note")} for c in cls]}
        key = _CLAUSE_SIT.get(stype)
        if not key:
            return None
        cid = sr.get(key) or sr.get("clause_id") or sr.get("sell_on_clause_id")
        if stype.startswith("addon_invoiced"):   # clause id lives on the invoice
            inv = read.invoice(cid) if cid else None
            cid = (inv or {}).get("claims_clause_id")
        if not cid:
            return None
        cl = read.clause(cid)
        if not cl:
            return None
        return {"clause_id": cid, "kind": cl.get("kind"), "terms": cl.get("params"),
                "as_written": cl.get("ambiguity_note"),
                "competitions_counted": cl.get("competitions_counted")}
    except Exception:  # noqa: BLE001
        return None
