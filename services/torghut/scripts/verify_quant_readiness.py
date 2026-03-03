#!/usr/bin/env python
"""Verify Torghut quant readiness controls for provenance and rollback evidence."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, cast

from sqlalchemy import and_, func, or_, select

from app.db import SessionLocal
from app.models import (
    Execution,
    ResearchCandidate,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchStressMetrics,
    TradeDecision,
)


def _parse_iso8601_timestamp(raw: str, *, field_name: str) -> datetime:
    normalized = raw.strip()
    if not normalized:
        raise ValueError(f'{field_name}_missing')
    if normalized.endswith('Z'):
        normalized = f'{normalized[:-1]}+00:00'
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f'{field_name}_invalid') from exc
    if parsed.tzinfo is None:
        raise ValueError(f'{field_name}_missing_timezone')
    return parsed.astimezone(timezone.utc)


def _load_gate_trace(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('gate_report_payload_invalid')
    payload_map = cast(dict[str, Any], payload)
    provenance = payload_map.get('provenance')
    if not isinstance(provenance, dict):
        raise ValueError('gate_report_missing_provenance')
    provenance_map = cast(dict[str, Any], provenance)
    gate_trace = str(provenance_map.get('gate_report_trace_id', '')).strip()
    recommendation_trace = str(provenance_map.get('recommendation_trace_id', '')).strip()
    if not gate_trace:
        raise ValueError('gate_report_trace_id_missing')
    if not recommendation_trace:
        raise ValueError('recommendation_trace_id_missing')
    return {
        'gate_report_trace_id': gate_trace,
        'recommendation_trace_id': recommendation_trace,
    }


def _load_profitability_proof(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('profitability_proof_invalid')
    payload_map = cast(dict[str, Any], payload)
    required_root_keys = (
        'hypothesis',
        'window_days',
        'statistics',
        'risk_controls',
    )
    missing = [key for key in required_root_keys if key not in payload_map]
    if missing:
        raise ValueError(f'profitability_proof_missing_keys:{",".join(missing)}')

    raw_statistics = payload_map.get('statistics')
    if not isinstance(raw_statistics, dict):
        raise ValueError('profitability_proof_statistics_invalid')
    statistics = cast(dict[str, Any], raw_statistics)

    effect_size = statistics.get('effect_size')
    if not isinstance(effect_size, (int, float)):
        raise ValueError('profitability_proof_effect_size_invalid')

    sample_size = payload_map.get('sample_size')
    if not isinstance(sample_size, int) or sample_size < 1:
        raise ValueError('profitability_proof_sample_size_invalid')

    p_value = statistics.get('p_value')
    if not isinstance(p_value, (int, float)) or not 0 <= float(p_value) <= 1:
        raise ValueError('profitability_proof_p_value_invalid')

    raw_risk_controls = payload_map.get('risk_controls')
    if not isinstance(raw_risk_controls, dict):
        raise ValueError('profitability_proof_risk_controls_invalid')
    risk_controls = cast(dict[str, Any], raw_risk_controls)

    drawdown_delta = risk_controls.get('max_drawdown_delta')
    if not isinstance(drawdown_delta, (int, float)):
        raise ValueError('profitability_proof_risk_controls_drawdown_invalid')

    window_days = payload_map.get('window_days')
    if not isinstance(window_days, (int, float)) or window_days <= 0:
        raise ValueError('profitability_proof_window_days_invalid')

    hypothesis = str(payload_map.get('hypothesis', '')).strip()
    if not hypothesis:
        raise ValueError('profitability_proof_hypothesis_missing')

    return {
        'hypothesis': hypothesis,
        'sample_size': sample_size,
        'window_days': float(window_days),
        'effect_size': float(effect_size),
        'p_value': float(p_value),
        'drawdown_delta': float(drawdown_delta),
        'risk_controls': risk_controls,
    }


def _load_incident_evidence(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('incident_payload_invalid')
    payload_map = cast(dict[str, Any], payload)
    required_keys = (
        'triggered_at',
        'reasons',
        'rollback_hooks',
        'safety_snapshot',
        'provenance',
        'verification',
    )
    missing = [key for key in required_keys if key not in payload_map]
    if missing:
        raise ValueError(f'incident_payload_missing_keys:{",".join(missing)}')
    rollback_hooks = payload_map.get('rollback_hooks')
    if not isinstance(rollback_hooks, dict):
        raise ValueError('incident_payload_rollback_hooks_invalid')
    reasons = payload_map.get('reasons')
    if not isinstance(reasons, list) or not reasons:
        raise ValueError('incident_payload_reasons_invalid')
    if not bool(rollback_hooks.get('order_submission_blocked', False)):
        raise ValueError('incident_payload_order_block_missing')
    verification = payload_map.get('verification')
    if not isinstance(verification, dict):
        raise ValueError('incident_payload_verification_invalid')
    if not bool(verification.get('incident_evidence_complete', False)):
        raise ValueError('incident_payload_verification_failed')
    return payload_map


def _load_control_plane_contract(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('control_plane_contract_invalid')
    payload_map = cast(dict[str, Any], payload)
    required_keys = (
        'contract_version',
        'signal_continuity_state',
        'signal_continuity_alert_active',
        'signal_continuity_promotion_block_total',
        'last_autonomy_recommendation_trace_id',
        'domain_telemetry_event_total',
        'domain_telemetry_dropped_total',
    )
    missing = [key for key in required_keys if key not in payload_map]
    if missing:
        raise ValueError(f'control_plane_contract_missing_keys:{",".join(missing)}')
    if payload_map.get('contract_version') != 'torghut.quant-producer.v1':
        raise ValueError('control_plane_contract_version_invalid')
    telemetry_events = payload_map.get('domain_telemetry_event_total')
    if not isinstance(telemetry_events, dict):
        raise ValueError('control_plane_contract_domain_telemetry_events_invalid')
    telemetry_drops = payload_map.get('domain_telemetry_dropped_total')
    if not isinstance(telemetry_drops, dict):
        raise ValueError('control_plane_contract_domain_telemetry_dropped_invalid')
    return payload_map


def _load_model_risk_evidence_package(
    path: Path,
    *,
    now: datetime,
    max_age_hours: int,
) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, dict):
        raise ValueError('model_risk_evidence_package_invalid')
    payload_map = cast(dict[str, Any], payload)
    required_keys = (
        'schema_version',
        'generated_at',
        'promotion',
        'rollback',
        'drift',
        'runbook_drill',
        'legacy_gap_disposition',
    )
    missing = [key for key in required_keys if key not in payload_map]
    if missing:
        raise ValueError(
            f'model_risk_evidence_package_missing_keys:{",".join(missing)}'
        )
    generated_at_raw = payload_map.get('generated_at')
    if not isinstance(generated_at_raw, str):
        raise ValueError('model_risk_evidence_package_generated_at_invalid')
    generated_at = _parse_iso8601_timestamp(
        generated_at_raw,
        field_name='model_risk_evidence_package_generated_at',
    )
    age_hours = max(
        0.0,
        (now - generated_at).total_seconds() / 3600.0,
    )
    if age_hours > max(1, int(max_age_hours)):
        raise ValueError('model_risk_evidence_package_stale')

    promotion_raw = payload_map.get('promotion')
    if not isinstance(promotion_raw, dict):
        raise ValueError('model_risk_evidence_package_promotion_invalid')
    promotion = cast(dict[str, Any], promotion_raw)
    gate_trace = str(promotion.get('gate_report_trace_id', '')).strip()
    recommendation_trace = str(promotion.get('recommendation_trace_id', '')).strip()
    if not gate_trace:
        raise ValueError('model_risk_evidence_package_gate_trace_missing')
    if not recommendation_trace:
        raise ValueError('model_risk_evidence_package_recommendation_trace_missing')

    rollback_raw = payload_map.get('rollback')
    if not isinstance(rollback_raw, dict):
        raise ValueError('model_risk_evidence_package_rollback_invalid')
    rollback = cast(dict[str, Any], rollback_raw)
    incident_evidence_path = str(rollback.get('incident_evidence_path', '')).strip()
    if not incident_evidence_path:
        raise ValueError('model_risk_evidence_package_rollback_incident_path_missing')
    if not bool(rollback.get('incident_evidence_complete', False)):
        raise ValueError('model_risk_evidence_package_rollback_incomplete')

    drift_raw = payload_map.get('drift')
    if not isinstance(drift_raw, dict):
        raise ValueError('model_risk_evidence_package_drift_invalid')
    drift = cast(dict[str, Any], drift_raw)
    continuity_path = str(drift.get('evidence_continuity_report_path', '')).strip()
    if not continuity_path:
        raise ValueError('model_risk_evidence_package_drift_report_missing')
    if not bool(drift.get('evidence_continuity_passed', False)):
        raise ValueError('model_risk_evidence_package_drift_not_passed')

    runbook_raw = payload_map.get('runbook_drill')
    if not isinstance(runbook_raw, dict):
        raise ValueError('model_risk_evidence_package_runbook_invalid')
    runbook = cast(dict[str, Any], runbook_raw)
    rehearsal_at_raw = str(runbook.get('rehearsal_at', '')).strip()
    if not rehearsal_at_raw:
        raise ValueError('model_risk_evidence_package_runbook_rehearsal_missing')
    _parse_iso8601_timestamp(
        rehearsal_at_raw,
        field_name='model_risk_evidence_package_rehearsal_at',
    )
    if not bool(runbook.get('emergency_stop_rehearsed', False)):
        raise ValueError('model_risk_evidence_package_runbook_rehearsal_not_passed')

    legacy_raw = payload_map.get('legacy_gap_disposition')
    if not isinstance(legacy_raw, dict):
        raise ValueError('model_risk_evidence_package_legacy_disposition_invalid')
    legacy_disposition = cast(dict[str, Any], legacy_raw)
    mapping_path = str(legacy_disposition.get('mapping_path', '')).strip()
    if not mapping_path:
        raise ValueError('model_risk_evidence_package_legacy_mapping_missing')
    if not bool(legacy_disposition.get('signed_disposition_complete', False)):
        raise ValueError('model_risk_evidence_package_legacy_disposition_incomplete')

    return {
        'schema_version': str(payload_map.get('schema_version', '')).strip(),
        'generated_at': generated_at.isoformat(),
        'age_hours': round(age_hours, 4),
        'promotion_gate_report_trace_id': gate_trace,
        'promotion_recommendation_trace_id': recommendation_trace,
        'rollback_incident_evidence_path': incident_evidence_path,
        'drift_evidence_continuity_report_path': continuity_path,
        'runbook_rehearsal_at': rehearsal_at_raw,
        'legacy_mapping_path': mapping_path,
    }


def _evaluate_acceptance_window(
    *,
    non_skipped_runs: int,
    trade_decisions: int,
    executions: int,
    full_chain_runs: int,
    route_total: int,
    missing_route_rows: int,
    route_fallback_rows: int,
    advisor_eligible_rows: int,
    advisor_payload_rows: int,
    min_non_skipped_runs: int,
    min_trade_decisions: int,
    min_executions: int,
    min_full_chain_runs: int,
    min_route_coverage_ratio: float,
    min_execution_advisor_coverage_ratio: float,
    max_route_fallback_ratio: float,
) -> dict[str, Any]:
    route_coverage_ratio = (
        max(0.0, (route_total - missing_route_rows) / route_total)
        if route_total > 0
        else 0.0
    )
    route_fallback_ratio = (
        max(0.0, route_fallback_rows / route_total)
        if route_total > 0
        else 0.0
    )
    execution_advisor_coverage_ratio = (
        max(0.0, advisor_payload_rows / advisor_eligible_rows)
        if advisor_eligible_rows > 0
        else 1.0
    )
    passed = (
        non_skipped_runs >= min_non_skipped_runs
        and trade_decisions >= min_trade_decisions
        and executions >= min_executions
        and full_chain_runs >= min_full_chain_runs
        and route_coverage_ratio >= min_route_coverage_ratio
        and route_fallback_ratio <= max_route_fallback_ratio
        and execution_advisor_coverage_ratio >= min_execution_advisor_coverage_ratio
    )
    return {
        'passed': passed,
        'lookback': {
            'non_skipped_runs': non_skipped_runs,
            'trade_decisions': trade_decisions,
            'executions': executions,
            'full_chain_runs': full_chain_runs,
            'route_total': route_total,
            'missing_route_rows': missing_route_rows,
            'route_coverage_ratio': round(route_coverage_ratio, 6),
            'route_fallback_rows': route_fallback_rows,
            'route_fallback_ratio': round(route_fallback_ratio, 6),
            'execution_advisor_eligible_rows': advisor_eligible_rows,
            'execution_advisor_payload_rows': advisor_payload_rows,
            'execution_advisor_coverage_ratio': round(execution_advisor_coverage_ratio, 6),
        },
        'thresholds': {
            'min_non_skipped_runs': min_non_skipped_runs,
            'min_trade_decisions': min_trade_decisions,
            'min_executions': min_executions,
            'min_full_chain_runs': min_full_chain_runs,
            'min_route_coverage_ratio': min_route_coverage_ratio,
            'max_route_fallback_ratio': max_route_fallback_ratio,
            'min_execution_advisor_coverage_ratio': min_execution_advisor_coverage_ratio,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='Verify Torghut autonomous quant readiness controls.')
    parser.add_argument(
        '--gate-report',
        type=Path,
        help='Optional gate-evaluation artifact path to validate governance trace IDs.',
    )
    parser.add_argument(
        '--max-missing-provenance',
        type=int,
        default=0,
        help='Allowed number of execution rows missing expected/actual adapter metadata.',
    )
    parser.add_argument(
        '--max-invalid-fallback-reason',
        type=int,
        default=0,
        help='Allowed number of fallback rows missing fallback reason when fallback_count > 0.',
    )
    parser.add_argument(
        '--max-missing-research-traces',
        type=int,
        default=0,
        help='Allowed number of non-skipped research runs missing gate/recommendation trace IDs.',
    )
    parser.add_argument(
        '--incident-evidence',
        type=Path,
        help='Optional rollback incident evidence path to validate emergency-stop evidence package.',
    )
    parser.add_argument(
        '--profitability-proof',
        type=Path,
        help='Optional profitability proof manifest path with scientific evidence details.',
    )
    parser.add_argument(
        '--control-plane-contract',
        type=Path,
        help='Optional control-plane contract artifact to verify drift/promotion/telemetry continuity fields.',
    )
    parser.add_argument(
        '--model-risk-evidence-package',
        type=Path,
        help='Optional model-risk evidence package artifact enforcing Wave-6 audit completeness.',
    )
    parser.add_argument(
        '--max-model-risk-evidence-age-hours',
        type=int,
        default=48,
        help='Maximum allowed age (hours) for model-risk evidence package generated_at timestamp.',
    )
    parser.add_argument(
        '--lookback-hours',
        type=int,
        default=24,
        help='Hours to evaluate for acceptance-window continuity checks.',
    )
    parser.add_argument(
        '--min-non-skipped-runs',
        type=int,
        default=1,
        help='Minimum non-skipped autonomous runs required in lookback window.',
    )
    parser.add_argument(
        '--min-trade-decisions',
        type=int,
        default=1,
        help='Minimum trade decisions required in lookback window.',
    )
    parser.add_argument(
        '--min-executions',
        type=int,
        default=1,
        help='Minimum executions required in lookback window.',
    )
    parser.add_argument(
        '--min-full-chain-runs',
        type=int,
        default=1,
        help='Minimum research runs with complete candidate/fold/stress/promotion chain in lookback window.',
    )
    parser.add_argument(
        '--min-route-coverage-ratio',
        type=float,
        default=0.99,
        help='Minimum route provenance coverage ratio in lookback window.',
    )
    parser.add_argument(
        '--max-route-fallback-ratio',
        type=float,
        default=0.05,
        help='Maximum allowed route fallback ratio in lookback window.',
    )
    parser.add_argument(
        '--min-execution-advisor-coverage-ratio',
        type=float,
        default=0.99,
        help='Minimum execution_advisor payload coverage ratio on rows that include microstructure_state.',
    )
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    lookback_hours = max(1, int(args.lookback_hours))
    lookback_start = now - timedelta(hours=lookback_hours)

    with SessionLocal() as session:
        missing_route_query = select(func.count(Execution.id)).where(
            and_(
                Execution.created_at >= lookback_start,
                or_(
                    Execution.execution_expected_adapter.is_(None),
                    and_(
                        Execution.execution_expected_adapter.is_not(None),
                        func.btrim(Execution.execution_expected_adapter) == '',
                    ),
                    Execution.execution_actual_adapter.is_(None),
                    and_(
                        Execution.execution_actual_adapter.is_not(None),
                        func.btrim(Execution.execution_actual_adapter) == '',
                    ),
                ),
            )
        )
        missing_route_count = session.execute(missing_route_query).scalar_one()

        total_route_count = session.execute(
            select(func.count(Execution.id)).where(Execution.created_at >= lookback_start)
        ).scalar_one()
        fallback_route_count = session.execute(
            select(func.count(Execution.id)).where(
                and_(
                    Execution.created_at >= lookback_start,
                    Execution.execution_fallback_count > 0,
                )
            )
        ).scalar_one()

        invalid_fallback_reason_count = session.execute(
            select(func.count(Execution.id)).where(
                and_(
                    Execution.created_at >= lookback_start,
                    Execution.execution_fallback_count > 0,
                    or_(
                        Execution.execution_fallback_reason.is_(None),
                        and_(
                            Execution.execution_fallback_reason.is_not(None),
                            func.btrim(Execution.execution_fallback_reason) == '',
                        ),
                    ),
                )
            )
        ).scalar_one()

        missing_research_trace_count = session.execute(
            select(func.count(ResearchRun.id)).where(
                and_(
                    ResearchRun.created_at >= lookback_start,
                    ResearchRun.status != 'skipped',
                    or_(
                        ResearchRun.gate_report_trace_id.is_(None),
                        and_(
                            ResearchRun.gate_report_trace_id.is_not(None),
                            func.btrim(ResearchRun.gate_report_trace_id) == '',
                        ),
                        ResearchRun.recommendation_trace_id.is_(None),
                        and_(
                            ResearchRun.recommendation_trace_id.is_not(None),
                            func.btrim(ResearchRun.recommendation_trace_id) == '',
                        ),
                    ),
                )
            )
        ).scalar_one()

        non_skipped_runs = session.execute(
            select(func.count(ResearchRun.id)).where(
                and_(
                    ResearchRun.created_at >= lookback_start,
                    ResearchRun.status != 'skipped',
                )
            )
        ).scalar_one()

        trade_decisions = session.execute(
            select(func.count(TradeDecision.id)).where(
                TradeDecision.created_at >= lookback_start
            )
        ).scalar_one()
        advisor_coverage = session.execute(
            select(
                func.count(TradeDecision.id).filter(
                    func.jsonb_typeof(
                        TradeDecision.decision_json['params']['microstructure_state']
                    ) == 'object'
                ),
                func.count(TradeDecision.id).filter(
                    and_(
                        func.jsonb_typeof(
                            TradeDecision.decision_json['params']['microstructure_state']
                        ) == 'object',
                        func.jsonb_typeof(
                            TradeDecision.decision_json['params']['execution_advisor']
                        ) == 'object',
                    )
                ),
            ).where(TradeDecision.created_at >= lookback_start)
        ).one()
        advisor_eligible_rows = int(advisor_coverage[0] or 0)
        advisor_payload_rows = int(advisor_coverage[1] or 0)

        executions = session.execute(
            select(func.count(Execution.id)).where(Execution.created_at >= lookback_start)
        ).scalar_one()

        full_chain_runs = session.execute(
            select(func.count(func.distinct(ResearchRun.run_id)))
            .select_from(ResearchRun)
            .join(ResearchCandidate, ResearchCandidate.run_id == ResearchRun.run_id)
            .join(
                ResearchFoldMetrics,
                ResearchFoldMetrics.candidate_id == ResearchCandidate.candidate_id,
            )
            .join(
                ResearchStressMetrics,
                ResearchStressMetrics.candidate_id == ResearchCandidate.candidate_id,
            )
            .join(
                ResearchPromotion,
                ResearchPromotion.candidate_id == ResearchCandidate.candidate_id,
            )
            .where(
                and_(
                    ResearchRun.created_at >= lookback_start,
                    ResearchRun.status != 'skipped',
                )
            )
        ).scalar_one()

    checks: dict[str, Any] = {
        'acceptance_window': _evaluate_acceptance_window(
            non_skipped_runs=int(non_skipped_runs),
            trade_decisions=int(trade_decisions),
            executions=int(executions),
            full_chain_runs=int(full_chain_runs),
            route_total=int(total_route_count),
            missing_route_rows=int(missing_route_count),
            route_fallback_rows=int(fallback_route_count),
            advisor_eligible_rows=advisor_eligible_rows,
            advisor_payload_rows=advisor_payload_rows,
            min_non_skipped_runs=max(1, int(args.min_non_skipped_runs)),
            min_trade_decisions=max(1, int(args.min_trade_decisions)),
            min_executions=max(1, int(args.min_executions)),
            min_full_chain_runs=max(1, int(args.min_full_chain_runs)),
            min_route_coverage_ratio=max(0.0, float(args.min_route_coverage_ratio)),
            max_route_fallback_ratio=max(0.0, float(args.max_route_fallback_ratio)),
            min_execution_advisor_coverage_ratio=max(
                0.0,
                float(args.min_execution_advisor_coverage_ratio),
            ),
        ),
        'execution_route_provenance': {
            'missing_rows': int(missing_route_count),
            'threshold': args.max_missing_provenance,
            'passed': int(missing_route_count) <= args.max_missing_provenance,
        },
        'execution_route_fallback_ratio': {
            'fallback_rows': int(fallback_route_count),
            'route_total': int(total_route_count),
            'ratio': (
                round(int(fallback_route_count) / int(total_route_count), 6)
                if int(total_route_count) > 0
                else 0.0
            ),
            'threshold': max(0.0, float(args.max_route_fallback_ratio)),
            'passed': (
                (int(fallback_route_count) / int(total_route_count))
                <= max(0.0, float(args.max_route_fallback_ratio))
                if int(total_route_count) > 0
                else True
            ),
        },
        'execution_advisor_provenance': {
            'microstructure_rows': advisor_eligible_rows,
            'execution_advisor_rows': advisor_payload_rows,
            'coverage_ratio': (
                round(advisor_payload_rows / advisor_eligible_rows, 6)
                if advisor_eligible_rows > 0
                else 1.0
            ),
            'threshold': max(0.0, float(args.min_execution_advisor_coverage_ratio)),
            'passed': (
                (advisor_payload_rows / advisor_eligible_rows)
                >= max(0.0, float(args.min_execution_advisor_coverage_ratio))
                if advisor_eligible_rows > 0
                else True
            ),
        },
        'execution_fallback_reason': {
            'missing_rows': int(invalid_fallback_reason_count),
            'threshold': args.max_invalid_fallback_reason,
            'passed': int(invalid_fallback_reason_count) <= args.max_invalid_fallback_reason,
        },
        'research_trace_provenance': {
            'missing_rows': int(missing_research_trace_count),
            'threshold': args.max_missing_research_traces,
            'passed': int(missing_research_trace_count) <= args.max_missing_research_traces,
        },
    }

    if args.gate_report:
        checks['governance_trace'] = {
            'artifact': str(args.gate_report),
            'passed': False,
        }
        trace_payload = _load_gate_trace(args.gate_report)
        checks['governance_trace'] = {
            'artifact': str(args.gate_report),
            'gate_report_trace_id': trace_payload['gate_report_trace_id'],
            'recommendation_trace_id': trace_payload['recommendation_trace_id'],
            'passed': True,
        }

    if args.incident_evidence:
        checks['rollback_incident_evidence'] = {
            'artifact': str(args.incident_evidence),
            'passed': False,
        }
        incident_payload = _load_incident_evidence(args.incident_evidence)
        checks['rollback_incident_evidence'] = {
            'artifact': str(args.incident_evidence),
            'triggered_at': incident_payload.get('triggered_at'),
            'reason_count': len(cast(list[Any], incident_payload.get('reasons', []))),
            'passed': True,
        }

    if args.profitability_proof:
        checks['profitability_evidence'] = {
            'artifact': str(args.profitability_proof),
            'passed': False,
        }
        proof_payload = _load_profitability_proof(args.profitability_proof)
        checks['profitability_evidence'] = {
            'artifact': str(args.profitability_proof),
            'hypothesis': proof_payload.get('hypothesis'),
            'sample_size': proof_payload.get('sample_size'),
            'window_days': proof_payload.get('window_days'),
            'effect_size': proof_payload.get('effect_size'),
            'p_value': proof_payload.get('p_value'),
            'drawdown_delta': proof_payload.get('drawdown_delta'),
            'passed': True,
        }

    if args.control_plane_contract:
        checks['control_plane_contract'] = {
            'artifact': str(args.control_plane_contract),
            'passed': False,
        }
        contract_payload = _load_control_plane_contract(args.control_plane_contract)
        checks['control_plane_contract'] = {
            'artifact': str(args.control_plane_contract),
            'contract_version': contract_payload.get('contract_version'),
            'last_autonomy_recommendation_trace_id': contract_payload.get(
                'last_autonomy_recommendation_trace_id'
            ),
            'domain_telemetry_event_total': contract_payload.get(
                'domain_telemetry_event_total'
            ),
            'domain_telemetry_dropped_total': contract_payload.get(
                'domain_telemetry_dropped_total'
            ),
            'passed': True,
        }

    if args.model_risk_evidence_package:
        checks['model_risk_evidence_package'] = {
            'artifact': str(args.model_risk_evidence_package),
            'passed': False,
        }
        package_payload = _load_model_risk_evidence_package(
            args.model_risk_evidence_package,
            now=now,
            max_age_hours=max(1, int(args.max_model_risk_evidence_age_hours)),
        )
        checks['model_risk_evidence_package'] = {
            'artifact': str(args.model_risk_evidence_package),
            **package_payload,
            'passed': True,
        }

    all_passed = all(bool(item.get('passed')) for item in checks.values())
    payload = {
        'ok': all_passed,
        'evaluated_at': now.isoformat(),
        'lookback_start': lookback_start.isoformat(),
        'lookback_hours': lookback_hours,
        'checks': checks,
    }
    print(json.dumps(payload, indent=2))
    if not all_passed:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
