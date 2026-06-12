from __future__ import annotations

from importlib import import_module


def test_autonomous_lane_split_modules_are_importable() -> None:
    modules = [
        "tests.autonomous_lane.test_autonomous_lane_evidence",
        "tests.autonomous_lane.test_autonomous_lane_governance_a",
        "tests.autonomous_lane.test_autonomous_lane_persistence_a",
        "tests.autonomous_lane.test_autonomous_lane_persistence_b",
        "tests.autonomous_lane.test_autonomous_lane_phase_a",
        "tests.autonomous_lane.test_autonomous_lane_phase_b",
    ]
    for module in modules:
        import_module(module)
