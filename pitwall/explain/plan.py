"""Pit Wall as an explainer *provider*: build grounded scenes + 'build it live'
canvas draws from the football world (via the read-only tools), then hand them to
the generic `explainer` engine for say-writing + grounding validation. All the
narration/validation logic lives in `explainer`; this file is just the adapter."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from explainer import engine
from explainer.llm import make_anthropic_say_writer

from ..config import get_settings
from ..db import connect
from . import tools

# re-export so callers (CLI) validate through the one engine
validate_scene = engine.validate_scene

CCY = {"EUR": "€", "GBP": "£", "USD": "$"}
SCENE_ORDER = ["email", "history", "bank_check", "clause", "match", "rule"]
STATE_DESC = {
    "HELD": "on hold", "REJECTED": "rejected", "POSTED": "completed",
    "APPROVED": "approved", "PROPOSED": "proposed", "NEEDS_INFO": "waiting on an answer",
}
UI = {k: ("evidence", k) for k in SCENE_ORDER}


def _money(amount: float, ccy: str) -> str:
    return f"{CCY.get(ccy, '')}{amount:,.0f}"


def _fact(key: str, value: str, source: str) -> dict[str, str]:
    return {"key": key, "value": value, "source": source}


def _scene_for(block: dict[str, Any], wi: dict[str, Any]) -> dict[str, Any] | None:
    key = block["key"]
    panel, highlight = UI[key]
    ui = {"focus": wi["id"], "panel": panel, "highlight": highlight}
    if key == "email":
        amt = _money(block["amount"], block["currency"])
        facts = [_fact("amount", amt, "work_item.proposal.amount"),
                 _fact("from_domain", block["from_domain"], "inbox_message.from_domain")]
        say = f"An email from {block['from_domain']} asked us to change the payee for a {amt} transfer."
    elif key == "history":
        n = str(block["prior_payments"])
        facts = [_fact("prior_payments", n, "counterparty_baseline")]
        say = f"{block['payee']} has paid to the same verified account for {n} straight installments."
    elif key == "bank_check":
        cost = f"${block['cost_usdc']:.2f}"
        ui["pulse"] = "tx_hash"
        facts = [_fact("cost", cost, "x402_payment.amount_usdc"),
                 _fact("result", block["result"], "x402_payment.response.result")]
        say = f"So I spent {cost} to verify the account — it came back a {block['result']}."
    elif key == "clause":
        thr = str(block["threshold"])
        facts = [_fact("threshold", thr, "contract_clause.params.threshold"),
                 _fact("competitions", block["competitions"], "contract_clause.competitions_counted")]
        say = f"The clause only counts {block['competitions']} appearances, and needs {thr} of them."
    elif key == "match":
        obs = str(block["observed_league"])
        facts = [_fact("observed_league", obs, "match_event (official)")]
        say = f"Official match data shows {obs} qualifying appearances — below the threshold."
    elif key == "rule":
        facts = [_fact("policy", f"{block['policy_id']} v{block['policy_version']}", "policy")]
        state = STATE_DESC.get(wi["state"], wi["state"].lower())
        say = f"The payment is {state}. Releasing it needs {block['requirement']}."
    else:
        return None
    return {"say": say, "ui": ui, "facts": facts}


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _build_scenes(wi: dict[str, Any], until: datetime | None) -> list[dict[str, Any]]:
    blocks = wi.get("evidence") or []
    if until is not None:
        blocks = [b for b in blocks if "at" not in b or _parse(b["at"]) <= until]
    by_key = {b["key"]: b for b in blocks}
    scenes = []
    for key in SCENE_ORDER:
        if key in by_key:
            sc = _scene_for(by_key[key], wi)
            if sc:
                scenes.append(sc)
    return scenes


def _mask(iban: str | None) -> str:
    if not iban or len(iban) < 8:
        return iban or "—"
    return f"{iban[:4]}…{iban[-4:]}"


def _attach_draws(wi: dict[str, Any], scenes: list[dict[str, Any]]) -> None:
    """Build the 'build it live' canvas from tool rows only (grounded by construction)."""
    refs = wi.get("subject_refs") or {}
    ev = {b["key"]: b for b in (wi.get("evidence") or [])}
    by_hl = {sc["ui"].get("highlight"): sc for sc in scenes}

    if "history" in by_hl and refs.get("installment_id") and refs.get("inbox_id"):
        insts = tools.installment_history(refs["installment_id"])
        verified, claimed = tools.fraud_ibans(refs["installment_id"], refs["inbox_id"])
        rows, hl = [], None
        for idx, i in enumerate(insts):
            if i["status"] == "paid":
                rows.append([str(i["seq"]), _mask(i["counterparty_iban"] or verified), "no"])
            else:
                rows.append([f"{i['seq']} (new)", _mask(claimed), "YES"])
                hl = idx
        if rows:
            by_hl["history"]["draw"] = {"type": "table", "title": "installment history",
                                        "columns": ["Installment", "Account", "Changed?"],
                                        "rows": rows, "highlight_row": hl}
    if "bank_check" in by_hl and wi.get("confidence_checks"):
        by_hl["bank_check"]["draw"] = {
            "type": "checks", "title": "hard checks",
            "items": [{"label": c["check"], "ok": bool(c["passed"])}
                      for c in wi["confidence_checks"]]}
    if "rule" in by_hl:
        by_hl["rule"]["draw"] = {"type": "flow", "title": "escalation",
                                 "boxes": ["bank check ✗", "HOLD", "needs CFO"]}
    if "match" in by_hl and "match" in ev:
        obs = ev["match"]["observed_league"]
        thr = ev.get("clause", {}).get("threshold", 25)
        by_hl["match"]["draw"] = {"type": "calc", "title": "appearance check",
                                  "lines": [f"League appearances   {obs}", f"Threshold            {thr}",
                                            f"{obs} < {thr}  ->  add-on not triggered"]}


def build_plan(work_item_id: str, as_of: datetime | None = None) -> dict[str, Any]:
    from datetime import timezone

    if as_of is not None and as_of.tzinfo is None:
        as_of = as_of.replace(tzinfo=timezone.utc)
    wi = tools.get_work_item(work_item_id)
    if wi is None:
        raise ValueError(f"no work item {work_item_id} (run `pitwall explain seed-demo`?)")

    if as_of is not None:
        st = tools.state_as_of(work_item_id, as_of)
        if st:
            wi = dict(wi, state=st)
    scenes = _build_scenes(wi, as_of)
    _attach_draws(wi, scenes)

    if as_of is not None:
        now_state = tools.get_work_item(work_item_id)["state"]
        if now_state != wi["state"]:
            scenes.append({
                "say": f"Since then, this moved to {STATE_DESC.get(now_state, now_state)}.",
                "ui": {"focus": work_item_id, "panel": "audit", "highlight": "audit"},
                "facts": [_fact("now_state", now_state, "work_item.state")]})

    request = {"subject_id": work_item_id,
               "as_of": as_of.isoformat() if as_of else None,
               "title": f"{wi['kind']} — {STATE_DESC.get(wi['state'], wi['state'])}",
               "scenes": scenes}
    s = get_settings()
    say_writer = make_anthropic_say_writer(s.anthropic_api_key, s.pitwall_agent_model) \
        if s.llm_is_live else None
    return engine.build_plan(request, say_writer=say_writer)


def persist_plan(plan: dict[str, Any]) -> str:
    """Append the explanation + an audit row THROUGH THE GATEWAY (the one door)."""
    import uuid

    from psycopg.types.json import Json

    pid = f"exp-{uuid.uuid4().hex[:10]}"
    subject = plan["subject_id"]
    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO work.explanation (id, work_item_id, plan, as_of) VALUES (%s,%s,%s,%s)",
                (pid, subject, Json(plan),
                 datetime.fromisoformat(plan["as_of"]) if plan["as_of"] else None))
            cur.execute(
                "INSERT INTO work.audit_log (actor, action, subject, allowed, reason, diff) "
                "VALUES ('explainer','explain',%s,true,%s,%s)",
                (subject, f"generated {len(plan['scenes'])}-scene explanation",
                 Json({"explanation_id": pid})))
        conn.commit()
    finally:
        conn.close()
    return pid
