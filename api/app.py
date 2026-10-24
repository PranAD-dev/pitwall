"""Harbourside FC — finance control backend.

A thin FastAPI layer over the REAL system: the System of Work gateway (M1), the
cloud Postgres data, and the grounded Explainer. The frontend's buttons hit these
endpoints and every result is live — work items actually transition through the
gateway, denials are actually logged, the audit trail is actually queried.

  uv run uvicorn api.app:app --port 4055   ->   open http://localhost:4055
"""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
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
    """The forecast system of record (slide 7) — projected cash + squad-cost ratio."""
    from pitwall.agent.forecast import snapshot

    return snapshot()


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
    """Transaction history as a navigable chain of events. Every transaction gets its
    append-only audit trail (what changed, step by step); transactions we can explain
    also get the agent's grounded train-of-thought + evidence scenes layered in."""
    from pitwall.explain import plan as planmod

    recent = _rows(
        "SELECT subject, max(at) mx FROM work.audit_log WHERE subject LIKE 'WI-%%' "
        "GROUP BY subject ORDER BY mx DESC LIMIT 10")
    order, seen = [], set()
    for wi in ("WI-5602", "WI-5611"):            # the two rich, seeded decisions first
        order.append(wi); seen.add(wi)
    for r in recent:
        if r["subject"] not in seen:
            order.append(r["subject"]); seen.add(r["subject"])

    events: list[dict] = []
    txn = 0
    for wi in order[:8]:
        trail = _rows("SELECT at, actor, action, allowed, reason, diff FROM work.audit_log "
                      "WHERE subject = %s ORDER BY at", (wi,))
        if not trail:
            continue
        wrow = _rows("SELECT kind, state FROM work.work_item WHERE id = %s", (wi,))
        kind = wrow[0]["kind"] if wrow else ""
        state = wrow[0]["state"] if wrow else ""
        title = f"{kind} — {state}" if kind else wi

        # 1) the chain of what changed (append-only audit log) as a timeline table
        rows = []
        last_reason = ""
        for e in trail:
            diff = e["diff"] or {}
            st = diff.get("state")
            trans = f"{st['from']}→{st['to']}" if st else (e["action"] or "")
            flag = "" if e["allowed"] else " ✗"
            rows.append([str(e["at"])[11:19], e["actor"], trans + flag])
            if e["reason"]:
                last_reason = e["reason"]
        events.append({
            "wi": wi, "txn": txn, "head": True,
            "title": title,
            "say": f"{wi} — {kind or 'transaction'}" + (f", resolved {state}." if state else "."),
            "draw": {"type": "table", "title": "what changed · append-only audit",
                     "columns": ["time", "actor", "transition"], "rows": rows,
                     "highlight_row": len(rows) - 1},
            "meta": last_reason[:90],
        })

        # 2) the agent's train of thought + evidence, where we can ground it
        try:
            plan = planmod.build_plan(wi)
            for sc in plan.get("scenes", []):
                events.append({"wi": wi, "txn": txn, "title": plan.get("title", title),
                               "say": sc.get("say", ""), "draw": sc.get("draw")})
        except Exception:
            pass
        txn += 1

    return {"count": len(events), "transactions": txn, "events": events}


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

    def emit(step: dict) -> None:
        loop.call_soon_threadsafe(q.put_nowait, step)

    def work() -> None:
        try:
            run_scenario(text, emit)
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
            .with_grants(api.VideoGrants(room_join=True, room=room))
            .to_jwt()
        )
        return {"token": jwt, "url": s.livekit_url, "room": room}
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


# --------------------------------------------------------------------------- #
# Serve the frontend
# --------------------------------------------------------------------------- #
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
