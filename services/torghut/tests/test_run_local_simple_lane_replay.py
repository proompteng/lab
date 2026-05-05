from __future__ import annotations

from scripts import run_local_simple_lane_replay


def test_default_replay_universe_is_live_chip_coverage() -> None:
    assert run_local_simple_lane_replay.DEFAULT_SYMBOLS == [
        "AMAT",
        "AMD",
        "AVGO",
        "INTC",
        "MU",
        "NVDA",
    ]
