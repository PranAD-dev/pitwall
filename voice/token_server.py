"""Tiny token endpoint the browser calls to join the LiveKit room.
POST /livekit/token {"identity": "...", "room": "..."} -> {"token": "...", "url": "..."}

Keys-gated: needs LIVEKIT_URL/API_KEY/API_SECRET in .env. The offline replay
(voice/replay.html) needs none of this.

Run:  uv run uvicorn voice.token_server:app --port 4020
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

app = FastAPI(title="Pit Wall LiveKit token server")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class TokenRequest(BaseModel):
    identity: str = "judge"
    room: str = "pitwall-demo"


@app.post("/livekit/token")
def token(req: TokenRequest) -> dict[str, str]:
    url = os.environ.get("LIVEKIT_URL")
    key = os.environ.get("LIVEKIT_API_KEY")
    secret = os.environ.get("LIVEKIT_API_SECRET")
    if not (url and key and secret):
        raise HTTPException(503, "LiveKit keys not configured; voice is disabled")
    from livekit import api

    jwt = (
        api.AccessToken(key, secret)
        .with_identity(req.identity)
        .with_name(req.identity)
        .with_grants(api.VideoGrants(room_join=True, room=req.room))
        .to_jwt()
    )
    return {"token": jwt, "url": url}
