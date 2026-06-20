from __future__ import annotations

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.routing import APIRoute

from app import main as main_module
from app.api import common as api_common
from app.api import proofs as proofs_api
from app.api.application import api_routers, get_app
from app.trading.scheduler import TradingScheduler


def _route_methods() -> dict[str, set[str]]:
    route_methods: dict[str, set[str]] = {}
    for route in main_module.app.routes:
        if isinstance(route, APIRoute):
            route_methods.setdefault(route.path, set()).update(route.methods or set())
    return route_methods


def test_main_exports_fastapi_app_with_routes() -> None:
    assert isinstance(main_module.app, FastAPI)
    assert main_module.app.title == "torghut"

    mounted_routes = _route_methods()
    expected_routes = {
        "/": {"GET"},
        "/healthz": {"GET"},
        "/db-check": {"GET"},
        "/readyz": {"GET"},
        "/metrics": {"GET"},
        "/trading/status": {"GET"},
        "/trading/health": {"GET"},
        "/trading/proofs": {"GET"},
        "/trading/profitability/runtime": {"GET"},
        "/whitepapers/status": {"GET"},
        "/whitepapers/search": {"GET"},
    }

    missing_routes = {
        path: methods
        for path, methods in expected_routes.items()
        if not methods.issubset(mounted_routes.get(path, set()))
    }
    assert missing_routes == {}


def test_main_public_contract_is_entrypoint_only() -> None:
    assert main_module.__all__ == ("app", "create_app")
    assert get_app() is main_module.app

    removed_private_attrs = (
        "ROUTER_PROVIDERS",
        "SessionLocal",
        "_TradingStatusReadBudget",
        "_build_live_submission_gate_payload",
        "_build_trading_proofs_payload",
        "_evaluate_database_contract",
        "_paper_route_target_plan_success_cache",
        "trading_status",
    )
    leaked_attrs = [
        name for name in removed_private_attrs if hasattr(main_module, name)
    ]
    assert leaked_attrs == []


def test_api_application_mounts_concrete_routers() -> None:
    route_paths = {
        route.path
        for router in api_routers()
        for route in router.routes
        if isinstance(route, APIRoute)
    }

    assert {
        "/readyz",
        "/trading/status",
        "/trading/health",
        "/trading/proofs",
        "/trading/consumer-evidence",
        "/trading/profitability/runtime",
        "/whitepapers/status",
    }.issubset(route_paths)


def test_main_runtime_value_falls_back_to_common_default() -> None:
    assert (
        api_common.main_runtime_value("__missing_refactor_probe__", "fallback")
        == "fallback"
    )


def test_proof_request_value_helpers_live_with_proofs_api() -> None:
    assert proofs_api._proof_kind_value("runtime_window") == "runtime_window"
    assert proofs_api._proof_window_value("next") == "next"
    assert proofs_api._proof_window_value("latest_closed") == "latest_closed"
    assert proofs_api._proof_window_value("unexpected") == "auto"

    with pytest.raises(HTTPException) as exc_info:
        proofs_api._proof_kind_value("paper_route")
    assert exc_info.value.status_code == 400


def test_trading_scheduler_for_proofs_creates_missing_scheduler() -> None:
    if hasattr(main_module.app.state, "trading_scheduler"):
        delattr(main_module.app.state, "trading_scheduler")

    scheduler = proofs_api._trading_scheduler_for_proofs()

    assert isinstance(scheduler, TradingScheduler)
    assert proofs_api._trading_scheduler_for_proofs() is scheduler


def test_paper_route_probe_symbol_values_from_mapping() -> None:
    assert proofs_api._paper_route_probe_symbol_values_from_mapping(
        {
            "paper_route_probe_symbols": " aapl, AMZN ",
            "symbols": ["MSFT", "", "aapl"],
            "symbol_actions": {"nvda": "buy", " AMZN ": "sell"},
        }
    ) == ["AAPL", "AMZN", "MSFT", "NVDA"]
