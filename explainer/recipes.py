"""Scene recipes — turn common financial objects into grounded 'build it live'
scenes. Plugging your data in is a few calls:

    from explainer import recipes as r
    scenes = [
        r.report_table("P&L — March", ["Line", "Amount"],
                       [["Revenue", "$4,820,000"], ["Net", "$610,000"]],
                       say="Revenue was $4,820,000 and net income $610,000.",
                       facts={"revenue": "$4,820,000", "net": "$610,000"}),
        r.transaction_entry(["Dr  Accounts payable   $250,000", "Cr  Cash   $250,000"],
                            say="We paid a $250,000 supplier invoice.",
                            facts={"amount": "$250,000"}),
    ]
    request = {"subject_id": "acme-close", "title": "March close", "scenes": scenes}

Every number you want spoken must be passed in `facts` (or appear on the canvas) —
that's what keeps the narration honest."""

from __future__ import annotations

from typing import Any

Facts = dict[str, str] | list[dict[str, str]]


def _facts(facts: Facts | None, source: str) -> list[dict[str, str]]:
    if facts is None:
        return []
    if isinstance(facts, dict):
        return [{"key": k, "value": str(v), "source": source} for k, v in facts.items()]
    return facts


def _scene(say: str, highlight: str, draw: dict[str, Any], facts: Facts | None,
           source: str, focus: str | None) -> dict[str, Any]:
    return {
        "say": say,
        "ui": {"focus": focus or draw.get("title", highlight), "panel": "canvas",
               "highlight": highlight},
        "facts": _facts(facts, source),
        "draw": draw,
    }


def report_table(title: str, columns: list[str], rows: list[list[str]], *, say: str,
                 facts: Facts | None = None, highlight_row: int | None = None,
                 source: str = "report", focus: str | None = None) -> dict[str, Any]:
    draw = {"type": "table", "title": title, "columns": columns, "rows": rows}
    if highlight_row is not None:
        draw["highlight_row"] = highlight_row
    return _scene(say, "table", draw, facts, source, focus)


def transaction_entry(lines: list[str], *, say: str, facts: Facts | None = None,
                      title: str = "journal entry", source: str = "ledger",
                      focus: str | None = None) -> dict[str, Any]:
    return _scene(say, "entry", {"type": "entry", "title": title, "lines": lines},
                  facts, source, focus)


def reconciliation_calc(lines: list[str], *, say: str, facts: Facts | None = None,
                        title: str = "reconciliation", source: str = "calc",
                        focus: str | None = None) -> dict[str, Any]:
    return _scene(say, "calc", {"type": "calc", "title": title, "lines": lines},
                  facts, source, focus)


def comparison(left_label: str, left_lines: list[str], right_label: str,
               right_lines: list[str], *, say: str, facts: Facts | None = None,
               title: str = "comparison", source: str = "compare",
               focus: str | None = None) -> dict[str, Any]:
    draw = {"type": "compare", "title": title, "columns": [
        {"label": left_label, "lines": left_lines},
        {"label": right_label, "lines": right_lines}]}
    return _scene(say, "compare", draw, facts, source, focus)


def checklist(items: list[tuple[str, bool]], *, say: str, facts: Facts | None = None,
              title: str = "checks", source: str = "checks",
              focus: str | None = None) -> dict[str, Any]:
    draw = {"type": "checks", "title": title,
            "items": [{"label": label, "ok": ok} for label, ok in items]}
    return _scene(say, "checks", draw, facts, source, focus)


def cascade_flow(boxes: list[str], *, say: str, facts: Facts | None = None,
                 title: str = "cascade", source: str = "flow",
                 focus: str | None = None) -> dict[str, Any]:
    return _scene(say, "flow", {"type": "flow", "title": title, "boxes": boxes},
                  facts, source, focus)
