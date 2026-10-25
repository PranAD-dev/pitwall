"""Render the narrated financial report to a downloadable MP4.

The live /report page streams *instructions* (scene JSON over LiveKit) and draws
them in the browser — there's no file. This module produces the shareable
artifact: for each scene it synthesizes the Cartesia narration (the same voice as
the live path) and renders the slide to a frame with headless Chromium (reusing
the report's look), then ffmpeg holds each still for its spoken length and
concatenates them into one H.264/AAC .mp4 that plays anywhere.

  build_report_video("/tmp/report.mp4")  ->  path to the mp4

Needs: playwright (chromium cached) + ffmpeg on PATH + CARTESIA_API_KEY.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import wave
from pathlib import Path

from . import tts

ROOT = Path(__file__).resolve().parents[2]
SAMPLE = ROOT / "voice" / "samples" / "financial-report.json"

# Mirrors web/report.html's visual language so the video matches the live page.
_CSS = """
*{box-sizing:border-box;margin:0;padding:0;}
html,body{width:1280px;height:720px;overflow:hidden;
  background:radial-gradient(1200px 600px at 50% -10%,#11202a 0%,#05080c 60%);
  color:#e8eef2;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial;}
.wrap{height:720px;display:flex;flex-direction:column;padding:34px 60px 0;}
header{display:flex;align-items:flex-end;justify-content:space-between;
  border-bottom:1px solid #1d2730;padding-bottom:16px;}
.brand{display:flex;align-items:center;gap:12px;}
.bars{display:inline-grid;grid-auto-flow:column;gap:3px;align-items:end;height:26px;}
.bars i{width:5px;background:#c6ff2e;display:block;border-radius:1px;}
h1{font-size:22px;}
.sub{color:#7d8b97;font-size:13px;margin-top:3px;}
.chip{font:12px/1 ui-monospace,Menlo,monospace;color:#05080c;background:#c6ff2e;
  padding:7px 12px;border-radius:999px;}
main{flex:1;display:flex;flex-direction:column;justify-content:center;padding:26px 0;}
.heading{font-size:30px;font-weight:700;color:#fff;margin-bottom:22px;}
.ledger{border:1px solid #1d2730;border-radius:14px;background:#0d1319;overflow:hidden;}
.row{display:flex;align-items:center;justify-content:space-between;gap:20px;
  padding:16px 24px;border-top:1px solid #1d2730;}
.row:first-child{border-top:0;}
.row .lbl{font-size:18px;}
.row .val{font:600 20px/1 ui-monospace,Menlo,monospace;color:#c6ff2e;white-space:nowrap;}
.row.total{background:#0a1f14;}
.row.total .lbl{font-weight:700;color:#fff;}
.note{color:#7d8b97;font-size:15px;margin:18px 2px 0;font-style:italic;
  border-left:2px solid #c6ff2e;padding-left:12px;}
footer{border-top:1px solid #1d2730;padding:18px 0 26px;display:flex;align-items:center;gap:18px;}
.prog{font:13px/1 ui-monospace,Menlo,monospace;color:#7d8b97;white-space:nowrap;}
.cap{flex:1;font-size:19px;color:#dfe9ef;}
"""


def _esc(s: str) -> str:
    return (str(s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _is_total(label: str) -> bool:
    import re

    return bool(re.search(r"total|operating (profit|result)|net cash", label or "", re.I))


def _scene_html(plan: dict, scene: dict, idx: int, total: int) -> str:
    rows = ""
    for label, val in scene.get("lines", []):
        cls = " total" if _is_total(label) else ""
        rows += (f'<div class="row{cls}"><span class="lbl">{_esc(label)}</span>'
                 f'<span class="val">{_esc(val)}</span></div>')
    note = f'<div class="note">{_esc(scene.get("note"))}</div>' if scene.get("note") else ""
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{_CSS}</style></head>
<body><div class="wrap">
  <header>
    <div class="brand">
      <span class="bars"><i style="height:10px"></i><i style="height:22px"></i><i style="height:16px"></i><i style="height:26px"></i></span>
      <div><h1>{_esc(plan.get("title", "Financial Report"))}</h1>
           <div class="sub">{_esc(plan.get("subtitle", ""))}</div></div>
    </div>
    <span class="chip">livekit · cartesia</span>
  </header>
  <main>
    <div class="heading">{_esc(scene.get("heading", ""))}</div>
    <div class="ledger">{rows}</div>
    {note}
  </main>
  <footer>
    <span class="prog">{idx + 1} / {total}</span>
    <span class="cap">{_esc(scene.get("say", ""))}</span>
  </footer>
</div></body></html>"""


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate() or 1)


def _render_frames(plan: dict, out_dir: Path, width: int, height: int) -> list[Path]:
    """One headless-Chromium session → a PNG per scene (reuses the report's CSS)."""
    from playwright.sync_api import sync_playwright

    scenes = plan.get("scenes", [])
    frames: list[Path] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page(viewport={"width": width, "height": height},
                                device_scale_factor=1)
        for i, scene in enumerate(scenes):
            page.set_content(_scene_html(plan, scene, i, len(scenes)))
            page.wait_for_timeout(120)
            fp = out_dir / f"frame_{i:02d}.png"
            page.screenshot(path=str(fp))
            frames.append(fp)
        browser.close()
    return frames


def _ffmpeg(args: list[str]) -> None:
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args],
                   check=True, capture_output=True)


def _draw_lines(draw: dict) -> list[tuple[str, str]]:
    """Flatten an explain `draw` canvas (table/calc/checks/flow/entry) into the
    (label, value) rows the slide renderer draws."""
    t = (draw or {}).get("type")
    if t == "table":
        out = []
        for r in (draw.get("rows") or []):
            r = list(r)
            if not r:
                continue
            out.append((str(r[0]), "   ".join(str(x) for x in r[1:]) if len(r) > 1 else ""))
        return out
    if t == "calc":
        out = []
        for ln in (draw.get("lines") or []):
            s = str(ln)
            i = s.rfind("  ")
            out.append((s[:i].strip(), s[i:].strip()) if i > 0 else (s, ""))
        return out
    if t == "checks":
        return [(str(it.get("label", "")), "✓" if it.get("ok") else "✗")
                for it in (draw.get("items") or [])]
    if t == "flow":
        return [(str(b), "") for b in (draw.get("boxes") or [])]
    if t == "entry":
        out = []
        for l in (draw.get("lines") or []):
            side = "Dr" if l.get("debit") else "Cr"
            out.append((f"{side}  {l.get('account', '')}", str(l.get("debit") or l.get("credit") or "")))
        return out
    return []


def plan_from_explain(explain_plan: dict) -> dict:
    """Turn an Explainer plan (scenes of say + draw) into the renderer's scene shape
    (heading + lines + say) so a single transaction can become a narrated video."""
    scenes = []
    for sc in explain_plan.get("scenes", []):
        draw = sc.get("draw") or {}
        scenes.append({"heading": draw.get("title") or explain_plan.get("title") or "",
                       "lines": _draw_lines(draw), "say": sc.get("say", ""),
                       "note": sc.get("note")})
    return {"title": explain_plan.get("title", "Transaction Report"),
            "subtitle": "Pit Wall · the agent's reasoning + the append-only audit",
            "scenes": scenes}


def build_report_video(out_path: str | Path, *, plan: dict | None = None,
                       width: int = 1280, height: int = 720) -> str:
    """Produce the narrated report MP4 at out_path. Returns the path. Renders `plan`
    if given (e.g. a transaction), else the standing financial report."""
    if not tts.is_configured():
        raise RuntimeError("CARTESIA_API_KEY not set — cannot synthesize narration")
    plan = plan or json.loads(SAMPLE.read_text())
    scenes = plan.get("scenes", [])
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        frames = _render_frames(plan, tmp, width, height)
        segments: list[Path] = []
        for i, scene in enumerate(scenes):
            # Cartesia narration → wav (exact duration drives the slide hold)
            wav = tmp / f"say_{i:02d}.wav"
            audio = tts.synth_bytes(scene.get("say", "") or " ",
                                    container="wav", encoding="pcm_s16le", sample_rate=44100)
            wav.write_bytes(audio)
            dur = max(1.5, _wav_duration(wav))
            seg = tmp / f"seg_{i:02d}.mp4"
            _ffmpeg(["-loop", "1", "-framerate", "25", "-i", str(frames[i]),
                     "-i", str(wav),
                     "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage",
                     "-pix_fmt", "yuv420p", "-r", "25",
                     "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
                     "-t", f"{dur + 0.4:.2f}", "-shortest", str(seg)])
            segments.append(seg)

        listf = tmp / "list.txt"
        listf.write_text("".join(f"file '{s}'\n" for s in segments))
        _ffmpeg(["-f", "concat", "-safe", "0", "-i", str(listf),
                 "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
                 "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out_path)])
    return str(out_path)


if __name__ == "__main__":
    import sys

    from dotenv import load_dotenv

    load_dotenv()
    dest = sys.argv[1] if len(sys.argv) > 1 else "/tmp/harbourside-financial-report.mp4"
    print("building", dest, "…")
    print("done →", build_report_video(dest))
