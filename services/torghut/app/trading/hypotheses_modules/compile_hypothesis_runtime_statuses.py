# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
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

# ruff: noqa: F401,F811,F821

from .shared_context import (
    CapitalStage,
    DependencyQuorumDecision,
    HypothesisEntryRequirements,
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    HypothesisState,
    JangarDependencyQuorumStatus,
    CAPITAL_STAGE_RANK as _CAPITAL_STAGE_RANK,
    DEPENDENCY_REASONS as _DEPENDENCY_REASONS,
    EDGE_OR_COST_REASONS as _EDGE_OR_COST_REASONS,
    EVIDENCE_REFRESH_REASONS as _EVIDENCE_REFRESH_REASONS,
    JANGAR_QUORUM_CACHE as _JANGAR_QUORUM_CACHE,
    JANGAR_QUORUM_CACHE_LOCK as _JANGAR_QUORUM_CACHE_LOCK,
    KNOWN_DEPENDENCY_CAPABILITIES as _KNOWN_DEPENDENCY_CAPABILITIES,
    KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS as _KNOWN_RUNTIME_LEDGER_SCHEMA_VERSIONS,
    RUNTIME_LEDGER_PROVENANCE_REASONS as _RUNTIME_LEDGER_PROVENANCE_REASONS,
    SAMPLE_REASONS as _SAMPLE_REASONS,
    as_payload_dict as _as_payload_dict,
    as_payload_dict_list as _as_payload_dict_list,
    bounded_route_evidence_collection_readiness as _bounded_route_evidence_collection_readiness,
    candidate_blocker_class as _candidate_blocker_class,
    candidate_blocker_rank as _candidate_blocker_rank,
    coerce_decimal as _coerce_decimal,
    decimal_to_string as _decimal_to_string,
    empty_payload_dict as _empty_payload_dict,
    empty_payload_dict_list as _empty_payload_dict_list,
    extract_stage_trust as _extract_stage_trust,
    first_matching_reason as _first_matching_reason,
    is_dependency_required as _is_dependency_required,
    normalize_dependency_capability as _normalize_dependency_capability,
    optional_bool as _optional_bool,
    optional_decimal as _optional_decimal,
    optional_int as _optional_int,
    parse_iso8601 as _parse_iso8601,
    ranked_candidate_dossiers as _ranked_candidate_dossiers,
    resolve_required_dependency_capabilities as _resolve_required_dependency_capabilities,
    sequence as _sequence,
    stable_string_list as _stable_string_list,
    hypothesis_registry_requires_dependency_capability,
    resolve_hypothesis_dependency_quorum,
)
from .extract_stage_renewal_bonds import (
    DelayAdjustedDepthStressInputs as _DelayAdjustedDepthStressInputs,
    NON_AUTHORITY_TCA_DECISION_MODES as _NON_AUTHORITY_TCA_DECISION_MODES,
    NON_AUTHORITY_TCA_SOURCE_KINDS as _NON_AUTHORITY_TCA_SOURCE_KINDS,
    RuntimeLedgerReadinessInputs as _RuntimeLedgerReadinessInputs,
    TcaReadinessInputs as _TcaReadinessInputs,
    extract_controller_ingestion_settlement as _extract_controller_ingestion_settlement,
    extract_foreclosure_carry_rollout_witness as _extract_foreclosure_carry_rollout_witness,
    extract_repair_slot_escrow as _extract_repair_slot_escrow,
    extract_stage_debt_repair_admission as _extract_stage_debt_repair_admission,
    extract_stage_renewal_bonds as _extract_stage_renewal_bonds,
    extract_verify_trust_foreclosure_board as _extract_verify_trust_foreclosure_board,
    latest_tca_timestamp as _latest_tca_timestamp,
    manifest_pair_contract_blockers as _manifest_pair_contract_blockers,
    normalized_route_token as _normalized_route_token,
    resolve_delay_adjusted_depth_stress_inputs as _resolve_delay_adjusted_depth_stress_inputs,
    resolve_tca_readiness_inputs as _resolve_tca_readiness_inputs,
    route_tca_adverse_slippage as _route_tca_adverse_slippage,
    route_tca_authority_blockers as _route_tca_authority_blockers,
    route_tca_bool as _route_tca_bool,
    route_tca_diagnostic as _route_tca_diagnostic,
    route_tca_target_blockers as _route_tca_target_blockers,
    route_tca_text as _route_tca_text,
    runtime_ledger_rows_for_hypothesis as _runtime_ledger_rows_for_hypothesis,
    runtime_ledger_target_blockers as _runtime_ledger_target_blockers,
    runtime_target_token as _runtime_target_token,
    runtime_text as _runtime_text,
    weighted_decimal_average as _weighted_decimal_average,
)
from .runtime_ledger_row_rank import (
    dedupe_runtime_ledger_blockers as _dedupe_runtime_ledger_blockers,
    fallback_quorum_from_legacy_status as _fallback_quorum_from_legacy_status,
    hash_count as _hash_count,
    load_manifest_payload as _load_manifest_payload,
    resolve_runtime_ledger_readiness_inputs as _resolve_runtime_ledger_readiness_inputs,
    runtime_ledger_blockers as _runtime_ledger_blockers,
    runtime_ledger_latest_row as _runtime_ledger_latest_row,
    runtime_ledger_provenance_blockers as _runtime_ledger_provenance_blockers,
    runtime_ledger_row_rank as _runtime_ledger_row_rank,
    runtime_ledger_window_bound_blockers as _runtime_ledger_window_bound_blockers,
    load_hypothesis_registry,
    load_jangar_dependency_quorum,
    resolve_hypothesis_registry_path,
    validate_hypothesis_registry_from_settings,
)


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
        pair_contract_blockers = _manifest_pair_contract_blockers(manifest)
        tca_inputs = _resolve_tca_readiness_inputs(
            tca_summary,
            max_allowed_slippage_bps=manifest.max_allowed_slippage_bps,
            route_symbol_filter_enabled=route_symbol_filter_enabled,
            target_scope_symbols=manifest.evidence_universe_symbols,
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
        reasons.extend(pair_contract_blockers)

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
            "evidence_universe_symbols": list(manifest.evidence_universe_symbols),
            "evidence_universe_symbol_count": len(manifest.evidence_universe_symbols),
            "pair_balance_required": manifest.require_pair_balance,
            "pair_contract_blockers": list(pair_contract_blockers),
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
            bounded_route_liveness = _bounded_route_evidence_collection_readiness(
                route_repair_symbols=tca_inputs.route_repair_symbols,
                requirements=requirements,
                signal_lag_seconds=signal_lag_seconds,
                drift_detection_checks_total=drift_detection_checks_total,
                market_session_open=market_session_open,
            )
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
                    "bounded_route_evidence_collection_ready": bool(
                        bounded_route_liveness["ready"]
                    ),
                    "bounded_route_evidence_collection_blockers": list(
                        cast(
                            Sequence[str],
                            bounded_route_liveness["blockers"],
                        )
                    ),
                    "bounded_route_evidence_collection_next_action": str(
                        bounded_route_liveness["next_action"]
                    ),
                    "bounded_route_evidence_collection_liveness": dict(
                        bounded_route_liveness
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
                    **(
                        {
                            "evidence_universe_symbols": list(
                                manifest.evidence_universe_symbols
                            )
                        }
                        if manifest.evidence_universe_symbols
                        else {}
                    ),
                    **(
                        {"require_pair_balance": True}
                        if manifest.require_pair_balance
                        else {}
                    ),
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


__all__ = (
    "compile_hypothesis_runtime_statuses",
    "summarize_hypothesis_runtime_statuses",
)
