"""Direct Alpaca REST client for the options lane."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
import re
from typing import cast
from urllib.parse import urlencode
from urllib.request import Request, urlopen

_OCC_SYMBOL_RE = re.compile(r"^([A-Z]{1,6})\d{6}[CP]\d{8}$")
JsonObject = dict[str, object]


def _as_json_object(value: object) -> JsonObject | None:
    if isinstance(value, dict):
        return cast(JsonObject, value)
    return None


def _as_json_list(value: object) -> list[object]:
    if isinstance(value, list):
        return cast(list[object], value)
    return []


def _normalize_iso_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalize_iso_date(value: object) -> date | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def _to_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(cast(Decimal | int | float | str, value))
    except (TypeError, ValueError, ArithmeticError):
        return None


def _to_int(value: object) -> int | None:
    if value is None:
        return None
    try:
        return int(cast(int | float | str, value))
    except (TypeError, ValueError, ArithmeticError):
        return None


@dataclass(frozen=True)
class AlpacaApiError(RuntimeError):
    """Raised when Alpaca returns an error payload."""

    status_code: int
    body: str

    def __str__(self) -> str:
        return f"alpaca_api_error:{self.status_code}:{self.body[:200]}"


class AlpacaOptionsClient:
    """HTTP client for Alpaca options discovery and enrichment endpoints."""

    def __init__(
        self,
        *,
        key_id: str,
        secret_key: str,
        contracts_base_url: str,
        data_base_url: str,
        feed: str,
    ) -> None:
        self._key_id = key_id
        self._secret_key = secret_key
        self._contracts_base_url = contracts_base_url.rstrip("/")
        self._data_base_url = data_base_url.rstrip("/")
        self._feed = feed

    def list_contracts(
        self,
        *,
        status: str,
        limit: int,
        expiration_date_gte: date,
        expiration_date_lte: date,
        page_token: str | None = None,
    ) -> tuple[list[JsonObject], str | None]:
        payload = self._request_json(
            self._contracts_base_url,
            "/v2/options/contracts",
            {
                "status": status,
                "limit": limit,
                "expiration_date_gte": expiration_date_gte.isoformat(),
                "expiration_date_lte": expiration_date_lte.isoformat(),
                "page_token": page_token,
            },
        )
        rows = _as_json_list(payload.get("option_contracts") or payload.get("contracts") or payload.get("data") or [])
        next_token = payload.get("next_page_token") or payload.get("page_token")
        normalized_rows: list[JsonObject] = []
        for row in rows:
            row_dict = _as_json_object(row)
            if row_dict is not None:
                normalized_rows.append(row_dict)
        resolved_next_token = next_token.strip() if isinstance(next_token, str) and next_token.strip() else None
        return normalized_rows, resolved_next_token

    def get_snapshots(self, symbols: list[str]) -> dict[str, JsonObject]:
        if not symbols:
            return {}
        payload = self._request_json(
            self._data_base_url,
            "/v1beta1/options/snapshots",
            {"symbols": ",".join(symbols), "feed": self._feed},
        )
        raw = _as_json_object(payload.get("snapshots")) if "snapshots" in payload else payload
        if raw is None:
            return {}
        snapshots: dict[str, JsonObject] = {}
        for symbol, body in raw.items():
            body_dict = _as_json_object(body)
            symbol_key = str(symbol).strip().upper()
            if body_dict is not None and symbol_key:
                snapshots[symbol_key] = body_dict
        return snapshots

    def get_option_bars(
        self,
        *,
        symbols: list[str],
        timeframe: str,
        start: datetime,
        end: datetime,
        limit: int,
    ) -> dict[str, list[JsonObject]]:
        if not symbols:
            return {}
        payload = self._request_json(
            self._data_base_url,
            "/v1beta1/options/bars",
            {
                "symbols": ",".join(symbols),
                "timeframe": timeframe,
                "start": start.isoformat(),
                "end": end.isoformat(),
                "limit": limit,
                "feed": self._feed,
            },
        )
        raw = _as_json_object(payload.get("bars")) if "bars" in payload else payload
        if raw is None:
            return {}
        normalized: dict[str, list[JsonObject]] = {}
        for symbol, rows in raw.items():
            row_items = _as_json_list(rows)
            normalized_rows: list[JsonObject] = []
            for row in row_items:
                row_dict = _as_json_object(row)
                if row_dict is not None:
                    normalized_rows.append(row_dict)
            if normalized_rows:
                normalized[str(symbol).strip().upper()] = normalized_rows
        return normalized

    def _request_json(self, base_url: str, path: str, params: dict[str, object]) -> JsonObject:
        encoded_params = urlencode(
            [(key, value) for key, value in params.items() if value is not None],
            doseq=True,
        )
        request = Request(
            f"{base_url}{path}?{encoded_params}" if encoded_params else f"{base_url}{path}",
            headers={
                "accept": "application/json",
                "APCA-API-KEY-ID": self._key_id,
                "APCA-API-SECRET-KEY": self._secret_key,
            },
        )
        try:
            with urlopen(request, timeout=30) as response:
                raw = response.read().decode("utf-8")
                status_code = int(getattr(response, "status", 200))
        except Exception as exc:
            status_code = int(getattr(exc, "code", 0) or 0)
            body = getattr(exc, "read", lambda: b"")()
            raw = body.decode("utf-8", errors="ignore") if isinstance(body, bytes) else str(exc)
            raise AlpacaApiError(status_code=status_code, body=raw or str(exc)) from exc

        try:
            payload = cast(object, json.loads(raw)) if raw else cast(object, {})
        except json.JSONDecodeError as exc:
            raise AlpacaApiError(status_code=status_code, body=raw) from exc
        payload_dict = _as_json_object(payload)
        if payload_dict is None:
            raise AlpacaApiError(status_code=status_code, body=raw)
        return payload_dict


def normalize_contract_record(raw: JsonObject, *, observed_at: datetime) -> dict[str, object]:
    """Normalize an Alpaca contract payload into the raw Kafka and Postgres contract shape."""

    contract_symbol = str(raw.get("symbol") or "").strip().upper()
    status = str(raw.get("status") or "unknown").strip().lower() or "unknown"
    expiration_date = _normalize_iso_date(raw.get("expiration_date")) or observed_at.date()
    option_type = str(raw.get("type") or raw.get("option_type") or "call").strip().lower()
    if option_type not in {"call", "put"}:
        option_type = "call"
    style = str(raw.get("style") or "unknown").strip().lower()
    if style not in {"american", "european", "unknown"}:
        style = "unknown"
    contract_size = _to_int(raw.get("size") or raw.get("contract_size")) or 100
    root_symbol = str(raw.get("root_symbol") or raw.get("root") or "").strip().upper()
    if not root_symbol and contract_symbol:
        match = _OCC_SYMBOL_RE.match(contract_symbol)
        if match is not None:
            root_symbol = match.group(1)
    underlying_symbol = str(raw.get("underlying_symbol") or raw.get("underlying") or root_symbol).strip().upper()

    return {
        "contract_id": str(raw.get("id") or contract_symbol),
        "contract_symbol": contract_symbol,
        "name": str(raw.get("name") or "").strip() or None,
        "status": status if status in {"active", "inactive", "expired", "unknown"} else "unknown",
        "tradable": bool(raw.get("tradable", True)),
        "expiration_date": expiration_date,
        "root_symbol": root_symbol or contract_symbol[:6],
        "underlying_symbol": underlying_symbol,
        "underlying_asset_id": str(raw.get("underlying_asset_id") or "").strip() or None,
        "option_type": option_type,
        "style": style,
        "strike_price": _to_float(raw.get("strike_price")) or 0.0,
        "contract_size": contract_size,
        "open_interest": _to_int(raw.get("open_interest")),
        "open_interest_date": _normalize_iso_date(raw.get("open_interest_date")),
        "close_price": _to_float(raw.get("close_price")),
        "close_price_date": _normalize_iso_date(raw.get("close_price_date")),
        "provider_updated_ts": _normalize_iso_datetime(raw.get("updated_at") or raw.get("provider_updated_at")),
        "first_seen_ts": observed_at,
        "last_seen_ts": observed_at,
        "catalog_status_reason": None,
        "metadata": raw,
        "schema_version": 1,
    }


def normalize_snapshot_record(
    contract_symbol: str,
    snapshot: JsonObject,
    *,
    underlying_symbol: str,
    snapshot_class: str,
) -> dict[str, object]:
    """Normalize an Alpaca snapshot payload into the raw snapshot contract."""

    latest_trade = _as_json_object(snapshot.get("latestTrade") or snapshot.get("latest_trade")) or {}
    latest_quote = _as_json_object(snapshot.get("latestQuote") or snapshot.get("latest_quote")) or {}
    greeks = _as_json_object(snapshot.get("greeks")) or {}

    bid_price = _to_float(latest_quote.get("bp") or latest_quote.get("bid_price"))
    ask_price = _to_float(latest_quote.get("ap") or latest_quote.get("ask_price"))
    mid_price = None
    if bid_price is not None and ask_price is not None and bid_price > 0 and ask_price > 0:
        mid_price = (bid_price + ask_price) / 2.0

    return {
        "contract_symbol": contract_symbol,
        "underlying_symbol": underlying_symbol,
        "latest_trade_price": _to_float(latest_trade.get("p") or latest_trade.get("price")),
        "latest_trade_size": _to_float(latest_trade.get("s") or latest_trade.get("size")),
        "latest_trade_ts": _normalize_iso_datetime(latest_trade.get("t") or latest_trade.get("timestamp")),
        "latest_bid_price": bid_price,
        "latest_bid_size": _to_float(latest_quote.get("bs") or latest_quote.get("bid_size")),
        "latest_ask_price": ask_price,
        "latest_ask_size": _to_float(latest_quote.get("as") or latest_quote.get("ask_size")),
        "latest_quote_ts": _normalize_iso_datetime(latest_quote.get("t") or latest_quote.get("timestamp")),
        "implied_volatility": _to_float(snapshot.get("impliedVolatility") or snapshot.get("implied_volatility")),
        "delta": _to_float(greeks.get("delta")),
        "gamma": _to_float(greeks.get("gamma")),
        "theta": _to_float(greeks.get("theta")),
        "vega": _to_float(greeks.get("vega")),
        "rho": _to_float(greeks.get("rho")),
        "open_interest": _to_int(snapshot.get("openInterest") or snapshot.get("open_interest")),
        "open_interest_date": _normalize_iso_date(snapshot.get("openInterestDate") or snapshot.get("open_interest_date")),
        "mark_price": _to_float(snapshot.get("markPrice") or snapshot.get("mark_price")),
        "mid_price": mid_price,
        "snapshot_class": snapshot_class,
        "source_window_start_ts": None,
        "source_window_end_ts": None,
        "schema_version": 1,
    }
