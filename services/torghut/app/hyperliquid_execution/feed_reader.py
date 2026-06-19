"""ClickHouse read path for Hyperliquid execution v2."""

from __future__ import annotations

import base64
import http.client
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Mapping, cast
from urllib.parse import urlencode, urlsplit

from .config import HyperliquidExecutionConfig
from .models import FeatureSnapshot, RuntimeDependencyStatus


@dataclass(frozen=True)
class FeedStatus:
    """Current mainnet feed freshness."""

    ready: bool
    statuses: tuple[RuntimeDependencyStatus, ...]


class ClickHouseFeedReader:
    """Small HTTP client for ClickHouse JSONEachRow queries."""

    def __init__(self, config: HyperliquidExecutionConfig) -> None:
        self._config = config

    def load_catalog_rows(self) -> list[dict[str, object]]:
        database = _identifier(self._config.clickhouse_database)
        network = _sql_string(self._config.market_data_network)
        limit = max(100, self._config.max_markets_per_cycle * 20)
        query = f"""
        WITH
          latest_catalog AS (
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
          ),
          latest_context AS (
            SELECT
              *,
              row_number() OVER (
                PARTITION BY market_id
                ORDER BY parseDateTimeBestEffort(event_ts) DESC, seq DESC
              ) AS rn
            FROM {database}.hyperliquid_asset_contexts
            WHERE network = {network}
              AND market_type = 'perp'
              AND market_id IS NOT NULL
          )
        SELECT
          c.market_id AS market_id,
          c.coin AS coin,
          c.dex AS dex,
          c.network AS network,
          c.market_type AS market_type,
          c.payload AS payload,
          COALESCE(
            NULLIF(JSONExtractString(JSONExtractRaw(a.payload, 'ctx'), 'dayNtlVlm'), ''),
            JSONExtractString(c.payload, 'dayNtlVlm')
          ) AS dayNtlVlm,
          COALESCE(
            NULLIF(JSONExtractString(JSONExtractRaw(a.payload, 'ctx'), 'markPx'), ''),
            JSONExtractString(c.payload, 'markPx')
          ) AS markPx,
          COALESCE(
            NULLIF(JSONExtractString(JSONExtractRaw(a.payload, 'ctx'), 'midPx'), ''),
            JSONExtractString(c.payload, 'midPx')
          ) AS midPx
        FROM latest_catalog AS c
        LEFT JOIN latest_context AS a
          ON c.market_id = a.market_id
          AND a.rn = 1
        WHERE c.rn = 1
        ORDER BY toFloat64OrZero(dayNtlVlm) DESC
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
          momentum_5m_bps,
          spread_bps,
          liquidity_usd,
          volatility_bps,
          book_imbalance,
          source_lag_seconds,
          bid_price,
          ask_price,
          quote_lag_seconds
        FROM {database}.hyperliquid_runtime_latest_features
        WHERE network = {network}
          AND market_id IN ({market_list})
        ORDER BY event_ts DESC
        LIMIT {len(market_ids)}
        """
        return [_feature_from_row(row) for row in self.query_json_each_row(query)]

    def status(self) -> FeedStatus:
        database = _identifier(self._config.clickhouse_database)
        query = f"""
        SELECT
          'hyperliquid_candles' AS name,
          max(parseDateTimeBestEffort(ingest_ts)) AS observed_at,
          dateDiff('second', observed_at, now()) AS lag_seconds
        FROM {database}.hyperliquid_candles
        WHERE network = {_sql_string(self._config.market_data_network)}
        UNION ALL
        SELECT
          'hyperliquid_ta_features' AS name,
          max(ingest_ts) AS observed_at,
          dateDiff('second', observed_at, now()) AS lag_seconds
        FROM {database}.hyperliquid_ta_features
        WHERE network = {_sql_string(self._config.market_data_network)}
        FORMAT JSONEachRow
        """
        try:
            rows = self.query_json_each_row(query, includes_format=True)
        except Exception as exc:
            reason = f"clickhouse_query_failed:{type(exc).__name__}"
            return FeedStatus(
                False, (RuntimeDependencyStatus("clickhouse", False, reason=reason),)
            )
        statuses = tuple(
            _dependency_from_row(row, self._config.dependency_staleness_seconds)
            for row in rows
        )
        return FeedStatus(
            bool(statuses) and all(status.ready for status in statuses), statuses
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
            parsed = json.loads(cleaned)
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
    payload = {str(key): value for key, value in row.items()}
    return FeatureSnapshot(
        market_id=_string(row.get("market_id")),
        coin=_string(row.get("coin")),
        dex=_string(row.get("dex")) or "default",
        event_ts=_datetime(row.get("event_ts")),
        price=_decimal(row.get("price")),
        momentum_5m_bps=_decimal(row.get("momentum_5m_bps")),
        spread_bps=_decimal(row.get("spread_bps")),
        liquidity_usd=_decimal(row.get("liquidity_usd")),
        volatility_bps=_decimal(row.get("volatility_bps")),
        book_imbalance=_decimal(row.get("book_imbalance")),
        source_lag_seconds=_int(row.get("source_lag_seconds")),
        bid_price=_optional_decimal(row.get("bid_price")),
        ask_price=_optional_decimal(row.get("ask_price")),
        quote_lag_seconds=_optional_int(row.get("quote_lag_seconds")),
        raw_features=payload,
    )


def _dependency_from_row(
    row: Mapping[str, object],
    max_lag_seconds: int,
) -> RuntimeDependencyStatus:
    name = _string(row.get("name")) or "clickhouse"
    observed_at = _optional_datetime(row.get("observed_at"))
    lag_seconds = _optional_int(row.get("lag_seconds"))
    ready = lag_seconds is not None and lag_seconds <= max_lag_seconds
    return RuntimeDependencyStatus(
        name=name,
        ready=ready,
        observed_at=observed_at,
        lag_seconds=lag_seconds,
        reason=None if ready else "feed_stale_or_missing",
    )


def _identifier(value: str) -> str:
    if not value.replace("_", "").isalnum():
        raise ValueError(f"invalid_clickhouse_identifier:{value}")
    return value


def _sql_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _string(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _decimal(value: object) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def _optional_decimal(value: object) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _int(value: object) -> int:
    parsed = _optional_int(value)
    return parsed if parsed is not None else 0


def _optional_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(str(value)))
    except (TypeError, ValueError):
        return None


def _datetime(value: object) -> datetime:
    parsed = _optional_datetime(value)
    if parsed is None:
        raise ValueError("missing_datetime")
    return parsed


def _optional_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    return datetime.fromisoformat(normalized)
