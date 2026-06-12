from __future__ import annotations

from importlib import import_module


def test_start_historical_simulation_split_modules_are_importable() -> None:
    modules = [
        "tests.historical_simulation.test_start_historical_simulation_config",
        "tests.historical_simulation.test_start_historical_simulation_postgres",
        "tests.historical_simulation.test_start_historical_simulation_clickhouse",
        "tests.historical_simulation.test_start_historical_simulation_apply_a",
        "tests.historical_simulation.test_start_historical_simulation_apply_b",
        "tests.historical_simulation.test_start_historical_simulation_service_config",
        "tests.historical_simulation.test_start_historical_simulation_dump_cache_a",
        "tests.historical_simulation.test_start_historical_simulation_dump_cache_b",
        "tests.historical_simulation.test_start_historical_simulation_completion_policy",
        "tests.historical_simulation.test_start_historical_simulation_lifecycle_a",
        "tests.historical_simulation.test_start_historical_simulation_lifecycle_b",
        "tests.historical_simulation.test_start_historical_simulation_lifecycle_c",
        "tests.historical_simulation.test_start_historical_simulation_runtime_verify_a",
        "tests.historical_simulation.test_start_historical_simulation_runtime_verify_b",
        "tests.historical_simulation.test_start_historical_simulation_runtime_verify_c",
        "tests.historical_simulation.test_start_historical_simulation_argocd_a",
        "tests.historical_simulation.test_start_historical_simulation_argocd_b",
    ]
    for module_name in modules:
        import_module(module_name)
