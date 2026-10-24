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
  fx_rate(pair, at, rate) · player(id, name) · sponsor_contract · journal_entry · period
  historical_outcome(situation, ...)  -- 12 months of how past humans handled things"""

SYSTEM = f"""You are Pit Wall, the autonomous transfer-finance agent for Harbourside FC.
You handle the payables & receivables of a football club. You do NOT have write access
to any system of record — you PROPOSE, and code decides. Precision is everything:
when a case does not clearly match a known pattern, classify it as "unknown" and it
will be escalated to a human. Never guess.

Your job for one scenario:
1. Think briefly about what the scenario is and how this team handled it before.
2. Use run_sql to (a) recall the relevant history and (b) LOCATE the exact golden rows
   the scenario refers to (so you can fill subject_refs with real ids).
3. Call propose exactly once with the situation_type, the subject_refs it needs, and a
   one-line reason. Do not try to compute the final accounting treatment — the hard-check
   gate does that from the data you located.

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


def _live_scenario(text: str, emit, api_key: str | None) -> dict | None:
    """Claude opus-4-8 tool-use loop: think → run_sql → propose. Returns the proposal."""
    import anthropic

    client = anthropic.Anthropic(api_key=api_key)
    tools = [
        {"name": "run_sql", "description": "Run one read-only SELECT over golden.* to recall "
         "history or locate the rows this scenario refers to.",
         "input_schema": {"type": "object", "properties": {"query": {"type": "string"}},
                          "required": ["query"]}},
        {"name": "propose", "description": "Propose how to handle the scenario — once, after "
         "you've recalled history and located the rows.",
         "input_schema": {"type": "object", "properties": {
             "situation_type": {"type": "string", "enum": [*SITUATIONS, "unknown"]},
             "subject_refs": {"type": "object"},
             "reason": {"type": "string"}},
             "required": ["situation_type", "subject_refs", "reason"]}},
    ]
    messages = [{"role": "user", "content": f"Scenario: {text}"}]
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
            if tu.name == "run_sql":
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


def run_scenario(text: str, emit) -> dict:
    """Perceive (Claude) → decide (code) → post (gateway) → audit. Streams via emit."""
    s = get_settings()
    live = s.llm_is_live
    emit({"actor": "system", "kind": "scenario", "text": text, "mode": "live" if live else "mock"})
    try:
        proposal = _live_scenario(text, emit, s.anthropic_api_key) if live else _mock_scenario(text, emit)
    except Exception as e:  # live reasoning failed (e.g. bad key) → fall back to mock
        emit({"actor": "system", "kind": "error", "text": f"live reasoning failed ({e}); using mock"})
        proposal = _mock_scenario(text, emit)

    if not proposal:
        emit({"actor": "system", "kind": "error", "text": "no proposal produced"})
        return {"ok": False}

    stype = proposal.get("situation_type", "unknown")
    sr = proposal.get("subject_refs", {}) or {}
    wi = "WI-scn-" + hashlib.md5(text.encode()).hexdigest()[:8]

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
              "text": "novel or incomplete — escalating to human_controller (code refuses to guess)"})

    # forecast ripple (deck slide 7: the 5th system) — how this decision moved the numbers
    try:
        from .forecast import impact, snapshot
        emit({"actor": "forecast", "kind": "forecast",
              "data": {"snapshot": snapshot(), "impact": impact(stype, sr)}})
    except Exception:
        pass

    trail = _audit_trail(wi)
    emit({"actor": "system", "kind": "audit", "data": trail})
    return {"ok": True, "wi": wi, "audit": trail}
