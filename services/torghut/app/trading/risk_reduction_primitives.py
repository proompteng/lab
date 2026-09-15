"""Normalization and signing primitives for risk-reduction authority."""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from datetime import datetime, timezone
from decimal import Decimal

from .broker_mutation_receipts import BrokerMutationReceiptValidationError


_PERMIT_SIGNING_KEY = secrets.token_bytes(32)


class RiskReductionPermitError(BrokerMutationReceiptValidationError):
    """The observed broker state cannot authorize the requested reduction."""


def aware_utc(value: datetime, *, field_name: str) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise RiskReductionPermitError(f"{field_name}_timezone_required")
    return value.astimezone(timezone.utc)


def positive_decimal(value: Decimal, *, field_name: str) -> Decimal:
    normalized = Decimal(value)
    if not normalized.is_finite() or normalized <= 0:
        raise RiskReductionPermitError(f"{field_name}_must_be_positive")
    return normalized.normalize()


def nonnegative_decimal(value: Decimal, *, field_name: str) -> Decimal:
    normalized = Decimal(value)
    if not normalized.is_finite() or normalized < 0:
        raise RiskReductionPermitError(f"{field_name}_must_be_nonnegative")
    return Decimal("0") if normalized == 0 else normalized.normalize()


def required_text(value: str, *, field_name: str, maximum: int = 256) -> str:
    normalized = str(value).strip()
    if not normalized or len(normalized) > maximum:
        raise RiskReductionPermitError(f"{field_name}_invalid")
    return normalized


def symbol(value: str) -> str:
    return required_text(value, field_name="symbol", maximum=32).upper()


def decimal_text(value: Decimal) -> str:
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


def permit_tag(fields: tuple[object, ...]) -> str:
    payload = json.dumps(
        [str(value) for value in fields],
        ensure_ascii=True,
        separators=(",", ":"),
    )
    return hmac.new(
        _PERMIT_SIGNING_KEY,
        payload.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


__all__ = [
    "RiskReductionPermitError",
    "aware_utc",
    "decimal_text",
    "nonnegative_decimal",
    "permit_tag",
    "positive_decimal",
    "required_text",
    "symbol",
]
