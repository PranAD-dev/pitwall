"""Pit Wall accounting — the System of Work's double-entry layer over the ledger
(the System of Record). Turns economic events into balanced journal entries, posts
them through the gateway, corrects closed periods by reverse+repost, and rolls the
ledger up into a trial balance and P&L.
"""

from __future__ import annotations

# submodules (coa, engine, posting, books) are imported directly by callers to keep
# package import light and avoid load-order coupling.
