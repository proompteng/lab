"""Market-context domain policy for Torghut decision gates."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, cast

ACTIVE_MARKET_CONTEXT_DOMAINS: tuple[str, ...] = ("technicals", "regime")
RETIRED_MARKET_CONTEXT_DOMAINS: frozenset[str] = frozenset({"fundamentals", "news"})


def is_active_market_context_domain(value: object) -> bool:
    return str(value).strip().lower() in ACTIVE_MARKET_CONTEXT_DOMAINS


def is_retired_market_context_reason(value: object) -> bool:
    normalized = str(value).strip().lower().replace("-", "_")
    if not normalized:
        return False
    return bool(RETIRED_MARKET_CONTEXT_DOMAINS.intersection(normalized.split("_")))


def active_market_context_reasons(values: object) -> list[str]:
    if isinstance(values, str):
        raw_values: tuple[object, ...] = (values,)
    elif isinstance(values, (list, tuple, set)):
        raw_values = tuple(cast(Iterable[object], values))
    else:
        raw_values = ()
    reasons: list[str] = []
    for value in raw_values:
        if value is None:
            continue
        text = str(value).strip()
        if text and not is_retired_market_context_reason(text):
            reasons.append(text)
    return reasons


def active_market_context_mapping(domains: Mapping[str, Any]) -> dict[str, Any]:
    return {
        str(name).strip().lower(): value
        for name, value in domains.items()
        if is_active_market_context_domain(name)
    }


def active_market_context_bundle_domains(bundle: object) -> dict[str, Any]:
    domains = getattr(bundle, "domains", None)
    if domains is None:
        return {}
    active: dict[str, Any] = {}
    for name in ACTIVE_MARKET_CONTEXT_DOMAINS:
        domain = getattr(domains, name, None)
        if domain is not None:
            active[name] = domain
    return active


def active_market_context_domain_states(bundle: object) -> dict[str, str]:
    return {
        name: str(getattr(domain, "state", "")).strip().lower()
        for name, domain in active_market_context_bundle_domains(bundle).items()
    }


def active_market_context_freshness_seconds(bundle: object) -> int:
    freshness_values = [
        int(freshness)
        for domain in active_market_context_bundle_domains(bundle).values()
        if (freshness := getattr(domain, "freshness_seconds", None)) is not None
    ]
    if freshness_values:
        return max(freshness_values)
    return int(getattr(bundle, "freshness_seconds", 0))


def active_market_context_quality_score(bundle: object) -> float:
    quality_values = [
        float(getattr(domain, "quality_score"))
        for domain in active_market_context_bundle_domains(bundle).values()
        if getattr(domain, "quality_score", None) is not None
    ]
    if quality_values:
        return min(quality_values)
    return float(getattr(bundle, "quality_score", 0.0))


__all__ = [
    "ACTIVE_MARKET_CONTEXT_DOMAINS",
    "RETIRED_MARKET_CONTEXT_DOMAINS",
    "active_market_context_bundle_domains",
    "active_market_context_domain_states",
    "active_market_context_freshness_seconds",
    "active_market_context_mapping",
    "active_market_context_quality_score",
    "active_market_context_reasons",
    "is_active_market_context_domain",
    "is_retired_market_context_reason",
]
