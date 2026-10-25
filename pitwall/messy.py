"""More messy, ambiguous data to experiment with in the Teamwork Terminal.

Adds extra cases the agent has to reason about — the point is the TRAPS: short
receipts that look alike but split into "genuine 5% solidarity withheld" vs
"unexplained, escalate", a duplicate agent fee, an ambiguous sell-on clause, a
stale-FX installment, and one wire that covers several installments. Idempotent
(ON CONFLICT DO NOTHING) so it's safe to run repeatedly; everything is tagged
raw_ref='mess' and ids are prefixed so it's easy to spot/remove.
"""

from __future__ import annotations

from psycopg.types.json import Json

from .db import connect

# players (transfer.player_id → golden.player.id): id, name, position, nationality
_PLAYERS = [
    ("pl-mess-varga", "Marco Varga", "ST", "Spain"),
    ("pl-mess-okafor", "Jon Okafor", "CB", "Nigeria"),
    ("pl-mess-kessler", "Luka Kessler", "CM", "Germany"),
    ("pl-mess-nilsson", "Erik Nilsson", "GK", "Sweden"),
    ("pl-mess-mendez", "Diego Mendez", "RW", "Argentina"),
    ("pl-mess-oak", "Samir Oak", "LW", "England"),
]

# counterparties: id, name, kind, country, verified_iban, email_domain
_CPARTIES = [
    ("cp-mess-montara", "Montara CF", "club", "ES", "ES7620770024003102575766", "montaracf.es"),
    ("cp-mess-dunmore", "Dunmore Athletic", "club", "GB", "GB29NWBK60161331926819", "dunmoreathletic.co.uk"),
    ("cp-mess-fenwick", "Fenwick Rovers", "club", "GB", "GB94BARC10201530093459", "fenwickrovers.co.uk"),
    ("cp-mess-rialto", "Rialto Sports Agency", "agent", "IT", "IT60X0542811101000000123456", "rialtosports.it"),
    ("cp-mess-castleton", "Castleton City", "club", "GB", "GB33BUKB20201555555555", "castletoncity.co.uk"),
    ("cp-mess-northbridge", "Northbridge FC", "club", "GB", "GB15MIDL40051512345678", "northbridgefc.co.uk"),
    ("cp-mess-oakmere", "Oakmere United", "club", "GB", "GB16BARC20031899999999", "oakmereunited.co.uk"),
]

# transfers: id, player_id, direction, counterparty_id, fee, currency, signed_at,
#            contract_years, amortization_months, solidarity_applicable, sell_on_pct,
#            sell_on_basis, status
_TRANSFERS = [
    ("tr-mess-varga", "pl-mess-varga", "out", "cp-mess-montara", 3_000_000, "EUR", "2026-01-15", 4, 48, True, None, None, "active"),
    ("tr-mess-okafor", "pl-mess-okafor", "out", "cp-mess-dunmore", 4_000_000, "EUR", "2026-01-20", 4, 48, False, None, None, "active"),
    ("tr-mess-kessler", "pl-mess-kessler", "out", "cp-mess-fenwick", 5_000_000, "EUR", "2026-02-01", 4, 48, False, None, None, "active"),
    ("tr-mess-nilsson", "pl-mess-nilsson", "in", "cp-mess-northbridge", 5_000_000, "EUR", "2026-01-20", 4, 48, False, None, None, "active"),
    ("tr-mess-mendez", "pl-mess-mendez", "out", "cp-mess-castleton", 8_000_000, "EUR", "2026-02-10", 4, 48, False, 15, None, "active"),
    ("tr-mess-oak", "pl-mess-oak", "out", "cp-mess-oakmere", 9_000_000, "EUR", "2026-02-15", 4, 48, True, None, None, "active"),
]

# installments: id, transfer_id, seq, due_date, amount, currency, status
_INSTALLMENTS = [
    ("inst-mess-varga-1", "tr-mess-varga", 1, "2026-03-01", 1_500_000, "EUR", "invoiced"),
    ("inst-mess-okafor-1", "tr-mess-okafor", 1, "2026-03-01", 2_000_000, "EUR", "invoiced"),
    ("inst-mess-kessler-1", "tr-mess-kessler", 1, "2026-03-05", 2_500_000, "EUR", "invoiced"),
    ("inst-mess-nilsson-1", "tr-mess-nilsson", 1, "2026-04-01", 1_250_000, "EUR", "scheduled"),
    ("inst-mess-oak-1", "tr-mess-oak", 1, "2026-03-15", 2_000_000, "EUR", "invoiced"),
    ("inst-mess-oak-2", "tr-mess-oak", 2, "2026-03-15", 2_250_000, "EUR", "invoiced"),
]

# bank_transactions: id, txn_time, amount, currency, memo, counterparty_iban, direction
_BANK = [
    ("bt-mess-varga", "2026-03-03", 1_425_000, "EUR",
     "FIFA solidarity contribution 5% withheld at source — Montara CF", "ES7620770024003102575766", "in"),
    ("bt-mess-okafor", "2026-03-04", 1_840_000, "EUR", "", "GB29NWBK60161331926819", "in"),
    ("bt-mess-kessler", "2026-03-07", 2_225_000, "EUR", "payment ref 99213", "GB94BARC10201530093459", "in"),
    ("bt-mess-oak", "2026-03-18", 4_250_000, "EUR",
     "OAKMERE UTD settlement INV-OAK-1 INV-OAK-2", "GB16BARC20031899999999", "in"),
    ("bt-mess-nilsson", "2026-04-05", -1_250_000, "EUR", "pay Northbridge installment 1", "GB15MIDL40051512345678", "out"),
]

# invoices (the duplicate agent fee): id, counterparty_id, amount, currency, transfer_id,
#           issued_at, number, kind, status
_INVOICES = [
    ("inv-mess-dup-a", "cp-mess-rialto", 450_000, "EUR", "tr-mess-nilsson", "2026-02-10", "RSA-2026-0912", "agent_fee", "received"),
    ("inv-mess-dup-b", "cp-mess-rialto", 450_000, "EUR", "tr-mess-nilsson", "2026-02-18", "RSA-2026-0912-R", "agent_fee", "received"),
]

# contract clauses (ambiguous sell-on): id, contract_id, kind, params, ambiguity_note
_CLAUSES = [
    ("cl-mess-sellon", "tr-mess-mendez", "sell_on", {"pct": 15},
     "clause does not state whether the 15% applies to the gross transfer fee or to our "
     "profit over the player's book value — the two bases differ materially"),
]

# fx rates for the stale-FX case: (pair, at, rate)
_FX = [
    ("EURGBP", "2026-01-20", 0.86),   # signing rate
    ("EURGBP", "2026-04-05", 0.84),   # payment rate months later
]


def seed_mess() -> dict:
    conn = connect("superuser")
    added: dict[str, int] = {}
    try:
        with conn.cursor() as cur:
            def run(key, sql, rows):
                n = 0
                for r in rows:
                    cur.execute(sql, r)
                    n += cur.rowcount if (cur.rowcount and cur.rowcount > 0) else 0
                added[key] = n

            # these tables have no unique constraint on id → guard with WHERE NOT EXISTS
            run("player",
                "INSERT INTO golden.player (id,name,position,nationality,raw_ref) "
                "SELECT %s,%s,%s,%s,'mess' WHERE NOT EXISTS (SELECT 1 FROM golden.player WHERE id=%s)",
                [(*p, p[0]) for p in _PLAYERS])

            run("counterparty",
                "INSERT INTO golden.counterparty (id,name,kind,country,verified_iban,"
                "iban_last_changed_at,email_domain,raw_ref) SELECT %s,%s,%s,%s,%s,'2026-01-05',%s,'mess' "
                "WHERE NOT EXISTS (SELECT 1 FROM golden.counterparty WHERE id=%s)",
                [(*c, c[0]) for c in _CPARTIES])

            run("transfer",
                "INSERT INTO golden.transfer (id,player_id,direction,counterparty_id,fee,currency,"
                "signed_at,contract_years,amortization_months,solidarity_applicable,sell_on_pct,"
                "sell_on_basis,status,raw_ref) SELECT %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'mess' "
                "WHERE NOT EXISTS (SELECT 1 FROM golden.transfer WHERE id=%s)",
                [(*t, t[0]) for t in _TRANSFERS])

            run("installment",
                "INSERT INTO golden.installment (id,transfer_id,seq,due_date,amount,currency,status,"
                "raw_ref) VALUES (%s,%s,%s,%s,%s,%s,%s,'mess') ON CONFLICT (id) DO NOTHING", _INSTALLMENTS)

            run("bank_transaction",
                "INSERT INTO golden.bank_transaction (id,source,account,txn_time,amount,currency,memo,"
                "counterparty_iban,direction,raw_ref) SELECT %s,'bank','main',%s,%s,%s,%s,%s,%s,'mess' "
                "WHERE NOT EXISTS (SELECT 1 FROM golden.bank_transaction WHERE id=%s)",
                [(*b, b[0]) for b in _BANK])

            run("invoice",
                "INSERT INTO golden.invoice (id,counterparty_id,amount,currency,transfer_id,issued_at,"
                "number,kind,status,raw_ref) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'mess') "
                "ON CONFLICT (id) DO NOTHING", _INVOICES)

            run("contract_clause",
                "INSERT INTO golden.contract_clause (id,contract_type,contract_id,kind,params,"
                "ambiguity_note,raw_ref) SELECT %s,'transfer',%s,%s,%s,%s,'mess' "
                "WHERE NOT EXISTS (SELECT 1 FROM golden.contract_clause WHERE id=%s)",
                [(i, cid, k, Json(p), note, i) for (i, cid, k, p, note) in _CLAUSES])

            run("fx_rate",
                "INSERT INTO golden.fx_rate (pair,at,rate) SELECT %s,%s,%s "
                "WHERE NOT EXISTS (SELECT 1 FROM golden.fx_rate WHERE pair=%s AND at=%s)",
                [(p, a, r, p, a) for (p, a, r) in _FX])
        conn.commit()
    finally:
        conn.close()
    return {"added": added, "total": sum(added.values())}


def seed_edge_cases() -> dict:
    """The clause-trigger edge cases: wage suspension (Mendy), loan-to-buy mandatory
    purchase (CAS), and Article 15 sporting just cause. Idempotent."""
    from datetime import timedelta

    conn = connect("superuser")
    added = {"players": 0, "emp_clauses": 0, "loan_deal": 0, "loan_clause": 0, "matches": 0}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT max(txn_time)::date FROM golden.bank_transaction")
            today = cur.fetchone()[0]
            match_date = (today - timedelta(days=10)).isoformat()   # season end inside the Art-15 window
            deadline = (today + timedelta(days=60)).isoformat()

            def ins(sql, rows):
                n = 0
                for r in rows:
                    cur.execute(sql, r); n += cur.rowcount or 0
                return n

            players = [("pl-mendy", "Marcus Vane", "CB", "France"),
                       ("pl-safe", "Theo Brandt", "GK", "Germany"),
                       ("pl-loan", "Niko Sauer", "RW", "Austria"),
                       ("pl-art15", "Owen Fisk", "CM", "England"),
                       ("pl-club-rep", "Club Squad", "NA", "Fictionland")]
            added["players"] = ins(
                "INSERT INTO golden.player (id,name,position,nationality,raw_ref) SELECT %s,%s,%s,%s,'mess' "
                "WHERE NOT EXISTS (SELECT 1 FROM golden.player WHERE id=%s)",
                [(*p, p[0]) for p in players])

            # employment clauses — pl-mendy has NO withholding clause (the trap)
            emp = [("cl-emp-vane", "pl-mendy", "standard_terms", {}, ""),
                   ("cl-emp-brandt-base", "pl-safe", "standard_terms", {}, ""),
                   ("cl-emp-brandt-wh", "pl-safe", "suspension_withholding",
                    {"trigger": "criminal_charge_or_serious_misconduct"},
                    "explicit contractual right to withhold pay during a suspension pending investigation")]
            added["emp_clauses"] = ins(
                "INSERT INTO golden.contract_clause (id,contract_type,contract_id,kind,params,"
                "ambiguity_note,raw_ref) SELECT %s,'player',%s,%s,%s,%s,'mess' "
                "WHERE NOT EXISTS (SELECT 1 FROM golden.contract_clause WHERE id=%s)",
                [(i, cid, k, Json(p), note, i) for (i, cid, k, p, note) in emp])

            added["loan_deal"] = ins(
                "INSERT INTO golden.transfer (id,player_id,direction,counterparty_id,fee,currency,"
                "signed_at,contract_years,amortization_months,solidarity_applicable,status,raw_ref) "
                "SELECT 'tr-loan-sauer','pl-loan','in','cp-mess-northbridge',0,'EUR','2025-08-01',4,48,"
                "false,'loan','mess' WHERE NOT EXISTS (SELECT 1 FROM golden.transfer WHERE id='tr-loan-sauer')", [()])
            loan_params = {"threshold_qualifying_appearances": 15, "min_minutes": 45,
                           "competitions": ["league"], "season": "DEMO/26", "fee": 10_000_000,
                           "currency": "EUR", "deadline": deadline, "relegation_voids": True}
            added["loan_clause"] = ins(
                "INSERT INTO golden.contract_clause (id,contract_type,contract_id,kind,params,"
                "competitions_counted,ambiguity_note,raw_ref) SELECT 'cl-loan-obligation','transfer',"
                "'tr-loan-sauer','obligation_to_buy',%s,%s,'mandatory purchase once the appearance trigger "
                "is met','mess' WHERE NOT EXISTS (SELECT 1 FROM golden.contract_clause WHERE id='cl-loan-obligation')",
                [(Json(loan_params), ["league"])])

            # DEMO/26: 40 club matches; pl-art15 in 3 (7.5%); pl-loan 12 qualifying (≥45m) + 6 late subs (<45m)
            rows = []
            for m in range(1, 41):
                mid = f"m-demo-{m:03d}"
                rows.append((f"me-app-rep-{m:03d}", mid, "pl-club-rep", "appearance", 1))
                rows.append((f"me-min-rep-{m:03d}", mid, "pl-club-rep", "minutes", 90))
                if m <= 3:
                    rows.append((f"me-app-art15-{m:03d}", mid, "pl-art15", "appearance", 1))
                    rows.append((f"me-min-art15-{m:03d}", mid, "pl-art15", "minutes", 90))
                if m <= 18:
                    mins = 90 if m <= 12 else 20
                    rows.append((f"me-app-loan-{m:03d}", mid, "pl-loan", "appearance", 1))
                    rows.append((f"me-min-loan-{m:03d}", mid, "pl-loan", "minutes", mins))
            added["matches"] = ins(
                "INSERT INTO golden.match_event (id,match_id,competition,player_id,event_time,kind,value,"
                "season,raw_ref) SELECT %s,%s,'league',%s,%s,%s,%s,'DEMO/26','mess' "
                "WHERE NOT EXISTS (SELECT 1 FROM golden.match_event WHERE id=%s)",
                [(rid, mid, pid, match_date, kind, val, rid) for (rid, mid, pid, kind, val) in rows])
        conn.commit()
    finally:
        conn.close()
    return added


def seed_player_finance() -> dict:
    """Deep per-player finance: monthly wage PAYMENT STATUS (paid/unpaid/pending — amount
    stays sealed), plus two departing players carrying OUTSTANDING obligations (unpaid
    wages, a loyalty bonus, image rights) so 'is X paid this month?' and 'what do we owe X
    on the way out?' are answerable from real data. Idempotent."""
    from datetime import timedelta

    conn = connect("superuser")
    added = {"wage_runs": 0, "obligations": 0, "leaving": 0}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT max(txn_time)::date FROM golden.bank_transaction")
            today = cur.fetchone()[0]
            cur.execute("SELECT DISTINCT p.id FROM golden.player p JOIN golden.transfer t "
                        "ON t.player_id=p.id WHERE coalesce(p.raw_ref,'') <> 'mess' ORDER BY p.id")
            players = [r[0] for r in cur.fetchall()]
            # the last 8 months, oldest → latest
            months, y, m = [], today.year, today.month
            for _ in range(8):
                months.append(f"{y:04d}-{m:02d}")
                m -= 1
                if m == 0:
                    m, y = 12, y - 1
            months.reverse()

            leaving = [p for p in ("pl-sol-1", "pl-sellon") if p in players] or players[:2]

            for idx, pid in enumerate(players):
                for mi, mo in enumerate(months):
                    latest = mi == len(months) - 1
                    if latest and pid in leaving:
                        status = "unpaid"
                    elif latest and idx % 3 == 1:
                        status = "pending"
                    elif mi == len(months) - 2 and idx % 5 == 0:
                        status = "unpaid"
                    else:
                        status = "paid"
                    rid = f"wr-{pid}-{mo}"
                    cur.execute(
                        "INSERT INTO golden.player_wage_run (id,player_id,month,status,due_date,paid_at,"
                        "currency) SELECT %s,%s,%s,%s,%s,%s,'EUR' WHERE NOT EXISTS "
                        "(SELECT 1 FROM golden.player_wage_run WHERE id=%s)",
                        (rid, pid, mo, status, mo + "-28", (mo + "-28" if status == "paid" else None), rid))
                    added["wage_runs"] += cur.rowcount or 0

            obls = [("wage", 180000, "unpaid wages for the final month"),
                    ("bonus", 50000, "loyalty bonus accrued, not yet paid"),
                    ("image_rights", 40000, "image-rights instalment outstanding")]
            for pid in leaving:
                cur.execute("UPDATE golden.player SET status='leaving', leaving_date=%s WHERE id=%s",
                            ((today + timedelta(days=21)).isoformat(), pid))
                added["leaving"] += cur.rowcount or 0
                for kind, amt, note in obls:
                    oid = f"obl-{pid}-{kind}"
                    cur.execute(
                        "INSERT INTO golden.player_obligation (id,player_id,kind,amount,currency,status,"
                        "due_date,note) SELECT %s,%s,%s,%s,'EUR','outstanding',%s,%s WHERE NOT EXISTS "
                        "(SELECT 1 FROM golden.player_obligation WHERE id=%s)",
                        (oid, pid, kind, amt, (today + timedelta(days=14)).isoformat(), note, oid))
                    added["obligations"] += cur.rowcount or 0
        conn.commit()
    finally:
        conn.close()
    return added
