"""The hard-check confidence gate. Confidence = checks in CODE, not LLM vibes.
Before anything auto-completes, these must pass; any failure is named and the item
escalates. The LLM proposes and explains; this decides."""

from __future__ import annotations

import json
from pathlib import Path

_SELLER_TRUTH: dict | None = None
SELLER_PATH = Path(__file__).resolve().parents[2] / "world" / "out" / "seller_bank_truth.json"


def edit_distance(a: str, b: str) -> int:
    """Levenshtein — used to spot a lookalike domain (northgate-rangers.fr vs the
    real northgaterangers.fr)."""
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def is_lookalike(from_domain: str, verified_domain: str) -> bool:
    """A domain that's close-but-not-equal to the verified one is a red flag."""
    if not from_domain or not verified_domain or from_domain == verified_domain:
        return False
    return edit_distance(from_domain, verified_domain) <= 3


def buy_bank_check(iban: str) -> dict:
    """Buy a bank-account verification (x402 evidence, mocked from the deterministic
    seller truth). Returns {status: match|mismatch, owner, cost_usdc, tx_hash}."""
    global _SELLER_TRUTH
    if _SELLER_TRUTH is None:
        _SELLER_TRUTH = json.loads(SELLER_PATH.read_text()) if SELLER_PATH.exists() else {}
    truth = _SELLER_TRUTH.get(iban, {"status": "mismatch", "owner": "UNVERIFIED"})
    return {"status": truth["status"], "owner": truth["owner"], "cost_usdc": 0.04,
            "network": "base-sepolia", "simulated": True,
            "tx_hash": "0xSIMULATED" + (iban[-8:] if iban else "00000000")}


def reconciles_to_cent(expected: float, got: float, tol: float = 0.01) -> bool:
    return abs(round(expected, 2) - round(got, 2)) <= tol


def within_threshold(amount: float, threshold: float) -> bool:
    return amount <= threshold


def shortfall_pct(expected: float, received: float) -> float:
    if expected == 0:
        return 0.0
    return round((expected - received) / expected * 100, 2)
