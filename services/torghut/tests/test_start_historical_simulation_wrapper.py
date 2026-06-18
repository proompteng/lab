from __future__ import annotations

from scripts import historical_simulation_startup, start_historical_simulation


def test_start_historical_simulation_reexports_startup_surface() -> None:
    assert start_historical_simulation.main is historical_simulation_startup.main
    assert "main" in start_historical_simulation.__all__
    assert "APPLY_CONFIRMATION_PHRASE" in start_historical_simulation.__all__
