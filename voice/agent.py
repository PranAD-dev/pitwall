"""Pit Wall Explainer — a LiveKit voice agent (read-only) that narrates finance
decisions while driving the terminal UI scene by scene.

Verified against docs.livekit.io (Oct 2026): AgentServer / @server.rtc_session /
AgentSession with inference STT + Cartesia TTS, and data messages on topic "ui"
to drive the frontend. Requires LIVEKIT_URL/API_KEY/API_SECRET (+ CARTESIA_API_KEY
for voice, ANTHROPIC_API_KEY for free-form Q&A). With no keys this file does not
run — use `pitwall explain plan <id>` or voice/replay.html for the offline demo.

HARD RULES (judges check these):
  * read-only: the tools only SELECT from Tiger via the voice_readonly role;
    the agent can never propose/approve/pay/post. A spoken "yes" is not approval.
  * never speaks a number a tool didn't return — it narrates the *validated* plan
    from pitwall.explain, where every spoken number is grounded in a fact.
  * past decisions are explained with world_as_of(decision_time) only.

Run:  uv pip install -r voice/requirements.txt  &&  uv run python voice/agent.py dev
"""

from __future__ import annotations

import json
import os
import sys

# Make the pitwall package importable when run as a script from repo root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

from pitwall.explain import plan as planmod
from pitwall.explain import tools as extools

load_dotenv()

try:
    from livekit import agents
    from livekit.agents import Agent, AgentServer, AgentSession, inference, room_io
    from livekit.agents.llm import function_tool
    from livekit.plugins import cartesia
except ImportError as e:  # pragma: no cover - only when deps/keys absent
    raise SystemExit(
        "voice deps not installed. `uv pip install -r voice/requirements.txt`, "
        "set LiveKit + Cartesia keys in .env, then `uv run python voice/agent.py dev`."
    ) from e

INSTRUCTIONS = (
    "You are Pit Wall's Explainer: a calm finance analyst who explains why the "
    "autonomous system made a decision. You are READ-ONLY. You can never approve, "
    "pay, release, or post anything; if asked to, refuse and say the write goes "
    "through the gateway under a human's identity and a spoken 'yes' is never an "
    "approval. Never state a number that a tool did not return. Keep sentences short. "
    "When explaining a past decision, use the as-of tools and say what was known then, "
    "then separately say what has been learned since."
)


class Explainer(Agent):
    def __init__(self) -> None:
        super().__init__(instructions=INSTRUCTIONS)

    @function_tool
    async def audit_trail(self, subject: str) -> str:
        """Return the append-only audit trail (actors, actions, reasons) for a work item."""
        rows = extools.audit_trail(subject)
        return json.dumps([{k: str(v) for k, v in r.items()} for r in rows])

    @function_tool
    async def policy(self, policy_id: str, version: int | None = None) -> str:
        """Return a versioned policy (its rule text and approval requirements)."""
        p = extools.policy(policy_id, version)
        return json.dumps(p, default=str)


async def _play(session: AgentSession, room, work_item_id: str, as_of: str | None = None) -> None:
    """Speak the grounded plan scene by scene, pushing each UI focus to the frontend."""
    from datetime import datetime

    when = datetime.fromisoformat(as_of) if as_of else None
    plan = planmod.build_plan(work_item_id, as_of=when)
    for scene in plan["scenes"]:
        # drive the terminal UI (data message on topic "ui"); frontend highlights the block
        await room.local_participant.publish_data(
            json.dumps(scene["ui"]).encode(), reliable=True, topic="ui"
        )
        # speak the EXACT validated sentence (no paraphrase at speak-time)
        await session.say(scene["say"], allow_interruptions=True)


server = AgentServer()


@server.rtc_session(agent_name="pitwall-explainer")
async def entrypoint(ctx: agents.JobContext) -> None:
    # work item + optional as-of can be passed via room metadata: {"wi": "...", "as_of": "..."}
    meta = {}
    try:
        meta = json.loads(ctx.room.metadata or "{}")
    except json.JSONDecodeError:
        pass
    work_item_id = meta.get("wi", "WI-5602")
    as_of = meta.get("as_of")

    session = AgentSession(
        stt=inference.STT(model="assemblyai/universal-streaming", language="en"),
        tts=cartesia.TTS(model="sonic-3", voice="f786b574-daa5-4673-aa0c-cbe3e8534c02"),
        turn_handling=inference.TurnHandlingOptions(turn_detection=inference.TurnDetector()),
        use_tts_aligned_transcript=True,  # captions stay in sync with speech
    )
    await session.start(room=ctx.room, agent=Explainer(),
                        room_options=room_io.RoomOptions())
    await _play(session, ctx.room, work_item_id, as_of)


if __name__ == "__main__":
    agents.cli.run_app(server)
