from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.exc import SQLAlchemyError

from app.api import trading_loop_status as trading_loop_status_api
from app.trading import loop_status as loop_status_module

from app.trading.loop_status import (
    LoopStatusOptions,
    LoopStatusRows,
    assemble_trading_loop_status,
    build_trading_loop_status,
    load_trading_loop_status_rows,
)


def test_loop_status_requires_real_execution_proof() -> None:
    now = datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc)
    rows = LoopStatusRows(
        latest_cycle={
            "finished_at": now.isoformat(),
            "selected_coins": ["AMD"],
        },
        latest_signal={
            "generated_at": now.isoformat(),
            "feature_event_ts": now.isoformat(),
            "feature_source_lag_seconds": 1,
            "feature_quote_lag_seconds": 1,
            "coin": "AMD",
            "action": "buy",
            "edge_bps": "12.5",
            "reason": "test_signal",
        },
        latest_order={
            "created_at": now.isoformat(),
            "coin": "AMD",
            "cloid": "loop-proof-1",
            "exchange_order_id": "12345",
            "side": "buy",
            "status": "filled",
            "notional_usd": "10",
        },
        counts_24h={
            "cycles_24h": 3,
            "signals_24h": 3,
            "orders_24h": 3,
            "fills_24h": 3,
            "account_snapshots_24h": 3,
        },
        fill_summary={
            "fills_24h": 3,
            "notional_usd_24h": "30",
            "fees_usd_24h": "0.03",
            "net_pnl_after_fees_usd_24h": "0.12",
        },
        latest_fill={
            "event_ts": now.isoformat(),
            "coin": "AMD",
            "fill_hash": "fill-1",
            "exchange_order_id": "12345",
            "side": "buy",
            "notional_usd": "10",
            "fee_usd": "0.01",
            "closed_pnl_usd": "0.05",
        },
        latest_account={
            "observed_at": now.isoformat(),
            "raw_payload": {"assetPositions": []},
        },
        positions=[],
        performance={"fill_count_24h": 3, "sample_ready": False},
        stale_open_orders=[],
        unexpected_live_alpaca={"orders_24h": 0, "events_24h": 0},
        query_errors=[],
        latest_multifactor_run={
            "id": "cycle-1",
            "lane": "hyperliquid_testnet",
            "model_version": "active-portfolio-management-v1",
            "finished_at": now.isoformat(),
        },
        latest_factor_snapshot={
            "run_id": "cycle-1",
            "asset_key": "hyperliquid:hl:perp:default:AMD",
            "source_lag_seconds": 1,
            "quote_lag_seconds": 1,
            "raw_factors": {"momentum_5m": "12"},
            "normalized_factors": {"momentum_5m": "3.0000"},
        },
        latest_forecast={
            "run_id": "cycle-1",
            "asset_key": "hyperliquid:hl:perp:default:AMD",
            "model_id": "active-portfolio-management-v1",
            "score": "3.0000",
            "residual_volatility_bps": "50",
            "information_coefficient": "0.05",
            "expected_return_bps": "8",
            "direction": "buy",
        },
        latest_risk_forecast={
            "run_id": "cycle-1",
            "asset_key": "hyperliquid:hl:perp:default:AMD",
            "active_risk_bps": "1",
            "gross_exposure_usd": "0",
            "symbol_exposure_usd": "0",
            "liquidity_capacity_usd": "10",
            "concentration_bps": "0",
        },
        latest_portfolio_target={
            "run_id": "cycle-1",
            "asset_key": "hyperliquid:hl:perp:default:AMD",
            "direction": "buy",
            "target_notional_usd": "10",
            "delta_notional_usd": "10",
            "expected_return_bps": "8",
            "expected_cost_bps": "4",
            "active_risk_bps": "1",
            "risk_buffer_bps": "1",
        },
        latest_execution_intent={
            "run_id": "cycle-1",
            "asset_key": "hyperliquid:hl:perp:default:AMD",
            "venue": "hyperliquid",
            "side": "buy",
            "notional_usd": "10",
            "idempotency_key": "loop-proof-1",
            "status": "filled",
            "venue_order_id": "12345",
        },
        latest_attribution={
            "run_id": "cycle-1",
            "observed_at": now.isoformat(),
            "fill_count": 3,
            "realized_pnl_usd": "0.12",
            "turnover_usd": "30",
            "realized_cost_usd": "0.03",
            "hit_rate": "1",
        },
    )

    payload = assemble_trading_loop_status(
        rows=rows,
        options=LoopStatusOptions(
            generated_at=now,
            trading_mode="paper",
            trading_enabled=True,
            min_recent_fills=3,
            freshness_threshold_seconds=180,
            account_freshness_seconds=300,
        ),
    )

    assert payload["restored"] is True
    assert payload["blocker_reasons"] == []
    assert payload["fills"]["recent_count"] == 3
    assert payload["alpha_model"]["present"] is True
    assert payload["portfolio_target"]["target_notional_positive"] is True
    assert payload["execution_intent"]["present"] is True
    assert payload["exchange_order_state"]["ack_seen"] is True
    assert payload["alpaca_guard"]["unexpected_live_order_count_24h"] == 0
    assert payload["operator_approval"]["scope"] == "testnet_only"
    assert payload["proof_trading"] == {
        "allowed": True,
        "lane": "hyperliquid_testnet",
        "reason": "testnet_proof_trading_operator_approved",
    }
    assert payload["runtime"]["live_capital"]["allowed"] is False
    assert payload["algorithm"] == {
        "name": "generic_multifactor_apm_v1",
        "run_id": "cycle-1",
        "asset_key": "hyperliquid:hl:perp:default:AMD",
        "factor_snapshot_present": True,
        "forecast_present": True,
        "risk_present": True,
        "target_present": True,
        "intent_present": True,
        "latest_order_id": "12345",
    }
    assert "live_capital" not in ",".join(payload["blocker_reasons"])


def test_loop_status_blocks_ready_runtime_without_fills_or_account_proof() -> None:
    now = datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc)
    rows = LoopStatusRows(
        latest_cycle={"finished_at": now.isoformat(), "selected_coins": ["AMD"]},
        latest_signal={
            "generated_at": now.isoformat(),
            "feature_event_ts": now.isoformat(),
            "feature_source_lag_seconds": 1,
            "feature_quote_lag_seconds": 1,
            "coin": "AMD",
            "action": "buy",
            "edge_bps": "12.5",
            "reason": "test_signal",
        },
        latest_order={},
        counts_24h={},
        fill_summary={"fills_24h": 0},
        latest_fill={},
        latest_account={},
        positions=[],
        performance={},
        stale_open_orders=[],
        unexpected_live_alpaca={"orders_24h": 0, "events_24h": 0},
        query_errors=[],
    )

    payload = assemble_trading_loop_status(
        rows=rows,
        options=LoopStatusOptions(
            generated_at=now,
            trading_mode="paper",
            trading_enabled=True,
            min_recent_fills=3,
            freshness_threshold_seconds=180,
            account_freshness_seconds=300,
        ),
    )

    assert payload["restored"] is False
    assert "hyperliquid_order_submission_missing" in payload["blocker_reasons"]
    assert "hyperliquid_recent_fills_below_floor" in payload["blocker_reasons"]
    assert "hyperliquid_account_snapshot_not_fresh" in payload["blocker_reasons"]


def test_loop_status_reads_rows_with_default_options_and_json_safe_values() -> None:
    payload = build_trading_loop_status(_StaticQuerySession())

    assert payload["schema_version"] == "torghut.trading-loop-status.v1"
    assert payload["runtime"]["selected_symbols"] == ["AMD"]
    assert payload["query_errors"] == []


def test_loop_status_records_independent_query_errors() -> None:
    rows = load_trading_loop_status_rows(_FailingQuerySession())

    assert "latest_cycle_query_failed:SQLAlchemyError" in rows.query_errors
    assert "positions_query_failed:SQLAlchemyError" in rows.query_errors
    assert "stale_open_orders_query_failed:SQLAlchemyError" in rows.query_errors


def test_loop_status_covers_raw_position_and_malformed_value_edges() -> None:
    now = datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc)
    account_observed_at = datetime(2026, 6, 25, 11, 59)
    rows = LoopStatusRows(
        latest_cycle={"finished_at": now, "selected_coins": '["MU", "AMD"]'},
        latest_signal={
            "generated_at": "not-a-date",
            "feature_event_ts": datetime(2026, 6, 25, 11, 59),
            "feature_source_lag_seconds": 1,
            "feature_quote_lag_seconds": 1,
            "coin": "MU",
            "action": "buy",
            "edge_bps": "7",
            "reason": "test_signal",
        },
        latest_order={
            "created_at": "not-a-date",
            "coin": "MU",
            "cloid": "loop-proof-2",
            "exchange_order_id": "",
            "side": "buy",
            "status": "accepted",
            "notional_usd": "10",
        },
        counts_24h={
            "cycles_24h": True,
            "signals_24h": "bad",
            "orders_24h": 1,
            "account_snapshots_24h": 1,
        },
        fill_summary={"fills_24h": True},
        latest_fill={"event_ts": "not-a-date", "coin": "MU"},
        latest_account={
            "observed_at": account_observed_at,
            "raw_payload": (
                '{"assetPositions":["bad-row", {"position": {}}, '
                '{"position": {"coin": "MU", "szi": "1", "entryPx": "10", '
                '"positionValue": "10", "unrealizedPnl": "0.1"}}]}'
            ),
        },
        positions=[{"coin": "MU"}],
        performance={},
        stale_open_orders=[{"coin": "MU", "exchange_order_id": "stale"}],
        unexpected_live_alpaca={"orders_24h": 1, "events_24h": "bad"},
        query_errors=[],
    )

    payload = assemble_trading_loop_status(
        rows=rows,
        options=LoopStatusOptions(
            generated_at=now,
            trading_mode="paper",
            trading_enabled=True,
            min_recent_fills=3,
            freshness_threshold_seconds=180,
            account_freshness_seconds=300,
        ),
    )

    assert payload["runtime"]["selected_symbols"] == ["MU", "AMD"]
    assert payload["position"]["exchange_raw_positions"] == [
        {
            "coin": "MU",
            "entry_price": "10",
            "notional_usd": "10",
            "size": "1",
            "unrealized_pnl_usd": "0.1",
        }
    ]
    assert "hyperliquid_exchange_order_ack_missing" in payload["blocker_reasons"]
    assert "hyperliquid_stale_open_orders_present" in payload["blocker_reasons"]
    assert "unexpected_live_alpaca_orders_present" in payload["blocker_reasons"]
    assert loop_status_module._mapping_payload("{not-json") == {}
    assert loop_status_module._string_list("AMD") == ["AMD"]


def test_loop_status_blocks_future_event_timestamp_with_stale_quote_lag() -> None:
    now = datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc)
    rows = LoopStatusRows(
        latest_cycle={"finished_at": now.isoformat(), "selected_coins": ["BNB"]},
        latest_signal={
            "generated_at": now.isoformat(),
            "feature_event_ts": datetime(2026, 6, 25, 12, 5, tzinfo=timezone.utc),
            "feature_source_lag_seconds": 1,
            "feature_quote_lag_seconds": 240,
            "coin": "BNB",
            "action": "buy",
            "edge_bps": "14",
            "reason": "edge_exceeds_cost",
        },
        latest_order={
            "created_at": now.isoformat(),
            "coin": "BNB",
            "cloid": "loop-proof-bnb",
            "exchange_order_id": "67890",
            "side": "buy",
            "status": "filled",
            "notional_usd": "10",
        },
        counts_24h={
            "cycles_24h": 3,
            "signals_24h": 3,
            "orders_24h": 3,
            "fills_24h": 3,
            "account_snapshots_24h": 3,
        },
        fill_summary={"fills_24h": 3},
        latest_fill={"event_ts": now.isoformat(), "coin": "BNB"},
        latest_account={
            "observed_at": now.isoformat(),
            "raw_payload": {"dexStates": {"default": {"assetPositions": []}}},
        },
        positions=[],
        performance={"fill_count_24h": 3, "sample_ready": False},
        stale_open_orders=[],
        unexpected_live_alpaca={"orders_24h": 0, "events_24h": 0},
        query_errors=[],
    )

    payload = assemble_trading_loop_status(
        rows=rows,
        options=LoopStatusOptions(
            generated_at=now,
            trading_mode="paper",
            trading_enabled=True,
            min_recent_fills=3,
            freshness_threshold_seconds=180,
            account_freshness_seconds=300,
        ),
    )

    assert payload["restored"] is False
    assert payload["market_data"]["fresh"] is False
    assert payload["market_data"]["quote_lag_seconds"] == 240
    assert "hyperliquid_market_data_not_fresh" in payload["blocker_reasons"]


def test_loop_status_anchors_market_data_to_multifactor_proof_snapshot() -> None:
    now = datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc)
    stale_signal_at = datetime(2026, 6, 25, 10, 0, tzinfo=timezone.utc)
    proof_feature_at = datetime(2026, 6, 25, 11, 59, 45, tzinfo=timezone.utc)
    rows = LoopStatusRows(
        latest_cycle={"finished_at": now.isoformat(), "selected_coins": ["BNB"]},
        latest_signal={
            "generated_at": now.isoformat(),
            "feature_event_ts": stale_signal_at.isoformat(),
            "feature_source_lag_seconds": 1,
            "feature_quote_lag_seconds": 9999,
            "coin": "BNB",
            "action": "hold",
            "edge_bps": "0",
            "reason": "old_signal",
        },
        latest_order={
            "created_at": now.isoformat(),
            "coin": "ZRO",
            "cloid": "proof-zro",
            "exchange_order_id": "555",
            "side": "buy",
            "status": "filled",
            "notional_usd": "10",
        },
        counts_24h={
            "cycles_24h": 3,
            "signals_24h": 3,
            "orders_24h": 3,
            "fills_24h": 3,
            "account_snapshots_24h": 3,
        },
        fill_summary={"fills_24h": 3},
        latest_fill={"event_ts": now.isoformat(), "coin": "ZRO"},
        latest_account={
            "observed_at": now.isoformat(),
            "raw_payload": {"dexStates": {"default": {"assetPositions": []}}},
        },
        positions=[],
        performance={"fill_count_24h": 3, "sample_ready": False},
        stale_open_orders=[],
        unexpected_live_alpaca={"orders_24h": 0, "events_24h": 0},
        query_errors=[],
        latest_multifactor_run={
            "id": "run-zro",
            "lane": "hyperliquid_testnet",
            "model_version": "active-portfolio-management-v1",
            "finished_at": now.isoformat(),
        },
        latest_factor_snapshot={
            "run_id": "run-zro",
            "asset_key": "hyperliquid:hl:perp:default:ZRO",
            "symbol": "ZRO",
            "source_event_at": proof_feature_at.isoformat(),
            "source_lag_seconds": 0,
            "quote_lag_seconds": 15,
            "raw_factors": {"momentum_5m": "12"},
            "normalized_factors": {"momentum_5m": "3.0000"},
        },
        latest_forecast={
            "run_id": "run-zro",
            "asset_key": "hyperliquid:hl:perp:default:ZRO",
            "model_id": "active-portfolio-management-v1",
            "score": "3.0000",
            "residual_volatility_bps": "50",
            "information_coefficient": "0.05",
            "expected_return_bps": "8",
            "direction": "buy",
        },
        latest_risk_forecast={
            "run_id": "run-zro",
            "asset_key": "hyperliquid:hl:perp:default:ZRO",
            "active_risk_bps": "1",
            "gross_exposure_usd": "0",
            "symbol_exposure_usd": "0",
            "liquidity_capacity_usd": "10",
            "concentration_bps": "0",
        },
        latest_portfolio_target={
            "run_id": "run-zro",
            "asset_key": "hyperliquid:hl:perp:default:ZRO",
            "direction": "buy",
            "target_notional_usd": "10",
            "delta_notional_usd": "10",
            "expected_return_bps": "8",
            "expected_cost_bps": "4",
            "active_risk_bps": "1",
            "risk_buffer_bps": "1",
        },
        latest_execution_intent={
            "run_id": "run-zro",
            "asset_key": "hyperliquid:hl:perp:default:ZRO",
            "venue": "hyperliquid",
            "side": "buy",
            "notional_usd": "10",
            "idempotency_key": "proof-zro",
            "status": "filled",
            "venue_order_id": "555",
        },
    )

    payload = assemble_trading_loop_status(
        rows=rows,
        options=LoopStatusOptions(
            generated_at=now,
            trading_mode="paper",
            trading_enabled=True,
            min_recent_fills=3,
            freshness_threshold_seconds=180,
            account_freshness_seconds=300,
        ),
    )

    assert payload["restored"] is True
    assert payload["market_data"]["fresh"] is True
    assert payload["market_data"]["selected_symbol"] == "ZRO"
    assert payload["market_data"]["latest_feature_at"] == proof_feature_at.isoformat()
    assert payload["market_data"]["quote_lag_seconds"] == 15
    assert "hyperliquid_market_data_not_fresh" not in payload["blocker_reasons"]


def test_loop_status_reads_nested_hyperliquid_dex_positions() -> None:
    now = datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc)
    rows = LoopStatusRows(
        latest_cycle={"finished_at": now.isoformat(), "selected_coins": ["BNB"]},
        latest_signal={
            "generated_at": now.isoformat(),
            "feature_event_ts": now.isoformat(),
            "feature_source_lag_seconds": 1,
            "feature_quote_lag_seconds": 1,
            "coin": "BNB",
            "action": "buy",
            "edge_bps": "14",
            "reason": "edge_exceeds_cost",
        },
        latest_order={
            "created_at": now.isoformat(),
            "coin": "BNB",
            "cloid": "loop-proof-bnb",
            "exchange_order_id": "67890",
            "side": "buy",
            "status": "filled",
            "notional_usd": "10",
        },
        counts_24h={},
        fill_summary={"fills_24h": 3},
        latest_fill={"event_ts": now.isoformat(), "coin": "BNB"},
        latest_account={
            "observed_at": now.isoformat(),
            "raw_payload": {
                "dexStates": {
                    "xyz": {
                        "assetPositions": [
                            {
                                "position": {
                                    "coin": "xyz:NVDA",
                                    "szi": "0.096",
                                    "entryPx": "209.395",
                                    "positionValue": "19.26528",
                                    "unrealizedPnl": "-0.83664",
                                }
                            }
                        ]
                    }
                }
            },
        },
        positions=[],
        performance={"fill_count_24h": 3, "sample_ready": False},
        stale_open_orders=[],
        unexpected_live_alpaca={"orders_24h": 0, "events_24h": 0},
        query_errors=[],
    )

    payload = assemble_trading_loop_status(
        rows=rows,
        options=LoopStatusOptions(
            generated_at=now,
            trading_mode="paper",
            trading_enabled=True,
            min_recent_fills=3,
            freshness_threshold_seconds=180,
            account_freshness_seconds=300,
        ),
    )

    assert payload["position"]["exchange_raw_positions"] == [
        {
            "coin": "xyz:NVDA",
            "entry_price": "209.395",
            "notional_usd": "19.26528",
            "size": "0.096",
            "unrealized_pnl_usd": "-0.83664",
        }
    ]
    assert payload["position"]["reconciled"] is False
    assert "hyperliquid_position_reconciliation_missing" in payload["blocker_reasons"]


def test_trading_loop_status_route_uses_runtime_settings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    class _SessionContext:
        def __enter__(self) -> "_SessionContext":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

    def fake_build(session: object, *, options: LoopStatusOptions) -> dict[str, object]:
        captured["session"] = session
        captured["options"] = options
        return {"restored": False, "blocker_reasons": ["test"]}

    monkeypatch.setattr(trading_loop_status_api, "SessionLocal", _SessionContext)
    monkeypatch.setattr(
        trading_loop_status_api, "build_trading_loop_status", fake_build
    )
    monkeypatch.setattr(trading_loop_status_api.settings, "trading_mode", "paper")
    monkeypatch.setattr(trading_loop_status_api.settings, "trading_enabled", True)

    response = trading_loop_status_api.trading_loop_status()

    assert response.status_code == 200
    assert isinstance(captured["options"], LoopStatusOptions)
    assert captured["options"].trading_mode == "paper"
    assert captured["options"].trading_enabled is True


class _StaticQueryResult:
    def mappings(self) -> "_StaticQueryResult":
        return self

    def first(self) -> dict[str, object]:
        return {
            "finished_at": datetime(2026, 6, 25, 12, 0, tzinfo=timezone.utc),
            "selected_coins": '["AMD"]',
            "value": Decimal("1.25"),
        }

    def all(self) -> list[dict[str, object]]:
        return [self.first()]


class _StaticQuerySession:
    def execute(
        self,
        _statement: Any,
        _parameters: Any | None = None,
    ) -> _StaticQueryResult:
        return _StaticQueryResult()


class _FailingQuerySession:
    def execute(
        self,
        _statement: Any,
        _parameters: Any | None = None,
    ) -> _StaticQueryResult:
        raise SQLAlchemyError("broken")
