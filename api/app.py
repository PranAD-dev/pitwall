"""Harbourside FC — finance control backend.

A thin FastAPI layer over the REAL system: the System of Work gateway (M1), the
cloud Postgres data, and the grounded Explainer. The frontend's buttons hit these
endpoints and every result is live — work items actually transition through the
gateway, denials are actually logged, the audit trail is actually queried.

  uv run uvicorn api.app:app --port 4055   ->   open http://localhost:4055
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
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
# Serve the frontend
# --------------------------------------------------------------------------- #
@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB / "football.html")
