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

# ruff: noqa: F401

from .shared_context import (
    CapitalStage,
    DependencyQuorumDecision,
    HypothesisEntryRequirements,
    HypothesisManifest,
    HypothesisRegistryLoadResult,
    HypothesisState,
    CAPITAL_STAGE_RANK as _CAPITAL_STAGE_RANK,
    DEPENDENCY_REASONS as _DEPENDENCY_REASONS,
    EDGE_OR_COST_REASONS as _EDGE_OR_COST_REASONS,
    EVIDENCE_REFRESH_REASONS as _EVIDENCE_REFRESH_REASONS,
    JANGAR_QUORUM_CACHE as _JANGAR_QUORUM_CACHE,
    JANGAR_QUORUM_CACHE_LOCK as _JANGAR_QUORUM_CACHE_LOCK,
    JangarDependencyQuorumStatus,
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


def _manifest_pair_contract_blockers(manifest: HypothesisManifest) -> tuple[str, ...]:
    if "pairs" not in manifest.strategy_family and "pairs" not in manifest.lane_id:
        return ()

    blockers: list[str] = []
    symbols = tuple(manifest.evidence_universe_symbols)
    if not symbols:
        blockers.append("evidence_universe_symbols_missing")
    elif len(symbols) < 2:
        blockers.append("evidence_universe_symbol_count_below_pair_minimum")
    elif len(symbols) % 2 != 0:
        blockers.append("pair_universe_unbalanced")
    if not manifest.require_pair_balance:
        blockers.append("pair_balance_not_declared")
    return tuple(blockers)


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
    target_scope_symbols: Sequence[str] = (),
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
    summary_scope_symbols = tuple(
        str(item).strip().upper()
        for item in _sequence(tca_summary.get("scope_symbols"))
        if str(item).strip()
    )
    manifest_scope_symbols = tuple(
        dict.fromkeys(
            str(item).strip().upper()
            for item in target_scope_symbols
            if str(item).strip()
        )
    )
    scope_symbols = manifest_scope_symbols or summary_scope_symbols
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
        if manifest_scope_symbols and symbol not in scope_symbol_set:
            excluded_symbol_count += 1
            route_blockers.append("route_tca_out_of_scope_symbol")
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


weighted_decimal_average = _weighted_decimal_average

__all__ = ("weighted_decimal_average",)

# Public aliases used by split modules.
DelayAdjustedDepthStressInputs = _DelayAdjustedDepthStressInputs
extract_controller_ingestion_settlement = _extract_controller_ingestion_settlement
extract_foreclosure_carry_rollout_witness = _extract_foreclosure_carry_rollout_witness
extract_repair_slot_escrow = _extract_repair_slot_escrow
extract_stage_debt_repair_admission = _extract_stage_debt_repair_admission
extract_stage_renewal_bonds = _extract_stage_renewal_bonds
extract_verify_trust_foreclosure_board = _extract_verify_trust_foreclosure_board
latest_tca_timestamp = _latest_tca_timestamp
manifest_pair_contract_blockers = _manifest_pair_contract_blockers
NON_AUTHORITY_TCA_DECISION_MODES = _NON_AUTHORITY_TCA_DECISION_MODES
NON_AUTHORITY_TCA_SOURCE_KINDS = _NON_AUTHORITY_TCA_SOURCE_KINDS
normalized_route_token = _normalized_route_token
resolve_delay_adjusted_depth_stress_inputs = _resolve_delay_adjusted_depth_stress_inputs
resolve_tca_readiness_inputs = _resolve_tca_readiness_inputs
route_tca_adverse_slippage = _route_tca_adverse_slippage
route_tca_authority_blockers = _route_tca_authority_blockers
route_tca_bool = _route_tca_bool
route_tca_diagnostic = _route_tca_diagnostic
route_tca_target_blockers = _route_tca_target_blockers
route_tca_text = _route_tca_text
runtime_ledger_rows_for_hypothesis = _runtime_ledger_rows_for_hypothesis
runtime_ledger_target_blockers = _runtime_ledger_target_blockers
runtime_target_token = _runtime_target_token
runtime_text = _runtime_text
RuntimeLedgerReadinessInputs = _RuntimeLedgerReadinessInputs
TcaReadinessInputs = _TcaReadinessInputs
