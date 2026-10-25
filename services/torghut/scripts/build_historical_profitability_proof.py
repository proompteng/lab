#!/usr/bin/env python3
"""CLI entrypoint for historical profitability proof artifacts."""

from __future__ import annotations

from scripts.historical_profitability_proof import (
    HistoricalRunSummary,
    ProfitabilityProofGatePolicy,
    build_historical_profitability_bundle,
    main,
)

__all__ = [
    "HistoricalRunSummary",
    "ProfitabilityProofGatePolicy",
    "build_historical_profitability_bundle",
    "main",
]


if __name__ == "__main__":
    raise SystemExit(main())
