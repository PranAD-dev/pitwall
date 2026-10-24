"""Apply the schema. Creates least-privilege roles from .env passwords (so secrets
never live in committed SQL), then runs db/schema/*.sql in filename order.

Whole-file execution uses libpq's simple-query protocol (conn.pgconn.exec_) which
handles multi-statement files and dollar-quoted function bodies natively."""

from __future__ import annotations

from pathlib import Path

from psycopg import pq, sql
from rich.console import Console

from .config import get_settings
from .db import connect

console = Console()
SCHEMA_DIR = Path(__file__).resolve().parents[1] / "db" / "schema"


def _ensure_roles(conn) -> None:
    creds = get_settings().role_credentials()
    with conn.cursor() as cur:
        for role, password in creds.items():
            cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (role,))
            exists = cur.fetchone() is not None
            verb = "ALTER" if exists else "CREATE"
            cur.execute(
                sql.SQL("{action} ROLE {name} LOGIN PASSWORD {pw}").format(
                    action=sql.SQL(verb),
                    name=sql.Identifier(role),
                    pw=sql.Literal(password),
                )
            )
            console.print(f"  role [cyan]{role}[/] {'updated' if exists else 'created'}")


def _run_file(conn, path: Path) -> None:
    result = conn.pgconn.exec_(path.read_text().encode())
    if result.status in (pq.ExecStatus.FATAL_ERROR, pq.ExecStatus.BAD_RESPONSE):
        msg = (result.error_message or b"").decode().strip()
        raise RuntimeError(f"{path.name}: {msg}")
    console.print(f"  applied [green]{path.name}[/]")


def migrate() -> None:
    files = sorted(SCHEMA_DIR.glob("*.sql"))
    if not files:
        raise RuntimeError(f"no schema files found in {SCHEMA_DIR}")
    conn = connect("superuser", autocommit=True)
    try:
        console.print("[bold]creating roles[/]")
        _ensure_roles(conn)
        console.print("[bold]applying schema[/]")
        for path in files:
            _run_file(conn, path)
    finally:
        conn.close()
    console.print(f"[bold green]migration complete[/] ({len(files)} files)")
