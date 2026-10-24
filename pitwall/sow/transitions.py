"""Build 3 — the work-item state machine. The agent's tools are CRUD on the work:
every change goes through a transition; a reversal is a new transition, never a
delete.  (Hyphenate deck, slide 17; extended with reject/hold/release/reverse.)"""

from __future__ import annotations

# (state, action) -> next state
TRANSITIONS: dict[tuple[str, str], str] = {
    ("NEW", "propose"): "PROPOSED",
    ("PROPOSED", "ask"): "NEEDS_INFO",
    ("NEEDS_INFO", "answer"): "PROPOSED",
    ("PROPOSED", "approve"): "APPROVED",
    ("PROPOSED", "reject"): "REJECTED",
    ("APPROVED", "post"): "POSTED",      # the only write to the record
    ("HELD", "release"): "PROPOSED",     # requires a second approver incl. CFO (checked in can())
    ("POSTED", "reverse"): "REVERSED",   # a reversal is itself a new, logged transition
}

# `hold` can fire from any non-terminal state (suspected fraud, missing evidence)
HOLDABLE = {"NEW", "PROPOSED", "NEEDS_INFO", "APPROVED"}
TERMINAL = {"POSTED", "REJECTED", "REVERSED"}


class Denied(Exception):
    """Raised (after the denied attempt is logged) when a transition is refused."""

    def __init__(self, action: str, subject: str, why: str):
        super().__init__(f"denied: {action} on {subject} — {why}")
        self.action, self.subject, self.why = action, subject, why


def next_state(state: str, action: str) -> str | None:
    """The state `action` leads to from `state`, or None if it isn't allowed."""
    if action == "hold":
        return "HELD" if state in HOLDABLE else None
    return TRANSITIONS.get((state, action))
