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
sow_app = typer.Typer(no_args_is_help=True, help="System of Work — gateway, roles, state machine")
agent_app = typer.Typer(no_args_is_help=True, help="the autonomous agent — onboard, run, process")
app.add_typer(db_app, name="db")
app.add_typer(world_app, name="world")
app.add_typer(demo_app, name="demo")
app.add_typer(eval_app, name="eval")
app.add_typer(explain_app, name="explain")
app.add_typer(voice_app, name="voice")
app.add_typer(sow_app, name="sow")
app.add_typer(agent_app, name="agent")


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
def eval_run(
    limit: int = typer.Option(None, "--limit", help="score only the first N planted issues"),
    no_write: bool = typer.Option(False, "--no-write", help="don't write docs/RESULTS.md"),
) -> None:
    """Run the agent's decision gate over every planted issue and score it vs the answer key."""
    from rich.console import Console
    from rich.table import Table

    from .eval.run import RESULTS_MD, run

    console = Console()
    res = run(limit=limit, write=not no_write)
    rows, m = res["rows"], res["metrics"]

    if m["errors"] and m["errors"] == m["total"]:
        console.print(
            "[red]Every detector failed to read golden facts.[/] Is the world loaded?\n"
            "Run [bold]make reset[/] (local) or [bold]make cloud-reset[/] first."
        )
        raise typer.Exit(1)

    table = Table(title="Pit Wall — planted-issue eval", header_style="bold")
    table.add_column("issue"); table.add_column("type")
    table.add_column("expected"); table.add_column("agent")
    table.add_column("mode"); table.add_column("✓", justify="center")
    for r in rows:
        act = r["action"] or (f"⚠ {r['error']}" if r["error"] else "—")
        mode = ("auto" if r["auto"] else "escalate") + (" ⛔" if r["violation"] else "")
        mark = "[green]✓[/]" if r["correct"] else "[red]✗[/]"
        style = None if r["correct"] else "red"
        table.add_row(r["issue_id"], r["type"], r["expected"], act, mode, mark, style=style)
    console.print(table)

    def pct(x):
        return f"{x * 100:.0f}%"

    prec = m["precision_on_auto_completed"]
    viol = m["must_not_auto_complete_violations"]
    console.print(
        f"\n[bold]Precision on auto-completed work:[/] "
        f"[{'green' if prec == 1 else 'red'}]{pct(prec)}[/] "
        f"({m['auto_correct']}/{m['auto_completed']})   target 100%"
    )
    console.print(
        f"[bold]Must-not-auto-complete violations:[/] "
        f"[{'green' if viol == 0 else 'red'}]{viol}[/]   target 0"
    )
    console.print(
        f"[bold]Planted-issue recall:[/] {pct(m['action_recall'])} ({m['correct']}/{m['total']})   "
        f"[bold]Automation:[/] {pct(m['automation_rate'])} ({m['auto_completed']}/{m['total']})   "
        f"[bold]Escalation quality:[/] {pct(m['escalation_quality'])} "
        f"({m['escalation_correct']}/{m['escalated']})"
    )
    if not no_write:
        console.print(f"\n[dim]→ wrote {RESULTS_MD}[/]")


@explain_app.command("seed-demo")
def explain_seed_demo() -> None:
    """Seed the demo work items (fraud hold, add-on reject) the explainer narrates."""
    from .explain.seed_demo import seed

    seed()


def _play_plan(p) -> bool:
    """Render any plan (football or generic) as timed captions. Returns grounded?"""
    import time as _time

    from rich.console import Console
    from rich.panel import Panel

    from explainer import engine

    console = Console()
    header = f"[bold]{p['title']}[/]  ·  {p.get('subject_id', '')}"
    if p.get("as_of"):
        header += f"  ·  [cyan]as of {p['as_of']}[/] (only what was known then)"
    console.print(Panel(header, border_style="grey37"))
    all_grounded = True
    for i, sc in enumerate(p["scenes"], 1):
        ungrounded = engine.validate_scene(sc)
        all_grounded = all_grounded and not ungrounded
        facts = "  ".join(f"[dim]{f['key']}=[/]{f['value']}" for f in sc.get("facts", []))
        mark = "[green]✓[/]" if not ungrounded else f"[red]✗ {ungrounded}[/]"
        console.print(f"\n[bold cyan]scene {i}[/]  →  focus=[yellow]{sc['ui'].get('highlight')}[/] {mark}")
        console.print(f'  [white]"{sc["say"]}"[/]')
        console.print(f"  {facts}")
        if sc.get("draw"):
            console.print(f"  [magenta]canvas:[/] {sc['draw']['type']} (builds on screen)")
        _time.sleep(0.12)
    console.print()
    console.print("[green]✓ every spoken number is grounded in source data[/]" if all_grounded
                  else "[red]✗ some numbers were not grounded[/]")
    return all_grounded


def _export(plan, out: str) -> None:
    import json
    from pathlib import Path

    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text("window.PITWALL_PLAN = " + json.dumps(plan, indent=2) + ";\n")
    typer.secho(f"wrote {out} — open voice/replay.html to watch it build live", fg="green")


@explain_app.command("plan")
def explain_plan(
    work_item_id: str = typer.Argument(..., help="e.g. WI-5602"),
    as_of: str = typer.Option(None, "--as-of", help="ISO time to rewind to, e.g. 2026-05-05T09:19"),
    no_persist: bool = typer.Option(False, "--no-persist", help="don't write the explanation"),
) -> None:
    """[Pit Wall] Build + validate a grounded narration plan and play it."""
    from datetime import datetime

    from .explain import plan as planmod

    when = datetime.fromisoformat(as_of) if as_of else None
    p = planmod.build_plan(work_item_id, as_of=when)
    _play_plan(p)
    if not no_persist:
        pid = planmod.persist_plan(p)
        typer.secho(f"explanation logged to audit as {pid} (actor=explainer, via gateway)", fg="bright_black")


@explain_app.command("from-json")
def explain_from_json(
    path: str = typer.Argument(..., help="an explain-request JSON file or directory"),
    subject: str = typer.Argument("", help="subject id (only for a directory / multi-key file)"),
    export: str = typer.Option(None, "--export", help="also write a browser plan, e.g. voice/plan.js"),
) -> None:
    """[Generic] Narrate ANY financial data you plug in as an explain-request JSON."""
    from explainer import engine
    from explainer.llm import make_anthropic_say_writer
    from explainer.providers import JsonProvider

    from .config import get_settings

    req = JsonProvider(path).fetch(subject)
    s = get_settings()
    sw = make_anthropic_say_writer(s.anthropic_api_key, s.pitwall_agent_model) if s.llm_is_live else None
    plan = engine.build_plan(req, say_writer=sw)
    _play_plan(plan)
    if export:
        _export(plan, export)


@explain_app.command("sample")
def explain_sample(
    export: str = typer.Option("voice/plan.js", "--export", help="browser plan path"),
) -> None:
    """[Generic] Play the bundled non-football sample (a monthly close) and export it."""
    from pathlib import Path

    import explainer
    from explainer import engine

    sample = Path(explainer.__file__).parent / "samples" / "acme-close-2026-03.json"
    import json

    plan = engine.build_plan(json.loads(sample.read_text()))
    _play_plan(plan)
    _export(plan, export)


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


@sow_app.command("sync")
def sow_sync() -> None:
    """Build 1: create a work item per unreconciled incoming bank line (idempotent)."""
    from .sow.sync import sync_bank_receipts

    created = sync_bank_receipts()
    if created:
        typer.secho(f"created {len(created)} work items:", fg="green")
        for wi in created:
            typer.echo(f"  {wi}")
    else:
        typer.secho("no new receipts to sync (cursor already caught up)", fg="bright_black")


@sow_app.command("audit")
def sow_audit(subject: str = typer.Argument(..., help="work item id, e.g. WI-5602")) -> None:
    """Build 4: 'why?' is one query — the append-only trail, denied attempts too."""
    from rich.console import Console
    from rich.table import Table

    from .sow.gateway import audit_trail

    rows = audit_trail(subject)
    t = Table(title=f"audit_log — {subject}")
    t.add_column("at"); t.add_column("actor", style="cyan"); t.add_column("action")
    t.add_column("ok", justify="center"); t.add_column("reason")
    for r in rows:
        ok = "[green]✓[/]" if r["allowed"] else "[red]✗[/]"
        diff = r["diff"] or {}
        st = diff.get("state")
        change = f" [{st['from']}→{st['to']}]" if st else ""
        t.add_row(str(r["at"])[:19], r["actor"], r["action"] + change, ok, (r["reason"] or "")[:52])
    Console().print(t)


@sow_app.command("walk")
def sow_walk() -> None:
    """Demo the whole spine on one work item: NEW → PROPOSED → APPROVED → POSTED,
    with a separation-of-duties DENIAL logged along the way. No keys needed."""
    from rich.console import Console

    from .sow import gateway
    from .sow.roles import Actor, GATEWAY
    from .sow.sync import sync_bank_receipts
    from .sow.transitions import Denied

    c = Console()
    agent = Actor("ai_agent", "ai_agent")
    priya = Actor("accountant:priya", "human_accountant")

    c.print("[bold]Build 1 · sync[/] — a bank line becomes a work item")
    created = sync_bank_receipts()
    if not created:
        # reuse an existing NEW receipt item if the cursor is caught up
        conn_items = gateway.connect("gateway")
        with conn_items.cursor() as cur:
            cur.execute("SELECT id FROM work.work_item WHERE kind='reconcile_receipt' AND state='NEW' LIMIT 1")
            row = cur.fetchone()
        conn_items.close()
        if not row:
            c.print("[yellow]no NEW receipt work item available — run `make reset` then retry[/]")
            raise typer.Exit(1)
        wi = row[0]
    else:
        wi = created[0]
    c.print(f"  work item: [cyan]{wi}[/]\n")

    c.print("[bold]Build 3 · the agent proposes[/] (ai_agent · propose)")
    gateway.transition(agent, wi, "propose",
                       patch={"proposed_by": "ai_agent",
                              "proposal": {"action": "match", "note": "memo matches one invoice; "
                                           "gap within tolerance"}},
                       reason="pol-001: gap within tolerance")
    c.print("  → PROPOSED\n")

    c.print("[bold]Build 2 · separation of duties[/] (ai_agent tries to approve its own proposal)")
    try:
        gateway.transition(agent, wi, "approve", reason="self-approve attempt")
    except Denied as e:
        c.print(f"  [red]DENIED[/] — {e.why}  [dim](logged as allowed=false)[/]\n")

    c.print("[bold]a human approves[/] (human_accountant · approve)")
    gateway.transition(priya, wi, "approve", patch={"approved_by": "accountant:priya"},
                       reason="match confirmed")
    c.print("  → APPROVED\n")

    c.print("[bold]Build 4 · only the gateway posts[/] (gateway · post → record)")
    gateway.post(GATEWAY, wi,
                 journal_lines=[{"account": "1000 Cash", "debit": 0, "credit": 0, "memo": "receipt matched"}],
                 reason="posted to ledger")
    c.print("  → POSTED  [dim](journal entry written by gateway)[/]\n")

    c.print("[bold]'why?' is one query:[/]")
    sow_audit(wi)


@agent_app.command("onboard")
def agent_onboard() -> None:
    """Self-learning: mine 12 months of history → draft policies → controller reviews."""
    from rich.console import Console
    from rich.table import Table

    from .agent.run import onboard

    outcomes = onboard()
    t = Table(title="Onboarding · self-learning from history")
    t.add_column("policy", style="cyan"); t.add_column("learned from"); t.add_column("evidence", justify="right")
    t.add_column("controller", justify="center")
    for o in outcomes:
        verdict = "[green]approved[/]" if o["approved"] else "[red]rejected[/]"
        t.add_row(o["policy"], o["situation"], str(o["evidence"]), verdict)
    Console().print(t)
    for o in outcomes:
        Console().print(f"  [cyan]{o['policy']}[/] — {o['text']}  [dim]({o['reason']})[/]")


@agent_app.command("run")
def agent_run(limit: int = typer.Option(None, "--limit", help="only the first N scenarios")) -> None:
    """Onboard, then autonomously process every planted scenario through the gateway."""
    from rich.console import Console
    from rich.table import Table

    from .agent.run import onboard, run_all

    c = Console()
    c.print("[bold]self-learning[/] — drafting policies from history…")
    onboard()
    c.print("[bold]processing scenarios[/] — code decides, gateway executes…\n")
    summary = run_all(limit=limit)
    t = Table(title="Autonomous run")
    t.add_column("work item", style="cyan"); t.add_column("type"); t.add_column("action", style="green")
    t.add_column("outcome"); t.add_column("routed to")
    for r in summary["results"]:
        if r.get("skipped"):
            t.add_row(r["wi"], "", "", f"[dim]{r['skipped']}[/]", "")
            continue
        outcome = r.get("final", "")
        extra = r.get("policy") or r.get("cfo") or ""
        x = " 💳" if r.get("x402") else ""
        t.add_row(r["wi"], r["type"], r["action"] + x, outcome, r.get("escalated_to") or extra)
    c.print(t)
    c.print(f"\n[bold]{summary['auto_completed']}[/] auto-completed · "
            f"[bold]{summary['escalated']}[/] escalated to a human · "
            f"{summary['skipped']} already processed  (of {summary['n']})")
    c.print("[dim]see any item's trail with:  pitwall sow audit WI-<id>[/]")


if __name__ == "__main__":
    app()
