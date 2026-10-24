"""Build 2 — map who may do WHAT, to WHICH resource. Checked on every call.

Actors propose; humans approve; only the gateway posts. Separation of duties:
whoever proposed a thing cannot approve it.  (Hyphenate deck, slide 16.)

This is the *logical* authorization layer. It sits on top of the DB-level grants
(pitwall_agent can't write journal/salaries; only the gateway role posts), which
are the backstop — limits enforced in code AND in the database, never the prompt.
"""

from __future__ import annotations

from dataclasses import dataclass

# role -> resource kind -> allowed actions
ROLES: dict[str, dict[str, set[str]]] = {
    "sync": {"work_item": {"create"}},
    "ai_agent": {
        "work_item": {"propose", "ask", "hold", "buy_evidence"},
        "policy": {"propose"},
    },
    "human_accountant": {"work_item": {"approve", "answer", "reject"}},
    "human_controller": {"work_item": {"approve", "reject"}, "policy": {"approve", "reject"}},
    "human_cfo": {"work_item": {"approve", "release"}},  # second approver on fraud holds
    "sporting_director": {"work_item": {"answer"}},       # answers questions only
    "payroll_lead": {"work_item": {"answer"}},
    "gateway": {"work_item": {"post", "reverse"}, "journal": {"post"}},
}


@dataclass(frozen=True)
class Actor:
    id: str      # e.g. "accountant:priya"
    role: str    # a key of ROLES


def can(actor: Actor, action: str, resource: dict) -> bool:
    """True iff `actor` may perform `action` on `resource`.

    The ROLES map is keyed by resource *category* (work_item | policy | journal),
    NOT the work item's business `kind` (reconcile_receipt, addon_claim, …). A
    resource states its category via `resource_kind`; a work item defaults to
    'work_item'."""
    category = resource.get("resource_kind", "work_item")
    if action not in ROLES.get(actor.role, {}).get(category, set()):
        return False
    # separation of duties: you cannot approve your own proposal
    if action in ("approve", "release") and resource.get("proposed_by") == actor.id:
        return False
    return True


# convenient singletons for the common model-played actors
SYNC = Actor("sync", "sync")
AI_AGENT = Actor("ai_agent", "ai_agent")
GATEWAY = Actor("gateway", "gateway")
