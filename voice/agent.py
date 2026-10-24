"""Explainer LiveKit agent — classic worker, data-channel driven.

Mirrors the proven wiring in Steve-Dusty/virtualhelper (agent/main_agent.py):
classic `cli.run_app(WorkerOptions(entrypoint_fnc=...))`, register
`ctx.room.on("data_received", ...)` BEFORE connect, and do request/response over
data-channel topics. Your UI button sends an explain-request; the agent builds the
grounded plan (our explainer engine) and streams the scenes back for the frontend
to render + speak.

Contract (JSON on the data channel):
  frontend -> agent   lk.explain-request     {requestId, subject, as_of?}
  agent -> frontend   lk.explain-processing  {requestId, status:"processing"}
  agent -> frontend   lk.explain-plan        {requestId, plan}                 (full plan)
  agent -> frontend   lk.explain-scene       {requestId, index, total, scene}  (paced, build-live)
  agent -> frontend   lk.explain-error       {requestId, error}

Data source via EXPLAIN_SOURCE (json:<dir> | pitwall | sample). Needs
LIVEKIT_URL/API_KEY/API_SECRET. ANTHROPIC_API_KEY optional (polishes say-lines).
Run:  uv pip install -r voice/requirements.txt  &&  uv run python voice/agent.py dev
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

from explainer import engine
from explainer.llm import make_anthropic_say_writer
from explainer.providers import JsonProvider

load_dotenv()

try:
    from livekit import agents, rtc
    from livekit.agents import JobContext, WorkerOptions, cli
except ImportError as e:  # pragma: no cover — only when deps absent
    raise SystemExit(
        "voice deps not installed. `uv pip install -r voice/requirements.txt`, set "
        "LIVEKIT_URL/API_KEY/API_SECRET in .env, then `uv run python voice/agent.py dev`."
    ) from e

# per-scene pacing (seconds) so captions + canvas build in step with speech
SCENE_PACING = float(os.environ.get("EXPLAIN_SCENE_PACING", "3.2"))


def _say_writer():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    return make_anthropic_say_writer(key, os.environ.get("PITWALL_AGENT_MODEL", "claude-sonnet-4-6"))


def _resolve_request(subject: str, as_of: str | None) -> dict:
    src = os.environ.get("EXPLAIN_SOURCE", "")
    if src.startswith("json:"):
        return JsonProvider(src[5:]).fetch(subject, as_of)
    if src == "pitwall" or subject.startswith("WI-"):
        from datetime import datetime

        from pitwall.explain import plan as planmod  # football provider (needs DB)

        return planmod.build_plan(subject, as_of=datetime.fromisoformat(as_of) if as_of else None)
    import explainer

    return json.loads((Path(explainer.__file__).parent / "samples" / "acme-close-2026-03.json").read_text())


async def _publish(room, topic: str, obj: dict) -> None:
    await room.local_participant.publish_data(
        payload=json.dumps(obj).encode("utf-8"), topic=topic, reliable=True)


async def _handle_explain(room, payload: dict) -> None:
    request_id = payload.get("requestId", "req")
    subject = payload.get("subject", "acme-close-2026-03")
    as_of = payload.get("as_of")
    try:
        await _publish(room, "lk.explain-processing", {"requestId": request_id, "status": "processing"})
        request = _resolve_request(subject, as_of)
        plan = engine.build_plan(request, say_writer=_say_writer())
        await _publish(room, "lk.explain-plan", {"requestId": request_id, "plan": plan})
        # stream scenes paced, so the canvas builds live (the frontend may also speak each say)
        total = len(plan["scenes"])
        for i, scene in enumerate(plan["scenes"]):
            await _publish(room, "lk.explain-scene",
                           {"requestId": request_id, "index": i, "total": total, "scene": scene})
            await asyncio.sleep(SCENE_PACING)
    except Exception as e:  # noqa: BLE001 — report back, never crash the worker
        await _publish(room, "lk.explain-error", {"requestId": request_id, "error": str(e)})


async def entrypoint(ctx: JobContext) -> None:
    print(f"🧾 Explainer agent — room: {ctx.room.name}  source: {os.environ.get('EXPLAIN_SOURCE', 'sample')}")

    def on_data_received(data: rtc.DataPacket) -> None:
        if data.topic == "lk.explain-request":
            try:
                payload = json.loads(data.data.decode("utf-8"))
            except json.JSONDecodeError:
                return
            asyncio.create_task(_handle_explain(ctx.room, payload))

    # register BEFORE connecting so we don't miss early requests
    ctx.room.on("data_received", on_data_received)
    await ctx.connect(auto_subscribe=agents.AutoSubscribe.SUBSCRIBE_NONE)
    print("✅ connected — waiting for lk.explain-request …")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint))
