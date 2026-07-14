"""Config contract tests for Hyperliquid execution v2."""

from __future__ import annotations

from decimal import Decimal

from app.hyperliquid_execution.config import HyperliquidExecutionConfig


def test_config_rejects_old_runtime_prefix() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_RUNTIME_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "false",
        }
    )

    assert "old_hyperliquid_runtime_env_present" in config.validation_errors()


def test_config_accepts_mainnet_data_testnet_execution_contract() -> None:
    assert HyperliquidExecutionConfig.from_env({}).trade_coins == (
        "BTC",
        "ETH",
        "HYPE",
        "SOL",
        "xyz:SKHX",
        "xyz:MU",
        "xyz:XYZ100",
        "xyz:CL",
        "xyz:SNDK",
        "xyz:MSTR",
        "xyz:SILVER",
        "xyz:GOLD",
    )

    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_MARKET_DATA_NETWORK": "mainnet",
            "HYPERLIQUID_EXECUTION_EXECUTION_NETWORK": "testnet",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA,xyz:AMD",
            "HYPERLIQUID_EXECUTION_EXCLUDED_COINS": "SPX",
            "HYPERLIQUID_EXECUTION_ORDER_POLICY": "marketable_ioc",
        }
    )

    assert config.validation_errors() == []
    assert config.market_data_network == "mainnet"
    assert config.execution_network == "testnet"
    assert config.account_label == "hyperliquid-testnet"
    assert config.trade_coins == ("xyz:NVDA", "xyz:AMD")
    assert config.excluded_coins == ("SPX",)
    assert config.allow_short_entries is False
    assert config.maintenance_reduce_only_close_enabled is False
    assert config.order_policy == "marketable_ioc"
    assert config.effective_order_tif == "Ioc"
    assert config.order_ttl_seconds == 10
    assert config.target_margin_utilization == Decimal("0.35")
    assert config.max_symbol_margin_utilization == Decimal("0.08")
    assert config.max_order_margin_utilization == Decimal("0.02")
    assert config.marketable_ioc_slippage_bps == Decimal("0")
    assert config.min_after_cost_edge_bps == Decimal("4")
    assert config.min_edge_cost_ratio == Decimal("2")
    assert config.max_symbol_turnover_equity_multiple_1h == Decimal("1")
    assert config.min_seconds_between_symbol_entries == 300
    assert config.min_seconds_between_side_flip == 900

    short_config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES": "true",
            "HYPERLIQUID_EXECUTION_MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "50",
            "HYPERLIQUID_EXECUTION_MIN_AFTER_COST_EDGE_BPS": "6",
            "HYPERLIQUID_EXECUTION_MIN_EDGE_COST_RATIO": "3",
            "HYPERLIQUID_EXECUTION_MAX_SYMBOL_TURNOVER_EQUITY_MULTIPLE_1H": "0.5",
            "HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES": "60",
            "HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SIDE_FLIP": "120",
        }
    )
    assert short_config.allow_short_entries is True
    assert short_config.maintenance_reduce_only_close_enabled is True
    assert short_config.marketable_ioc_slippage_bps == Decimal("50")
    assert short_config.min_after_cost_edge_bps == Decimal("6")
    assert short_config.min_edge_cost_ratio == Decimal("3")
    assert short_config.max_symbol_turnover_equity_multiple_1h == Decimal("0.5")
    assert short_config.min_seconds_between_symbol_entries == 60
    assert short_config.min_seconds_between_side_flip == 120


def test_config_accepts_feed_readiness_dependency_contract() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_FEED_READINESS_URL": "http://feed/readyz",
            "HYPERLIQUID_EXECUTION_FEED_READINESS_TIMEOUT_SECONDS": "7",
        }
    )

    assert config.feed_readiness_url == "http://feed/readyz"
    assert config.feed_readiness_timeout_seconds == 7


def test_config_rejects_removed_fixed_cap_envs_and_non_ioc_policy() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ORDER_POLICY": "maker_ttl",
            "HYPERLIQUID_EXECUTION_MAX_ORDER_NOTIONAL_USD": "12",
        }
    )

    errors = set(config.validation_errors())

    assert "order_policy_must_be_marketable_ioc" in errors
    assert "removed_fixed_notional_cap_env_present" in errors


def test_config_reports_all_strict_contract_blockers() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_MARKET_DATA_NETWORK": "mainnet",
            "HYPERLIQUID_EXECUTION_EXECUTION_NETWORK": "mainnet",
            "HYPERLIQUID_EXECUTION_EXCHANGE_API_URL": "https://api.hyperliquid.xyz",
            "HYPERLIQUID_EXECUTION_ORDER_POLICY": "post_only",
            "HYPERLIQUID_EXECUTION_ORDER_TTL_SECONDS": "0",
            "HYPERLIQUID_EXECUTION_MAX_OPEN_ORDERS_PER_SYMBOL": "2",
            "HYPERLIQUID_EXECUTION_MIN_ORDER_NOTIONAL_USD": "6",
            "HYPERLIQUID_EXECUTION_TARGET_MARGIN_UTILIZATION": "1.1",
            "HYPERLIQUID_EXECUTION_MAX_SYMBOL_MARGIN_UTILIZATION": "1.2",
            "HYPERLIQUID_EXECUTION_MAX_ORDER_MARGIN_UTILIZATION": "1.3",
            "HYPERLIQUID_EXECUTION_MARKETABLE_IOC_SLIPPAGE_BPS": "-1",
            "HYPERLIQUID_EXECUTION_MIN_AFTER_COST_EDGE_BPS": "-1",
            "HYPERLIQUID_EXECUTION_MIN_EDGE_COST_RATIO": "-1",
            "HYPERLIQUID_EXECUTION_MAX_SYMBOL_TURNOVER_EQUITY_MULTIPLE_1H": "0",
            "HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SYMBOL_ENTRIES": "-1",
            "HYPERLIQUID_EXECUTION_MIN_SECONDS_BETWEEN_SIDE_FLIP": "-1",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "",
            "HYPERLIQUID_EXECUTION_EXCLUDED_COINS": "BTC",
            "HYPERLIQUID_EXECUTION_POLL_INTERVAL_SECONDS": "7",
        }
    )

    errors = set(config.validation_errors())

    assert config.poll_interval_seconds == 7
    assert "execution_network_must_be_testnet" in errors
    assert "exchange_api_url_must_target_testnet" in errors
    assert "account_address_required_when_trading_enabled" in errors
    assert "api_wallet_private_key_required_when_trading_enabled" in errors
    assert "order_policy_must_be_marketable_ioc" in errors
    assert "order_ttl_seconds_must_be_positive" in errors
    assert "max_open_orders_per_symbol_must_be_one" in errors
    assert "target_margin_utilization_must_not_exceed_one" in errors
    assert "symbol_margin_utilization_must_not_exceed_target" in errors
    assert "order_margin_utilization_must_not_exceed_symbol" in errors
    assert "marketable_ioc_slippage_bps_must_be_non_negative" in errors
    assert "min_after_cost_edge_bps_must_be_non_negative" in errors
    assert "min_edge_cost_ratio_must_be_non_negative" in errors
    assert "max_symbol_turnover_equity_multiple_1h_must_be_positive" in errors
    assert "min_seconds_between_symbol_entries_must_be_non_negative" in errors
    assert "min_seconds_between_side_flip_must_be_non_negative" in errors
    assert "trade_coins_required" in errors
    assert "spx_must_be_excluded" in errors


def test_config_rejects_invalid_boolean() -> None:
    try:
        HyperliquidExecutionConfig.from_env(
            {"HYPERLIQUID_EXECUTION_TRADING_ENABLED": "maybe"}
        )
    except ValueError as exc:
        assert str(exc) == "invalid_boolean_env:HYPERLIQUID_EXECUTION_TRADING_ENABLED"
    else:
        raise AssertionError("invalid boolean should fail")
