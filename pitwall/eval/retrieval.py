"""Retrieval eval (Moss): can a natural-language question find the right past
decision? 30 questions — paraphrases, and some that name a month or club — each
mapped to the acceptable work-item id(s). We report top-1 and top-3 accuracy,
with and without the decided_at date filter, so the value of the filter is visible.

For a clean, reproducible score the eval builds a DEDICATED index from only the
canonical planted + seeded decisions (so ad-hoc scenario runs in the live index
don't skew it), queries it, records latency to work.retrieval_metric, then tears
it down. Every target id is a real Tiger work item; Moss only has to find it.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from psycopg.rows import dict_row

from ..config import get_settings
from ..db import connect
from ..retrieval import client as R
from ..retrieval import documents as docs
from ..retrieval import metrics

ROOT = Path(__file__).resolve().parents[2]
ANSWER_KEY = ROOT / "world" / "out" / "answer_key.json"
PERF_MD = ROOT / "docs" / "MOSS_PERF.md"
EVAL_INDEX = "eval_decisions"  # prefixed → 'pitwall_eval_decisions'

# Each: q (text; {month} filled from the target's real date for timed questions),
# ids (acceptable work items), timed (name a month + constrain decided_at to it).
QUESTIONS: list[dict] = [
    {"q": "a lookalike-domain email asked us to change the payee's IBAN — what did we do?",
     "ids": ["WI-fraud-1", "WI-fraud-2", "WI-fraud-3", "WI-5602"]},
    {"q": "we held a transfer payment on suspected bank-detail fraud",
     "ids": ["WI-fraud-1", "WI-fraud-2", "WI-fraud-3", "WI-5602"]},
    {"q": "the payment to Northgate Rangers that we put on hold",
     "ids": ["WI-5602", "WI-fraud-1", "WI-fraud-2", "WI-fraud-3"]},
    {"q": "a bank-account change that turned out legitimate after a bank check",
     "ids": ["WI-fraud-legit-1"]},
    {"q": "an add-on bonus invoice we rejected because appearances were below the clause threshold",
     "ids": ["WI-addon-false-1", "WI-addon-false-2", "WI-5611"]},
    {"q": "the Montara add-on claim we turned down", "ids": ["WI-5611"]},
    {"q": "an add-on that actually triggered but had not been booked — we proposed an accrual",
     "ids": ["WI-addon-trig-1"]},
    {"q": "an incoming transfer came in short because the solidarity contribution was withheld; "
          "we did not chase it",
     "ids": ["WI-solidarity-1", "WI-solidarity-2", "WI-solidarity-3"]},
    {"q": "a receipt that was short for no clear reason — we chased or escalated it",
     "ids": ["WI-short-unexplained-1", "WI-short-unexplained-2"]},
    {"q": "one wire that paid several installments at once — we split it one-to-many",
     "ids": ["WI-combined-wire-1", "WI-combined-wire-2"]},
    {"q": "a duplicate agent-fee invoice we rejected", "ids": ["WI-duplicate-invoice-1", "WI-duplicate-invoice-2"]},
    {"q": "a consultancy fee split into pieces to stay under the approval limit",
     "ids": ["WI-threshold-evasion-1"]},
    {"q": "a stale FX rate on a cross-currency installment — we proposed an FX gain or loss",
     "ids": ["WI-stale-fx-1", "WI-stale-fx-2"]},
    {"q": "an ambiguous sell-on clause we refused to guess on and escalated",
     "ids": ["WI-sell-on-ambiguous-1"]},
    {"q": "a contract extension that changed the amortization — we proposed an adjustment",
     "ids": ["WI-extension-amort-1"]},
    {"q": "why did we complete a bank-detail change without holding it?",
     "ids": ["WI-fraud-legit-1"]},
    {"q": "an invoice claiming an appearance milestone the player never reached in counted competitions",
     "ids": ["WI-addon-false-1", "WI-addon-false-2", "WI-5611"]},
    {"q": "money arrived about five percent short on an international incoming transfer",
     "ids": ["WI-solidarity-1", "WI-solidarity-2", "WI-solidarity-3"]},
    {"q": "a second invoice with the same amount and transfer, number reformatted",
     "ids": ["WI-duplicate-invoice-1", "WI-duplicate-invoice-2"]},
    {"q": "a combined payment across two installments that reconciled to the cent",
     "ids": ["WI-combined-wire-1", "WI-combined-wire-2"]},
    {"q": "the euro/sterling rate was out of date when we booked the receipt",
     "ids": ["WI-stale-fx-1", "WI-stale-fx-2"]},
    {"q": "the sell-on basis was unclear — gross or profit — so we asked a human",
     "ids": ["WI-sell-on-ambiguous-1"]},
    {"q": "the agent commission we wrote off and re-amortised after a contract extension",
     "ids": ["WI-extension-amort-1"]},
    {"q": "a shortfall we could not explain and routed for chasing",
     "ids": ["WI-short-unexplained-1", "WI-short-unexplained-2"]},
    {"q": "a held payment escalated to the CFO for a second approval",
     "ids": ["WI-5602", "WI-fraud-1", "WI-fraud-2", "WI-fraud-3"]},
    {"q": "payments structured just under the approval limit (threshold evasion)",
     "ids": ["WI-threshold-evasion-1"]},
    # timed — the month (filled from the target's real decided_at) is the decisive
    # tiebreaker. Each target's month is UNIQUE to its decision type in this world, so
    # naming the month isolates it: a "rejected invoice" is a duplicate agent fee in
    # March but a false add-on in April; a "shortfall" is a solidarity case in
    # September; a held payment is the fraud batch in May. Without the filter the text
    # matches across months; with it, the month picks the right group.
    {"q": "the incoming transfer shortfall we handled in {month}",
     "ids": ["WI-solidarity-1", "WI-solidarity-2", "WI-solidarity-3"], "timed": True},
    {"q": "a rejected counterparty invoice from {month}",
     "ids": ["WI-duplicate-invoice-1", "WI-duplicate-invoice-2"], "timed": True},
    {"q": "a rejected counterparty invoice from {month}",
     "ids": ["WI-addon-false-1", "WI-addon-false-2", "WI-5611"], "timed": True},
    {"q": "a payment we held and escalated in {month}",
     "ids": ["WI-fraud-1", "WI-fraud-2", "WI-fraud-3", "WI-5602"], "timed": True},
]


def _canonical_ids() -> set[str]:
    key = json.loads(ANSWER_KEY.read_text())
    return {f"WI-{i['issue_id']}" for i in key} | {"WI-5602", "WI-5611"}


def _decided_at_map(ids: list[str]) -> dict[str, datetime]:
    """Real decided_at per work item (authoritative, from Tiger)."""
    out: dict[str, datetime] = {}
    conn = connect("retrieval")
    conn.row_factory = dict_row
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            for wid in ids:
                cur.execute("SELECT * FROM work.work_item WHERE id=%s", (wid,))
                wi = cur.fetchone()
                if wi:
                    d = docs._decision_date(cur, wi)
                    if d:
                        out[wid] = d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    finally:
        conn.close()
    return out


def _month_window(d: datetime) -> tuple[str, str, str]:
    """(month name, epoch_start, epoch_end) for the calendar month of d."""
    start = datetime(d.year, d.month, 1, tzinfo=timezone.utc)
    end = datetime(d.year + (d.month == 12), (d.month % 12) + 1, 1, tzinfo=timezone.utc)
    return start.strftime("%B %Y"), R.epoch_str(start), R.epoch_str(end)


def run(write: bool = True) -> dict:
    if not R.is_available():
        return {"skipped": "Moss not configured"}
    s = get_settings()
    index = s.moss_index(EVAL_INDEX)

    # 1) build a clean, canonical eval index from Tiger
    canonical = _canonical_ids()
    all_docs = docs.build_index_docs("decisions")
    eval_docs = [d for d in all_docs if d.id in canonical]
    R.rebuild_index(index, eval_docs)
    R.load(index)

    decided = _decided_at_map([q["ids"][0] for q in QUESTIONS if q.get("timed")])

    rows = []
    for q in QUESTIONS:
        timed = q.get("timed", False)
        text = q["q"]
        flt = None
        if timed:
            tgt = q["ids"][0]
            if tgt in decided:
                month, e0, e1 = _month_window(decided[tgt])
                text = text.format(month=month)
                # [first-of-month, first-of-next-month) — exclusive upper bound so a
                # decision dated on the 1st at 00:00 doesn't leak into the prior month
                flt = R.f_and(R.f_gte("decided_at", e0), R.f_lt("decided_at", e1))
            else:
                text = text.format(month="that month")

        # no filter
        res0 = R.query(index, text, top_k=3, alpha=0.8)
        h0 = [h["id"] for h in R.hits(res0)]
        metrics.record("eval", index, "retrieval_eval", R.ms(res0), top_k=3, hit_count=len(h0),
                       top_score=R.hits(res0)[0]["score"] if h0 else None)
        # with filter (only differs for timed questions)
        res1 = R.query(index, text, top_k=3, alpha=0.8, filter=flt) if flt else res0
        h1 = [h["id"] for h in R.hits(res1)]
        if flt:
            metrics.record("eval", index, "retrieval_eval_filtered", R.ms(res1), top_k=3,
                           hit_count=len(h1), top_score=R.hits(res1)[0]["score"] if h1 else None)

        acc = set(q["ids"])
        rows.append({
            "q": text, "ids": q["ids"], "timed": timed,
            "top1_nofilter": bool(h0 and h0[0] in acc),
            "top3_nofilter": bool(acc & set(h0)),
            "top1_filter": bool(h1 and h1[0] in acc),
            "top3_filter": bool(acc & set(h1)),
            "got": h0,
        })

    # 2) tear the eval index down (keep the project tidy)
    try:
        R._bridge.run(lambda c: c.delete_index(index), timeout=30)
    except Exception:
        pass

    n = len(rows)
    timed_rows = [r for r in rows if r["timed"]]

    def pct(sel, subset=rows):
        return sum(1 for r in subset if r[sel]) / len(subset) if subset else 0.0

    metrics_out = {
        "n": n, "docs_indexed": len(eval_docs),
        "top1_nofilter": pct("top1_nofilter"), "top3_nofilter": pct("top3_nofilter"),
        "top1_filter": pct("top1_filter"), "top3_filter": pct("top3_filter"),
        "timed_n": len(timed_rows),
        "timed_top1_nofilter": pct("top1_nofilter", timed_rows),
        "timed_top1_filter": pct("top1_filter", timed_rows),
    }
    latency = _latency_percentiles()
    if write:
        _write_perf(metrics_out, latency, rows)
    return {"rows": rows, "metrics": metrics_out, "latency": latency}


def _latency_percentiles() -> dict:
    """p50/p95 retrieval_ms from the Tiger hypertable (overall + by surface)."""
    conn = connect("retrieval")
    conn.row_factory = dict_row
    try:
        with conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "SELECT count(*) n, "
                "percentile_cont(0.5) WITHIN GROUP (ORDER BY retrieval_ms) p50, "
                "percentile_cont(0.95) WITHIN GROUP (ORDER BY retrieval_ms) p95, "
                "max(retrieval_ms) mx FROM work.retrieval_metric")
            overall = cur.fetchone()
            cur.execute(
                "SELECT surface, count(*) n, "
                "percentile_cont(0.5) WITHIN GROUP (ORDER BY retrieval_ms) p50, "
                "percentile_cont(0.95) WITHIN GROUP (ORDER BY retrieval_ms) p95 "
                "FROM work.retrieval_metric GROUP BY surface ORDER BY surface")
            by_surface = cur.fetchall()
    finally:
        conn.close()
    return {"overall": overall, "by_surface": by_surface}


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def _write_perf(m: dict, lat: dict, rows: list[dict]) -> None:
    PERF_MD.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    o = lat["overall"] or {}
    L: list[str] = []
    L.append("# Pit Wall — Moss retrieval performance & accuracy")
    L.append("")
    L.append(f"_Generated {ts} by `pitwall eval retrieval`. Retrieval runs in-process over "
             f"Moss; Tiger (TimescaleDB) stays the source of truth — every id below is a real "
             f"work item, refetched from Tiger before the agent acts or speaks._")
    L.append("")
    L.append("## Latency (Moss `time_taken_ms`, from `work.retrieval_metric`)")
    L.append("")
    L.append("| Scope | queries | p50 | p95 | max |")
    L.append("|---|--:|--:|--:|--:|")
    if o.get("n"):
        L.append(f"| all | {o['n']} | {float(o['p50']):.0f} ms | {float(o['p95']):.0f} ms | "
                 f"{int(o['mx'])} ms |")
    for s in lat["by_surface"]:
        L.append(f"| {s['surface']} | {s['n']} | {float(s['p50']):.0f} ms | {float(s['p95']):.0f} ms | |")
    L.append("")
    L.append("## Retrieval accuracy — 30 natural-language questions → the right decision")
    L.append("")
    L.append(f"Indexed {m['docs_indexed']} canonical decisions. Each question maps to the "
             f"acceptable work-item id(s); a hit counts when a correct id is returned.")
    L.append("")
    L.append("| Metric | No date filter | With date filter |")
    L.append("|---|--:|--:|")
    L.append(f"| **Top-1 accuracy** | {_pct(m['top1_nofilter'])} | {_pct(m['top1_filter'])} |")
    L.append(f"| **Top-3 accuracy** | {_pct(m['top3_nofilter'])} | {_pct(m['top3_filter'])} |")
    L.append(f"| Top-1 on the {m['timed_n']} month-named questions | "
             f"{_pct(m['timed_top1_nofilter'])} | {_pct(m['timed_top1_filter'])} |")
    L.append("")
    L.append("The date filter is the tiebreaker on near-duplicate decisions: naming the month "
             "narrows a group (e.g. three solidarity shortfalls) to the one that was decided then.")
    L.append("")
    L.append("## Per-question detail")
    L.append("")
    L.append("| ✓ | timed | question | returned (top-3) |")
    L.append("|:--:|:--:|---|---|")
    for r in rows:
        ok = "✅" if (r["top1_filter"] or r["top3_filter"]) else "❌"
        tm = "🕑" if r["timed"] else ""
        L.append(f"| {ok} | {tm} | {r['q'][:70]} | {', '.join(r['got'][:3])} |")
    L.append("")
    PERF_MD.write_text("\n".join(L) + "\n")
