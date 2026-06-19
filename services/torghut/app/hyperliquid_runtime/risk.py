"""Strict risk gates for the Hyperliquid testnet runtime."""

from __future__ import annotations

import hashlib
from datetime import datetime, time, timezone
from decimal import Decimal, ROUND_DOWN
from zoneinfo import ZoneInfo

from .config import HyperliquidRuntimeConfig
from .models import FeatureSnapshot, OrderIntent, RiskState, RiskVerdict, Signal
from .universe import classify_asset


_EQUITY_LIKE_ASSET_CLASSES = frozenset({"stocks", "indices", "preipo"})
_US_EQUITY_TIMEZONE = ZoneInfo("America/New_York")
_US_CASH_SESSION_START = time(9, 30)
_US_CASH_SESSION_END = time(16, 0)


def evaluate_signal_risk(
    signal: Signal,
    state: RiskState,
    config: HyperliquidRuntimeConfig,
    *,
    now: datetime | None = None,
) -> RiskVerdict:
    """Block anything that is stale, over cap, duplicate, or not actionable."""

    blocked_reason = _blocked_reason(signal, state, config, now=now)
    if blocked_reason is not None:
        return _blocked(blocked_reason)
    remaining_exposure = config.max_gross_exposure_usd - state.gross_exposure_usd
    if remaining_exposure <= Decimal("0"):
        return _blocked("gross_exposure_cap")
    if remaining_exposure < config.min_order_notional_usd:
        return _blocked("remaining_exposure_below_min_order_notional")
    notional = min(config.max_order_notional_usd, remaining_exposure)
    return RiskVerdict("allowed", "allowed", notional)


def build_order_intent(
    *,
    signal: Signal,
    verdict: RiskVerdict,
    config: HyperliquidRuntimeConfig,
    decision_id: str,
) -> OrderIntent:
    """Create a deterministic IOC limit order intent from an allowed decision."""

    if not verdict.allowed:
        raise ValueError(f"risk_verdict_blocked:{verdict.reason}")
    side = "buy" if signal.action == "buy" else "sell"
    price = _limit_price(
        signal.feature, side=side, max_slippage_bps=config.max_slippage_bps
    )
    size = _order_size(verdict.order_notional_usd, price, config.min_order_size)
    return OrderIntent(
        market_id=signal.market_id,
        coin=signal.coin,
        dex=signal.feature.dex,
        side=side,
        size=size,
        limit_price=price,
        notional_usd=(price * size).quantize(Decimal("0.000001")),
        cloid=deterministic_cloid(
            decision_id=decision_id, market_id=signal.market_id, side=side
        ),
        reduce_only=False,
        decision_id=decision_id,
    )


def deterministic_cloid(
    *,
    decision_id: str,
    market_id: str,
    side: str,
) -> str:
    """Return a 128-bit client order id in Hyperliquid hex form."""

    digest = hashlib.sha256(
        f"{decision_id}\0{market_id}\0{side}".encode("utf-8")
    ).hexdigest()
    return f"0x{digest[:32]}"


def _limit_price(
    feature: FeatureSnapshot,
    *,
    side: str,
    max_slippage_bps: Decimal,
) -> Decimal:
    touch_price = feature.ask_price if side == "buy" else feature.bid_price
    if touch_price is None:
        raise ValueError("missing_executable_quote")
    multiplier = Decimal("1") + (max_slippage_bps / Decimal("10000"))
    if side == "sell":
        multiplier = Decimal("1") - (max_slippage_bps / Decimal("10000"))
    return (touch_price * multiplier).quantize(Decimal("0.000001"))


def _order_size(
    notional: Decimal,
    price: Decimal,
    min_order_size: Decimal,
) -> Decimal:
    if price <= Decimal("0"):
        raise ValueError("feature_price_must_be_positive")
    size = (notional / price).quantize(min_order_size, rounding=ROUND_DOWN)
    if size < min_order_size:
        raise ValueError("order_size_below_minimum")
    return size


def _blocked(reason: str) -> RiskVerdict:
    return RiskVerdict("blocked", reason, Decimal("0"))


def _blocked_reason(
    signal: Signal,
    state: RiskState,
    config: HyperliquidRuntimeConfig,
    *,
    now: datetime | None = None,
) -> str | None:
    config_errors = config.validation_errors()
    dependency_blockers = sorted(
        dependency.name for dependency in state.dependencies if not dependency.ready
    )
    quote_blocker = _quote_blocked_reason(signal.feature, config)
    observed_at = now or datetime.now(timezone.utc)
    checks = (
        (bool(config_errors), ",".join(config_errors)),
        (not config.trading_enabled, "trading_disabled_shadow"),
        (signal.action not in {"buy", "sell"}, f"signal_{signal.action}"),
        (
            signal.feature.source_lag_seconds > config.signal_staleness_seconds,
            "signal_stale",
        ),
        (
            bool(dependency_blockers),
            f"dependency_not_ready:{','.join(dependency_blockers)}",
        ),
        (signal.market_id in state.open_order_markets, "open_order_exists_for_market"),
        (state.daily_realized_pnl_usd <= -config.max_daily_loss_usd, "daily_loss_stop"),
        (quote_blocker is not None, quote_blocker or ""),
        (
            _equity_like_market_session_closed(signal, observed_at),
            "equity_like_market_session_closed",
        ),
    )
    return next((reason for blocked, reason in checks if blocked), None)


def _quote_blocked_reason(
    feature: FeatureSnapshot,
    config: HyperliquidRuntimeConfig,
) -> str | None:
    bid = feature.bid_price
    ask = feature.ask_price
    checks = (
        (bid is None and ask is None, "missing_executable_quote"),
        (bid is None, "missing_bid"),
        (ask is None, "missing_ask"),
        (bid is not None and bid <= Decimal("0"), "non_positive_bid"),
        (ask is not None and ask <= Decimal("0"), "non_positive_ask"),
        (bid is not None and ask is not None and ask < bid, "crossed_quote"),
        (feature.quote_lag_seconds is None, "missing_executable_quote_timestamp"),
        (
            feature.quote_lag_seconds is not None
            and feature.quote_lag_seconds > config.signal_staleness_seconds,
            "executable_quote_stale",
        ),
    )
    return next((reason for blocked, reason in checks if blocked), None)


def _equity_like_market_session_closed(signal: Signal, now: datetime) -> bool:
    asset_class = classify_asset(coin=signal.coin, dex=signal.feature.dex)
    if asset_class not in _EQUITY_LIKE_ASSET_CLASSES:
        return False
    observed = now.astimezone(_US_EQUITY_TIMEZONE)
    if observed.weekday() >= 5:
        return True
    current = observed.time()
    return not (_US_CASH_SESSION_START <= current < _US_CASH_SESSION_END)
