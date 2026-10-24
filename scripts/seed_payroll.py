"""Deterministic payroll: realistic player wages + fake managers/coaching staff.

Standalone + idempotent (TRUNCATE + INSERT only the payroll tables). Recalibrates the
40 existing players to realistic EUR wages (~€38M total) and adds 9 named non-playing
staff (~€6M) → ~€44M wage bill, consistent with golden.payroll_cost and the forecast.
Individual pay stays in payroll_private (agent denied); only names/roles are in golden.

    uv run python scripts/seed_payroll.py
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv  # noqa: E402

load_dotenv()
from pitwall.db import connect  # noqa: E402

PLAYER_WAGE_TARGET = 38_000_000   # EUR/year across the squad
POS_PREMIUM = {"ST": 1.35, "CF": 1.30, "RW": 1.20, "LW": 1.20, "AM": 1.15, "CM": 1.00,
               "DM": 1.00, "CB": 1.00, "RB": 0.90, "LB": 0.90, "GK": 0.95}

# id, name, role, department, nationality, joined, base_wage (EUR/yr)
STAFF = [
    ("stf-01", "Marco Verhoeven",  "head_coach",          "football",    "Netherlands", date(2024, 6, 1), 3_000_000),
    ("stf-02", "Tom Bridger",      "assistant_coach",     "football",    "England",     date(2024, 6, 1),   620_000),
    ("stf-03", "Luka Novak",       "gk_coach",            "football",    "Croatia",     date(2023, 7, 1),   320_000),
    ("stf-04", "Diego Salas",      "first_team_coach",    "football",    "Spain",       date(2024, 6, 1),   400_000),
    ("stf-05", "Henrik Olsen",     "head_of_fitness",     "medical",     "Denmark",     date(2022, 8, 1),   300_000),
    ("stf-06", "Priya Raman",      "lead_physio",         "medical",     "England",     date(2021, 9, 1),   250_000),
    ("stf-07", "Samuel Boateng",   "performance_analyst", "analysis",    "Ghana",       date(2023, 1, 15),  210_000),
    ("stf-08", "Gianni Ferrara",   "sporting_director",   "recruitment", "Italy",       date(2020, 5, 1),   820_000),
    ("stf-09", "Alan Whitmore",    "academy_director",    "football",    "Scotland",    date(2019, 7, 1),   410_000),
]


def _rng(seed: str) -> random.Random:
    return random.Random(int(hashlib.md5(seed.encode()).hexdigest(), 16) & 0xFFFFFFFF)


def main() -> None:
    with connect() as c, c.cursor() as cur:
        cur.execute("SELECT id, position FROM golden.player ORDER BY id")
        players = cur.fetchall()

        # raw wage by tier × position premium, then scale the squad to the target
        raw = []
        for pid, pos in players:
            r = _rng(pid + "-pay")
            roll = r.random()
            base = 6_000_000 if roll < 0.10 else 2_600_000 if roll < 0.35 else 1_100_000 if roll < 0.72 else 450_000
            prem = POS_PREMIUM.get((pos or "").upper(), 1.0)
            raw.append((pid, base * prem * (0.85 + r.random() * 0.30)))
        scale = PLAYER_WAGE_TARGET / (sum(w for _, w in raw) or 1)

        sal = []
        for pid, w in raw:
            r = _rng(pid + "-bon")
            wage = max(250_000, round(w * scale, -3))      # nearest €1k, floor €250k
            sal.append((pid, wage, "EUR", json.dumps({"appearance": 2000 + r.randrange(0, 6000)})))
        cur.execute("TRUNCATE payroll_private.salary")
        cur.executemany(
            "INSERT INTO payroll_private.salary (player_id, base_wage, currency, bonuses) "
            "VALUES (%s,%s,%s,%s)", sal)

        # managers + coaching/medical/recruitment staff
        cur.execute("TRUNCATE golden.staff")
        cur.executemany(
            "INSERT INTO golden.staff (id,name,role,department,nationality,joined_at) "
            "VALUES (%s,%s,%s,%s,%s,%s)", [(s[0], s[1], s[2], s[3], s[4], s[5]) for s in STAFF])
        cur.execute("TRUNCATE payroll_private.staff_salary")
        cur.executemany(
            "INSERT INTO payroll_private.staff_salary (staff_id, base_wage, currency, bonuses) "
            "VALUES (%s,%s,'EUR','{}')", [(s[0], s[6]) for s in STAFF])

        c.commit()
        psum = sum(w for _, w, _, _ in sal)
        ssum = sum(s[6] for s in STAFF)
        print(f"players: {len(sal)} (€{psum / 1e6:.1f}M) · staff: {len(STAFF)} (€{ssum / 1e6:.1f}M) "
              f"· total wage bill €{(psum + ssum) / 1e6:.1f}M")


if __name__ == "__main__":
    main()
