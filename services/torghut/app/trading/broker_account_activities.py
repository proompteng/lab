"""Immutable broker economic source normalization and equivalence checks."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Mapping
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import BrokerAccountActivity, BrokerAccountActivityCursor

ALPACA_PROVIDER = "alpaca"
ACCOUNT_ACTIVITIES_REST_SOURCE = "account_activities_rest"
_TRADE_UPDATE_SOURCE = "trade_updates_ws"
_FRESHNESS_MAX_AGE_SECONDS = 60


class BrokerAccountActivityError(RuntimeError):
    """Base error for broker economic-activity ingestion."""


class BrokerAccountActivityPayloadError(BrokerAccountActivityError):
    """Raised when Alpaca returns a payload that cannot be an economic fact."""


class BrokerAccountActivityContradiction(BrokerAccountActivityError):
    """Raised when one broker activity ID is observed with different content."""


def as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def required_text(payload: Mapping[str, object], key: str, *, maximum: int) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise BrokerAccountActivityPayloadError(
            f"broker_account_activity_{key}_invalid"
        )
    return value.strip()


def _optional_text(
    payload: Mapping[str, object], key: str, *, maximum: int
) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > maximum:
        raise BrokerAccountActivityPayloadError(
            f"broker_account_activity_{key}_invalid"
        )
    return value.strip()


def _optional_decimal(payload: Mapping[str, object], key: str) -> Decimal | None:
    value = payload.get(key)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float, Decimal)):
        raise BrokerAccountActivityPayloadError(
            f"broker_account_activity_{key}_invalid"
        )
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise BrokerAccountActivityPayloadError(
            f"broker_account_activity_{key}_invalid"
        ) from exc
    if not parsed.is_finite():
        raise BrokerAccountActivityPayloadError(
            f"broker_account_activity_{key}_invalid"
        )
    return parsed


def _optional_datetime(payload: Mapping[str, object], key: str) -> datetime | None:
    value = _optional_text(payload, key, maximum=64)
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BrokerAccountActivityPayloadError(
            f"broker_account_activity_{key}_invalid"
        ) from exc
    if parsed.tzinfo is None:
        raise BrokerAccountActivityPayloadError(
            f"broker_account_activity_{key}_timezone_required"
        )
    return parsed.astimezone(timezone.utc)


def _canonical_payload(payload: Mapping[str, object]) -> tuple[str, str]:
    try:
        canonical = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise BrokerAccountActivityPayloadError(
            "broker_account_activity_not_json_serializable"
        ) from exc
    return canonical, hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _canonical_decimal(value: Decimal | None) -> str | None:
    if value is None:
        return None
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


def _canonical_symbol(value: str | None) -> str | None:
    if value is None:
        return None
    return value.strip().upper().replace("/", "") or None


def _normalized_economic_digest(
    *,
    environment: str,
    account_label: str,
    activity_type: str,
    activity_subtype: str | None,
    correction_of_external_id: str | None,
    event_at: datetime | None,
    settle_date: date | None,
    order_id: str | None,
    symbol: str | None,
    side: str | None,
    quantity: Decimal | None,
    price: Decimal | None,
    net_amount: Decimal | None,
    currency: str | None,
) -> str:
    """Hash fields that mean the same thing across stream and REST shapes."""

    payload = {
        "account_label": account_label.strip(),
        "activity_subtype": (
            activity_subtype.strip().lower() if activity_subtype else None
        ),
        "activity_type": activity_type.strip().upper(),
        "correction_of_external_id": correction_of_external_id,
        "currency": currency.strip().upper() if currency else None,
        "environment": environment.strip().lower(),
        "event_at": (
            as_utc(event_at).isoformat(timespec="microseconds")
            if event_at is not None
            else None
        ),
        "net_amount": _canonical_decimal(net_amount),
        "order_id": order_id,
        "price": _canonical_decimal(price),
        "quantity": _canonical_decimal(quantity),
        "settle_date": settle_date.isoformat() if settle_date is not None else None,
        "side": side.strip().lower() if side else None,
        "symbol": _canonical_symbol(symbol),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalize_broker_account_activity(
    payload: Mapping[str, object],
    *,
    environment: str,
    account_label: str,
    endpoint_fingerprint: str,
    source_page_token: str | None,
    observed_at: datetime,
) -> BrokerAccountActivity:
    """Normalize common REST fields while preserving the exact broker document."""

    raw_payload = dict(payload)
    canonical, payload_sha256 = _canonical_payload(raw_payload)
    event_at = _optional_datetime(raw_payload, "transaction_time")
    activity_date = _optional_text(raw_payload, "date", maximum=32)
    settle_date = None
    if activity_date is not None:
        try:
            settle_date = datetime.fromisoformat(
                activity_date.replace("Z", "+00:00")
            ).date()
        except ValueError as exc:
            raise BrokerAccountActivityPayloadError(
                "broker_account_activity_date_invalid"
            ) from exc
    activity_type = required_text(raw_payload, "activity_type", maximum=32).upper()
    activity_subtype = _optional_text(raw_payload, "type", maximum=32)
    correction_of_external_id = _optional_text(raw_payload, "previous_id", maximum=256)
    order_id = _optional_text(raw_payload, "order_id", maximum=128)
    symbol = _optional_text(raw_payload, "symbol", maximum=64)
    side = _optional_text(raw_payload, "side", maximum=16)
    quantity = _optional_decimal(raw_payload, "qty")
    price = _optional_decimal(raw_payload, "price")
    net_amount = _optional_decimal(raw_payload, "net_amount")
    currency = _optional_text(raw_payload, "currency", maximum=16)
    return BrokerAccountActivity(
        provider=ALPACA_PROVIDER,
        source=ACCOUNT_ACTIVITIES_REST_SOURCE,
        environment=environment,
        account_label=account_label,
        endpoint_fingerprint=endpoint_fingerprint,
        external_activity_id=required_text(raw_payload, "id", maximum=256),
        activity_type=activity_type,
        activity_subtype=activity_subtype,
        correction_of_external_id=correction_of_external_id,
        event_at=event_at,
        settle_date=settle_date,
        order_id=order_id,
        client_order_id=_optional_text(raw_payload, "client_order_id", maximum=128),
        symbol=symbol,
        side=side,
        quantity=quantity,
        price=price,
        cumulative_quantity=_optional_decimal(raw_payload, "cum_qty"),
        leaves_quantity=_optional_decimal(raw_payload, "leaves_qty"),
        net_amount=net_amount,
        currency=currency,
        raw_payload=raw_payload,
        raw_payload_canonical_json=canonical,
        raw_payload_sha256=payload_sha256,
        normalized_economic_sha256=_normalized_economic_digest(
            environment=environment,
            account_label=account_label,
            activity_type=activity_type,
            activity_subtype=activity_subtype,
            correction_of_external_id=correction_of_external_id,
            event_at=event_at,
            settle_date=settle_date,
            order_id=order_id,
            symbol=symbol,
            side=side,
            quantity=quantity,
            price=price,
            net_amount=net_amount,
            currency=currency,
        ),
        source_page_token=source_page_token,
        source_topic=None,
        source_partition=None,
        source_offset=None,
        first_observed_at=as_utc(observed_at),
    )


def _mapping(value: object) -> Mapping[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    raw = cast(Mapping[object, object], value)
    if any(not isinstance(key, str) for key in raw):
        return None
    return {cast(str, key): item for key, item in raw.items()}


def _trade_update_payload(raw_event: Mapping[str, object]) -> Mapping[str, object]:
    channel = raw_event.get("channel")
    payload = _mapping(raw_event.get("payload"))
    if channel == "trade_updates" and payload is not None:
        return payload
    stream = raw_event.get("stream")
    data = _mapping(raw_event.get("data"))
    if stream == "trade_updates" and data is not None:
        return data
    if _mapping(raw_event.get("order")) is not None:
        return raw_event
    raise BrokerAccountActivityPayloadError("broker_trade_update_payload_missing")


def normalize_broker_trade_update(
    raw_event: Mapping[str, object],
    *,
    event_fingerprint: str,
    environment: str,
    account_label: str,
    endpoint_fingerprint: str,
    source_topic: str,
    source_partition: int,
    source_offset: int,
    observed_at: datetime,
) -> BrokerAccountActivity:
    """Preserve one broker WebSocket order update as an immutable source fact."""

    if source_partition < 0 or source_offset < 0 or not source_topic.strip():
        raise BrokerAccountActivityPayloadError(
            "broker_trade_update_source_position_invalid"
        )
    if len(event_fingerprint) != 64 or any(
        character not in "0123456789abcdef" for character in event_fingerprint
    ):
        raise BrokerAccountActivityPayloadError(
            "broker_trade_update_fingerprint_invalid"
        )
    broker_payload = dict(_trade_update_payload(raw_event))
    for key in tuple(broker_payload):
        if key.startswith("_torghut_"):
            broker_payload.pop(key)
    order = _mapping(broker_payload.get("order")) or {}
    canonical, payload_sha256 = _canonical_payload(broker_payload)
    activity_subtype = _optional_text(
        broker_payload, "event", maximum=32
    ) or _optional_text(broker_payload, "event_type", maximum=32)
    if activity_subtype is None:
        raise BrokerAccountActivityPayloadError("broker_trade_update_event_invalid")
    normalized_subtype = activity_subtype.lower()
    external_activity_id = (
        _optional_text(broker_payload, "event_id", maximum=256)
        or _optional_text(broker_payload, "execution_id", maximum=256)
        or event_fingerprint
    )
    activity_type = (
        "FILL"
        if normalized_subtype in {"fill", "partial_fill", "trade_bust", "trade_correct"}
        else "ORDER"
    )
    event_at = None
    for key in ("timestamp", "at", "t"):
        if broker_payload.get(key) is not None:
            event_at = _optional_datetime(broker_payload, key)
            break
    if event_at is None:
        for key in ("updated_at", "submitted_at"):
            if order.get(key) is not None:
                event_at = _optional_datetime(order, key)
                break
    order_id = _optional_text(order, "id", maximum=128)
    if order_id is None:
        order_id = _optional_text(order, "order_id", maximum=128)
    client_order_id = _optional_text(order, "client_order_id", maximum=128)
    symbol = _optional_text(order, "symbol", maximum=64)
    side = _optional_text(order, "side", maximum=16)
    quantity = _optional_decimal(
        broker_payload if activity_type == "FILL" else order,
        "qty",
    )
    price = (
        _optional_decimal(broker_payload, "price") if activity_type == "FILL" else None
    )
    cumulative_quantity = _optional_decimal(order, "filled_qty")
    order_quantity = _optional_decimal(order, "qty")
    leaves_quantity = None
    if order_quantity is not None and cumulative_quantity is not None:
        leaves_quantity = max(Decimal("0"), order_quantity - cumulative_quantity)
    correction_of_external_id = _optional_text(
        broker_payload, "previous_id", maximum=256
    ) or _optional_text(broker_payload, "original_execution_id", maximum=256)
    return BrokerAccountActivity(
        provider=ALPACA_PROVIDER,
        source=_TRADE_UPDATE_SOURCE,
        environment=environment,
        account_label=account_label,
        endpoint_fingerprint=endpoint_fingerprint,
        external_activity_id=external_activity_id,
        activity_type=activity_type,
        activity_subtype=normalized_subtype,
        correction_of_external_id=correction_of_external_id,
        event_at=event_at,
        settle_date=None,
        order_id=order_id,
        client_order_id=client_order_id,
        symbol=symbol,
        side=side,
        quantity=quantity,
        price=price,
        cumulative_quantity=cumulative_quantity,
        leaves_quantity=leaves_quantity,
        net_amount=None,
        currency=None,
        raw_payload=broker_payload,
        raw_payload_canonical_json=canonical,
        raw_payload_sha256=payload_sha256,
        normalized_economic_sha256=_normalized_economic_digest(
            environment=environment,
            account_label=account_label,
            activity_type=activity_type,
            activity_subtype=normalized_subtype,
            correction_of_external_id=correction_of_external_id,
            event_at=event_at,
            settle_date=None,
            order_id=order_id,
            symbol=symbol,
            side=side,
            quantity=quantity,
            price=price,
            net_amount=None,
            currency=None,
        ),
        source_page_token=None,
        source_topic=source_topic,
        source_partition=source_partition,
        source_offset=source_offset,
        first_observed_at=as_utc(observed_at),
    )


def persist_broker_trade_update(
    session: Session,
    raw_event: Mapping[str, object],
    *,
    event_fingerprint: str,
    environment: str,
    account_label: str,
    endpoint_fingerprint: str,
    source_topic: str,
    source_partition: int,
    source_offset: int,
    observed_at: datetime,
) -> tuple[BrokerAccountActivity, bool]:
    """Append one stream fact, deduplicating only byte-equivalent broker events."""

    row = normalize_broker_trade_update(
        raw_event,
        event_fingerprint=event_fingerprint,
        environment=environment,
        account_label=account_label,
        endpoint_fingerprint=endpoint_fingerprint,
        source_topic=source_topic,
        source_partition=source_partition,
        source_offset=source_offset,
        observed_at=observed_at,
    )
    existing = session.scalar(
        select(BrokerAccountActivity).where(
            BrokerAccountActivity.provider == ALPACA_PROVIDER,
            BrokerAccountActivity.source == _TRADE_UPDATE_SOURCE,
            BrokerAccountActivity.environment == environment,
            BrokerAccountActivity.account_label == account_label,
            BrokerAccountActivity.external_activity_id == row.external_activity_id,
        )
    )
    if existing is not None:
        if existing.raw_payload_sha256 != row.raw_payload_sha256:
            raise BrokerAccountActivityContradiction(
                f"broker_trade_update_payload_changed:{row.external_activity_id}"
            )
        return existing, True
    session.add(row)
    return row, False


def load_broker_account_activity_status(
    session: Session,
    *,
    account_label: str,
    environment: str,
    observed_at: datetime,
) -> dict[str, object]:
    """Project bounded source-cursor freshness without treating activity time as lag."""

    cursor = session.scalar(
        select(BrokerAccountActivityCursor)
        .where(
            BrokerAccountActivityCursor.provider == ALPACA_PROVIDER,
            BrokerAccountActivityCursor.source == ACCOUNT_ACTIVITIES_REST_SOURCE,
            BrokerAccountActivityCursor.environment == environment,
            BrokerAccountActivityCursor.account_label == account_label,
        )
        .order_by(BrokerAccountActivityCursor.updated_at.desc())
        .limit(1)
    )
    if cursor is None:
        return {
            "schema_version": "torghut.broker-account-activity-status.v1",
            "state": "missing",
            "current": False,
            "reason_codes": ["broker_account_activity_cursor_missing"],
            "account_label": account_label,
            "environment": environment,
            "max_age_seconds": _FRESHNESS_MAX_AGE_SECONDS,
        }
    observed = as_utc(observed_at)
    updated_at = as_utc(cursor.updated_at)
    age_seconds = max(0, int((observed - updated_at).total_seconds()))
    reasons: list[str] = []
    if cursor.status != "complete":
        reasons.append(f"broker_account_activity_{cursor.status}")
    if age_seconds > _FRESHNESS_MAX_AGE_SECONDS:
        reasons.append("broker_account_activity_cursor_stale")
    return {
        "schema_version": "torghut.broker-account-activity-status.v1",
        "state": "current" if not reasons else cursor.status,
        "current": not reasons,
        "reason_codes": reasons,
        "account_label": account_label,
        "environment": environment,
        "cursor_updated_at": updated_at.isoformat(),
        "last_completed_at": (
            as_utc(cursor.last_completed_at).isoformat()
            if cursor.last_completed_at is not None
            else None
        ),
        "age_seconds": age_seconds,
        "max_age_seconds": _FRESHNESS_MAX_AGE_SECONDS,
        "pages_processed": cursor.pages_processed,
        "activities_seen": cursor.activities_seen,
        "activities_inserted": cursor.activities_inserted,
        "last_activity_id": cursor.last_activity_id,
    }


def compare_broker_fill_sources(
    session: Session,
    *,
    account_label: str,
    environment: str,
    window_start: datetime,
    window_end: datetime,
) -> dict[str, object]:
    """Compare stream and REST fill multisets over one explicit proof window."""

    start = as_utc(window_start)
    end = as_utc(window_end)
    if start >= end:
        raise ValueError("broker_economic_source_window_invalid")
    rows = session.scalars(
        select(BrokerAccountActivity).where(
            BrokerAccountActivity.provider == ALPACA_PROVIDER,
            BrokerAccountActivity.environment == environment,
            BrokerAccountActivity.account_label == account_label,
            BrokerAccountActivity.activity_type == "FILL",
            BrokerAccountActivity.event_at >= start,
            BrokerAccountActivity.event_at < end,
            BrokerAccountActivity.source.in_(
                (ACCOUNT_ACTIVITIES_REST_SOURCE, _TRADE_UPDATE_SOURCE)
            ),
        )
    ).all()
    normalized_by_source = {
        source: Counter(
            row.normalized_economic_sha256 for row in rows if row.source == source
        )
        for source in (ACCOUNT_ACTIVITIES_REST_SOURCE, _TRADE_UPDATE_SOURCE)
    }
    rest = normalized_by_source[ACCOUNT_ACTIVITIES_REST_SOURCE]
    stream = normalized_by_source[_TRADE_UPDATE_SOURCE]
    missing_from_rest = stream - rest
    missing_from_stream = rest - stream

    def _multiset_digest(values: Counter[str]) -> str:
        expanded = sorted(values.elements())
        canonical = json.dumps(expanded, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    source_hashes = {
        source: sorted(row.raw_payload_sha256 for row in rows if row.source == source)
        for source in (ACCOUNT_ACTIVITIES_REST_SOURCE, _TRADE_UPDATE_SOURCE)
    }
    equivalent = not missing_from_rest and not missing_from_stream
    evidence_count = sum(rest.values())
    return {
        "schema_version": "torghut.broker-economic-source-comparison.v1",
        "account_label": account_label,
        "environment": environment,
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "equivalent": equivalent,
        "proof_complete": equivalent and evidence_count > 0,
        "rest_fill_count": sum(rest.values()),
        "stream_fill_count": sum(stream.values()),
        "evidence_count": evidence_count,
        "rest_normalized_multiset_sha256": _multiset_digest(rest),
        "stream_normalized_multiset_sha256": _multiset_digest(stream),
        "missing_from_rest": dict(sorted(missing_from_rest.items())),
        "missing_from_stream": dict(sorted(missing_from_stream.items())),
        "source_hashes": source_hashes,
    }


__all__ = (
    "ACCOUNT_ACTIVITIES_REST_SOURCE",
    "ALPACA_PROVIDER",
    "BrokerAccountActivityContradiction",
    "BrokerAccountActivityError",
    "BrokerAccountActivityPayloadError",
    "as_utc",
    "compare_broker_fill_sources",
    "load_broker_account_activity_status",
    "normalize_broker_account_activity",
    "normalize_broker_trade_update",
    "persist_broker_trade_update",
    "required_text",
)
