"""`pitwall` command-line entry point (the one invoked by the Makefile)."""

from __future__ import annotations

import typer

app = typer.Typer(no_args_is_help=True, add_completion=False, help="Pit Wall CLI")
db_app = typer.Typer(no_args_is_help=True, help="database schema + migrations")
world_app = typer.Typer(no_args_is_help=True, help="deterministic world + answer key")
demo_app = typer.Typer(no_args_is_help=True, help="scripted demo scenarios")
eval_app = typer.Typer(no_args_is_help=True, help="score Pit Wall vs the answer key")
explain_app = typer.Typer(no_args_is_help=True, help="grounded narrated explanations (voice)")
voice_app = typer.Typer(no_args_is_help=True, help="LiveKit + Cartesia voice agent")
app.add_typer(db_app, name="db")
app.add_typer(world_app, name="world")
app.add_typer(demo_app, name="demo")
app.add_typer(eval_app, name="eval")
app.add_typer(explain_app, name="explain")
app.add_typer(voice_app, name="voice")


@db_app.command("migrate")
def db_migrate() -> None:
    """Create roles + apply db/schema/*.sql (idempotent)."""
    from .migrate import migrate

    migrate()


@world_app.command("generate")
def world_generate(
    no_db: bool = typer.Option(
        False, "--no-db", help="Build the world + write answer_key.json without a database"
    ),
) -> None:
    """Generate the deterministic world and the planted-issue answer key."""
    from .world.generate import generate

    generate(no_db=no_db)


@world_app.command("answer-key")
def world_answer_key() -> None:
    """Pretty-print the planted-issue answer key."""
    from .world.generate import print_answer_key

    print_answer_key()


@demo_app.command("run")
def demo_run() -> None:
    """Run the scripted final-whistle demo (arrives in M5)."""
    typer.secho("demo scenario comes online in M5 (final-whistle cascade).", fg="yellow")


@eval_app.command("run")
def eval_run() -> None:
    """Run Pit Wall over the timeline and score it (arrives in M6)."""
    typer.secho("eval harness comes online in M6.", fg="yellow")


@explain_app.command("seed-demo")
def explain_seed_demo() -> None:
    """Seed the demo work items (fraud hold, add-on reject) the explainer narrates."""
    from .explain.seed_demo import seed

    seed()


@explain_app.command("plan")
def explain_plan(
    work_item_id: str = typer.Argument(..., help="e.g. WI-5602"),
    as_of: str = typer.Option(None, "--as-of", help="ISO time to rewind to, e.g. 2026-05-05T09:19"),
    no_persist: bool = typer.Option(False, "--no-persist", help="don't write the explanation"),
) -> None:
    """Build + validate a grounded narration plan and play it as timed captions."""
    import time as _time
    from datetime import datetime

    from rich.console import Console
    from rich.panel import Panel

    from .explain import plan as planmod

    console = Console()
    when = datetime.fromisoformat(as_of) if as_of else None
    p = planmod.build_plan(work_item_id, as_of=when)

    header = f"[bold]{p['title']}[/]  ·  {work_item_id}"
    if p["as_of"]:
        header += f"  ·  [cyan]as of {p['as_of']}[/] (only what was known then)"
    console.print(Panel(header, border_style="grey37"))

    all_grounded = True
    for i, sc in enumerate(p["scenes"], 1):
        ungrounded = planmod.validate_scene(sc)
        all_grounded = all_grounded and not ungrounded
        facts = "  ".join(f"[dim]{f['key']}=[/]{f['value']}" for f in sc["facts"])
        mark = "[green]✓[/]" if not ungrounded else f"[red]✗ {ungrounded}[/]"
        console.print(f"\n[bold cyan]scene {i}[/]  →  focus=[yellow]{sc['ui'].get('highlight')}[/] {mark}")
        console.print(f'  [white]"{sc["say"]}"[/]')
        console.print(f"  {facts}")
        if sc.get("draw"):
            console.print(f"  [magenta]canvas:[/] {sc['draw']['type']} (builds on screen)")
        _time.sleep(0.15)

    console.print()
    console.print("[green]✓ every spoken number is grounded in a tool fact[/]" if all_grounded
                  else "[red]✗ some numbers were not grounded[/]")
    if not no_persist:
        pid = planmod.persist_plan(p)
        console.print(f"[dim]explanation logged to audit as {pid} (actor=explainer, via gateway)[/]")


@explain_app.command("export")
def explain_export(
    work_item_id: str = typer.Argument("WI-5602"),
    as_of: str = typer.Option(None, "--as-of"),
    out: str = typer.Option("voice/plan.js", "-o", "--out", help="path for the browser player"),
) -> None:
    """Write a plan as voice/plan.js so voice/replay.html plays it offline (no keys)."""
    import json
    from datetime import datetime
    from pathlib import Path

    from .explain import plan as planmod

    when = datetime.fromisoformat(as_of) if as_of else None
    p = planmod.build_plan(work_item_id, as_of=when)
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text("window.PITWALL_PLAN = " + json.dumps(p, indent=2) + ";\n")
    typer.secho(f"wrote {out} — open voice/replay.html to watch it build live", fg="green")


@voice_app.command("token")
def voice_token(
    identity: str = typer.Argument("judge", help="participant identity"),
    room: str = typer.Argument("pitwall-demo", help="LiveKit room name"),
) -> None:
    """Mint a LiveKit join token (needs LIVEKIT_API_KEY/SECRET in .env)."""
    from .config import get_settings

    s = get_settings()
    if not (s.livekit_api_key and s.livekit_api_secret):
        typer.secho("LiveKit keys not set — add LIVEKIT_API_KEY/SECRET to .env. "
                    "Voice is off until then; the offline explainer (`pitwall explain plan`) "
                    "works without keys.", fg="yellow")
        raise typer.Exit(1)
    try:
        from livekit import api
    except ImportError:
        typer.secho("install the voice deps:  uv pip install -r voice/requirements.txt", fg="yellow")
        raise typer.Exit(1)
    token = (api.AccessToken(s.livekit_api_key, s.livekit_api_secret)
             .with_identity(identity).with_name(identity)
             .with_grants(api.VideoGrants(room_join=True, room=room)).to_jwt())
    typer.echo(token)


@voice_app.command("agent")
def voice_agent() -> None:
    """Run the LiveKit explainer agent (needs LiveKit + Cartesia keys)."""
    from .config import get_settings

    s = get_settings()
    missing = [k for k, v in {
        "LIVEKIT_URL": s.livekit_url, "LIVEKIT_API_KEY": s.livekit_api_key,
        "LIVEKIT_API_SECRET": s.livekit_api_secret,
    }.items() if not v]
    if missing:
        typer.secho(f"voice agent needs: {', '.join(missing)} in .env. "
                    "It's wired and ready — drop keys in and rerun. "
                    "Cartesia TTS activates when CARTESIA_API_KEY is also set.", fg="yellow")
        raise typer.Exit(1)
    typer.secho("launch via the LiveKit worker entrypoint:  "
                "uv run python voice/agent.py dev", fg="green")


if __name__ == "__main__":
    app()
