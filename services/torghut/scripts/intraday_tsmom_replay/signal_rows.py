from __future__ import annotations

import csv

import time as time_mod

from dataclasses import dataclass

from app.trading.discovery.replay_tape import (
    load_replay_tape,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)
from app.trading.models import SignalEnvelope

from app.trading.quote_quality import (
    QuoteQualityStatus,
)

from app.trading.session_context import (
    is_regular_equities_session_date,
    regular_session_close_utc_for,
    regular_session_open_utc_for,
)

from datetime import (
    datetime,
    timedelta,
    timezone,
)

from decimal import Decimal

from typing import (
    Any,
    Iterable,
    Mapping,
)

from .replay_types import (
    DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS,
    ReplayConfig,
    _decimal_text,
    logger,
)

from .strategy_loading import _http_query


@dataclass(frozen=True)
class FetchChunkRequest:
    http_url: str
    username: str | None
    password: str | None
    chunk_start: datetime
    chunk_end: datetime
    timeout_seconds: int = DEFAULT_CLICKHOUSE_QUERY_TIMEOUT_SECONDS
    symbols: tuple[str, ...] = ()


@dataclass(frozen=True)
class _SignalRowParts:
    symbol: str
    event_ts: str
    seq: str
    macd: str
    macd_signal: str
    ema12: str
    ema26: str
    rsi14: str
    price: str
    bid_px: str
    ask_px: str
    spread: str
    bid_sz: str
    ask_sz: str
    imbalance_spread: str
    vwap_session: str
    vwap_w5m: str
    vol: str
    microbar_volume: str


def _iter_signal_rows(config: ReplayConfig) -> Iterable[SignalEnvelope]:
    if config.replay_tape_path is not None:
        yield from _iter_signal_rows_from_replay_tape(config)
        return

    chunk_delta = timedelta(minutes=config.chunk_minutes)
    current_day = config.start_date
    while current_day <= config.end_date:
        if not is_regular_equities_session_date(current_day):
            reason = "weekend" if current_day.weekday() >= 5 else "market_holiday"
            logger.info(
                "replay_day_skip day=%s reason=%s", current_day.isoformat(), reason
            )
            current_day += timedelta(days=1)
            continue
        session_start = regular_session_open_utc_for(current_day)
        session_end = regular_session_close_utc_for(current_day)
        logger.info(
            "replay_day_fetch_start day=%s session_start=%s session_end=%s",
            current_day.isoformat(),
            session_start.isoformat(),
            session_end.isoformat(),
        )
        chunk_start = session_start
        while chunk_start < session_end:
            chunk_end = min(chunk_start + chunk_delta, session_end)
            fetch_started_at = time_mod.monotonic()
            logger.debug(
                "replay_chunk_fetch_start day=%s chunk_start=%s chunk_end=%s symbol_count=%s",
                current_day.isoformat(),
                chunk_start.isoformat(),
                chunk_end.isoformat(),
                len(config.symbols),
            )
            rows = _fetch_chunk(
                FetchChunkRequest(
                    http_url=config.clickhouse_http_url,
                    username=config.clickhouse_username,
                    password=config.clickhouse_password,
                    timeout_seconds=config.clickhouse_query_timeout_seconds,
                    chunk_start=chunk_start,
                    chunk_end=chunk_end,
                    symbols=config.symbols,
                )
            )
            logger.debug(
                "replay_chunk_fetch_done day=%s chunk_start=%s chunk_end=%s rows=%s elapsed_s=%.3f",
                current_day.isoformat(),
                chunk_start.isoformat(),
                chunk_end.isoformat(),
                len(rows),
                time_mod.monotonic() - fetch_started_at,
            )
            rows.sort(key=lambda item: (item.event_ts, item.symbol, item.seq or 0))
            for row in rows:
                yield row
            chunk_start = chunk_end
        current_day += timedelta(days=1)


def _iter_signal_rows_from_replay_tape(
    config: ReplayConfig,
) -> Iterable[SignalEnvelope]:
    if config.replay_tape_path is None:
        return
    tape = load_replay_tape(
        config.replay_tape_path,
        manifest_path=config.replay_tape_manifest_path,
    )
    validation = validate_tape_freshness(
        tape.manifest,
        start_date=config.start_date,
        end_date=config.end_date,
        symbols=config.symbols,
        allow_stale_tape=config.allow_stale_tape,
    )
    logger.info(
        "replay_tape_loaded path=%s rows=%s validation_status=%s stale_override=%s digest=%s",
        config.replay_tape_path,
        tape.manifest.row_count,
        validation["status"],
        validation["stale_override_used"],
        tape.manifest.content_sha256,
    )
    rows = slice_tape_by_window(
        tape.rows,
        start_date=config.start_date,
        end_date=config.end_date,
    )
    rows = slice_tape_by_symbols(rows, symbols=config.symbols)
    for row in rows:
        yield row


def _fetch_chunk(request: FetchChunkRequest) -> list[SignalEnvelope]:
    symbol_filter = ""
    if request.symbols:
        rendered_symbols = ", ".join(f"'{symbol}'" for symbol in request.symbols)
        symbol_filter = f"\n  AND s.symbol IN ({rendered_symbols})"
    query = f"""
SELECT
  s.symbol,
  s.event_ts,
  s.seq,
  toString(s.macd) AS macd,
  toString(s.macd_signal) AS macd_signal,
  toString(s.ema12) AS ema12,
  toString(s.ema26) AS ema26,
  toString(s.rsi14) AS rsi14,
  toString((s.imbalance_bid_px + s.imbalance_ask_px) / 2) AS price,
  toString(s.imbalance_bid_px) AS bid_px,
  toString(s.imbalance_ask_px) AS ask_px,
  toString(s.imbalance_ask_px - s.imbalance_bid_px) AS spread,
  toString(s.imbalance_bid_sz) AS bid_sz,
  toString(s.imbalance_ask_sz) AS ask_sz,
  toString(s.imbalance_spread) AS imbalance_spread,
  toString(s.vwap_session) AS vwap_session,
  toString(s.vwap_w5m) AS vwap_w5m,
  toString(s.vol_realized_w60s) AS vol_realized_w60s,
  toString(m.v) AS microbar_volume
FROM torghut.ta_signals AS s
ANY LEFT JOIN torghut.ta_microbars AS m
  ON s.symbol = m.symbol
  AND s.event_ts = m.event_ts
  AND s.source = m.source
  AND s.window_size = m.window_size
WHERE s.source = 'ta'
  AND s.window_size = 'PT1S'
  AND s.event_ts >= toDateTime64('{request.chunk_start.strftime("%Y-%m-%d %H:%M:%S")}', 3, 'UTC')
  AND s.event_ts < toDateTime64('{request.chunk_end.strftime("%Y-%m-%d %H:%M:%S")}', 3, 'UTC')
  {symbol_filter}
  AND isNotNull(s.imbalance_bid_px)
  AND isNotNull(s.imbalance_ask_px)
FORMAT TSVRaw
""".strip()
    raw = _http_query(
        url=request.http_url,
        username=request.username,
        password=request.password,
        timeout_seconds=request.timeout_seconds,
        query=query,
    )
    reader = csv.reader(raw.splitlines(), delimiter="\t")
    rows: list[SignalEnvelope] = []
    for parts in reader:
        parsed = _parse_signal_row(parts)
        if parsed is not None:
            rows.append(parsed)
    return rows


def _parse_signal_row(parts: list[str]) -> SignalEnvelope | None:
    if len(parts) != 19:
        return None
    row = _SignalRowParts(*parts)
    return SignalEnvelope(
        event_ts=_parse_clickhouse_ts(row.event_ts),
        symbol=row.symbol,
        timeframe="1Sec",
        seq=int(row.seq),
        source="ta",
        payload=_signal_payload(row),
    )


def _signal_payload(row: _SignalRowParts) -> dict[str, Any]:
    price_value = _to_decimal(row.price)
    bid_px_value = _to_decimal(row.bid_px)
    ask_px_value = _to_decimal(row.ask_px)
    spread_value = _to_decimal(row.spread)
    bid_sz_value = _to_decimal(row.bid_sz)
    ask_sz_value = _to_decimal(row.ask_sz)
    imbalance_spread_value = _to_decimal(row.imbalance_spread)
    payload = {
        "macd": _to_decimal(row.macd),
        "macd_signal": _to_decimal(row.macd_signal),
        "ema12": _to_decimal(row.ema12),
        "ema26": _to_decimal(row.ema26),
        "rsi14": _to_decimal(row.rsi14),
        "rsi": _to_decimal(row.rsi14),
        "price": price_value,
        "vwap_session": _to_decimal(row.vwap_session),
        "vwap_w5m": _to_decimal(row.vwap_w5m),
        "vol_realized_w60s": _to_decimal(row.vol),
        "microbar_volume": _to_decimal(row.microbar_volume),
        "imbalance_bid_px": bid_px_value,
        "imbalance_ask_px": ask_px_value,
        "imbalance_bid_sz": bid_sz_value,
        "imbalance_ask_sz": ask_sz_value,
        "imbalance_spread": imbalance_spread_value,
        "imbalance": {
            "bid_px": bid_px_value,
            "ask_px": ask_px_value,
            "bid_sz": bid_sz_value,
            "ask_sz": ask_sz_value,
            "spread": imbalance_spread_value
            if imbalance_spread_value is not None
            else spread_value,
        },
        "spread": spread_value,
        "spread_bps": (
            (spread_value / price_value) * Decimal("10000")
            if spread_value is not None and price_value is not None and price_value > 0
            else None
        ),
        "window_size": "PT1S",
        "window_step": "PT1S",
    }
    return payload


def _parse_clickhouse_ts(value: str) -> datetime:
    normalized = value.replace(" ", "T")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _to_decimal(value: str) -> Decimal | None:
    stripped = value.strip()
    if not stripped or stripped == "\\N":
        return None
    return Decimal(stripped)


def _extract_spread(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get("spread")
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_bid(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get("imbalance_bid_px")
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_ask(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get("imbalance_ask_px")
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_decimal_payload(signal: SignalEnvelope, key: str) -> Decimal | None:
    raw = signal.payload.get(key)
    if isinstance(raw, Decimal):
        return raw
    if raw is None:
        return None
    return Decimal(str(raw))


def _extract_price(signal: SignalEnvelope) -> Decimal:
    raw = signal.payload.get("price")
    if isinstance(raw, Decimal):
        return raw
    return Decimal(str(raw))


def _extract_volatility(signal: SignalEnvelope) -> Decimal | None:
    raw = signal.payload.get("vol_realized_w60s")
    if raw is None:
        return None
    if isinstance(raw, Decimal):
        return raw
    return Decimal(str(raw))


def _signal_spread_bps(
    *, signal: SignalEnvelope, price: Decimal | None = None
) -> Decimal | None:
    resolved_price = _extract_price(signal) if price is None else price
    if resolved_price <= 0:
        return None
    spread = _extract_spread(signal)
    if spread is None:
        return None
    return (abs(spread) / resolved_price) * Decimal("10000")


def _signal_mid_jump_bps(
    *, price: Decimal, reference_price: Decimal | None
) -> Decimal | None:
    if reference_price is None or reference_price <= 0:
        return None
    return (abs(price - reference_price) / reference_price) * Decimal("10000")


def _log_quote_skipped(
    *,
    signal: SignalEnvelope,
    status: QuoteQualityStatus,
    has_open_position: bool,
    has_pending_order: bool,
) -> None:
    logger.debug(
        "replay_quote_skipped ts=%s symbol=%s reason=%s spread_bps=%s jump_bps=%s open_position=%s pending_order=%s",
        signal.event_ts.isoformat(),
        signal.symbol,
        status.reason or "unknown",
        _decimal_text(status.spread_bps) if status.spread_bps is not None else "None",
        _decimal_text(status.jump_bps) if status.jump_bps is not None else "None",
        has_open_position,
        has_pending_order,
    )


def _positive_decimal_mapping_value(
    bucket: Mapping[str, Any] | None, key: str
) -> Decimal | None:
    if bucket is None:
        return None
    raw = bucket.get(key)
    if isinstance(raw, Decimal):
        value = raw
    elif raw is None:
        return None
    else:
        try:
            value = Decimal(str(raw))
        except (ArithmeticError, ValueError):
            return None
    return value if value > 0 else None


def _observed_adv_notional(
    *,
    signal: SignalEnvelope,
    day_bucket: Mapping[str, Any] | None = None,
    symbol_bucket: Mapping[str, Any] | None = None,
) -> Decimal | None:
    return _observed_adv_notional_with_source(
        signal=signal,
        day_bucket=day_bucket,
        symbol_bucket=symbol_bucket,
    )[0]


def _observed_adv_notional_with_source(
    *,
    signal: SignalEnvelope,
    day_bucket: Mapping[str, Any] | None = None,
    symbol_bucket: Mapping[str, Any] | None = None,
) -> tuple[Decimal | None, str | None]:
    for source, bucket in (
        ("symbol_bucket.daily_adv_notional", symbol_bucket),
        ("day_bucket.daily_adv_notional", day_bucket),
    ):
        value = _positive_decimal_mapping_value(bucket, "daily_adv_notional")
        if value is not None:
            return value, source
    for key in ("daily_adv_notional", "adv_notional", "adv", "avg_dollar_volume"):
        value = _positive_decimal_mapping_value(signal.payload, key)
        if value is not None and value > 0:
            return value, f"signal_payload.{key}"
    return None, None
