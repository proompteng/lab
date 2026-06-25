"""Strategy, risk, universe, and order-policy tests for v2."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.hyperliquid_execution.config import HyperliquidExecutionConfig
from app.hyperliquid_execution.models import (
    FeatureSnapshot,
    RiskState,
    RiskVerdict,
    RuntimeDependencyStatus,
)
from app.hyperliquid_execution.order_policy import (
    build_maker_order_intent,
    build_order_intent,
)
from app.hyperliquid_execution.risk import evaluate_signal_risk
from app.hyperliquid_execution.strategy import generate_signal
from app.hyperliquid_execution.universe import (
    UniverseSelectionConfig,
    market_from_catalog_row,
    parse_configured_coin,
    select_configured_markets,
)


def test_universe_uses_configured_equities_and_excludes_spx() -> None:
    rows = [
        _catalog("NVDA", "xyz", "hl:perp:xyz:NVDA", "100"),
        _catalog("AMD", "xyz", "hl:perp:xyz:AMD", "90"),
        _catalog("SPX", "xyz", "hl:perp:xyz:SPX", "1000"),
        _catalog("BTC", "default", "hl:perp:default:BTC", "2000"),
    ]

    markets, details = select_configured_markets(
        rows,
        config=UniverseSelectionConfig(
            market_data_network="mainnet",
            configured_coins=("xyz:NVDA", "xyz:AMD"),
            excluded_coins=("SPX",),
            min_day_notional_volume_usd=Decimal("0"),
            max_markets=10,
        ),
    )

    assert [market.coin for market in markets] == ["NVDA", "AMD"]
    assert details["excluded"] == ["SPX"]


def test_universe_handles_parse_and_catalog_edge_cases() -> None:
    assert parse_configured_coin(" ").symbol == ""
    assert parse_configured_coin("nvda").symbol == "NVDA"
    assert (
        market_from_catalog_row(
            {"market_type": "spot", "coin": "NVDA"}, market_data_network="mainnet"
        )
        is None
    )
    assert (
        market_from_catalog_row({"market_type": "perp"}, market_data_network="mainnet")
        is None
    )

    market = market_from_catalog_row(
        {
            "coin": "NVDA",
            "dex": "",
            "payload": '{"dayNtlVlm":"not-a-number","markPx":"bad","midPx":"101"}',
        },
        market_data_network="mainnet",
    )

    assert market is not None
    assert market.market_id == "hl:perp:default:NVDA"
    assert market.day_notional_volume_usd == Decimal("0")
    assert market.mark_price is None
    assert market.mid_price is None

    markets, details = select_configured_markets(
        [
            _catalog("NVDA", "xyz", "hl:perp:xyz:NVDA", "1"),
            _catalog("AMD", "xyz", "hl:perp:xyz:AMD", "100"),
        ],
        config=UniverseSelectionConfig(
            market_data_network="mainnet",
            configured_coins=("abc:NVDA", "xyz:AMD"),
            excluded_coins=(),
            min_day_notional_volume_usd=Decimal("10"),
            max_markets=1,
        ),
    )

    assert [market.coin for market in markets] == ["AMD"]
    assert details["missing_from_feed"] == ["abc:NVDA"]


def test_strategy_holds_below_cost_adjusted_edge() -> None:
    config = HyperliquidExecutionConfig.from_env({})
    feature = _feature(momentum=Decimal("3"), spread=Decimal("2"))

    signal = generate_signal(feature, config)

    assert signal.action == "hold"
    assert signal.reason == "no_edge"


def test_strategy_buys_or_sells_above_cost_adjusted_edge() -> None:
    config = HyperliquidExecutionConfig.from_env({})

    buy_signal = generate_signal(_feature(momentum=Decimal("12")), config)
    sell_signal = generate_signal(_feature(momentum=Decimal("-12")), config)

    assert buy_signal.action == "buy"
    assert sell_signal.action == "sell"


def test_risk_blocks_disabled_stale_open_order_caps_cooldown_and_missing_quotes() -> (
    None
):
    config = HyperliquidExecutionConfig.from_env({})
    dependency = RuntimeDependencyStatus("feed", True)
    base_state = RiskState(
        trading_enabled=True,
        dependencies=(dependency,),
        gross_exposure_usd=Decimal("0"),
        daily_realized_pnl_usd=Decimal("0"),
        open_order_coins=frozenset(),
        symbol_exposure_usd_by_coin={},
        cooldown_reason_by_coin={},
    )
    signal = generate_signal(_feature(momentum=Decimal("12")), config)

    assert evaluate_signal_risk(signal, base_state, config).allowed
    assert not evaluate_signal_risk(
        signal,
        base_state.__class__(**{**base_state.__dict__, "trading_enabled": False}),
        config,
    ).allowed
    assert not evaluate_signal_risk(
        signal,
        base_state.__class__(
            **{**base_state.__dict__, "open_order_coins": frozenset({"NVDA"})}
        ),
        config,
    ).allowed
    assert not evaluate_signal_risk(
        signal,
        base_state.__class__(
            **{
                **base_state.__dict__,
                "cooldown_reason_by_coin": {"NVDA": "symbol_reject_cooldown"},
            }
        ),
        config,
    ).allowed
    assert not evaluate_signal_risk(
        signal,
        base_state.__class__(
            **{
                **base_state.__dict__,
                "symbol_exposure_usd_by_coin": {"NVDA": Decimal("25")},
            }
        ),
        config,
    ).allowed
    stale_signal = generate_signal(
        _feature(momentum=Decimal("12"), source_lag=999), config
    )
    assert not evaluate_signal_risk(stale_signal, base_state, config).allowed


def test_risk_blocks_short_entries_by_default() -> None:
    config = HyperliquidExecutionConfig.from_env({})
    short_config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES": "true"}
    )
    state = _risk_state()
    sell_signal = generate_signal(_feature(momentum=Decimal("-12")), config)

    blocked = evaluate_signal_risk(sell_signal, state, config)
    allowed = evaluate_signal_risk(sell_signal, state, short_config)

    assert blocked.reason == "short_entries_disabled"
    assert blocked.risk_forecast is not None
    assert blocked.portfolio_target is not None
    assert blocked.portfolio_target.clip_reason == "short_entries_disabled"
    assert blocked.portfolio_target.target_notional_usd == Decimal("0")
    assert allowed.allowed


def test_restore_order_policy_uses_ioc_crossing_quote_and_ttl() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES": "true"}
    )
    now = datetime(2026, 6, 19, tzinfo=timezone.utc)
    buy_signal = generate_signal(
        _feature(momentum=Decimal("12"), bid=Decimal("10"), ask=Decimal("10.02")),
        config,
        now=now,
    )
    sell_signal = generate_signal(
        _feature(momentum=Decimal("-12"), bid=Decimal("10"), ask=Decimal("10.02")),
        config,
        now=now,
    )

    buy_intent = build_order_intent(
        signal=buy_signal,
        verdict=evaluate_signal_risk(buy_signal, _risk_state(), config),
        config=config,
        signal_id="signal-buy",
        now=now,
    )
    sell_intent = build_order_intent(
        signal=sell_signal,
        verdict=evaluate_signal_risk(sell_signal, _risk_state(), config),
        config=config,
        signal_id="signal-sell",
        now=now,
    )

    assert buy_intent.tif == "Ioc"
    assert sell_intent.tif == "Ioc"
    assert buy_intent.limit_price == Decimal("10.02")
    assert sell_intent.limit_price == Decimal("10")
    assert buy_intent.expires_at.timestamp() - now.timestamp() == 10


def test_maker_order_policy_still_uses_alo_bid_ask_when_explicit() -> None:
    config = HyperliquidExecutionConfig.from_env(
        {
            "HYPERLIQUID_EXECUTION_ALLOW_SHORT_ENTRIES": "true",
            "HYPERLIQUID_EXECUTION_ORDER_POLICY": "maker_ttl",
            "HYPERLIQUID_EXECUTION_MAKER_TTL_SECONDS": "45",
        }
    )
    now = datetime(2026, 6, 19, tzinfo=timezone.utc)
    buy_signal = generate_signal(
        _feature(momentum=Decimal("12"), bid=Decimal("10"), ask=Decimal("10.02")),
        config,
        now=now,
    )

    intent = build_maker_order_intent(
        signal=buy_signal,
        verdict=evaluate_signal_risk(buy_signal, _risk_state(), config),
        config=config,
        signal_id="signal-buy",
        now=now,
    )
    active_policy_intent = build_order_intent(
        signal=buy_signal,
        verdict=evaluate_signal_risk(buy_signal, _risk_state(), config),
        config=config,
        signal_id="signal-buy",
        now=now,
    )

    assert intent.tif == "Alo"
    assert intent.limit_price == Decimal("10")
    assert intent.expires_at.timestamp() - now.timestamp() == 45
    assert active_policy_intent.tif == "Alo"
    assert active_policy_intent.limit_price == Decimal("10")


def test_maker_order_policy_rounds_size_up_to_clear_min_notional() -> None:
    config = HyperliquidExecutionConfig.from_env({})
    signal = generate_signal(
        _feature(momentum=Decimal("12"), bid=Decimal("99.5"), ask=Decimal("99.99")),
        config,
    )

    intent = build_order_intent(
        signal=signal,
        verdict=evaluate_signal_risk(signal, _risk_state(), config),
        config=config,
        signal_id="signal-buy",
    )

    assert intent.notional_usd >= config.min_order_notional_usd
    assert intent.size == Decimal("0.1001")


def test_maker_order_policy_rejects_blocked_or_unusable_quotes() -> None:
    config = HyperliquidExecutionConfig.from_env({})
    high_floor_config = HyperliquidExecutionConfig.from_env(
        {"HYPERLIQUID_EXECUTION_MIN_ORDER_NOTIONAL_USD": "100"}
    )
    allowed = RiskVerdict("allowed", "allowed", Decimal("10"))
    blocked = RiskVerdict("blocked", "symbol_cooldown", Decimal("0"))
    signal = generate_signal(_feature(momentum=Decimal("12")), config)

    for candidate_signal, verdict, candidate_config in (
        (signal, blocked, config),
        (
            generate_signal(_feature(momentum=Decimal("-12"), bid=None), config),
            allowed,
            config,
        ),
        (signal, RiskVerdict("allowed", "allowed", Decimal("10")), high_floor_config),
    ):
        try:
            build_order_intent(
                signal=candidate_signal,
                verdict=verdict,
                config=candidate_config,
                signal_id="signal",
            )
        except ValueError:
            continue
        raise AssertionError("unusable order intent should fail")


def _catalog(coin: str, dex: str, market_id: str, volume: str) -> dict[str, object]:
    return {
        "coin": coin,
        "dex": dex,
        "market_id": market_id,
        "market_type": "perp",
        "network": "mainnet",
        "dayNtlVlm": volume,
    }


def _feature(
    *,
    momentum: Decimal,
    spread: Decimal = Decimal("1"),
    bid: Decimal | None = Decimal("10"),
    ask: Decimal | None = Decimal("10.01"),
    source_lag: int = 1,
) -> FeatureSnapshot:
    return FeatureSnapshot(
        market_id="hl:perp:xyz:NVDA",
        coin="NVDA",
        dex="xyz",
        event_ts=datetime.now(timezone.utc),
        price=Decimal("10"),
        momentum_5m_bps=momentum,
        spread_bps=spread,
        liquidity_usd=Decimal("10000"),
        volatility_bps=Decimal("50"),
        book_imbalance=Decimal("0"),
        source_lag_seconds=source_lag,
        bid_price=bid,
        ask_price=ask,
        quote_lag_seconds=1,
    )


def _risk_state() -> RiskState:
    return RiskState(
        trading_enabled=True,
        dependencies=(RuntimeDependencyStatus("feed", True),),
        gross_exposure_usd=Decimal("0"),
        daily_realized_pnl_usd=Decimal("0"),
        open_order_coins=frozenset(),
        symbol_exposure_usd_by_coin={},
        cooldown_reason_by_coin={},
    )
