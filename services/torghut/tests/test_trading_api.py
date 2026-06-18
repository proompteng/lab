from __future__ import annotations

from importlib import import_module


def test_trading_api_split_packages_are_importable() -> None:
    modules = [
        "tests.api.test_trading_api_forecast_options",
        "tests.api.test_trading_api_db_contract",
        "tests.api.test_trading_api_status_consumer_evidence",
        "tests.api.test_trading_api_status_read_budget",
        "tests.api.test_trading_api_simple_lane_profit_floor",
        "tests.api.test_trading_api_health_dependency",
        "tests.api.test_trading_api_readyz_contract",
        "tests.api.test_trading_api_health_cache",
        "tests.api.test_trading_api_live_gate_llm",
        "tests.api.test_trading_api_revenue_zero_repair",
        "tests.api.test_trading_api_zero_notional_replay",
        "tests.api.test_trading_api_status_metadata",
        "tests.api.test_trading_api_runtime_profitability",
        "tests.api.test_trading_api_paper_route_cache",
        "tests.api.test_trading_api_paper_route_payloads",
        "tests.api.test_trading_api_paper_route_external",
    ]
    for module_name in modules:
        import_module(module_name)
