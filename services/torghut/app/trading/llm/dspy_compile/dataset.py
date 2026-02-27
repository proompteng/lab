"""Deterministic DSPy dataset builder for Torghut compile/eval lanes."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from sqlalchemy import select
from sqlalchemy.orm import Session

from ....models import LLMDecisionReview, TradeDecision, coerce_json_payload
from .hashing import canonical_json, hash_payload

DATASET_SCHEMA_VERSION = "torghut.dspy.dataset.v1"
DATASET_METADATA_SCHEMA_VERSION = "torghut.dspy.dataset.metadata.v1"
DEFAULT_SAMPLING_SEED = "torghut-dspy-dataset-seed-v1"

_SPLIT_RATIOS = {
    "train": 0.8,
    "eval": 0.1,
    "test": 0.1,
}

_ISO_8601_WINDOW_PATTERN = re.compile(
    r"^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<minutes>\d+)M)?(?:(?P<seconds>\d+)S)?)?$"
)


@dataclass(frozen=True)
class DSPyDatasetBuildResult:
    dataset_path: Path
    metadata_path: Path
    dataset_hash: str
    row_counts_by_split: dict[str, int]
    total_rows: int


def build_dspy_dataset_artifacts(
    session: Session,
    *,
    repository: str,
    base: str,
    head: str,
    artifact_path: Path | str,
    dataset_window: str,
    universe_ref: str,
    source_refs: Sequence[str] | None = None,
    sampling_seed: str = DEFAULT_SAMPLING_SEED,
    window_end: datetime | None = None,
) -> DSPyDatasetBuildResult:
    """Materialize deterministic DSPy dataset and metadata artifacts."""

    normalized_repository = repository.strip()
    normalized_base = base.strip()
    normalized_head = head.strip()
    normalized_universe_ref = universe_ref.strip()
    normalized_seed = sampling_seed.strip() or DEFAULT_SAMPLING_SEED

    if not normalized_repository:
        raise ValueError("repository_required")
    if not normalized_base:
        raise ValueError("base_required")
    if not normalized_head:
        raise ValueError("head_required")
    if not normalized_universe_ref:
        raise ValueError("universe_ref_required")

    duration = _parse_dataset_window(dataset_window)
    resolved_window_end = _coerce_utc_datetime(window_end or datetime.now(timezone.utc))
    resolved_window_start = resolved_window_end - duration
    resolved_filter = _resolve_symbol_filter(normalized_universe_ref)

    rows = _query_dataset_source_rows(
        session=session,
        window_start=resolved_window_start,
        window_end=resolved_window_end,
        symbols=resolved_filter.symbols,
    )

    dataset_rows: list[dict[str, Any]] = []
    row_counts_by_split = {"train": 0, "eval": 0, "test": 0}
    decision_ids: set[str] = set()
    rows_with_market_context = 0

    for decision, review in rows:
        dataset_row = _build_dataset_row(
            decision=decision,
            review=review,
            sampling_seed=normalized_seed,
        )
        split = cast(str, dataset_row["split"])
        row_counts_by_split[split] = row_counts_by_split.get(split, 0) + 1
        decision_ids.add(cast(str, dataset_row["decision"]["decisionId"]))
        input_payload = cast(dict[str, Any], dataset_row["input"])
        if cast(dict[str, Any], input_payload["marketContext"]):
            rows_with_market_context += 1
        dataset_rows.append(dataset_row)

    dataset_payload = {
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "rows": dataset_rows,
    }
    dataset_hash = hash_payload(dataset_payload)

    metadata_payload = {
        "schemaVersion": DATASET_METADATA_SCHEMA_VERSION,
        "generatedAt": _iso_utc(datetime.now(timezone.utc)),
        "repository": normalized_repository,
        "base": normalized_base,
        "head": normalized_head,
        "datasetHash": dataset_hash,
        "window": {
            "datasetWindow": dataset_window.strip(),
            "startUtc": _iso_utc(resolved_window_start),
            "endUtc": _iso_utc(resolved_window_end),
            "durationSeconds": int(duration.total_seconds()),
        },
        "filters": {
            "universeRef": normalized_universe_ref,
            "symbolFilter": sorted(resolved_filter.symbols)
            if resolved_filter.symbols is not None
            else [],
            "symbolFilterMode": resolved_filter.mode,
        },
        "sampling": {
            "seed": normalized_seed,
            "strategy": "sha256(seed:reviewId)",
            "splits": dict(_SPLIT_RATIOS),
        },
        "sourceRefs": sorted(
            {
                "torghut.postgres.trade_decisions",
                "torghut.postgres.llm_decision_reviews",
                "torghut.llm_review.input_json.market_context",
                *(_normalize_source_refs(source_refs)),
            }
        ),
        "stats": {
            "decisionCount": len(decision_ids),
            "reviewCount": len(dataset_rows),
            "rowsWithMarketContext": rows_with_market_context,
            "rowsWithoutMarketContext": max(
                len(dataset_rows) - rows_with_market_context, 0
            ),
            "rowCountsBySplit": row_counts_by_split,
        },
    }

    output_dir = Path(artifact_path)
    output_dir.mkdir(parents=True, exist_ok=True)
    dataset_path = output_dir / "dspy-dataset.json"
    metadata_path = output_dir / "dspy-dataset-metadata.json"

    dataset_path.write_text(canonical_json(dataset_payload) + "\n", encoding="utf-8")
    metadata_path.write_text(canonical_json(metadata_payload) + "\n", encoding="utf-8")

    return DSPyDatasetBuildResult(
        dataset_path=dataset_path,
        metadata_path=metadata_path,
        dataset_hash=dataset_hash,
        row_counts_by_split=row_counts_by_split,
        total_rows=len(dataset_rows),
    )


@dataclass(frozen=True)
class _UniverseFilter:
    mode: str
    symbols: set[str] | None


def _resolve_symbol_filter(universe_ref: str) -> _UniverseFilter:
    normalized = universe_ref.strip()
    if not normalized:
        return _UniverseFilter(mode="all", symbols=None)

    lowered = normalized.lower()
    if lowered in {"all", "*", "torghut:all"}:
        return _UniverseFilter(mode="all", symbols=None)

    if lowered.startswith("symbols:"):
        raw_symbols = normalized.split(":", 1)[1]
        parsed_symbols = {
            symbol.strip().upper()
            for symbol in raw_symbols.split(",")
            if symbol.strip()
        }
        return _UniverseFilter(mode="explicit", symbols=parsed_symbols)

    if lowered == "torghut:equity:enabled":
        return _UniverseFilter(mode="equity_enabled_hint", symbols=None)

    return _UniverseFilter(mode="unrecognized_ref", symbols=None)


def _query_dataset_source_rows(
    *,
    session: Session,
    window_start: datetime,
    window_end: datetime,
    symbols: set[str] | None,
) -> list[tuple[TradeDecision, LLMDecisionReview]]:
    stmt = (
        select(TradeDecision, LLMDecisionReview)
        .join(
            LLMDecisionReview,
            LLMDecisionReview.trade_decision_id == TradeDecision.id,
        )
        .where(TradeDecision.created_at >= window_start)
        .where(TradeDecision.created_at < window_end)
        .order_by(
            TradeDecision.created_at.asc(),
            LLMDecisionReview.created_at.asc(),
            LLMDecisionReview.id.asc(),
        )
    )
    if symbols:
        stmt = stmt.where(TradeDecision.symbol.in_(sorted(symbols)))
    rows = session.execute(stmt).all()
    return [
        (cast(TradeDecision, row[0]), cast(LLMDecisionReview, row[1])) for row in rows
    ]


def _build_dataset_row(
    *,
    decision: TradeDecision,
    review: LLMDecisionReview,
    sampling_seed: str,
) -> dict[str, Any]:
    decision_payload = _as_mapping(coerce_json_payload(decision.decision_json))
    request_payload = _as_mapping(coerce_json_payload(review.input_json))
    response_payload = _as_mapping(coerce_json_payload(review.response_json))
    market_context_payload = _extract_market_context_payload(request_payload)

    review_id = str(review.id)
    split = _resolve_split(review_id=review_id, seed=sampling_seed)
    review_confidence = _decimal_to_float(review.confidence)

    return cast(
        dict[str, Any],
        coerce_json_payload(
            {
                "rowId": review_id,
                "split": split,
                "decision": {
                    "decisionId": str(decision.id),
                    "strategyId": str(decision.strategy_id),
                    "symbol": decision.symbol,
                    "timeframe": decision.timeframe,
                    "status": decision.status,
                    "createdAt": _iso_utc(_coerce_utc_datetime(decision.created_at)),
                    "executedAt": (
                        _iso_utc(_coerce_utc_datetime(decision.executed_at))
                        if decision.executed_at is not None
                        else None
                    ),
                    "decisionHash": decision.decision_hash,
                    "decisionJson": decision_payload,
                    "rationale": decision.rationale,
                },
                "review": {
                    "reviewId": review_id,
                    "createdAt": _iso_utc(_coerce_utc_datetime(review.created_at)),
                    "model": review.model,
                    "promptVersion": review.prompt_version,
                    "verdict": review.verdict,
                    "confidence": review_confidence,
                    "adjustedQty": _decimal_to_string(review.adjusted_qty),
                    "adjustedOrderType": review.adjusted_order_type,
                    "rationale": review.rationale,
                    "riskFlags": _normalize_risk_flags(review.risk_flags),
                    "tokensPrompt": review.tokens_prompt,
                    "tokensCompletion": review.tokens_completion,
                },
                "input": {
                    "requestJson": request_payload,
                    "marketContext": market_context_payload,
                },
                "label": {
                    "responseJson": response_payload,
                    "verdict": review.verdict,
                },
            }
        ),
    )


def _extract_market_context_payload(payload: Mapping[str, Any]) -> dict[str, Any]:
    direct = _as_mapping(payload.get("market_context"))
    if direct:
        return direct
    camel = _as_mapping(payload.get("marketContext"))
    if camel:
        return camel
    if "contextVersion" in payload and "domains" in payload:
        return dict(payload)
    return {}


def _resolve_split(*, review_id: str, seed: str) -> str:
    digest = hashlib.sha256(f"{seed}:{review_id}".encode("utf-8")).hexdigest()
    sample = int(digest[:16], 16) / float(0xFFFFFFFFFFFFFFFF)
    if sample < _SPLIT_RATIOS["train"]:
        return "train"
    if sample < _SPLIT_RATIOS["train"] + _SPLIT_RATIOS["eval"]:
        return "eval"
    return "test"


def _parse_dataset_window(raw_window: str) -> timedelta:
    normalized = raw_window.strip().upper()
    match = _ISO_8601_WINDOW_PATTERN.fullmatch(normalized)
    if match is None:
        raise ValueError("dataset_window_invalid_iso8601_duration")

    days = int(match.group("days") or "0")
    hours = int(match.group("hours") or "0")
    minutes = int(match.group("minutes") or "0")
    seconds = int(match.group("seconds") or "0")
    duration = timedelta(days=days, hours=hours, minutes=minutes, seconds=seconds)
    if duration.total_seconds() <= 0:
        raise ValueError("dataset_window_must_be_positive")
    return duration


def _coerce_utc_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso_utc(value: datetime) -> str:
    return _coerce_utc_datetime(value).isoformat().replace("+00:00", "Z")


def _as_mapping(value: object) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[object, Any], value).items()}


def _decimal_to_float(value: Decimal | None) -> float | None:
    if value is None:
        return None
    return float(value)


def _decimal_to_string(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return str(value)


def _normalize_risk_flags(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [
            str(item).strip() for item in cast(list[Any], value) if str(item).strip()
        ]
    if isinstance(value, Mapping):
        return [
            str(key).strip()
            for key in cast(Mapping[object, Any], value).keys()
            if str(key).strip()
        ]
    text = str(value).strip()
    return [text] if text else []


def _normalize_source_refs(source_refs: Sequence[str] | None) -> list[str]:
    if source_refs is None:
        return []
    return [ref.strip() for ref in source_refs if ref.strip()]


__all__ = [
    "DATASET_METADATA_SCHEMA_VERSION",
    "DATASET_SCHEMA_VERSION",
    "DEFAULT_SAMPLING_SEED",
    "DSPyDatasetBuildResult",
    "build_dspy_dataset_artifacts",
]
