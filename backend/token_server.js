// Token backend for the Explainer — mirrors Steve-Dusty/virtualhelper backend/server.js.
// GET /token?room=&username=  -> { token, url, room } ; creates the room and
// dispatches the explainer worker to it (so the agent auto-joins).
//
//   npm install   &&   node token_server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { AccessToken, RoomServiceClient, AgentDispatchClient } from "livekit-server-sdk";

dotenv.config();

const { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, PORT = 3001 } = process.env;
if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
  throw new Error("set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET in .env");
}

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
const dispatch = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

app.get("/token", async (req, res) => {
  try {
    const room = req.query.room || "explainer-demo";
    const identity = req.query.username || `user-${Date.now()}`;

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: "30m" });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    const token = await at.toJwt();

    try {
      await roomService.createRoom({ name: room, emptyTimeout: 300 });
    } catch (e) {
      /* room may already exist */
    }
    try {
      await dispatch.createDispatch(room, ""); // dispatch the explainer worker
    } catch (e) {
      console.error("dispatch failed:", e.message);
    }

    res.json({ token, url: LIVEKIT_URL, room });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to generate token" });
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`token backend on :${PORT}  (LiveKit ${LIVEKIT_URL})`));
