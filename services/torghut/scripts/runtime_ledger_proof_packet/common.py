"""Shared constants and scalar helpers for runtime-ledger proof packet assembly."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol, cast

from app.trading.runtime_ledger_proof_policy import (
    DEFAULT_RUNTIME_LEDGER_PROOF_MODE,
    RUNTIME_LEDGER_PROOF_MODES,
    normalize_runtime_ledger_proof_mode,
    runtime_ledger_proof_policy_from_env,
)

SCHEMA_VERSION = "torghut.runtime-ledger-live-paper-proof-packet.v1"
DOC29_LIVE_SCALE_GATE = "live_scale_observed"
DEFAULT_RUNTIME_LEDGER_PROOF_POLICY = runtime_ledger_proof_policy_from_env()
RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER = (
    "runtime_ledger_proof_mode_not_authority"
)
STATUS_ENDPOINT = "/trading/status"
PAPER_ROUTE_EVIDENCE_ENDPOINT = (
    "/trading/proofs?kind=runtime_window&window=latest_closed&full_audit=true"
)
COMPLETION_DOC29_ENDPOINT = "/trading/completion/doc29"
ARTIFACT_SCHEMA_VERSION = "torghut.runtime-ledger-proof-packet-artifact.v1"
HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION = (
    "torghut.hpairs-source-proof-census-status.v1"
)
CAPITAL_PROMOTION_STATUS_BLOCKERS = frozenset(
    {
        "alpha_hypothesis_not_promotion_eligible",
        "alpha_hypothesis_shadow_only",
        "alpha_readiness_not_promotion_eligible",
        "drift_checks_not_ok",
        "hypothesis_window_evidence_stale",
        "paper_probation_evidence_collection_only",
        "post_cost_expectancy_below_manifest_threshold",
        "promotion_certificate_not_live_runtime",
        "promotion_certificate_shadow_only",
        "promotion_decision_not_allowed",
        "runtime_ledger_stage_not_live",
        "sample_count_below_canary_minimum",
        "simple_submit_disabled",
        "order_feed_lifecycle_disabled",
    }
)
CAPITAL_PROMOTION_STATUS_BLOCKER_PREFIXES = (
    "alpha_",
    "promotion_",
    "paper_probation_",
)
RUNTIME_IMPORT_MATERIALIZATION_PROMOTION_ONLY_BLOCKERS = frozenset(
    {
        "candidate_board_promotion_not_allowed",
        "final_promotion_not_authorized",
        "final_promotion_not_allowed",
        "live_runtime_ledger_required",
        "paper_probation_evidence_collection_only",
        "paper_route_runtime_ledger_import_pending",
        "paper_stage_evidence_collection_only",
        "runtime_ledger_stage_not_live",
    }
)
RUNTIME_IMPORT_MATERIALIZATION_STRUCTURAL_BLOCKERS = frozenset(
    {
        "execution_tca_missing",
        "runtime_ledger_authority_class_missing",
        "runtime_ledger_bucket_missing",
        "runtime_ledger_evidence_grade_bucket_missing",
        "runtime_ledger_execution_order_event_refs_missing",
        "runtime_ledger_execution_refs_missing",
        "runtime_ledger_execution_tca_refs_missing",
        "runtime_ledger_explicit_costs_missing",
        "runtime_ledger_source_materialization_missing",
        "runtime_ledger_source_offsets_missing",
        "runtime_ledger_source_refs_missing",
        "runtime_ledger_source_window_ids_missing",
        "runtime_ledger_source_window_missing",
        "runtime_ledger_trade_decision_refs_missing",
        "source_decisions_missing",
        "source_executions_missing",
        "source_runtime_ledger_missing",
        "source_tca_missing",
    }
)
DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS = 30.0


class _ObjectStoreClient(Protocol):
    def put_object(
        self,
        *,
        bucket: str,
        key: str,
        body: bytes,
        content_type: str,
    ) -> Mapping[str, Any]: ...


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    normalized = str(value).strip()
    return normalized or default


def _bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, Decimal)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {
            "1",
            "true",
            "yes",
            "y",
            "ok",
            "pass",
            "passed",
            "allowed",
            "satisfied",
        }
    return False


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(Decimal(value.strip()))
        except (InvalidOperation, ValueError):
            return default
    return default


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    text = format(value, "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def _first_decimal(
    payload: Mapping[str, Any],
    keys: Sequence[str],
) -> tuple[Decimal | None, str]:
    for key in keys:
        if key in payload:
            value = _decimal(payload.get(key))
            if value is not None:
                return value, key
    return None, ""


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _contains_tigerbeetle_claim(value: object) -> bool:
    if isinstance(value, Mapping):
        for raw_key, raw_value in cast(Mapping[object, object], value).items():
            key = str(raw_key).lower()
            if key == "tigerbeetle" and _mapping(raw_value):
                return True
            if key.startswith("tigerbeetle_") and bool(raw_value):
                return True
            if _contains_tigerbeetle_claim(raw_value):
                return True
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_tigerbeetle_claim(item) for item in value)
    return False


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return []


def _text_list(value: object) -> list[str]:
    items: list[str] = []
    if isinstance(value, Mapping):
        return items
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for item in cast(Sequence[object], value):
            if isinstance(item, Mapping):
                continue
            if isinstance(item, Sequence) and not isinstance(
                item,
                (str, bytes, bytearray),
            ):
                for text in _text_list(item):
                    if text not in items:
                        items.append(text)
                continue
            text = _text(item)
            if text and text not in items:
                items.append(text)
        return items
    text = _text(value)
    if text:
        items.append(text)
    return items


__all__ = (
    "SCHEMA_VERSION",
    "DOC29_LIVE_SCALE_GATE",
    "DEFAULT_RUNTIME_LEDGER_PROOF_POLICY",
    "RUNTIME_LEDGER_PROOF_MODE_NOT_AUTHORITY_BLOCKER",
    "STATUS_ENDPOINT",
    "PAPER_ROUTE_EVIDENCE_ENDPOINT",
    "COMPLETION_DOC29_ENDPOINT",
    "ARTIFACT_SCHEMA_VERSION",
    "HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION",
    "CAPITAL_PROMOTION_STATUS_BLOCKERS",
    "CAPITAL_PROMOTION_STATUS_BLOCKER_PREFIXES",
    "RUNTIME_IMPORT_MATERIALIZATION_PROMOTION_ONLY_BLOCKERS",
    "RUNTIME_IMPORT_MATERIALIZATION_STRUCTURAL_BLOCKERS",
    "DEFAULT_SERVICE_FETCH_TIMEOUT_SECONDS",
    "DEFAULT_RUNTIME_LEDGER_PROOF_MODE",
    "RUNTIME_LEDGER_PROOF_MODES",
    "normalize_runtime_ledger_proof_mode",
    "runtime_ledger_proof_policy_from_env",
    "_ObjectStoreClient",
    "_utc_now",
    "_text",
    "_bool",
    "_int",
    "_decimal",
    "_decimal_text",
    "_first_decimal",
    "_mapping",
    "_contains_tigerbeetle_claim",
    "_sequence",
    "_text_list",
)
