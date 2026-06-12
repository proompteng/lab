from __future__ import annotations

import sys
import types

import pytest
from fastapi import HTTPException

from app import main as main_module
from app.api import common as api_common
from app.api.proxy import (
    MainAttrProxy,
    export_api_symbols,
    install_main_compat_proxies,
)
from app.trading import TradingScheduler


def test_main_runtime_value_falls_back_to_common_default() -> None:
    assert (
        api_common.main_runtime_value("__missing_refactor_probe__", "fallback")
        == "fallback"
    )


def test_main_attr_proxy_forwards_runtime_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        main_module, "_refactor_proxy_target", {"AAPL": 1}, raising=False
    )
    proxy = MainAttrProxy("_refactor_proxy_target")

    assert bool(proxy)
    assert str(proxy) == "{'AAPL': 1}"
    assert repr(proxy) == "{'AAPL': 1}"
    assert list(proxy) == ["AAPL"]
    assert len(proxy) == 1
    assert proxy["AAPL"] == 1
    assert proxy == {"AAPL": 1}

    monkeypatch.setattr(
        main_module, "_refactor_proxy_target", lambda value: value + 1, raising=False
    )
    assert proxy(2) == 3

    monkeypatch.setattr(main_module, "_refactor_proxy_target", 3, raising=False)
    assert int(proxy) == 3
    assert float(proxy) == 3.0


def test_main_attr_proxy_fails_closed_without_main_module() -> None:
    original_main = sys.modules.pop("app.main", None)
    try:
        with pytest.raises(RuntimeError, match="app.main is not loaded"):
            MainAttrProxy("_missing")._target()
    finally:
        if original_main is not None:
            sys.modules["app.main"] = original_main


def test_api_symbol_export_and_proxy_installation() -> None:
    main_holder = types.ModuleType("main_holder")
    source_module = types.ModuleType("source_module")
    skipped_module = types.ModuleType("skipped_module")
    target_module = types.ModuleType("target_module")
    source_module._EXPORTED_SYMBOLS = {"exported": 7}
    skipped_module._EXPORTED_SYMBOLS = []

    export_api_symbols(main_holder, [source_module, skipped_module])
    assert main_holder.exported == 7

    install_main_compat_proxies([target_module], ["router", "exported"])
    assert "router" not in vars(target_module)
    assert isinstance(target_module.exported, MainAttrProxy)


def test_proof_request_value_helpers() -> None:
    assert main_module._paper_route_target_plan_audit_mode_value("deferred") is False
    assert main_module._paper_route_target_plan_audit_mode_value("full") is True
    assert main_module._paper_route_target_plan_audit_mode_value("off") is None
    assert main_module._proof_kind_value("runtime_window") == "runtime_window"
    assert main_module._proof_window_value("next") == "next"
    assert main_module._proof_window_value("latest_closed") == "latest_closed"
    assert main_module._proof_window_value("unexpected") == "auto"

    with pytest.raises(HTTPException) as exc_info:
        main_module._proof_kind_value("paper_route")
    assert exc_info.value.status_code == 400


def test_trading_scheduler_for_proofs_creates_missing_scheduler() -> None:
    if hasattr(main_module.app.state, "trading_scheduler"):
        delattr(main_module.app.state, "trading_scheduler")

    scheduler = main_module._trading_scheduler_for_proofs()

    assert isinstance(scheduler, TradingScheduler)
    assert main_module._trading_scheduler_for_proofs() is scheduler


def test_paper_route_probe_symbol_values_from_mapping() -> None:
    assert main_module._paper_route_probe_symbol_values_from_mapping(
        {
            "paper_route_probe_symbols": " aapl, AMZN ",
            "symbols": ["MSFT", "", "aapl"],
            "symbol_actions": {"nvda": "buy", " AMZN ": "sell"},
        }
    ) == ["AAPL", "AMZN", "MSFT", "NVDA"]
