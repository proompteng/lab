# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Signal ingestion from ClickHouse."""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from dataclasses import dataclass, field
from http.client import HTTPConnection, HTTPSConnection
from typing import Any, Mapping, Optional, cast
from urllib.parse import urlencode, urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ...models import TradeCursor
from ..clickhouse import normalize_symbol, to_datetime64
from ..models import SignalEnvelope
from ..simulation import (
    resolve_simulation_context,
    signal_ingest_runtime,
    simulation_context_enabled,
)
from ..simulation_progress import active_simulation_runtime_context
from ..simulation_window import normalize_simulation_cursor, simulation_window_bounds
from ..time_source import trading_now

# ruff: noqa: F401,F403,F405,F811,F821

from .shared_context import (
    ENVELOPE_SIGNAL_COLUMNS,
    FLAT_CURSOR_OVERLAP,
    FLAT_SIGNAL_COLUMNS,
    LATEST_SIGNAL_TS_CACHE_TTL,
    LATEST_SIGNAL_TS_ERROR_LOG_COOLDOWN,
    SIMULATION_CURSOR_BASELINE,
    SignalBatch,
    _ClickHouseSignalIngestorFields,
    _coerce_count,
    _simulation_fetch_window,
    logger,
)
from .clickhouse_signal_ingestor_core_methods import (
    _ClickHouseSignalIngestorCoreMethods,
)
from .clickhouse_signal_ingestor_market_methods import (
    _ClickHouseRequest,
    _ClickHouseSignalIngestorMarketMethods,
    _LatestSignalCacheLookup,
    _column_names_from_rows,
    _latest_signal_timestamp_from_rows,
)


class _ClickHouseSignalIngestorPersistenceMethods:
    def _resolve_time_column(self) -> str:
        if self._time_column:
            return self._time_column
        if self.schema == "flat":
            columns = self._resolve_columns(force=True)
            if columns and "event_ts" in columns:
                self._time_column = "event_ts"
            elif columns and "ts" in columns:
                self._time_column = "ts"
            else:
                self._time_column = "event_ts"
            return self._time_column
        if self.schema == "envelope":
            self._time_column = "event_ts"
            return self._time_column
        columns = self._resolve_columns()
        if columns:
            if "event_ts" in columns:
                self._time_column = "event_ts"
            elif "ts" in columns:
                self._time_column = "ts"
            else:
                self._time_column = "event_ts"
        else:
            self._time_column = "event_ts"
        return self._time_column

    def _get_cursor(
        self, session: Session
    ) -> tuple[datetime, Optional[int], Optional[str]]:
        stmt = select(TradeCursor).where(
            TradeCursor.source == "clickhouse",
            TradeCursor.account_label == self.account_label,
        )
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            cursor_at = cursor_row.cursor_at
            if cursor_at.tzinfo is None:
                cursor_at = cursor_at.replace(tzinfo=timezone.utc)
            if self.simulation_mode and cursor_at <= SIMULATION_CURSOR_BASELINE:
                return trading_now(account_label=self.account_label), None, None
            if self.simulation_mode:
                normalized_cursor = normalize_simulation_cursor(cursor_at)
                if normalized_cursor is not None and normalized_cursor != cursor_at:
                    return normalized_cursor, None, None
            return cursor_at, cursor_row.cursor_seq, cursor_row.cursor_symbol

        if self.simulation_mode:
            return trading_now(account_label=self.account_label), None, None

        lookback = timedelta(minutes=self.initial_lookback_minutes)
        return datetime.now(timezone.utc) - lookback, None, None

    def _set_cursor(
        self,
        session: Session,
        cursor_at: datetime,
        cursor_seq: Optional[int],
        cursor_symbol: Optional[str],
    ) -> None:
        stmt = select(TradeCursor).where(
            TradeCursor.source == "clickhouse",
            TradeCursor.account_label == self.account_label,
        )
        cursor_row = session.execute(stmt).scalar_one_or_none()
        if cursor_row:
            cursor_row.cursor_at = cursor_at
            cursor_row.cursor_seq = cursor_seq
            cursor_row.cursor_symbol = cursor_symbol
            session.add(cursor_row)
        else:
            cursor_row = TradeCursor(
                source="clickhouse",
                account_label=self.account_label,
                cursor_at=cursor_at,
                cursor_seq=cursor_seq,
                cursor_symbol=cursor_symbol,
            )
            session.add(cursor_row)
        session.commit()

    def _supports_seq(self) -> bool:
        if self.schema == "flat":
            return False
        columns = self._resolve_columns(force=True)
        if columns is None:
            return True
        return "seq" in columns

    def _supports_seq_for_time_column(self, time_column: str) -> bool:
        if time_column == "event_ts":
            return self._supports_seq()
        if time_column == "ts":
            columns = self._resolve_columns(force=True)
            if columns is None:
                return False
            return "seq" in columns
        return False


class ClickHouseSignalIngestor(
    _ClickHouseSignalIngestorFields,
    _ClickHouseSignalIngestorCoreMethods,
    _ClickHouseSignalIngestorMarketMethods,
    _ClickHouseSignalIngestorPersistenceMethods,
    object,
):
    pass


def _parse_ts(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if isinstance(value, str):
        cleaned = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(cleaned)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed
    return None


def _coerce_timeframe(row: dict[str, Any], payload: dict[str, Any]) -> Optional[str]:
    window = row.get("window")
    size: Optional[str] = None
    if isinstance(window, dict):
        window_dict = cast(dict[str, Any], window)
        raw_size = window_dict.get("size")
        if isinstance(raw_size, str):
            size = raw_size
    if size is None:
        raw_size = row.get("window_size")
        if isinstance(raw_size, str):
            size = raw_size
    if size is None:
        raw_step = row.get("window_step")
        if isinstance(raw_step, str):
            size = raw_step
    if payload:
        timeframe = payload.get("timeframe")
        if isinstance(timeframe, str):
            return timeframe
    timeframe = row.get("timeframe")
    if isinstance(timeframe, str):
        return timeframe
    return _timeframe_from_iso_duration(size)


def _timeframe_from_iso_duration(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    match = re.fullmatch(r"PT(\d+)([SMH])", value)
    if match is not None:
        amount = int(match.group(1))
        unit = match.group(2)
        if unit == "S":
            return f"{amount}Sec"
        if unit == "M":
            return f"{amount}Min"
        if unit == "H":
            return f"{amount}Hour"

    legacy_match = re.fullmatch(
        r"(?i)\s*(\d+)\s*(sec|secs|s|min|minute|minutes|m|hour|hours|h)\s*",
        value,
    )
    if not legacy_match:
        return None
    amount = int(legacy_match.group(1))
    unit = legacy_match.group(2).lower()
    if unit in {"sec", "secs", "s"}:
        return f"{amount}Sec"
    if unit in {"min", "minute", "minutes", "m"}:
        return f"{amount}Min"
    if unit in {"hour", "hours", "h"}:
        return f"{amount}Hour"
    return None


def _normalize_payload(payload: Any) -> dict[str, Any]:
    if payload is None:
        return {}
    if isinstance(payload, dict):
        return cast(dict[str, Any], payload)
    if isinstance(payload, str):
        try:
            decoded = json.loads(payload)
        except json.JSONDecodeError:
            return {}
        if isinstance(decoded, dict):
            return cast(dict[str, Any], decoded)
    return {}


def _payload_from_flat_row(row: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    _merge_signal_json_payload(payload, row)
    _merge_macd_payload(payload, row)
    _merge_microstructure_signal_payload(payload, row)
    _copy_row_values_if_missing(payload, row, ("rsi", "rsi14"))
    _copy_row_value_if_missing(payload, row, "ema")
    _copy_row_value_if_missing(payload, row, "vwap")
    _copy_row_values_if_missing(payload, row, ("price", "close"))
    _ensure_price_value(payload, row)
    _merge_imbalance_payload(payload, row)
    _copy_extended_ta_fields(payload, row)
    return payload


def _merge_flat_row_fallbacks(payload: dict[str, Any], row: dict[str, Any]) -> None:
    _merge_microstructure_signal_payload(payload, row)
    _copy_row_values_if_missing(payload, row, ("rsi", "rsi14"))
    _copy_row_value_if_missing(payload, row, "ema")
    _copy_row_value_if_missing(payload, row, "vwap")
    _copy_row_values_if_missing(payload, row, ("price", "close"))
    _ensure_price_value(payload, row)
    _merge_imbalance_payload(payload, row)
    _copy_extended_ta_fields(payload, row)


def _merge_signal_json_payload(payload: dict[str, Any], row: dict[str, Any]) -> None:
    signal_json = row.get("signal_json")
    if not isinstance(signal_json, str):
        return
    try:
        decoded = json.loads(signal_json)
    except json.JSONDecodeError:
        return
    if isinstance(decoded, dict):
        payload.update(cast(dict[str, Any], decoded))


def _merge_macd_payload(payload: dict[str, Any], row: dict[str, Any]) -> None:
    macd_val = row.get("macd")
    signal_val = row.get("macd_signal") or row.get("signal")
    if macd_val is None and signal_val is None:
        return
    existing_macd = payload.get("macd")
    if isinstance(existing_macd, dict):
        if macd_val is not None:
            existing_macd["macd"] = macd_val
        if signal_val is not None:
            existing_macd["signal"] = signal_val
        return
    payload["macd"] = {"macd": macd_val, "signal": signal_val}


def _copy_row_values_if_missing(
    payload: dict[str, Any],
    row: dict[str, Any],
    keys: tuple[str, ...],
) -> None:
    for key in keys:
        _copy_row_value_if_missing(payload, row, key)


def _copy_row_value_if_missing(
    payload: dict[str, Any], row: dict[str, Any], key: str
) -> None:
    value = row.get(key)
    if value is not None and payload.get(key) is None:
        payload[key] = value


def _ensure_price_value(payload: dict[str, Any], row: dict[str, Any]) -> None:
    if payload.get("price") is not None:
        return
    bid_px = row.get("imbalance_bid_px")
    ask_px = row.get("imbalance_ask_px")
    if bid_px is not None and ask_px is not None:
        try:
            payload["price"] = (float(bid_px) + float(ask_px)) / 2
            return
        except (TypeError, ValueError):
            logger.debug(
                "Unable to derive midpoint price from imbalance fields bid=%r ask=%r",
                bid_px,
                ask_px,
            )
    for key in ("vwap_session", "vwap_w5m", "vwap"):
        candidate = row.get(key)
        if candidate is not None:
            payload["price"] = candidate
            return


def _merge_imbalance_payload(payload: dict[str, Any], row: dict[str, Any]) -> None:
    spread_value = row.get("spread")
    if spread_value is None:
        spread_value = row.get("imbalance_spread")

    bid_px = row.get("imbalance_bid_px")
    ask_px = row.get("imbalance_ask_px")
    if "imbalance" not in payload and (
        spread_value is not None or bid_px is not None or ask_px is not None
    ):
        payload["imbalance"] = {}

    raw_imbalance = payload.get("imbalance")
    if not isinstance(raw_imbalance, dict):
        return
    imbalance = cast(dict[str, Any], raw_imbalance)

    if bid_px is not None and imbalance.get("bid_px") is None:
        imbalance["bid_px"] = bid_px
    if ask_px is not None and imbalance.get("ask_px") is None:
        imbalance["ask_px"] = ask_px
    if spread_value is not None and imbalance.get("spread") is None:
        imbalance["spread"] = spread_value


def _merge_microstructure_signal_payload(
    payload: dict[str, Any], row: dict[str, Any]
) -> None:
    signal_value = row.get("microstructure_signal_v1")
    if signal_value is None:
        return
    if isinstance(signal_value, str):
        try:
            signal_value = json.loads(signal_value)
        except json.JSONDecodeError:
            return
    if isinstance(signal_value, dict):
        payload.setdefault("microstructure_signal", {})
        payload["microstructure_signal"] = _merge_dict_payload(
            payload.get("microstructure_signal"), cast(dict[str, Any], signal_value)
        )


def _copy_extended_ta_fields(payload: dict[str, Any], row: dict[str, Any]) -> None:
    # Preserve extended TA fields required by plugin_v3 strategy runtime.
    for key in (
        "macd_hist",
        "ema12",
        "ema26",
        "vwap_session",
        "vwap_w5m",
        "boll_mid",
        "boll_upper",
        "boll_lower",
        "imbalance_bid_px",
        "imbalance_ask_px",
        "imbalance_spread",
        "vol_realized_w60s",
        "microbar_volume",
    ):
        _copy_row_value_if_missing(payload, row, key)


def _merge_dict_payload(base: Any, updates: dict[str, Any]) -> dict[str, Any]:
    merged: dict[str, Any] = {}
    if isinstance(base, dict):
        merged.update(cast(dict[str, Any], base))
    merged.update(updates)
    return merged


def _next_signal_cursor_state(
    *,
    signal: SignalEnvelope,
    max_event_ts: Optional[datetime],
    max_seq: Optional[int],
    max_symbol: Optional[str],
) -> tuple[Optional[datetime], Optional[int], Optional[str]]:
    if max_event_ts is None or signal.event_ts > max_event_ts:
        return signal.event_ts, _coerce_seq(signal.seq), signal.symbol
    if signal.event_ts < max_event_ts:
        return max_event_ts, max_seq, max_symbol

    candidate_seq = _coerce_seq(signal.seq)
    normalized_candidate_seq = candidate_seq if candidate_seq is not None else max_seq
    if max_seq is None or (
        normalized_candidate_seq is not None and normalized_candidate_seq > max_seq
    ):
        return max_event_ts, normalized_candidate_seq, signal.symbol
    if normalized_candidate_seq == max_seq and (
        max_symbol is None or signal.symbol > max_symbol
    ):
        return max_event_ts, max_seq, signal.symbol
    return max_event_ts, max_seq, max_symbol


def _signal_identity(
    signal: SignalEnvelope,
) -> tuple[datetime, str, str | None, tuple[Any, ...], str]:
    return (
        signal.event_ts.astimezone(timezone.utc),
        signal.symbol,
        signal.timeframe,
        _signal_provenance_key(signal),
        _signal_payload_fingerprint(signal),
    )


def _signal_sort_key(signal: SignalEnvelope) -> tuple[datetime, str, str, int, str]:
    return (
        signal.event_ts.astimezone(timezone.utc),
        signal.symbol,
        signal.timeframe or "",
        _coerce_seq(signal.seq) or -1,
        signal.source or "",
    )


def _prefer_preferred_signal(
    *, candidate: SignalEnvelope, current: SignalEnvelope
) -> bool:
    return _signal_preference_key(candidate) > _signal_preference_key(current)


def _signal_preference_key(
    signal: SignalEnvelope,
) -> tuple[int, int, int, str, int, str]:
    return (
        1 if _signal_matches_active_simulation_run(signal) else 0,
        _signal_provenance_completeness(signal),
        len(_signal_payload_fingerprint(signal)),
        _signal_payload_context_fingerprint(signal),
        _coerce_seq(signal.seq) or -1,
        signal.source or "",
    )


def _signal_matches_active_simulation_run(signal: SignalEnvelope) -> bool:
    context = _signal_simulation_context(signal)
    signal_run_id = str(context.get("simulation_run_id") or "").strip()
    if not signal_run_id:
        return False
    runtime_context = active_simulation_runtime_context()
    active_run_id = str(
        (runtime_context or {}).get("run_id")
        or settings.trading_simulation_run_id
        or ""
    ).strip()
    if not active_run_id:
        return False
    return signal_run_id == active_run_id


def _signal_provenance_completeness(signal: SignalEnvelope) -> int:
    context = _signal_simulation_context(signal)
    values: tuple[Any, ...] = (
        context.get("dataset_event_id"),
        context.get("source_topic"),
        context.get("source_partition"),
        context.get("source_offset"),
        context.get("replay_topic"),
        context.get("signal_seq"),
        signal.seq,
        signal.source,
    )
    return sum(1 for value in values if value not in (None, "", -1))


def _signal_provenance_key(signal: SignalEnvelope) -> tuple[Any, ...]:
    context = _signal_simulation_context(signal)
    return (
        str(context.get("dataset_event_id") or ""),
        str(context.get("source_topic") or ""),
        _coerce_seq(context.get("source_partition")) or -1,
        _coerce_seq(context.get("source_offset")) or -1,
        str(context.get("replay_topic") or ""),
        _coerce_seq(context.get("signal_seq")) or _coerce_seq(signal.seq) or -1,
        signal.source or "",
    )


def _signal_payload_fingerprint(signal: SignalEnvelope) -> str:
    payload = dict(signal.payload)
    payload.pop("simulation_context", None)
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _signal_payload_context_fingerprint(signal: SignalEnvelope) -> str:
    context = dict(_signal_simulation_context(signal))
    context.pop("simulation_run_id", None)
    return json.dumps(context, sort_keys=True, separators=(",", ":"), default=str)


def _signal_simulation_context(signal: SignalEnvelope) -> dict[str, Any]:
    raw_context = signal.payload.get("simulation_context")
    if isinstance(raw_context, Mapping):
        return {
            str(key): value
            for key, value in cast(Mapping[object, Any], raw_context).items()
        }
    return {}


def _coerce_seq(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _normalized_signal_symbols(symbols: set[str] | None) -> tuple[str, ...]:
    if not symbols:
        return ()
    normalized: list[str] = []
    for raw_symbol in symbols:
        symbol = normalize_symbol(raw_symbol)
        if symbol is None:
            continue
        normalized_symbol = symbol.upper()
        if normalized_symbol not in normalized:
            normalized.append(normalized_symbol)
    return tuple(sorted(normalized))


def _normalized_signal_timeframes(timeframes: set[str] | None) -> tuple[str, ...]:
    if not timeframes:
        return ()
    normalized: list[str] = []
    for raw_timeframe in timeframes:
        timeframe = str(raw_timeframe or "").strip()
        if not timeframe or not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", timeframe):
            continue
        if timeframe not in normalized:
            normalized.append(timeframe)
    return tuple(sorted(normalized))


def _signal_scope_key(
    symbols: tuple[str, ...],
    timeframes: tuple[str, ...],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    return symbols, timeframes


def _timeframes_to_iso_durations(timeframes: tuple[str, ...]) -> tuple[str, ...]:
    rendered: list[str] = []
    for timeframe in timeframes:
        match = re.fullmatch(
            r"(?i)(\d+)(sec|secs|s|min|mins|m|hour|hours|h)", timeframe
        )
        if match is None:
            rendered.append(timeframe)
            continue
        amount = int(match.group(1))
        unit = match.group(2).lower()
        if unit in {"sec", "secs", "s"}:
            rendered.append(f"PT{amount}S")
        elif unit in {"min", "mins", "m"}:
            rendered.append(f"PT{amount}M")
        elif unit in {"hour", "hours", "h"}:
            rendered.append(f"PT{amount}H")
        else:  # pragma: no cover - regex constrains units above.
            rendered.append(timeframe)
    return tuple(dict.fromkeys(rendered))


def _mark_non_authority_stale_fallback_signal(
    signal: SignalEnvelope,
    *,
    reason: str,
    cached_at: datetime,
) -> SignalEnvelope:
    payload = dict(signal.payload)
    payload["signal_authority"] = "non_authority_stale_bounded_fallback"
    payload["signal_ingest_fallback"] = {
        "authority": "non_authority_stale_bounded",
        "reason": reason,
        "cached_at": cached_at.isoformat(),
    }
    return signal.model_copy(update={"payload": payload})


def _normalized_signal_sources(raw: str | None) -> set[str]:
    if not raw:
        return set()
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def _quote_literal(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def _select_columns(columns: set[str], time_column: str) -> list[str]:
    desired = [
        time_column,
        "event_ts",
        "ts",
        "ingest_ts",
        "symbol",
        "payload",
        "window",
        "window_size",
        "window_step",
        "seq",
        "source",
        "timeframe",
        "macd",
        "macd_signal",
        "macd_hist",
        "signal",
        "rsi",
        "rsi14",
        "ema",
        "ema12",
        "ema26",
        "vwap",
        "vwap_session",
        "vwap_w5m",
        "boll_mid",
        "boll_upper",
        "boll_lower",
        "imbalance_spread",
        "vol_realized_w60s",
        "signal_json",
        "close",
        "price",
        "spread",
        "imbalance_bid_px",
        "imbalance_ask_px",
        "microstructure_signal_v1",
        "simulation_context",
        "dataset_event_id",
        "source_topic",
        "source_partition",
        "source_offset",
        "replay_topic",
    ]
    selected: list[str] = []
    seen: set[str] = set()
    for col in desired:
        if col in seen or col not in columns:
            continue
        selected.append(col)
        seen.add(col)
    return selected


def _dedupe_columns(columns: list[str]) -> list[str]:
    selected: list[str] = []
    seen: set[str] = set()
    for col in columns:
        if col in seen:
            continue
        selected.append(col)
        seen.add(col)
    return selected


__all__ = [name for name in globals() if not name.startswith("__")]
