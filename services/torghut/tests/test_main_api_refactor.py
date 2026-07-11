from __future__ import annotations

import importlib

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute

from app import main as main_module
from app import scheduler_main
from app.api.application import api_routers, get_app


def _route_methods() -> dict[str, set[str]]:
    route_methods: dict[str, set[str]] = {}
    for route in main_module.app.routes:
        if isinstance(route, APIRoute):
            route_methods.setdefault(route.path, set()).update(route.methods or set())
    return route_methods


def test_main_exports_operational_api_only() -> None:
    assert isinstance(main_module.app, FastAPI)
    assert main_module.app.title == "torghut"

    mounted_routes = _route_methods()
    expected_routes = {
        "/healthz": {"GET"},
        "/readyz": {"GET"},
        "/metrics": {"GET"},
        "/trading/status": {"GET"},
    }
    assert mounted_routes == expected_routes


def test_main_public_contract_is_entrypoint_only() -> None:
    assert main_module.__all__ == ("app", "create_app")
    assert get_app() is main_module.app
    assert get_app("scheduler") is scheduler_main.app

    removed_private_attrs = (
        "ROUTER_PROVIDERS",
        "SessionLocal",
        "_TradingStatusReadBudget",
        "_build_live_submission_gate_payload",
        "_build_trading_proofs_payload",
        "_evaluate_database_contract",
        "trading_status",
    )
    assert [name for name in removed_private_attrs if hasattr(main_module, name)] == []


def test_api_application_mounts_only_operational_routers() -> None:
    route_paths = {
        route.path
        for router in api_routers()
        for route in router.routes
        if isinstance(route, APIRoute)
    }

    assert route_paths == {"/readyz", "/trading/status", "/metrics"}


def test_api_common_dead_surface_is_removed() -> None:
    with pytest.raises(ModuleNotFoundError):
        importlib.import_module("app.api.common")
    assert not hasattr(main_module, "main_runtime_value")
