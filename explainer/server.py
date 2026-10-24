"""The button's backend: one call returns a finalized, grounded plan the UI plays.

    GET  /explain/{subject}        -> plan   (resolve a subject via the provider)
    POST /explain  {request}       -> plan   (narrate a request you built client-side)
    POST /explain  {"subject": …}  -> plan

Pick the data source with EXPLAIN_SOURCE:
    EXPLAIN_SOURCE=json:/path/to/requests_dir   (a dir of <subject>.json)
    (unset)                                     -> the bundled samples dir
Set ANTHROPIC_API_KEY to let Claude polish the spoken lines (re-validated).

Run:  uv pip install '.[server]'  &&  uv run uvicorn explainer.server:app --port 4022
The UI button then does:  fetch(`/explain/${subject}`) -> play in replay.html.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from . import engine
from .llm import make_anthropic_say_writer
from .providers import JsonProvider

app = FastAPI(title="explainer")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _provider() -> JsonProvider:
    src = os.environ.get("EXPLAIN_SOURCE", "")
    if src.startswith("json:"):
        return JsonProvider(src[5:])
    return JsonProvider(Path(__file__).parent / "samples")


def _say_writer():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    return make_anthropic_say_writer(key, os.environ.get("PITWALL_AGENT_MODEL", "claude-sonnet-4-6"))


def _finalize(request: dict[str, Any]) -> dict[str, Any]:
    return engine.build_plan(request, say_writer=_say_writer())


class ExplainBody(BaseModel):
    subject: str | None = None
    request: dict[str, Any] | None = None


@app.get("/explain/{subject}")
def explain_subject(subject: str) -> dict[str, Any]:
    try:
        req = _provider().fetch(subject)
    except KeyError as e:
        raise HTTPException(404, str(e))
    return _finalize(req)


@app.post("/explain")
def explain(body: ExplainBody) -> dict[str, Any]:
    if body.request is not None:
        return _finalize(body.request)
    if body.subject is not None:
        return explain_subject(body.subject)
    raise HTTPException(400, "provide either `subject` or `request`")


@app.get("/subjects")
def subjects() -> list[str]:
    return _provider().subjects()
