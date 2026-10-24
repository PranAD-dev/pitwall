"""Deterministically populate golden.ticket_sale + golden.forecast_snapshot.

Standalone and idempotent (TRUNCATE + INSERT only these two tables) so it runs against
the live Tiger DB WITHOUT regenerating the whole world — safe while other work is in
flight. Tied to the existing golden.period calendar. Tickets are a slice of total
revenue, so the squad-cost ratio stays consistent with the Forecast board (~68%, limit 70).

    uv run python scripts/seed_tickets_forecast.py
"""
from __future__ import annotations

import hashlib
import os
import random
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv  # noqa: E402

load_dotenv()
from pitwall.db import connect  # noqa: E402

# section, capacity, matchday base price (EUR)
SECTIONS = [
    ("North Stand", 8200, 38),
    ("South Stand", 7600, 34),
    ("East Stand", 5400, 46),
    ("West Stand (Hospitality)", 1200, 120),
    ("Away End", 3000, 32),
]
# section, holders, season-ticket price (EUR)
SEASON_TICKET = [
    ("North Stand", 5200, 580),
    ("South Stand", 4300, 540),
    ("East Stand", 3100, 690),
    ("West Stand (Hospitality)", 700, 2100),
]
OPPONENTS = ["Northgate Rangers", "Fernhill City", "Westbrook United", "Caldershaw",
             "Port Meadow", "Ashcombe Town", "Rivenhall", "Dunmore Albion",
             "Sandford", "Kingsbridge", "Elmwood FC", "Thornbury"]

OTHER_REVENUE_ANNUAL = 105_000_000      # total club revenue (tickets are a slice of this)
WAGE_AGG_ANNUAL = 44_000_000
SQUAD_COST_LIMIT = 70


def _rng(seed: str) -> random.Random:
    return random.Random(int(hashlib.md5(seed.encode()).hexdigest(), 16) & 0xFFFFFFFF)


def _slug(s: str) -> str:
    return "".join(ch.lower() if ch.isalnum() else "-" for ch in s).strip("-")


def _season_of(d: date) -> str:
    y = d.year if d.month >= 7 else d.year - 1
    return f"{y}/{str(y + 1)[2:]}"


def _months_into_season(d: date) -> int:
    return (d.month - 7 if d.month >= 7 else d.month + 5) + 1   # 1..12


def main() -> None:
    with connect() as c, c.cursor() as cur:
        cur.execute("SELECT id, start_date, end_date FROM golden.period ORDER BY start_date")
        periods = cur.fetchall()

        # ---------- tickets ----------
        tix = []
        for pid, start, end in periods:
            seas = _season_of(start)
            rng = _rng(pid)
            if start.month == 7:                       # season tickets go on sale in July
                for sec, holders, price in SEASON_TICKET:
                    qty = int(holders * (0.82 + rng.random() * 0.16))
                    tix.append((f"tix-{seas.replace('/', '')}-season-{_slug(sec)}", "season", seas,
                                None, None, None, None, sec, qty, price, qty * price, "EUR",
                                start + timedelta(days=12)))
            if start.month in (8, 9, 10, 11, 12, 1, 2, 3, 4, 5):   # match months: 2 home games
                for g in range(2):
                    md = min(start + timedelta(days=6 + g * 14), end)
                    comp = "league" if rng.random() > 0.22 else ("europe" if rng.random() > 0.5 else "cup")
                    opp = OPPONENTS[rng.randrange(len(OPPONENTS))]
                    mid = f"M-{md.isoformat()}"
                    draw = 1.12 if comp == "europe" else 1.0
                    for sec, cap, price in SECTIONS:
                        qty = int(cap * (0.68 + rng.random() * 0.30))
                        up = round(price * draw, 2)
                        tix.append((f"tix-{md.isoformat()}-{_slug(sec)}", "matchday", seas,
                                    mid, md, comp, opp, sec, qty, up, round(qty * up, 2), "EUR", md))

        cur.execute("TRUNCATE golden.ticket_sale")
        cur.executemany(
            "INSERT INTO golden.ticket_sale (id,kind,season,match_id,matchday,competition,opponent,"
            "section,qty,unit_price,gross,currency,sold_at,raw_ref) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL)", tix)

        # monthly + season ticket revenue, for the forecast build-up
        cur.execute("SELECT date_trunc('month', matchday)::date, sum(gross) FROM golden.ticket_sale "
                    "WHERE matchday IS NOT NULL GROUP BY 1")
        md_rev = {r[0]: float(r[1]) for r in cur.fetchall()}
        cur.execute("SELECT season, sum(gross) FROM golden.ticket_sale WHERE kind='season' GROUP BY 1")
        season_rev = {r[0]: float(r[1]) for r in cur.fetchall()}

        # ---------- forecast snapshots ----------
        snaps = []
        cur_season, ytd = None, 0.0
        for pid, start, end in periods:
            seas = _season_of(start)
            if seas != cur_season:
                cur_season, ytd = seas, 0.0
            rng = _rng(pid + "-fc")
            tkt_month = md_rev.get(date(start.year, start.month, 1), 0.0)
            if start.month == 7:
                tkt_month += season_rev.get(seas, 0.0)
            ytd += OTHER_REVENUE_ANNUAL / 12.0          # tickets are a slice of total revenue
            # squad-cost ratio hovers near 68%, drifting up over a season (compliance tension)
            ratio = round(min(70.4, max(64.0, 67.5 + (_months_into_season(start) - 6) * 0.28
                                        + rng.uniform(-0.6, 0.6))), 1)
            cash = round(9_000_000 + tkt_month * 0.4 + rng.uniform(-2_000_000, 5_000_000), 2)
            snaps.append((f"fc-{pid}", end, f"FY{seas}", cash, round(ytd, 2),
                          float(OTHER_REVENUE_ANNUAL), float(WAGE_AGG_ANNUAL), ratio,
                          round(tkt_month, 2),
                          f"squad-cost {ratio}% of revenue (league limit {SQUAD_COST_LIMIT}%)"))

        cur.execute("TRUNCATE golden.forecast_snapshot")
        cur.executemany(
            "INSERT INTO golden.forecast_snapshot (id,as_of,horizon,projected_cash,revenue_ytd,"
            "revenue_forecast,wage_bill,squad_cost_ratio,ticket_revenue,note,raw_ref) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NULL)", snaps)

        # ---------- payroll cost (AGGREGATE only — never an individual salary) ----------
        cur.execute("SELECT count(*) FROM payroll_private.salary")   # headcount only
        headcount = cur.fetchone()[0] or 40
        base_month = WAGE_AGG_ANNUAL / 12.0
        pc = []
        for pid, start, end in periods:
            rng = _rng(pid + "-pay")
            # appearance/goal bonus accruals rise during match months (agent computes these)
            bonus = base_month * (0.02 + rng.random() * 0.03) if start.month in (8, 9, 10, 11, 12, 1, 2, 3, 4, 5) else 0.0
            oncost = base_month * 0.14
            total = base_month + bonus + oncost
            pc.append((f"pay-{pid}", end, headcount, round(base_month, 2), round(bonus, 2),
                       round(oncost, 2), round(total, 2), "EUR",
                       f"{headcount} registered players · aggregate wage bill (no individual salaries)"))
        cur.execute("TRUNCATE golden.payroll_cost")
        cur.executemany(
            "INSERT INTO golden.payroll_cost (id,month,headcount,base_wage_bill,bonus_accrual,"
            "employer_oncost,total,currency,note) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", pc)

        c.commit()
        print(f"ticket_sale: {len(tix)} rows · forecast_snapshot: {len(snaps)} rows · payroll_cost: {len(pc)} rows")


if __name__ == "__main__":
    main()
