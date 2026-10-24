"""Pit Wall Explainer — a reusable LiveKit voice agent (read-only) that narrates
financial decisions while driving a terminal canvas scene by scene.

It is DATA-AGNOSTIC: it narrates whatever explain-request it resolves for a subject
— plug yours in via EXPLAIN_SOURCE:
    EXPLAIN_SOURCE=json:/path/to/requests_dir   -> narrate your financial data
    EXPLAIN_SOURCE=pitwall                       -> narrate the football demo (WI-…)
    (unset)                                      -> the bundled sample (a monthly close)
Room metadata {"subject": "...", "as_of": "..."} picks the subject.

Verified against docs.livekit.io (Oct 2026): AgentServer / @server.rtc_session,
AgentSession with inference STT + Cartesia TTS, UI focus pushed as data messages on
topic "ui". Needs LIVEKIT_URL/API_KEY/API_SECRET (+ CARTESIA_API_KEY for voice,
ANTHROPIC_API_KEY to polish the spoken lines). With no keys this file does not run —
use `pitwall explain sample` / `pitwall explain from-json` + voice/replay.html offline.

HARD RULES: read-only (never propose/approve/pay/post; a spoken "yes" is not an
approval); never speaks a number the source didn't return (the engine validates it).

Run:  uv pip install -r voice/requirements.txt  &&  uv run python voice/agent.py dev
"""

from __future__ import annotations

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
    from livekit import agents
    from livekit.agents import Agent, AgentServer, AgentSession, inference, room_io
    from livekit.agents.llm import function_tool
    from livekit.plugins import cartesia
except ImportError as e:  # pragma: no cover — only when deps/keys absent
    raise SystemExit(
        "voice deps not installed. `uv pip install -r voice/requirements.txt`, set "
        "LiveKit + Cartesia keys in .env, then `uv run python voice/agent.py dev`."
    ) from e

INSTRUCTIONS = (
    "You are an AI finance explainer: a calm analyst who explains why a decision was "
    "made or what a report shows. You are READ-ONLY — you can never approve, pay, "
    "release, or post anything; if asked to, refuse and say the write goes through the "
    "system's gateway under a human's identity, and a spoken 'yes' is never an approval. "
    "Never state a number the data did not return. Keep sentences short."
)


def _resolve_request(subject: str, as_of: str | None) -> dict:
    src = os.environ.get("EXPLAIN_SOURCE", "")
    if src.startswith("json:"):
        return JsonProvider(src[5:]).fetch(subject, as_of)
    if src == "pitwall" or subject.startswith("WI-"):
        from datetime import datetime

        from pitwall.explain import plan as planmod  # football provider (needs DB)

        return planmod.build_plan(subject, as_of=datetime.fromisoformat(as_of) if as_of else None)
    import explainer

    sample = Path(explainer.__file__).parent / "samples" / "acme-close-2026-03.json"
    return json.loads(sample.read_text())


class Explainer(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)


async def _play(session: AgentSession, room, subject: str, as_of: str | None) -> None:
    request = _resolve_request(subject, as_of)
    sw = (make_anthropic_say_writer(os.environ.get("ANTHROPIC_API_KEY"),
                                    os.environ.get("PITWALL_AGENT_MODEL", "claude-sonnet-4-6"))
          if os.environ.get("ANTHROPIC_API_KEY") else None)
    plan = engine.build_plan(request, say_writer=sw)
    for scene in plan["scenes"]:
        await room.local_participant.publish_data(
            json.dumps(scene["ui"]).encode(), reliable=True, topic="ui")
        await session.say(scene["say"], allow_interruptions=True)  # the validated sentence


server = AgentServer()


@server.rtc_session(agent_name="pitwall-explainer")
async def entrypoint(ctx: agents.JobContext) -> None:
    meta = {}
    try:
        meta = json.loads(ctx.room.metadata or "{}")
    except json.JSONDecodeError:
        pass
    subject = meta.get("subject", "acme-close-2026-03")
    as_of = meta.get("as_of")

    session = AgentSession(
        stt=inference.STT(model="assemblyai/universal-streaming", language="en"),
        tts=cartesia.TTS(model="sonic-3", voice="f786b574-daa5-4673-aa0c-cbe3e8534c02"),
        turn_handling=inference.TurnHandlingOptions(turn_detection=inference.TurnDetector()),
        use_tts_aligned_transcript=True,
    )
    await session.start(room=ctx.room, agent=Explainer(), room_options=room_io.RoomOptions())
    await _play(session, ctx.room, subject, as_of)


if __name__ == "__main__":
    agents.cli.run_app(server)
