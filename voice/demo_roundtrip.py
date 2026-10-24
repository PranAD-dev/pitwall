"""Live LiveKit sample: a real data-channel round-trip over LiveKit Cloud.

Connects TWO participants to one room:
  * 'agent'    — on lk.explain-request, builds a grounded plan (our explainer
                 engine) and streams lk.explain-processing + lk.explain-scene back
  * 'frontend' — presses the button (publishes lk.explain-request) and prints
                 every scene it receives

This is the exact contract voice/agent.py uses, exercised over real WebRTC.
Run:  uv run python voice/demo_roundtrip.py
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from dotenv import dotenv_values
from livekit import api, rtc

from explainer import engine

ROOT = Path(__file__).resolve().parents[1]
ENV = dotenv_values(ROOT / ".env")
ROOM = "explainer-sample"


def _https() -> str:
    return ENV["LIVEKIT_URL"].replace("wss://", "https://").replace("ws://", "http://")


def _token(identity: str) -> str:
    return (api.AccessToken(ENV["LIVEKIT_API_KEY"], ENV["LIVEKIT_API_SECRET"])
            .with_identity(identity).with_name(identity)
            .with_grants(api.VideoGrants(room_join=True, room=ROOM)).to_jwt())


def _sample_request() -> dict:
    return json.loads((ROOT / "explainer" / "samples" / "txn-INV-2048.json").read_text())


async def _publish(room: rtc.Room, topic: str, obj: dict) -> None:
    await room.local_participant.publish_data(
        json.dumps(obj).encode(), reliable=True, topic=topic)


async def run_agent(done: asyncio.Event) -> rtc.Room:
    room = rtc.Room()

    @room.on("data_received")
    def on_data(data: rtc.DataPacket):
        if data.topic == "lk.explain-request":
            asyncio.create_task(handle(json.loads(data.data.decode())))

    async def handle(payload: dict):
        rid = payload.get("requestId", "req")
        print(f"[agent]    ← lk.explain-request  {rid} subject={payload.get('subject')}")
        await _publish(room, "lk.explain-processing", {"requestId": rid, "status": "processing"})
        plan = engine.build_plan(_sample_request())
        await _publish(room, "lk.explain-plan", {"requestId": rid, "plan": plan})
        for i, sc in enumerate(plan["scenes"]):
            await _publish(room, "lk.explain-scene",
                           {"requestId": rid, "index": i, "total": len(plan["scenes"]), "scene": sc})
            print(f"[agent]    → lk.explain-scene   {i + 1}/{len(plan['scenes'])} ({sc['draw']['type']})")
            await asyncio.sleep(0.6)

    await room.connect(ENV["LIVEKIT_URL"], _token("agent"))
    print("[agent]    connected, listening for requests")
    return room


async def run_frontend(done: asyncio.Event) -> rtc.Room:
    room = rtc.Room()
    received = {"scenes": 0}

    @room.on("data_received")
    def on_data(data: rtc.DataPacket):
        obj = json.loads(data.data.decode())
        if data.topic == "lk.explain-processing":
            print(f"[frontend] ← processing…")
        elif data.topic == "lk.explain-plan":
            print(f"[frontend] ← plan: \"{obj['plan']['title']}\" ({len(obj['plan']['scenes'])} scenes)")
        elif data.topic == "lk.explain-scene":
            sc = obj["scene"]
            received["scenes"] += 1
            print(f'[frontend] ← scene {obj["index"] + 1}: canvas={sc["draw"]["type"]:5}  '
                  f'say="{sc["say"][:56]}"')
            if obj["index"] + 1 == obj["total"]:
                done.set()

    await room.connect(ENV["LIVEKIT_URL"], _token("frontend"))
    print("[frontend] connected")
    await asyncio.sleep(1.0)  # let both sides see each other
    print('[frontend] → BUTTON: publish lk.explain-request {subject:"txn-INV-2048"}')
    await _publish(room, "lk.explain-request", {"requestId": "demo-1", "subject": "txn-INV-2048"})
    return room


async def main() -> None:
    print(f"connecting to {ENV['LIVEKIT_URL']}  room='{ROOM}'\n")
    done = asyncio.Event()
    agent = await run_agent(done)
    await asyncio.sleep(0.5)
    frontend = await run_frontend(done)
    try:
        await asyncio.wait_for(done.wait(), timeout=25)
        print("\n✅ round-trip complete — frontend received the full grounded plan over LiveKit")
    except asyncio.TimeoutError:
        print("\n⏱️  timed out waiting for scenes")
    finally:
        await frontend.disconnect()
        await agent.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
