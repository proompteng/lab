"""Config contract tests for Hyperliquid execution v2."""

from __future__ import annotations

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
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_MARKET_DATA_NETWORK": "mainnet",
            "HYPERLIQUID_EXECUTION_EXECUTION_NETWORK": "testnet",
            "HYPERLIQUID_EXECUTION_TRADE_COINS": "xyz:NVDA,xyz:AMD",
            "HYPERLIQUID_EXECUTION_EXCLUDED_COINS": "SPX",
            "HYPERLIQUID_EXECUTION_ORDER_POLICY": "marketable_ioc",
            "HYPERLIQUID_EXECUTION_MAKER_TIF": "Ioc",
        }
    )

    assert config.validation_errors() == []
    assert config.market_data_network == "mainnet"
    assert config.execution_network == "testnet"
    assert config.trade_coins == ("xyz:NVDA", "xyz:AMD")
    assert config.excluded_coins == ("SPX",)
    assert config.allow_short_entries is False
    assert config.maintenance_reduce_only_close_enabled is False
    assert config.order_policy == "marketable_ioc"
    assert config.effective_order_tif == "Ioc"
    assert config.maker_ttl_seconds == 10

    short_config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES": "true",
            "HYPERLIQUID_EXECUTION_MAINTENANCE_REDUCE_ONLY_CLOSE_ENABLED": "true",
        }
    )
    assert short_config.allow_short_entries is True
    assert short_config.maintenance_reduce_only_close_enabled is True


def test_config_keeps_maker_ttl_as_explicit_compatibility_policy() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ORDER_POLICY": "maker_ttl",
            "HYPERLIQUID_EXECUTION_MAKER_TIF": "Alo",
            "HYPERLIQUID_EXECUTION_MAKER_TTL_SECONDS": "45",
        }
    )

    assert config.validation_errors() == []
    assert config.effective_order_tif == "Alo"
    assert config.maker_ttl_seconds == 45

    bad_tif_config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ORDER_POLICY": "maker_ttl",
            "HYPERLIQUID_EXECUTION_MAKER_TIF": "Ioc",
        }
    )
    assert "maker_tif_must_be_alo_for_maker_ttl" in bad_tif_config.validation_errors()


def test_config_reports_all_strict_contract_blockers() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_TRADING_ENABLED": "true",
            "HYPERLIQUID_EXECUTION_MARKET_DATA_NETWORK": "mainnet",
            "HYPERLIQUID_EXECUTION_EXECUTION_NETWORK": "mainnet",
            "HYPERLIQUID_EXECUTION_EXCHANGE_API_URL": "https://api.hyperliquid.xyz",
            "HYPERLIQUID_EXECUTION_ORDER_POLICY": "post_only",
            "HYPERLIQUID_EXECUTION_MAKER_TTL_SECONDS": "0",
            "HYPERLIQUID_EXECUTION_MAX_OPEN_ORDERS_PER_SYMBOL": "2",
            "HYPERLIQUID_EXECUTION_MAX_ORDER_NOTIONAL_USD": "5",
            "HYPERLIQUID_EXECUTION_MIN_ORDER_NOTIONAL_USD": "6",
            "HYPERLIQUID_EXECUTION_MAX_SYMBOL_EXPOSURE_USD": "4",
            "HYPERLIQUID_EXECUTION_MAX_GROSS_EXPOSURE_USD": "4",
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
    assert "order_policy_must_be_marketable_ioc_or_maker_ttl" in errors
    assert "maker_ttl_seconds_must_be_positive" in errors
    assert "max_open_orders_per_symbol_must_be_one" in errors
    assert "max_order_notional_usd_must_cover_min_order_notional" in errors
    assert "symbol_cap_must_cover_one_order" in errors
    assert "gross_cap_must_cover_one_order" in errors
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
