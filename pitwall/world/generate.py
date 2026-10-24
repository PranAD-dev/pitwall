"""Deterministic (seeded) ~24-month simulation of Harbourside FC + an answer key
of planted issues. One command (`make reset`) rebuilds this exactly.

Design: a base random world for realism/volume, then explicit *scenario* entities
with hand-set values so every planted issue has a known-correct expected action.
Run with no_db=True to validate generation logic without a database."""

from __future__ import annotations

import json
import random
from bisect import bisect_right
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from psycopg.types.json import Json
from rich.console import Console
from rich.table import Table

from ..config import get_settings
from ..db import connect
from ..ids import raw_ref

console = Console()
OUT_DIR = Path(__file__).resolve().parents[2] / "world" / "out"

# --------------------------------------------------------------------------- #
# Timeline & constants
# --------------------------------------------------------------------------- #
WORLD_START = date(2024, 7, 1)
WORLD_END = date(2026, 6, 30)
SIM_NOW = date(2026, 5, 1)  # the demo "today"; installments due before this are paid
HOME_CCY = "GBP"
ACCOUNTS = {"GBP": "MAIN-GBP", "EUR": "MAIN-EUR", "USD": "MAIN-USD"}
SOLIDARITY_PCT = 0.05
APPROVAL_THRESHOLD = 250_000  # mirrors PITWALL_APPROVAL_THRESHOLD_USDC default

# Expected-action vocabulary (what the answer key asserts Pit Wall should do).
A = {
    "hold_fraud": "HOLD_BUY_EVIDENCE_ESCALATE_CFO",
    "complete_after_evidence": "COMPLETE_AFTER_EVIDENCE",
    "reject": "REJECT_WITH_CLAUSE_AND_MATCH_IDS",
    "propose_accrual": "PROPOSE_ACCRUAL_LIABILITY",
    "complete_solidarity": "COMPLETE_DO_NOT_CHASE",
    "chase": "CHASE_OR_ESCALATE",
    "split": "SPLIT_ONE_TO_MANY",
    "reject_dup": "REJECT_DUPLICATE",
    "escalate_threshold": "ESCALATE_THRESHOLD_EVASION",
    "propose_fx": "PROPOSE_FX_GAIN_LOSS",
    "escalate_sellon": "ESCALATE_AMBIGUOUS_DO_NOT_GUESS",
    "propose_amort": "PROPOSE_AMORTIZATION_ADJUSTMENT",
}

# Name pools (fictional; no real clubs/leagues).
CITY = ["Montara", "Keldby", "Varholm", "Sundby", "Aldermoor", "Riverton", "Oststrand",
        "Northgate", "Valebridge", "Skyline", "Old Harbor", "Chase", "Greymoor", "Fenwick",
        "Portvale", "Westcliff", "Brackenford", "Dunmore", "Larkspur", "Eastmere"]
CLUB_SUFFIX = ["FC", "United", "City", "Athletic", "SC", "Rovers", "CF"]
COUNTRY_CCY = {"England": "GBP", "Spain": "EUR", "Germany": "EUR", "France": "EUR",
               "Italy": "EUR", "Portugal": "EUR", "Netherlands": "EUR", "USA": "USD"}
COUNTRY_TLD = {"England": "co.uk", "Spain": "es", "Germany": "de", "France": "fr",
               "Italy": "it", "Portugal": "pt", "Netherlands": "nl", "USA": "com"}
AGENCY = ["Vertex Sports Mgmt", "Meridian Football Partners", "Apex Football Agents",
          "Northwind Talent", "Lodestar Representation", "Cobalt Player Mgmt",
          "Equinox Sports Group", "Harrow & Finch"]
SPONSOR = ["Harbour Bank", "Aerial Airways", "Voltic Energy", "Kappline Sportswear",
           "Northwind Telecom", "Golden Lager"]
VENDOR = ["Pitch Perfect Grounds", "MediScan Physio", "TravelEase Logistics", "LegalKraft LLP"]
FIRST = ["Luka", "Mateo", "Diego", "Noah", "Elias", "Omar", "Kai", "Finn", "Hugo", "Samir",
         "Niko", "Theo", "Marco", "Ivan", "Yusuf", "Rafael", "Soren", "Bruno", "Jonas", "Andre",
         "Milan", "Victor", "Oscar", "Lars", "Emre", "Pavel", "Dario", "Felix"]
LAST = ["Haaland-ish", "Vostok", "Marin", "Keller", "Okafor", "Lindqvist", "Dubois", "Rossi",
        "Novak", "Demir", "Costa", "Bauer", "Jansen", "Petrov", "Moreau", "Silva", "Horvat",
        "Fischer", "Larsen", "Mendez", "Varga", "Nielsen", "Kovac", "Weiss", "Falk", "Reed"]
POS = ["GK", "CB", "RB", "LB", "DM", "CM", "AM", "RW", "LW", "ST"]


def ts(d: date, hour: int = 12) -> datetime:
    return datetime.combine(d, time(hour, 0), tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# Buffer schema
# --------------------------------------------------------------------------- #
COLUMNS = {
    "raw.raw_record": ["raw_ref", "source", "src_id", "payload"],
    "golden.counterparty": ["id", "name", "kind", "country", "verified_iban",
                            "iban_last_changed_at", "email_domain", "raw_ref"],
    "golden.player": ["id", "name", "position", "dob", "nationality", "raw_ref"],
    "golden.transfer": ["id", "player_id", "direction", "counterparty_id", "fee", "currency",
                        "signed_at", "contract_years", "amortization_months",
                        "solidarity_applicable", "sell_on_pct", "sell_on_basis", "status",
                        "raw_ref"],
    "golden.installment": ["id", "transfer_id", "seq", "due_date", "amount", "currency",
                           "status", "paid_txn_id", "raw_ref"],
    "golden.contract_clause": ["id", "contract_type", "contract_id", "kind", "params",
                               "competitions_counted", "ambiguity_note", "raw_ref"],
    "golden.invoice": ["id", "counterparty_id", "amount", "currency", "claims_clause_id",
                       "transfer_id", "issued_at", "number", "kind", "status", "raw_ref"],
    "golden.inbox_message": ["id", "received_at", "from_name", "from_domain", "subject", "body",
                             "counterparty_id", "claims_new_iban", "about_installment_id",
                             "raw_ref"],
    "golden.period": ["id", "start_date", "end_date", "status"],
    "golden.historical_outcome": ["id", "at", "situation", "subject_refs", "handled_as",
                                  "actor", "raw_ref"],
    "golden.bank_transaction": ["id", "source", "account", "txn_time", "amount", "currency",
                                "memo", "counterparty_iban", "direction",
                                "matched_installment_id", "raw_ref"],
    "golden.match_event": ["id", "match_id", "competition", "player_id", "event_time", "kind",
                           "value", "season", "raw_ref"],
    "golden.fx_rate": ["pair", "at", "rate"],
    "payroll_private.salary": ["player_id", "base_wage", "currency", "bonuses"],
}
JSON_COLS = {
    "raw.raw_record.payload", "golden.contract_clause.params",
    "golden.historical_outcome.subject_refs", "golden.historical_outcome.handled_as",
    "payroll_private.salary.bonuses",
}
# order matters for FK integrity on insert
INSERT_ORDER = [
    "raw.raw_record", "golden.period", "golden.counterparty", "golden.player",
    "payroll_private.salary", "golden.transfer", "golden.installment",
    "golden.contract_clause", "golden.invoice", "golden.inbox_message",
    "golden.historical_outcome", "golden.fx_rate", "golden.bank_transaction",
    "golden.match_event",
]


class World:
    def __init__(self, rng: random.Random, scale: str):
        self.rng = rng
        self.scale = scale
        self.buf: dict[str, list[tuple]] = defaultdict(list)
        self.answer_key: list[dict] = []
        # iban -> {owner, status}: the deterministic truth the M3 bank-verify
        # seller returns. Seeded with every verified iban; planters add the fraud
        # (mismatch) and legitimate-change (match) ibans.
        self.seller_bank_truth: dict[str, dict] = {}
        self._seen_raw: set[str] = set()
        self._fx: dict[str, list[tuple[date, float]]] = {}

    def land(self, source: str, src_id: str, payload: dict) -> str:
        ref = raw_ref(source, src_id)
        if ref not in self._seen_raw:
            self._seen_raw.add(ref)
            self.add("raw.raw_record", raw_ref=ref, source=source, src_id=src_id, payload=payload)
        return ref

    def add(self, table: str, **vals) -> None:
        row = []
        for col in COLUMNS[table]:
            v = vals.get(col)
            if f"{table}.{col}" in JSON_COLS and v is not None:
                v = Json(v)
            row.append(v)
        self.buf[table].append(tuple(row))

    def plant(self, **entry) -> None:
        self.answer_key.append(entry)

    # --- fx -----------------------------------------------------------------
    def build_fx(self) -> None:
        bases = {"EURGBP": 0.85, "USDGBP": 0.78, "EURUSD": 1.09}
        for pair, base in bases.items():
            rate = base
            series: list[tuple[date, float]] = []
            d = WORLD_START
            while d <= WORLD_END:
                rate = max(0.3, rate * (1 + self.rng.uniform(-0.012, 0.012)))
                series.append((d, round(rate, 6)))
                self.add("golden.fx_rate", pair=pair, at=ts(d), rate=round(rate, 6))
                d += timedelta(days=7)
            self._fx[pair] = series

    def fx_at(self, ccy: str, d: date) -> float:
        if ccy == HOME_CCY:
            return 1.0
        pair = f"{ccy}GBP"
        series = self._fx[pair]
        dates = [x[0] for x in series]
        i = bisect_right(dates, d) - 1
        return series[max(0, i)][1]


# --------------------------------------------------------------------------- #
# Base world (volume + realism)
# --------------------------------------------------------------------------- #
def _periods(w: World) -> None:
    d = date(WORLD_START.year, WORLD_START.month, 1)
    while d <= WORLD_END:
        nxt = date(d.year + (d.month // 12), (d.month % 12) + 1, 1)
        end = nxt - timedelta(days=1)
        pid = f"{d.year}-{d.month:02d}"
        status = "closed" if end < date(2026, 4, 1) else "open"
        w.add("golden.period", id=pid, start_date=d, end_date=end, status=status)
        d = nxt


def _mk_counterparty(w: World, cid, name, kind, country, iban_changed=None, domain=None):
    ccy = COUNTRY_CCY.get(country, "EUR")
    iban = f"{country[:2].upper()}{abs(hash(cid)) % 10**16:016d}"
    dom = domain or (name.lower().replace(" ", "").replace("&", "and")[:18] + "." + COUNTRY_TLD.get(country, "com"))
    ref = w.land("contracts", f"cp:{cid}", {"name": name, "kind": kind, "country": country})
    w.add("golden.counterparty", id=cid, name=name, kind=kind, country=country,
          verified_iban=iban, iban_last_changed_at=ts(iban_changed) if iban_changed else None,
          email_domain=dom, raw_ref=ref)
    w.seller_bank_truth[iban] = {"owner": name, "status": "match"}
    return {"id": cid, "name": name, "iban": iban, "domain": dom, "country": country, "ccy": ccy}


def _base_counterparties(w: World) -> dict[str, dict]:
    cps: dict[str, dict] = {}
    countries = list(COUNTRY_CCY.keys())
    n = 0
    for suffix in CLUB_SUFFIX:
        for city in CITY[:3]:
            n += 1
            cid = f"cp-club-{n:03d}"
            country = countries[n % len(countries)]
            cps[cid] = _mk_counterparty(w, cid, f"{city} {suffix}", "club", country,
                                        iban_changed=WORLD_START - timedelta(days=400 + n))
            if n >= 16:
                break
        if n >= 16:
            break
    for i, a in enumerate(AGENCY, 1):
        cid = f"cp-agent-{i:03d}"
        cps[cid] = _mk_counterparty(w, cid, a, "agent", "England")
    for i, s in enumerate(SPONSOR, 1):
        cid = f"cp-spon-{i:03d}"
        cps[cid] = _mk_counterparty(w, cid, s, "sponsor", "England")
    for i, v in enumerate(VENDOR, 1):
        cid = f"cp-vend-{i:03d}"
        cps[cid] = _mk_counterparty(w, cid, v, "vendor", "England")
    return cps


def _roster(w: World) -> list[str]:
    ids = []
    for i in range(1, 23):
        pid = f"pl-{i:03d}"
        name = f"{w.rng.choice(FIRST)} {w.rng.choice(LAST)}"
        ref = w.land("contracts", f"pl:{pid}", {"name": name})
        w.add("golden.player", id=pid, name=name, position=w.rng.choice(POS),
              dob=date(1995 + i % 10, 1 + i % 12, 1 + i % 28), nationality="Fictionland", raw_ref=ref)
        w.add("payroll_private.salary", player_id=pid,
              base_wage=w.rng.randint(8_000, 90_000) * 52, currency=HOME_CCY,
              bonuses={"appearance": w.rng.randint(1_000, 8_000)})
        ids.append(pid)
    return ids


SEASONS = {"2024/25": (date(2024, 8, 10), date(2025, 5, 20)),
           "2025/26": (date(2025, 8, 9), date(2026, 5, 17))}


def _match_events(w: World, players: list[str], forced: dict | None = None) -> None:
    """Baseline appearances/goals/minutes for roster players across two seasons.
    `forced` maps player_id -> {season: {'league': n, 'cup': n, 'europe': n}} to pin counts."""
    forced = forced or {}
    for pid in players:
        for season, (s_start, s_end) in SEASONS.items():
            pin = forced.get(pid, {}).get(season)
            counts = pin or {"league": w.rng.randint(6, 34), "cup": w.rng.randint(0, 6),
                             "europe": w.rng.randint(0, 8)}
            for comp, n in counts.items():
                span = (s_end - s_start).days or 1
                for k in range(n):
                    md = s_start + timedelta(days=int(span * (k + 0.5) / max(n, 1)))
                    mid = f"m-{season[:4]}-{comp}-{k:02d}"
                    base = f"{pid}:{season}:{comp}:{k}"
                    w.add("golden.match_event", id=f"me-app-{raw_ref('m', base)[:10]}", match_id=mid,
                          competition=comp, player_id=pid, event_time=ts(md, 20), kind="appearance",
                          value=1, season=season, raw_ref=w.land("matchdata", "app:" + base, {"c": comp}))
                    w.add("golden.match_event", id=f"me-min-{raw_ref('m', base)[:10]}", match_id=mid,
                          competition=comp, player_id=pid, event_time=ts(md, 20), kind="minutes",
                          value=w.rng.choice([90, 90, 75, 62, 20]), season=season,
                          raw_ref=w.land("matchdata", "min:" + base, {}))
                    if w.rng.random() < 0.18:
                        w.add("golden.match_event", id=f"me-goal-{raw_ref('m', base)[:10]}",
                              match_id=mid, competition=comp, player_id=pid, event_time=ts(md, 20),
                              kind="goal", value=1, season=season,
                              raw_ref=w.land("matchdata", "goal:" + base, {}))


def _routine_invoices(w: World, cps: dict[str, dict]) -> None:
    """Padding: monthly agent retainers + vendor invoices across the timeline."""
    billers = [c for cid, c in cps.items() if cid.startswith(("cp-agent", "cp-vend"))]
    inv = 0
    d = WORLD_START
    while d <= SIM_NOW:
        for c in billers:
            if w.rng.random() < 0.6:
                inv += 1
                amt = w.rng.randint(2_000, 40_000)
                num = f"{c['id'][-3:]}-{d.year}{d.month:02d}-{inv:04d}"
                ref = w.land("inbox", f"inv:{c['id']}:{num}", {"amt": amt})
                w.add("golden.invoice", id=f"inv-{inv:05d}", counterparty_id=c["id"], amount=amt,
                      currency=HOME_CCY, claims_clause_id=None, transfer_id=None, issued_at=ts(d),
                      number=num, kind="agent_fee" if "agent" in c["id"] else "other",
                      status="paid" if d < SIM_NOW - timedelta(days=30) else "received", raw_ref=ref)
        d = date(d.year + (d.month // 12), (d.month % 12) + 1, 1)


# --------------------------------------------------------------------------- #
# Helpers for scenario builders
# --------------------------------------------------------------------------- #
def _installments(w: World, tr_id, fee, ccy, signed: date, n: int, paid_cutoff=SIM_NOW,
                  short=None, combined_skip=False):
    """Create n installments; emit bank txns for ones due before paid_cutoff.
    `short` = (seq, fraction, memo) to pay one installment short. Returns list of dicts."""
    out = []
    per = round(fee / n, 2)
    amounts = [per] * n
    amounts[0] = round(fee - per * (n - 1), 2)
    for seq in range(1, n + 1):
        due = signed + timedelta(days=60 + (seq - 1) * 365)
        iid = f"{tr_id}-i{seq}"
        amt = amounts[seq - 1]
        ref = w.land("contracts", f"inst:{iid}", {"fee": fee})
        paid = due < paid_cutoff
        status = "paid" if paid else "scheduled"
        out.append({"id": iid, "seq": seq, "due": due, "amount": amt, "ccy": ccy,
                    "status": status, "paid": paid})
        w.add("golden.installment", id=iid, transfer_id=tr_id, seq=seq, due_date=due, amount=amt,
              currency=ccy, status=status, paid_txn_id=None, raw_ref=ref)
    return out


def _bank(w: World, bid, acct_ccy, when: date, amount, memo, iban, direction, matched=None):
    ref = w.land("bank", f"btx:{bid}", {"memo": memo})
    w.add("golden.bank_transaction", id=bid, source="bank", account=ACCOUNTS[acct_ccy],
          txn_time=ts(when, 9), amount=amount, currency=acct_ccy, memo=memo, counterparty_iban=iban,
          direction=direction, matched_installment_id=matched, raw_ref=ref)


def _transfer(w: World, tr_id, player_id, direction, cp, fee, ccy, signed: date, years,
              sell_on_pct=None, sell_on_basis=None, amort_override=None):
    ref = w.land("contracts", f"tr:{tr_id}", {"fee": fee, "ccy": ccy})
    w.add("golden.transfer", id=tr_id, player_id=player_id, direction=direction,
          counterparty_id=cp["id"], fee=fee, currency=ccy, signed_at=ts(signed),
          contract_years=years, amortization_months=amort_override or years * 12,
          solidarity_applicable=(direction == "out" and cp["country"] != "England"),
          sell_on_pct=sell_on_pct, sell_on_basis=sell_on_basis, status="active", raw_ref=ref)


def _scenario_player(w: World, pid, name=None):
    name = name or f"{w.rng.choice(FIRST)} {w.rng.choice(LAST)}"
    ref = w.land("contracts", f"pl:{pid}", {"name": name})
    w.add("golden.player", id=pid, name=name, position=w.rng.choice(POS),
          dob=date(1998, 3, 11), nationality="Fictionland", raw_ref=ref)
    w.add("payroll_private.salary", player_id=pid, base_wage=1_500_000, currency=HOME_CCY,
          bonuses={"appearance": 5000})
    return pid


def _inst(w, iid, tr_id, seq, due, amount, ccy, status, paid_txn=None):
    ref = w.land("contracts", f"inst:{iid}", {"amt": amount})
    w.add("golden.installment", id=iid, transfer_id=tr_id, seq=seq, due_date=due, amount=amount,
          currency=ccy, status=status, paid_txn_id=paid_txn, raw_ref=ref)


def _clause(w, clid, ctype, contract_id, kind, params, comps=None, ambiguity=None):
    ref = w.land("contracts", f"clause:{clid}", params)
    w.add("golden.contract_clause", id=clid, contract_type=ctype, contract_id=contract_id,
          kind=kind, params=params, competitions_counted=comps, ambiguity_note=ambiguity, raw_ref=ref)


def _invoice(w, iid, cp_id, amount, ccy, issued, number, kind, claims_clause=None, transfer=None,
             status="received"):
    ref = w.land("inbox", f"inv:{iid}", {"n": number, "amt": amount})
    w.add("golden.invoice", id=iid, counterparty_id=cp_id, amount=amount, currency=ccy,
          claims_clause_id=claims_clause, transfer_id=transfer, issued_at=ts(issued), number=number,
          kind=kind, status=status, raw_ref=ref)


def _inbox(w, mid, received, cp, subject, body, claimed_iban, about_inst, from_domain):
    ref = w.land("inbox", f"msg:{mid}", {"subject": subject})
    w.add("golden.inbox_message", id=mid, received_at=ts(received), from_name=cp["name"],
          from_domain=from_domain, subject=subject, body=body, counterparty_id=cp["id"],
          claims_new_iban=claimed_iban, about_installment_id=about_inst, raw_ref=ref)


# --------------------------------------------------------------------------- #
# Planters — each creates entities AND the matching answer-key entry
# --------------------------------------------------------------------------- #
def planter_fraud(w: World, sc: dict) -> None:
    fraud = [("northgate", "northgate-rangers.fr", 11_000_000),
             ("fenwick", "fenwlck.it", 8_500_000),
             ("portvale", "portvaie.pt", 9_750_000)]
    for k, (key, look, fee) in enumerate(fraud, 1):
        cp = sc[key]
        pid = _scenario_player(w, f"pl-fr-{k}")
        tr = f"tr-in-fr-{k}"
        _transfer(w, tr, pid, "in", cp, fee, "EUR", date(2024, 9, 1), 4)
        per = round(fee / 4, 2)
        for s, dd in enumerate([date(2024, 11, 1), date(2025, 5, 1), date(2025, 11, 1)], start=1):
            bid = f"btx-fr-{k}-{s}"
            _bank(w, bid, "EUR", dd + timedelta(days=2), -per,
                  f"Transfer installment {s}/4 {cp['name']}", cp["iban"], "out", matched=f"{tr}-i{s}")
            _inst(w, f"{tr}-i{s}", tr, s, dd, per, "EUR", "paid", paid_txn=bid)
        _inst(w, f"{tr}-i4", tr, 4, date(2026, 5, 8), round(fee - per * 3, 2), "EUR", "scheduled")
        fake = f"XX{abs(hash(tr)) % 10**16:016d}"
        w.seller_bank_truth[fake] = {"owner": "NAME MISMATCH / UNVERIFIED", "status": "mismatch"}
        mid = f"msg-fr-{k}"
        _inbox(w, mid, date(2026, 5, 5), cp, "Updated bank details for upcoming payment",
               "Our bank account has changed; please remit the next installment to the IBAN below.",
               fake, f"{tr}-i4", look)
        w.plant(issue_id=f"fraud-{k}", type="fake_bank_detail_change",
                subject_refs={"installment_id": f"{tr}-i4", "inbox_id": mid, "counterparty_id": cp["id"],
                              "claimed_iban": fake, "verified_iban": cp["iban"], "lookalike_domain": look,
                              "legit_domain": cp["domain"], "prior_installments_to_verified": 3},
                expected_action=A["hold_fraud"], must_not_auto_complete=True,
                note="Lookalike domain; 3 prior payments to verified IBAN; change <72h before due. "
                     "Buy bank check -> mismatch -> HOLD -> escalate CFO.")
    # legitimate change — must NOT be over-blocked
    cp = sc["skyline"]
    pid = _scenario_player(w, "pl-fr-legit")
    tr = "tr-in-fr-legit"
    fee = 7_200_000
    _transfer(w, tr, pid, "in", cp, fee, "EUR", date(2024, 9, 1), 3)
    per = round(fee / 3, 2)
    _bank(w, "btx-fr-legit-1", "EUR", date(2024, 11, 3), -per, f"Installment 1/3 {cp['name']}",
          cp["iban"], "out", matched=f"{tr}-i1")
    _inst(w, f"{tr}-i1", tr, 1, date(2024, 11, 1), per, "EUR", "paid", paid_txn="btx-fr-legit-1")
    _inst(w, f"{tr}-i2", tr, 2, date(2026, 5, 20), per, "EUR", "scheduled")
    legit = f"DE{abs(hash('skyline-new')) % 10**16:016d}"
    w.seller_bank_truth[legit] = {"owner": cp["name"], "status": "match"}
    _inbox(w, "msg-fr-legit", date(2026, 4, 15), cp, "Bank account update ahead of next installment",
           "Following our treasury migration, future payments should go to the account below.",
           legit, f"{tr}-i2", cp["domain"])
    w.plant(issue_id="fraud-legit-1", type="legitimate_bank_detail_change",
            subject_refs={"installment_id": f"{tr}-i2", "inbox_id": "msg-fr-legit",
                          "counterparty_id": cp["id"], "claimed_iban": legit,
                          "verified_iban": cp["iban"], "from_domain": cp["domain"]},
            expected_action=A["complete_after_evidence"], must_not_auto_complete=False,
            note="Change from the REAL domain, >72h before due. Buy bank check -> owner matches. "
                 "Complete after evidence; do not over-block.")


def planter_addons(w: World, sc: dict) -> None:
    # triggered but never booked
    cp = sc["realvista"]
    pid = _scenario_player(w, "pl-rv")
    tr = "tr-in-rv"
    _transfer(w, tr, pid, "in", cp, 14_000_000, "EUR", date(2024, 8, 20), 4)
    _inst(w, f"{tr}-i1", tr, 1, date(2024, 10, 20), 3_500_000, "EUR", "paid")
    _clause(w, "cl-rv-addon", "transfer", tr, "addon_appearances",
            {"threshold": 25, "fee": 600000, "currency": "EUR"}, comps=["league"])
    _match_events(w, [pid], forced={pid: {"2024/25": {"league": 0, "cup": 0, "europe": 0},
                                          "2025/26": {"league": 25, "cup": 2, "europe": 0}}})
    w.plant(issue_id="addon-trig-1", type="addon_triggered_not_booked",
            subject_refs={"transfer_id": tr, "clause_id": "cl-rv-addon", "player_id": pid,
                          "threshold": 25, "observed_league": 25, "addon_amount": 600000,
                          "currency": "EUR"},
            expected_action=A["propose_accrual"], must_not_auto_complete=True,
            note="Player reached 25 league apps; liability not booked. Propose accrual when it triggers.")
    # invoiced but not triggered (25th was an excluded cup game)
    cp = sc["montara"]
    pid = _scenario_player(w, "pl-mo")
    tr = "tr-in-mo"
    _transfer(w, tr, pid, "in", cp, 9_000_000, "EUR", date(2024, 8, 22), 4)
    _inst(w, f"{tr}-i1", tr, 1, date(2024, 10, 22), 2_250_000, "EUR", "paid")
    _clause(w, "cl-mo-addon", "transfer", tr, "addon_appearances",
            {"threshold": 25, "fee": 500000, "currency": "EUR"}, comps=["league"])
    _match_events(w, [pid], forced={pid: {"2024/25": {"league": 0, "cup": 0, "europe": 0},
                                          "2025/26": {"league": 24, "cup": 3, "europe": 0}}})
    _invoice(w, "inv-addon-mo", cp["id"], 500000, "EUR", date(2026, 4, 2), "MC-2026-0442",
             "addon", claims_clause="cl-mo-addon", transfer=tr)
    w.plant(issue_id="addon-false-1", type="addon_invoiced_not_triggered",
            subject_refs={"invoice_id": "inv-addon-mo", "clause_id": "cl-mo-addon", "player_id": pid,
                          "threshold": 25, "observed_league": 24, "observed_cup": 3,
                          "competitions_counted": ["league"]},
            expected_action=A["reject"], must_not_auto_complete=False,
            note="Claims a 25-appearance add-on; only 24 league (the 25th was an excluded cup game). "
                 "Reject citing clause + match ids.")
    # second invoiced-not-triggered
    cp = sc["valebridge"]
    pid = _scenario_player(w, "pl-vb")
    tr = "tr-in-vb"
    _transfer(w, tr, pid, "in", cp, 6_500_000, "GBP", date(2024, 8, 25), 3)
    _inst(w, f"{tr}-i1", tr, 1, date(2024, 10, 25), 2_166_666.67, "GBP", "paid")
    _clause(w, "cl-vb-addon", "transfer", tr, "addon_appearances",
            {"threshold": 20, "fee": 350000, "currency": "GBP"}, comps=["league"])
    _match_events(w, [pid], forced={pid: {"2024/25": {"league": 0, "cup": 0, "europe": 0},
                                          "2025/26": {"league": 18, "cup": 4, "europe": 0}}})
    _invoice(w, "inv-addon-vb", cp["id"], 350000, "GBP", date(2026, 4, 3), "VB/26/118",
             "addon", claims_clause="cl-vb-addon", transfer=tr)
    w.plant(issue_id="addon-false-2", type="addon_invoiced_not_triggered",
            subject_refs={"invoice_id": "inv-addon-vb", "clause_id": "cl-vb-addon", "player_id": pid,
                          "threshold": 20, "observed_league": 18, "observed_cup": 4,
                          "competitions_counted": ["league"]},
            expected_action=A["reject"], must_not_auto_complete=False,
            note="20-appearance add-on claimed; only 18 league appearances. Reject.")


def planter_solidarity(w: World, sc: dict) -> None:
    for k, (key, fee, ccy) in enumerate([("chase", 22_000_000, "USD"),
                                         ("brackenford", 15_000_000, "EUR"),
                                         ("dunmore", 12_500_000, "EUR")], 1):
        cp = sc[key]
        pid = _scenario_player(w, f"pl-sol-{k}")
        tr = f"tr-out-sol-{k}"
        _transfer(w, tr, pid, "out", cp, fee, ccy, date(2024, 7, 15), 3)
        per = round(fee / 3, 2)
        due = date(2025, 9, 15)
        _inst(w, f"{tr}-i1", tr, 1, due, per, ccy, "invoiced")
        recv = round(per * (1 - SOLIDARITY_PCT), 2)
        bid = f"btx-sol-{k}"
        _bank(w, bid, ccy, due + timedelta(days=3), recv,
              f"Transfer fee {cp['name']} less solidarity 5%", cp["iban"], "in")
        w.plant(issue_id=f"solidarity-{k}", type="incoming_short_solidarity",
                subject_refs={"installment_id": f"{tr}-i1", "txn_id": bid, "expected": per,
                              "received": recv, "currency": ccy, "shortfall_pct": 5,
                              "solidarity_applicable": True},
                expected_action=A["complete_solidarity"], must_not_auto_complete=False,
                note="International sale: 5% solidarity withheld, arrives short legitimately. "
                     "Book to solidarity receivable; do NOT chase.")


def planter_unexplained_short(w: World, sc: dict) -> None:
    for k, (key, fee, ccy, short) in enumerate([("westcliff", 9_000_000, "GBP", 0.08),
                                                ("greymoor", 7_500_000, "GBP", 0.11)], 1):
        cp = sc[key]
        pid = _scenario_player(w, f"pl-uns-{k}")
        tr = f"tr-out-uns-{k}"
        _transfer(w, tr, pid, "out", cp, fee, ccy, date(2024, 7, 20), 3)
        per = round(fee / 3, 2)
        due = date(2025, 10, 1)
        _inst(w, f"{tr}-i1", tr, 1, due, per, ccy, "invoiced")
        recv = round(per * (1 - short), 2)
        bid = f"btx-uns-{k}"
        _bank(w, bid, ccy, due + timedelta(days=5), recv, f"Payment {cp['name']}", cp["iban"], "in")
        w.plant(issue_id=f"short-unexplained-{k}", type="incoming_short_unexplained",
                subject_refs={"installment_id": f"{tr}-i1", "txn_id": bid, "expected": per,
                              "received": recv, "currency": ccy, "shortfall_pct": round(short * 100, 1),
                              "solidarity_applicable": False},
                expected_action=A["chase"], must_not_auto_complete=True,
                note="Domestic (no solidarity) sale arrives short with no explanation. "
                     "Chase / escalate; do not auto-complete.")


def planter_combined_wire(w: World, sc: dict) -> None:
    for k, (key, fee, ccy) in enumerate([("dunmore", 10_000_000, "EUR"),
                                         ("chase", 13_000_000, "USD")], 1):
        cp = sc[key]
        pid = _scenario_player(w, f"pl-cw-{k}")
        tr = f"tr-out-cw-{k}"
        _transfer(w, tr, pid, "out", cp, fee, ccy, date(2024, 7, 10), 3)
        i1, i2, addon = round(fee * 0.4, 2), round(fee * 0.3, 2), 250000
        due = date(2025, 8, 1)
        _inst(w, f"{tr}-i1", tr, 1, due, i1, ccy, "invoiced")
        _inst(w, f"{tr}-i2", tr, 2, due, i2, ccy, "invoiced")
        _clause(w, f"cl-cw-{k}", "transfer", tr, "addon_appearances",
                {"threshold": 10, "fee": addon, "currency": ccy, "triggered": True}, comps=["league"])
        total = round(i1 + i2 + addon, 2)
        bid = f"btx-cw-{k}"
        _bank(w, bid, ccy, due + timedelta(days=4), total,
              f"{cp['name']} settlement refs INV1 INV2 ADDON", cp["iban"], "in")
        w.plant(issue_id=f"combined-wire-{k}", type="one_wire_many_items",
                subject_refs={"txn_id": bid, "installment_ids": [f"{tr}-i1", f"{tr}-i2"],
                              "clause_id": f"cl-cw-{k}", "components": {"i1": i1, "i2": i2, "addon": addon},
                              "total": total, "currency": ccy},
                expected_action=A["split"], must_not_auto_complete=False,
                note="Single wire pays two installments plus a triggered add-on. "
                     "Split one-to-many; it reconciles to the cent.")


def planter_duplicate_invoice(w: World, sc: dict) -> None:
    agent = sc["apex"]
    for k, (tr, amt, n1, n2) in enumerate([("tr-in-rv", 180000, "AX-2026-0191", "AX/26/191"),
                                           ("tr-in-mo", 140000, "AX-2026-0205", "2026-AX-205")], 1):
        orig, dup = f"inv-agent-{k}a", f"inv-agent-{k}b"
        _invoice(w, orig, agent["id"], amt, "GBP", date(2026, 3, 10), n1, "agent_fee", transfer=tr)
        _invoice(w, dup, agent["id"], amt, "GBP", date(2026, 3, 24), n2, "agent_fee", transfer=tr)
        w.plant(issue_id=f"duplicate-invoice-{k}", type="duplicate_agent_fee",
                subject_refs={"original_invoice_id": orig, "duplicate_invoice_id": dup, "amount": amt,
                              "currency": "GBP", "transfer_id": tr, "number_original": n1,
                              "number_duplicate": n2},
                expected_action=A["reject_dup"], must_not_auto_complete=False,
                note="Same agent, same amount, same signing, reformatted number two weeks later. "
                     "Reject the duplicate.")


def planter_threshold_evasion(w: World, sc: dict) -> None:
    agent = sc["apex"]
    tr = "tr-in-vb"
    _invoice(w, "inv-te-fee", agent["id"], 240000, "GBP", date(2026, 2, 5), "AX-2026-0150",
             "agent_fee", transfer=tr)
    _invoice(w, "inv-te-cons", agent["id"], 120000, "GBP", date(2026, 2, 6), "AX-2026-0151",
             "consultancy", transfer=tr)
    w.plant(issue_id="threshold-evasion-1", type="threshold_evasion_split",
            subject_refs={"invoice_ids": ["inv-te-fee", "inv-te-cons"], "transfer_id": tr,
                          "amounts": [240000, 120000], "combined": 360000,
                          "threshold": APPROVAL_THRESHOLD, "currency": "GBP"},
            expected_action=A["escalate_threshold"], must_not_auto_complete=True,
            note="Fee split into a £240k agent fee + £120k 'consultancy', each under the £250k "
                 "approval limit but £360k combined. Escalate.")


def planter_stale_fx(w: World, sc: dict) -> None:
    for k, (key, fee) in enumerate([("fenwick", 6_000_000), ("portvale", 4_800_000)], 1):
        cp = sc[key]
        pid = _scenario_player(w, f"pl-fx-{k}")
        signed = date(2024, 8, 5)
        tr = f"tr-in-fx-{k}"
        _transfer(w, tr, pid, "in", cp, fee, "EUR", signed, 3)
        per = round(fee / 3, 2)
        pay_date = date(2025, 10, 10)
        sign_rate, pay_rate = w.fx_at("EUR", signed), w.fx_at("EUR", pay_date)
        gbp_signed, gbp_paid = round(per * sign_rate, 2), round(per * pay_rate, 2)
        _inst(w, f"{tr}-i1", tr, 1, pay_date, per, "EUR", "invoiced")
        bid = f"btx-fx-{k}"
        _bank(w, bid, "GBP", pay_date + timedelta(days=1), -gbp_paid,
              f"FX settlement installment {cp['name']} EUR {per}", cp["iban"], "out", matched=f"{tr}-i1")
        w.plant(issue_id=f"stale-fx-{k}", type="stale_fx_rate",
                subject_refs={"installment_id": f"{tr}-i1", "txn_id": bid, "amount_eur": per,
                              "signing_rate_eurgbp": sign_rate, "payment_rate_eurgbp": pay_rate,
                              "gbp_at_signing": gbp_signed, "gbp_paid": gbp_paid,
                              "fx_diff_gbp": round(gbp_paid - gbp_signed, 2)},
                expected_action=A["propose_fx"], must_not_auto_complete=True,
                note="Installment booked at the signing-date FX; paid at a moved rate. "
                     "Flag the difference and propose an FX gain/loss entry.")


def planter_sell_on(w: World, sc: dict) -> None:
    buyer, prior = sc["brackenford"], sc["oldharbor"]
    pid = _scenario_player(w, "pl-sellon")
    sale_fee, original_fee, remaining_book = 20_000_000, 8_000_000, 5_000_000
    tr = "tr-out-sellon"
    _transfer(w, tr, pid, "out", buyer, sale_fee, "GBP", date(2026, 1, 20), 4,
              sell_on_pct=15, sell_on_basis="ambiguous")
    _clause(w, "cl-sellon", "transfer", tr, "sell_on",
            {"pct": 15, "owed_to": prior["id"], "original_fee": original_fee,
             "remaining_book_value": remaining_book},
            ambiguity="Contract says 15% of the fee; unclear whether gross fee or profit over book value.")
    w.plant(issue_id="sell-on-ambiguous-1", type="ambiguous_sell_on",
            subject_refs={"transfer_id": tr, "sell_on_clause_id": "cl-sellon", "owed_to": prior["id"],
                          "pct": 15, "gross_basis_amount": round(sale_fee * 0.15, 2),
                          "profit_basis_amount": round((sale_fee - remaining_book) * 0.15, 2),
                          "currency": "GBP"},
            expected_action=A["escalate_sellon"], must_not_auto_complete=True,
            note="Sell-on %: gross vs profit basis changes the amount by £750k. Must escalate, never guess.")


def planter_extension_amort(w: World, sc: dict) -> None:
    cp = sc["fenwick"]
    pid = _scenario_player(w, "pl-ext")
    fee = 12_000_000
    tr = "tr-in-ext"
    _transfer(w, tr, pid, "in", cp, fee, "EUR", date(2024, 9, 10), 4)
    _clause(w, "cl-ext", "transfer", tr, "extension",
            {"old_contract_years": 4, "new_contract_years": 6, "old_amortization_months": 48,
             "new_amortization_months": 72, "extended_at": "2026-03-15"})
    w.plant(issue_id="extension-amort-1", type="contract_extension_amortization",
            subject_refs={"transfer_id": tr, "clause_id": "cl-ext", "fee": fee, "currency": "EUR",
                          "old_amortization_months": 48, "new_amortization_months": 72},
            expected_action=A["propose_amort"], must_not_auto_complete=True,
            note="Contract extended 4y -> 6y; amortization must change 48 -> 72 months. Propose the adjustment.")


def _historical(w: World) -> None:
    specs = [("incoming_short_solidarity", 41, {"booked_to": "solidarity_receivable", "chased": False}),
             ("one_wire_many_items", 14, {"action": "split_one_to_many"}),
             ("duplicate_agent_fee", 9, {"action": "rejected_duplicate"}),
             ("addon_invoiced_not_triggered", 6, {"action": "rejected_with_clause_and_match_ids"}),
             ("legitimate_bank_detail_change", 5, {"action": "verified_then_paid"})]
    n = 0
    for situation, count, handled in specs:
        for i in range(count):
            n += 1
            dd = WORLD_START + timedelta(days=w.rng.randint(0, 360))
            hid = f"hist-{n:04d}"
            ref = w.land("ledger", f"hist:{hid}", handled)
            w.add("golden.historical_outcome", id=hid, at=ts(dd), situation=situation,
                  subject_refs={"example": i}, handled_as=handled,
                  actor=w.rng.choice(["controller:Dana", "accountant:Priya", "accountant:Sam"]),
                  raw_ref=ref)


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def build_world(seed: int, scale: str) -> World:
    rng = random.Random(seed)
    w = World(rng, scale)
    _periods(w)
    cps = _base_counterparties(w)
    roster = _roster(w)
    _match_events(w, roster)
    w.build_fx()

    def mk(key, name, kind, country, **kw):
        w_cp = _mk_counterparty(w, f"cp-{key}", name, kind, country, **kw)
        sc[key] = w_cp

    sc: dict[str, dict] = {}
    mk("realvista", "Real Vista", "club", "Spain", iban_changed=date(2023, 1, 1))
    mk("montara", "Montara CF", "club", "Spain", iban_changed=date(2023, 2, 1))
    mk("valebridge", "Valebridge United", "club", "England", iban_changed=date(2023, 3, 1))
    mk("skyline", "Skyline Athletic", "club", "Germany", iban_changed=date(2023, 4, 1))
    mk("northgate", "Northgate Rangers", "club", "France", iban_changed=date(2022, 9, 1))
    mk("fenwick", "Fenwick City", "club", "Italy", iban_changed=date(2022, 10, 1))
    mk("portvale", "Portvale SC", "club", "Portugal", iban_changed=date(2022, 11, 1))
    mk("apex", "Apex Football Agents", "agent", "England")
    mk("oldharbor", "Old Harbor FC", "club", "Netherlands", iban_changed=date(2022, 1, 1))
    mk("chase", "Chase City", "club", "USA", iban_changed=date(2022, 2, 1))
    mk("westcliff", "Westcliff Rovers", "club", "England")
    mk("greymoor", "Greymoor Athletic", "club", "England")
    mk("brackenford", "Brackenford FC", "club", "Spain")
    mk("dunmore", "Dunmore United", "club", "France")

    _routine_invoices(w, cps)
    planter_fraud(w, sc)
    planter_addons(w, sc)
    planter_solidarity(w, sc)
    planter_unexplained_short(w, sc)
    planter_combined_wire(w, sc)
    planter_duplicate_invoice(w, sc)
    planter_threshold_evasion(w, sc)
    planter_stale_fx(w, sc)
    planter_sell_on(w, sc)
    planter_extension_amort(w, sc)
    _historical(w)
    return w


# --------------------------------------------------------------------------- #
# Database flush
# --------------------------------------------------------------------------- #
from psycopg import sql  # noqa: E402  (kept near its only use)


def _pad_volume(cur, w: World) -> None:
    """scale=big: COPY millions of routine time-series rows for the Tiger story."""
    rng = w.rng
    span = (SIM_NOW - WORLD_START).days
    console.print("  padding time-series (scale=big)...")
    cols = ("id,source,account,txn_time,amount,currency,memo,counterparty_iban,"
            "direction,matched_installment_id,raw_ref")
    with cur.copy(f"COPY golden.bank_transaction ({cols}) FROM STDIN") as cp:
        for i in range(1_500_000):
            d = WORLD_START + timedelta(days=i % span, hours=rng.randint(0, 23))
            cp.write_row((f"pad-btx-{i}", "card", "MAIN-GBP", ts(d.date(), d.hour),
                          round(rng.uniform(-220, 220), 2), "GBP", "card settlement batch",
                          None, "in" if i % 2 else "out", None, None))
    with cur.copy("COPY golden.match_event (id,match_id,competition,player_id,event_time,kind,"
                  "value,season,raw_ref) FROM STDIN") as cp:
        for i in range(1_500_000):
            d = WORLD_START + timedelta(days=i % span, hours=20)
            cp.write_row((f"pad-me-{i}", f"m-pad-{i % 760}", "league", f"pl-{(i % 22) + 1:03d}",
                          ts(d.date(), 20), "minutes", rng.choice([90, 75, 60, 30]), "2025/26", None))


def write_to_db(w: World) -> None:
    conn = connect("superuser")
    try:
        with conn.cursor() as cur:
            targets = sql.SQL(", ").join(
                sql.SQL(".").join(map(sql.Identifier, t.split("."))) for t in COLUMNS
            )
            cur.execute(sql.SQL("TRUNCATE {} RESTART IDENTITY CASCADE").format(targets))
            for table in INSERT_ORDER:
                rows = w.buf.get(table)
                if not rows:
                    continue
                cols = COLUMNS[table]
                q = sql.SQL("INSERT INTO {} ({}) VALUES ({})").format(
                    sql.SQL(".").join(map(sql.Identifier, table.split("."))),
                    sql.SQL(", ").join(map(sql.Identifier, cols)),
                    sql.SQL(", ").join(sql.Placeholder() * len(cols)),
                )
                cur.executemany(q, rows)
                console.print(f"  inserted [green]{len(rows):,}[/] -> {table}")
            if w.scale == "big":
                _pad_volume(cur, w)
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #
def _summary(w: World, no_db: bool) -> None:
    t = Table(title="World generated (SIMULATED)" + ("  [dry-run, no DB]" if no_db else ""))
    t.add_column("table")
    t.add_column("rows", justify="right")
    for table in INSERT_ORDER:
        t.add_row(table, f"{len(w.buf.get(table, [])):,}")
    console.print(t)
    console.print(f"[bold]planted issues:[/] {len(w.answer_key)}   "
                  f"seed={get_settings().pitwall_seed}   scale={w.scale}")


def generate(no_db: bool = False) -> World:
    s = get_settings()
    w = build_world(s.pitwall_seed, s.pitwall_scale)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "answer_key.json").write_text(json.dumps(w.answer_key, indent=2, default=str))
    (OUT_DIR / "seller_bank_truth.json").write_text(json.dumps(w.seller_bank_truth, indent=2))
    if not no_db:
        write_to_db(w)
    _summary(w, no_db)
    console.print(f"[dim]answer key -> {OUT_DIR / 'answer_key.json'}[/]")
    return w


def print_answer_key() -> None:
    path = OUT_DIR / "answer_key.json"
    if not path.exists():
        console.print("[red]no answer_key.json[/] — run `make generate` (or `pitwall world generate`) first")
        return
    data = json.loads(path.read_text())
    t = Table(title=f"Answer key — {len(data)} planted issues")
    t.add_column("issue_id", style="cyan")
    t.add_column("type")
    t.add_column("expected_action", style="green")
    t.add_column("no-auto", justify="center")
    for e in data:
        t.add_row(e["issue_id"], e["type"], e["expected_action"],
                  "[red]YES[/]" if e["must_not_auto_complete"] else "-")
    console.print(t)
