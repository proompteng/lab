"""ClickHouse read path for Hyperliquid market and signal state."""

from __future__ import annotations

import base64
import http.client
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping, cast
from urllib.parse import urlencode, urlsplit

from .config import HyperliquidRuntimeConfig
from .models import FeatureSnapshot, RuntimeDependencyStatus


@dataclass(frozen=True)
class ClickHouseStatus:
    """Current feed and feature freshness read from ClickHouse."""

    ready: bool
    statuses: tuple[RuntimeDependencyStatus, ...]


class ClickHouseRuntimeReader:
    """Small HTTP client for ClickHouse JSONEachRow queries."""

    def __init__(self, config: HyperliquidRuntimeConfig) -> None:
        self._config = config

    def load_catalog_rows(self) -> list[dict[str, object]]:
        database = _identifier(self._config.clickhouse_database)
        network = _sql_string(self._config.market_data_network)
        limit = max(1, self._config.max_markets_per_cycle * 4)
        query = f"""
        SELECT
          market_id,
          coin,
          dex,
          network,
          market_type,
          payload,
          JSONExtractString(payload, 'dayNtlVlm') AS dayNtlVlm,
          JSONExtractString(payload, 'markPx') AS markPx,
          JSONExtractString(payload, 'midPx') AS midPx,
          JSONExtractString(payload, 'openInterest') AS openInterest,
          JSONExtractInt(payload, 'maxLeverage') AS maxLeverage
        FROM (
          SELECT
            *,
            row_number() OVER (
              PARTITION BY market_id
              ORDER BY parseDateTimeBestEffort(event_ts) DESC, seq DESC
            ) AS rn
          FROM {database}.hyperliquid_market_catalog
          WHERE network = {network}
            AND market_type = 'perp'
            AND market_id IS NOT NULL
        )
        WHERE rn = 1
        LIMIT {limit}
        """
        return self.query_json_each_row(query)

    def load_feature_rows(self, market_ids: list[str]) -> list[FeatureSnapshot]:
        if not market_ids:
            return []
        database = _identifier(self._config.clickhouse_database)
        network = _sql_string(self._config.market_data_network)
        market_list = ", ".join(_sql_string(market_id) for market_id in market_ids)
        query = f"""
        SELECT
          market_id,
          coin,
          dex,
          event_ts,
          price,
          momentum_1m_bps,
          momentum_3m_bps,
          momentum_5m_bps,
          momentum_15m_bps,
          momentum_1h_bps,
          volatility_bps,
          vwap_distance_bps,
          spread_bps,
          book_imbalance,
          liquidity_usd,
          funding_rate,
          open_interest_usd,
          regime,
          source_lag_seconds
        FROM {database}.hyperliquid_runtime_latest_features
        WHERE network = {network}
          AND market_id IN ({market_list})
        ORDER BY event_ts DESC
        LIMIT {len(market_ids)}
        """
        return [_feature_from_row(row) for row in self.query_json_each_row(query)]

    def status(self) -> ClickHouseStatus:
        database = _identifier(self._config.clickhouse_database)
        query = f"""
        SELECT
          'hyperliquid_candles' AS name,
          max(parseDateTimeBestEffort(event_ts)) AS observed_at,
          dateDiff('second', observed_at, now()) AS lag_seconds
        FROM {database}.hyperliquid_candles
        WHERE network = {_sql_string(self._config.market_data_network)}
        UNION ALL
        SELECT
          'hyperliquid_runtime_latest_features' AS name,
          max(event_ts) AS observed_at,
          dateDiff('second', observed_at, now()) AS lag_seconds
        FROM {database}.hyperliquid_runtime_latest_features
        WHERE network = {_sql_string(self._config.market_data_network)}
        FORMAT JSONEachRow
        """
        try:
            rows = self.query_json_each_row(query, includes_format=True)
        except Exception as exc:
            reason = f"clickhouse_query_failed:{type(exc).__name__}"
            return ClickHouseStatus(
                ready=False,
                statuses=(RuntimeDependencyStatus("clickhouse", False, reason=reason),),
            )
        statuses = tuple(
            _dependency_from_row(row, self._config.dependency_staleness_seconds)
            for row in rows
        )
        return ClickHouseStatus(
            ready=bool(statuses) and all(status.ready for status in statuses),
            statuses=statuses,
        )

    def query_json_each_row(
        self,
        query: str,
        *,
        includes_format: bool = False,
    ) -> list[dict[str, object]]:
        final_query = query if includes_format else f"{query}\nFORMAT JSONEachRow"
        body = _request_clickhouse(
            url=self._config.clickhouse_http_url,
            username=self._config.clickhouse_username,
            password=self._config.clickhouse_password,
            timeout_seconds=self._config.clickhouse_timeout_seconds,
            query=final_query,
        )
        rows: list[dict[str, object]] = []
        for line in body.splitlines():
            cleaned = line.strip()
            if not cleaned:
                continue
            parsed: Any = json.loads(cleaned)
            if isinstance(parsed, dict):
                rows.append(
                    {
                        str(key): value
                        for key, value in cast(dict[object, object], parsed).items()
                    }
                )
        return rows


def _request_clickhouse(
    *,
    url: str,
    username: str,
    password: str | None,
    timeout_seconds: int,
    query: str,
) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise RuntimeError(f"unsupported_clickhouse_url_scheme:{parsed.scheme}")
    if not parsed.hostname:
        raise RuntimeError("invalid_clickhouse_url_host")
    path = parsed.path or "/"
    query_path = f"{path}?{urlencode({'query': query})}"
    headers = {"Content-Type": "text/plain"}
    if password:
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode(
            "ascii"
        )
        headers["Authorization"] = f"Basic {token}"
    connection: http.client.HTTPConnection
    if parsed.scheme == "https":
        connection = http.client.HTTPSConnection(
            parsed.hostname, parsed.port, timeout=timeout_seconds
        )
    else:
        connection = http.client.HTTPConnection(
            parsed.hostname, parsed.port, timeout=timeout_seconds
        )
    try:
        connection.request("POST", query_path, body="", headers=headers)
        response = connection.getresponse()
        payload = response.read().decode("utf-8")
        if response.status >= 300:
            raise RuntimeError(f"clickhouse_http_{response.status}:{payload[:200]}")
        return payload
    finally:
        connection.close()


def _feature_from_row(row: Mapping[str, object]) -> FeatureSnapshot:
    return FeatureSnapshot(
        market_id=_string(row.get("market_id")),
        coin=_string(row.get("coin")),
        dex=_string(row.get("dex")) or "default",
        event_ts=_datetime(row.get("event_ts")),
        price=_decimal(row.get("price")),
        momentum_1m_bps=_decimal(row.get("momentum_1m_bps")),
        momentum_3m_bps=_decimal(row.get("momentum_3m_bps")),
        momentum_5m_bps=_decimal(row.get("momentum_5m_bps")),
        momentum_15m_bps=_decimal(row.get("momentum_15m_bps")),
        momentum_1h_bps=_decimal(row.get("momentum_1h_bps")),
        volatility_bps=_decimal(row.get("volatility_bps")),
        vwap_distance_bps=_decimal(row.get("vwap_distance_bps")),
        spread_bps=_decimal(row.get("spread_bps")),
        book_imbalance=_decimal(row.get("book_imbalance")),
        liquidity_usd=_decimal(row.get("liquidity_usd")),
        funding_rate=_decimal(row.get("funding_rate")),
        open_interest_usd=_decimal(row.get("open_interest_usd")),
        regime=_string(row.get("regime")) or "unknown",
        source_lag_seconds=int(_decimal(row.get("source_lag_seconds"))),
    )


def _dependency_from_row(
    row: Mapping[str, object],
    staleness_seconds: int,
) -> RuntimeDependencyStatus:
    observed_at = _optional_datetime(row.get("observed_at"))
    lag_seconds = int(_decimal(row.get("lag_seconds")))
    ready = observed_at is not None and lag_seconds <= staleness_seconds
    reason = None if ready else "stale_or_missing"
    return RuntimeDependencyStatus(
        name=_string(row.get("name")),
        ready=ready,
        observed_at=observed_at,
        lag_seconds=lag_seconds,
        reason=reason,
    )


def _identifier(value: str) -> str:
    if not value.replace("_", "").isalnum():
        raise ValueError(f"invalid_clickhouse_identifier:{value}")
    return value


def _sql_string(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _string(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _decimal(value: object) -> Decimal:
    if value is None:
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _datetime(value: object) -> datetime:
    parsed = _optional_datetime(value)
    if parsed is None:
        return datetime.fromtimestamp(0, tz=timezone.utc)
    return parsed


def _optional_datetime(value: object) -> datetime | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.endswith("Z"):
        raw = f"{raw[:-1]}+00:00"
    parsed = datetime.fromisoformat(raw)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
