"""Immutable broker economic source normalization and equivalence checks."""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
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


@dataclass(frozen=True, slots=True)
class BrokerActivityObservation:
    """Account and endpoint scope attached to one broker observation."""

    environment: str
    account_label: str
    endpoint_fingerprint: str
    observed_at: datetime


@dataclass(frozen=True, slots=True)
class BrokerStreamPosition:
    """Transport position retained as provenance, never economic identity."""

    topic: str
    partition: int
    offset: int


@dataclass(frozen=True, slots=True)
class _ActivityFields:
    external_activity_id: str
    activity_type: str
    activity_subtype: str | None = None
    correction_of_external_id: str | None = None
    event_at: datetime | None = None
    settle_date: date | None = None
    order_id: str | None = None
    client_order_id: str | None = None
    symbol: str | None = None
    side: str | None = None
    quantity: Decimal | None = None
    price: Decimal | None = None
    cumulative_quantity: Decimal | None = None
    leaves_quantity: Decimal | None = None
    net_amount: Decimal | None = None
    currency: str | None = None


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
    return _round_to_broker_microseconds(value, parsed).astimezone(timezone.utc)


def _round_to_broker_microseconds(value: str, parsed: datetime) -> datetime:
    """Match Alpaca REST's half-up conversion of stream nanoseconds."""

    fraction_start = value.find(".", 10)
    if fraction_start < 0:
        return parsed
    fraction_end = len(value)
    for separator in ("Z", "+", "-"):
        separator_at = value.find(separator, fraction_start + 1)
        if separator_at >= 0:
            fraction_end = min(fraction_end, separator_at)
    fraction = value[fraction_start + 1 : fraction_end]
    if len(fraction) > 6 and fraction[6] >= "5":
        return parsed + timedelta(microseconds=1)
    return parsed


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
    observation: BrokerActivityObservation,
    fields: _ActivityFields,
) -> str:
    """Hash fields that mean the same thing across stream and REST shapes."""

    payload = {
        "account_label": observation.account_label.strip(),
        "activity_subtype": (
            fields.activity_subtype.strip().lower() if fields.activity_subtype else None
        ),
        "activity_type": fields.activity_type.strip().upper(),
        "correction_of_external_id": fields.correction_of_external_id,
        "currency": fields.currency.strip().upper() if fields.currency else None,
        "environment": observation.environment.strip().lower(),
        "event_at": (
            as_utc(fields.event_at).isoformat(timespec="microseconds")
            if fields.event_at is not None
            else None
        ),
        "net_amount": _canonical_decimal(fields.net_amount),
        "order_id": fields.order_id,
        "price": _canonical_decimal(fields.price),
        "quantity": _canonical_decimal(fields.quantity),
        "settle_date": (
            fields.settle_date.isoformat() if fields.settle_date is not None else None
        ),
        "side": fields.side.strip().lower() if fields.side else None,
        "symbol": _canonical_symbol(fields.symbol),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _settle_date(payload: Mapping[str, object]) -> date | None:
    activity_date = _optional_text(payload, "date", maximum=32)
    if activity_date is None:
        return None
    try:
        return datetime.fromisoformat(activity_date.replace("Z", "+00:00")).date()
    except ValueError as exc:
        raise BrokerAccountActivityPayloadError(
            "broker_account_activity_date_invalid"
        ) from exc


def _rest_activity_fields(payload: Mapping[str, object]) -> _ActivityFields:
    return _ActivityFields(
        external_activity_id=required_text(payload, "id", maximum=256),
        activity_type=required_text(payload, "activity_type", maximum=32).upper(),
        activity_subtype=_optional_text(payload, "type", maximum=32),
        correction_of_external_id=_optional_text(payload, "previous_id", maximum=256),
        event_at=_optional_datetime(payload, "transaction_time"),
        settle_date=_settle_date(payload),
        order_id=_optional_text(payload, "order_id", maximum=128),
        client_order_id=_optional_text(payload, "client_order_id", maximum=128),
        symbol=_optional_text(payload, "symbol", maximum=64),
        side=_optional_text(payload, "side", maximum=16),
        quantity=_optional_decimal(payload, "qty"),
        price=_optional_decimal(payload, "price"),
        cumulative_quantity=_optional_decimal(payload, "cum_qty"),
        leaves_quantity=_optional_decimal(payload, "leaves_qty"),
        net_amount=_optional_decimal(payload, "net_amount"),
        currency=_optional_text(payload, "currency", maximum=16),
    )


def normalize_broker_account_activity(
    payload: Mapping[str, object],
    *,
    observation: BrokerActivityObservation,
    source_page_token: str | None,
) -> BrokerAccountActivity:
    """Normalize common REST fields while preserving the exact broker document."""

    raw_payload = dict(payload)
    canonical, payload_sha256 = _canonical_payload(raw_payload)
    fields = _rest_activity_fields(raw_payload)
    return BrokerAccountActivity(
        provider=ALPACA_PROVIDER,
        source=ACCOUNT_ACTIVITIES_REST_SOURCE,
        environment=observation.environment,
        account_label=observation.account_label,
        endpoint_fingerprint=observation.endpoint_fingerprint,
        external_activity_id=fields.external_activity_id,
        activity_type=fields.activity_type,
        activity_subtype=fields.activity_subtype,
        correction_of_external_id=fields.correction_of_external_id,
        event_at=fields.event_at,
        settle_date=fields.settle_date,
        order_id=fields.order_id,
        client_order_id=fields.client_order_id,
        symbol=fields.symbol,
        side=fields.side,
        quantity=fields.quantity,
        price=fields.price,
        cumulative_quantity=fields.cumulative_quantity,
        leaves_quantity=fields.leaves_quantity,
        net_amount=fields.net_amount,
        currency=fields.currency,
        raw_payload=raw_payload,
        raw_payload_canonical_json=canonical,
        raw_payload_sha256=payload_sha256,
        normalized_economic_sha256=_normalized_economic_digest(observation, fields),
        source_page_token=source_page_token,
        source_topic=None,
        source_partition=None,
        source_offset=None,
        first_observed_at=as_utc(observation.observed_at),
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


def _stream_event_at(
    payload: Mapping[str, object],
    order: Mapping[str, object],
) -> datetime | None:
    for key in ("timestamp", "at", "t"):
        if payload.get(key) is not None:
            return _optional_datetime(payload, key)
    for key in ("updated_at", "submitted_at"):
        if order.get(key) is not None:
            return _optional_datetime(order, key)
    return None


def _stream_order_id(order: Mapping[str, object]) -> str | None:
    return _optional_text(order, "id", maximum=128) or _optional_text(
        order, "order_id", maximum=128
    )


def _stream_quantities(
    payload: Mapping[str, object],
    order: Mapping[str, object],
    *,
    activity_type: str,
) -> tuple[Decimal | None, Decimal | None, Decimal | None, Decimal | None]:
    quantity = _optional_decimal(payload if activity_type == "FILL" else order, "qty")
    price = _optional_decimal(payload, "price") if activity_type == "FILL" else None
    cumulative = _optional_decimal(order, "filled_qty")
    order_quantity = _optional_decimal(order, "qty")
    leaves = None
    if order_quantity is not None and cumulative is not None:
        leaves = max(Decimal("0"), order_quantity - cumulative)
    return quantity, price, cumulative, leaves


def _stream_activity_fields(
    payload: Mapping[str, object],
    *,
    event_fingerprint: str,
) -> _ActivityFields:
    order = _mapping(payload.get("order")) or {}
    activity_subtype = _optional_text(payload, "event", maximum=32) or _optional_text(
        payload, "event_type", maximum=32
    )
    if activity_subtype is None:
        raise BrokerAccountActivityPayloadError("broker_trade_update_event_invalid")
    normalized_subtype = activity_subtype.lower()
    activity_type = (
        "FILL"
        if normalized_subtype in {"fill", "partial_fill", "trade_bust", "trade_correct"}
        else "ORDER"
    )
    quantity, price, cumulative, leaves = _stream_quantities(
        payload,
        order,
        activity_type=activity_type,
    )
    return _ActivityFields(
        external_activity_id=(
            _optional_text(payload, "event_id", maximum=256)
            or _optional_text(payload, "execution_id", maximum=256)
            or event_fingerprint
        ),
        activity_type=activity_type,
        activity_subtype=normalized_subtype,
        correction_of_external_id=(
            _optional_text(payload, "previous_id", maximum=256)
            or _optional_text(payload, "original_execution_id", maximum=256)
        ),
        event_at=_stream_event_at(payload, order),
        order_id=_stream_order_id(order),
        client_order_id=_optional_text(order, "client_order_id", maximum=128),
        symbol=_optional_text(order, "symbol", maximum=64),
        side=_optional_text(order, "side", maximum=16),
        quantity=quantity,
        price=price,
        cumulative_quantity=cumulative,
        leaves_quantity=leaves,
    )


def normalize_broker_trade_update(
    raw_event: Mapping[str, object],
    *,
    event_fingerprint: str,
    observation: BrokerActivityObservation,
    position: BrokerStreamPosition,
) -> BrokerAccountActivity:
    """Preserve one broker WebSocket order update as an immutable source fact."""

    if position.partition < 0 or position.offset < 0 or not position.topic.strip():
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
    canonical, payload_sha256 = _canonical_payload(broker_payload)
    fields = _stream_activity_fields(
        broker_payload,
        event_fingerprint=event_fingerprint,
    )
    return BrokerAccountActivity(
        provider=ALPACA_PROVIDER,
        source=_TRADE_UPDATE_SOURCE,
        environment=observation.environment,
        account_label=observation.account_label,
        endpoint_fingerprint=observation.endpoint_fingerprint,
        external_activity_id=fields.external_activity_id,
        activity_type=fields.activity_type,
        activity_subtype=fields.activity_subtype,
        correction_of_external_id=fields.correction_of_external_id,
        event_at=fields.event_at,
        settle_date=fields.settle_date,
        order_id=fields.order_id,
        client_order_id=fields.client_order_id,
        symbol=fields.symbol,
        side=fields.side,
        quantity=fields.quantity,
        price=fields.price,
        cumulative_quantity=fields.cumulative_quantity,
        leaves_quantity=fields.leaves_quantity,
        net_amount=fields.net_amount,
        currency=fields.currency,
        raw_payload=broker_payload,
        raw_payload_canonical_json=canonical,
        raw_payload_sha256=payload_sha256,
        normalized_economic_sha256=_normalized_economic_digest(observation, fields),
        source_page_token=None,
        source_topic=position.topic,
        source_partition=position.partition,
        source_offset=position.offset,
        first_observed_at=as_utc(observation.observed_at),
    )


def persist_broker_trade_update(
    session: Session,
    raw_event: Mapping[str, object],
    *,
    event_fingerprint: str,
    observation: BrokerActivityObservation,
    position: BrokerStreamPosition,
) -> tuple[BrokerAccountActivity, bool]:
    """Append one stream fact, deduplicating only byte-equivalent broker events."""

    row = normalize_broker_trade_update(
        raw_event,
        event_fingerprint=event_fingerprint,
        observation=observation,
        position=position,
    )
    existing = session.scalar(
        select(BrokerAccountActivity).where(
            BrokerAccountActivity.provider == ALPACA_PROVIDER,
            BrokerAccountActivity.source == _TRADE_UPDATE_SOURCE,
            BrokerAccountActivity.environment == observation.environment,
            BrokerAccountActivity.account_label == observation.account_label,
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
    last_completed_at = (
        as_utc(cursor.last_completed_at)
        if cursor.last_completed_at is not None
        else None
    )
    freshness_at = (
        last_completed_at
        if cursor.status in {"complete", "scanning"} and last_completed_at is not None
        else updated_at
    )
    age_seconds = max(0, int((observed - freshness_at).total_seconds()))
    reasons: list[str] = []
    has_completed_scan = (
        last_completed_at is not None and cursor.last_completed_scan_until is not None
    )
    if cursor.status != "complete" and not (
        cursor.status == "scanning" and has_completed_scan
    ):
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
    rest = _source_counter(rows, ACCOUNT_ACTIVITIES_REST_SOURCE)
    stream = _source_counter(rows, _TRADE_UPDATE_SOURCE)
    missing_from_rest = stream - rest
    missing_from_stream = rest - stream
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
        "source_hashes": {
            source: _source_payload_hashes(rows, source)
            for source in (ACCOUNT_ACTIVITIES_REST_SOURCE, _TRADE_UPDATE_SOURCE)
        },
    }


def _source_counter(
    rows: Iterable[BrokerAccountActivity],
    source: str,
) -> Counter[str]:
    return Counter(
        row.normalized_economic_sha256 for row in rows if row.source == source
    )


def _source_payload_hashes(
    rows: Iterable[BrokerAccountActivity],
    source: str,
) -> list[str]:
    return sorted(row.raw_payload_sha256 for row in rows if row.source == source)


def _multiset_digest(values: Counter[str]) -> str:
    canonical = json.dumps(sorted(values.elements()), separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


__all__ = (
    "ACCOUNT_ACTIVITIES_REST_SOURCE",
    "ALPACA_PROVIDER",
    "BrokerAccountActivityContradiction",
    "BrokerAccountActivityError",
    "BrokerAccountActivityPayloadError",
    "BrokerActivityObservation",
    "BrokerStreamPosition",
    "as_utc",
    "compare_broker_fill_sources",
    "load_broker_account_activity_status",
    "normalize_broker_account_activity",
    "normalize_broker_trade_update",
    "persist_broker_trade_update",
    "required_text",
)
