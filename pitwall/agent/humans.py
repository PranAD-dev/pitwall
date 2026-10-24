"""Model-played humans. Approvers are busy, the controller sometimes says no, and
fraud-hold release needs the CFO as a second approver. Deterministic personas so
the demo + eval are reproducible; their answers become evidence on the work item.

A human's answer is information, never a silent approval — the actual approval
still goes through the gateway under the human's identity (sow/gateway.py)."""

from __future__ import annotations

from dataclasses import dataclass

from ..sow.roles import Actor


@dataclass
class Decision:
    approved: bool
    reason: str


# the people the agent escalates to
CONTROLLER = Actor("controller:dana", "human_controller")
CFO = Actor("cfo:marcus", "human_cfo")
ACCOUNTANT = Actor("accountant:priya", "human_accountant")
SPORTING = Actor("sporting_director:ruiz", "sporting_director")
PAYROLL = Actor("payroll_lead:chen", "payroll_lead")


def controller_reviews_policy(policy_id: str, evidence_count: int, rule: dict) -> Decision:
    """The controller approves a drafted policy iff it has enough precedent behind it.
    Thin evidence (or a risky auto_approve on an ambiguous rule) gets a 'no' with a reason."""
    if evidence_count < 5:
        return Decision(False, f"only {evidence_count} precedents — not enough to generalise; "
                               "keep escalating these by hand for now")
    if rule.get("auto_approve") and rule.get("kind") == "ambiguous":
        return Decision(False, "won't auto-approve an ambiguous treatment — must stay human-reviewed")
    return Decision(True, f"approved on {evidence_count} precedents")


def controller_reviews_work(subject: str, proposal: dict) -> Decision:
    """The controller signs off a proposed accounting treatment on an escalated item."""
    return Decision(True, "treatment confirmed")


def cfo_reviews_fraud_release(subject: str) -> Decision:
    """A fraud hold needs the CFO as second approver. The CFO does NOT rubber-stamp:
    with a confirmed bank mismatch, the CFO keeps it held and demands re-verification."""
    return Decision(False, "bank mismatch confirmed — do not release; re-verify details with the "
                           "club through a known contact before any payment")


def accountant_answers(question: str) -> str:
    return "confirmed against the records"
