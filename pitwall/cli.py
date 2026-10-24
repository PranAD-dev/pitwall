"""`pitwall` command-line entry point (the one invoked by the Makefile)."""

from __future__ import annotations

import typer

app = typer.Typer(no_args_is_help=True, add_completion=False, help="Pit Wall CLI")
db_app = typer.Typer(no_args_is_help=True, help="database schema + migrations")
world_app = typer.Typer(no_args_is_help=True, help="deterministic world + answer key")
demo_app = typer.Typer(no_args_is_help=True, help="scripted demo scenarios")
eval_app = typer.Typer(no_args_is_help=True, help="score Pit Wall vs the answer key")
app.add_typer(db_app, name="db")
app.add_typer(world_app, name="world")
app.add_typer(demo_app, name="demo")
app.add_typer(eval_app, name="eval")


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


if __name__ == "__main__":
    app()
