"""Chart of accounts for a football club — the small, deep vocabulary the ledger
posts into. Each account has a type and a normal balance side (debit/credit), which
the trial balance and P&L use to classify and sign balances.

Player registrations are the heart of football accounting: a transfer fee is
CAPITALISED as an intangible asset, AMORTISED over the contract, and DERECOGNISED
on sale with a gain/loss — exactly BVB's IFRS Note 1/17/21 shape.
"""

from __future__ import annotations

# code -> (name, type).  type ∈ asset | contra_asset | liability | equity | revenue | expense
ACCOUNTS: dict[str, tuple[str, str]] = {
    "1000": ("Cash", "asset"),
    "1050": ("VAT recoverable", "asset"),
    "1100": ("Transfer receivable", "asset"),
    "1110": ("Solidarity receivable", "asset"),
    "1200": ("Player registrations", "asset"),
    "1210": ("Accumulated amortisation — player registrations", "contra_asset"),
    "2000": ("Transfer payable", "liability"),
    "2100": ("Accrued add-on liabilities", "liability"),
    "2110": ("Sell-on payable", "liability"),
    "2200": ("Deferred revenue", "liability"),
    "2300": ("Wages payable", "liability"),
    "2310": ("Accrued player bonuses", "liability"),
    "3000": ("Retained earnings", "equity"),
    "4000": ("Sponsorship revenue", "revenue"),
    "4100": ("Matchday revenue", "revenue"),
    "4200": ("Profit on disposal of player registrations", "revenue"),
    "5000": ("Amortisation expense", "expense"),
    "5100": ("Agent fees expense", "expense"),
    "5200": ("Loss on disposal of player registrations", "expense"),
    "5300": ("Player wages & salaries", "expense"),
    "5310": ("Player bonus expense", "expense"),
    "5320": ("Coaching & staff wages", "expense"),
    "6000": ("FX gain/(loss)", "revenue"),
}

# named handles so posting rules read like accounting, not magic numbers
CASH = "1000"
VAT_RECOVERABLE = "1050"
AR = "1100"              # transfer receivable (money owed to us on sales)
SOLIDARITY_AR = "1110"
REGISTRATIONS = "1200"   # player registrations (intangible asset, at cost)
ACCUM_AMORT = "1210"     # contra-asset
AP = "2000"              # transfer payable (money we owe on purchases)
ADDON_LIAB = "2100"      # accrued contingent add-ons, once probable/earned
SELLON_AP = "2110"
DEFERRED_REV = "2200"
WAGES_PAYABLE = "2300"
ACCRUED_BONUS = "2310"
RETAINED = "3000"
SPONSOR_REV = "4000"
MATCHDAY_REV = "4100"
DISPOSAL_GAIN = "4200"
AMORT_EXP = "5000"
AGENT_EXP = "5100"
DISPOSAL_LOSS = "5200"
WAGES_EXP = "5300"        # player wages & salaries
BONUS_EXP = "5310"
STAFF_WAGES_EXP = "5320"  # coaching & other staff
FX = "6000"

# accounts whose normal (positive) balance is a debit
_DEBIT_NORMAL = {"asset", "expense"}


def name(code: str) -> str:
    return ACCOUNTS.get(code, (code, "asset"))[0]


def label(code: str) -> str:
    return f"{code} {name(code)}"


def acct_type(code: str) -> str:
    return ACCOUNTS.get(code, ("", "asset"))[1]


def is_debit_normal(code: str) -> bool:
    t = acct_type(code)
    if t == "contra_asset":
        return False  # a contra-asset carries a credit balance
    return t in _DEBIT_NORMAL
