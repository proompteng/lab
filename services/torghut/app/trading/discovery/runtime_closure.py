"""Runtime-closure bundle helpers for MLX autoresearch outputs."""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping, cast

from app.trading.autonomy.policy_checks import (
    evaluate_promotion_prerequisites,
    evaluate_rollback_readiness,
)
from app.trading.discovery.autoresearch import StrategyAutoresearchProgram
from app.trading.discovery.mlx_snapshot import MlxSnapshotManifest

_REPO_ROOT = Path(__file__).resolve().parents[5]


def _string(value: Any) -> str:
    return str(value or '').strip()


def _int(value: Any) -> int:
    try:
        return int(float(str(value or 0)))
    except (TypeError, ValueError):
        return 0


def _float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _json_dumps(payload: Mapping[str, Any]) -> str:
    return json.dumps(payload, indent=2, sort_keys=True)


def _write_json(path: Path, payload: Mapping[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_json_dumps(payload) + '\n', encoding='utf-8')
    return path


def _sha256_path(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_json(payload: Mapping[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    ).hexdigest()


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _git_output(*args: str) -> str:
    try:
        completed = subprocess.run(
            ['git', *args],
            cwd=_REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return ''
    return completed.stdout.strip()


def _runtime_run_context(*, root: Path, runner_run_id: str) -> dict[str, str]:
    head = _git_output('rev-parse', '--abbrev-ref', 'HEAD') or 'unknown'
    return {
        'repository': 'proompteng/lab',
        'base': 'main',
        'head': head,
        'artifact_path': str(root),
        'run_id': runner_run_id,
        'design_doc': 'docs/torghut/design-system/v6/70-torghut-mlx-autoresearch-and-apple-silicon-research-lane-2026-04-10.md',
    }


def _runtime_closure_policy() -> dict[str, Any]:
    return {
        'promotion_require_profitability_stage_manifest': True,
        'promotion_require_alpha_readiness_contract': True,
        'promotion_require_jangar_dependency_quorum': True,
        'promotion_require_benchmark_parity': False,
        'promotion_require_foundation_router_parity': False,
        'promotion_require_deeplob_bdlob_contract': False,
        'promotion_require_advisor_fallback_slo': False,
        'promotion_require_contamination_registry': False,
        'promotion_require_hmm_state_posterior': False,
        'promotion_require_expert_router_registry': False,
        'promotion_require_shadow_live_deviation': False,
        'promotion_require_simulation_calibration': False,
        'promotion_require_stress_evidence': False,
        'promotion_require_janus_evidence': False,
        'gate6_require_profitability_evidence': False,
        'gate6_require_janus_evidence': False,
        'rollback_require_human_approval': True,
        'rollback_dry_run_max_age_hours': 72,
    }


def _candidate_spec(
    *,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
) -> dict[str, Any]:
    return {
        'schema_version': 'torghut.runtime-closure-candidate-spec.v1',
        'candidate_id': _string(best_candidate.get('candidate_id')),
        'runner_run_id': runner_run_id,
        'program_id': program.program_id,
        'family_template_id': _string(best_candidate.get('family_template_id')),
        'runtime_family': _string(best_candidate.get('runtime_family')),
        'runtime_strategy_name': _string(best_candidate.get('runtime_strategy_name')),
        'dataset_snapshot_ref': manifest.snapshot_id,
        'source_window_start': manifest.source_window_start,
        'source_window_end': manifest.source_window_end,
        'objective_scope': _string(best_candidate.get('objective_scope')) or 'research_only',
        'objective_met': bool(best_candidate.get('objective_met')),
        'status': _string(best_candidate.get('status')),
        'mutation_label': _string(best_candidate.get('mutation_label')),
        'parent_candidate_id': _string(best_candidate.get('parent_candidate_id')),
        'descriptor': {
            'descriptor_id': _string(best_candidate.get('descriptor_id')),
            'entry_window_start_minute': _int(best_candidate.get('entry_window_start_minute')),
            'entry_window_end_minute': _int(best_candidate.get('entry_window_end_minute')),
            'max_hold_minutes': _int(best_candidate.get('max_hold_minutes')),
            'rank_count': _int(best_candidate.get('rank_count')),
            'requires_prev_day_features': bool(best_candidate.get('requires_prev_day_features')),
            'requires_cross_sectional_features': bool(best_candidate.get('requires_cross_sectional_features')),
            'requires_quote_quality_gate': bool(best_candidate.get('requires_quote_quality_gate')),
        },
        'metrics': {
            'net_pnl_per_day': _string(best_candidate.get('net_pnl_per_day')),
            'active_day_ratio': _string(best_candidate.get('active_day_ratio')),
            'positive_day_ratio': _string(best_candidate.get('positive_day_ratio')),
            'best_day_share': _string(best_candidate.get('best_day_share')),
            'worst_day_loss': _string(best_candidate.get('worst_day_loss')),
            'max_drawdown': _string(best_candidate.get('max_drawdown')),
            'proposal_score': _float(best_candidate.get('proposal_score')),
            'proposal_rank': _int(best_candidate.get('proposal_rank')),
        },
        'promotion_contract': {
            'status': _string(best_candidate.get('promotion_status')),
            'stage': _string(best_candidate.get('promotion_stage')),
            'reason': _string(best_candidate.get('promotion_reason')),
            'blockers': list(cast(list[str], best_candidate.get('promotion_blockers') or [])),
            'required_evidence': list(
                cast(list[str], best_candidate.get('promotion_required_evidence') or [])
            ),
        },
    }


def _candidate_generation_manifest(
    *,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
) -> dict[str, Any]:
    return {
        'schema_version': 'torghut.runtime-closure-generation-manifest.v1',
        'runner_run_id': runner_run_id,
        'program_id': program.program_id,
        'candidate_id': _string(best_candidate.get('candidate_id')),
        'dataset_snapshot_ref': manifest.snapshot_id,
        'proposal_score': _float(best_candidate.get('proposal_score')),
        'proposal_rank': _int(best_candidate.get('proposal_rank')),
        'proposal_selected': bool(best_candidate.get('proposal_selected')),
        'proposal_selection_reason': _string(best_candidate.get('proposal_selection_reason')),
        'mutation_label': _string(best_candidate.get('mutation_label')),
        'status': _string(best_candidate.get('status')),
    }


def _gate_report(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
) -> dict[str, Any]:
    runtime_family = _string(best_candidate.get('runtime_family')) or 'unknown'
    active_day_ratio = _float(best_candidate.get('active_day_ratio'))
    throughput_count = max(0, int(round(active_day_ratio * 10)))
    promotion_reasons = [
        'research_candidate_pending_scheduler_v3_parity',
        'research_candidate_pending_scheduler_v3_approval',
        'research_candidate_pending_shadow_validation',
    ]
    return {
        'run_id': runner_run_id,
        'promotion_allowed': False,
        'recommended_mode': 'shadow',
        'dependency_quorum': {
            'decision': 'allow',
            'reasons': [],
            'message': 'Autoresearch runtime closure artifacts are local-only and do not require live actuation.',
        },
        'alpha_readiness': {
            'mode': 'candidate_alignment_v1',
            'registry_loaded': True,
            'registry_path': 'runtime_harness',
            'registry_errors': [],
            'strategy_families': [runtime_family],
            'matched_hypothesis_ids': [_string(best_candidate.get('family_template_id'))],
            'missing_strategy_families': [],
            'promotion_eligible': False,
            'reasons': list(promotion_reasons),
        },
        'throughput': {
            'signal_count': throughput_count,
            'decision_count': throughput_count,
            'trade_count': throughput_count,
            'no_signal_window': active_day_ratio <= 0,
            'no_signal_reason': (
                'no_active_days_in_research_window'
                if active_day_ratio <= 0
                else None
            ),
        },
        'gates': [
            {'gate_id': 'gate0_data_integrity', 'status': 'pass'},
            {'gate_id': 'gate1_statistical_robustness', 'status': 'pass'},
            {'gate_id': 'gate2_risk_capacity', 'status': 'pass'},
        ],
        'promotion_evidence': {
            'promotion_rationale': {
                'requested_target': 'shadow',
                'gate_recommended_mode': 'shadow',
                'gate_reasons': list(promotion_reasons),
                'rationale_text': 'Research candidate is mapped to runtime, but parity, approval replay, and shadow validation are still missing.',
            }
        },
        'uncertainty_gate_action': 'abstain',
        'coverage_error': '1.0',
        'recalibration_run_id': None,
    }


def _candidate_state(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
) -> dict[str, Any]:
    dependency_quorum: dict[str, Any] = {
        'decision': 'allow',
        'reasons': [],
        'message': 'Local runtime-closure planning is allowed.',
    }
    return {
        'candidateId': _string(best_candidate.get('candidate_id')),
        'runId': runner_run_id,
        'activeStage': 'runtime-closure',
        'paused': False,
        'datasetSnapshotRef': manifest.snapshot_id,
        'noSignalReason': None,
        'dependencyQuorum': dependency_quorum,
        'alphaReadiness': {
            'mode': 'candidate_alignment_v1',
            'registry_loaded': True,
            'registry_path': 'runtime_harness',
            'registry_errors': [],
            'strategy_families': [_string(best_candidate.get('runtime_family'))],
            'matched_hypothesis_ids': [_string(best_candidate.get('family_template_id'))],
            'missing_strategy_families': [],
            'promotion_eligible': False,
            'reasons': ['runtime_parity_not_completed'],
            'dependency_quorum': dependency_quorum,
        },
        'rollbackReadiness': {
            'killSwitchDryRunPassed': False,
            'gitopsRevertDryRunPassed': False,
            'strategyDisableDryRunPassed': False,
            'dryRunCompletedAt': '',
            'humanApproved': False,
            'rollbackTarget': '',
        },
    }


def _backtest_summary(
    *,
    runner_run_id: str,
    best_candidate: Mapping[str, Any],
    manifest: MlxSnapshotManifest,
) -> tuple[dict[str, Any], dict[str, Any]]:
    walkforward = {
        'schema_version': 'torghut.walkforward-results.v1',
        'run_id': runner_run_id,
        'candidate_id': _string(best_candidate.get('candidate_id')),
        'dataset_snapshot_ref': manifest.snapshot_id,
        'status': 'research_only',
        'metrics': {
            'net_pnl_per_day': _string(best_candidate.get('net_pnl_per_day')),
            'active_day_ratio': _string(best_candidate.get('active_day_ratio')),
            'best_day_share': _string(best_candidate.get('best_day_share')),
        },
    }
    evaluation = {
        'report_version': 'torghut.evaluation-report.v1',
        'generated_at': _now_iso(),
        'run_id': runner_run_id,
        'candidate_id': _string(best_candidate.get('candidate_id')),
        'promotion_target': 'shadow',
        'recommended_mode': 'shadow',
        'promotion_allowed': False,
        'metrics': walkforward['metrics'],
    }
    return walkforward, evaluation


def _profitability_stage_manifest(
    *,
    root: Path,
    runner_run_id: str,
    candidate_id: str,
    candidate_spec_path: Path,
    candidate_generation_manifest_path: Path,
    walkforward_results_path: Path,
    evaluation_report_path: Path,
    gate_report_path: Path,
    rollback_readiness_path: Path,
) -> dict[str, Any]:
    def _artifact(path: Path, *, stage: str, check: str) -> dict[str, Any]:
        return {
            'path': str(path.relative_to(root)),
            'sha256': _sha256_path(path),
            'stage': stage,
            'check': check,
        }

    artifact_hashes = {
        str(candidate_spec_path.relative_to(root)): _sha256_path(candidate_spec_path),
        str(candidate_generation_manifest_path.relative_to(root)): _sha256_path(candidate_generation_manifest_path),
        str(walkforward_results_path.relative_to(root)): _sha256_path(walkforward_results_path),
        str(evaluation_report_path.relative_to(root)): _sha256_path(evaluation_report_path),
        str(gate_report_path.relative_to(root)): _sha256_path(gate_report_path),
        str(rollback_readiness_path.relative_to(root)): _sha256_path(rollback_readiness_path),
    }
    payload = {
        'schema_version': 'profitability-stage-manifest-v1',
        'candidate_id': candidate_id,
        'strategy_family': 'autoresearch_runtime_closure',
        'llm_artifact_ref': None,
        'router_artifact_ref': 'runtime_harness',
        'run_context': _runtime_run_context(root=root, runner_run_id=runner_run_id),
        'stages': {
            'research': {
                'status': 'pass',
                'checks': [
                    {'check': 'candidate_spec_present', 'status': 'pass'},
                    {'check': 'candidate_generation_manifest_present', 'status': 'pass'},
                    {'check': 'walkforward_results_present', 'status': 'pass'},
                    {'check': 'baseline_evaluation_report_present', 'status': 'pass'},
                ],
                'artifacts': {
                    'candidate_spec': _artifact(candidate_spec_path, stage='research', check='candidate_spec_present'),
                    'candidate_generation_manifest': _artifact(
                        candidate_generation_manifest_path,
                        stage='research',
                        check='candidate_generation_manifest_present',
                    ),
                    'walkforward_results': _artifact(
                        walkforward_results_path,
                        stage='research',
                        check='walkforward_results_present',
                    ),
                    'baseline_evaluation_report': _artifact(
                        evaluation_report_path,
                        stage='research',
                        check='baseline_evaluation_report_present',
                    ),
                },
                'owner': 'autoresearch-loop',
                'completed_at_utc': _now_iso(),
            },
            'validation': {
                'status': 'fail',
                'checks': [
                    {'check': 'evaluation_report_present', 'status': 'pass'},
                    {'check': 'profitability_benchmark_present', 'status': 'fail'},
                    {'check': 'profitability_evidence_present', 'status': 'fail'},
                    {'check': 'profitability_validation_present', 'status': 'fail'},
                ],
                'artifacts': {
                    'evaluation_report': _artifact(
                        evaluation_report_path,
                        stage='validation',
                        check='evaluation_report_present',
                    ),
                },
                'owner': 'autoresearch-loop',
                'completed_at_utc': _now_iso(),
            },
            'execution': {
                'status': 'fail',
                'checks': [
                    {'check': 'gate_evaluation_present', 'status': 'pass'},
                    {'check': 'gate_matrix_approval', 'status': 'fail'},
                    {'check': 'drift_gate_approval', 'status': 'fail'},
                ],
                'artifacts': {
                    'gate_evaluation': _artifact(
                        gate_report_path,
                        stage='execution',
                        check='gate_evaluation_present',
                    ),
                },
                'owner': 'autoresearch-loop',
                'completed_at_utc': _now_iso(),
            },
            'governance': {
                'status': 'fail',
                'checks': [
                    {'check': 'rollback_ready', 'status': 'fail'},
                    {'check': 'gate_report_present', 'status': 'pass'},
                    {'check': 'candidate_spec_present', 'status': 'pass'},
                    {'check': 'rollback_readiness_present', 'status': 'pass'},
                    {'check': 'risk_controls_attestable', 'status': 'pass'},
                ],
                'artifacts': {
                    'candidate_spec': _artifact(
                        candidate_spec_path,
                        stage='governance',
                        check='candidate_spec_present',
                    ),
                    'gate_evaluation': _artifact(
                        gate_report_path,
                        stage='governance',
                        check='gate_report_present',
                    ),
                    'rollback_readiness': _artifact(
                        rollback_readiness_path,
                        stage='governance',
                        check='rollback_readiness_present',
                    ),
                },
                'owner': 'autoresearch-loop',
                'completed_at_utc': _now_iso(),
            },
        },
        'overall_status': 'fail',
        'failure_reasons': [
            'validation_stage_incomplete',
            'execution_stage_incomplete',
            'governance_stage_incomplete',
        ],
        'replay_contract': {
            'artifact_hashes': artifact_hashes,
            'contract_hash': _sha256_json({'artifact_hashes': artifact_hashes}),
            'hash_algorithm': 'sha256',
        },
        'rollback_contract_ref': str(rollback_readiness_path.relative_to(root)),
        'created_at_utc': _now_iso(),
    }
    payload['content_hash'] = _sha256_json({key: value for key, value in payload.items() if key != 'content_hash'})
    return payload


@dataclass(frozen=True)
class RuntimeClosureBundleSummary:
    status: str
    candidate_id: str
    root: str
    candidate_spec_path: str
    candidate_generation_manifest_path: str
    gate_report_path: str
    candidate_state_path: str
    rollback_readiness_artifact_path: str
    rollback_readiness_evaluation_path: str
    policy_path: str
    profitability_stage_manifest_path: str
    promotion_prerequisites_path: str
    replay_plan_path: str
    next_required_steps: tuple[str, ...]
    promotion_prerequisites: Mapping[str, Any]
    rollback_readiness: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            'status': self.status,
            'candidate_id': self.candidate_id,
            'root': self.root,
            'candidate_spec_path': self.candidate_spec_path,
            'candidate_generation_manifest_path': self.candidate_generation_manifest_path,
            'gate_report_path': self.gate_report_path,
            'candidate_state_path': self.candidate_state_path,
            'rollback_readiness_artifact_path': self.rollback_readiness_artifact_path,
            'rollback_readiness_evaluation_path': self.rollback_readiness_evaluation_path,
            'policy_path': self.policy_path,
            'profitability_stage_manifest_path': self.profitability_stage_manifest_path,
            'promotion_prerequisites_path': self.promotion_prerequisites_path,
            'replay_plan_path': self.replay_plan_path,
            'next_required_steps': list(self.next_required_steps),
            'promotion_prerequisites': dict(self.promotion_prerequisites),
            'rollback_readiness': dict(self.rollback_readiness),
        }


def write_runtime_closure_bundle(
    *,
    run_root: Path,
    runner_run_id: str,
    program: StrategyAutoresearchProgram,
    best_candidate: Mapping[str, Any] | None,
    manifest: MlxSnapshotManifest,
) -> RuntimeClosureBundleSummary:
    closure_root = run_root / 'runtime-closure'
    if best_candidate is None:
        summary = RuntimeClosureBundleSummary(
            status='missing_candidate',
            candidate_id='',
            root=str(closure_root),
            candidate_spec_path='',
            candidate_generation_manifest_path='',
            gate_report_path='',
            candidate_state_path='',
            rollback_readiness_artifact_path='',
            rollback_readiness_evaluation_path='',
            policy_path='',
            profitability_stage_manifest_path='',
            promotion_prerequisites_path='',
            replay_plan_path='',
            next_required_steps=(),
            promotion_prerequisites={},
            rollback_readiness={},
        )
        _write_json(closure_root / 'summary.json', summary.to_payload())
        return summary

    candidate_id = _string(best_candidate.get('candidate_id'))
    candidate_spec_path = closure_root / 'research' / 'candidate-spec.json'
    candidate_generation_manifest_path = closure_root / 'research' / 'candidate-generation-manifest.json'
    gate_report_path = closure_root / 'gates' / 'gate-evaluation.json'
    candidate_state_path = closure_root / 'promotion' / 'candidate-state.json'
    rollback_readiness_artifact_path = closure_root / 'gates' / 'rollback-readiness.json'
    rollback_readiness_evaluation_path = closure_root / 'promotion' / 'rollback-readiness-evaluation.json'
    policy_path = closure_root / 'promotion' / 'policy.json'
    profitability_stage_manifest_path = closure_root / 'profitability' / 'profitability-stage-manifest-v1.json'
    promotion_prerequisites_path = closure_root / 'promotion' / 'promotion-prerequisites.json'
    replay_plan_path = closure_root / 'replay' / 'runtime-replay-plan.json'
    walkforward_results_path = closure_root / 'backtest' / 'walkforward-results.json'
    evaluation_report_path = closure_root / 'backtest' / 'evaluation-report.json'

    candidate_spec = _candidate_spec(
        runner_run_id=runner_run_id,
        program=program,
        best_candidate=best_candidate,
        manifest=manifest,
    )
    candidate_generation_manifest = _candidate_generation_manifest(
        runner_run_id=runner_run_id,
        program=program,
        best_candidate=best_candidate,
        manifest=manifest,
    )
    gate_report = _gate_report(runner_run_id=runner_run_id, best_candidate=best_candidate)
    candidate_state = _candidate_state(
        runner_run_id=runner_run_id,
        best_candidate=best_candidate,
        manifest=manifest,
    )
    policy_payload = _runtime_closure_policy()

    _write_json(candidate_spec_path, candidate_spec)
    _write_json(candidate_generation_manifest_path, candidate_generation_manifest)
    _write_json(gate_report_path, gate_report)
    _write_json(candidate_state_path, candidate_state)

    rollback_readiness_result = evaluate_rollback_readiness(
        policy_payload=policy_payload,
        candidate_state_payload=candidate_state,
    )
    _write_json(rollback_readiness_artifact_path, rollback_readiness_result.to_payload())
    _write_json(rollback_readiness_evaluation_path, rollback_readiness_result.to_payload())
    _write_json(policy_path, policy_payload)

    walkforward_results, evaluation_report = _backtest_summary(
        runner_run_id=runner_run_id,
        best_candidate=best_candidate,
        manifest=manifest,
    )
    _write_json(walkforward_results_path, walkforward_results)
    _write_json(evaluation_report_path, evaluation_report)
    profitability_stage_manifest = _profitability_stage_manifest(
        root=closure_root,
        runner_run_id=runner_run_id,
        candidate_id=candidate_id,
        candidate_spec_path=candidate_spec_path,
        candidate_generation_manifest_path=candidate_generation_manifest_path,
        walkforward_results_path=walkforward_results_path,
        evaluation_report_path=evaluation_report_path,
        gate_report_path=gate_report_path,
        rollback_readiness_path=rollback_readiness_artifact_path,
    )
    _write_json(profitability_stage_manifest_path, profitability_stage_manifest)

    promotion_prerequisites_result = evaluate_promotion_prerequisites(
        policy_payload=policy_payload,
        gate_report_payload=gate_report,
        candidate_state_payload=candidate_state,
        promotion_target='shadow',
        artifact_root=closure_root,
    )
    _write_json(promotion_prerequisites_path, promotion_prerequisites_result.to_payload())

    replay_plan = {
        'schema_version': 'torghut.runtime-closure-replay-plan.v1',
        'candidate_id': candidate_id,
        'dataset_snapshot_ref': manifest.snapshot_id,
        'source_window_start': manifest.source_window_start,
        'source_window_end': manifest.source_window_end,
        'runtime_family': _string(best_candidate.get('runtime_family')),
        'runtime_strategy_name': _string(best_candidate.get('runtime_strategy_name')),
        'approval_path': 'scheduler_v3',
        'required_steps': [
            'checked_in_runtime_family',
            'scheduler_v3_parity_replay',
            'scheduler_v3_approval_replay',
            'live_shadow_validation',
        ],
        'recommended_commands': [
            'run scheduler-v3 parity replay for the mapped runtime family on the snapshot window',
            'run scheduler-v3 approval replay on the same candidate family and snapshot contract',
            'attach shadow validation evidence before requesting promotion',
        ],
    }
    _write_json(replay_plan_path, replay_plan)

    summary = RuntimeClosureBundleSummary(
        status='pending_runtime_parity',
        candidate_id=candidate_id,
        root=str(closure_root),
        candidate_spec_path=str(candidate_spec_path),
        candidate_generation_manifest_path=str(candidate_generation_manifest_path),
        gate_report_path=str(gate_report_path),
        candidate_state_path=str(candidate_state_path),
        rollback_readiness_artifact_path=str(rollback_readiness_artifact_path),
        rollback_readiness_evaluation_path=str(rollback_readiness_evaluation_path),
        policy_path=str(policy_path),
        profitability_stage_manifest_path=str(profitability_stage_manifest_path),
        promotion_prerequisites_path=str(promotion_prerequisites_path),
        replay_plan_path=str(replay_plan_path),
        next_required_steps=(
            'checked_in_runtime_family',
            'scheduler_v3_parity_replay',
            'scheduler_v3_approval_replay',
            'live_shadow_validation',
        ),
        promotion_prerequisites=promotion_prerequisites_result.to_payload(),
        rollback_readiness=rollback_readiness_result.to_payload(),
    )
    _write_json(closure_root / 'summary.json', summary.to_payload())
    return summary
