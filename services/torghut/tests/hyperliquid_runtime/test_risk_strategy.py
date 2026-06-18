from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.hyperliquid_runtime.config import HyperliquidRuntimeConfig
from app.hyperliquid_runtime.models import (
    FeatureSnapshot,
    RiskState,
    RuntimeDependencyStatus,
)
from app.hyperliquid_runtime.risk import (
    build_order_intent,
    deterministic_cloid,
    evaluate_signal_risk,
)
from app.hyperliquid_runtime.strategy import generate_signal


def _config(**overrides: object) -> HyperliquidRuntimeConfig:
    env = {
        "HYPERLIQUID_RUNTIME_TRADING_ENABLED": "false",
        "HYPERLIQUID_RUNTIME_EXECUTION_NETWORK": "testnet",
    }
    env.update({key: str(value) for key, value in overrides.items()})
    return HyperliquidRuntimeConfig.from_env(env)


def _feature() -> FeatureSnapshot:
    return FeatureSnapshot(
        market_id="hl:perp:cash:cash:AAPL",
        coin="cash:AAPL",
        dex="cash",
        event_ts=datetime(2026, 6, 18, tzinfo=timezone.utc),
        price=Decimal("200"),
        momentum_1m_bps=Decimal("3"),
        momentum_3m_bps=Decimal("7"),
        momentum_5m_bps=Decimal("12"),
        momentum_15m_bps=Decimal("20"),
        momentum_1h_bps=Decimal("45"),
        volatility_bps=Decimal("60"),
        vwap_distance_bps=Decimal("5"),
        spread_bps=Decimal("4"),
        book_imbalance=Decimal("0.10"),
        liquidity_usd=Decimal("500000"),
        funding_rate=Decimal("0.0001"),
        open_interest_usd=Decimal("1000000"),
        regime="trend",
        source_lag_seconds=10,
    )


def test_signal_and_risk_build_tiny_ioc_intent() -> None:
    config = _config(
        HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
        HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111",
        HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY=(
            "0x2222222222222222222222222222222222222222222222222222222222222222"
        ),
    )
    signal = generate_signal(_feature(), parameter_version="test-v1")
    state = RiskState(
        gross_exposure_usd=Decimal("90"),
        daily_realized_pnl_usd=Decimal("0"),
        open_order_markets=frozenset(),
        dependencies=(
            RuntimeDependencyStatus("clickhouse", True),
            RuntimeDependencyStatus("exchange", True),
        ),
    )

    verdict = evaluate_signal_risk(signal, state, config)
    intent = build_order_intent(
        signal=signal, verdict=verdict, config=config, decision_id="decision-1"
    )

    assert verdict.allowed
    assert verdict.order_notional_usd == Decimal("10")
    assert intent.side == "buy"
    assert intent.limit_price == Decimal("200.300000")
    assert intent.cloid.startswith("0x")
    assert len(intent.cloid) == 34


def test_risk_blocks_shadow_mode_before_order_path() -> None:
    signal = generate_signal(_feature(), parameter_version="test-v1")
    state = RiskState(
        gross_exposure_usd=Decimal("0"),
        daily_realized_pnl_usd=Decimal("0"),
        open_order_markets=frozenset(),
        dependencies=(
            RuntimeDependencyStatus("clickhouse", True),
            RuntimeDependencyStatus("exchange", True),
        ),
    )

    verdict = evaluate_signal_risk(signal, state, _config())

    assert not verdict.allowed
    assert verdict.reason == "trading_disabled_shadow"
    assert verdict.order_notional_usd == Decimal("0")


def test_risk_blocks_mainnet_execution_config() -> None:
    signal = generate_signal(_feature(), parameter_version="test-v1")
    state = RiskState(
        gross_exposure_usd=Decimal("0"),
        daily_realized_pnl_usd=Decimal("0"),
        open_order_markets=frozenset(),
        dependencies=(RuntimeDependencyStatus("clickhouse", True),),
    )

    verdict = evaluate_signal_risk(
        signal,
        state,
        _config(HYPERLIQUID_RUNTIME_EXECUTION_NETWORK="mainnet"),
    )

    assert not verdict.allowed
    assert "execution_network_must_be_testnet" in verdict.reason


def test_risk_blocks_stale_dependency_and_duplicate_market() -> None:
    config = _config(
        HYPERLIQUID_RUNTIME_TRADING_ENABLED="true",
        HYPERLIQUID_RUNTIME_ACCOUNT_ADDRESS="0x1111111111111111111111111111111111111111",
        HYPERLIQUID_RUNTIME_API_WALLET_PRIVATE_KEY=(
            "0x2222222222222222222222222222222222222222222222222222222222222222"
        ),
    )
    signal = generate_signal(_feature(), parameter_version="test-v1")
    state = RiskState(
        gross_exposure_usd=Decimal("0"),
        daily_realized_pnl_usd=Decimal("0"),
        open_order_markets=frozenset({signal.market_id}),
        dependencies=(RuntimeDependencyStatus("clickhouse", False, reason="stale"),),
    )

    verdict = evaluate_signal_risk(signal, state, config)

    assert not verdict.allowed
    assert verdict.reason == "dependency_not_ready:clickhouse"


def test_deterministic_cloid_is_stable() -> None:
    first = deterministic_cloid(decision_id="decision", market_id="market", side="buy")
    second = deterministic_cloid(decision_id="decision", market_id="market", side="buy")
    assert first == second
