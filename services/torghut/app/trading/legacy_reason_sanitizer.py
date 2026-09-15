"""Normalize retired reason codes in operator-facing payloads."""

from __future__ import annotations

from collections.abc import Mapping
from typing import cast


_ALPHA_READINESS_PREFIX = "alpha_readiness_"
_RETIRE_ALPHA_READINESS_PREFIX = "retire_alpha_readiness_"
_NOT_PROMOTION_ELIGIBLE_SUFFIX = "not_promotion_eligible"
_HYPOTHESIS_NOT_PROMOTION_ELIGIBLE = "hypothesis_not_promotion_eligible"
_RETIRE_HYPOTHESIS_NOT_PROMOTION_ELIGIBLE = "retire_hypothesis_not_promotion_eligible"


def sanitize_legacy_alpha_readiness_reasons(value: object) -> object:
    """Remove retired alpha-readiness reason codes from JSON-like payloads."""

    if isinstance(value, str):
        return _sanitize_reason(value)
    if isinstance(value, Mapping):
        payload = cast(Mapping[object, object], value)
        return {
            str(key): sanitize_legacy_alpha_readiness_reasons(item)
            for key, item in payload.items()
        }
    if isinstance(value, list):
        items = cast(list[object], value)
        sanitized = [sanitize_legacy_alpha_readiness_reasons(item) for item in items]
        if all(isinstance(item, str) for item in sanitized):
            return _dedupe_strings(sanitized)
        return sanitized
    return value


def _sanitize_reason(reason: str) -> str:
    if reason.startswith(_RETIRE_ALPHA_READINESS_PREFIX) and reason.endswith(
        _NOT_PROMOTION_ELIGIBLE_SUFFIX
    ):
        return _RETIRE_HYPOTHESIS_NOT_PROMOTION_ELIGIBLE
    if reason.startswith(_ALPHA_READINESS_PREFIX) and reason.endswith(
        _NOT_PROMOTION_ELIGIBLE_SUFFIX
    ):
        return _HYPOTHESIS_NOT_PROMOTION_ELIGIBLE
    return reason


def _dedupe_strings(items: list[object]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = str(item)
        if text in seen:
            continue
        seen.add(text)
        deduped.append(text)
    return deduped


__all__ = ["sanitize_legacy_alpha_readiness_reasons"]
