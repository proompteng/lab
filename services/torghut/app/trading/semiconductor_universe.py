"""Canonical semiconductor/technology universe used by Torghut live execution."""

from __future__ import annotations

MAX_RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE_SIZE = 12

RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE: tuple[str, ...] = (
    "NVDA",
    "AAPL",
    "AMZN",
    "GOOGL",
    "AVGO",
    "AMD",
    "ORCL",
    "INTC",
)

LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE = RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE

SEMICONDUCTOR_TECH_UNIVERSE_CSV = ",".join(RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE)
