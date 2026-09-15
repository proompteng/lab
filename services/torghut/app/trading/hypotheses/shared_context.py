"""Hypothesis registry loading and runtime alpha-readiness compilation."""

from __future__ import annotations

import json
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from threading import Lock
from typing import Any, Literal, cast
from urllib.request import Request, urlopen

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ...config import settings
from ..runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS


HypothesisState = Literal["blocked", "shadow", "canary_live", "scaled_live"]

CapitalStage = Literal[
    "shadow",
    "0.10x canary",
    "0.25x canary",
    "0.50x live",
    "1.00x live",
]

DependencyQuorumDecision = Literal["allow", "delay", "block", "unknown"]

_KNOWN_DEPENDENCY_CAPABILITIES = {
    "jangar_dependency_quorum",
    "signal_continuity",
    "drift_governance",
    "feature_coverage",
    "market_context_freshness",
    "evidence_continuity",
}

_JANGAR_QUORUM_CACHE_LOCK = Lock()

_JANGAR_QUORUM_CACHE: dict[str, object] = {}


def _stable_string_list(values: Sequence[str]) -> list[str]:
    normalized = [value.strip() for value in values if value.strip()]
    return sorted(set(normalized))


def _coerce_decimal(value: object, default: Decimal = Decimal("0")) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str) and value.strip():
        return Decimal(value.strip())
    return default


def _optional_decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, (int, float)):
        return Decimal(str(value))
    if isinstance(value, str) and value.strip():
        try:
            return Decimal(value.strip())
        except Exception:
            return None
    return None


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _optional_bool(value: object) -> bool | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "pass", "passed", "ok", "ready"}:
            return True
        if normalized in {"0", "false", "no", "off", "fail", "failed", "blocked"}:
            return False
    return None


def _first_matching_reason(reasons: set[str], ordered: Sequence[str]) -> str | None:
    for reason in ordered:
        if reason in reasons:
            return reason
    return None


def _bounded_route_evidence_collection_readiness(
    *,
    route_repair_symbols: Sequence[str],
    requirements: HypothesisEntryRequirements,
    signal_lag_seconds: int | None,
    drift_detection_checks_total: int,
    market_session_open: bool | None,
) -> dict[str, object]:
    """Return fail-closed H-PAIRS bounded-route liveness gates.

    Route-repair eligibility only means there is a non-authority target worth
    collecting. This readback keeps the live/SIM collector honest by separately
    requiring a fresh signal window, materialized drift checks, and an open
    market session before any bounded collection can be considered ready.
    """

    has_route_repair_symbols = bool(route_repair_symbols)
    blockers: list[str] = []
    if not has_route_repair_symbols:
        blockers.append("bounded_route_repair_symbols_missing")

    drift_checks_required = requirements.require_drift_checks
    drift_checks_present = (
        True if not drift_checks_required else drift_detection_checks_total > 0
    )
    if not drift_checks_present:
        blockers.append("drift_checks_missing")

    max_signal_lag_seconds = requirements.max_signal_lag_seconds
    fresh_signal_window: bool | None = None
    if max_signal_lag_seconds is not None:
        if signal_lag_seconds is None:
            blockers.append("signal_lag_unmeasured")
        else:
            fresh_signal_window = signal_lag_seconds <= max_signal_lag_seconds
            if not fresh_signal_window:
                blockers.append("signal_lag_exceeded")

    if market_session_open is False:
        blockers.append("market_session_closed")

    blocker_set = set(blockers)
    next_blocker = _first_matching_reason(
        blocker_set,
        (
            "bounded_route_repair_symbols_missing",
            "drift_checks_missing",
            "signal_lag_unmeasured",
            "signal_lag_exceeded",
            "market_session_closed",
        ),
    )
    next_action = {
        "bounded_route_repair_symbols_missing": "wait_for_bounded_route_repair_target",
        "drift_checks_missing": "materialize_drift_checks",
        "signal_lag_unmeasured": "measure_signal_lag",
        "signal_lag_exceeded": "wait_for_fresh_signal_window",
        "market_session_closed": "wait_for_market_session_open",
        None: "collect_bounded_paper_route_source_rows",
    }[next_blocker]
    ready = has_route_repair_symbols and not blockers

    return {
        "ready": ready,
        "blockers": sorted(set(blockers)),
        "next_action": next_action,
        "fresh_signal_window": fresh_signal_window,
        "signal_lag_seconds": signal_lag_seconds,
        "max_signal_lag_seconds": max_signal_lag_seconds,
        "drift_checks_present": drift_checks_present,
        "drift_detection_checks_total": drift_detection_checks_total,
        "market_session_open": market_session_open,
    }


def _parse_iso8601(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _decimal_to_string(value: Decimal) -> str:
    normalized = value.normalize()
    rendered = format(normalized, "f")
    return rendered.rstrip("0").rstrip(".") if "." in rendered else rendered


_CAPITAL_STAGE_RANK = {
    "shadow": 0,
    "0.10x canary": 1,
    "0.25x canary": 2,
    "0.50x live": 3,
    "1.00x live": 4,
}

_KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS = frozenset(
    {
        EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "torghut.runtime-ledger-bucket.v1",
    }
)

_RUNTIME_LEDGER_PROVENANCE_REASONS = {
    "runtime_ledger_candidate_id_mismatch",
    "runtime_ledger_candidate_id_missing",
    "runtime_ledger_cost_model_hash_missing",
    "runtime_ledger_execution_policy_hash_missing",
    "runtime_ledger_lineage_hash_missing",
    "runtime_ledger_pnl_basis_invalid",
    "runtime_ledger_pnl_basis_missing",
    "runtime_ledger_schema_version_invalid",
    "runtime_ledger_schema_version_missing",
    "runtime_ledger_strategy_family_mismatch",
}

_EVIDENCE_REFRESH_REASONS = {
    "delay_adjusted_depth_stress_failed",
    "delay_adjusted_depth_stress_missing",
    "delay_adjusted_depth_stress_stale",
    "drift_checks_missing",
    "evidence_continuity_failed",
    "evidence_continuity_missing",
    "evidence_continuity_stale",
    "feature_rows_missing",
    "hypothesis_window_evidence_missing",
    "hypothesis_window_evidence_stale",
    "paper_probation_evidence_collection_only",
    "required_feature_set_unavailable",
    "runtime_ledger_proof_missing",
    "tca_evidence_stale",
    *_RUNTIME_LEDGER_PROVENANCE_REASONS,
}

_SAMPLE_REASONS = {"sample_count_below_canary_minimum", "route_universe_empty"}

_EDGE_OR_COST_REASONS = {
    "post_cost_expectancy_below_manifest_threshold",
    "post_cost_expectancy_non_positive",
    "runtime_ledger_expectancy_missing",
    "runtime_ledger_stage_not_live",
    "slippage_budget_exceeded",
}

_DEPENDENCY_REASONS = {
    "dependency_quorum_block",
    "dependency_quorum_delay",
    "jangar_dependency_block",
    "jangar_dependency_delay",
    "signal_continuity_alert_active",
}


def _normalize_dependency_capability(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower().replace("-", "_")
    return normalized if normalized else None


def _resolve_required_dependency_capabilities(
    manifest: HypothesisManifest,
) -> tuple[set[str], set[str]]:
    explicit = {
        item
        for item in (
            _normalize_dependency_capability(item)
            for item in manifest.required_dependency_capabilities
        )
        if item is not None
    }
    if explicit:
        unknown = explicit - _KNOWN_DEPENDENCY_CAPABILITIES
        return explicit, unknown

    return {
        "jangar_dependency_quorum",
        "signal_continuity",
        "drift_governance",
        "feature_coverage",
        "evidence_continuity",
        "market_context_freshness",
    }, set()


def _is_dependency_required(required: set[str], capability: str) -> bool:
    return capability in required


def _candidate_blocker_class(reason_codes: Sequence[str]) -> str:
    reasons = {reason for reason in reason_codes if reason}
    if not reasons:
        return "promotion_ready"
    if reasons.intersection(_EVIDENCE_REFRESH_REASONS):
        return "evidence_refresh"
    if reasons.intersection(_SAMPLE_REASONS):
        return "sample_count"
    if reasons.intersection(_EDGE_OR_COST_REASONS):
        return "edge_or_cost"
    if reasons.intersection(_DEPENDENCY_REASONS):
        return "dependency"
    return "other"


def _candidate_blocker_rank(blocker_class: str) -> int:
    return {
        "promotion_ready": 0,
        "evidence_refresh": 1,
        "sample_count": 2,
        "edge_or_cost": 3,
        "dependency": 4,
        "other": 5,
    }.get(blocker_class, 5)


def _ranked_candidate_dossiers(
    statuses: Sequence[Mapping[str, Any]],
) -> list[dict[str, object]]:
    dossiers: list[dict[str, object]] = []
    for item in statuses:
        observed_payload = item.get("observed")
        observed: Mapping[str, Any] = (
            cast(Mapping[str, Any], observed_payload)
            if isinstance(observed_payload, Mapping)
            else {}
        )
        reason_codes = sorted(
            {
                str(reason)
                for reason in cast(Sequence[object], item.get("reasons") or [])
                if str(reason).strip()
            }
        )
        blocker_class = _candidate_blocker_class(reason_codes)
        dossiers.append(
            {
                "hypothesis_id": str(item.get("hypothesis_id") or ""),
                "candidate_id": item.get("candidate_id"),
                "strategy_id": item.get("strategy_id"),
                "lane_id": item.get("lane_id"),
                "strategy_family": item.get("strategy_family"),
                "state": item.get("state"),
                "capital_stage": item.get("capital_stage"),
                "capital_multiplier": item.get("capital_multiplier"),
                "promotion_eligible": bool(item.get("promotion_eligible")),
                "paper_probation_eligible": bool(item.get("paper_probation_eligible")),
                "paper_probation_target_capital_stage": item.get(
                    "paper_probation_target_capital_stage"
                ),
                "blocker_class": blocker_class,
                "next_blocker": reason_codes[0] if reason_codes else None,
                "reason_codes": reason_codes,
                "observed": {
                    "tca_order_count": observed.get("tca_order_count"),
                    "avg_abs_slippage_bps": observed.get("avg_abs_slippage_bps"),
                    "runtime_ledger_candidate_id": observed.get(
                        "runtime_ledger_candidate_id"
                    ),
                    "runtime_ledger_observed_stage": observed.get(
                        "runtime_ledger_observed_stage"
                    ),
                    "runtime_ledger_submitted_order_count": observed.get(
                        "runtime_ledger_submitted_order_count"
                    ),
                    "runtime_ledger_post_cost_expectancy_bps": observed.get(
                        "runtime_ledger_post_cost_expectancy_bps"
                    ),
                    "runtime_ledger_filled_notional": observed.get(
                        "runtime_ledger_filled_notional"
                    ),
                    "runtime_ledger_net_strategy_pnl_after_costs": observed.get(
                        "runtime_ledger_net_strategy_pnl_after_costs"
                    ),
                    "runtime_ledger_schema_version": observed.get(
                        "runtime_ledger_schema_version"
                    ),
                    "runtime_ledger_pnl_basis": observed.get(
                        "runtime_ledger_pnl_basis"
                    ),
                    "feature_batch_rows_total": observed.get(
                        "feature_batch_rows_total"
                    ),
                    "drift_detection_checks_total": observed.get(
                        "drift_detection_checks_total"
                    ),
                    "delay_adjusted_depth_stress_checks_total": observed.get(
                        "delay_adjusted_depth_stress_checks_total"
                    ),
                    "delay_adjusted_depth_stress_passed": observed.get(
                        "delay_adjusted_depth_stress_passed"
                    ),
                },
                "promotion_contract": item.get("promotion_contract"),
            }
        )

    def sort_key(dossier: Mapping[str, object]) -> tuple[int, int, int, int, int, str]:
        observed = cast(Mapping[str, object], dossier.get("observed") or {})
        return (
            _candidate_blocker_rank(str(dossier.get("blocker_class") or "other")),
            -_CAPITAL_STAGE_RANK.get(str(dossier.get("capital_stage") or "shadow"), 0),
            -(_optional_int(observed.get("runtime_ledger_submitted_order_count")) or 0),
            -(_optional_int(observed.get("tca_order_count")) or 0),
            -int(
                bool(dossier.get("candidate_id")) and bool(dossier.get("strategy_id"))
            ),
            str(dossier.get("hypothesis_id") or ""),
        )

    ranked = sorted(dossiers, key=sort_key)
    for index, dossier in enumerate(ranked, start=1):
        dossier["rank"] = index
    return ranked


def hypothesis_registry_requires_dependency_capability(
    registry: HypothesisRegistryLoadResult,
    capability: str,
) -> bool:
    """Return whether any loaded hypothesis requires an external dependency capability."""

    normalized = _normalize_dependency_capability(capability)
    if normalized is None or not registry.loaded:
        return False
    for manifest in registry.items:
        required, _unknown = _resolve_required_dependency_capabilities(manifest)
        if normalized in required:
            return True
    return False


def resolve_hypothesis_dependency_quorum(
    registry: HypothesisRegistryLoadResult,
) -> JangarDependencyQuorumStatus:
    """Fetch Jangar quorum only when the active hypothesis registry requires it."""

    if hypothesis_registry_requires_dependency_capability(
        registry,
        "jangar_dependency_quorum",
    ):
        from .runtime_ledger_row_rank import load_jangar_dependency_quorum

        return load_jangar_dependency_quorum()
    return JangarDependencyQuorumStatus(
        decision="allow",
        reasons=["torghut_dependency_quorum_not_required"],
        message="Torghut hypothesis registry is self-governed for dependency quorum.",
    )


class HypothesisEntryRequirements(BaseModel):
    """Entry requirements that determine whether a lane can leave shadow or blocked."""

    model_config = ConfigDict(extra="forbid")

    max_signal_lag_seconds: int | None = None
    max_no_signal_streak: int | None = None
    max_market_context_freshness_seconds: int | None = None
    max_evidence_age_minutes: int | None = None
    min_feature_batch_rows: int = 1
    require_feature_rows: bool = True
    require_drift_checks: bool = True
    require_evidence_continuity: bool = True
    require_delay_adjusted_depth_stress: bool = False
    min_delay_adjusted_depth_stress_checks: int = 1
    max_delay_adjusted_depth_stress_age_minutes: int | None = None
    required_dependency_quorum: Literal["allow", "allow_or_delay"] = "allow"


class HypothesisManifest(BaseModel):
    """Source-controlled runtime contract for one alpha hypothesis."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["torghut.hypothesis-manifest.v1"]
    hypothesis_id: str
    lane_id: str
    strategy_family: str
    candidate_id: str | None = None
    paper_probation_candidate_ids: list[str] = Field(default_factory=list)
    strategy_id: str | None = None
    dataset_snapshot_ref: str | None = None
    initial_state: Literal["shadow", "blocked"] = "shadow"
    market_regimes: list[str] = Field(default_factory=list)
    required_feature_sets: list[str] = Field(default_factory=list)
    required_dependency_capabilities: list[str] = Field(default_factory=list)
    segment_dependencies: list[str] = Field(default_factory=list)
    evidence_universe_symbols: list[str] = Field(default_factory=list)
    require_pair_balance: bool = False
    expected_gross_edge_bps: Decimal
    max_allowed_slippage_bps: Decimal
    min_sample_count_for_live_canary: int
    min_sample_count_for_scale_up: int
    max_rolling_drawdown_bps: Decimal
    rollback_triggers: list[str] = Field(default_factory=list)
    promotion_gates: list[str] = Field(default_factory=list)
    entry_requirements: HypothesisEntryRequirements = Field(
        default_factory=HypothesisEntryRequirements
    )

    @field_validator(
        "market_regimes",
        "required_feature_sets",
        "required_dependency_capabilities",
        "segment_dependencies",
        "evidence_universe_symbols",
        "paper_probation_candidate_ids",
        "rollback_triggers",
        "promotion_gates",
        mode="before",
    )
    @classmethod
    def _normalize_list(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return _stable_string_list([item for item in value.split(",")])
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            return _stable_string_list(
                [str(item) for item in cast(Sequence[object], value)]
            )
        raise ValueError(
            "manifest list fields must be a list or comma-delimited string"
        )

    @field_validator("hypothesis_id", "lane_id", "strategy_family")
    @classmethod
    def _require_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("manifest text fields cannot be empty")
        return normalized

    @field_validator("candidate_id", "strategy_id", "dataset_snapshot_ref")
    @classmethod
    def _normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        return normalized or None

    @field_validator("evidence_universe_symbols")
    @classmethod
    def _normalize_symbol_universe(cls, value: list[str]) -> list[str]:
        symbols: list[str] = []
        seen: set[str] = set()
        for item in value:
            symbol = item.strip().upper()
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            symbols.append(symbol)
        return symbols


@dataclass(frozen=True)
class HypothesisRegistryLoadResult:
    path: str | None
    loaded: bool
    items: list[HypothesisManifest]
    errors: list[str]


def _empty_payload_dict() -> dict[str, object]:
    return {}


def _empty_payload_dict_list() -> list[dict[str, object]]:
    return []


@dataclass(frozen=True)
class JangarDependencyQuorumStatus:
    decision: DependencyQuorumDecision
    reasons: list[str]
    message: str
    stage_trust: dict[str, object] = field(default_factory=_empty_payload_dict)
    stage_renewal_bonds: list[dict[str, object]] = field(
        default_factory=_empty_payload_dict_list
    )
    controller_ingestion_settlement: dict[str, object] = field(
        default_factory=_empty_payload_dict
    )
    verify_trust_foreclosure_board: dict[str, object] = field(
        default_factory=_empty_payload_dict
    )
    repair_slot_escrow: dict[str, object] = field(default_factory=_empty_payload_dict)
    stage_debt_repair_admission: dict[str, object] = field(
        default_factory=_empty_payload_dict
    )
    foreclosure_carry_rollout_witness: dict[str, object] = field(
        default_factory=_empty_payload_dict
    )
    generated_at: str | None = None

    def as_payload(self) -> dict[str, object]:
        payload: dict[str, object] = {
            "decision": self.decision,
            "reasons": list(self.reasons),
            "message": self.message,
        }
        if self.stage_trust:
            payload["stage_trust"] = dict(self.stage_trust)
        if self.stage_renewal_bonds:
            payload["stage_renewal_bonds"] = [
                dict(item) for item in self.stage_renewal_bonds
            ]
        if self.controller_ingestion_settlement:
            payload["controller_ingestion_settlement"] = dict(
                self.controller_ingestion_settlement
            )
        if self.verify_trust_foreclosure_board:
            payload["verify_trust_foreclosure_board"] = dict(
                self.verify_trust_foreclosure_board
            )
        if self.repair_slot_escrow:
            payload["repair_slot_escrow"] = dict(self.repair_slot_escrow)
        if self.stage_debt_repair_admission:
            payload["stage_debt_repair_admission"] = dict(
                self.stage_debt_repair_admission
            )
        if self.foreclosure_carry_rollout_witness:
            payload["foreclosure_carry_rollout_witness"] = dict(
                self.foreclosure_carry_rollout_witness
            )
        if self.generated_at:
            payload["generated_at"] = self.generated_at
        return payload


def _as_payload_dict(value: object) -> dict[str, object]:
    return dict(cast(Mapping[str, object], value)) if isinstance(value, Mapping) else {}


def _as_payload_dict_list(value: object) -> list[dict[str, object]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        dict(cast(Mapping[str, object], item))
        for item in cast(Sequence[object], value)
        if isinstance(item, Mapping)
    ]


def _extract_stage_trust(
    payload: Mapping[str, Any],
    quorum: Mapping[str, Any],
) -> dict[str, object]:
    return _as_payload_dict(
        payload.get("stage_trust")
        or payload.get("stageTrust")
        or quorum.get("stage_trust")
        or quorum.get("stageTrust")
    )


JANGAR_QUORUM_CACHE = _JANGAR_QUORUM_CACHE
JANGAR_QUORUM_CACHE_LOCK = _JANGAR_QUORUM_CACHE_LOCK
CAPITAL_STAGE_RANK = _CAPITAL_STAGE_RANK
DEPENDENCY_REASONS = _DEPENDENCY_REASONS
EDGE_OR_COST_REASONS = _EDGE_OR_COST_REASONS
EVIDENCE_REFRESH_REASONS = _EVIDENCE_REFRESH_REASONS
KNOWN_DEPENDENCY_CAPABILITIES = _KNOWN_DEPENDENCY_CAPABILITIES
KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS = _KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS
RUNTIME_LEDGER_PROVENANCE_REASONS = _RUNTIME_LEDGER_PROVENANCE_REASONS
SAMPLE_REASONS = _SAMPLE_REASONS
as_payload_dict = _as_payload_dict
as_payload_dict_list = _as_payload_dict_list
bounded_route_evidence_collection_readiness = (
    _bounded_route_evidence_collection_readiness
)
candidate_blocker_class = _candidate_blocker_class
candidate_blocker_rank = _candidate_blocker_rank
coerce_decimal = _coerce_decimal
decimal_to_string = _decimal_to_string
empty_payload_dict = _empty_payload_dict
empty_payload_dict_list = _empty_payload_dict_list
extract_stage_trust = _extract_stage_trust
first_matching_reason = _first_matching_reason
is_dependency_required = _is_dependency_required
normalize_dependency_capability = _normalize_dependency_capability
optional_bool = _optional_bool
optional_decimal = _optional_decimal
optional_int = _optional_int
parse_iso8601 = _parse_iso8601
ranked_candidate_dossiers = _ranked_candidate_dossiers
resolve_required_dependency_capabilities = _resolve_required_dependency_capabilities
sequence = _sequence
stable_string_list = _stable_string_list

# Explicit barrel exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "BaseModel",
    "CAPITAL_STAGE_RANK",
    "CapitalStage",
    "ConfigDict",
    "Counter",
    "DEPENDENCY_REASONS",
    "Decimal",
    "DependencyQuorumDecision",
    "EDGE_OR_COST_REASONS",
    "EVIDENCE_REFRESH_REASONS",
    "EXACT_REPLAY_LEDGER_SCHEMA_VERSION",
    "Field",
    "HypothesisEntryRequirements",
    "HypothesisManifest",
    "HypothesisRegistryLoadResult",
    "HypothesisState",
    "JANGAR_QUORUM_CACHE",
    "JANGAR_QUORUM_CACHE_LOCK",
    "JangarDependencyQuorumStatus",
    "KNOWN_DEPENDENCY_CAPABILITIES",
    "KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS",
    "Literal",
    "Lock",
    "Mapping",
    "POST_COST_PNL_BASIS",
    "Path",
    "RUNTIME_LEDGER_PROVENANCE_REASONS",
    "Request",
    "SAMPLE_REASONS",
    "Sequence",
    "ValidationError",
    "_CAPITAL_STAGE_RANK",
    "_DEPENDENCY_REASONS",
    "_EDGE_OR_COST_REASONS",
    "_EVIDENCE_REFRESH_REASONS",
    "_JANGAR_QUORUM_CACHE",
    "_JANGAR_QUORUM_CACHE_LOCK",
    "_KNOWN_DEPENDENCY_CAPABILITIES",
    "_KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS",
    "_RUNTIME_LEDGER_PROVENANCE_REASONS",
    "_SAMPLE_REASONS",
    "_as_payload_dict",
    "_as_payload_dict_list",
    "_bounded_route_evidence_collection_readiness",
    "_candidate_blocker_class",
    "_candidate_blocker_rank",
    "_coerce_decimal",
    "_decimal_to_string",
    "_empty_payload_dict",
    "_empty_payload_dict_list",
    "_extract_stage_trust",
    "_first_matching_reason",
    "_is_dependency_required",
    "_normalize_dependency_capability",
    "_optional_bool",
    "_optional_decimal",
    "_optional_int",
    "_parse_iso8601",
    "_ranked_candidate_dossiers",
    "_resolve_required_dependency_capabilities",
    "_sequence",
    "_stable_string_list",
    "annotations",
    "as_payload_dict",
    "as_payload_dict_list",
    "bounded_route_evidence_collection_readiness",
    "candidate_blocker_class",
    "candidate_blocker_rank",
    "cast",
    "coerce_decimal",
    "dataclass",
    "datetime",
    "decimal_to_string",
    "empty_payload_dict",
    "empty_payload_dict_list",
    "extract_stage_trust",
    "field",
    "field_validator",
    "first_matching_reason",
    "hypothesis_registry_requires_dependency_capability",
    "is_dependency_required",
    "json",
    "normalize_dependency_capability",
    "optional_bool",
    "optional_decimal",
    "optional_int",
    "parse_iso8601",
    "ranked_candidate_dossiers",
    "resolve_hypothesis_dependency_quorum",
    "resolve_required_dependency_capabilities",
    "sequence",
    "settings",
    "stable_string_list",
    "timedelta",
    "timezone",
    "urlopen",
    "yaml",
)
