"""The payroll run — a PRIVILEGED job (the payroll team's system).

It is the only thing that reads payroll_private (individual salaries + per-player
bonus rates) and golden.match_event, and it writes ONE authorized aggregate per
period into golden.payroll_run: gross wages + the performance bonuses players
actually earned that month (appearances/goals × their rate). The accounting agent
then books from this aggregate and never touches a single salary.

Runs as the superuser connection because payroll_private is granted to no app role —
that separation is the point: the number the books use is an aggregate, the detail
stays sealed.
"""

from __future__ import annotations

from ..db import connect


def run_payroll() -> dict:
    """(Re)compute golden.payroll_run for every period. Idempotent."""
    conn = connect("superuser")
    try:
        with conn.cursor() as cur:
            # 1) per-player base wage + bonus rates (SECRET)
            cur.execute("SELECT player_id, base_wage, "
                        "coalesce((bonuses->>'appearance')::numeric,0), "
                        "coalesce((bonuses->>'goal')::numeric,0) FROM payroll_private.salary")
            rate = {}
            player_base = 0.0
            for pid, base, appr, goalr in cur.fetchall():
                player_base += float(base or 0)
                rate[pid] = {"appearance": float(appr or 0), "goal": float(goalr or 0)}
            cur.execute("SELECT coalesce(sum(base_wage),0) FROM payroll_private.staff_salary")
            staff_base = float(cur.fetchone()[0] or 0)
            headcount = len(rate)
            cur.execute("SELECT count(*) FROM payroll_private.staff_salary")
            headcount += int(cur.fetchone()[0] or 0)

            annual_gross = player_base + staff_base
            monthly_gross = round(annual_gross / 12, 2)
            monthly_player = round(player_base / 12, 2)      # SCR counts first-team wages
            monthly_staff = round(staff_base / 12, 2)        # coaching & other staff

            # 2) match-triggered bonuses per (player, period, kind)
            cur.execute(
                "SELECT me.player_id, pr.id, me.kind, count(*) "
                "FROM golden.match_event me "
                "JOIN golden.period pr ON me.event_time::date BETWEEN pr.start_date AND pr.end_date "
                "WHERE me.kind IN ('appearance','goal') GROUP BY 1,2,3")
            appr_by_period: dict[str, float] = {}
            goal_by_period: dict[str, float] = {}
            for pid, period, kind, cnt in cur.fetchall():
                r = rate.get(pid, {"appearance": 0, "goal": 0})
                amt = float(cnt) * r.get(kind, 0)
                if kind == "appearance":
                    appr_by_period[period] = round(appr_by_period.get(period, 0) + amt, 2)
                else:
                    goal_by_period[period] = round(goal_by_period.get(period, 0) + amt, 2)

            # 3) write one aggregate row per period
            cur.execute("SELECT id FROM golden.period ORDER BY start_date")
            periods = [r[0] for r in cur.fetchall()]
            for p in periods:
                cur.execute(
                    "INSERT INTO golden.payroll_run (id, period_id, currency, gross_wages, "
                    "player_gross, staff_gross, earned_appearance_bonus, earned_goal_bonus, "
                    "headcount) VALUES (%s,%s,'EUR',%s,%s,%s,%s,%s,%s) "
                    "ON CONFLICT (id) DO UPDATE SET gross_wages=EXCLUDED.gross_wages, "
                    "player_gross=EXCLUDED.player_gross, staff_gross=EXCLUDED.staff_gross, "
                    "earned_appearance_bonus=EXCLUDED.earned_appearance_bonus, "
                    "earned_goal_bonus=EXCLUDED.earned_goal_bonus, headcount=EXCLUDED.headcount, "
                    "computed_at=now()",
                    (f"payrun-{p}", p, monthly_gross, monthly_player, monthly_staff,
                     appr_by_period.get(p, 0), goal_by_period.get(p, 0), headcount))
        conn.commit()
    finally:
        conn.close()
    return {"periods": len(periods), "monthly_gross": monthly_gross, "annual_gross": annual_gross,
            "headcount": headcount,
            "total_appearance_bonus": round(sum(appr_by_period.values()), 2),
            "total_goal_bonus": round(sum(goal_by_period.values()), 2)}
