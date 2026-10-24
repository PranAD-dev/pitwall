"""Eval harness (M6): run the agent's decision gate over every planted issue and
score it against world/out/answer_key.json.

Deterministic and re-runnable — it reads the real golden facts (as the read-only
`agent` role) and writes nothing to the database. The agent never sees the answer
key; `detectors.decide()` derives the verdict from the data, and only then do we
compare. Produces docs/RESULTS.md plus a structured result the CLI prints.

Headline metric: precision on auto-completed work (target 100%) — of the items the
hard-check gate cleared to complete on its own, how many were both the right call
AND allowed to auto-complete. Plus automation rate, must-not-auto-complete
violations (target 0), escalation quality, and planted-issue recall by type.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from ..agent import detectors as D

ROOT = Path(__file__).resolve().parents[2]
ANSWER_KEY = ROOT / "world" / "out" / "answer_key.json"
RESULTS_MD = ROOT / "docs" / "RESULTS.md"


def _score_one(issue: dict) -> dict:
    """Run the decision gate for one planted issue and compare to its expected action."""
    case = {"type": issue["type"], "subject_refs": issue["subject_refs"]}
    action = failing = err = None
    auto = False
    try:
        d = D.decide(case)
        action, auto, failing = d.action, d.auto_completed, d.failing_check
    except Exception as e:  # a detector that can't read its facts is a scored failure
        err = f"{type(e).__name__}: {e}"
    expected = issue["expected_action"]
    must_not = bool(issue.get("must_not_auto_complete", False))
    correct = action == expected
    return {
        "issue_id": issue["issue_id"],
        "type": issue["type"],
        "expected": expected,
        "action": action,
        "correct": correct,
        "auto": auto,
        "must_not_auto_complete": must_not,
        "violation": must_not and auto,  # auto-completed something it must not have
        "failing_check": failing,
        "error": err,
    }


def run(limit: int | None = None, write: bool = True) -> dict:
    """Score every planted issue. Returns {rows, metrics}; writes docs/RESULTS.md if `write`."""
    key = json.loads(ANSWER_KEY.read_text())
    if limit:
        key = key[:limit]
    rows = [_score_one(i) for i in key]

    n = len(rows)
    correct = sum(r["correct"] for r in rows)
    auto_rows = [r for r in rows if r["auto"]]
    esc_rows = [r for r in rows if not r["auto"]]
    n_auto = len(auto_rows)
    auto_ok = sum(1 for r in auto_rows if r["correct"] and not r["must_not_auto_complete"])
    esc_ok = sum(1 for r in esc_rows if r["correct"])

    by_type: dict[str, dict] = {}
    for r in rows:
        t = by_type.setdefault(r["type"], {"n": 0, "correct": 0})
        t["n"] += 1
        t["correct"] += int(r["correct"])

    metrics = {
        "total": n,
        "action_recall": correct / n if n else 0.0,
        "correct": correct,
        "precision_on_auto_completed": (auto_ok / n_auto) if n_auto else 1.0,
        "auto_completed": n_auto,
        "auto_correct": auto_ok,
        "automation_rate": n_auto / n if n else 0.0,
        "must_not_auto_complete_violations": sum(r["violation"] for r in rows),
        "escalation_quality": (esc_ok / len(esc_rows)) if esc_rows else 1.0,
        "escalated": len(esc_rows),
        "escalation_correct": esc_ok,
        "errors": sum(1 for r in rows if r["error"]),
        "by_type": by_type,
    }
    if write:
        _write_results(rows, metrics)
    return {"rows": rows, "metrics": metrics}


def _pct(x: float) -> str:
    return f"{x * 100:.0f}%"


def _write_results(rows: list[dict], m: dict) -> None:
    RESULTS_MD.parent.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    L: list[str] = []
    L.append("# Pit Wall — Evaluation Results")
    L.append("")
    L.append(
        f"_Generated {ts} by `pitwall eval run` against `world/out/answer_key.json` "
        f"({m['total']} planted issues)._"
    )
    L.append("")
    L.append(
        "The agent's decision gate (hard checks in code — `pitwall/agent/detectors.py`) is run "
        "over every planted issue, reading the real golden facts as the read-only `agent` DB role. "
        "The agent never sees the answer key; the verdict is derived from the data, then compared."
    )
    L.append("")
    L.append("## Headline")
    L.append("")
    L.append("| Metric | Result | Target |")
    L.append("|---|---|---|")
    L.append(
        f"| **Precision on auto-completed work** | **{_pct(m['precision_on_auto_completed'])}** "
        f"({m['auto_correct']}/{m['auto_completed']}) | 100% |"
    )
    L.append(
        f"| **Must-not-auto-complete violations** | **{m['must_not_auto_complete_violations']}** | 0 |"
    )
    L.append(
        f"| Planted-issue recall (right action) | {_pct(m['action_recall'])} "
        f"({m['correct']}/{m['total']}) | — |"
    )
    L.append(
        f"| Automation rate | {_pct(m['automation_rate'])} "
        f"({m['auto_completed']}/{m['total']}) | — |"
    )
    L.append(
        f"| Escalation quality | {_pct(m['escalation_quality'])} "
        f"({m['escalation_correct']}/{m['escalated']}) | — |"
    )
    if m["errors"]:
        L.append(f"| ⚠ Detector/DB errors | {m['errors']} | 0 |")
    L.append("")
    L.append("## Recall by issue type")
    L.append("")
    L.append("| Type | Correct | n |")
    L.append("|---|---|---|")
    for t, s in sorted(m["by_type"].items()):
        L.append(f"| `{t}` | {s['correct']} | {s['n']} |")
    L.append("")
    L.append("## Per-issue detail")
    L.append("")
    L.append("| Issue | Type | Expected | Agent action | Auto | ✓ |")
    L.append("|---|---|---|---|:--:|:--:|")
    for r in rows:
        act = r["action"] or (f"⚠ {r['error']}" if r["error"] else "—")
        mark = "✅" if r["correct"] else "❌"
        auto = "auto" if r["auto"] else "escalate"
        if r["violation"]:
            auto += " ⛔"
        L.append(
            f"| `{r['issue_id']}` | `{r['type']}` | `{r['expected']}` | `{act}` | {auto} | {mark} |"
        )
    L.append("")
    RESULTS_MD.write_text("\n".join(L) + "\n")
