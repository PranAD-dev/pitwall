"""Register contract-clause CONDITIONS in the DB — the triggers the clause-trigger
detectors read. One generic writer, so a new clause (and its conditions) can be added
as data without touching code: you write the clause + params, and the detectors evaluate
it against the ground-truth facts (appearances, minutes, status, dates).

The `params` jsonb IS the condition. Each clause `kind` has an expected shape (below),
but the store is schemaless so bespoke terms can be captured too (and a bespoke `kind`
the structured cascade doesn't recognise is exactly what gets surfaced + escalated).
"""

from __future__ import annotations

from psycopg.rows import dict_row
from psycopg.types.json import Json

from ..db import connect

_CTYPES = {"transfer", "sponsor", "player"}   # DB check-constraint on contract_type

# the condition shape each detector expects (documentation + a light validator)
KIND_SCHEMAS = {
    "obligation_to_buy": {"threshold_qualifying_appearances": "int", "min_minutes": "int",
                          "competitions": "[str]", "season": "str", "fee": "number",
                          "currency": "str", "deadline": "YYYY-MM-DD", "relegation_voids": "bool"},
    "suspension_withholding": {"trigger": "str"},
    "sell_on": {"pct": "number", "basis": "gross_fee | profit_over_book_value"},
    "addon_appearances": {"threshold": "int", "fee": "number", "competitions": "[str]"},
    "extension": {"new_amortization_months": "int"},
    "termination": {"effective_date": "YYYY-MM-DD"},
    "standard_terms": {},
}


def add_clause(*, id: str, contract_type: str, contract_id: str, kind: str,
               params: dict | None = None, competitions_counted: list | None = None,
               ambiguity_note: str | None = None, actor: str = "controller:dana") -> dict:
    """Record a clause + its trigger conditions. Upserts by id. Logged to the append-only
    audit. Flags (doesn't block) when the params don't match the kind's known shape."""
    if contract_type not in _CTYPES:
        return {"error": f"contract_type must be one of {sorted(_CTYPES)}"}
    params = params or {}
    warnings = []
    schema = KIND_SCHEMAS.get(kind)
    if schema is None:
        warnings.append(f"'{kind}' is not a known clause kind — it will be stored and surfaced "
                        "as a bespoke clause (the detectors can't evaluate it, so it escalates)")
    else:
        missing = [k for k in schema if k not in params]
        if missing:
            warnings.append(f"missing expected conditions for {kind}: {missing}")

    conn = connect("superuser")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM golden.contract_clause WHERE id=%s", (id,))
            if cur.fetchone():
                cur.execute("UPDATE golden.contract_clause SET contract_type=%s, contract_id=%s, "
                            "kind=%s, params=%s, competitions_counted=%s, ambiguity_note=%s "
                            "WHERE id=%s",
                            (contract_type, contract_id, kind, Json(params), competitions_counted,
                             ambiguity_note, id))
                op = "updated"
            else:
                cur.execute("INSERT INTO golden.contract_clause (id,contract_type,contract_id,kind,"
                            "params,competitions_counted,ambiguity_note,raw_ref) "
                            "VALUES (%s,%s,%s,%s,%s,%s,%s,'manual')",
                            (id, contract_type, contract_id, kind, Json(params), competitions_counted,
                             ambiguity_note))
                op = "inserted"
        conn.commit()
    finally:
        conn.close()

    try:   # append-only audit of the contract change
        c = connect("gateway")
        with c.cursor() as cur:
            cur.execute("INSERT INTO work.audit_log (at,actor,action,subject,allowed,reason,diff) "
                        "VALUES (now(),%s,'register_clause',%s,true,%s,%s)",
                        (actor, f"clause:{id}", f"{op} {kind} on {contract_type} {contract_id}",
                         Json({"params": params})))
        c.commit()
        c.close()
    except Exception:  # noqa: BLE001
        pass
    return {"ok": True, "op": op, "id": id, "kind": kind,
            "contract": f"{contract_type}:{contract_id}", "params": params, "warnings": warnings}


def list_clauses(contract_id: str | None = None) -> list[dict]:
    conn = connect("gateway")
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            if contract_id:
                cur.execute("SELECT id,contract_type,contract_id,kind,params,ambiguity_note "
                            "FROM golden.contract_clause WHERE contract_id=%s ORDER BY id", (contract_id,))
            else:
                cur.execute("SELECT id,contract_type,contract_id,kind,params,ambiguity_note "
                            "FROM golden.contract_clause ORDER BY contract_id, id LIMIT 300")
            return cur.fetchall()
    finally:
        conn.close()
