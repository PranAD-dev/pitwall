"""Cartesia TTS — the Explainer's voice. One client, two outputs:

  • pcm16()  raw pcm_s16le @ 44.1 kHz mono — the LiveKit worker frames this
             straight into an `rtc.AudioFrame` and publishes it as a room track.
  • mp3()    audio/mpeg — the browser's HTTP fallback (`GET /api/voice`) plays
             this with a plain <audio> element when the live room track is absent.

Both paths run server-side so the Cartesia key never reaches the browser. Model
and voice come from env (`.env`: CARTESIA_API_KEY / CARTESIA_MODEL / CARTESIA_VOICE);
unset key → is_configured() is False and callers fall back to browser speech.
Nothing here logs the key.
"""

from __future__ import annotations

import os

import httpx

CARTESIA_URL = "https://api.cartesia.ai/tts/bytes"
CARTESIA_VERSION = "2024-11-13"
DEFAULT_MODEL = "sonic-3"
# Clive — Measured Expert: a calm finance-analyst voice (overridable via CARTESIA_VOICE).
DEFAULT_VOICE = "b24f41fd-00a3-4cd8-992a-a0c9f13f3ef1"
SAMPLE_RATE = 44100


def _key() -> str | None:
    # env first (the worker load_dotenv()s); fall back to pydantic Settings, which
    # reads .env the same way the rest of the app loads config — so a server started
    # without the key exported still finds it.
    k = os.environ.get("CARTESIA_API_KEY")
    if k:
        return k
    try:
        from pitwall.config import get_settings

        return get_settings().cartesia_api_key or None
    except Exception:
        return None


def is_configured() -> bool:
    return bool(_key())


def _model() -> str:
    return os.environ.get("CARTESIA_MODEL") or DEFAULT_MODEL


def _voice() -> str:
    return os.environ.get("CARTESIA_VOICE") or DEFAULT_VOICE


def synth_bytes(text: str, *, container: str = "raw", encoding: str = "pcm_s16le",
                sample_rate: int = SAMPLE_RATE, bit_rate: int = 128000,
                timeout: float = 30.0) -> bytes:
    """Synthesize `text` to audio bytes in the requested container. Raises on a
    missing key or a non-2xx Cartesia response; returns b'' for empty text."""
    key = _key()
    if not key:
        raise RuntimeError("CARTESIA_API_KEY not set")
    t = (text or "").strip()
    if not t:
        return b""
    if container == "raw":
        out = {"container": "raw", "encoding": encoding, "sample_rate": sample_rate}
    elif container == "mp3":
        out = {"container": "mp3", "sample_rate": sample_rate, "bit_rate": bit_rate}
    elif container == "wav":
        out = {"container": "wav", "encoding": encoding, "sample_rate": sample_rate}
    else:
        raise ValueError(f"unsupported container {container!r}")
    body = {
        "model_id": _model(),
        "transcript": t,
        "voice": {"mode": "id", "id": _voice()},
        "output_format": out,
        "language": "en",
    }
    headers = {
        "X-API-Key": key,
        "Cartesia-Version": CARTESIA_VERSION,
        "Content-Type": "application/json",
    }
    r = httpx.post(CARTESIA_URL, json=body, headers=headers, timeout=timeout)
    r.raise_for_status()
    return r.content


def pcm16(text: str, sample_rate: int = SAMPLE_RATE) -> bytes:
    """Raw pcm_s16le mono — for framing into a LiveKit audio track."""
    return synth_bytes(text, container="raw", encoding="pcm_s16le", sample_rate=sample_rate)


def mp3(text: str, sample_rate: int = SAMPLE_RATE) -> bytes:
    """audio/mpeg — for the browser's <audio> fallback."""
    return synth_bytes(text, container="mp3", sample_rate=sample_rate)
