"""Whitepaper claim graph validation and hypothesis-card compilation."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.hypothesis_cards import (
    HypothesisCard,
    build_hypothesis_cards,
)

from .models import (
    FEATURE_BLOCKER_CLAIM_TYPES,
    FEATURE_BLOCKER_RELATION_TYPES,
    FEATURE_FIELD_KEYS,
    FEATURE_RECIPE_CLAIM_TYPES,
    MECHANISM_CLAIM_TYPES,
    RISK_VALIDATION_CLAIM_TYPES,
    RISK_VALIDATION_RELATION_TYPES,
    WhitepaperResearchSource,
)


def _string(value: Any) -> str:
    return str(value or "").strip()


def _strings_from_value(value: Any) -> tuple[str, ...]:
    if value is None:
        return ()
    if isinstance(value, str):
        values: Sequence[Any] = (value,)
    elif isinstance(value, list):
        values = cast(list[Any], value)
    elif isinstance(value, tuple):
        values = cast(tuple[Any, ...], value)
    elif isinstance(value, set):
        values = tuple(cast(set[Any], value))
    else:
        return ()
    resolved: list[str] = []
    for item in values:
        text = _string(item)
        if text and text not in resolved:
            resolved.append(text)
    return tuple(resolved)


def _claim_type(claim: Mapping[str, Any]) -> str:
    return _string(claim.get("claim_type")).lower()


def _claim_text(claim: Mapping[str, Any]) -> str:
    return _string(claim.get("claim_text")) or _string(claim.get("claim"))


def _relation_type(relation: Mapping[str, Any]) -> str:
    return _string(relation.get("relation_type")).lower()


def _claim_feature_terms(claim: Mapping[str, Any]) -> tuple[str, ...]:
    metadata = claim.get("metadata")
    metadata_payload: Mapping[str, Any] = (
        cast(Mapping[str, Any], metadata) if isinstance(metadata, Mapping) else {}
    )
    terms: list[str] = []
    for key in FEATURE_FIELD_KEYS:
        terms.extend(_strings_from_value(claim.get(key)))
        terms.extend(_strings_from_value(metadata_payload.get(key)))
    return tuple(dict.fromkeys(terms))


def _has_mechanism(claims: Sequence[Mapping[str, Any]]) -> bool:
    return any(
        _claim_type(claim) in MECHANISM_CLAIM_TYPES and bool(_claim_text(claim))
        for claim in claims
    )


def _has_feature_recipe_or_blocker(
    claims: Sequence[Mapping[str, Any]],
    relations: Sequence[Mapping[str, Any]],
) -> bool:
    for claim in claims:
        claim_type = _claim_type(claim)
        if claim_type in FEATURE_RECIPE_CLAIM_TYPES | FEATURE_BLOCKER_CLAIM_TYPES:
            return True
        if _claim_feature_terms(claim):
            return True
    return any(
        _relation_type(relation) in FEATURE_BLOCKER_RELATION_TYPES
        for relation in relations
    )


def _has_risk_validation_constraint(
    claims: Sequence[Mapping[str, Any]],
    relations: Sequence[Mapping[str, Any]],
) -> bool:
    if any(
        _claim_type(claim) in RISK_VALIDATION_CLAIM_TYPES and bool(_claim_text(claim))
        for claim in claims
    ):
        return True
    return any(
        _relation_type(relation) in RISK_VALIDATION_RELATION_TYPES
        for relation in relations
    )


def claim_subgraph_blockers(source: WhitepaperResearchSource) -> tuple[str, ...]:
    """Return deterministic reasons this source cannot produce executable hypotheses."""

    claims = tuple(dict(item) for item in source.claims)
    relations = tuple(dict(item) for item in source.claim_relations)
    blockers: list[str] = []
    if not _string(source.run_id):
        blockers.append("source_run_id_missing")
    if not claims:
        blockers.append("claims_missing")
    if claims and not any(_claim_text(claim) for claim in claims):
        blockers.append("claim_text_missing")
    if not _has_mechanism(claims):
        blockers.append("mechanism_missing")
    if not _has_feature_recipe_or_blocker(claims, relations):
        blockers.append("feature_recipe_or_blocker_missing")
    if not _has_risk_validation_constraint(claims, relations):
        blockers.append("risk_or_validation_constraint_missing")
    return tuple(blockers)


def compile_sources_to_hypothesis_cards(
    sources: Sequence[WhitepaperResearchSource],
) -> list[HypothesisCard]:
    cards: list[HypothesisCard] = []
    for source in sources:
        if claim_subgraph_blockers(source):
            continue
        cards.extend(
            build_hypothesis_cards(
                source_run_id=source.run_id,
                claims=source.claims,
                relations=source.claim_relations,
            )
        )
    return cards


def source_from_payload(payload: Mapping[str, Any]) -> WhitepaperResearchSource:
    claims = payload.get("claims")
    relations = payload.get("claim_relations")
    claim_rows = cast(list[Any], claims) if isinstance(claims, list) else []
    relation_rows = cast(list[Any], relations) if isinstance(relations, list) else []
    return WhitepaperResearchSource(
        run_id=str(payload.get("run_id") or "").strip(),
        title=str(payload.get("title") or "").strip(),
        source_url=str(payload.get("source_url") or "").strip(),
        published_at=str(payload.get("published_at") or "").strip(),
        claims=tuple(
            cast(Mapping[str, Any], item)
            for item in claim_rows
            if isinstance(item, Mapping)
        ),
        claim_relations=tuple(
            cast(Mapping[str, Any], item)
            for item in relation_rows
            if isinstance(item, Mapping)
        ),
    )


def sources_from_jsonl(path: Path) -> list[WhitepaperResearchSource]:
    sources: list[WhitepaperResearchSource] = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"whitepaper_source_jsonl_invalid_json:{path}:{line_number}"
            ) from exc
        if not isinstance(payload, Mapping):
            raise ValueError(
                f"whitepaper_source_jsonl_row_not_mapping:{path}:{line_number}"
            )
        sources.append(source_from_payload(cast(Mapping[str, Any], payload)))
    return sources
