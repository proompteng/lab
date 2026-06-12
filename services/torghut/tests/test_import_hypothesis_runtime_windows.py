from __future__ import annotations

from importlib import import_module


def test_runtime_window_import_split_modules_are_importable() -> None:
    modules = [
        "tests.runtime_window_import.test_runtime_window_config",
        "tests.runtime_window_import.test_runtime_window_authority",
        "tests.runtime_window_import.test_runtime_window_source_context",
        "tests.runtime_window_import.test_runtime_window_source_decisions",
        "tests.runtime_window_import.test_runtime_window_proof_hygiene",
        "tests.runtime_window_import.test_runtime_window_realized_pnl_a",
        "tests.runtime_window_import.test_runtime_window_realized_pnl_b",
        "tests.runtime_window_import.test_runtime_window_realized_pnl_c",
        "tests.runtime_window_import.test_runtime_window_realized_pnl_d",
        "tests.runtime_window_import.test_runtime_window_realized_pnl_e",
        "tests.runtime_window_import.test_runtime_window_realized_pnl_f",
        "tests.runtime_window_import.test_runtime_window_realized_pnl_g",
        "tests.runtime_window_import.test_runtime_window_query_timestamps_a",
        "tests.runtime_window_import.test_runtime_window_query_timestamps_b",
        "tests.runtime_window_import.test_runtime_window_artifacts",
        "tests.runtime_window_import.test_runtime_window_main_a",
        "tests.runtime_window_import.test_runtime_window_main_b",
    ]
    for module_name in modules:
        import_module(module_name)
