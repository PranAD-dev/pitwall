"""The pure explainer engine: take an explain-request (scenes with grounded facts
+ optional canvas draws), optionally polish the spoken lines with a say-writer, and
enforce that every spoken number is grounded. No DB, no hidden I/O.

An explain-request is plain JSON so any system can produce it:
    {
      "subject_id": "acme-close-2026-03",
      "title": "March close — reviewed",
      "as_of": null,
      "scenes": [
         {"say": "...", "ui": {"focus": "...", "panel": "canvas", "highlight": "table"},
          "facts": [{"key": "...", "value": "...", "source": "..."}],
          "draw": {"type": "table", ...}}
      ]
    }
The returned plan has the same shape (with final say-lines) — exactly what
voice/replay.html and the LiveKit agent consume."""

from __future__ import annotations

import re
from typing import Any, Callable

Scene = dict[str, Any]
SayWriter = Callable[[list[Scene]], list[str] | None]

# number-like token not preceded by a letter/digit/hyphen (so "pol-011" is skipped)
_NUM = re.compile(r"(?<![A-Za-z0-9\-])[$€£]?\d[\d,]*(?:\.\d+)?%?")


def _numbers(text: str) -> list[str]:
    return [re.sub(r"[,$€£%]", "", m) for m in _NUM.findall(text)]


def draw_values(draw: dict[str, Any]) -> str:
    """Every string a draw puts on screen — its own grounding set."""
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
    elif t == "log":
        out += [e.get("text", "") for e in draw.get("entries", [])]
    return re.sub(r"[,$€£%]", "", " ".join(str(x) for x in out))


def validate_scene(scene: Scene) -> list[str]:
    """Ungrounded numbers in the scene's say line (empty list = OK). A number is
    grounded if it appears in a fact value or on the canvas (both are source-backed)."""
    haystack = " ".join(re.sub(r"[,$€£%]", "", f["value"]) for f in scene.get("facts", []))
    if scene.get("draw"):
        haystack += " " + draw_values(scene["draw"])
    return [n for n in _numbers(scene.get("say", "")) if n not in haystack]


def _facts_sentence(scene: Scene) -> str:
    return "; ".join(f"{f['key']} {f['value']}" for f in scene.get("facts", [])) or scene.get(
        "say", ""
    )


def build_plan(request: dict[str, Any], say_writer: SayWriter | None = None) -> dict[str, Any]:
    """Finalize an explain-request into a validated plan.

    If `say_writer` is given (e.g. a Claude-backed polisher), it rewrites the draft
    `say` lines; code then validates grounding and regenerates once, falling back to
    the draft (or a facts-only sentence) so output is ALWAYS grounded."""
    scenes: list[Scene] = [dict(s) for s in request.get("scenes", [])]

    if say_writer is not None:
        for _ in range(2):
            candidate = say_writer(scenes)
            if candidate is None or len(candidate) != len(scenes):
                break
            trial = [dict(sc, say=line) for sc, line in zip(scenes, candidate)]
            if all(not validate_scene(sc) for sc in trial):
                for sc, line in zip(scenes, candidate):
                    sc["say"] = line
                break

    # final safety net: any ungrounded say collapses to its grounded facts
    for sc in scenes:
        if validate_scene(sc):
            sc["say"] = _facts_sentence(sc)

    return {
        "subject_id": request.get("subject_id"),
        "as_of": request.get("as_of"),
        "title": request.get("title", request.get("subject_id", "Explanation")),
        "scenes": scenes,
    }
