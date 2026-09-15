"""Command entrypoint for historical simulation report analysis."""

from __future__ import annotations

from scripts.historical_simulation_analysis import main

__all__ = ("main",)

if __name__ == "__main__":
    raise SystemExit(main())
