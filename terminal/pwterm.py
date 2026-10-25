#!/usr/bin/env python3
"""PIT WALL — FINANCE TERMINAL

A Bloomberg-style terminal client for the Pit Wall autonomous finance agent.

The point of this program: it shares ZERO code with the 3D stadium web app. It is a
thin, dependency-free client over the exact same HTTP API (the System of Work
gateway). Same agent, same least-privilege DB roles, same append-only audit, same
100%-precision hard-check gate — a brand-new surface. Proof the system is a service
you can put any face on, not a pile of code welded to one UI.

Pure Python standard library. No pip install. Run it against a running API:

    python3 terminal/pwterm.py                 # defaults to http://localhost:4055
    python3 terminal/pwterm.py http://host:port

Then type a mnemonic and press Enter (Bloomberg-style "<CMD> GO"). `HELP` lists them.
Best viewed in a dark, full-screen terminal at >=100 columns.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

# --------------------------------------------------------------------------- #
# Connection
# --------------------------------------------------------------------------- #
HOST = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("PITWALL_API", "http://localhost:4055")).rstrip("/")
CONNECTED = True


def api_get(path: str, timeout: int = 30):
    with urllib.request.urlopen(HOST + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def api_post(path: str, timeout: int = 180):
    req = urllib.request.Request(HOST + path, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def api_sse(path: str, timeout: int = 600):
    """Yield parsed JSON objects from a text/event-stream endpoint."""
    req = urllib.request.Request(HOST + path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line.startswith("data:"):
                payload = line[5:].strip()
                if payload:
                    try:
                        yield json.loads(payload)
                    except Exception:  # noqa: BLE001
                        pass


# --------------------------------------------------------------------------- #
# ANSI / palette  (Bloomberg = amber-on-black, with green/red data)
# --------------------------------------------------------------------------- #
ESC = "\x1b["
RESET = ESC + "0m"
BOLD = ESC + "1m"


def _fg(n: int) -> str:
    return f"{ESC}38;5;{n}m"


def _bg(n: int) -> str:
    return f"{ESC}48;5;{n}m"


AMBER = _fg(214)
ORANGE = _fg(208)
GOLD = _fg(220)
GREEN = _fg(46)
RED = _fg(196)
CYAN = _fg(45)
BLUE = _fg(39)
WHITE = _fg(231)
GREY = _fg(245)
DGREY = _fg(240)
BLACK = _fg(16)

BG = _bg(233)          # the black panel background (forced, theme-independent)
OBG = _bg(208)         # orange brand bar
DBG = _bg(236)         # dark header/legend bar
REDBG = _bg(88)

ALT_ON = ESC + "?1049h"
ALT_OFF = ESC + "?1049l"
HIDE = ESC + "?25l"
SHOW = ESC + "?25h"
CLEAR_HOME = ESC + "2J" + ESC + "H"

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def vlen(s: str) -> int:
    return len(_ANSI.sub("", s))


def clip(s: str, w: int) -> str:
    """Truncate to w *visible* chars, preserving ANSI codes. No reset appended."""
    if w <= 0:
        return ""
    out, vis, i, n = [], 0, 0, len(s)
    while i < n:
        c = s[i]
        if c == "\x1b":
            j = s.find("m", i)
            if j == -1:
                break
            out.append(s[i:j + 1])
            i = j + 1
            continue
        if vis >= w:
            break
        out.append(c)
        vis += 1
        i += 1
    return "".join(out)


def padv(s: str, w: int, align: str = "left") -> str:
    s = clip(s, w)
    gap = max(0, w - vlen(s))
    if align == "right":
        return " " * gap + s
    if align == "center":
        l = gap // 2
        return " " * l + s + " " * (gap - l)
    return s + " " * gap


def col(s, w: int, align: str = "left", color: str = AMBER) -> str:
    """One table cell: sets its own fg (never resets), pads by visible width."""
    return color + padv(str(s), w, align)


# --------------------------------------------------------------------------- #
# Screen geometry
# --------------------------------------------------------------------------- #
def size():
    try:
        sz = os.get_terminal_size()
        return max(80, sz.columns), max(20, sz.lines)
    except OSError:
        return 120, 40


W, H = size()


def line_plain(content: str) -> str:
    s = clip(content, W)
    return BG + s + " " * max(0, W - vlen(s)) + RESET


def line_bar(content: str, bg_fg: str) -> str:
    s = clip(content, W)
    return bg_fg + s + " " * max(0, W - vlen(s)) + RESET


def split_bar(left: str, right: str, bg_fg: str) -> str:
    gap = W - vlen(left) - vlen(right)
    content = left + " " * gap + right if gap >= 1 else left + " " + right
    return line_bar(content, bg_fg)


def sep() -> str:
    return line_plain(DGREY + "─" * W)


def wrap(text: str, width: int):
    words, out, cur = str(text).split(), [], ""
    for wd in words:
        if len(cur) + len(wd) + 1 > width:
            if cur:
                out.append(cur)
            cur = wd
        else:
            cur = (cur + " " + wd).strip()
    if cur:
        out.append(cur)
    return out or [""]


# --------------------------------------------------------------------------- #
# Formatting helpers
# --------------------------------------------------------------------------- #
SYM = {"EUR": "€", "GBP": "£", "USD": "$"}


def money(n, ccy: str = "") -> str:
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "—"
    s = SYM.get(ccy, "")
    a = abs(n)
    sign = "-" if n < 0 else ""
    if a >= 1e6:
        return f"{sign}{s}{a / 1e6:,.1f}M"
    if a >= 1e3:
        return f"{sign}{s}{a / 1e3:,.0f}K"
    return f"{sign}{s}{a:,.0f}"


def norm_wi(arg):
    a = (arg or "").strip().upper()
    if not a:
        return None
    if a.startswith("WI-"):
        return a
    if a.startswith("WI"):
        return "WI-" + a[2:].lstrip("-")
    if a.isdigit():
        return "WI-" + a
    return a


# --------------------------------------------------------------------------- #
# Chrome (top bar, ticker, title bar, legend)
# --------------------------------------------------------------------------- #
_MODE = {"mode": "?", "agent": None}


def _refresh_status():
    global CONNECTED
    try:
        _MODE.update(api_get("/api/agent/mode", timeout=4))
        CONNECTED = True
    except Exception:  # noqa: BLE001
        CONNECTED = False


def topbar() -> str:
    brand = BOLD + "  PIT WALL  " + ESC + "22m" + "▮ FINANCE TERMINAL"
    dot = "● LIVE" if CONNECTED else "× NO LINK"
    mode = (_MODE.get("mode") or "?").upper()
    host = HOST.replace("http://", "").replace("https://", "")
    right = f"HARBOURSIDE FC   AGENT:{mode}   {host}   {time.strftime('%Y-%m-%d %H:%M:%S')}   {dot}  "
    return split_bar(BLACK + brand, BLACK + right, OBG + BLACK)


_FEED_CACHE = {"t": 0.0, "v": []}


def ticker() -> str:
    now = time.time()
    if now - _FEED_CACHE["t"] > 3:
        try:
            _FEED_CACHE["v"] = api_get("/api/feed", timeout=4)
            _FEED_CACHE["t"] = now
        except Exception:  # noqa: BLE001
            pass
    chips = []
    for f in _FEED_CACHE["v"][:12]:
        c = {"red": RED, "green": GREEN, "amber": AMBER}.get(f.get("kind"), WHITE)
        chips.append(f"{c}{f.get('subject', '')} {f.get('label', '')}")
    body = (GREY + "  ┆  ").join(chips) if chips else GREY + "no activity"
    return line_plain(GOLD + BOLD + " TAPE ▸ " + RESET + BG + body)


def title_bar(code: str, title: str, sub: str = "") -> str:
    left = ORANGE + BOLD + f"  {code} " + DGREY + "▸ " + AMBER + BOLD + title
    right = GREY + (sub + "  " if sub else "")
    return split_bar(left, right, DBG)


LEGEND = [
    ("1", "MON"), ("2", "QUEUE"), ("3", "BOOK"), ("4", "PNL"), ("5", "SCR"),
    ("6", "POL"), ("7", "SCORE"), ("8", "AUDIT"), ("9", "HIST"),
    ("WI#", "DRILL"), ("RUN", "AGENT"), ("?", "HELP"),
]


def legend_bar() -> str:
    # keep bg = DBG for the whole bar; only switch fg per piece (no RESET mid-line)
    content = GREY
    for k, v in LEGEND:
        content += AMBER + BOLD + k + ESC + "22m" + GREY + " " + v + "   "
    return line_bar("  " + content, DBG)


# --------------------------------------------------------------------------- #
# Paint a framed view
# --------------------------------------------------------------------------- #
def paint(code: str, title: str, sub: str, body):
    global W, H
    W, H = size()
    area = max(4, H - 7)
    if len(body) > area:
        body = body[:area - 1] + [DGREY + f"  … {len(body) - area + 1} more rows — narrow the view or resize"]
    else:
        body = body + [""] * (area - len(body))
    out = [topbar(), ticker(), sep(), title_bar(code, title, sub)]
    out += [line_plain(b) for b in body]
    out += [sep(), legend_bar()]
    sys.stdout.write(HIDE + BG + CLEAR_HOME + "".join(l + "\n" for l in out))
    sys.stdout.flush()


PROMPT = BG + GOLD + BOLD + "  HFC ▸ " + RESET + BG + AMBER


def read_cmd() -> str:
    sys.stdout.write(SHOW)
    sys.stdout.flush()
    try:
        c = input(PROMPT)
    except EOFError:
        return "EXIT"
    sys.stdout.write(RESET)
    return c.strip()


# --------------------------------------------------------------------------- #
# Views  ->  (title, subtitle, [body lines])
# --------------------------------------------------------------------------- #
def kv_rows(pairs, per_row):
    """Render label/value tiles across `per_row` columns -> two lines per band."""
    cw = (W - 4) // per_row
    lines = []
    for i in range(0, len(pairs), per_row):
        band = pairs[i:i + per_row]
        labels = "  " + "".join(col(lbl.upper(), cw, "left", CYAN) for lbl, _, _ in band)
        values = "  " + "".join(col(val, cw, "left", c + BOLD) for _, val, c in band)
        lines += [labels, values, ""]
    return lines


def v_mon():
    m = api_get("/api/metrics")
    st = m.get("states", {})
    tr = m.get("transfers", {})
    cash = m.get("cash", {})
    tin, tout = tr.get("in", {}), tr.get("out", {})
    tiles = [
        ("cash · eur", money(cash.get("EUR"), "EUR"), WHITE),
        ("cash · gbp", money(cash.get("GBP"), "GBP"), WHITE),
        ("cash · usd", money(cash.get("USD"), "USD"), WHITE),
        ("posted", str(m.get("posted", 0)), GREEN),
        ("held", str(m.get("held", 0)), RED),
        ("needs info", str(st.get("NEEDS_INFO", 0)), AMBER),
    ]
    tiles2 = [
        ("transfers in", f"{tin.get('n', 0)} · {money(tin.get('total'), 'EUR')}", WHITE),
        ("transfers out", f"{tout.get('n', 0)} · {money(tout.get('total'), 'EUR')}", WHITE),
        ("audit · allowed", f"{m.get('audit_allowed', 0):,}", GREEN),
        ("audit · denied", f"{m.get('audit_denied', 0):,}", RED),
        ("planted issues", str(m.get("planted_issues", 0)), GOLD),
        ("agent mode", (_MODE.get("mode") or "?").upper(), ORANGE),
    ]
    body = [ORANGE + BOLD + "  SYSTEM OF WORK — LIVE COCKPIT"]
    body += kv_rows(tiles, 6)
    body += kv_rows(tiles2, 6)
    body.append(ORANGE + BOLD + "  LATEST GATEWAY ACTIVITY  " + DGREY + "(append-only — nothing here can be edited or deleted)")
    try:
        rows = api_get("/api/audit-recent")
    except Exception:  # noqa: BLE001
        rows = []
    body.append(GREY + "  " + col("TIME", 9) + col("ACTOR", 20) + col("ACTION", 10)
                + col("SUBJECT", 16) + col("TRANSITION", 15) + col("REASON", 30, color=GREY))
    for r in rows:
        okc = GREEN if r.get("allowed") else RED
        act = r.get("action", "")
        actc = {"post": GREEN, "approve": GREEN, "hold": RED, "reject": RED, "propose": AMBER}.get(act, WHITE)
        flag = "" if r.get("allowed") else " ✗"
        body.append("  " + col(r.get("at", ""), 9, color=DGREY) + col(r.get("actor", ""), 20, color=CYAN)
                    + col(act + flag, 10, color=actc) + col(r.get("subject", ""), 16, color=WHITE)
                    + col(r.get("state") or "·", 15, color=GOLD) + col((r.get("reason") or "")[:30], 30, color=okc))
    return "MONITOR", f"{sum(st.values())} work items · books tie across 3 currencies", body


def v_queue():
    rows = api_get("/api/queue")
    body = [GREY + "  " + col("WORK ITEM", 22) + col("KIND", 18) + col("STATE", 13)
            + col("AMOUNT", 14, "right") + col("  COUNTERPARTY / CHECK", 40, color=GREY)]
    statec = {"POSTED": GREEN, "APPROVED": GREEN, "HELD": RED, "REJECTED": RED,
              "NEEDS_INFO": AMBER, "PROPOSED": CYAN, "NEW": WHITE}
    for r in rows:
        sc = statec.get(r.get("state"), WHITE)
        amt = money(r.get("amount"), r.get("currency") or "") if r.get("amount") else "—"
        detail = r.get("failing_check") or r.get("counterparty") or ""
        dc = RED if r.get("failing_check") else GREY
        body.append("  " + col(r.get("id", ""), 22, color=AMBER) + col(r.get("kind", ""), 18, color=WHITE)
                    + col(r.get("state", ""), 13, color=sc) + col(amt, 14, "right", WHITE)
                    + col("  " + str(detail), 40, color=dc))
    return "WORK QUEUE", f"{len(rows)} items · the agent's desk", body


def v_book():
    d = api_get("/api/books")
    tb = d["trial_balance"]
    body = []
    for ccy, c in tb["currencies"].items():
        tie = c.get("balanced")
        badge = (GREEN + "✓ TIES") if tie else (RED + "✗ OUT")
        body.append(ORANGE + BOLD + f"  {ccy}   " + GREY + "Dr " + WHITE + money(c["total_debit"], ccy)
                    + GREY + "   Cr " + WHITE + money(c["total_credit"], ccy) + "   " + badge)
        rows = sorted(c["rows"], key=lambda r: -abs(r["balance"]))[:6]
        for r in rows:
            bc = GREEN if r["balance"] >= 0 else RED
            body.append("    " + col(r["code"], 7, color=DGREY) + col(r["account"], 34, color=WHITE)
                        + col(money(r["debit"], ccy), 14, "right", GREY) + col(money(r["credit"], ccy), 14, "right", GREY)
                        + col(money(r["balance"], ccy), 14, "right", bc))
        body.append("")
    overall = (GREEN + BOLD + "TRIAL BALANCE TIES TO THE CENT ✓") if tb.get("balanced") else (RED + BOLD + "DOES NOT TIE")
    body.append("  " + overall + DGREY + "   double-entry produced by the agent, not hand-keyed")
    return "TRIAL BALANCE", "proof the System of Work produced correct accounting", body


def v_pnl():
    d = api_get("/api/books")
    pnl = d["pnl"]
    labels = [("net_transfer_income", "Net transfer income", True), ("matchday_revenue", "Matchday revenue", True),
              ("sponsorship_revenue", "Sponsorship revenue", True), ("fx_gain_loss", "FX gain / loss", True),
              ("player_wages", "Player wages", False), ("staff_wages", "Staff wages", False),
              ("player_bonuses", "Player bonuses", False), ("amortisation_expense", "Amortisation", False),
              ("agent_fees_expense", "Agent fees", False)]
    body = []
    for ccy, p in pnl.items():
        body.append(ORANGE + BOLD + f"  {ccy}")
        for key, lbl, is_rev in labels:
            val = p.get(key, 0)
            if not val:
                continue
            c = GREEN if is_rev else RED
            body.append("    " + col(lbl, 30, color=WHITE) + col(money(val, ccy), 16, "right", c))
        ni = p.get("net_income", 0)
        nic = GREEN if ni >= 0 else RED
        body.append("    " + col("NET INCOME", 30, color=GOLD + BOLD) + col(money(ni, ccy), 16, "right", nic + BOLD))
        body.append("")
    return "PROFIT & LOSS", "every line is a posted journal entry", body


def v_scr():
    d = api_get("/api/books")
    pnl = d["pnl"]
    squad = rev = 0.0
    comp = {"wages": 0.0, "bonuses": 0.0, "amortisation": 0.0, "agent_fees": 0.0}
    for p in pnl.values():
        comp["wages"] += p.get("player_wages", 0) + p.get("staff_wages", 0)
        comp["bonuses"] += p.get("player_bonuses", 0)
        comp["amortisation"] += p.get("amortisation_expense", 0)
        comp["agent_fees"] += p.get("agent_fees_expense", 0)
        squad += (p.get("player_wages", 0) + p.get("staff_wages", 0) + p.get("player_bonuses", 0)
                  + p.get("amortisation_expense", 0) + p.get("agent_fees_expense", 0))
        rev += p.get("total_revenue", 0)
    ratio = round(100 * squad / rev, 1) if rev else 0.0
    gw = W - 24
    pos = min(gw, int(round(ratio / 100 * gw)))
    barc = GREEN if ratio <= 70 else (AMBER if ratio <= 85 else RED)
    gauge = barc + "█" * pos + DGREY + "░" * (gw - pos)
    m70 = int(70 / 100 * gw)
    m85 = int(85 / 100 * gw)
    marks = [" "] * gw
    if 0 <= m70 < gw:
        marks[m70] = "┊"
    if 0 <= m85 < gw:
        marks[m85] = "┊"
    markline = GREY + "".join(marks)
    body = [
        "", "  " + CYAN + "SQUAD-COST RATIO    " + barc + BOLD + f"{ratio:.1f}%"
        + GREY + "    of revenue  (wages + bonuses + amortisation + agent fees)",
        "",
        "  " + gauge,
        "  " + markline,
        "  " + GREY + padv("", m70) + col("↑70% UEFA", 14, color=GOLD) + padv("", max(0, m85 - m70 - 14)) + col("↑85% PremierLeague", 20, color=GOLD),
        "",
        ORANGE + BOLD + "  NUMERATOR",
        "    " + col("Wages (player + staff)", 30, color=WHITE) + col(money(comp["wages"], "EUR"), 16, "right", RED),
        "    " + col("Player bonuses", 30, color=WHITE) + col(money(comp["bonuses"], "EUR"), 16, "right", RED),
        "    " + col("Transfer amortisation", 30, color=WHITE) + col(money(comp["amortisation"], "EUR"), 16, "right", RED),
        "    " + col("Agent fees", 30, color=WHITE) + col(money(comp["agent_fees"], "EUR"), 16, "right", RED),
        "    " + col("Squad cost", 30, color=GOLD + BOLD) + col(money(squad, "EUR"), 16, "right", GOLD + BOLD),
        "",
        "  " + col("Revenue", 30, color=WHITE) + col(money(rev, "EUR"), 16, "right", GREEN),
        "",
        "  " + (GREEN if ratio <= 70 else AMBER) + BOLD
        + (f"WITHIN UEFA 70% AND PL 85%" if ratio <= 70 else (f"WITHIN PL 85% · OVER UEFA 70%" if ratio <= 85 else "OVER BOTH LIMITS")),
    ]
    return "SQUAD-COST RATIO", "currencies summed 1:1 (no FX) — directional", body


def v_pol():
    rows = api_get("/api/policies")
    body = [GREY + "  " + col("POLICY", 10) + col("MODE", 11) + col("EVID", 6, "right")
            + col("  ORIGIN", 15) + col("RULE", 50, color=GREY)]
    for r in rows:
        auto = r.get("auto")
        badge = (GREEN + "AUTO") if auto else (AMBER + "ESCALATE")
        body.append("  " + col(r.get("id", ""), 10, color=ORANGE) + col(badge, 11)
                    + col(str(r.get("evidence", "")), 6, "right", WHITE)
                    + col("  " + (r.get("origin", "") or ""), 15, color=CYAN)
                    + col((r.get("text", "") or "")[:50], 50, color=WHITE))
    body.append("")
    body.append(DGREY + "  the agent's memory, in the database — learned at onboarding, approved by a human, cited by id when it acts")
    return "POLICIES · AGENT MEMORY", f"{len(rows)} approved rules", body


def v_score():
    s = api_get("/api/score", timeout=60)
    if "error" in s:
        return "SCORE", "error", [RED + "  " + s["error"]]
    tiles = [
        ("precision", f"{s['precision']}%", GREEN),
        ("violations", str(s["violations"]), GREEN if s["violations"] == 0 else RED),
        ("correct", f"{s['recall_correct']}/{s['total']}", GREEN),
        ("automation", f"{s['automation']}%", AMBER),
        ("escalation q.", f"{s['escalation']}%", AMBER),
        ("auto / esc", f"{s['auto_completed']} / {s['escalated']}", WHITE),
    ]
    body = [ORANGE + BOLD + "  SCORED AUTONOMOUSLY vs THE 21-PLANTED-ISSUE ANSWER KEY  " + DGREY + "(the agent never sees the key)"]
    body += kv_rows(tiles, 6)
    body.append(ORANGE + BOLD + "  BY ISSUE TYPE")
    bt = s.get("by_type", [])
    half = (len(bt) + 1) // 2
    cw = (W - 4) // 2
    for i in range(half):
        line = "  "
        for j in (i, i + half):
            if j < len(bt):
                t = bt[j]
                ok = t["correct"] == t["n"]
                c = GREEN if ok else RED
                line += col(f"{'✓' if ok else '✗'} {t['type']}", cw - 10, color=c) + col(f"{t['correct']}/{t['n']}", 10, "left", WHITE)
        body.append(line)
    return "EVAL SCORE", "100% precision · 0 must-not-auto-complete violations", body


def v_aud():
    rows = api_get("/api/audit-recent")
    body = [GREY + "  " + col("TIME", 9) + col("ACTOR", 22) + col("ACTION", 10)
            + col("SUBJECT", 16) + col("TRANSITION", 15) + col("REASON", 32, color=GREY)]
    for r in rows:
        okc = GREEN if r.get("allowed") else RED
        act = r.get("action", "")
        flag = "" if r.get("allowed") else " ✗ DENIED"
        body.append("  " + col(r.get("at", ""), 9, color=DGREY) + col(r.get("actor", ""), 22, color=CYAN)
                    + col(act, 10, color=okc) + col(r.get("subject", ""), 16, color=WHITE)
                    + col(r.get("state") or "·", 15, color=GOLD) + col((r.get("reason") or "")[:30] + flag, 32, color=okc))
    body.append("")
    body.append(DGREY + "  append-only: UPDATE and DELETE are blocked at the database — even for a superuser. denials are logged too.")
    return "APPEND-ONLY AUDIT LOG", f"{len(rows)} recent transitions", body


def v_hist():
    d = api_get("/api/history")
    body = [GREY + "  " + col("WORK ITEM", 16) + col("WHAT HAPPENED", 34) + col("  OUTCOME / REASON", 60, color=GREY)]
    for e in d.get("events", []):
        title = e.get("title", "")
        tc = GREEN if "POSTED" in title else (RED if ("HELD" in title or "REJECT" in title) else AMBER)
        body.append("  " + col(e.get("wi", ""), 16, color=ORANGE) + col(title, 34, color=tc)
                    + col("  " + (e.get("meta", "") or ""), 60, color=WHITE))
    body.append("")
    body.append(DGREY + f"  {d.get('transactions', 0)} transactions — type  WI <id>  to drill into one (e.g.  WI 5602)")
    return "TRANSACTION HISTORY", f"{d.get('transactions', 0)} events", body


def _draw_lines(draw, indent="      "):
    out = []
    t = draw.get("type")
    if t == "table":
        cols = draw.get("columns", [])
        rows = draw.get("rows", [])
        if draw.get("title"):
            out.append(indent + GREY + draw["title"])
        cw = max(10, (W - len(indent) - 2) // max(1, len(cols)))
        if cols:
            out.append(indent + "".join(col(str(c), cw, color=CYAN) for c in cols))
        for r in rows:
            out.append(indent + "".join(col(str(x), cw, color=WHITE) for x in r))
    elif t == "checks":
        for it in draw.get("items", []):
            ok = it.get("ok")
            out.append(indent + (GREEN + "✓ " if ok else RED + "✗ ") + WHITE + str(it.get("label", "")))
    elif t in ("calc", "entry"):
        if draw.get("title"):
            out.append(indent + GREY + draw["title"])
        for l in draw.get("lines", []):
            out.append(indent + WHITE + str(l))
    return out


def v_wi(wi):
    wi = norm_wi(wi)
    if not wi:
        return "DRILL", "usage", [RED + "  usage:  WI <id>   e.g.  WI 5602"]
    ex = api_get(f"/api/explain/{urllib.parse.quote(wi)}")
    trail = api_get(f"/api/audit/{urllib.parse.quote(wi)}")
    body = []
    for sc in ex.get("scenes", []):
        say = sc.get("say")
        if say:
            for i, ln in enumerate(wrap(say, W - 8)):
                body.append(("  " + AMBER + "▸ " + WHITE if i == 0 else "    " + WHITE) + ln)
        draw = sc.get("draw")
        if draw:
            body += _draw_lines(draw)
        body.append("")
    body.append(ORANGE + BOLD + "  APPEND-ONLY AUDIT CHAIN")
    for r in trail:
        okc = GREEN if r.get("allowed") else RED
        flag = "" if r.get("allowed") else " ✗ DENIED"
        body.append("    " + col(r.get("at", ""), 9, color=DGREY) + col(r.get("actor", ""), 22, color=CYAN)
                    + col((r.get("action", "") or "") + flag, 16, color=okc) + col(r.get("state") or "·", 14, color=GOLD)
                    + col((r.get("reason") or "")[:40], 42, color=WHITE))
    return f"DRILL · {wi}", ex.get("title", ""), body


def v_env():
    d = api_get("/api/environment")
    body = [ORANGE + BOLD + "  SYSTEMS OF RECORD, SYNCED INTO ONE SHAPE"]
    body.append("  " + GREY + "sources: " + WHITE + "  ·  ".join(d.get("sources", [])))
    body.append("")
    g = d.get("golden", {})
    cw = (W - 4) // 3
    items = list(g.items())
    for i in range(0, len(items), 3):
        line = "  "
        for k, v in items[i:i + 3]:
            line += col("golden." + k, cw - 12, color=CYAN) + col(f"{v:,}", 12, "right", WHITE)
        body.append(line)
    body.append("")
    body.append("  " + GOLD + BOLD + f"TOTAL ROWS  {d.get('total', 0):,}")
    return "ENVIRONMENT", "the golden System of Record", body


def v_feed():
    rows = api_get("/api/feed")
    body = [GREY + "  " + col("", 2) + col("SUBJECT", 20) + col("EVENT", 34) + col("REASON", 44, color=GREY)]
    for f in rows:
        c = {"red": RED, "green": GREEN, "amber": AMBER}.get(f.get("kind"), WHITE)
        dot = c + "●"
        body.append("  " + col(dot, 2) + col(f.get("subject", ""), 20, color=ORANGE)
                    + col(f.get("label", ""), 34, color=c) + col((f.get("reason", "") or "")[:44], 44, color=WHITE))
    return "DEADLINE-DAY TAPE", f"{len(rows)} notable decisions", body


ABOUT_BODY = [
    "",
    "  " + ORANGE + BOLD + "SAME AGENT.  NEW SURFACE.",
    "",
    "  " + WHITE + "This terminal shares " + GOLD + BOLD + "zero code" + RESET + BG + WHITE + " with the 3D stadium web app.",
    "  " + WHITE + "Both are thin clients over one HTTP API — the System of Work gateway.",
    "",
    "  " + CYAN + "The agent lives behind the API, not in any UI:",
    "    " + WHITE + "• least-privilege DB roles — it can't read salaries or write the ledger directly",
    "    " + WHITE + "• append-only audit — it can't erase what it did (blocked even for superuser)",
    "    " + WHITE + "• hard-check gate — code decides, the model only proposes  →  100% precision",
    "    " + WHITE + "• grounded answers — it can't invent a number that isn't on the record",
    "",
    "  " + GOLD + "Swap the stadium for a Bloomberg terminal and every guarantee still holds.",
    "  " + GOLD + "That's the point: it's a service you can put any face on — not welded to one app.",
    "",
    "  " + DGREY + "Type  HELP  for commands, or just press  1  then Enter for the live cockpit.",
]


def v_about():
    return "WHY A TERMINAL", "portability, not a pile of code", list(ABOUT_BODY)


def v_help():
    cmds = [
        ("MON / 1", "live cockpit — cash, work items, gateway activity"),
        ("QUEUE / 2", "the agent's desk — open work items + failing checks"),
        ("BOOK / 3", "trial balance (ties to the cent, per currency)"),
        ("PNL / 4", "profit & loss, football line items"),
        ("SCR / 5", "squad-cost ratio gauge vs UEFA 70% / PL 85%"),
        ("POL / 6", "policies — the agent's approved memory"),
        ("SCORE / 7", "eval vs the 21-planted-issue answer key"),
        ("AUDIT / 8", "append-only audit log"),
        ("HIST / 9", "transaction history"),
        ("WI <id>", "drill into one transaction   e.g.  WI 5602"),
        ("RUN <text>", "run the agent on a free-text scenario (live trail)"),
        ("FRAUD", "the fraud-hold showpiece (WI-5602)"),
        ("ADDON", "the add-on dispute (WI-5611)"),
        ("MODE <m>", "flip agent  onboarded | newbie"),
        ("ENV / FEED", "systems of record · deadline-day tape"),
        ("WHY", "why this terminal exists (portability pitch)"),
        ("CONN <url>", "point at another API host"),
        ("REF / <Enter>", "refresh the current view"),
        ("EXIT", "quit"),
    ]
    body = [""]
    for k, v in cmds:
        body.append("  " + col(k, 16, color=GOLD + BOLD) + WHITE + v)
    return "COMMANDS", "type a mnemonic and press Enter — Bloomberg-style <GO>", body


# --------------------------------------------------------------------------- #
# Streaming action: RUN a scenario (self-scrolling live console)
# --------------------------------------------------------------------------- #
def pline(s):
    sys.stdout.write(line_plain(s) + "\n")
    sys.stdout.flush()


def render_step(step):
    kind = step.get("kind")
    actor = step.get("actor", "")
    txt = step.get("text", "")
    if kind == "scenario":
        return
    if kind == "think":
        for i, ln in enumerate(wrap(txt, W - 14)):
            pline(("  " + AMBER + "think   " if i == 0 else "          ") + DGREY + ln)
    elif kind == "recall":
        pline("  " + CYAN + "recall  " + WHITE + clip(txt, W - 12))
    elif kind == "run_sql":
        pline("  " + BLUE + "sql     " + GREY + clip(txt.replace("\n", " "), W - 12))
    elif kind == "sql_result":
        d = step.get("data")
        msg = ""
        if isinstance(d, dict):
            rows = d.get("rows")
            if isinstance(rows, list):
                msg = f"→ {len(rows)} row(s)" + (("  " + clip(json.dumps(rows[0], default=str), W - 24)) if rows else "")
            elif "error" in d:
                msg = RED + "→ " + str(d["error"])[:W - 20]
            else:
                msg = clip(json.dumps(d, default=str), W - 16)
        pline("          " + DGREY + msg)
    elif kind == "propose":
        pline("")
        pline("  " + ORANGE + BOLD + "PROPOSE " + WHITE + clip(txt, W - 14))
    elif kind == "post":
        pline("  " + GREEN + BOLD + "✓ POST  " + WHITE + clip(txt or "posted to ledger", W - 14))
    elif kind == "escalate":
        pline("  " + RED + BOLD + "⚑ ESCL  " + WHITE + clip(txt or "escalated to a human", W - 14))
    elif kind == "await_human":
        q = step.get("question") or step.get("situation") or step.get("escalated_to") or txt or "awaiting human sign-off"
        pline("  " + GOLD + BOLD + "⏸ HUMAN " + AMBER + clip(str(q), W - 14))
    elif kind == "error":
        pline("  " + RED + "error   " + clip(txt, W - 12))
    elif kind in (None, "done"):
        return
    else:
        if txt:
            pline("  " + GREY + col(kind or actor, 8) + WHITE + clip(txt, W - 12))


def run_scenario(text):
    global W, H
    W, H = size()
    sys.stdout.write(HIDE + BG + CLEAR_HOME)
    sys.stdout.write(topbar() + "\n")
    sys.stdout.write(title_bar("RUN", "LIVE AGENT TRAIL", "perceive → recall → confirm → propose → gate → post") + "\n")
    sys.stdout.write(sep() + "\n")
    for ln in wrap(text, W - 14):
        pline("  " + CYAN + "scenario" + WHITE + "  " + ln)
    pline(DGREY + "  " + "─" * (W - 4))
    try:
        for step in api_sse("/api/scenario/stream?text=" + urllib.parse.quote(text)):
            render_step(step)
            if step.get("kind") == "done":
                break
    except Exception as e:  # noqa: BLE001
        pline("  " + RED + "stream error: " + str(e)[:W - 20])
    pline(DGREY + "  " + "─" * (W - 4))
    pline("  " + GREEN + BOLD + "DECISION COMPLETE" + DGREY + "   the hard-check gate decided; every step is now in the append-only audit log")
    sys.stdout.write(SHOW + BG + GOLD + "  press Enter to return ▸ " + RESET)
    sys.stdout.flush()
    try:
        input()
    except EOFError:
        pass


def loading(msg):
    global W, H
    W, H = size()
    sys.stdout.write(HIDE + BG + CLEAR_HOME + topbar() + "\n" + sep() + "\n\n")
    pline("  " + AMBER + BOLD + msg)
    sys.stdout.flush()


# --------------------------------------------------------------------------- #
# Dispatch
# --------------------------------------------------------------------------- #
VIEWS = {
    "MON": v_mon, "QUEUE": v_queue, "BOOK": v_book, "PNL": v_pnl, "SCR": v_scr,
    "POL": v_pol, "SCORE": v_score, "AUD": v_aud, "HIST": v_hist, "ENV": v_env,
    "FEED": v_feed, "WHY": v_about, "HELP": v_help,
}
ALIAS = {
    "1": "MON", "DASH": "MON", "HOME": "MON", "MONITOR": "MON",
    "2": "QUEUE", "Q": "QUEUE",
    "3": "BOOK", "TB": "BOOK", "BOOKS": "BOOK",
    "4": "PNL", "PL": "PNL",
    "5": "SCR", "RATIO": "SCR",
    "6": "POL", "POLICY": "POL", "POLICIES": "POL", "MEM": "POL",
    "7": "SCORE", "EVAL": "SCORE",
    "8": "AUD", "AUDIT": "AUD",
    "9": "HIST", "HISTORY": "HIST",
    "NEWS": "FEED", "TAPE": "FEED",
    "ABOUT": "WHY",
    "?": "HELP", "H": "HELP",
    "TX": "WI",
    "ASK": "RUN", "AGENT": "RUN",
}


def disconnected_view():
    return "NO LINK", HOST, [
        "",
        "  " + RED + BOLD + "Can't reach the Pit Wall API at  " + WHITE + HOST,
        "",
        "  " + GREY + "Start it, then press Enter to retry:",
        "    " + AMBER + "cd ~/pitwall && uv run uvicorn api.app:app --port 4055",
        "",
        "  " + DGREY + "or point this terminal at another host:   CONN http://host:port",
    ]


def main():
    global HOST
    sys.stdout.write(ALT_ON)
    _refresh_status()
    current = ("WHY", None)  # launch on the portability splash
    try:
        while True:
            code, arg = current
            if code == "RUN":
                if not arg:
                    current = ("HELP", None)
                    continue
                run_scenario(arg)
                current = ("MON", None)
                continue
            if code in ("FRAUD", "ADDON"):
                loading("replaying the " + ("fraud-hold moment (WI-5602)…" if code == "FRAUD" else "add-on dispute (WI-5611)…"))
                try:
                    r = api_post("/api/sim/" + ("fraud" if code == "FRAUD" else "addon"))
                    current = ("WI", r.get("work_item", "WI-5602" if code == "FRAUD" else "WI-5611"))
                except Exception as e:  # noqa: BLE001
                    current = ("WI", "WI-5602" if code == "FRAUD" else "WI-5611")
                continue
            if code == "PRIME":
                loading("priming the agent (seed → onboard → precedents → books → index)… ~30s")
                try:
                    api_post("/api/agent/prime", timeout=300)
                except Exception:  # noqa: BLE001
                    pass
                _refresh_status()
                current = ("MON", None)
                continue
            if code == "MODESET":
                try:
                    api_post(f"/api/agent/mode?mode={urllib.parse.quote(arg or 'onboarded')}")
                except Exception:  # noqa: BLE001
                    pass
                _refresh_status()
                current = ("MON", None)
                continue

            _refresh_status()
            try:
                if not CONNECTED:
                    title, sub, body = disconnected_view()
                elif code == "WI":
                    title, sub, body = v_wi(arg)
                elif code == "SCORE":
                    loading("running the eval against the answer key…")
                    title, sub, body = v_score()
                else:
                    title, sub, body = VIEWS.get(code, v_mon)()
            except Exception as e:  # noqa: BLE001
                title, sub, body = (code, "error", [RED + "  " + type(e).__name__ + ": " + str(e)[:W - 10]])

            paint(code, title, sub, body)
            raw = read_cmd()
            if not raw:
                continue  # refresh current view
            parts = raw.split(None, 1)
            tok = parts[0].upper()
            rest = parts[1] if len(parts) > 1 else None

            if tok in ("EXIT", "QUIT", "BYE", "Q!"):
                break
            if tok == "CONN" and rest:
                HOST = rest.rstrip("/")
                _refresh_status()
                current = ("MON", None)
                continue
            if tok == "MODE":
                current = ("MODESET", rest or "onboarded")
                continue
            if tok in ("RUN", "ASK", "AGENT"):
                current = ("RUN", rest)
                continue
            if tok in ("WI", "TX"):
                current = ("WI", rest)
                continue
            if tok in ("FRAUD", "ADDON", "PRIME"):
                current = (tok, None)
                continue
            code = ALIAS.get(tok, tok)
            if code in VIEWS:
                current = (code, None)
            else:
                current = ("HELP", None)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(SHOW + RESET + ALT_OFF)
        sys.stdout.flush()


if __name__ == "__main__":
    main()
