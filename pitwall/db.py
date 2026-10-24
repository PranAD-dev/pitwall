"""Thin psycopg helpers. `connect(role=...)` picks the right least-privilege URL."""

from __future__ import annotations

from contextlib import contextmanager
from typing import Iterator

import psycopg

from .config import get_settings


def connect(role: str = "superuser", *, autocommit: bool = False) -> psycopg.Connection:
    """Open a connection as one of: superuser | agent | gateway | sync | voice."""
    url = get_settings().role_url(role)
    return psycopg.connect(url, autocommit=autocommit)


@contextmanager
def cursor(role: str = "superuser", *, autocommit: bool = False) -> Iterator[psycopg.Cursor]:
    conn = connect(role, autocommit=autocommit)
    try:
        with conn.cursor() as cur:
            yield cur
        if not autocommit:
            conn.commit()
    finally:
        conn.close()
