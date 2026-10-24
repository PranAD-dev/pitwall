# Cartesia — Best Use of Cartesia

**Is voice core?** Yes. The Explainer's job *is* spoken explanation: a judge asks
"why did you hold this payment?" out loud and Pit Wall answers in real time while
the terminal builds the evidence on screen. Voice is the interface to the
accountability story, not demo garnish — but it is a Saturday-night feature and the
core (gateway, audit log, hard-check gate, eval) never depends on it.

## Problem & originality
Autonomous finance only earns trust if it can **defend a decision when questioned**.
Most "explainability" is a text log. We make the system *teach* its decision in
30–90 seconds — voice narration synchronized to a canvas that draws the exact
tables, calculations, and checks behind the call, grounded so it can never invent a
number. Asking "why?" about a *past* decision rewinds the world to that moment.

## Cartesia features used
- **Cartesia `sonic-3` TTS** via the LiveKit Agents plugin (`livekit.plugins.cartesia`).
- **Aligned transcripts** (`use_tts_aligned_transcript=True`) so captions stay in
  sync with speech — and remain the full fallback when audio is muted/unavailable.
- Low-latency streaming TTS inside a LiveKit `AgentSession` with VAD + turn
  detection, so a judge can **interrupt** mid-explanation and ask a follow-up.

## Execution
- Main flow works: `pitwall explain plan WI-5602` plays the grounded fraud-hold
  explanation; `--as-of` rewinds; `voice/replay.html` is the audio-fallback player.
- Edge cases handled: no-audio fallback (captions + canvas), ungrounded say-lines
  (regenerate → template), unknown work item (clear error), past-decision replay
  via `world_as_of`.

## Impact & responsibility
- **Read-only & least-privilege:** the voice agent connects as `voice_readonly` —
  it cannot read salaries (`payroll_private`) and cannot write anything. A spoken
  "yes" is never an approval; writes go through the gateway under a human identity.
- **No invented numbers:** every spoken/drawn value is validated against tool output.
- **Accessibility:** captions always render even with audio off; color is used only
  for meaning (green/amber/red), never as the sole signal.
- **Privacy / no secrets:** keys live in `.env` only; `.env.example` lists
  `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `CARTESIA_API_KEY`,
  `ANTHROPIC_API_KEY`. Nothing is committed.

## Known limitations
- Live voice needs LiveKit + Cartesia keys; without them the explainer runs
  offline with timed captions (no TTS).
- STT (for free-form spoken questions) uses LiveKit Inference; the scripted
  "Explain" flow and the canvas work without STT.
- Saved-replay MP4 (LiveKit Egress) is stretch; today replays persist as the plan +
  canvas (`work.explanation`) and re-play via `voice/replay.html`.
