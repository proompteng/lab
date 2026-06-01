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

from ..config import settings
from .runtime_ledger import EXACT_REPLAY_LEDGER_SCHEMA_VERSION, POST_COST_PNL_BASIS

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


def _extract_stage_renewal_bonds(
    payload: Mapping[str, Any],
    quorum: Mapping[str, Any],
) -> list[dict[str, object]]:
    return _as_payload_dict_list(
        payload.get("stage_renewal_bonds")
        or payload.get("stageRenewalBonds")
        or quorum.get("stage_renewal_bonds")
        or quorum.get("stageRenewalBonds")
    )


def _extract_controller_ingestion_settlement(
    payload: Mapping[str, Any],
    quorum: Mapping[str, Any],
) -> dict[str, object]:
    return _as_payload_dict(
        payload.get("controller_ingestion_settlement")
        or payload.get("controllerIngestionSettlement")
        or quorum.get("controller_ingestion_settlement")
        or quorum.get("controllerIngestionSettlement")
    )


def _extract_verify_trust_foreclosure_board(
    payload: Mapping[str, Any],
    quorum: Mapping[str, Any],
) -> dict[str, object]:
    return _as_payload_dict(
        payload.get("verify_trust_foreclosure_board")
        or payload.get("verifyTrustForeclosureBoard")
        or quorum.get("verify_trust_foreclosure_board")
        or quorum.get("verifyTrustForeclosureBoard")
    )


def _extract_repair_slot_escrow(
    payload: Mapping[str, Any],
    quorum: Mapping[str, Any],
) -> dict[str, object]:
    return _as_payload_dict(
        payload.get("repair_slot_escrow")
        or payload.get("repairSlotEscrow")
        or quorum.get("repair_slot_escrow")
        or quorum.get("repairSlotEscrow")
    )


def _extract_stage_debt_repair_admission(
    payload: Mapping[str, Any],
    quorum: Mapping[str, Any],
) -> dict[str, object]:
    return _as_payload_dict(
        payload.get("stage_debt_repair_admission")
        or payload.get("stageDebtRepairAdmission")
        or quorum.get("stage_debt_repair_admission")
        or quorum.get("stageDebtRepairAdmission")
    )


def _extract_foreclosure_carry_rollout_witness(
    payload: Mapping[str, Any],
    quorum: Mapping[str, Any],
) -> dict[str, object]:
    return _as_payload_dict(
        payload.get("foreclosure_carry_rollout_witness")
        or payload.get("foreclosureCarryRolloutWitness")
        or payload.get("controller_ingestion_witness")
        or payload.get("controllerIngestionWitness")
        or quorum.get("foreclosure_carry_rollout_witness")
        or quorum.get("foreclosureCarryRolloutWitness")
        or quorum.get("controller_ingestion_witness")
        or quorum.get("controllerIngestionWitness")
    )


@dataclass(frozen=True)
class _TcaReadinessInputs:
    order_count: int
    avg_abs_slippage_bps: Decimal
    avg_realized_shortfall_bps: Decimal
    last_computed_at: datetime | None
    route_filter_applied: bool
    routeable_symbols: tuple[str, ...]
    route_repair_symbols: tuple[str, ...]
    route_excluded_symbol_count: int
    route_missing_symbol_count: int
    route_blocking_reason_codes: tuple[str, ...]
    route_symbol_diagnostics: tuple[dict[str, object], ...]


_NON_AUTHORITY_TCA_SOURCE_KINDS = {
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    "aggregate",
    "aggregate_only",
    "backtest",
    "backtest_replay",
    "exact_replay",
    "exact_replay_ledger",
    "exact_replay_ledger.v1",
    "replay",
    "replay_only",
    "synthetic",
}
_NON_AUTHORITY_TCA_DECISION_MODES = {
    "bounded_paper_collection",
    "bounded_paper_route_collection",
    "bounded_paper_route_collection_only",
    "exact_replay",
    "paper_route_probe",
    "paper_route_probe_runtime_observed",
    "replay_only",
}


@dataclass(frozen=True)
class _RuntimeLedgerReadinessInputs:
    proof_present: bool
    candidate_id: str | None
    observed_stage: str | None
    runtime_strategy_name: str | None
    strategy_family: str | None
    fill_count: int
    submitted_order_count: int
    closed_trade_count: int
    open_position_count: int
    filled_notional: Decimal
    net_strategy_pnl_after_costs: Decimal
    post_cost_expectancy_bps: Decimal | None
    bucket_started_at: datetime | None
    bucket_ended_at: datetime | None
    blockers: tuple[str, ...]
    execution_policy_hash_count: int
    cost_model_hash_count: int
    lineage_hash_count: int
    ledger_schema_version: str | None
    pnl_basis: str | None


@dataclass(frozen=True)
class _DelayAdjustedDepthStressInputs:
    check_count: int
    passed: bool | None
    checked_at: datetime | None
    report_id: str | None


def _weighted_decimal_average(
    rows: Sequence[Mapping[str, Any]],
    field_name: str,
) -> Decimal | None:
    total_weight = 0
    weighted_sum = Decimal("0")
    for row in rows:
        weight = max(0, _optional_int(row.get("order_count")) or 0)
        if weight <= 0:
            continue
        value = _optional_decimal(row.get(field_name))
        if value is None:
            return None
        total_weight += weight
        weighted_sum += value * Decimal(weight)
    if total_weight <= 0:
        return None
    return weighted_sum / Decimal(total_weight)


def _latest_tca_timestamp(rows: Sequence[Mapping[str, Any]]) -> datetime | None:
    latest: datetime | None = None
    for row in rows:
        parsed = _parse_iso8601(row.get("last_computed_at"))
        if parsed is not None and (latest is None or parsed > latest):
            latest = parsed
    return latest


def _normalized_route_token(value: object) -> str | None:
    text = _route_tca_text(value)
    return text.lower().replace("-", "_") if text is not None else None


def _route_tca_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _route_tca_bool(value: object) -> bool | None:
    return _optional_bool(value)


def _route_tca_target_blockers(
    row: Mapping[str, Any],
    *,
    hypothesis_id: str | None,
    candidate_id: str | None,
    strategy_family: str | None,
    account_label: str | None,
) -> tuple[str, ...]:
    blockers: list[str] = []
    expected_hypothesis_id = _route_tca_text(hypothesis_id)
    actual_hypothesis_id = _route_tca_text(row.get("hypothesis_id"))
    if (
        expected_hypothesis_id is not None
        and actual_hypothesis_id is not None
        and actual_hypothesis_id != expected_hypothesis_id
    ):
        blockers.append("route_tca_hypothesis_id_mismatch")

    expected_candidate_id = _route_tca_text(candidate_id)
    actual_candidate_id = _route_tca_text(row.get("candidate_id"))
    if (
        expected_candidate_id is not None
        and actual_candidate_id is not None
        and actual_candidate_id != expected_candidate_id
    ):
        blockers.append("route_tca_candidate_id_mismatch")

    expected_strategy_family = _normalized_route_token(strategy_family)
    actual_strategy_family = _normalized_route_token(row.get("strategy_family"))
    if (
        expected_strategy_family is not None
        and actual_strategy_family is not None
        and actual_strategy_family != expected_strategy_family
    ):
        blockers.append("route_tca_strategy_family_mismatch")

    expected_account_label = _route_tca_text(account_label)
    actual_account_label = _route_tca_text(row.get("account_label"))
    if (
        expected_account_label is not None
        and actual_account_label is not None
        and actual_account_label != expected_account_label
    ):
        blockers.append("route_tca_account_label_mismatch")

    return tuple(blockers)


def _route_tca_authority_blockers(row: Mapping[str, Any]) -> tuple[str, ...]:
    blockers: list[str] = []
    source_kind = _normalized_route_token(
        row.get("source_kind")
        or row.get("source")
        or row.get("ledger_schema_version")
        or row.get("schema_version")
    )
    if source_kind in _NON_AUTHORITY_TCA_SOURCE_KINDS:
        blockers.append("route_tca_non_authority_source")
    source_decision_mode = _normalized_route_token(row.get("source_decision_mode"))
    if source_decision_mode in _NON_AUTHORITY_TCA_DECISION_MODES:
        blockers.append("route_tca_non_authority_source_decision_mode")
    profit_proof_eligible = _route_tca_bool(
        row.get("source_decision_mode_profit_proof_eligible")
    )
    if source_decision_mode is not None and profit_proof_eligible is False:
        blockers.append("route_tca_non_authority_source_decision_mode")
    for key in ("aggregate_only", "replay_only", "synthetic", "non_authority"):
        if _route_tca_bool(row.get(key)) is True:
            blockers.append(f"route_tca_{key}")
    state = _normalized_route_token(row.get("state") or row.get("source_state"))
    if state in {"stale", "expired"}:
        blockers.append("route_tca_stale")
    return tuple(dict.fromkeys(blockers))


def _route_tca_adverse_slippage(row: Mapping[str, Any]) -> Decimal | None:
    realized_shortfall = _optional_decimal(row.get("avg_realized_shortfall_bps"))
    if realized_shortfall is not None:
        return max(realized_shortfall, Decimal("0"))
    return _optional_decimal(row.get("avg_abs_slippage_bps"))


def _route_tca_diagnostic(
    *,
    row: Mapping[str, Any],
    symbol: str,
    state: str,
    blockers: Sequence[str],
    route_adverse_slippage: Decimal | None,
    max_allowed_slippage_bps: Decimal,
) -> dict[str, object]:
    diagnostic: dict[str, object] = {
        "symbol": symbol,
        "state": state,
        "order_count": max(0, _optional_int(row.get("order_count")) or 0),
        "blocking_reason_codes": list(dict.fromkeys(blockers)),
        "max_avg_abs_slippage_bps": _decimal_to_string(max_allowed_slippage_bps),
    }
    for key in (
        "avg_abs_slippage_bps",
        "avg_realized_shortfall_bps",
        "last_computed_at",
        "candidate_id",
        "hypothesis_id",
        "strategy_family",
        "account_label",
        "source_kind",
        "source_decision_mode",
    ):
        value = row.get(key)
        if value is not None:
            diagnostic[key] = value
    if route_adverse_slippage is not None:
        diagnostic["route_adverse_slippage_bps"] = _decimal_to_string(
            route_adverse_slippage
        )
    return diagnostic


def _resolve_delay_adjusted_depth_stress_inputs(
    *,
    state: object,
    readiness: Mapping[str, Any],
) -> _DelayAdjustedDepthStressInputs:
    metrics = getattr(state, "metrics", None)
    report = _as_payload_dict(
        readiness.get("delay_adjusted_depth_stress_report")
        or readiness.get("delay_depth_stress_report")
        or getattr(state, "last_delay_adjusted_depth_stress_report", None)
        or getattr(state, "last_delay_depth_stress_report", None)
    )
    check_count = max(
        0,
        _optional_int(readiness.get("delay_adjusted_depth_stress_checks_total")) or 0,
        _optional_int(readiness.get("delay_depth_stress_checks_total")) or 0,
        _optional_int(getattr(metrics, "delay_adjusted_depth_stress_checks_total", 0))
        or 0,
        _optional_int(report.get("stress_case_count")) or 0,
        _optional_int(report.get("case_count")) or 0,
        _optional_int(report.get("trading_day_count")) or 0,
    )
    passed = _optional_bool(
        readiness.get("delay_adjusted_depth_stress_passed")
        or readiness.get("delay_depth_stress_passed")
        or report.get("passed")
        or report.get("ok")
    )
    checked_at = (
        _parse_iso8601(readiness.get("delay_adjusted_depth_stress_checked_at"))
        or _parse_iso8601(readiness.get("delay_depth_stress_checked_at"))
        or _parse_iso8601(report.get("generated_at"))
        or _parse_iso8601(report.get("checked_at"))
    )
    report_id = (
        str(
            report.get("report_id")
            or report.get("artifact_ref")
            or readiness.get("delay_adjusted_depth_stress_artifact_ref")
            or ""
        ).strip()
        or None
    )
    return _DelayAdjustedDepthStressInputs(
        check_count=check_count,
        passed=passed,
        checked_at=checked_at,
        report_id=report_id,
    )


def _resolve_tca_readiness_inputs(
    tca_summary: Mapping[str, Any],
    *,
    max_allowed_slippage_bps: Decimal,
    route_symbol_filter_enabled: bool,
    hypothesis_id: str | None = None,
    candidate_id: str | None = None,
    strategy_family: str | None = None,
    account_label: str | None = None,
) -> _TcaReadinessInputs:
    aggregate_order_count = max(0, _optional_int(tca_summary.get("order_count")) or 0)
    aggregate_avg_abs_slippage = _coerce_decimal(
        tca_summary.get("avg_abs_slippage_bps")
    )
    aggregate_avg_realized_shortfall = _coerce_decimal(
        tca_summary.get("avg_realized_shortfall_bps")
    )
    aggregate_last_computed_at = _parse_iso8601(tca_summary.get("last_computed_at"))
    aggregate = _TcaReadinessInputs(
        order_count=aggregate_order_count,
        avg_abs_slippage_bps=aggregate_avg_abs_slippage,
        avg_realized_shortfall_bps=aggregate_avg_realized_shortfall,
        last_computed_at=aggregate_last_computed_at,
        route_filter_applied=False,
        routeable_symbols=(),
        route_repair_symbols=(),
        route_excluded_symbol_count=0,
        route_missing_symbol_count=0,
        route_blocking_reason_codes=(),
        route_symbol_diagnostics=(),
    )
    if not route_symbol_filter_enabled:
        return aggregate

    rows = [
        cast(Mapping[str, Any], item)
        for item in _sequence(tca_summary.get("symbol_breakdown"))
        if isinstance(item, Mapping)
    ]
    scope_symbols = tuple(
        str(item).strip().upper()
        for item in _sequence(tca_summary.get("scope_symbols"))
        if str(item).strip()
    )
    scope_symbol_set = set(scope_symbols)
    if not rows and not scope_symbols:
        return aggregate

    routeable_rows: list[Mapping[str, Any]] = []
    route_repair_symbols: list[str] = []
    route_repair_symbol_set: set[str] = set()
    route_blockers: list[str] = []
    diagnostics: list[dict[str, object]] = []
    missing_symbol_count = 0
    excluded_symbol_count = 0
    seen_symbols: set[str] = set()

    def append_repair_symbol(symbol: str) -> None:
        normalized = symbol.strip().upper()
        if not normalized or normalized in route_repair_symbol_set:
            return
        route_repair_symbol_set.add(normalized)
        route_repair_symbols.append(normalized)

    for row in rows:
        symbol = str(row.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        seen_symbols.add(symbol)
        order_count = max(0, _optional_int(row.get("order_count")) or 0)
        scope_blockers: tuple[str, ...] = (
            ("route_tca_out_of_scope_symbol",)
            if scope_symbol_set and symbol not in scope_symbol_set
            else ()
        )
        target_blockers = _route_tca_target_blockers(
            row,
            hypothesis_id=hypothesis_id,
            candidate_id=candidate_id,
            strategy_family=strategy_family,
            account_label=account_label,
        )
        authority_blockers = _route_tca_authority_blockers(row)
        row_blockers: list[str] = [
            *scope_blockers,
            *target_blockers,
            *authority_blockers,
        ]
        avg_abs_slippage = _optional_decimal(row.get("avg_abs_slippage_bps"))
        route_adverse_slippage = _route_tca_adverse_slippage(row)
        if order_count <= 0:
            missing_symbol_count += 1
            row_blockers.append("execution_tca_symbol_missing")
            if not scope_blockers and not target_blockers:
                append_repair_symbol(symbol)
            route_blockers.extend(row_blockers)
            diagnostics.append(
                _route_tca_diagnostic(
                    row=row,
                    symbol=symbol,
                    state="missing",
                    blockers=row_blockers,
                    route_adverse_slippage=route_adverse_slippage,
                    max_allowed_slippage_bps=max_allowed_slippage_bps,
                )
            )
            continue
        if (
            not row_blockers
            and avg_abs_slippage is not None
            and avg_abs_slippage <= max_allowed_slippage_bps
        ):
            routeable_rows.append(row)
            diagnostics.append(
                _route_tca_diagnostic(
                    row=row,
                    symbol=symbol,
                    state="final_authority_routeable",
                    blockers=(),
                    route_adverse_slippage=route_adverse_slippage,
                    max_allowed_slippage_bps=max_allowed_slippage_bps,
                )
            )
        else:
            excluded_symbol_count += 1
            if avg_abs_slippage is None:
                row_blockers.append("route_tca_slippage_missing")
            elif avg_abs_slippage > max_allowed_slippage_bps:
                row_blockers.append("route_tca_avg_abs_slippage_above_guardrail")
            if not scope_blockers and not target_blockers:
                append_repair_symbol(symbol)
            route_blockers.extend(row_blockers)
            diagnostics.append(
                _route_tca_diagnostic(
                    row=row,
                    symbol=symbol,
                    state="bounded_repair_only",
                    blockers=row_blockers,
                    route_adverse_slippage=route_adverse_slippage,
                    max_allowed_slippage_bps=max_allowed_slippage_bps,
                )
            )

    for symbol in scope_symbols:
        if symbol in seen_symbols:
            continue
        missing_symbol_count += 1
        append_repair_symbol(symbol)
        route_blockers.append("execution_tca_symbol_missing")
        diagnostics.append(
            _route_tca_diagnostic(
                row={},
                symbol=symbol,
                state="missing",
                blockers=("execution_tca_symbol_missing",),
                route_adverse_slippage=None,
                max_allowed_slippage_bps=max_allowed_slippage_bps,
            )
        )

    routeable_symbols = tuple(
        str(row.get("symbol") or "").strip().upper()
        for row in routeable_rows
        if str(row.get("symbol") or "").strip()
    )
    route_order_count = sum(
        max(0, _optional_int(row.get("order_count")) or 0) for row in routeable_rows
    )
    if route_order_count <= 0:
        return _TcaReadinessInputs(
            order_count=0,
            avg_abs_slippage_bps=aggregate_avg_abs_slippage,
            avg_realized_shortfall_bps=aggregate_avg_realized_shortfall,
            last_computed_at=aggregate_last_computed_at,
            route_filter_applied=True,
            routeable_symbols=(),
            route_repair_symbols=tuple(route_repair_symbols),
            route_excluded_symbol_count=excluded_symbol_count,
            route_missing_symbol_count=missing_symbol_count,
            route_blocking_reason_codes=tuple(dict.fromkeys(route_blockers)),
            route_symbol_diagnostics=tuple(diagnostics),
        )

    route_avg_abs_slippage = _weighted_decimal_average(
        routeable_rows,
        "avg_abs_slippage_bps",
    )
    route_avg_realized_shortfall = _weighted_decimal_average(
        routeable_rows,
        "avg_realized_shortfall_bps",
    )
    avg_abs_slippage = route_avg_abs_slippage or aggregate_avg_abs_slippage
    avg_realized_shortfall = (
        route_avg_realized_shortfall
        if route_avg_realized_shortfall is not None
        else aggregate_avg_realized_shortfall
    )
    return _TcaReadinessInputs(
        order_count=route_order_count,
        avg_abs_slippage_bps=avg_abs_slippage,
        avg_realized_shortfall_bps=avg_realized_shortfall,
        last_computed_at=_latest_tca_timestamp(routeable_rows)
        or aggregate_last_computed_at,
        route_filter_applied=True,
        routeable_symbols=routeable_symbols,
        route_repair_symbols=tuple(route_repair_symbols),
        route_excluded_symbol_count=excluded_symbol_count,
        route_missing_symbol_count=missing_symbol_count,
        route_blocking_reason_codes=tuple(dict.fromkeys(route_blockers)),
        route_symbol_diagnostics=tuple(diagnostics),
    )


def _runtime_ledger_rows_for_hypothesis(
    runtime_ledger_summary: Mapping[str, Any] | None,
    *,
    hypothesis_id: str,
) -> list[Mapping[str, Any]]:
    if not isinstance(runtime_ledger_summary, Mapping):
        return []

    rows: list[Mapping[str, Any]] = []
    for key in ("by_hypothesis", "hypotheses"):
        raw_by_hypothesis = runtime_ledger_summary.get(key)
        if isinstance(raw_by_hypothesis, Mapping):
            by_hypothesis = cast(Mapping[str, object], raw_by_hypothesis)
            item: object = by_hypothesis.get(hypothesis_id)
            if isinstance(item, Mapping):
                rows.append(cast(Mapping[str, Any], item))

    for key in ("items", "runtime_ledger_buckets", "buckets"):
        raw_rows = runtime_ledger_summary.get(key)
        for item in _sequence(raw_rows):
            if not isinstance(item, Mapping):
                continue
            row = cast(Mapping[str, Any], item)
            if str(row.get("hypothesis_id") or "").strip() == hypothesis_id:
                rows.append(row)

    if str(runtime_ledger_summary.get("hypothesis_id") or "").strip() == hypothesis_id:
        rows.append(runtime_ledger_summary)
    return rows


def _runtime_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _runtime_target_token(value: object) -> str | None:
    text = _runtime_text(value)
    return text.lower().replace("-", "_") if text is not None else None


def _runtime_ledger_target_blockers(
    row: Mapping[str, Any],
    *,
    candidate_id: str | None,
    strategy_family: str | None,
) -> tuple[str, ...]:
    blockers: list[str] = []
    expected_candidate_id = _runtime_text(candidate_id)
    actual_candidate_id = _runtime_text(row.get("candidate_id"))
    if expected_candidate_id is not None:
        if actual_candidate_id is None:
            blockers.append("runtime_ledger_candidate_id_missing")
        elif actual_candidate_id != expected_candidate_id:
            blockers.append("runtime_ledger_candidate_id_mismatch")

    expected_strategy_family = _runtime_target_token(strategy_family)
    actual_strategy_family = _runtime_target_token(row.get("strategy_family"))
    if (
        expected_strategy_family is not None
        and actual_strategy_family is not None
        and actual_strategy_family != expected_strategy_family
    ):
        blockers.append("runtime_ledger_strategy_family_mismatch")
    return tuple(blockers)


def _runtime_ledger_row_rank(
    row: Mapping[str, Any],
    *,
    candidate_id: str | None,
    strategy_family: str | None,
) -> tuple[int, int, datetime]:
    target_blockers = _runtime_ledger_target_blockers(
        row,
        candidate_id=candidate_id,
        strategy_family=strategy_family,
    )
    row_at = (
        _parse_iso8601(row.get("bucket_ended_at"))
        or _parse_iso8601(row.get("window_ended_at"))
        or _parse_iso8601(row.get("created_at"))
        or datetime.min.replace(tzinfo=timezone.utc)
    )
    return (
        0 if target_blockers else 1,
        1 if _runtime_text(row.get("observed_stage")) == "live" else 0,
        row_at,
    )


def _runtime_ledger_latest_row(
    rows: Sequence[Mapping[str, Any]],
    *,
    candidate_id: str | None,
    strategy_family: str | None,
) -> Mapping[str, Any] | None:
    if not rows:
        return None
    return max(
        rows,
        key=lambda row: _runtime_ledger_row_rank(
            row,
            candidate_id=candidate_id,
            strategy_family=strategy_family,
        ),
    )


def _hash_count(value: object) -> int:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return sum(1 for key in mapping.keys() if str(key).strip())
    return 0


def _dedupe_runtime_ledger_blockers(blockers: Sequence[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    deduped: list[str] = []
    for blocker in blockers:
        reason = str(blocker).strip()
        if not reason or reason in seen:
            continue
        seen.add(reason)
        deduped.append(reason)
    return tuple(deduped)


def _runtime_ledger_provenance_blockers(
    *,
    ledger_schema_version: str | None,
    pnl_basis: str | None,
    execution_policy_hash_count: int,
    cost_model_hash_count: int,
    lineage_hash_count: int,
) -> tuple[str, ...]:
    blockers: list[str] = []
    if ledger_schema_version is None:
        blockers.append("runtime_ledger_schema_version_missing")
    elif ledger_schema_version not in _KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS:
        blockers.append("runtime_ledger_schema_version_invalid")

    if pnl_basis is None:
        blockers.append("runtime_ledger_pnl_basis_missing")
    elif pnl_basis != POST_COST_PNL_BASIS:
        blockers.append("runtime_ledger_pnl_basis_invalid")

    if execution_policy_hash_count <= 0:
        blockers.append("runtime_ledger_execution_policy_hash_missing")
    if cost_model_hash_count <= 0:
        blockers.append("runtime_ledger_cost_model_hash_missing")
    if lineage_hash_count <= 0:
        blockers.append("runtime_ledger_lineage_hash_missing")
    return tuple(blockers)


def _runtime_ledger_window_bound_blockers(
    *,
    bucket_started_at: datetime | None,
    bucket_ended_at: datetime | None,
) -> tuple[str, ...]:
    if bucket_started_at is None or bucket_ended_at is None:
        return ("runtime_ledger_window_bounds_missing",)
    if bucket_ended_at < bucket_started_at:
        return ("runtime_ledger_window_bounds_mismatch",)
    return ()


def _runtime_ledger_blockers(row: Mapping[str, Any]) -> tuple[str, ...]:
    raw: object = (
        row.get("blockers")
        or row.get("blockers_json")
        or row.get("runtime_ledger_blockers")
        or []
    )
    blockers: list[str] = []
    for item in _sequence(raw):
        reason = str(item).strip()
        if reason:
            blockers.append(reason)
    seen: set[str] = set()
    deduped: list[str] = []
    for blocker in blockers:
        if blocker in seen:
            continue
        seen.add(blocker)
        deduped.append(blocker)
    return tuple(deduped)


def _resolve_runtime_ledger_readiness_inputs(
    runtime_ledger_summary: Mapping[str, Any] | None,
    *,
    manifest: HypothesisManifest,
) -> _RuntimeLedgerReadinessInputs:
    row = _runtime_ledger_latest_row(
        _runtime_ledger_rows_for_hypothesis(
            runtime_ledger_summary,
            hypothesis_id=manifest.hypothesis_id,
        ),
        candidate_id=manifest.candidate_id,
        strategy_family=manifest.strategy_family,
    )
    if row is None:
        return _RuntimeLedgerReadinessInputs(
            proof_present=False,
            candidate_id=None,
            observed_stage=None,
            runtime_strategy_name=None,
            strategy_family=None,
            fill_count=0,
            submitted_order_count=0,
            closed_trade_count=0,
            open_position_count=0,
            filled_notional=Decimal("0"),
            net_strategy_pnl_after_costs=Decimal("0"),
            post_cost_expectancy_bps=None,
            bucket_started_at=None,
            bucket_ended_at=None,
            blockers=("runtime_ledger_proof_missing",),
            execution_policy_hash_count=0,
            cost_model_hash_count=0,
            lineage_hash_count=0,
            ledger_schema_version=None,
            pnl_basis=None,
        )

    execution_policy_hash_count = _hash_count(row.get("execution_policy_hash_counts"))
    cost_model_hash_count = _hash_count(row.get("cost_model_hash_counts"))
    lineage_hash_count = _hash_count(row.get("lineage_hash_counts"))
    ledger_schema_version = _runtime_text(row.get("ledger_schema_version"))
    pnl_basis = _runtime_text(row.get("pnl_basis"))
    bucket_started_at = _parse_iso8601(row.get("bucket_started_at"))
    bucket_ended_at = _parse_iso8601(row.get("bucket_ended_at"))
    blockers = _dedupe_runtime_ledger_blockers(
        (
            *_runtime_ledger_blockers(row),
            *_runtime_ledger_target_blockers(
                row,
                candidate_id=manifest.candidate_id,
                strategy_family=manifest.strategy_family,
            ),
            *_runtime_ledger_provenance_blockers(
                ledger_schema_version=ledger_schema_version,
                pnl_basis=pnl_basis,
                execution_policy_hash_count=execution_policy_hash_count,
                cost_model_hash_count=cost_model_hash_count,
                lineage_hash_count=lineage_hash_count,
            ),
            *_runtime_ledger_window_bound_blockers(
                bucket_started_at=bucket_started_at,
                bucket_ended_at=bucket_ended_at,
            ),
        )
    )
    return _RuntimeLedgerReadinessInputs(
        proof_present=True,
        candidate_id=_runtime_text(row.get("candidate_id")),
        observed_stage=_runtime_text(row.get("observed_stage")),
        runtime_strategy_name=_runtime_text(row.get("runtime_strategy_name"))
        or _runtime_text(row.get("strategy_id")),
        strategy_family=_runtime_text(row.get("strategy_family")),
        fill_count=max(0, _optional_int(row.get("fill_count")) or 0),
        submitted_order_count=max(
            0, _optional_int(row.get("submitted_order_count")) or 0
        ),
        closed_trade_count=max(0, _optional_int(row.get("closed_trade_count")) or 0),
        open_position_count=max(0, _optional_int(row.get("open_position_count")) or 0),
        filled_notional=_coerce_decimal(row.get("filled_notional")),
        net_strategy_pnl_after_costs=_coerce_decimal(
            row.get("net_strategy_pnl_after_costs")
        ),
        post_cost_expectancy_bps=_optional_decimal(row.get("post_cost_expectancy_bps")),
        bucket_started_at=bucket_started_at,
        bucket_ended_at=bucket_ended_at,
        blockers=blockers,
        execution_policy_hash_count=execution_policy_hash_count,
        cost_model_hash_count=cost_model_hash_count,
        lineage_hash_count=lineage_hash_count,
        ledger_schema_version=ledger_schema_version,
        pnl_basis=pnl_basis,
    )


def resolve_hypothesis_registry_path(path_value: str | None = None) -> Path | None:
    raw = (path_value or settings.trading_hypothesis_registry_path or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    if path.is_absolute():
        return path
    service_root = Path(__file__).resolve().parents[2]
    return service_root / path


def _load_manifest_payload(path: Path) -> Any:
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        raise ValueError(f"hypothesis manifest is empty: {path}")
    suffix = path.suffix.lower()
    if suffix == ".json":
        return json.loads(raw)
    if suffix in {".yaml", ".yml"}:
        return yaml.safe_load(raw)
    raise ValueError(f"unsupported hypothesis manifest extension: {path.name}")


def load_hypothesis_registry(
    *,
    path_value: str | None = None,
    raise_on_error: bool = False,
) -> HypothesisRegistryLoadResult:
    resolved = resolve_hypothesis_registry_path(path_value)
    if resolved is None:
        return HypothesisRegistryLoadResult(
            path=None,
            loaded=False,
            items=[],
            errors=["hypothesis_registry_path_not_configured"],
        )
    if not resolved.exists():
        message = f"hypothesis registry path not found: {resolved}"
        if raise_on_error:
            raise RuntimeError(message)
        return HypothesisRegistryLoadResult(
            path=str(resolved),
            loaded=False,
            items=[],
            errors=[message],
        )

    manifest_paths: list[Path]
    if resolved.is_dir():
        manifest_paths = sorted(
            path
            for path in resolved.iterdir()
            if path.is_file() and path.suffix.lower() in {".json", ".yaml", ".yml"}
        )
    else:
        manifest_paths = [resolved]

    items: list[HypothesisManifest] = []
    errors: list[str] = []
    seen_ids: set[str] = set()

    for path in manifest_paths:
        try:
            payload = _load_manifest_payload(path)
            if not isinstance(payload, Mapping):
                raise ValueError("hypothesis manifest payload must be an object")
            manifest = HypothesisManifest.model_validate(payload)
        except (
            OSError,
            json.JSONDecodeError,
            ValidationError,
            ValueError,
            yaml.YAMLError,
        ) as exc:
            errors.append(f"{path}: {exc}")
            continue
        if manifest.hypothesis_id in seen_ids:
            errors.append(f"{path}: duplicate hypothesis_id {manifest.hypothesis_id}")
            continue
        seen_ids.add(manifest.hypothesis_id)
        items.append(manifest)

    if errors and raise_on_error:
        raise RuntimeError("; ".join(errors))
    return HypothesisRegistryLoadResult(
        path=str(resolved),
        loaded=len(errors) == 0,
        items=items if len(errors) == 0 else [],
        errors=errors,
    )


def validate_hypothesis_registry_from_settings() -> None:
    load_hypothesis_registry(raise_on_error=True)


def _fallback_quorum_from_legacy_status(
    payload: Mapping[str, Any],
) -> JangarDependencyQuorumStatus:
    workflows = payload.get("workflows")
    if isinstance(workflows, Mapping):
        workflows_map = cast(Mapping[str, Any], workflows)
        confidence = str(workflows_map.get("data_confidence") or "").strip()
        backoff_jobs = max(
            0, _optional_int(workflows_map.get("backoff_limit_exceeded_jobs")) or 0
        )
        if confidence == "unknown":
            return JangarDependencyQuorumStatus(
                decision="block",
                reasons=["workflows_data_unknown"],
                message="Torghut workflow reliability is unavailable.",
                controller_ingestion_settlement=_extract_controller_ingestion_settlement(
                    payload,
                    {},
                ),
                verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
                    payload,
                    {},
                ),
                repair_slot_escrow=_extract_repair_slot_escrow(payload, {}),
                stage_debt_repair_admission=_extract_stage_debt_repair_admission(
                    payload,
                    {},
                ),
                foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
                    payload,
                    {},
                ),
            )
        if backoff_jobs > 0 or confidence == "degraded":
            return JangarDependencyQuorumStatus(
                decision="delay",
                reasons=["workflows_degraded"],
                message="Torghut workflow reliability is degraded.",
                controller_ingestion_settlement=_extract_controller_ingestion_settlement(
                    payload,
                    {},
                ),
                verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
                    payload,
                    {},
                ),
                repair_slot_escrow=_extract_repair_slot_escrow(payload, {}),
                stage_debt_repair_admission=_extract_stage_debt_repair_admission(
                    payload,
                    {},
                ),
                foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
                    payload,
                    {},
                ),
            )
    namespaces = payload.get("namespaces")
    if isinstance(namespaces, Sequence) and not isinstance(
        namespaces, (str, bytes, bytearray)
    ):
        for raw_item in cast(Sequence[object], namespaces):
            if not isinstance(raw_item, Mapping):
                continue
            item = cast(Mapping[str, Any], raw_item)
            if str(item.get("status") or "").strip() == "degraded":
                return JangarDependencyQuorumStatus(
                    decision="delay",
                    reasons=["jangar_namespace_degraded"],
                    message="Torghut namespace health is degraded.",
                    controller_ingestion_settlement=_extract_controller_ingestion_settlement(
                        payload,
                        {},
                    ),
                    verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
                        payload,
                        {},
                    ),
                    repair_slot_escrow=_extract_repair_slot_escrow(payload, {}),
                    stage_debt_repair_admission=_extract_stage_debt_repair_admission(
                        payload,
                        {},
                    ),
                    foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
                        payload,
                        {},
                    ),
                )
    return JangarDependencyQuorumStatus(
        decision="unknown",
        reasons=["jangar_dependency_quorum_missing"],
        message="Torghut control-plane status did not include dependency_quorum.",
        controller_ingestion_settlement=_extract_controller_ingestion_settlement(
            payload,
            {},
        ),
        verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
            payload,
            {},
        ),
        repair_slot_escrow=_extract_repair_slot_escrow(payload, {}),
        stage_debt_repair_admission=_extract_stage_debt_repair_admission(payload, {}),
        foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
            payload,
            {},
        ),
    )


def load_jangar_dependency_quorum(
    *,
    omit_torghut_consumer_evidence: bool = False,
) -> JangarDependencyQuorumStatus:
    status_url = (settings.trading_jangar_control_plane_status_url or "").strip()
    if not status_url:
        return JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["jangar_control_plane_status_url_missing"],
            message="TRADING_JANGAR_CONTROL_PLANE_STATUS_URL is not configured.",
        )
    cache_key = (
        f"{status_url}#omit_torghut_consumer_evidence="
        f"{str(omit_torghut_consumer_evidence).lower()}"
    )

    ttl_seconds = max(0, int(settings.trading_jangar_control_plane_cache_ttl_seconds))
    if ttl_seconds > 0:
        now = datetime.now(timezone.utc)
        with _JANGAR_QUORUM_CACHE_LOCK:
            cached = cast(dict[str, Any] | None, _JANGAR_QUORUM_CACHE.get(cache_key))
            if cached is not None:
                checked_at = cast(datetime | None, cached.get("checked_at"))
                if checked_at is not None and now - checked_at <= timedelta(
                    seconds=ttl_seconds
                ):
                    return cast(JangarDependencyQuorumStatus, cached["status"])

    decoded: Any = None
    try:
        headers = {"accept": "application/json"}
        if omit_torghut_consumer_evidence:
            headers["x-torghut-consumer-evidence-mode"] = "omit"
        request = Request(status_url, method="GET", headers=headers)
        with urlopen(
            request, timeout=settings.trading_jangar_control_plane_timeout_seconds
        ) as response:
            if response.status < 200 or response.status >= 300:
                return JangarDependencyQuorumStatus(
                    decision="unknown",
                    reasons=[f"jangar_status_http_{response.status}"],
                    message=f"Torghut control-plane status returned HTTP {response.status}.",
                )
            decoded = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        return JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["jangar_status_fetch_failed"],
            message=f"Torghut control-plane status fetch failed: {exc}",
        )

    if not isinstance(decoded, Mapping):
        return JangarDependencyQuorumStatus(
            decision="unknown",
            reasons=["jangar_status_payload_invalid"],
            message="Torghut control-plane status payload was invalid.",
        )
    payload = cast(Mapping[str, Any], decoded)
    raw_quorum = payload.get("dependency_quorum")
    if isinstance(raw_quorum, Mapping):
        quorum = cast(Mapping[str, Any], raw_quorum)
        decision = str(quorum.get("decision") or "").strip()
        if decision in {"allow", "delay", "block", "unknown"}:
            reasons = [
                str(item).strip()
                for item in cast(Sequence[object], quorum.get("reasons") or [])
                if str(item).strip()
            ]
            status = JangarDependencyQuorumStatus(
                decision=cast(DependencyQuorumDecision, decision),
                reasons=reasons,
                message=str(quorum.get("message") or "").strip(),
                stage_trust=_extract_stage_trust(payload, quorum),
                stage_renewal_bonds=_extract_stage_renewal_bonds(payload, quorum),
                controller_ingestion_settlement=_extract_controller_ingestion_settlement(
                    payload,
                    quorum,
                ),
                verify_trust_foreclosure_board=_extract_verify_trust_foreclosure_board(
                    payload,
                    quorum,
                ),
                repair_slot_escrow=_extract_repair_slot_escrow(payload, quorum),
                stage_debt_repair_admission=_extract_stage_debt_repair_admission(
                    payload,
                    quorum,
                ),
                foreclosure_carry_rollout_witness=_extract_foreclosure_carry_rollout_witness(
                    payload,
                    quorum,
                ),
                generated_at=str(
                    payload.get("generated_at")
                    or payload.get("generatedAt")
                    or quorum.get("generated_at")
                    or quorum.get("generatedAt")
                    or ""
                ).strip()
                or None,
            )
        else:
            status = _fallback_quorum_from_legacy_status(payload)
    else:
        status = _fallback_quorum_from_legacy_status(payload)

    if ttl_seconds > 0:
        with _JANGAR_QUORUM_CACHE_LOCK:
            _JANGAR_QUORUM_CACHE[cache_key] = {
                "checked_at": datetime.now(timezone.utc),
                "status": status,
            }
    return status


def compile_hypothesis_runtime_statuses(
    *,
    registry: HypothesisRegistryLoadResult,
    state: object,
    tca_summary: Mapping[str, Any],
    runtime_ledger_summary: Mapping[str, Any] | None = None,
    market_context_status: Mapping[str, Any],
    jangar_dependency_quorum: JangarDependencyQuorumStatus,
    feature_readiness: Mapping[str, Any] | None = None,
    now: datetime | None = None,
    market_session_open: bool | None = None,
    route_symbol_filter_enabled: bool = False,
) -> list[dict[str, object]]:
    if not registry.loaded:
        return []

    now = now or datetime.now(timezone.utc)
    metrics = getattr(state, "metrics", None)
    feature_batch_rows_total = max(
        0,
        _optional_int(getattr(metrics, "feature_batch_rows_total", 0)) or 0,
    )
    readiness = (
        dict(feature_readiness) if isinstance(feature_readiness, Mapping) else {}
    )
    persisted_feature_rows = max(
        0,
        _optional_int(
            readiness.get("equity_ta_rows")
            or readiness.get("signal_rows")
            or readiness.get("row_count")
            or readiness.get("rows")
            or 0
        )
        or 0,
    )
    feature_batch_rows_total = max(feature_batch_rows_total, persisted_feature_rows)
    persisted_drift_checks = max(
        0,
        _optional_int(
            readiness.get("drift_detection_checks_total")
            or readiness.get("drift_detection_checks")
            or readiness.get("drift_checks")
            or 0
        )
        or 0,
    )
    drift_detection_checks_total = max(
        0,
        _optional_int(getattr(metrics, "drift_detection_checks_total", 0)) or 0,
        persisted_drift_checks,
    )
    evidence_continuity_checks_total = max(
        0,
        _optional_int(getattr(metrics, "evidence_continuity_checks_total", 0)) or 0,
    )
    signal_lag_seconds = _optional_int(getattr(metrics, "signal_lag_seconds", None))
    no_signal_streak = max(
        0, _optional_int(getattr(state, "autonomy_no_signal_streak", 0)) or 0
    )
    signal_continuity_alert_active = bool(
        getattr(state, "signal_continuity_alert_active", False)
    )
    evidence_report = getattr(state, "last_evidence_continuity_report", None)
    evidence_ok = True
    evidence_age_minutes: int | None = None
    if isinstance(evidence_report, Mapping):
        report_map = cast(Mapping[str, Any], evidence_report)
        if "ok" in report_map:
            evidence_ok = bool(report_map.get("ok"))
        checked_at = _parse_iso8601(report_map.get("checked_at"))
        if checked_at is not None:
            evidence_age_minutes = max(
                0,
                int((now - checked_at).total_seconds() / 60),
            )
    market_context_freshness_seconds = _optional_int(
        market_context_status.get("last_freshness_seconds")
    )
    delay_depth_stress = _resolve_delay_adjusted_depth_stress_inputs(
        state=state,
        readiness=readiness,
    )
    delay_depth_stress_age_minutes: int | None = None
    if delay_depth_stress.checked_at is not None:
        delay_depth_stress_age_minutes = max(
            0,
            int((now - delay_depth_stress.checked_at).total_seconds() / 60),
        )

    statuses: list[dict[str, object]] = []
    for manifest in registry.items:
        tca_inputs = _resolve_tca_readiness_inputs(
            tca_summary,
            max_allowed_slippage_bps=manifest.max_allowed_slippage_bps,
            route_symbol_filter_enabled=route_symbol_filter_enabled,
            hypothesis_id=manifest.hypothesis_id,
            candidate_id=manifest.candidate_id,
            strategy_family=manifest.strategy_family,
            account_label=cast(str | None, tca_summary.get("account_label")),
        )
        runtime_ledger_inputs = _resolve_runtime_ledger_readiness_inputs(
            runtime_ledger_summary,
            manifest=manifest,
        )
        runtime_ledger_age_minutes: int | None = None
        if runtime_ledger_inputs.bucket_ended_at is not None:
            runtime_ledger_age_minutes = max(
                0,
                int((now - runtime_ledger_inputs.bucket_ended_at).total_seconds() / 60),
            )
        tca_age_minutes: int | None = None
        if tca_inputs.last_computed_at is not None:
            tca_age_minutes = max(
                0,
                int((now - tca_inputs.last_computed_at).total_seconds() / 60),
            )
        required_dependency_capabilities, unknown_dependency_capabilities = (
            _resolve_required_dependency_capabilities(manifest)
        )
        reasons: list[str] = []
        informational_reasons: list[str] = []
        requirements = manifest.entry_requirements

        if (
            _is_dependency_required(
                required_dependency_capabilities, "feature_coverage"
            )
            and requirements.require_feature_rows
            and feature_batch_rows_total
            < max(
                1,
                requirements.min_feature_batch_rows,
            )
        ):
            reasons.append("feature_rows_missing")
        if (
            _is_dependency_required(
                required_dependency_capabilities, "drift_governance"
            )
            and requirements.require_drift_checks
            and drift_detection_checks_total <= 0
        ):
            reasons.append("drift_checks_missing")
        if (
            _is_dependency_required(
                required_dependency_capabilities, "evidence_continuity"
            )
            and requirements.require_evidence_continuity
        ):
            if evidence_continuity_checks_total <= 0:
                reasons.append("evidence_continuity_missing")
            elif not evidence_ok:
                reasons.append("evidence_continuity_failed")
            if (
                requirements.max_evidence_age_minutes is not None
                and evidence_age_minutes is not None
                and evidence_age_minutes > requirements.max_evidence_age_minutes
            ):
                reasons.append("evidence_continuity_stale")
        if (
            runtime_ledger_inputs.proof_present
            and requirements.max_evidence_age_minutes is not None
            and runtime_ledger_age_minutes is not None
            and runtime_ledger_age_minutes > requirements.max_evidence_age_minutes
        ):
            if market_session_open is False:
                informational_reasons.append(
                    "closed_session_runtime_ledger_evidence_hold"
                )
            else:
                reasons.append("runtime_ledger_evidence_stale")
        if requirements.require_delay_adjusted_depth_stress:
            if (
                delay_depth_stress.check_count
                < requirements.min_delay_adjusted_depth_stress_checks
            ):
                reasons.append("delay_adjusted_depth_stress_missing")
            elif delay_depth_stress.passed is False:
                reasons.append("delay_adjusted_depth_stress_failed")
            if (
                delay_depth_stress.checked_at is None
                and requirements.max_delay_adjusted_depth_stress_age_minutes is not None
            ):
                reasons.append("delay_adjusted_depth_stress_missing")
            if (
                requirements.max_delay_adjusted_depth_stress_age_minutes is not None
                and delay_depth_stress_age_minutes is not None
                and delay_depth_stress_age_minutes
                > requirements.max_delay_adjusted_depth_stress_age_minutes
            ):
                reasons.append("delay_adjusted_depth_stress_stale")
        max_signal_lag_seconds = requirements.max_signal_lag_seconds
        if max_signal_lag_seconds is not None:
            signal_lag_unmeasured_without_features = (
                signal_lag_seconds is None and feature_batch_rows_total <= 0
            )
            signal_lag_exceeds_budget = (
                signal_lag_seconds is not None
                and signal_lag_seconds > max_signal_lag_seconds
            )
            if signal_lag_unmeasured_without_features or signal_lag_exceeds_budget:
                if market_session_open is False:
                    informational_reasons.append("closed_session_signal_hold")
                else:
                    reasons.append("signal_lag_exceeded")
        if (
            requirements.max_no_signal_streak is not None
            and no_signal_streak > requirements.max_no_signal_streak
        ):
            reasons.append("no_signal_streak_exceeded")
        if (
            _is_dependency_required(
                required_dependency_capabilities, "signal_continuity"
            )
            and signal_continuity_alert_active
        ):
            reasons.append("signal_continuity_alert_active")
        if (
            _is_dependency_required(
                required_dependency_capabilities, "market_context_freshness"
            )
            and requirements.max_market_context_freshness_seconds is not None
            and (
                market_context_freshness_seconds is None
                or market_context_freshness_seconds
                > requirements.max_market_context_freshness_seconds
            )
        ):
            if market_session_open is False:
                informational_reasons.append("closed_session_market_context_hold")
            else:
                reasons.append("market_context_stale")
        if (
            _is_dependency_required(
                required_dependency_capabilities, "jangar_dependency_quorum"
            )
            and requirements.required_dependency_quorum == "allow"
        ):
            if jangar_dependency_quorum.decision == "delay":
                reasons.append("jangar_dependency_delay")
            elif jangar_dependency_quorum.decision in {"block", "unknown"}:
                reasons.append("jangar_dependency_block")
        elif (
            _is_dependency_required(
                required_dependency_capabilities, "jangar_dependency_quorum"
            )
            and jangar_dependency_quorum.decision == "block"
        ):
            reasons.append("jangar_dependency_block")

        if unknown_dependency_capabilities:
            reasons.extend(
                f"dependency_capability_unknown:{capability}"
                for capability in sorted(unknown_dependency_capabilities)
            )

        if (
            manifest.initial_state == "blocked"
            and manifest.required_feature_sets
            and feature_batch_rows_total <= 0
        ):
            reasons.append("required_feature_set_unavailable")
        if (
            tca_inputs.order_count > 0
            and requirements.max_evidence_age_minutes is not None
            and (
                tca_age_minutes is None
                or tca_age_minutes > requirements.max_evidence_age_minutes
            )
        ):
            if market_session_open is False:
                informational_reasons.append("closed_session_tca_evidence_hold")
            else:
                reasons.append("tca_evidence_stale")

        readiness_blockers = set(reasons)

        capital_stage: CapitalStage = "shadow"
        capital_multiplier = Decimal("0")
        promotion_eligible = False
        rollback_required = bool(
            {
                "jangar_dependency_delay",
                "jangar_dependency_block",
                "signal_continuity_alert_active",
                "tca_evidence_stale",
            }
            & readiness_blockers
        )

        if not readiness_blockers:
            if tca_inputs.route_filter_applied and not tca_inputs.routeable_symbols:
                reasons.append("route_universe_empty")
                rollback_required = True
            elif not runtime_ledger_inputs.proof_present:
                reasons.append("runtime_ledger_proof_missing")
            elif runtime_ledger_inputs.observed_stage != "live":
                reasons.append("runtime_ledger_stage_not_live")
            elif runtime_ledger_inputs.blockers:
                reasons.extend(runtime_ledger_inputs.blockers)
                rollback_required = bool(
                    {
                        "unclosed_position",
                        "runtime_order_lifecycle_missing",
                        "submitted_order_lifecycle_missing",
                    }
                    & set(runtime_ledger_inputs.blockers)
                )
            elif (
                runtime_ledger_inputs.submitted_order_count
                < manifest.min_sample_count_for_live_canary
            ):
                reasons.append("sample_count_below_canary_minimum")
            elif tca_inputs.avg_abs_slippage_bps > manifest.max_allowed_slippage_bps:
                reasons.append("slippage_budget_exceeded")
                rollback_required = True
            elif runtime_ledger_inputs.post_cost_expectancy_bps is None:
                reasons.append("runtime_ledger_expectancy_missing")
                rollback_required = True
            elif runtime_ledger_inputs.post_cost_expectancy_bps <= Decimal("0"):
                reasons.append("post_cost_expectancy_non_positive")
                rollback_required = True
            elif (
                runtime_ledger_inputs.post_cost_expectancy_bps
                < manifest.expected_gross_edge_bps
            ):
                reasons.append("post_cost_expectancy_below_manifest_threshold")
            else:
                promotion_eligible = True
                if (
                    runtime_ledger_inputs.submitted_order_count
                    >= manifest.min_sample_count_for_scale_up
                ):
                    if (
                        tca_inputs.avg_abs_slippage_bps
                        <= manifest.max_allowed_slippage_bps * Decimal("0.60")
                    ):
                        capital_stage = "1.00x live"
                        capital_multiplier = Decimal("1.00")
                    else:
                        capital_stage = "0.50x live"
                        capital_multiplier = Decimal("0.50")
                else:
                    if (
                        tca_inputs.avg_abs_slippage_bps
                        <= manifest.max_allowed_slippage_bps * Decimal("0.75")
                    ):
                        capital_stage = "0.25x canary"
                        capital_multiplier = Decimal("0.25")
                    else:
                        capital_stage = "0.10x canary"
                        capital_multiplier = Decimal("0.10")

        if manifest.initial_state == "blocked" and readiness_blockers:
            state_name: HypothesisState = "blocked"
            capital_stage = "shadow"
            capital_multiplier = Decimal("0")
        elif capital_multiplier >= Decimal("0.50"):
            state_name = "scaled_live"
        elif capital_multiplier > 0:
            state_name = "canary_live"
        else:
            state_name = "shadow"

        observed: dict[str, object] = {
            "signal_lag_seconds": signal_lag_seconds,
            "no_signal_streak": no_signal_streak,
            "feature_batch_rows_total": feature_batch_rows_total,
            "drift_detection_checks_total": drift_detection_checks_total,
            "evidence_continuity_checks_total": evidence_continuity_checks_total,
            "evidence_continuity_ok": evidence_ok,
            "evidence_age_minutes": evidence_age_minutes,
            "delay_adjusted_depth_stress_checks_total": delay_depth_stress.check_count,
            "delay_adjusted_depth_stress_passed": delay_depth_stress.passed,
            "delay_adjusted_depth_stress_age_minutes": delay_depth_stress_age_minutes,
            "delay_adjusted_depth_stress_report_id": delay_depth_stress.report_id,
            "market_context_freshness_seconds": market_context_freshness_seconds,
            "tca_order_count": tca_inputs.order_count,
            "tca_last_computed_at": (
                tca_inputs.last_computed_at.isoformat()
                if tca_inputs.last_computed_at is not None
                else None
            ),
            "tca_age_minutes": tca_age_minutes,
            "market_session_open": market_session_open,
            "avg_abs_slippage_bps": _decimal_to_string(tca_inputs.avg_abs_slippage_bps),
            "runtime_ledger_proof_present": runtime_ledger_inputs.proof_present,
            "runtime_ledger_candidate_id": runtime_ledger_inputs.candidate_id,
            "runtime_ledger_observed_stage": runtime_ledger_inputs.observed_stage,
            "runtime_ledger_runtime_strategy_name": (
                runtime_ledger_inputs.runtime_strategy_name
            ),
            "runtime_ledger_strategy_family": runtime_ledger_inputs.strategy_family,
            "runtime_ledger_fill_count": runtime_ledger_inputs.fill_count,
            "runtime_ledger_submitted_order_count": runtime_ledger_inputs.submitted_order_count,
            "runtime_ledger_closed_trade_count": runtime_ledger_inputs.closed_trade_count,
            "runtime_ledger_open_position_count": runtime_ledger_inputs.open_position_count,
            "runtime_ledger_filled_notional": _decimal_to_string(
                runtime_ledger_inputs.filled_notional
            ),
            "runtime_ledger_net_strategy_pnl_after_costs": _decimal_to_string(
                runtime_ledger_inputs.net_strategy_pnl_after_costs
            ),
            "runtime_ledger_post_cost_expectancy_bps": (
                _decimal_to_string(runtime_ledger_inputs.post_cost_expectancy_bps)
                if runtime_ledger_inputs.post_cost_expectancy_bps is not None
                else None
            ),
            "runtime_ledger_bucket_started_at": (
                runtime_ledger_inputs.bucket_started_at.isoformat()
                if runtime_ledger_inputs.bucket_started_at is not None
                else None
            ),
            "runtime_ledger_bucket_ended_at": (
                runtime_ledger_inputs.bucket_ended_at.isoformat()
                if runtime_ledger_inputs.bucket_ended_at is not None
                else None
            ),
            "runtime_ledger_age_minutes": runtime_ledger_age_minutes,
            "runtime_ledger_blockers": list(runtime_ledger_inputs.blockers),
            "runtime_ledger_execution_policy_hash_count": (
                runtime_ledger_inputs.execution_policy_hash_count
            ),
            "runtime_ledger_cost_model_hash_count": (
                runtime_ledger_inputs.cost_model_hash_count
            ),
            "runtime_ledger_lineage_hash_count": runtime_ledger_inputs.lineage_hash_count,
            "runtime_ledger_schema_version": runtime_ledger_inputs.ledger_schema_version,
            "runtime_ledger_pnl_basis": runtime_ledger_inputs.pnl_basis,
        }
        if tca_inputs.route_filter_applied:
            observed.update(
                {
                    "route_symbol_filter_enabled": True,
                    "route_tca_symbols": list(tca_inputs.routeable_symbols),
                    "route_tca_symbol_count": len(tca_inputs.routeable_symbols),
                    "route_tca_repair_symbols": list(tca_inputs.route_repair_symbols),
                    "route_tca_repair_symbol_count": len(
                        tca_inputs.route_repair_symbols
                    ),
                    "route_tca_excluded_symbol_count": tca_inputs.route_excluded_symbol_count,
                    "route_tca_missing_symbol_count": tca_inputs.route_missing_symbol_count,
                    "route_tca_blocking_reason_codes": list(
                        tca_inputs.route_blocking_reason_codes
                    ),
                    "route_tca_symbol_diagnostics": list(
                        tca_inputs.route_symbol_diagnostics
                    ),
                    "bounded_route_evidence_collection_eligible": bool(
                        tca_inputs.route_repair_symbols
                    ),
                    "bounded_route_evidence_collection_authority": (
                        "repair_only_non_authority"
                        if tca_inputs.route_repair_symbols
                        else "none"
                    ),
                    "bounded_route_repair_action": (
                        "collect_bounded_paper_route_source_rows_before_promotion"
                        if tca_inputs.route_repair_symbols
                        else "none"
                    ),
                }
            )

        statuses.append(
            {
                "hypothesis_id": manifest.hypothesis_id,
                "candidate_id": manifest.candidate_id,
                "strategy_id": manifest.strategy_id or manifest.strategy_family,
                "dataset_snapshot_ref": manifest.dataset_snapshot_ref,
                "lane_id": manifest.lane_id,
                "strategy_family": manifest.strategy_family,
                "initial_state": manifest.initial_state,
                "state": state_name,
                "capital_stage": capital_stage,
                "capital_multiplier": _decimal_to_string(capital_multiplier),
                "promotion_eligible": promotion_eligible,
                "rollback_required": rollback_required,
                "reasons": sorted(set(reasons)),
                "informational_reasons": sorted(set(informational_reasons)),
                "required_feature_sets": list(manifest.required_feature_sets),
                "required_dependency_capabilities": list(
                    manifest.required_dependency_capabilities
                ),
                "segment_dependencies": list(manifest.segment_dependencies),
                "observed": observed,
                "dependency_capabilities": {
                    "required": sorted(required_dependency_capabilities),
                    "unknown": sorted(unknown_dependency_capabilities),
                },
                "entry_contract": {
                    "max_signal_lag_seconds": requirements.max_signal_lag_seconds,
                    "max_no_signal_streak": requirements.max_no_signal_streak,
                    "max_market_context_freshness_seconds": requirements.max_market_context_freshness_seconds,
                    "max_evidence_age_minutes": requirements.max_evidence_age_minutes,
                    "min_feature_batch_rows": requirements.min_feature_batch_rows,
                    "require_delay_adjusted_depth_stress": (
                        requirements.require_delay_adjusted_depth_stress
                    ),
                    "min_delay_adjusted_depth_stress_checks": (
                        requirements.min_delay_adjusted_depth_stress_checks
                    ),
                    "max_delay_adjusted_depth_stress_age_minutes": (
                        requirements.max_delay_adjusted_depth_stress_age_minutes
                    ),
                },
                "promotion_contract": {
                    "min_sample_count_for_live_canary": manifest.min_sample_count_for_live_canary,
                    "min_sample_count_for_scale_up": manifest.min_sample_count_for_scale_up,
                    "min_post_cost_expectancy_bps": _decimal_to_string(
                        manifest.expected_gross_edge_bps
                    ),
                    "max_avg_abs_slippage_bps": _decimal_to_string(
                        manifest.max_allowed_slippage_bps
                    ),
                    "profitability_authority": "runtime_ledger",
                    "sample_count_source": "runtime_ledger_submitted_order_count",
                },
                "dependency_quorum": jangar_dependency_quorum.as_payload(),
                "lineage_ref": {
                    "status": "manifest_declared"
                    if manifest.candidate_id or manifest.dataset_snapshot_ref
                    else "unverified",
                    "candidate_id": manifest.candidate_id,
                    "hypothesis_id": manifest.hypothesis_id,
                    "dataset_snapshot_ref": manifest.dataset_snapshot_ref,
                    "strategy_id": manifest.strategy_id or manifest.strategy_family,
                    "lane_id": manifest.lane_id,
                    "strategy_family": manifest.strategy_family,
                },
            }
        )
    return statuses


def summarize_hypothesis_runtime_statuses(
    statuses: Sequence[Mapping[str, Any]],
    *,
    registry: HypothesisRegistryLoadResult,
    dependency_quorum: JangarDependencyQuorumStatus,
) -> dict[str, object]:
    state_totals = Counter(str(item.get("state") or "unknown") for item in statuses)
    reason_totals = Counter(
        str(reason)
        for item in statuses
        for reason in cast(Sequence[object], item.get("reasons") or [])
        if str(reason).strip()
    )
    informational_reason_totals = Counter(
        str(reason)
        for item in statuses
        for reason in cast(Sequence[object], item.get("informational_reasons") or [])
        if str(reason).strip()
    )
    capital_stage_totals = Counter(
        str(item.get("capital_stage") or "shadow") for item in statuses
    )
    capital_multiplier_by_hypothesis = {
        str(item.get("hypothesis_id") or "unknown"): str(
            item.get("capital_multiplier") or "0"
        )
        for item in statuses
    }
    promotion_eligible_total = sum(
        1 for item in statuses if bool(item.get("promotion_eligible"))
    )
    paper_probation_eligible_total = sum(
        1 for item in statuses if bool(item.get("paper_probation_eligible"))
    )
    rollback_required_total = sum(
        1 for item in statuses if bool(item.get("rollback_required"))
    )
    ranked_candidates = _ranked_candidate_dossiers(statuses)
    return {
        "candidate_dossier_version": "torghut.hypothesis-candidate-dossier.v1",
        "registry_loaded": registry.loaded,
        "registry_path": registry.path,
        "registry_errors": list(registry.errors),
        "hypotheses_total": len(statuses),
        "ranked_candidates": ranked_candidates,
        "selected_candidate": ranked_candidates[0] if ranked_candidates else None,
        "state_totals": dict(sorted(state_totals.items())),
        "reason_totals": dict(sorted(reason_totals.items())),
        "informational_reason_totals": dict(
            sorted(informational_reason_totals.items())
        ),
        "capital_stage_totals": dict(sorted(capital_stage_totals.items())),
        "capital_multiplier_by_hypothesis": capital_multiplier_by_hypothesis,
        "promotion_eligible_total": promotion_eligible_total,
        "paper_probation_eligible_total": paper_probation_eligible_total,
        "rollback_required_total": rollback_required_total,
        "dependency_quorum": dependency_quorum.as_payload(),
    }


__all__ = [
    "HypothesisManifest",
    "HypothesisRegistryLoadResult",
    "JangarDependencyQuorumStatus",
    "compile_hypothesis_runtime_statuses",
    "hypothesis_registry_requires_dependency_capability",
    "load_hypothesis_registry",
    "load_jangar_dependency_quorum",
    "resolve_hypothesis_dependency_quorum",
    "resolve_hypothesis_registry_path",
    "summarize_hypothesis_runtime_statuses",
    "validate_hypothesis_registry_from_settings",
]
