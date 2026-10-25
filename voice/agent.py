"""Explainer voice worker — the real LiveKit + Cartesia narration path.

Joins the LiveKit room, PUBLISHES a Cartesia-synthesised audio track, and streams
grounded scenes over the `lk.explain-*` data channel. The stadium billboard
(`web/fc/src/livereport.js`) subscribes to the audio track and renders each scene;
captions stay the fallback when audio is muted or the worker is down.

Plain `livekit.rtc` (no `livekit-agents`): the worker mints its own token with
publish grants, connects to LIVEKIT_ROOM (default 'pitwall-report') and stays.
Cartesia TTS (`pitwall.explain.tts`, sonic-3) turns each scene's say-line into
pcm_s16le frames pushed into an `rtc.AudioSource`; scene delivery is paced to the
audio so the canvas builds in step with the voice.

Contract (JSON on the data channel):
  frontend -> worker   lk.explain-request     {requestId, subject, as_of?}
  frontend -> worker   lk.resolve-request     {requestId, utterance, as_of?}
  worker -> frontend   lk.explain-processing  {requestId, status:"processing"}
  worker -> frontend   lk.explain-plan        {requestId, plan}
  worker -> frontend   lk.explain-scene       {requestId, index, total, scene}
  worker -> frontend   lk.resolve-result      {requestId, ...}
  worker -> frontend   lk.explain-error       {requestId, error}

Data source via EXPLAIN_SOURCE (json:<dir> | pitwall | sample). Needs
LIVEKIT_URL/API_KEY/API_SECRET and (for voice) CARTESIA_API_KEY in .env.
Run:  make voice   (or)   uv run python voice/agent.py
"""

from __future__ import annotations

import asyncio
import datetime as _dt
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

from explainer import engine
from explainer.llm import make_anthropic_say_writer
from explainer.providers import JsonProvider

load_dotenv()

try:
    from livekit import api, rtc
except ImportError as e:  # pragma: no cover — only when deps absent
    raise SystemExit(
        "voice deps not installed. `uv pip install -r voice/requirements.txt`, set "
        "LIVEKIT_URL/API_KEY/API_SECRET (+ CARTESIA_API_KEY) in .env, then "
        "`uv run python voice/agent.py`."
    ) from e

from pitwall.explain import tts

ROOM = os.environ.get("LIVEKIT_ROOM", "pitwall-report")
IDENTITY = os.environ.get("LIVEKIT_VOICE_IDENTITY", "pitwall-voice")
SR = tts.SAMPLE_RATE
FRAME_SAMPLES = SR // 100                 # 10 ms frames → 441 samples @ 44.1k
FRAME_BYTES = FRAME_SAMPLES * 2           # s16le mono → 2 bytes/sample
# a small silent gap between scenes so lines don't run together
SCENE_GAP_S = float(os.environ.get("EXPLAIN_SCENE_GAP", "0.45"))
# when Cartesia is off, pace scenes by text length so the canvas still builds
SILENT_PACING_S = float(os.environ.get("EXPLAIN_SCENE_PACING", "3.2"))


def _say_writer():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    return make_anthropic_say_writer(key, os.environ.get("PITWALL_AGENT_MODEL", "claude-sonnet-4-6"))


SAMPLES_DIR = Path(__file__).resolve().parent / "samples"


def _sample_plan(subject: str) -> dict | None:
    """A self-contained lesson/report shipped as JSON (no DB, no LLM) — e.g.
    'financial-report'. Lets the billboard narrate a fixed script end to end,
    the way an edtech explainer walks through a prepared lesson."""
    if not subject:
        return None
    p = SAMPLES_DIR / f"{subject}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


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


async def _publish(room: rtc.Room, topic: str, obj: dict) -> None:
    await room.local_participant.publish_data(
        payload=json.dumps(obj).encode("utf-8"), topic=topic, reliable=True)


# --------------------------------------------------------------------------- #
# Cartesia → LiveKit audio track
# --------------------------------------------------------------------------- #
async def _speak(source: rtc.AudioSource, text: str) -> None:
    """Synthesize one say-line with Cartesia and push it into the room's audio
    track, frame by frame. Returns once the audio has played out. No-op (and no
    delay here — the caller paces) when Cartesia is unconfigured or TTS fails."""
    t = (text or "").strip()
    if not t or not tts.is_configured():
        return
    try:
        pcm = await asyncio.to_thread(tts.pcm16, t, SR)
    except Exception as e:  # noqa: BLE001 — a bad line must never kill the worker
        print(f"  ⚠ cartesia tts failed: {e}")
        return
    if not pcm:
        return
    for i in range(0, len(pcm), FRAME_BYTES):
        chunk = pcm[i:i + FRAME_BYTES]
        if len(chunk) < FRAME_BYTES:
            chunk = chunk + b"\x00" * (FRAME_BYTES - len(chunk))
        frame = rtc.AudioFrame(data=chunk, sample_rate=SR, num_channels=1,
                               samples_per_channel=FRAME_SAMPLES)
        await source.capture_frame(frame)
    await source.wait_for_playout()


# --------------------------------------------------------------------------- #
# Moss: resolve a spoken reference to a work item, honestly rewound
# --------------------------------------------------------------------------- #
_MONTHS = {m.lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August",
     "September", "October", "November", "December"], start=1)}


def _month_window_from_text(utterance: str):
    from pitwall.retrieval import client as R

    m = re.search(r"\b(" + "|".join(_MONTHS) + r")\s+(\d{4})\b", utterance.lower())
    if not m:
        return None
    mon, year = _MONTHS[m.group(1)], int(m.group(2))
    start = _dt.datetime(year, mon, 1, tzinfo=_dt.timezone.utc)
    end = _dt.datetime(year + (mon == 12), (mon % 12) + 1, 1, tzinfo=_dt.timezone.utc)
    return R.epoch_str(start), R.epoch_str(end)


def _load_indexes() -> None:
    """Load decisions/policies/clauses into process memory so voice lookups are local.
    Best-effort; voice still works (explain-by-id) if this fails."""
    try:
        from pitwall.config import get_settings
        from pitwall.retrieval import client as R

        if not R.is_available():
            return
        s = get_settings()
        R.load_many([s.moss_index(k) for k in ("decisions", "policies", "clauses")])
    except Exception:
        pass


def _resolve_reference(utterance: str, as_of: str | None = None) -> dict:
    from pitwall.config import get_settings
    from pitwall.retrieval import client as R
    from pitwall.retrieval import metrics

    if not R.is_available():
        return {"error": "retrieval is off — send a work-item id (e.g. WI-5602) as the subject"}
    as_of_dt = _dt.datetime.fromisoformat(as_of) if as_of else None
    flt = R.as_of_filter("decided_at", as_of_dt)
    win = _month_window_from_text(utterance)
    if win:
        flt = R.f_and(flt, R.f_gte("decided_at", win[0]), R.f_lt("decided_at", win[1]))

    idx = get_settings().moss_index("decisions")
    res = R.query(idx, utterance, top_k=3, alpha=0.8, filter=flt)
    hits = R.hits(res)
    metrics.record("voice", idx, "resolve_reference", R.ms(res), top_k=3, hit_count=len(hits),
                   top_score=hits[0]["score"] if hits else None,
                   work_item_id=hits[0]["id"] if hits else None)
    if not hits:
        return {"error": "no matching past decision"}

    def label(h):
        md = h["metadata"]
        when = ""
        try:
            when = " on " + _dt.datetime.utcfromtimestamp(int(md.get("decided_at", 0))).date().isoformat()
        except Exception:
            pass
        return f"the {md.get('counterparty') or md.get('kind', 'decision')}{when}"

    top = hits[0]
    if len(hits) >= 2 and hits[0]["score"] - hits[1]["score"] < 0.07 and hits[1]["score"] > 0.3:
        return {"clarify": True, "retrieval_ms": R.ms(res),
                "question": f"Did you mean {label(hits[0])}, or {label(hits[1])}?",
                "candidates": [{"id": h["id"], "label": label(h), "score": round(h["score"], 3)}
                               for h in hits[:2]]}
    return {"work_item_id": top["id"], "retrieval_ms": R.ms(res),
            "score": round(top["score"], 3), "label": label(top),
            "candidates": [{"id": h["id"], "label": label(h), "score": round(h["score"], 3)}
                           for h in hits]}


# --------------------------------------------------------------------------- #
# request handlers
# --------------------------------------------------------------------------- #
async def _handle_explain(room: rtc.Room, source: rtc.AudioSource, payload: dict) -> None:
    request_id = payload.get("requestId", "req")
    subject = payload.get("subject", "acme-close-2026-03")
    as_of = payload.get("as_of")
    try:
        await _publish(room, "lk.explain-processing", {"requestId": request_id, "status": "processing"})
        plan = _sample_plan(subject)  # a prepared script (financial-report) → no DB/LLM
        if plan is None:
            request = await asyncio.to_thread(_resolve_request, subject, as_of)
            plan = await asyncio.to_thread(engine.build_plan, request, _say_writer())
        await _publish(room, "lk.explain-plan", {"requestId": request_id, "plan": plan})
        scenes = plan.get("scenes", [])
        total = len(scenes)
        source.clear_queue()  # barge-in: a new request cuts off the previous narration
        voicing = tts.is_configured()
        print(f"🎙  {subject}: {total} scenes, voice={'cartesia' if voicing else 'off (captions only)'}")
        for i, scene in enumerate(scenes):
            await _publish(room, "lk.explain-scene",
                           {"requestId": request_id, "index": i, "total": total, "scene": scene})
            if voicing:
                await _speak(source, scene.get("say", ""))
            else:
                await asyncio.sleep(SILENT_PACING_S)
            await asyncio.sleep(SCENE_GAP_S)
    except Exception as e:  # noqa: BLE001 — report back, never crash the worker
        await _publish(room, "lk.explain-error", {"requestId": request_id, "error": str(e)})


async def _handle_resolve(room: rtc.Room, source: rtc.AudioSource, payload: dict) -> None:
    request_id = payload.get("requestId", "req")
    utterance = payload.get("utterance", "")
    as_of = payload.get("as_of")
    res = await asyncio.to_thread(_resolve_reference, utterance, as_of)
    await _publish(room, "lk.resolve-result", {"requestId": request_id, **res})
    if res.get("work_item_id"):
        await _handle_explain(room, source, {"requestId": request_id,
                                             "subject": res["work_item_id"], "as_of": as_of})


# --------------------------------------------------------------------------- #
# worker main — connect, publish the audio track, serve the room
# --------------------------------------------------------------------------- #
def _token(url_key_secret: tuple[str, str, str]) -> str:
    _, key, secret = url_key_secret
    return (api.AccessToken(key, secret)
            .with_identity(IDENTITY)
            .with_name("Pit Wall Explainer")
            .with_grants(api.VideoGrants(room_join=True, room=ROOM, can_publish=True,
                                         can_subscribe=True, can_publish_data=True))
            .to_jwt())


async def main() -> None:
    url = os.environ.get("LIVEKIT_URL")
    key = os.environ.get("LIVEKIT_API_KEY")
    secret = os.environ.get("LIVEKIT_API_SECRET")
    if not (url and key and secret):
        raise SystemExit("LIVEKIT_URL/API_KEY/API_SECRET not set in .env — voice disabled.")

    room = rtc.Room()
    source = rtc.AudioSource(SR, 1)
    track = rtc.LocalAudioTrack.create_audio_track("pitwall-voice", source)

    def on_data(data: rtc.DataPacket) -> None:
        try:
            payload = json.loads(data.data.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return
        if data.topic == "lk.explain-request":
            asyncio.create_task(_handle_explain(room, source, payload))
        elif data.topic == "lk.resolve-request":
            asyncio.create_task(_handle_resolve(room, source, payload))

    # register BEFORE connecting so we don't miss early requests
    room.on("data_received", on_data)

    await room.connect(url, _token((url, key, secret)))
    opts = rtc.TrackPublishOptions()
    opts.source = rtc.TrackSource.SOURCE_MICROPHONE
    await room.local_participant.publish_track(track, opts)
    await asyncio.to_thread(_load_indexes)

    voice = "cartesia · " + tts._model() if tts.is_configured() else "OFF (captions only — set CARTESIA_API_KEY)"
    print(f"✅ voice worker in room '{ROOM}' as '{IDENTITY}' · audio track published · voice: {voice}")
    print("   waiting for lk.explain-request / lk.resolve-request …")

    stop = asyncio.Event()
    room.on("disconnected", lambda *_: stop.set())
    try:
        await stop.wait()
    finally:
        await room.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
