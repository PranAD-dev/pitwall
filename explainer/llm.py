"""Optional Claude-backed say-writer. The engine works without it (draft lines are
used as-is); pass one to polish the spoken sentences. The model only rewrites text —
code still validates that every number is grounded, so the LLM can never smuggle in
a figure your source didn't return."""

from __future__ import annotations

import json
from typing import Callable

from .engine import Scene

SYSTEM = (
    "You narrate financial explanations. Rewrite each scene's draft sentence as one "
    "short, plain sentence a calm analyst would say out loud. You may ONLY use numbers "
    "that already appear in that scene's facts or canvas — never introduce a figure. "
    "One sentence per scene; return JSON {\"lines\": [...]} with the same length and order."
)


def make_anthropic_say_writer(
    api_key: str | None, model: str = "claude-sonnet-4-6"
) -> Callable[[list[Scene]], list[str] | None]:
    def write(scenes: list[Scene]) -> list[str] | None:
        try:
            import anthropic
        except ImportError:
            return None
        client = anthropic.Anthropic(api_key=api_key)
        payload = [{"draft": s.get("say", ""), "facts": s.get("facts", []),
                    "canvas": s.get("draw", {})} for s in scenes]
        schema = {"type": "object", "additionalProperties": False,
                  "properties": {"lines": {"type": "array", "items": {"type": "string"}}},
                  "required": ["lines"]}
        try:
            resp = client.messages.create(
                model=model, max_tokens=1200, system=SYSTEM,
                output_config={"format": {"type": "json_schema", "schema": schema}},
                messages=[{"role": "user", "content": json.dumps(payload)}],
            )
            text = next(b.text for b in resp.content if b.type == "text")
            lines = json.loads(text)["lines"]
            return lines if len(lines) == len(scenes) else None
        except Exception:  # noqa: BLE001 — any failure -> engine keeps the drafts
            return None

    return write
