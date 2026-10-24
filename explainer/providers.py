"""Providers are the seam you plug your data into. A provider turns a subject id
(an invoice, a close, a transaction batch, a report) into an explain-request the
engine can narrate. Ship your own by implementing `fetch`.

Built in:
  * DictProvider  — in-memory requests (tests, quick demos)
  * JsonProvider  — a file or a directory of `<subject>.json` requests
Pit Wall's football data is just another provider (pitwall.explain.provider)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol


class Provider(Protocol):
    def fetch(self, subject_id: str, as_of: str | None = None) -> dict[str, Any]:
        """Return an explain-request dict for this subject."""
        ...


class DictProvider:
    def __init__(self, requests: dict[str, dict[str, Any]]):
        self._requests = requests

    def fetch(self, subject_id: str, as_of: str | None = None) -> dict[str, Any]:
        req = self._requests.get(subject_id)
        if req is None:
            raise KeyError(f"no explain-request for subject {subject_id!r}")
        return dict(req, as_of=as_of) if as_of else req


class JsonProvider:
    """Load requests from a single JSON file (keyed by subject_id) or a directory
    of `<subject_id>.json` files."""

    def __init__(self, path: str | Path):
        self.path = Path(path)

    def fetch(self, subject_id: str, as_of: str | None = None) -> dict[str, Any]:
        if self.path.is_dir():
            f = self.path / f"{subject_id}.json"
            if not f.exists():
                raise KeyError(f"{f} not found")
            req = json.loads(f.read_text())
        else:
            data = json.loads(self.path.read_text())
            req = data.get(subject_id, data) if isinstance(data, dict) else data
        return dict(req, as_of=as_of) if as_of else req

    def subjects(self) -> list[str]:
        if self.path.is_dir():
            return sorted(p.stem for p in self.path.glob("*.json"))
        data = json.loads(self.path.read_text())
        return sorted(data.keys()) if isinstance(data, dict) and "scenes" not in data else []
