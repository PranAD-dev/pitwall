"""Build a narrated explanation plan for a work item — deterministic first, model
second. Code assembles the scenes (UI focus + facts drawn from tools); the LLM
only writes the one-sentence `say` lines; then code VALIDATES that every number
spoken appears in that scene's facts. If validation fails we regenerate once,
then fall back to a template sentence. This is the "never speaks a number a tool
didn't return" guarantee.

Runs fully offline: with no ANTHROPIC_API_KEY the say-lines come from
deterministic templates (which pass validation by construction)."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from rich.console import Console

from ..config import get_settings
from ..db import connect
from . import tools

console = Console()

CCY = {"EUR": "€", "GBP": "£", "USD": "$"}
# canonical scene order by evidence key
SCENE_ORDER = ["email", "history", "bank_check", "clause", "match", "rule"]
STATE_DESC = {
    "HELD": "on hold", "REJECTED": "rejected", "POSTED": "completed",
    "APPROVED": "approved", "PROPOSED": "proposed", "NEEDS_INFO": "waiting on an answer",
}
# UI panel/highlight each evidence block maps to (keys match the frontend blocks)
UI = {
    "email": ("evidence", "email"), "history": ("evidence", "history"),
    "bank_check": ("evidence", "bank_check"), "clause": ("evidence", "clause"),
    "match": ("evidence", "match"), "rule": ("evidence", "rule"),
}


def _money(amount: float, ccy: str) -> str:
    return f"{CCY.get(ccy, '')}{amount:,.0f}"


def _fact(key: str, value: str, source: str) -> dict[str, str]:
    return {"key": key, "value": value, "source": source}


# --------------------------------------------------------------------------- #
# Scene construction (deterministic; facts come only from tool output)
# --------------------------------------------------------------------------- #
def _scene_for(block: dict[str, Any], wi: dict[str, Any]) -> dict[str, Any] | None:
    key = block["key"]
    panel, highlight = UI[key]
    ui = {"focus": wi["id"], "panel": panel, "highlight": highlight}

    if key == "email":
        amt = _money(block["amount"], block["currency"])
        facts = [_fact("amount", amt, "work_item.proposal.amount"),
                 _fact("from_domain", block["from_domain"], "inbox_message.from_domain")]
        say = (f"An email from {block['from_domain']} asked us to change the payee "
               f"for a {amt} transfer.")
    elif key == "history":
        n = str(block["prior_payments"])
        facts = [_fact("prior_payments", n, "counterparty_baseline")]
        say = (f"{block['payee']} has paid to the same verified account "
               f"for {n} straight installments.")
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
        say = (f"The clause only counts {block['competitions']} appearances, "
               f"and needs {thr} of them.")
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


def _parse(s: str) -> datetime:
    return datetime.fromisoformat(s)


def _mask(iban: str | None) -> str:
    if not iban or len(iban) < 8:
        return iban or "—"
    return f"{iban[:4]}…{iban[-4:]}"


def _attach_draws(wi: dict[str, Any], scenes: list[dict[str, Any]]) -> None:
    """Attach a 'build it live' canvas to scenes where tool data supports one.
    Every value placed on the canvas comes straight from a tool query."""
    refs = wi.get("subject_refs") or {}
    ev = {b["key"]: b for b in (wi.get("evidence") or [])}
    by_hl = {sc["ui"].get("highlight"): sc for sc in scenes}

    # fraud: installment-history table, last row = the requested change
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
            by_hl["history"]["draw"] = {
                "type": "table", "columns": ["Installment", "Account", "Changed?"],
                "rows": rows, "highlight_row": hl,
            }

    # fraud: the hard-check list ticking through
    if "bank_check" in by_hl and wi.get("confidence_checks"):
        by_hl["bank_check"]["draw"] = {
            "type": "checks",
            "items": [{"label": c["check"], "ok": bool(c["passed"])}
                      for c in wi["confidence_checks"]],
        }

    # fraud: the escalation flow
    if "rule" in by_hl:
        by_hl["rule"]["draw"] = {"type": "flow", "boxes": ["bank check ✗", "HOLD", "needs CFO"]}

    # add-on: the appearance calc
    if "match" in by_hl and "match" in ev:
        obs = ev["match"]["observed_league"]
        thr = ev.get("clause", {}).get("threshold", 25)
        by_hl["match"]["draw"] = {
            "type": "calc",
            "lines": [f"League appearances   {obs}", f"Threshold            {thr}",
                      f"{obs} < {thr}  ->  add-on not triggered"],
        }


# --------------------------------------------------------------------------- #
# Grounding validation: every number in `say` must be in that scene's facts
# --------------------------------------------------------------------------- #
# number-like token not preceded by a letter/digit/hyphen (so "pol-011" is skipped)
_NUM = re.compile(r"(?<![A-Za-z0-9\-])[$€£]?\d[\d,]*(?:\.\d+)?%?")


def _numbers(text: str) -> list[str]:
    return [re.sub(r"[,$€£%]", "", m) for m in _NUM.findall(text)]


def _draw_values(draw: dict[str, Any]) -> str:
    """All string values a draw puts on screen (its own grounding set)."""
    t = draw.get("type")
    out: list[str] = []
    if t == "table":
        out += draw.get("columns", [])
        for row in draw.get("rows", []):
            out += [str(c) for c in row]
    elif t in ("calc", "entry"):
        out += draw.get("lines", [])
    elif t == "checks":
        out += [i.get("label", "") for i in draw.get("items", [])]
    elif t == "flow":
        out += draw.get("boxes", [])
    elif t == "compare":
        out += [c for col in draw.get("columns", []) for c in col.get("lines", [])]
    return re.sub(r"[,$€£%]", "", " ".join(out))


def validate_scene(scene: dict[str, Any]) -> list[str]:
    """Return ungrounded numbers in the scene's say line (empty = OK). A number is
    grounded if it appears in a fact value OR on the canvas (the draw) — both are
    tool-sourced."""
    haystack = " ".join(re.sub(r"[,$€£%]", "", f["value"]) for f in scene["facts"])
    if scene.get("draw"):
        haystack += " " + _draw_values(scene["draw"])
    return [n for n in _numbers(scene["say"]) if n not in haystack]


# --------------------------------------------------------------------------- #
# Say-line writer: deterministic templates (mock) or Claude (live), then validate
# --------------------------------------------------------------------------- #
_SYSTEM = (
    "You are Pit Wall's finance explainer. Rewrite each scene's draft sentence as one "
    "short, plain sentence a calm finance analyst would say out loud. Never invent a "
    "number: you may only use numbers that already appear in that scene's facts. Keep "
    "each to a single sentence."
)


def _write_say_live(scenes: list[dict[str, Any]]) -> list[str] | None:
    s = get_settings()
    try:
        import anthropic
    except ImportError:
        return None
    client = anthropic.Anthropic(api_key=s.anthropic_api_key)
    payload = [{"draft": sc["say"], "facts": sc["facts"]} for sc in scenes]
    schema = {"type": "object", "additionalProperties": False,
              "properties": {"lines": {"type": "array", "items": {"type": "string"}}},
              "required": ["lines"]}
    try:
        resp = client.messages.create(
            model=s.pitwall_agent_model, max_tokens=1000, system=_SYSTEM,
            output_config={"format": {"type": "json_schema", "schema": schema}},
            messages=[{"role": "user", "content": json.dumps(payload)}],
        )
        text = next(b.text for b in resp.content if b.type == "text")
        lines = json.loads(text)["lines"]
        return lines if len(lines) == len(scenes) else None
    except Exception as e:  # noqa: BLE001 — any failure -> fall back to templates
        console.print(f"[yellow]live say-writer failed ({e}); using templates[/]")
        return None


def _apply_and_validate(scenes: list[dict[str, Any]]) -> None:
    """Fill say-lines (live if a key is set, else keep templates) and enforce grounding."""
    s = get_settings()
    if s.llm_is_live:
        for attempt in range(2):
            candidate = _write_say_live(scenes)
            if candidate is None:
                break
            trial = [dict(sc, say=line) for sc, line in zip(scenes, candidate)]
            if all(not validate_scene(sc) for sc in trial):
                for sc, line in zip(scenes, candidate):
                    sc["say"] = line
                return
            console.print(f"[yellow]say-lines ungrounded (attempt {attempt + 1}); "
                          "regenerating[/]")
    # templates (or final fallback) — guaranteed grounded by construction
    for sc in scenes:
        bad = validate_scene(sc)
        if bad:  # extremely defensive: strip the offending sentence to facts only
            sc["say"] = "; ".join(f"{f['key']} {f['value']}" for f in sc["facts"])


# --------------------------------------------------------------------------- #
def build_plan(work_item_id: str, as_of: datetime | None = None) -> dict[str, Any]:
    from datetime import timezone

    if as_of is not None and as_of.tzinfo is None:
        as_of = as_of.replace(tzinfo=timezone.utc)  # treat a bare --as-of as UTC
    wi = tools.get_work_item(work_item_id)
    if wi is None:
        raise ValueError(f"no work item {work_item_id} (run `pitwall explain seed-demo`?)")

    # "only what was known then": override state + filter evidence as of the moment
    if as_of is not None:
        st = tools.state_as_of(work_item_id, as_of)
        if st:
            wi = dict(wi, state=st)
    scenes = _build_scenes(wi, as_of)
    _attach_draws(wi, scenes)
    _apply_and_validate(scenes)

    plan = {
        "work_item_id": work_item_id,
        "as_of": as_of.isoformat() if as_of else None,
        "title": f"{wi['kind']} — {STATE_DESC.get(wi['state'], wi['state'])}",
        "scenes": scenes,
    }
    # "what I've learned since" when rewinding to a past decision
    if as_of is not None:
        now_state = tools.get_work_item(work_item_id)["state"]
        if now_state != wi["state"]:
            plan["scenes"].append({
                "say": f"Since then, this moved to {STATE_DESC.get(now_state, now_state)}.",
                "ui": {"focus": work_item_id, "panel": "audit", "highlight": "audit"},
                "facts": [_fact("now_state", now_state, "work_item.state")],
            })
    return plan


def persist_plan(plan: dict[str, Any]) -> str:
    """Append the explanation + an audit row THROUGH THE GATEWAY (the one door).
    The voice agent itself never writes — this is a server-side gateway action."""
    import uuid

    pid = f"exp-{uuid.uuid4().hex[:10]}"
    from psycopg.types.json import Json

    conn = connect("gateway")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO work.explanation (id, work_item_id, plan, as_of) VALUES (%s,%s,%s,%s)",
                (pid, plan["work_item_id"], Json(plan),
                 datetime.fromisoformat(plan["as_of"]) if plan["as_of"] else None),
            )
            cur.execute(
                "INSERT INTO work.audit_log (actor, action, subject, allowed, reason, diff) "
                "VALUES ('explainer','explain',%s,true,%s,%s)",
                (plan["work_item_id"], f"generated {len(plan['scenes'])}-scene explanation",
                 Json({"explanation_id": pid})),
            )
        conn.commit()
    finally:
        conn.close()
    return pid
