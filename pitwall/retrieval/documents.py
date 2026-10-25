"""Tiger → Moss document builders. One builder per index; each turns real
golden/work rows into Moss documents whose `id` is the Tiger primary key and whose
`text` is what a human would search for. Metadata is string-only (Moss rule);
timestamps become 10-digit epoch strings so range filters compare correctly.

Reads run as the least-privilege `retrieval` role (SELECT on golden+work only —
no payroll, ever). NOTHING here is authoritative: the text is a searchable shadow
of Tiger, and every id points back to the row that holds the real numbers.
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from psycopg.rows import dict_row

from ..db import connect
from . import client as R

# imported lazily-safe: moss is a hard dependency, so a top-level import is fine
from moss import DocumentInfo  # noqa: E402


# --------------------------------------------------------------------------- #
# small read helpers (retrieval role; read-only)
# --------------------------------------------------------------------------- #
def _rows(cur, sql: str, params: tuple = ()) -> list[dict]:
    cur.execute(sql, params)
    return cur.fetchall()


def _one(cur, sql: str, params: tuple = ()) -> dict | None:
    cur.execute(sql, params)
    return cur.fetchone()


# --------------------------------------------------------------------------- #
# clauses — one document per contract clause (text = clause + plain-English gloss)
# --------------------------------------------------------------------------- #
def _n(params: dict, *keys: str) -> str:
    for k in keys:
        if params.get(k) is not None:
            v = params[k]
            return f"{v:,}" if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v)
    return "the agreed amount"


def clause_gloss(kind: str, params: dict, competitions: list | None, ambiguity: str | None) -> str:
    """Plain-English rendering rich in the natural trigger words a human (or a
    final-whistle cascade) would search for — this is what lets semantic retrieval
    surface a clause the structured `kind` lookup would miss."""
    comp = "/".join(competitions) if competitions else "all competitions"
    amt = _n(params, "amount", "fee", "bonus")
    thr = _n(params, "threshold", "appearances", "goals", "count")
    pct = _n(params, "pct", "percent", "percentage")
    g = {
        "addon_appearances": f"Appearance add-on: an extra {amt} becomes payable once the player "
                             f"reaches {thr} appearances counted in {comp}.",
        "addon_goals": f"Goal add-on: an extra {amt} becomes payable once the player scores {thr} "
                       f"goals in {comp}.",
        "stays_up": f"Survival bonus: {amt} is payable if the club stays up — i.e. retains its "
                    f"top-division status and avoids relegation this season.",
        "europe_bonus": f"European qualification bonus: {amt} is payable if the club qualifies for "
                        f"Europe / European competition.",
        "relegation_reduction": f"Relegation fee reduction: the transfer fee is reduced by {amt} if "
                                f"the club is relegated / drops to the second tier / loses its "
                                f"top-division status.",
        "relegation_wage_cut": "Relegation wage cut: player wages are reduced if the club is "
                               "relegated from the top division.",
        "sell_on": f"Sell-on clause: {pct}% of a future onward sale is owed to a previous club.",
        "obligation_to_buy": "Obligation to buy: the loan converts to a permanent transfer once the "
                             "stated condition (appearances / survival) is met.",
        "win_bonus": f"Result bonus: {amt} is payable on the agreed result / competition outcome.",
    }
    base = g.get(kind, f"Bespoke {kind.replace('_', ' ')} clause ({comp}).")
    wording = params.get("wording") or params.get("text")
    if wording:  # carry the real contract language into the searchable text
        base += f' Exact wording: "{wording}"'
    if ambiguity:
        base += f"  AMBIGUOUS — wording must be escalated, never auto-applied: {ambiguity}"
    return base


def _clause_context(cur, cl: dict) -> tuple[str | None, datetime | None]:
    """Resolve (counterparty name, valid_from) for a clause from its contract."""
    ct, cid = cl["contract_type"], cl["contract_id"]
    if ct == "transfer":
        t = _one(cur, "SELECT c.name, t.signed_at FROM golden.transfer t "
                      "LEFT JOIN golden.counterparty c ON c.id=t.counterparty_id WHERE t.id=%s", (cid,))
        if t:
            return t["name"], t["signed_at"]
    elif ct == "sponsor":
        s = _one(cur, "SELECT c.name FROM golden.sponsor_contract s "
                      "LEFT JOIN golden.counterparty c ON c.id=s.counterparty_id WHERE s.id=%s", (cid,))
        if s:
            return s["name"], None
    elif ct == "player":
        p = _one(cur, "SELECT name FROM golden.player WHERE id=%s", (cid,))
        if p:
            return p["name"], None
    return None, None


def _clause_doc(cur, cl: dict) -> DocumentInfo:
    gloss = clause_gloss(cl["kind"], cl.get("params") or {}, cl.get("competitions_counted"),
                         cl.get("ambiguity_note"))
    cp, valid_from = _clause_context(cur, cl)
    text = f"Clause {cl['id']} ({cl['contract_type']} contract {cl['contract_id']}" \
           + (f", {cp}" if cp else "") + f"). {gloss}"
    md = R.meta(
        contract_id=cl["contract_id"], contract_type=cl["contract_type"], counterparty=cp,
        clause_kind=cl["kind"],
        competitions_counted="/".join(cl["competitions_counted"]) if cl.get("competitions_counted") else None,
        ambiguous="true" if cl.get("ambiguity_note") else "false",
        valid_from=R.epoch_str(valid_from, default="0000000000"),
    )
    return DocumentInfo(id=cl["id"], text=text, metadata=md)


def build_clauses(cur) -> list[DocumentInfo]:
    return [_clause_doc(cur, cl) for cl in _rows(cur, "SELECT * FROM golden.contract_clause")]


# --------------------------------------------------------------------------- #
# policies — one document per policy version (text = policy + evidence summary)
# --------------------------------------------------------------------------- #
def _policy_doc(p: dict) -> DocumentInfo:
    ev = f"{p['evidence_count']} precedents" if p.get("evidence_count") else "no prior precedents"
    auto = "auto-approves matching work" if p.get("auto_approve") else "requires human approval"
    text = f"Policy {p['id']} v{p['version']} ({p['status']}; {auto}). {p['text']} " \
           f"Learned from {ev}."
    md = R.meta(
        policy_id=p["id"], version=p["version"], status=p["status"],
        auto_approve="true" if p.get("auto_approve") else "false",
        valid_from=R.epoch_str(p.get("valid_from"), default="0000000000"),
        valid_to=R.epoch_str(p.get("valid_to")),  # OPEN_ENDED when null → '9999999999'
    )
    return DocumentInfo(id=f"{p['id']}@v{p['version']}", text=text, metadata=md)


def build_policies(cur) -> list[DocumentInfo]:
    return [_policy_doc(p) for p in _rows(cur, "SELECT * FROM work.policy")]


# --------------------------------------------------------------------------- #
# decisions — one document per work item (latest grounded summary)
# --------------------------------------------------------------------------- #
_NUM = re.compile(r"\d[\d,]*(?:\.\d+)?")


def _nums(s: str) -> set[str]:
    return {m.replace(",", "") for m in _NUM.findall(s or "")}


def _decision_date(cur, wi: dict) -> datetime | None:
    """The domain date this decision pertains to (so 'in March' and as-of rewind are
    meaningful), preferring the real event over the processing timestamp."""
    r = wi.get("subject_refs") or {}
    probes = [
        ("golden.invoice", "issued_at", r.get("invoice_id") or r.get("original_invoice_id")
         or r.get("duplicate_invoice_id")),
        ("golden.installment", "due_date", r.get("installment_id")),
        ("golden.bank_transaction", "txn_time", r.get("txn_id")),
    ]
    for table, col, key in probes:
        if key:
            row = _one(cur, f"SELECT {col} AS d FROM {table} WHERE id=%s", (key,))
            if row and row["d"]:
                d = row["d"]
                return d if isinstance(d, datetime) else datetime(d.year, d.month, d.day)
    if r.get("transfer_id"):
        row = _one(cur, "SELECT signed_at AS d FROM golden.transfer WHERE id=%s", (r["transfer_id"],))
        if row and row["d"]:
            return row["d"]
    # fall back to the real last-transition time, else updated_at
    a = _one(cur, "SELECT max(at) AS d FROM work.audit_log WHERE subject=%s", (wi["id"],))
    if a and a["d"]:
        return a["d"]
    return wi.get("updated_at")


def _decision_context(cur, wi: dict) -> tuple[str | None, float | None, str | None]:
    """(counterparty name, amount, currency) best-effort from subject_refs/proposal."""
    r = wi.get("subject_refs") or {}
    prop = wi.get("proposal") or {}
    cp = None
    if r.get("counterparty_id"):
        row = _one(cur, "SELECT name FROM golden.counterparty WHERE id=%s", (r["counterparty_id"],))
        cp = row["name"] if row else None
    if not cp and r.get("transfer_id"):
        row = _one(cur, "SELECT c.name FROM golden.transfer t LEFT JOIN golden.counterparty c "
                        "ON c.id=t.counterparty_id WHERE t.id=%s", (r["transfer_id"],))
        cp = row["name"] if row else None
    amount = prop.get("amount")
    ccy = prop.get("currency")
    if amount is None and r.get("amount") is not None:
        amount, ccy = r.get("amount"), r.get("currency")
    return cp, (float(amount) if amount is not None else None), ccy


def _decision_record(wi: dict, cp: str | None, amount: float | None, ccy: str | None,
                     decided: datetime | None) -> str:
    prop = wi.get("proposal") or {}
    parts = [f"Work item {wi['id']}: {wi['kind']} for {cp or 'a counterparty'}."]
    if prop.get("action"):
        parts.append(f"Decision: {prop['action']}.")
    if amount is not None:
        parts.append(f"Amount: {amount:,.0f} {ccy or ''}.".strip())
    reason = prop.get("reason") or prop.get("note")
    if reason:
        parts.append(f"Reason: {reason}")
    if wi.get("failing_check"):
        parts.append(f"Failing check: {wi['failing_check']}.")
    parts.append(f"Current state: {wi['state']}.")
    if decided:
        parts.append(f"Decided around {decided.date().isoformat()}.")
    return " ".join(parts)


def _summarize(record: str, *, llm) -> str:
    """1–3 sentence summary. If an LLM is given, use it but VALIDATE: every number in
    the summary must appear in the record, else fall back to the (grounded) record."""
    if not llm:
        return record
    try:
        import anthropic

        client = anthropic.Anthropic(api_key=llm["key"])
        msg = client.messages.create(
            model=llm["model"], max_tokens=180,
            system="Summarize this finance decision in 1-3 plain sentences for semantic search. "
                   "Use ONLY facts and numbers present in the record. No preamble.",
            messages=[{"role": "user", "content": record}])
        out = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
        if out and _nums(out) <= _nums(record):  # no invented numbers
            return out
    except Exception:
        pass
    return record  # grounded fallback


def _decision_doc(cur, wi: dict, *, llm) -> DocumentInfo:
    cp, amount, ccy = _decision_context(cur, wi)
    decided = _decision_date(cur, wi)
    record = _decision_record(wi, cp, amount, ccy, decided)
    summary = _summarize(record, llm=llm)
    md = R.meta(
        work_item_id=wi["id"], kind=wi["kind"], state=wi["state"], counterparty=cp,
        decided_at=R.epoch_str(decided, default="0000000000"),
        amount=(f"{amount:.2f}" if amount is not None else None), currency=ccy,
    )
    return DocumentInfo(id=wi["id"], text=summary, metadata=md)


def build_decisions(cur, *, llm=None) -> list[DocumentInfo]:
    return [_decision_doc(cur, wi, llm=llm)
            for wi in _rows(cur, "SELECT * FROM work.work_item ORDER BY updated_at")]


# --------------------------------------------------------------------------- #
# precedents — one document per human correction
# --------------------------------------------------------------------------- #
def _role_of(actor: str | None) -> str | None:
    if not actor:
        return None
    head = actor.split(":", 1)[0]
    return {"accountant": "human_accountant", "controller": "human_controller",
            "cfo": "human_cfo"}.get(head, head)


def _precedent_doc(p: dict) -> DocumentInfo:
    corr = p.get("correction") or {}
    did = corr.get("did") or corr.get("change") or "corrected the agent's handling"
    club = f" ({corr['club']})" if corr.get("club") else ""
    text = f"Precedent on {p['work_item_id']}: a human {_role_of(p.get('actor')) or 'reviewer'} " \
           f"{did}{club}. Pattern: {p.get('situation')}."
    md = R.meta(
        work_item_id=p["work_item_id"], actor_role=_role_of(p.get("actor")),
        pattern_key=p.get("situation"), at=R.epoch_str(p.get("at"), default="0000000000"),
    )
    return DocumentInfo(id=p["id"], text=text, metadata=md)


def build_precedents(cur) -> list[DocumentInfo]:
    return [_precedent_doc(p) for p in _rows(cur, "SELECT * FROM work.precedent")]


# --------------------------------------------------------------------------- #
# questions — one document per ANSWERED question
# --------------------------------------------------------------------------- #
def _question_doc(q: dict) -> DocumentInfo:
    text = f"Question to {q['to_role']} on {q['work_item_id']}: \"{q['text']}\" " \
           f"Answer: \"{q['answer']}\"" + (f" (answered by {q['answered_by']})" if q.get("answered_by") else "")
    md = R.meta(
        work_item_id=q["work_item_id"], to_role=q["to_role"], answered_by=q.get("answered_by"),
        answered_at=R.epoch_str(q.get("answered_at"), default="0000000000"),
    )
    return DocumentInfo(id=q["id"], text=text, metadata=md)


def build_questions(cur) -> list[DocumentInfo]:
    return [_question_doc(q) for q in
            _rows(cur, "SELECT * FROM work.question WHERE answer IS NOT NULL")]


# --------------------------------------------------------------------------- #
# dispatch — build one index's docs, or a single doc for the upsert path
# --------------------------------------------------------------------------- #
_BUILDERS = {
    "clauses": build_clauses,
    "policies": build_policies,
    "decisions": build_decisions,
    "precedents": build_precedents,
    "questions": build_questions,
}


def build_index_docs(kind: str, *, llm=None) -> list[DocumentInfo]:
    conn = connect("retrieval")
    conn.row_factory = dict_row
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            if kind == "decisions":
                return build_decisions(cur, llm=llm)
            return _BUILDERS[kind](cur)
    finally:
        conn.close()


def build_one_doc(kind: str, tiger_id: str, *, llm=None) -> DocumentInfo | None:
    """Rebuild a single document from Tiger for the gateway upsert path."""
    conn = connect("retrieval")
    conn.row_factory = dict_row
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            if kind == "clauses":
                cl = _one(cur, "SELECT * FROM golden.contract_clause WHERE id=%s", (tiger_id,))
                return _clause_doc(cur, cl) if cl else None
            if kind == "policies":
                # tiger_id may be 'pol-001' (latest version) or 'pol-001@v2'
                pid, _, ver = tiger_id.partition("@v")
                if ver:
                    p = _one(cur, "SELECT * FROM work.policy WHERE id=%s AND version=%s", (pid, int(ver)))
                else:
                    p = _one(cur, "SELECT * FROM work.policy WHERE id=%s ORDER BY version DESC LIMIT 1", (pid,))
                return _policy_doc(p) if p else None
            if kind == "decisions":
                wi = _one(cur, "SELECT * FROM work.work_item WHERE id=%s", (tiger_id,))
                return _decision_doc(cur, wi, llm=llm) if wi else None
            if kind == "precedents":
                p = _one(cur, "SELECT * FROM work.precedent WHERE id=%s", (tiger_id,))
                return _precedent_doc(p) if p else None
            if kind == "questions":
                q = _one(cur, "SELECT * FROM work.question WHERE id=%s AND answer IS NOT NULL", (tiger_id,))
                return _question_doc(q) if q else None
    finally:
        conn.close()
    return None


def llm_opts():
    """{'key','model'} when Claude summaries are enabled, else None (template fallback)."""
    from ..config import get_settings

    s = get_settings()
    if s.llm_is_live:
        return {"key": s.anthropic_api_key, "model": s.pitwall_agent_model}
    return None
