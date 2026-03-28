"""Shared parameter contract for intraday_tsmom_v1 across runtimes."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Literal, Mapping


@dataclass(frozen=True)
class IntradayTsmomThresholdProfile:
    bullish_hist_min: Decimal
    bullish_hist_cap: Decimal | None
    bearish_hist_min: Decimal
    min_bull_rsi: Decimal
    max_bull_rsi: Decimal
    min_bear_rsi: Decimal | None
    max_bear_rsi: Decimal | None
    vol_floor: Decimal | None
    vol_ceil: Decimal | None
    bearish_hist_cap: Decimal | None
    low_vol_bonus_threshold: Decimal | None
    max_price_above_ema12_bps: Decimal | None
    min_price_below_ema12_bps: Decimal | None
    max_price_below_ema12_bps: Decimal | None


@dataclass(frozen=True)
class IntradayTsmomEvaluation:
    direction: Literal["long", "short"]
    confidence: Decimal
    rationale: tuple[str, ...]
    macd_hist: Decimal
    thresholds: IntradayTsmomThresholdProfile


_ONE_SECOND_PROFILE = IntradayTsmomThresholdProfile(
    bullish_hist_min=Decimal("0.005"),
    bullish_hist_cap=None,
    bearish_hist_min=Decimal("0.004"),
    min_bull_rsi=Decimal("52"),
    max_bull_rsi=Decimal("62"),
    min_bear_rsi=None,
    max_bear_rsi=Decimal("45"),
    vol_floor=Decimal("0"),
    vol_ceil=Decimal("0.00030"),
    bearish_hist_cap=Decimal("0.03"),
    low_vol_bonus_threshold=Decimal("0.00020"),
    max_price_above_ema12_bps=None,
    min_price_below_ema12_bps=None,
    max_price_below_ema12_bps=None,
)

_DEFAULT_PROFILE = IntradayTsmomThresholdProfile(
    bullish_hist_min=Decimal("0.04"),
    bullish_hist_cap=None,
    bearish_hist_min=Decimal("0.06"),
    min_bull_rsi=Decimal("52"),
    max_bull_rsi=Decimal("62"),
    min_bear_rsi=Decimal("66"),
    max_bear_rsi=None,
    vol_floor=Decimal("0.001"),
    vol_ceil=Decimal("0.012"),
    bearish_hist_cap=None,
    low_vol_bonus_threshold=Decimal("0.008"),
    max_price_above_ema12_bps=None,
    min_price_below_ema12_bps=None,
    max_price_below_ema12_bps=None,
)


def validate_intraday_tsmom_params(params: Mapping[str, Any]) -> None:
    for key in (
        "bullish_hist_min",
        "bullish_hist_cap",
        "bearish_hist_min",
        "bearish_hist_cap",
        "vol_floor",
        "vol_ceil",
        "low_vol_bonus_threshold",
        "max_spread_bps",
        "entry_start_minute_utc",
        "entry_end_minute_utc",
        "max_price_above_ema12_bps",
        "min_price_below_ema12_bps",
        "max_price_below_ema12_bps",
        "long_stop_loss_bps",
        "long_stop_loss_spread_bps_multiplier",
        "long_stop_loss_volatility_bps_multiplier",
        "long_trailing_stop_activation_profit_bps",
        "long_trailing_stop_drawdown_bps",
        "long_trailing_stop_spread_bps_multiplier",
        "long_trailing_stop_volatility_bps_multiplier",
    ):
        _validate_optional_decimal_param(
            params=params,
            key=key,
            invalid_error=f"invalid_{key}",
        )
    for key in ("entry_start_minute_utc", "entry_end_minute_utc"):
        _validate_optional_minute_param(
            params=params,
            key=key,
            invalid_error=f"invalid_{key}",
            out_of_range_error=f"{key}_out_of_range",
        )
    for key in ("min_bull_rsi", "max_bull_rsi", "min_bear_rsi", "max_bear_rsi"):
        _validate_optional_rsi_param(
            params=params,
            key=key,
            invalid_error=f"invalid_{key}",
            out_of_range_error=f"{key}_out_of_range",
        )


def resolve_intraday_tsmom_thresholds(
    *,
    params: Mapping[str, Any],
    timeframe: str | None,
) -> IntradayTsmomThresholdProfile:
    validate_intraday_tsmom_params(params)
    profile = _profile_for_timeframe(timeframe)
    return IntradayTsmomThresholdProfile(
        bullish_hist_min=_decimal_param(
            params=params,
            key="bullish_hist_min",
            default=profile.bullish_hist_min,
        ),
        bullish_hist_cap=_optional_decimal_param(
            params=params,
            key="bullish_hist_cap",
            default=profile.bullish_hist_cap,
        ),
        bearish_hist_min=_decimal_param(
            params=params,
            key="bearish_hist_min",
            default=profile.bearish_hist_min,
        ),
        min_bull_rsi=_decimal_param(
            params=params,
            key="min_bull_rsi",
            default=profile.min_bull_rsi,
        ),
        max_bull_rsi=_decimal_param(
            params=params,
            key="max_bull_rsi",
            default=profile.max_bull_rsi,
        ),
        min_bear_rsi=_optional_decimal_param(
            params=params,
            key="min_bear_rsi",
            default=profile.min_bear_rsi,
        ),
        max_bear_rsi=_optional_decimal_param(
            params=params,
            key="max_bear_rsi",
            default=profile.max_bear_rsi,
        ),
        vol_floor=_optional_decimal_param(
            params=params,
            key="vol_floor",
            default=profile.vol_floor,
        ),
        vol_ceil=_optional_decimal_param(
            params=params,
            key="vol_ceil",
            default=profile.vol_ceil,
        ),
        bearish_hist_cap=_optional_decimal_param(
            params=params,
            key="bearish_hist_cap",
            default=profile.bearish_hist_cap,
        ),
        low_vol_bonus_threshold=_optional_decimal_param(
            params=params,
            key="low_vol_bonus_threshold",
            default=profile.low_vol_bonus_threshold,
        ),
        max_price_above_ema12_bps=_optional_decimal_param(
            params=params,
            key="max_price_above_ema12_bps",
            default=profile.max_price_above_ema12_bps,
        ),
        min_price_below_ema12_bps=_optional_decimal_param(
            params=params,
            key="min_price_below_ema12_bps",
            default=profile.min_price_below_ema12_bps,
        ),
        max_price_below_ema12_bps=_optional_decimal_param(
            params=params,
            key="max_price_below_ema12_bps",
            default=profile.max_price_below_ema12_bps,
        ),
    )


def evaluate_intraday_tsmom_signal(
    *,
    timeframe: str | None,
    params: Mapping[str, Any],
    event_ts: str | datetime | None,
    price: Decimal | None,
    spread: Decimal | None,
    ema12: Decimal | None,
    ema26: Decimal | None,
    macd: Decimal | None,
    macd_signal: Decimal | None,
    rsi14: Decimal | None,
    vol_realized_w60s: Decimal | None,
) -> IntradayTsmomEvaluation | None:
    if (
        ema12 is None
        or ema26 is None
        or macd is None
        or macd_signal is None
        or rsi14 is None
        or price is None
    ):
        return None
    if not _within_entry_window(event_ts=event_ts, params=params):
        return None

    thresholds = resolve_intraday_tsmom_thresholds(
        params=params,
        timeframe=timeframe,
    )
    macd_hist = macd - macd_signal
    spread_bps = _spread_bps(price=price, spread=spread)
    trend_up = ema12 > ema26 and macd > macd_signal
    trend_down = ema12 < ema26 and macd < macd_signal
    vol_ok = _volatility_within_budget(
        vol_realized_w60s,
        floor=thresholds.vol_floor,
        ceil=thresholds.vol_ceil,
    )
    max_spread_bps = _optional_decimal_param(
        params=params,
        key='max_spread_bps',
        default=None,
    )
    spread_ok = (
        max_spread_bps is None
        or spread_bps is None
        or spread_bps <= max_spread_bps
    )
    price_not_overextended = _price_within_entry_band(
        price=price,
        ema12=ema12,
        max_price_above_ema12_bps=thresholds.max_price_above_ema12_bps,
        min_price_below_ema12_bps=thresholds.min_price_below_ema12_bps,
        max_price_below_ema12_bps=thresholds.max_price_below_ema12_bps,
    )

    if (
        trend_up
        and vol_ok
        and spread_ok
        and price_not_overextended
        and macd_hist >= thresholds.bullish_hist_min
        and (
            thresholds.bullish_hist_cap is None
            or macd_hist <= thresholds.bullish_hist_cap
        )
        and thresholds.min_bull_rsi <= rsi14 <= thresholds.max_bull_rsi
    ):
        confidence = Decimal("0.64")
        if macd_hist >= thresholds.bullish_hist_min * Decimal("2"):
            confidence += Decimal("0.05")
        if (
            vol_realized_w60s is not None
            and thresholds.low_vol_bonus_threshold is not None
            and vol_realized_w60s <= thresholds.low_vol_bonus_threshold
        ):
            confidence += Decimal("0.03")
        if rsi14 >= thresholds.max_bull_rsi:
            confidence += Decimal("0.02")
        return IntradayTsmomEvaluation(
            direction="long",
            confidence=min(confidence, Decimal("0.84")),
            rationale=(
                "tsmom_trend_up",
                "momentum_confirmed",
                "volatility_within_budget",
            ),
            macd_hist=macd_hist,
            thresholds=thresholds,
        )

    bearish_hist = -macd_hist
    if (
        trend_down
        and spread_ok
        and bearish_hist >= thresholds.bearish_hist_min
        and _rsi_within_bearish_bounds(
            rsi14,
            min_bear_rsi=thresholds.min_bear_rsi,
            max_bear_rsi=thresholds.max_bear_rsi,
        )
    ):
        if thresholds.bearish_hist_cap is not None and bearish_hist > thresholds.bearish_hist_cap:
            return None
        confidence = Decimal("0.62")
        if thresholds.max_bear_rsi is not None and rsi14 <= thresholds.max_bear_rsi:
            confidence += Decimal("0.03")
        elif thresholds.min_bear_rsi is not None and rsi14 >= thresholds.min_bear_rsi + Decimal("6"):
            confidence += Decimal("0.03")
        return IntradayTsmomEvaluation(
            direction="short",
            confidence=min(confidence, Decimal("0.80")),
            rationale=("tsmom_trend_down", "momentum_reversal_exit"),
            macd_hist=macd_hist,
            thresholds=thresholds,
        )

    return None


def _price_within_entry_band(
    *,
    price: Decimal,
    ema12: Decimal,
    max_price_above_ema12_bps: Decimal | None,
    min_price_below_ema12_bps: Decimal | None,
    max_price_below_ema12_bps: Decimal | None,
) -> bool:
    if ema12 <= 0:
        return True
    if price > ema12:
        if max_price_above_ema12_bps is None:
            return True
        price_gap_bps = ((price - ema12) / ema12) * Decimal("10000")
        return price_gap_bps <= max_price_above_ema12_bps

    price_gap_bps = ((ema12 - price) / ema12) * Decimal("10000")
    if min_price_below_ema12_bps is not None and price_gap_bps < min_price_below_ema12_bps:
        return False
    if max_price_below_ema12_bps is not None and price_gap_bps > max_price_below_ema12_bps:
        return False
    return True


def _profile_for_timeframe(timeframe: str | None) -> IntradayTsmomThresholdProfile:
    normalized = _normalize_timeframe(timeframe)
    if normalized == "1sec":
        return _ONE_SECOND_PROFILE
    return _DEFAULT_PROFILE


def _normalize_timeframe(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"1sec", "1s", "pt1s"}:
        return "1sec"
    if normalized in {"1min", "1m", "pt1m"}:
        return "1min"
    return normalized


def _decimal_param(
    *,
    params: Mapping[str, Any],
    key: str,
    default: Decimal,
) -> Decimal:
    resolved = _optional_decimal_param(params=params, key=key, default=default)
    return default if resolved is None else resolved


def _optional_decimal_param(
    *,
    params: Mapping[str, Any],
    key: str,
    default: Decimal | None,
) -> Decimal | None:
    if key not in params:
        return default
    value = _decimal(params.get(key))
    return default if value is None else value


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _minute_param(
    *,
    params: Mapping[str, Any],
    key: str,
) -> int | None:
    raw_value = params.get(key)
    if raw_value is None:
        return None
    try:
        resolved = int(str(raw_value))
    except (TypeError, ValueError):
        return None
    if resolved < 0 or resolved >= 24 * 60:
        return None
    return resolved


def _validate_optional_minute_param(
    *,
    params: Mapping[str, Any],
    key: str,
    invalid_error: str,
    out_of_range_error: str,
) -> None:
    if key not in params:
        return
    raw_value = params.get(key)
    try:
        resolved = int(str(raw_value))
    except (TypeError, ValueError):
        raise ValueError(invalid_error) from None
    if resolved < 0 or resolved >= 24 * 60:
        raise ValueError(out_of_range_error)


def _within_entry_window(
    *,
    event_ts: str | datetime | None,
    params: Mapping[str, Any],
) -> bool:
    if not event_ts:
        return True
    entry_start_minute = _minute_param(
        params=params,
        key="entry_start_minute_utc",
    )
    entry_end_minute = _minute_param(
        params=params,
        key="entry_end_minute_utc",
    )
    if entry_start_minute is None and entry_end_minute is None:
        return True
    if isinstance(event_ts, datetime):
        event_dt = event_ts
    else:
        try:
            event_dt = datetime.fromisoformat(event_ts.replace("Z", "+00:00"))
        except ValueError:
            return False
    if event_dt.tzinfo is None:
        event_dt = event_dt.replace(tzinfo=timezone.utc)
    event_dt = event_dt.astimezone(timezone.utc)
    minute_of_day = event_dt.hour * 60 + event_dt.minute
    if entry_start_minute is not None and minute_of_day < entry_start_minute:
        return False
    if entry_end_minute is not None and minute_of_day > entry_end_minute:
        return False
    return True


def _validate_optional_decimal_param(
    *,
    params: Mapping[str, Any],
    key: str,
    invalid_error: str,
) -> None:
    if key not in params:
        return
    if _decimal(params.get(key)) is None:
        raise ValueError(invalid_error)


def _validate_optional_rsi_param(
    *,
    params: Mapping[str, Any],
    key: str,
    invalid_error: str,
    out_of_range_error: str,
) -> None:
    if key not in params:
        return
    value = _decimal(params.get(key))
    if value is None:
        raise ValueError(invalid_error)
    if value < 0 or value > 100:
        raise ValueError(out_of_range_error)


def _volatility_within_budget(
    volatility: Decimal | None,
    *,
    floor: Decimal | None,
    ceil: Decimal | None,
) -> bool:
    if volatility is None:
        return True
    if floor is not None and volatility < floor:
        return False
    if ceil is not None and volatility > ceil:
        return False
    return True


def _spread_bps(
    *,
    price: Decimal,
    spread: Decimal | None,
) -> Decimal | None:
    if spread is None or spread <= 0 or price <= 0:
        return None
    return (spread / price) * Decimal('10000')


def _rsi_within_bearish_bounds(
    rsi14: Decimal,
    *,
    min_bear_rsi: Decimal | None,
    max_bear_rsi: Decimal | None,
) -> bool:
    if min_bear_rsi is not None and rsi14 < min_bear_rsi:
        return False
    if max_bear_rsi is not None and rsi14 > max_bear_rsi:
        return False
    return True


__all__ = [
    "IntradayTsmomEvaluation",
    "IntradayTsmomThresholdProfile",
    "evaluate_intraday_tsmom_signal",
    "resolve_intraday_tsmom_thresholds",
    "validate_intraday_tsmom_params",
]
