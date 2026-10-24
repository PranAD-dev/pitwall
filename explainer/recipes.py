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


def log_trail(entries: list[Any], *, say: str, facts: Facts | None = None,
              title: str = "write-ahead log", source: str = "log",
              focus: str | None = None) -> dict[str, Any]:
    """A log stream. Each entry is (at, text) or (at, text, level) or a dict
    {at, text, level}. level ∈ info|ok|warn|err drives colour."""
    norm = []
    for e in entries:
        if isinstance(e, dict):
            norm.append({"at": e.get("at", ""), "text": e.get("text", ""),
                         "level": e.get("level", "info")})
        else:
            at, text, *rest = e
            norm.append({"at": at, "text": text, "level": rest[0] if rest else "info"})
    return _scene(say, "log", {"type": "log", "title": title, "entries": norm},
                  facts, source, focus)


def transaction_impact(*, title: str, entry_lines: list[str],
                       affected: list[tuple[str, Any, str]], logs: list[Any],
                       says: dict[str, str] | None = None,
                       facts: dict[str, Facts] | None = None,
                       source: str = "ledger") -> list[dict[str, Any]]:
    """The UI-button archetype: explain one transaction end to end —
      1) the journal entry that posted,
      2) the OTHER tables it touched (Table | Rows | Effect),
      3) the append-only log of every write.
    `affected` = [(table_name, rows_changed, effect_text), ...].
    `says`/`facts` optionally override each scene's sentence/grounded values; the
    defaults carry no bare numbers, so they're grounded by construction."""
    says = says or {}
    facts = facts or {}
    return [
        transaction_entry(entry_lines, title=title, source=source,
                          say=says.get("entry", "Here is the transaction that posted."),
                          facts=facts.get("entry")),
        report_table(f"{title} — tables affected", ["Table", "Rows", "Effect"],
                     [[t, str(r), e] for (t, r, e) in affected],
                     say=says.get("impact", "It rippled into the tables below."),
                     facts=facts.get("impact"), source=source),
        log_trail(logs, say=says.get("logs", "Every write is in the append-only log."),
                  facts=facts.get("logs"), source=source),
    ]
