"""Harbourside FC — finance control backend.

A thin FastAPI layer over the REAL system: the System of Work gateway (M1), the
cloud Postgres data, and the grounded Explainer. The frontend's buttons hit these
endpoints and every result is live — work items actually transition through the
gateway, denials are actually logged, the audit trail is actually queried.

  uv run uvicorn api.app:app --port 4055   ->   open http://localhost:4055
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row

from pitwall.db import connect

app = FastAPI(title="Harbourside FC — finance control")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

WEB = Path(__file__).resolve().parents[1] / "web"


def _rows(sql: str, params: tuple = ()) -> list[dict]:
    conn = connect("gateway")
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(sql, params)
            return cur.fetchall()
    finally:
        conn.close()


def _save_trace(wi: str, text: str, steps: list) -> None:
    """Persist a Teamwork-Terminal run (everything the agent just did) so it can be
    reopened from History later — the live trace is otherwise only in the browser.
    Best-effort and self-contained: lazily creates its own table (a plain work.* table,
    NOT the append-only audit log, so upsert is fine) and grants the app's read role."""
    conn = connect("superuser")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS work.scenario_trace ("
                "wi text PRIMARY KEY, text text, at timestamptz DEFAULT now(), steps jsonb)")
            cur.execute("GRANT SELECT, INSERT, UPDATE ON work.scenario_trace TO gateway")
            cur.execute(
                "INSERT INTO work.scenario_trace (wi, text, at, steps) VALUES (%s,%s,now(),%s::jsonb) "
                "ON CONFLICT (wi) DO UPDATE SET text=EXCLUDED.text, at=now(), steps=EXCLUDED.steps",
                (wi, text, json.dumps(steps, default=str)))
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Dashboard + queue (live reads)
# --------------------------------------------------------------------------- #
@app.get("/api/metrics")
def metrics() -> dict:
    cash = _rows(
        "SELECT currency, round(sum(amount))::bigint AS net FROM golden.bank_transaction "
        "GROUP BY currency ORDER BY currency")
    states = _rows("SELECT state, count(*) n FROM work.work_item GROUP BY state")
    transfers = _rows(
        "SELECT direction, count(*) n, round(sum(fee))::bigint total FROM golden.transfer "
        "GROUP BY direction")
    outcomes = _rows(
        "SELECT allowed, count(*) n FROM work.audit_log GROUP BY allowed")
    posted = sum(s["n"] for s in states if s["state"] == "POSTED")
    held = sum(s["n"] for s in states if s["state"] == "HELD")
    return {
        "cash": {c["currency"]: c["net"] for c in cash},
        "states": {s["state"]: s["n"] for s in states},
        "transfers": {t["direction"]: {"n": t["n"], "total": t["total"]} for t in transfers},
        "audit_allowed": sum(o["n"] for o in outcomes if o["allowed"]),
        "audit_denied": sum(o["n"] for o in outcomes if not o["allowed"]),
        "planted_issues": 21,
        "posted": posted, "held": held,
    }


@app.get("/api/queue")
def queue() -> list[dict]:
    rows = _rows(
        "SELECT id, kind, state, subject_refs, failing_check, updated_at "
        "FROM work.work_item ORDER BY updated_at DESC LIMIT 40")
    out = []
    for r in rows:
        sr = r["subject_refs"] or {}
        amt = sr.get("amount")
        ccy = sr.get("currency", "")
        cp = sr.get("counterparty_id") or sr.get("memo") or ""
        out.append({"id": r["id"], "kind": r["kind"], "state": r["state"],
                    "amount": amt, "currency": ccy, "counterparty": str(cp)[:28],
                    "failing_check": r["failing_check"]})
    return out


@app.get("/api/feed")
def feed() -> list[dict]:
    """Recent notable decisions as deadline-day 'breaking news' for the ticker."""
    rows = _rows(
        "SELECT at, actor, action, subject, allowed, reason FROM work.audit_log "
        "WHERE action IN ('hold','reject','post','approve','propose') OR allowed = false "
        "ORDER BY at DESC LIMIT 14")
    out = []
    for r in rows:
        if not r["allowed"]:
            kind, label = "red", f"RED CARD · {r['actor']} {r['action']} blocked"
        elif r["action"] == "hold":
            kind, label = "red", "HELD"
        elif r["action"] == "reject":
            kind, label = "red", "REJECTED"
        elif r["action"] == "post":
            kind, label = "green", "DONE DEAL · posted to ledger"
        elif r["action"] == "approve":
            kind, label = "green", "APPROVED"
        else:
            kind, label = "amber", "PROPOSED"
        out.append({"kind": kind, "subject": r["subject"], "label": label,
                    "reason": (r["reason"] or "")[:70]})
    return out


@app.get("/api/forecast")
def forecast() -> dict:
    """The forecast system of record (slide 7) — projected cash + squad-cost ratio,
    plus the annual-report view (IFRS notes) and receivables aging."""
    from pitwall.agent.forecast import snapshot

    return snapshot()


@app.get("/api/report")
def report() -> dict:
    """The annual-report view: our golden.* rolled up like a real club's IFRS notes
    (net transfer income, player registrations + amortisation, contingent commitments)
    plus trade-receivables aging — the shape a club like BVB actually publishes."""
    from pitwall.agent.forecast import club_report, receivables_aging

    return {"report": club_report(), "receivables": receivables_aging()}


@app.get("/api/books")
def books() -> dict:
    """The books: trial balance (must tie, per currency) + P&L. Proof the System of
    Work produced correct double-entry accounting from the system of record."""
    from pitwall.accounting.books import pnl, trial_balance

    return {"trial_balance": trial_balance(), "pnl": pnl()}


@app.get("/api/policies")
def policies() -> list[dict]:
    """The agent's memory in the DB — approved auto_approve rules, learned at onboarding
    or self-improved from precedents (deck slides 12-13)."""
    rows = _rows("SELECT DISTINCT ON (id) id, version, evidence_count, text, auto_approve, rule "
                 "FROM work.policy WHERE status = 'approved' ORDER BY id, version DESC")
    out = []
    for r in rows:
        rule = r["rule"] or {}
        out.append({
            "id": r["id"], "version": r["version"], "evidence": r["evidence_count"],
            "text": r["text"], "auto": r["auto_approve"], "covers": rule.get("covers"),
            "origin": "self-improved" if rule.get("precedents") else "learned",
        })
    return out


# --------------------------------------------------------------------------- #
# Agent context — switch the current agent newbie ↔ onboarded, and onboard it.
# --------------------------------------------------------------------------- #
@app.get("/api/agent/mode")
def agent_mode_get() -> dict:
    from pitwall.config import get_agent_mode, get_agent_name

    return {"mode": get_agent_mode(), "agent": get_agent_name()}


@app.post("/api/agent/mode")
def agent_mode_set(mode: str = "onboarded") -> dict:
    """Flip the live agent between 'onboarded' (uses its learned policies) and 'newbie'
    (no context — escalates everything). The button in the control room hits this."""
    from pitwall.config import set_agent_mode

    mode = mode if mode in ("onboarded", "newbie", "no-context") else "onboarded"
    set_agent_mode(mode)
    return {"mode": mode}


@app.post("/api/agent/onboard")
def agent_onboard() -> dict:
    """Onboard the agent: learn the accounting policies from the records and write them
    as the agent's memory. Returns the policies it now holds."""
    from pitwall.agent.policy import onboard

    learned = onboard()
    return {"ok": True, "learned": len(learned), "policies": learned}


@app.get("/api/agent/onboard/stream")
async def agent_onboard_stream(agent: str = "", roles: str = "", use_llm: str = "") -> StreamingResponse:
    """Onboard the agent as a LIVE trail of thought, streamed over SSE: it mines the
    club's history, reasons out one policy per treatment it can evidence, then PROPOSES
    the full policy set for a human to approve. Steps mirror /api/scenario/stream so the
    stadium terminal renders them the same way. Policies are written proposed (inactive)
    — nothing is live until /api/agent/policy/approve."""
    from pitwall.agent.capability import onboard_stream

    config = {"agent": agent or None,
              "roles": [r for r in roles.split(",") if r] or None,
              "use_llm": True if use_llm == "1" else (False if use_llm == "0" else None)}

    loop = asyncio.get_event_loop()
    q: asyncio.Queue = asyncio.Queue()

    def emit(step: dict) -> None:
        loop.call_soon_threadsafe(q.put_nowait, step)

    def work() -> None:
        try:
            onboard_stream(emit, config)
        except Exception as e:  # noqa: BLE001
            loop.call_soon_threadsafe(q.put_nowait, {"actor": "system", "kind": "error", "text": str(e)})
        finally:
            loop.call_soon_threadsafe(q.put_nowait, {"kind": "done"})

    threading.Thread(target=work, daemon=True).start()

    async def gen():
        while True:
            step = await q.get()
            yield f"data: {json.dumps(step, default=str)}\n\n"
            if step.get("kind") == "done":
                break

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _ask_context(plan: dict, trail: list[dict]) -> str:
    """Flatten a transaction's record (reasoning + the data it touched + audit) to text
    the model answers strictly from."""
    lines = [f"Title: {plan.get('title', '')}"]
    for sc in plan.get("scenes", []):
        if sc.get("say"):
            lines.append("- " + sc["say"])
        dr = sc.get("draw") or {}
        if dr.get("type") == "table":
            for row in (dr.get("rows") or []):
                lines.append("    " + " | ".join(str(x) for x in row))
        elif dr.get("type") == "checks":
            for it in (dr.get("items") or []):
                lines.append(f"    [{'ok' if it.get('ok') else 'x'}] {it.get('label', '')}")
        elif dr.get("type") in ("calc", "entry"):
            for l in (dr.get("lines") or []):
                lines.append("    " + str(l))
    lines.append("Audit trail:")
    for r in trail:
        lines.append(f"  {r.get('at', '')} {r.get('actor', '')} {r.get('action', '')} — {r.get('reason', '')}")
    return "\n".join(lines)[:6000]


def _trace_context(wi: str) -> str:
    """For a Teamwork-Terminal run, the agent's OWN saved trail — its reasoning, the exact
    SQL it ran + what it found, and the decision — so 'why did you do that?' is answered
    from what the agent actually did, not a thin reconstruction."""
    try:
        rows = _rows("SELECT steps FROM work.scenario_trace WHERE wi = %s", (wi,))
    except Exception:  # noqa: BLE001 — table may not exist yet
        return ""
    if not rows:
        return ""
    steps = rows[0]["steps"] or []
    out = ["What the agent actually did on this one, step by step (its live trail):"]
    for s in steps:
        k, t = s.get("kind"), (s.get("text") or "").strip()
        if k == "think" and t:
            out.append("  reasoned: " + t)
        elif k == "recall" and t:
            out.append("  memory: " + t)
        elif k == "run_sql" and t:
            out.append("  ran SQL: " + t.replace("\n", " "))
        elif k == "sql_result":
            d = s.get("data") or {}
            rws = d.get("rows")
            if isinstance(rws, list):
                out.append(f"    -> {len(rws)} row(s)"
                           + (("; first: " + json.dumps(rws[0], default=str)[:200]) if rws else ""))
            elif isinstance(d, dict) and d.get("error"):
                out.append("    -> query error: " + str(d["error"])[:120])
        elif k == "propose" and t:
            out.append("  proposed: " + t)
        elif k == "post":
            d = s.get("data") or {}
            out.append("  decision: " + str(d.get("final") or t or d.get("action") or ""))
        elif k == "escalate" and t:
            out.append("  escalated: " + t)
        elif k == "report" and t:
            out.append("  filed report: " + t)
    return "\n".join(out)


@app.post("/api/ask")
def ask_agent(wi: str, q: str) -> dict:
    """Question the agent about a PAST event (from History). It answers ONLY from that
    transaction's own record — its reasoning, the data it touched, and the audit trail —
    so it can't invent figures or outcomes. Grounded Q&A."""
    import re

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", wi or ""):
        raise HTTPException(400, "bad wi")
    q = (q or "").strip()
    if not q:
        raise HTTPException(400, "empty question")

    from pitwall.config import get_settings
    from pitwall.explain import plan as planmod

    try:
        plan = planmod.build_plan(wi)
    except Exception:  # noqa: BLE001
        plan = {"title": wi, "scenes": []}
    facts = _ask_context(plan, audit(wi))
    # for a Teamwork-Terminal run, add the agent's own saved trail so 'why?' is grounded
    # in exactly what it did (reasoning + the SQL it ran + the decision)
    tctx = _trace_context(wi)
    if tctx:
        facts = (facts + "\n\n" + tctx)[:9000]

    s = get_settings()
    if not getattr(s, "llm_is_live", False):
        return {"answer": "The language model isn't configured, so I can only show the record "
                "itself — see the report above.", "grounded": False}
    try:
        import anthropic

        client = anthropic.Anthropic(api_key=s.anthropic_api_key)
        sys = ("You are Pit Wall's finance agent, answering a question about ONE past "
               "transaction. Answer ONLY from the RECORD below — its reasoning, the data it "
               "touched, and the audit trail. If the record does not contain the answer, say so "
               "plainly; NEVER invent figures, names, dates, or outcomes. Be concise (2-4 "
               "sentences) and cite the exact numbers/ids from the record when relevant.")
        msg = client.messages.create(
            model=s.pitwall_agent_model, max_tokens=500, system=sys,
            messages=[{"role": "user", "content": f"RECORD for {wi}:\n{facts}\n\nQUESTION: {q}"}])
        answer = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        return {"answer": answer or "(no answer)", "grounded": True}
    except Exception as e:  # noqa: BLE001
        return {"answer": f"(couldn't reach the model: {str(e)[:120]})", "grounded": False}


@app.post("/api/clause")
async def register_clause(req: Request) -> dict:
    """Add a contract clause + its trigger CONDITIONS to the DB (the thing the
    clause-trigger detectors read). JSON body: {id, contract_type, contract_id, kind,
    params, competitions_counted?, ambiguity_note?}. `params` is the condition — e.g.
    an obligation_to_buy's threshold/min_minutes/fee/deadline. Upserts; logged."""
    from pitwall.accounting.clauses import add_clause

    try:
        body = await req.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(400, "expected a JSON body")
    need = ("id", "contract_type", "contract_id", "kind")
    if not all(body.get(k) for k in need):
        raise HTTPException(400, f"need: {', '.join(need)}")
    return add_clause(id=body["id"], contract_type=body["contract_type"],
                      contract_id=body["contract_id"], kind=body["kind"],
                      params=body.get("params"), competitions_counted=body.get("competitions_counted"),
                      ambiguity_note=body.get("ambiguity_note"))


@app.get("/api/deal/{deal_id}/clause-scan")
def clause_scan(deal_id: str) -> dict:
    """The clause guard: enumerate + check EVERY clause on this deal's UID (and the
    player's employment contract), auto-clear the unambiguous ones, and return the subset
    that needs a human — each with a plain-English read AND the verbatim terms."""
    import re

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", deal_id or ""):
        raise HTTPException(400, "bad deal id")
    from pitwall.agent.clause_guard import scan

    return scan(deal_id)


@app.get("/api/clauses")
def list_clauses_ep(contract_id: str = "") -> dict:
    """List registered clauses (optionally for one contract) + the known clause kinds and
    the condition shape each detector expects."""
    from pitwall.accounting.clauses import KIND_SCHEMAS, list_clauses

    return {"clauses": list_clauses(contract_id or None), "known_kinds": KIND_SCHEMAS}


@app.post("/api/dev/seed-amendments")
def seed_amendments_ep() -> dict:
    """Seed demo deals + contract amendments (extension past the 5y cap, a fee cut below
    book value, an early termination), then post the baseline books for them."""
    from pitwall.accounting.amend import seed_amendments

    added = seed_amendments()
    try:
        from pitwall.accounting.posting import build_books

        build_books()
    except Exception:  # noqa: BLE001
        pass
    return added


@app.get("/api/amendments")
def amendments_list() -> dict:
    """Contract amendments and their status (pending → applied/escalated)."""
    from pitwall.accounting.amend import pending_amendments

    return {"amendments": pending_amendments()}


@app.post("/api/amend/apply")
def amend_apply(id: str) -> dict:
    """Apply a contract amendment → cascade the financial events (reverse+repost the legs
    that change, escalate the ones it must not guess). Returns the full cascade."""
    import re

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", id or ""):
        raise HTTPException(400, "bad amendment id")
    from pitwall.accounting.amend import apply_amendment

    return apply_amendment(id)


@app.post("/api/dev/seed-mess")
def seed_mess() -> dict:
    """Add more messy, ambiguous data to experiment with in the Teamwork Terminal —
    extra short-receipt traps (genuine solidarity vs unexplained), a duplicate agent
    fee, an ambiguous sell-on clause, a stale-FX installment and a combined wire.
    Idempotent."""
    from pitwall.messy import seed_edge_cases, seed_mess, seed_player_finance

    out = {"messy": seed_mess(), "edge_cases": seed_edge_cases(), "player_finance": seed_player_finance()}
    try:
        from pitwall.accounting.amend import seed_amendments

        out["amendments"] = seed_amendments()
    except Exception:  # noqa: BLE001
        pass
    return out


@app.post("/api/agent/prime")
def agent_prime() -> dict:
    """TRAIN / PRIME the agent with full context for a demo: load the data (incl. the messy
    traps + clause edge cases), onboard it (learn + approve the accounting policies), seed
    precedents (its memory), post the books, and index everything into Moss so recall works.
    After this the agent orients on policy + precedent + similar past decisions on every
    question — so it can tell 'looks-wrong-but-fine' from genuinely-wrong, and handle novel
    judge questions by routing or safely escalating. Returns the agent's loaded context."""
    ctx: dict = {}

    def step(name, fn):
        try:
            ctx[name] = fn()
        except Exception as e:  # noqa: BLE001
            ctx[name] = f"err: {str(e)[:90]}"

    def _data():
        from pitwall.accounting.amend import seed_amendments
        from pitwall.agent.capability import seed_learning_corpus
        from pitwall.messy import seed_edge_cases, seed_mess, seed_player_finance

        seed_mess(); seed_edge_cases(); seed_amendments(); seed_learning_corpus(); seed_player_finance()
        return "seeded (messy + edge cases + amendments + learning corpus + player finance)"

    def _onboard():
        from pitwall.agent.policy import onboard
        from pitwall.config import set_agent_name

        set_agent_name("Harbourside Agent")
        return f"{len(onboard())} accounting policies learned + approved"

    def _precedents():
        from pitwall.agent import improve
        d = improve.improve_demo()
        return {"recorded": len(d.get("recorded", [])), "generalized": d.get("outcome", {}).get("status")}

    def _books():
        from pitwall.accounting.books import trial_balance
        from pitwall.accounting.posting import build_books

        build_books()
        return {"trial_balance_ties": trial_balance().get("balanced")}

    def _moss():
        from pitwall.retrieval import sync as RS
        from pitwall.retrieval.client import is_available

        return RS.build_all() if is_available() else "moss off"

    def _mode():
        from pitwall.config import get_agent_name, register_onboarded_agent, set_agent_mode

        set_agent_mode("onboarded")
        pols = policies()
        register_onboarded_agent(get_agent_name() or "Harbourside Agent",
                                 [{"id": p["id"], "text": p["text"], "auto": p["auto"],
                                   "covers": p["covers"], "basis": None} for p in pols])
        return {"mode": "onboarded", "active_policies": len(pols)}

    def _history():
        from pitwall.agent.run import fill_history

        return {"transactions": fill_history()["processed"]}

    for name, fn in (("data", _data), ("onboarding", _onboard), ("memory_precedents", _precedents),
                     ("books", _books), ("moss_index", _moss), ("agent", _mode), ("history", _history)):
        step(name, fn)
    return {"ok": True, "trained": True, "context": ctx}


@app.post("/api/history/fill")
def history_fill() -> dict:
    """Process a spread of cases so History is populated (DB-backed work items + audit)."""
    from pitwall.agent.run import fill_history

    return fill_history()


@app.post("/api/agent/reset")
def agent_reset() -> dict:
    """Wipe the agent's LEARNED MEMORY — every precedent + every policy — and the
    onboarding roster, and drop the live agent back to 'newbie'. A clean slate to test
    the workflow from scratch (newbie → Onboard → approve → learns again). The
    append-only audit log is preserved (it can never be deleted — that's the point)."""
    from pitwall.config import reset_agents, set_agent_mode

    n_prec = n_pol = 0
    conn = connect("superuser")
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM work.precedent")
            n_prec = cur.rowcount
            cur.execute("DELETE FROM work.policy")
            n_pol = cur.rowcount
        conn.commit()
    finally:
        conn.close()
    # best-effort: clear the derived Moss indexes for policies + precedents too
    moss = "skipped"
    try:
        from pitwall.config import get_settings
        from pitwall.retrieval import client as R
        from pitwall.retrieval.client import is_available

        if is_available():
            s = get_settings()
            for kind in ("policies", "precedents"):
                R.rebuild_index(s.moss_index(kind), [])
            moss = "cleared"
    except Exception as e:  # noqa: BLE001
        moss = f"error: {str(e)[:80]}"
    reset_agents()
    set_agent_mode("newbie")
    return {"ok": True, "deleted_precedents": n_prec, "deleted_policies": n_pol,
            "moss_policies_index": moss, "mode": "newbie"}


@app.get("/api/agent/policies/pending")
def agent_policies_pending() -> dict:
    """The policies the onboarding agent drafted but that are not yet active — what the
    human is being asked to approve."""
    from pitwall.agent.policy import pending_policies

    return {"pending": pending_policies()}


@app.post("/api/agent/policy/approve")
def agent_policy_approve(ids: str = "", approver: str = "") -> dict:
    """A human approves the proposed policies → they become active auto-rules the engine
    can cite. `ids` is an optional comma-separated subset; empty approves all pending.
    Every approval is appended to the audit log. Returns the approvals' audit trail."""
    from pitwall.agent.policy import approve_policies

    id_list = [i for i in ids.split(",") if i] or None
    res = approve_policies(id_list, approver=approver or None)
    # persist to LONG-TERM memory: the durable write already happened in Tiger
    # (work.policy). Index the approved policies into Moss so the control room recalls
    # them later — fire-and-forget on a background worker (Moss is derived; it must
    # never block or slow the approval; it outboxes if Moss is down)
    indexed = 0
    try:
        from pitwall.retrieval import sync as RS
        from pitwall.retrieval.client import is_available

        if is_available():
            for pid in res["approved"]:
                RS.enqueue_async("policies", pid)
                indexed += 1
    except Exception:  # noqa: BLE001
        pass
    # register this agent + the policy set it just approved, so the Onboard roster
    # can list it and show its policies
    try:
        from pitwall.config import get_agent_name, register_onboarded_agent

        snap = _rows("SELECT DISTINCT ON (id) id, text, auto_approve, rule FROM work.policy "
                     "WHERE status='approved' ORDER BY id, version DESC")
        pols = [{"id": r["id"], "text": r["text"], "auto": r["auto_approve"],
                 "covers": (r["rule"] or {}).get("covers"), "basis": (r["rule"] or {}).get("basis")}
                for r in snap]
        register_onboarded_agent(get_agent_name() or "Agent", pols)
    except Exception:  # noqa: BLE001
        pass
    trail = []
    for pid in res["approved"]:
        trail += audit(f"policy:{pid}")
    return {"ok": True, **res, "indexed": indexed, "audit": trail}


@app.get("/api/agents")
def agents() -> dict:
    """The roster of onboarded agents + each one's approved policy set (what the
    Onboard panel lists). Seeds the current agent from the live policy set if the
    roster is empty (e.g. after a server restart)."""
    from pitwall.config import get_agent_name, list_onboarded_agents

    roster = list_onboarded_agents()
    if not roster:
        pols = policies()  # the live approved set
        if pols:
            roster = [{"name": get_agent_name() or "Harbourside Agent", "at": None,
                       "engine": None,
                       "policies": [{"id": p["id"], "text": p["text"], "auto": p["auto"],
                                     "covers": p["covers"], "basis": None} for p in pols]}]
    return {"agents": roster, "current": get_agent_name()}


@app.get("/api/environment")
def environment() -> dict:
    """Build 1 — the systems of record synced into one shape (deck slide 15)."""
    tables = ["bank_transaction", "invoice", "installment", "transfer", "counterparty",
              "contract_clause", "match_event", "fx_rate", "inbox_message", "sponsor_contract",
              "journal_entry"]
    counts = {}
    for t in tables:
        try:
            counts[t] = _rows(f"SELECT count(*) n FROM golden.{t}")[0]["n"]
        except Exception:
            counts[t] = 0
    return {"golden": counts, "total": sum(counts.values()),
            "sources": ["J.P. Morgan · bank", "Oracle NetSuite · ledger", "Contracts",
                        "Match data", "Inbox"]}


@app.get("/api/denials")
def denials() -> list[dict]:
    """Build 2 / Build 4 — denied attempts, logged too (limits in code)."""
    rows = _rows("SELECT at, actor, action, subject, reason FROM work.audit_log "
                 "WHERE allowed = false ORDER BY at DESC LIMIT 8")
    return [{"at": str(r["at"])[11:19], "actor": r["actor"], "action": r["action"],
             "subject": r["subject"], "reason": (r["reason"] or "")[:70]} for r in rows]


@app.get("/api/audit-recent")
def audit_recent() -> list[dict]:
    """Build 4 — the append-only log, recent transitions as diffs (deck slide 14)."""
    rows = _rows("SELECT at, actor, action, subject, allowed, reason, diff FROM work.audit_log "
                 "ORDER BY at DESC LIMIT 14")
    out = []
    for r in rows:
        diff = r["diff"] or {}
        st = diff.get("state")
        out.append({"at": str(r["at"])[11:19], "actor": r["actor"], "action": r["action"],
                    "subject": r["subject"], "allowed": r["allowed"],
                    "reason": (r["reason"] or "")[:56],
                    "state": f"{st['from']}→{st['to']}" if st else None})
    return out


@app.get("/api/audit/{subject}")
def audit(subject: str) -> list[dict]:
    rows = _rows(
        "SELECT at, actor, action, allowed, reason, diff FROM work.audit_log "
        "WHERE subject = %s ORDER BY at", (subject,))
    out = []
    for r in rows:
        diff = r["diff"] or {}
        st = diff.get("state")
        out.append({"at": str(r["at"])[11:19], "actor": r["actor"], "action": r["action"],
                    "allowed": r["allowed"], "reason": r["reason"],
                    "state": f"{st['from']}→{st['to']}" if st else None})
    return out


@app.get("/api/history")
def history() -> dict:
    """A FAST list of the real transactions + each one's append-only audit chain. The full
    per-transaction report (the agent's reasoning + evidence) is loaded lazily when a topic
    is opened (/api/explain), so this list stays snappy — no plan-building up front."""
    # only real, still-existing transactions — not orphaned test audit rows / demo items
    recent = _rows(
        "SELECT subject, max(at) mx FROM work.audit_log al WHERE subject LIKE 'WI-%%' "
        "AND EXISTS (SELECT 1 FROM work.work_item wi WHERE wi.id = al.subject) "
        "AND subject NOT LIKE 'WI-improve-%%' AND subject NOT LIKE 'WI-combined-%%' "
        "AND subject NOT LIKE 'WI-mess-%%' AND subject NOT LIKE 'WI-fxdyn-%%' "
        "AND subject NOT LIKE 'WI-fxhitl-%%' AND subject NOT LIKE 'WI-hitl-%%' "
        "AND subject NOT LIKE 'WI-susp-%%' AND subject NOT LIKE 'WI-demo-%%' "
        "AND subject NOT LIKE 'WI-moss-%%' "
        "GROUP BY subject ORDER BY mx DESC LIMIT 60")
    order, seen = [], set()
    for wi in ("WI-5602", "WI-5611"):            # the two rich, seeded decisions first
        order.append(wi); seen.add(wi)
    for r in recent:
        if r["subject"] not in seen:
            order.append(r["subject"]); seen.add(r["subject"])
    order = order[:24]
    if not order:
        return {"count": 0, "transactions": 0, "events": []}

    # TWO batched queries instead of 2×N round-trips (the slow part was a build_plan per wi)
    trails = _rows("SELECT subject, at, actor, action, allowed, reason, diff FROM work.audit_log "
                   "WHERE subject = ANY(%s) ORDER BY subject, at", (order,))
    witems = _rows("SELECT id, kind, state FROM work.work_item WHERE id = ANY(%s)", (order,))
    wmap = {w["id"]: w for w in witems}
    by_subj: dict[str, list] = {}
    for r in trails:
        by_subj.setdefault(r["subject"], []).append(r)

    events: list[dict] = []
    txn = 0
    for wi in order:
        trail = by_subj.get(wi)
        if not trail:
            continue
        w = wmap.get(wi, {})
        kind, state = w.get("kind", ""), w.get("state", "")
        title = f"{kind} — {state}" if kind else wi
        rows, last_reason = [], ""
        for e in trail:
            diff = e["diff"] or {}
            st = diff.get("state")
            trans = f"{st['from']}→{st['to']}" if st else (e["action"] or "")
            flag = "" if e["allowed"] else " ✗"
            rows.append([str(e["at"])[11:19], e["actor"], trans + flag])
            if e["reason"]:
                last_reason = e["reason"]
        events.append({
            "wi": wi, "txn": txn, "head": True, "title": title,
            "say": f"{wi} — {kind or 'transaction'}" + (f", resolved {state}." if state else "."),
            "draw": {"type": "table", "title": "what changed · append-only audit",
                     "columns": ["time", "actor", "transition"], "rows": rows,
                     "highlight_row": len(rows) - 1},
            "meta": last_reason[:90],
        })
        txn += 1

    return {"count": len(events), "transactions": txn, "events": events}


# --------------------------------------------------------------------------- #
# The score — proof it works (deck ① "is it real enough?")
# --------------------------------------------------------------------------- #
_SCORE_CACHE: dict = {}


@app.get("/api/score")
def score() -> dict:
    """The agent's decision gate scored autonomously against the 21-planted-issue answer
    key (it never sees the key). Cached after the first run."""
    if "m" not in _SCORE_CACHE:
        try:
            from pitwall.eval.run import run as eval_run

            res = eval_run(write=False)
            _SCORE_CACHE["m"] = res["metrics"]
            _SCORE_CACHE["rows"] = res["rows"]
        except Exception as e:  # noqa: BLE001
            return {"error": str(e)[:200]}
    m = _SCORE_CACHE["m"]
    rows = _SCORE_CACHE.get("rows", [])
    return {
        "precision": round(m["precision_on_auto_completed"] * 100),
        "violations": m["must_not_auto_complete_violations"],
        "recall_correct": m["correct"], "total": m["total"],
        "automation": round(m["automation_rate"] * 100),
        "escalation": round(m["escalation_quality"] * 100),
        "auto_completed": m["auto_completed"],
        "escalated": m["total"] - m["auto_completed"],
        "by_type": [{"type": t, "correct": v["correct"], "n": v["n"]}
                    for t, v in m["by_type"].items()],
        "issues": [{"issue_id": r["issue_id"], "type": r["type"], "action": r["action"],
                    "auto": r["auto"], "correct": r["correct"], "violation": r["violation"]}
                   for r in rows],
    }


# --------------------------------------------------------------------------- #
# Reports desk — a financial report assembled from golden + the forecast. The
# scenario terminal offloads report requests here; it plays on the report billboard
# and the markdown is downloadable.
# --------------------------------------------------------------------------- #
@app.get("/api/finreport")
def finreport() -> dict:
    def m(x):
        try:
            return f"€{float(x) / 1e6:.1f}M"
        except Exception:  # noqa: BLE001
            return "—"

    fcr = _rows("SELECT as_of, projected_cash, revenue_forecast, wage_bill, squad_cost_ratio, ticket_revenue "
                "FROM golden.forecast_snapshot ORDER BY as_of DESC LIMIT 1")
    fc = fcr[0] if fcr else {}
    as_of = str(fc.get("as_of", ""))
    ssn = _rows("SELECT season, round(sum(gross))::bigint g, "
                "round(sum(gross) FILTER (WHERE kind='season'))::bigint s, "
                "round(sum(gross) FILTER (WHERE kind='matchday'))::bigint md "
                "FROM golden.ticket_sale GROUP BY season ORDER BY season DESC")
    cs = ssn[0] if ssn else {}
    pcr = _rows("SELECT headcount, round(total)::bigint t FROM golden.payroll_cost ORDER BY month DESC LIMIT 1")
    pc = pcr[0] if pcr else {}
    trs = _rows("SELECT direction, count(*) n, round(sum(fee))::bigint total FROM golden.transfer GROUP BY direction")
    tin = next((t for t in trs if t["direction"] == "in"), {})
    tout = next((t for t in trs if t["direction"] == "out"), {})
    recv = _rows("SELECT status, count(*) n, round(sum(amount))::bigint total FROM golden.installment "
                 "WHERE status IN ('scheduled','invoiced','short_paid','disputed','held') "
                 "GROUP BY status ORDER BY total DESC NULLS LAST")

    rev, ratio, cash, wage = fc.get("revenue_forecast"), fc.get("squad_cost_ratio"), fc.get("projected_cash"), fc.get("wage_bill")
    sections = [
        {"key": "revenue", "title": "revenue",
         "say": f"Total revenue is projected at {m(rev)} for the year, of which matchday and season tickets are {m(cs.get('g'))}.",
         "draw": {"type": "table", "title": "revenue", "columns": ["line", "amount"],
                  "rows": [["Total revenue", m(rev)], ["— season tickets", m(cs.get("s"))],
                           ["— matchday tickets", m(cs.get("md"))]], "highlight_row": 0}},
        {"key": "wages", "title": "wages & squad cost",
         "say": f"The wage bill is {m(wage)} across {pc.get('headcount', '—')} players plus staff. "
                f"Squad cost is {ratio}% of revenue, against a 70% league limit.",
         "draw": {"type": "table", "title": "wages & squad cost", "columns": ["metric", "value"],
                  "rows": [["Wage bill (annual)", m(wage)], ["Registered players", str(pc.get("headcount", "—"))],
                           ["Squad-cost ratio", f"{ratio}%"], ["League limit", "70%"]], "highlight_row": 2}},
        {"key": "transfers", "title": "transfers",
         "say": f"{tin.get('n', 0)} incoming deals worth {m(tin.get('total'))} payable, and "
                f"{tout.get('n', 0)} outgoing worth {m(tout.get('total'))} receivable.",
         "draw": {"type": "table", "title": "transfers", "columns": ["direction", "deals", "fees"],
                  "rows": [["Incoming (buy)", str(tin.get("n", 0)), m(tin.get("total"))],
                           ["Outgoing (sell)", str(tout.get("n", 0)), m(tout.get("total"))]]}},
        {"key": "receivables", "title": "receivables",
         "say": "Outstanding receivables: " + (", ".join(f"{r['status']} {m(r['total'])}" for r in recv) or "none") + ".",
         "draw": {"type": "table", "title": "receivables (outstanding installments)", "columns": ["status", "count", "amount"],
                  "rows": [[r["status"], str(r["n"]), m(r["total"])] for r in recv] or [["—", "0", "—"]]}},
        {"key": "cash", "title": "cash position",
         "say": f"Projected cash is {m(cash)} as of {as_of}.",
         "draw": {"type": "calc", "title": "cash position", "lines": [f"Projected cash   {m(cash)}", f"As of            {as_of}"]}},
    ]
    md = [f"# Harbourside FC — Financial Report", f"_As of {as_of} · grounded in golden + forecast_", ""]
    for s in sections:
        md += [f"## {s['title'].title()}", s["say"], ""]
        d = s["draw"]
        if d["type"] == "table":
            md.append("| " + " | ".join(d["columns"]) + " |")
            md.append("|" + "|".join(["---"] * len(d["columns"])) + "|")
            md += ["| " + " | ".join(r) + " |" for r in d["rows"]]
            md.append("")
    return {"title": "Harbourside FC — Financial Report", "as_of": as_of,
            "sections": sections, "markdown": "\n".join(md)}


# --------------------------------------------------------------------------- #
# Simulation buttons (run the REAL gateway)
# --------------------------------------------------------------------------- #
@app.post("/api/sim/sync")
def sim_sync() -> dict:
    from pitwall.sow.sync import sync_bank_receipts

    created = sync_bank_receipts()
    return {"ok": True, "created": created,
            "message": f"sync created {len(created)} work items from unmatched bank lines"
            if created else "no new receipts — cursor already caught up"}


@app.post("/api/sim/walk")
def sim_walk() -> dict:
    """Walk one NEW receipt item NEW→PROPOSED→(SoD denial)→APPROVED→POSTED, live."""
    from pitwall.sow import gateway
    from pitwall.sow.roles import Actor, GATEWAY
    from pitwall.sow.sync import sync_bank_receipts
    from pitwall.sow.transitions import Denied

    sync_bank_receipts()
    row = _rows("SELECT id FROM work.work_item WHERE kind='reconcile_receipt' AND state='NEW' "
                "ORDER BY updated_at DESC LIMIT 1")
    if not row:
        raise HTTPException(409, "no NEW receipt work item to walk — click Sync first")
    wi = row[0]["id"]
    agent = Actor("ai_agent", "ai_agent")
    priya = Actor("accountant:priya", "human_accountant")
    steps = []

    gateway.transition(agent, wi, "propose",
                       patch={"proposed_by": "ai_agent",
                              "proposal": {"action": "match", "note": "memo matches one invoice; gap within tolerance"}},
                       reason="pol-001: gap within tolerance")
    steps.append({"actor": "ai_agent", "action": "propose", "ok": True, "state": "NEW→PROPOSED"})

    try:
        gateway.transition(agent, wi, "approve", reason="self-approve attempt")
    except Denied as e:
        steps.append({"actor": "ai_agent", "action": "approve", "ok": False,
                      "state": "—", "why": e.why})

    gateway.transition(priya, wi, "approve", patch={"approved_by": "accountant:priya"},
                       reason="match confirmed")
    steps.append({"actor": "human_accountant", "action": "approve", "ok": True,
                  "state": "PROPOSED→APPROVED"})

    gateway.post(GATEWAY, wi,
                 journal_lines=[{"account": "1000 Cash", "debit": 0, "credit": 0, "memo": "receipt matched"}],
                 reason="posted to ledger")
    steps.append({"actor": "gateway", "action": "post", "ok": True, "state": "APPROVED→POSTED"})

    return {"ok": True, "work_item": wi, "steps": steps, "audit": audit(wi)}


def _ensure_seeded() -> None:
    row = _rows("SELECT 1 FROM work.work_item WHERE id='WI-5602'")
    if not row:
        from pitwall.explain.seed_demo import seed
        seed()


@app.post("/api/sim/fraud")
def sim_fraud() -> dict:
    """The fraud-hold moment (WI-5602): the real work item + its explanation + audit."""
    _ensure_seeded()
    return {"ok": True, "work_item": "WI-5602",
            "headline": "Bank-detail change from a lookalike domain → bought a bank check → "
                        "mismatch → HELD, routed to CFO",
            "explanation": explain("WI-5602"), "audit": audit("WI-5602")}


@app.post("/api/sim/addon")
def sim_addon() -> dict:
    """The add-on dispute (WI-5611): invoiced 25 appearances, only 24 league → REJECT."""
    _ensure_seeded()
    return {"ok": True, "work_item": "WI-5611",
            "headline": "Counterparty invoiced a 25-appearance add-on; match data shows 24 "
                        "league appearances → REJECTED with clause + match ids",
            "explanation": explain("WI-5611"), "audit": audit("WI-5611")}


@app.get("/api/explain/{wi}")
def explain(wi: str) -> dict:
    from pitwall.explain import plan as planmod

    try:
        return planmod.build_plan(wi)
    except Exception as e:  # noqa: BLE001
        return {"title": wi, "scenes": [], "error": str(e)}


# --------------------------------------------------------------------------- #
# Free scenario — live agent trail streamed over SSE (deck slide 12)
# --------------------------------------------------------------------------- #
@app.get("/api/scenario/stream")
async def scenario_stream(text: str) -> StreamingResponse:
    """Run a free-text scenario and stream every think/run_sql/propose/gate/post/audit
    step to the browser as Server-Sent Events. The agent runs in a worker thread
    (it's blocking — Claude + DB); steps cross into the event loop via a queue."""
    from pitwall.agent.scenario import run_scenario

    loop = asyncio.get_event_loop()
    q: asyncio.Queue = asyncio.Queue()
    collected: list = []
    wi_ref = {"wi": None}

    def emit(step: dict) -> None:
        collected.append(step)
        w = (step.get("data") or {}).get("wi")
        if w:
            wi_ref["wi"] = w
        loop.call_soon_threadsafe(q.put_nowait, step)

    def work() -> None:
        try:
            run_scenario(text, emit)
        except Exception as e:  # noqa: BLE001
            loop.call_soon_threadsafe(q.put_nowait, {"actor": "system", "kind": "error", "text": str(e)})
        finally:
            # save the whole trail so History can reopen exactly what the agent did
            try:
                wi = wi_ref["wi"] or ("WI-scn-" + hashlib.md5(text.encode()).hexdigest()[:8])
                _save_trace(wi, text, collected)
            except Exception:  # noqa: BLE001
                pass
            loop.call_soon_threadsafe(q.put_nowait, {"kind": "done"})

    threading.Thread(target=work, daemon=True).start()

    async def gen():
        while True:
            step = await q.get()
            yield f"data: {json.dumps(step, default=str)}\n\n"
            if step.get("kind") == "done":
                break

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/scenario/trace/{wi}")
def scenario_trace(wi: str) -> dict:
    """The saved trace of a Teamwork-Terminal run — its full trail of thought, the queries
    it ran + rows it touched, and the decision. Lets History reopen exactly what the agent
    did. Returns {found: false} for runs that predate trace-saving."""
    import re

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", wi or ""):
        raise HTTPException(400, "bad wi")
    try:
        rows = _rows("SELECT wi, text, at, steps FROM work.scenario_trace WHERE wi = %s", (wi,))
    except Exception:  # noqa: BLE001 — table may not exist until the first run is saved
        rows = []
    if not rows:
        return {"found": False, "wi": wi, "steps": []}
    r = rows[0]
    return {"found": True, "wi": r["wi"], "text": r["text"], "at": str(r["at"]), "steps": r["steps"]}


@app.post("/api/scenario/resolve")
def scenario_resolve(wi: str, situation: str = "", decision: str = "", role: str = "") -> dict:
    """HUMAN-IN-THE-LOOP: a human resolves an escalation the agent raised in the Teamwork
    Terminal. (1) records the decision as a precedent, (2) applies it through the gateway
    (answer → approve, logged), (3) lets the agent try to GENERALIZE a policy from the
    accumulated precedents — so the same correction is never needed twice (HITL ↓)."""
    import re

    from pitwall.agent import humans, improve
    from pitwall.sow import gateway

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", wi or ""):
        raise HTTPException(400, "bad wi")
    sit = situation or "unknown"
    actor = {"human_cfo": humans.CFO, "human_accountant": humans.ACCOUNTANT,
             "human_controller": humans.CONTROLLER}.get(role, humans.CONTROLLER)

    # 1) record the human's call as a precedent (the agent's memory, in the DB)
    precedent = None
    try:
        precedent = improve.record_correction(wi, sit, {"decision": decision, "by": actor.id}, actor.id)
    except Exception:  # noqa: BLE001
        pass

    # 2) apply it through the gateway — answer the question, then approve (best-effort:
    #    whichever transition is valid from the item's current state fires)
    applied = False
    for action in ("answer", "approve"):
        try:
            gateway.transition(actor, wi, action,
                               patch={"approved_by": actor.id} if action == "approve" else None,
                               reason=f"human {actor.role}: {decision}" if decision else f"human {action}")
            applied = True
        except Exception:  # noqa: BLE001
            pass

    # 3) learn: generalize a policy once ≥3 alike precedents exist (controller reviews)
    try:
        learned = improve.propose_from_precedents(sit)
    except Exception as e:  # noqa: BLE001
        learned = {"status": "error", "reason": str(e)[:120]}

    return {"ok": True, "wi": wi, "precedent": precedent, "applied": applied,
            "by": actor.id, "learned": learned, "audit": audit(wi)}


# --------------------------------------------------------------------------- #
# LiveKit — mint a join token so the stadium can host the report agent on a billboard.
# Returns {"error": ...} (not 503) when voice isn't configured so the frontend can
# fall back to the HTTP report (/api/explain/{wi}) cleanly.
# --------------------------------------------------------------------------- #
@app.get("/api/livekit/token")
def livekit_token(room: str = "pitwall-report", identity: str = "stadium") -> dict:
    from pitwall.config import get_settings

    s = get_settings()
    if not (s.livekit_url and s.livekit_api_key and s.livekit_api_secret):
        return {"error": "livekit-not-configured"}
    try:
        from livekit import api

        jwt = (
            api.AccessToken(s.livekit_api_key, s.livekit_api_secret)
            .with_identity(identity)
            .with_name(identity)
            # subscribe to the worker's Cartesia audio track + send explain-requests;
            # the stadium is a listener, so it never needs can_publish (no track).
            .with_grants(api.VideoGrants(room_join=True, room=room,
                                         can_subscribe=True, can_publish_data=True))
            .to_jwt()
        )
        return {"token": jwt, "url": s.livekit_url, "room": room}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


# --------------------------------------------------------------------------- #
# Cartesia voice — the HTTP fallback. The LiveKit worker (voice/agent.py) voices
# the live room track; when that worker isn't up, the billboard calls this per
# say-line so narration is still Cartesia (not the robotic browser voice). The
# key stays server-side. 404 when unconfigured → the browser drops to Web-Speech.
# --------------------------------------------------------------------------- #
@app.get("/api/voice")
def voice_tts(text: str = ""):
    from fastapi.responses import JSONResponse, Response

    from pitwall.explain import tts

    if not tts.is_configured():
        return JSONResponse({"error": "voice-not-configured"}, status_code=404)
    t = (text or "").strip()
    if not t:
        return JSONResponse({"error": "empty-text"}, status_code=400)
    try:
        audio = tts.mp3(t)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=502)
    return Response(content=audio, media_type="audio/mpeg",
                    headers={"Cache-Control": "public, max-age=3600"})


@app.get("/api/sample-report")
def sample_report() -> dict:
    """The prepared financial-report script (self-contained, no DB) the LiveKit
    worker narrates. Served here too so the /report page can render + HTTP-narrate
    it (via /api/voice) when the worker isn't running."""
    p = Path(__file__).resolve().parents[1] / "voice" / "samples" / "financial-report.json"
    if not p.exists():
        from fastapi.responses import JSONResponse

        return JSONResponse({"error": "sample-missing"}, status_code=404)
    return json.loads(p.read_text())


@app.get("/api/report-video")
async def report_video(fresh: int = 0, wi: str = ""):
    """Render a narrated report to a downloadable MP4 (Cartesia voice + the report
    slides, stitched by ffmpeg). With `?wi=WI-xxxx` it renders THAT transaction's
    report (the agent's reasoning + evidence); otherwise the standing financial
    report. Cached after the first build (~40s); `?fresh=1` rebuilds. 404 when
    Cartesia isn't configured."""
    import re
    import tempfile

    from fastapi.responses import FileResponse, JSONResponse

    from pitwall.explain import tts, video

    if not tts.is_configured():
        return JSONResponse({"error": "voice-not-configured"}, status_code=404)

    plan = None
    if wi:
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", wi):
            return JSONResponse({"error": "bad wi"}, status_code=400)
        from pitwall.explain import plan as planmod

        try:
            plan = video.plan_from_explain(planmod.build_plan(wi))
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"error": str(e)}, status_code=500)
        name = f"harbourside-{wi}.mp4"
    else:
        name = "harbourside-financial-report.mp4"

    out = Path(tempfile.gettempdir()) / name
    if fresh or not out.exists():
        try:
            await asyncio.to_thread(video.build_report_video, str(out), plan=plan)
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"error": str(e)}, status_code=500)
    return FileResponse(str(out), media_type="video/mp4", filename=name)


# --------------------------------------------------------------------------- #
# Serve the frontend
# --------------------------------------------------------------------------- #
@app.get("/report")
def report_ui() -> FileResponse:
    """The standalone financial-report billboard: click play → Cartesia narrates
    over LiveKit while the report builds on screen (edtech-style)."""
    return FileResponse(WEB / "report.html")


@app.get("/txreport")
def txreport_ui() -> FileResponse:
    """A single transaction's report, opened in its own window from the History
    board: the agent's thinking, what it touched, the human input — and a button to
    turn it into a narrated video."""
    return FileResponse(WEB / "txreport.html")


@app.get("/scenario-report")
def scenario_report_ui() -> FileResponse:
    """The full report for a Teamwork-Terminal run (opened in a new window): the agent's
    trace of thought, every query it ran + the rows it touched, and its decision."""
    return FileResponse(WEB / "scenario-report.html")
@app.get("/")
def index() -> RedirectResponse:
    return RedirectResponse("/fc/index.html")  # the stadium is the home


@app.get("/home")
def home_ui() -> FileResponse:
    return FileResponse(WEB / "home.html")


@app.get("/control")
def control_ui() -> FileResponse:
    return FileResponse(WEB / "scenario.html")


@app.get("/board")
def board_ui() -> FileResponse:
    return FileResponse(WEB / "board.html")


@app.get("/match")
def match_ui() -> FileResponse:
    return FileResponse(WEB / "football.html")


# Serve the whole 3D stadium (web/fc) same-origin — one server, no :8000, no CORS.
app.mount("/fc", StaticFiles(directory=str(WEB / "fc"), html=True), name="fc")
