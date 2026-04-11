#!/usr/bin/env python3
"""Run an autoresearch-style outer loop for Torghut strategy discovery."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, cast

import yaml

from app.trading.discovery.autoresearch import (
    FamilyAutoresearchPlan,
    ProposalModelPolicy,
    StrategyAutoresearchProgram,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_meets_objective,
    load_strategy_autoresearch_program,
    run_id,
    stable_payload_hash,
)
from app.trading.discovery.autoresearch_notebooks import write_autoresearch_notebooks
from app.trading.discovery.family_templates import family_template_dir
from app.trading.discovery.mlx_features import (
    MlxCandidateDescriptor,
    descriptor_from_candidate_payload,
    descriptor_from_sweep_config,
)
from app.trading.discovery.mlx_notebook_exports import write_mlx_notebook_exports
from app.trading.discovery.mlx_proposal_models import (
    ProposalDiagnostics,
    ProposalScore,
    ProposalSelectionEntry,
    build_proposal_diagnostics,
    rank_candidate_descriptors,
    select_proposal_batch,
)
from app.trading.discovery.mlx_snapshot import (
    MlxSignalBundleStats,
    MlxSnapshotManifest,
    build_mlx_snapshot_manifest,
    write_mlx_signal_bundle,
    write_mlx_snapshot_manifest,
)
from app.trading.discovery.promotion_contract import (
    blocked_research_candidate_promotion_readiness,
    summary_promotion_readiness,
)
from app.trading.discovery.runtime_closure import write_runtime_closure_bundle
from app.trading.discovery.runtime_closure import RuntimeClosureExecutionContext
import scripts.local_intraday_tsmom_replay as replay_mod
from scripts.search_consistent_profitability_frontier import run_consistent_profitability_frontier

_REPO_ROOT = Path(__file__).resolve().parents[3]


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Run an autoresearch-style strategy discovery loop and emit notebooks.',
    )
    parser.add_argument(
        '--program',
        type=Path,
        required=True,
        help='Path to the strategy autoresearch program YAML.',
    )
    parser.add_argument(
        '--output-dir',
        type=Path,
        required=True,
        help='Directory that will receive a timestamped run folder.',
    )
    parser.add_argument(
        '--strategy-configmap',
        type=Path,
        default=_REPO_ROOT / 'argocd/applications/torghut/strategy-configmap.yaml',
    )
    parser.add_argument(
        '--family-template-dir',
        type=Path,
        default=family_template_dir(),
    )
    parser.add_argument(
        '--clickhouse-http-url',
        default='http://torghut-clickhouse.torghut.svc.cluster.local:8123',
    )
    parser.add_argument('--clickhouse-username', default='torghut')
    parser.add_argument('--clickhouse-password', default='')
    parser.add_argument('--start-equity', default='31590.02')
    parser.add_argument('--chunk-minutes', type=int, default=10)
    parser.add_argument('--symbols', default='')
    parser.add_argument('--progress-log-seconds', type=int, default=30)
    parser.add_argument(
        '--shadow-validation-artifact',
        type=Path,
        default=None,
        help='Optional path to an existing shadow-live-deviation-report-v1 artifact.',
    )
    parser.add_argument('--train-days', type=int, default=6)
    parser.add_argument('--holdout-days', type=int, default=3)
    parser.add_argument('--full-window-start-date', default='')
    parser.add_argument('--full-window-end-date', default='')
    parser.add_argument('--expected-last-trading-day', default='')
    parser.add_argument('--allow-stale-tape', action='store_true')
    parser.add_argument('--prefetch-full-window-rows', action='store_true')
    parser.add_argument(
        '--max-frontier-runs',
        type=int,
        default=0,
        help='Optional overall cap on frontier executions. 0 means use the family budgets only.',
    )
    parser.add_argument('--json-output', type=Path)
    return parser.parse_args()


@dataclass(frozen=True)
class WorkItem:
    family_plan: FamilyAutoresearchPlan
    iteration: int
    sweep_config: dict[str, Any]
    mutation_label: str
    parent_candidate_id: str | None


def _mapping(value: Any) -> dict[str, Any]:
    return {str(key): item for key, item in value.items()} if isinstance(value, Mapping) else {}


def _string(value: Any) -> str:
    return str(value or '').strip()


def _slug(value: str) -> str:
    normalized = ''.join(char if char.isalnum() else '-' for char in value.lower())
    return '-'.join(part for part in normalized.split('-') if part)


def _iter_symbols(value: Any) -> list[str]:
    if isinstance(value, str):
        normalized = value.strip().upper()
        return [normalized] if normalized else []
    if isinstance(value, (list, tuple)):
        resolved: list[str] = []
        for item in value:
            resolved.extend(_iter_symbols(item))
        return resolved
    return []


def _snapshot_symbols(*, args: argparse.Namespace, worklist: list[WorkItem]) -> tuple[str, ...]:
    cli_symbols = tuple(
        symbol.strip().upper()
        for symbol in str(args.symbols or '').split(',')
        if symbol.strip()
    )
    if cli_symbols:
        return cli_symbols
    ordered: list[str] = []
    seen: set[str] = set()
    for item in worklist:
        strategy_overrides = _mapping(item.sweep_config.get('strategy_overrides'))
        for symbol in _iter_symbols(strategy_overrides.get('universe_symbols')):
            if symbol in seen:
                continue
            seen.add(symbol)
            ordered.append(symbol)
    return tuple(ordered)


def _mlx_bundle_paths(run_root: Path) -> dict[str, str]:
    return {
        'signal_rows_jsonl': str(run_root / 'mlx-snapshot-signals.jsonl'),
        'descriptors_jsonl': str(run_root / 'mlx-candidate-descriptors.jsonl'),
        'proposal_scores_jsonl': str(run_root / 'mlx-proposal-scores.jsonl'),
        'history_jsonl': str(run_root / 'history.jsonl'),
        'results_tsv': str(run_root / 'results.tsv'),
    }


def _keep_candidate_limit(*, family_plan: FamilyAutoresearchPlan, replay_budget_max_candidates_per_round: int) -> int:
    if replay_budget_max_candidates_per_round <= 0:
        return max(1, family_plan.keep_top_candidates)
    return max(1, min(family_plan.keep_top_candidates, replay_budget_max_candidates_per_round))


def _frontier_candidate_budget(
    *,
    family_plan: FamilyAutoresearchPlan,
    replay_budget_max_candidates_per_frontier_run: int,
) -> int:
    if replay_budget_max_candidates_per_frontier_run <= 0:
        return 0
    minimum_budget = max(
        family_plan.frontier_top_n,
        family_plan.keep_top_candidates,
        family_plan.symbol_prune_candidates + 1,
    )
    return max(minimum_budget, replay_budget_max_candidates_per_frontier_run)


def _work_item_candidate_id(work_item: WorkItem) -> str:
    return _slug(
        f'{work_item.family_plan.family_template.family_id}-iter-{work_item.iteration}-{work_item.mutation_label}'
    )


def _promotion_readiness_payload(*, family_plan: FamilyAutoresearchPlan) -> dict[str, Any]:
    return blocked_research_candidate_promotion_readiness(
        candidate_id='',
        family_template_id=family_plan.family_template.family_id,
        runtime_harness=family_plan.family_template.runtime_harness,
    )


def _frontier_args(
    *,
    args: argparse.Namespace,
    program: StrategyAutoresearchProgram,
    family_plan: FamilyAutoresearchPlan,
    sweep_config_path: Path,
    json_output_path: Path,
) -> argparse.Namespace:
    top_n = max(family_plan.frontier_top_n, family_plan.keep_top_candidates)
    max_candidates_to_evaluate = _frontier_candidate_budget(
        family_plan=family_plan,
        replay_budget_max_candidates_per_frontier_run=int(program.replay_budget.max_candidates_per_frontier_run),
    )
    return argparse.Namespace(
        strategy_configmap=args.strategy_configmap.resolve(),
        sweep_config=sweep_config_path,
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=str(args.clickhouse_username),
        clickhouse_password=str(args.clickhouse_password),
        start_equity=str(args.start_equity),
        chunk_minutes=int(args.chunk_minutes),
        symbols=str(args.symbols),
        progress_log_seconds=int(args.progress_log_seconds),
        train_days=int(args.train_days),
        holdout_days=int(args.holdout_days),
        full_window_start_date=str(args.full_window_start_date),
        full_window_end_date=str(args.full_window_end_date),
        expected_last_trading_day=str(args.expected_last_trading_day),
        allow_stale_tape=bool(args.allow_stale_tape),
        family_template_dir=args.family_template_dir.resolve(),
        prefetch_full_window_rows=bool(args.prefetch_full_window_rows),
        top_n=top_n,
        max_candidates_to_evaluate=max_candidates_to_evaluate,
        json_output=json_output_path,
        symbol_prune_iterations=family_plan.symbol_prune_iterations,
        symbol_prune_candidates=family_plan.symbol_prune_candidates,
        symbol_prune_min_universe_size=family_plan.symbol_prune_min_universe_size,
    )


def _load_yaml(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise ValueError(f'sweep_config_not_mapping:{path}')
    return json.loads(json.dumps(payload))


def _default_full_window_day_count(args: argparse.Namespace) -> int | None:
    # Only stamp count-based full-window constraints when the full window is the same
    # exact window as train + holdout. If the caller widens the full window, ratios remain
    # safe but hard counts would become biased unless we resolve the real trading-day set.
    if _string(args.full_window_start_date) or _string(args.full_window_end_date):
        return None
    return max(1, int(args.train_days)) + max(1, int(args.holdout_days))


def _iso_date(value: str) -> date:
    return date.fromisoformat(value)


def _maybe_write_signal_bundle(
    *,
    args: argparse.Namespace,
    snapshot_symbols: tuple[str, ...],
    bundle_paths: Mapping[str, str],
    full_window_start_date: str,
    full_window_end_date: str,
    existing: MlxSignalBundleStats | None,
) -> MlxSignalBundleStats | None:
    if existing is not None:
        return existing
    if not full_window_start_date or not full_window_end_date or not snapshot_symbols:
        return existing
    signal_bundle_config = replay_mod.ReplayConfig(
        strategy_configmap_path=args.strategy_configmap.resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(str(args.clickhouse_username).strip() or None),
        clickhouse_password=(str(args.clickhouse_password).strip() or None),
        start_date=_iso_date(full_window_start_date),
        end_date=_iso_date(full_window_end_date),
        chunk_minutes=max(1, int(args.chunk_minutes)),
        flatten_eod=True,
        start_equity=Decimal(str(args.start_equity)),
        symbols=snapshot_symbols,
        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
    )
    return write_mlx_signal_bundle(
        Path(bundle_paths['signal_rows_jsonl']),
        replay_mod._iter_signal_rows(signal_bundle_config),
    )


def _history_record(
    *,
    runner_run_id: str,
    experiment_index: int,
    family_plan: FamilyAutoresearchPlan,
    iteration: int,
    mutation_label: str,
    parent_candidate_id: str | None,
    sweep_config_path: Path,
    result_path: Path,
    candidate_payload: Mapping[str, Any],
    rank: int,
    status: str,
    objective_met: bool,
    dataset_snapshot_id: str,
    descriptor: MlxCandidateDescriptor | None = None,
    proposal_score: ProposalScore | None = None,
    proposal_selected: bool = False,
    proposal_selection_reason: str = '',
    disable_other_strategies: bool = True,
) -> dict[str, Any]:
    full_window = _mapping(candidate_payload.get('full_window'))
    scorecard = _mapping(candidate_payload.get('objective_scorecard'))
    ranking = _mapping(candidate_payload.get('ranking'))
    replay_config = _mapping(candidate_payload.get('replay_config'))
    promotion_readiness = _promotion_readiness_payload(family_plan=family_plan)
    return {
        'runner_run_id': runner_run_id,
        'experiment_index': experiment_index,
        'iteration': iteration,
        'rank': rank,
        'family_template_id': family_plan.family_template.family_id,
        'candidate_id': _string(candidate_payload.get('candidate_id')),
        'parent_candidate_id': parent_candidate_id,
        'status': status,
        'objective_met': objective_met,
        'mutation_label': mutation_label,
        'dataset_snapshot_id': dataset_snapshot_id,
        'sweep_config_path': str(sweep_config_path),
        'result_path': str(result_path),
        'candidate_params': _mapping(replay_config.get('params')),
        'candidate_strategy_overrides': _mapping(replay_config.get('strategy_overrides')),
        'disable_other_strategies': disable_other_strategies,
        'train_start_date': _string(replay_config.get('train_start_date')),
        'train_end_date': _string(replay_config.get('train_end_date')),
        'holdout_start_date': _string(replay_config.get('holdout_start_date')),
        'holdout_end_date': _string(replay_config.get('holdout_end_date')),
        'full_window_start_date': _string(replay_config.get('full_window_start_date')),
        'full_window_end_date': _string(replay_config.get('full_window_end_date')),
        'normalization_regime': _string(candidate_payload.get('normalization_regime')),
        'net_pnl_per_day': _string(scorecard.get('net_pnl_per_day') or full_window.get('net_per_day')),
        'active_day_ratio': _string(scorecard.get('active_day_ratio')),
        'positive_day_ratio': _string(scorecard.get('positive_day_ratio')),
        'avg_filled_notional_per_day': _string(scorecard.get('avg_filled_notional_per_day')),
        'avg_filled_notional_per_active_day': _string(scorecard.get('avg_filled_notional_per_active_day')),
        'worst_day_loss': _string(scorecard.get('worst_day_loss')),
        'max_drawdown': _string(scorecard.get('max_drawdown')),
        'best_day_share': _string(scorecard.get('best_day_share')),
        'regime_slice_pass_rate': _string(scorecard.get('regime_slice_pass_rate')),
        'pareto_tier': int(ranking.get('pareto_tier') or 999),
        'tie_breaker_score': _string(ranking.get('tie_breaker_score')),
        'hard_vetoes': list(cast(list[str], candidate_payload.get('hard_vetoes') or [])),
        'daily_net': _mapping(full_window.get('daily_net')),
        'daily_filled_notional': _mapping(full_window.get('daily_filled_notional')),
        'pruned_symbol': _string(candidate_payload.get('pruned_symbol')),
        'objective_scope': 'research_only',
        'promotion_stage': promotion_readiness['stage'],
        'promotion_status': promotion_readiness['status'],
        'promotable': promotion_readiness['promotable'],
        'promotion_reason': promotion_readiness['reason'],
        'promotion_blockers': list(cast(list[str], promotion_readiness['blockers'])),
        'promotion_required_evidence': list(cast(list[str], promotion_readiness['required_evidence'])),
        'runtime_family': _string(_mapping(promotion_readiness['runtime_harness']).get('family')),
        'runtime_strategy_name': _string(_mapping(promotion_readiness['runtime_harness']).get('strategy_name')),
        'descriptor_id': _string(descriptor.descriptor_id) if descriptor is not None else '',
        'entry_window_start_minute': descriptor.entry_window_start_minute if descriptor is not None else 0,
        'entry_window_end_minute': descriptor.entry_window_end_minute if descriptor is not None else 0,
        'max_hold_minutes': descriptor.max_hold_minutes if descriptor is not None else 0,
        'rank_count': descriptor.rank_count if descriptor is not None else 0,
        'requires_prev_day_features': descriptor.requires_prev_day_features if descriptor is not None else False,
        'requires_cross_sectional_features': (
            descriptor.requires_cross_sectional_features if descriptor is not None else False
        ),
        'requires_quote_quality_gate': descriptor.requires_quote_quality_gate if descriptor is not None else False,
        'proposal_score': proposal_score.score if proposal_score is not None else 0.0,
        'proposal_rank': proposal_score.rank if proposal_score is not None else 0,
        'proposal_backend': _string(proposal_score.backend) if proposal_score is not None else '',
        'proposal_mode': _string(proposal_score.mode) if proposal_score is not None else '',
        'proposal_selected': proposal_selected,
        'proposal_selection_reason': proposal_selection_reason,
    }


def _write_history_jsonl(path: Path, history: list[dict[str, Any]]) -> None:
    lines = [json.dumps(item, sort_keys=True) for item in history]
    path.write_text('\n'.join(lines) + ('\n' if lines else ''), encoding='utf-8')


def _sanitize_tsv_field(value: Any) -> str:
    return str(value).replace('\t', ' ').replace('\n', ' ').strip()


def _write_results_tsv(path: Path, history: list[dict[str, Any]]) -> None:
    header = [
        'experiment',
        'iteration',
        'family_template_id',
        'candidate_id',
        'net_pnl_per_day',
        'active_day_ratio',
        'best_day_share',
        'max_drawdown',
        'status',
        'description',
    ]
    rows = ['\t'.join(header)]
    for item in history:
        rows.append(
            '\t'.join(
                [
                    _sanitize_tsv_field(item['experiment_index']),
                    _sanitize_tsv_field(item['iteration']),
                    _sanitize_tsv_field(item['family_template_id']),
                    _sanitize_tsv_field(item['candidate_id']),
                    _sanitize_tsv_field(item['net_pnl_per_day']),
                    _sanitize_tsv_field(item['active_day_ratio']),
                    _sanitize_tsv_field(item['best_day_share']),
                    _sanitize_tsv_field(item['max_drawdown']),
                    _sanitize_tsv_field(item['status']),
                    _sanitize_tsv_field(item['mutation_label']),
                ]
            )
        )
    path.write_text('\n'.join(rows) + '\n', encoding='utf-8')


def _best_history_record(history: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not history:
        return None
    sorted_history = sorted(
        history,
        key=lambda item: (
            item['status'] != 'keep',
            bool(item['hard_vetoes']),
            int(item['pareto_tier']),
            -float(item['net_pnl_per_day'] or '0'),
            -float(item['active_day_ratio'] or '0'),
        ),
    )
    return sorted_history[0]


def _proposal_diagnostics(
    *,
    descriptors: list[MlxCandidateDescriptor],
    proposal_scores: list[ProposalScore],
    history: list[dict[str, Any]],
) -> ProposalDiagnostics:
    selected_entries = [
        {
            'candidate_id': _string(item.get('candidate_id')),
            'descriptor_id': _string(item.get('descriptor_id')),
            'selection_reason': _string(item.get('proposal_selection_reason')) or 'exploitation',
            'score': float(item.get('proposal_score') or 0.0),
            'rank': int(item.get('proposal_rank') or 0),
            'family_template_id': _string(item.get('family_template_id')),
            'side_policy': 'unknown',
        }
        for item in history
        if bool(item.get('proposal_selected'))
    ]
    selected_by_candidate: dict[str, dict[str, Any]] = {}
    descriptor_by_candidate = {item.candidate_id: item for item in descriptors}
    for item in selected_entries:
        candidate_id = item['candidate_id']
        descriptor = descriptor_by_candidate.get(candidate_id)
        if descriptor is not None:
            item['side_policy'] = descriptor.side_policy
        selected_by_candidate[candidate_id] = item
    return build_proposal_diagnostics(
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        history_rows=history,
        selected_candidates=[
            ProposalSelectionEntry(
                candidate_id=item['candidate_id'],
                descriptor_id=item['descriptor_id'],
                selection_reason=item['selection_reason'],
                score=float(item['score']),
                rank=int(item['rank']),
                family_template_id=item['family_template_id'],
                side_policy=item['side_policy'],
            )
            for item in selected_by_candidate.values()
        ],
    )


def _experiment_snapshot_from_payload(
    *,
    payload: Mapping[str, Any],
    experiment: str,
    result_path: Path,
) -> dict[str, Any] | None:
    top_candidates = cast(list[dict[str, Any]], payload.get('top') or [])
    if not top_candidates:
        return None
    top_row = _mapping(top_candidates[0])
    scorecard = _mapping(top_row.get('objective_scorecard'))
    progress = _mapping(payload.get('progress'))
    return {
        'experiment': experiment,
        'path': str(result_path),
        'status': _string(payload.get('status')),
        'candidate_count': int(payload.get('candidate_count') or 0),
        'evaluated_candidates': int(progress.get('evaluated_candidates') or 0),
        'pending_candidates': int(progress.get('pending_candidates') or 0),
        'top_candidate_id': _string(top_row.get('candidate_id')),
        'top_net_pnl_per_day': _string(scorecard.get('net_pnl_per_day')),
        'top_active_day_ratio': _string(scorecard.get('active_day_ratio')),
        'top_best_day_share': _string(scorecard.get('best_day_share')),
        'top_hard_vetoes': list(cast(list[str], top_row.get('hard_vetoes') or [])),
    }


def _load_experiment_snapshots(run_root: Path) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    for result_path in sorted((run_root / 'experiments').glob('*/result.json')):
        try:
            payload = json.loads(result_path.read_text(encoding='utf-8'))
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        if not isinstance(payload, Mapping):
            continue
        snapshot = _experiment_snapshot_from_payload(
            payload=cast(Mapping[str, Any], payload),
            experiment=result_path.parent.name,
            result_path=result_path,
        )
        if snapshot is not None:
            snapshots.append(snapshot)
    return snapshots


def _best_experiment_snapshot(snapshots: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not snapshots:
        return None
    return max(
        snapshots,
        key=lambda item: (
            Decimal(_string(item.get('top_net_pnl_per_day')) or '0'),
            Decimal(_string(item.get('top_active_day_ratio')) or '0'),
            -Decimal(_string(item.get('top_best_day_share')) or '0'),
            -int(item.get('pending_candidates') or 0),
        ),
    )


def _live_progress_payload(
    *,
    run_root: Path,
    frontier_runs: int,
    worklist: list[WorkItem],
    history: list[dict[str, Any]],
    descriptors: list[MlxCandidateDescriptor],
    proposal_scores: list[ProposalScore],
    selected_for_replay: ProposalSelectionEntry | None = None,
    selected_descriptor: MlxCandidateDescriptor | None = None,
) -> dict[str, Any]:
    snapshots = _load_experiment_snapshots(run_root)
    payload: dict[str, Any] = {
        'frontier_runs_started': frontier_runs,
        'pending_work_items': len(worklist),
        'history_row_count': len(history),
        'descriptor_count': len(descriptors),
        'proposal_score_count': len(proposal_scores),
        'experiment_result_count': len(snapshots),
        'latest_experiment': snapshots[-1] if snapshots else None,
        'best_experiment_candidate': _best_experiment_snapshot(snapshots),
    }
    if selected_for_replay is not None:
        payload['selected_for_replay'] = {
            'candidate_id': selected_for_replay.candidate_id,
            'descriptor_id': selected_for_replay.descriptor_id,
            'selection_reason': selected_for_replay.selection_reason,
            'score': selected_for_replay.score,
            'rank': selected_for_replay.rank,
            'family_template_id': selected_for_replay.family_template_id,
            'side_policy': selected_for_replay.side_policy,
            'entry_window_start_minute': (
                selected_descriptor.entry_window_start_minute if selected_descriptor is not None else 0
            ),
            'entry_window_end_minute': (
                selected_descriptor.entry_window_end_minute if selected_descriptor is not None else 0
            ),
        }
    return payload


def _persist_run_outputs(
    *,
    run_root: Path,
    program: StrategyAutoresearchProgram,
    program_payload: Mapping[str, Any],
    runner_run_id: str,
    program_id: str,
    frontier_runs: int,
    objective_met: bool,
    history: list[dict[str, Any]],
    manifest: MlxSnapshotManifest,
    descriptors: list[MlxCandidateDescriptor],
    proposal_scores: list[ProposalScore],
    worklist: list[WorkItem],
    status: str,
    selected_for_replay: ProposalSelectionEntry | None = None,
    selected_descriptor: MlxCandidateDescriptor | None = None,
    closure_execution_context: RuntimeClosureExecutionContext | None = None,
    error: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    history_path = run_root / 'history.jsonl'
    results_tsv_path = run_root / 'results.tsv'
    research_dossier_path = run_root / 'research_dossier.json'
    summary_path = run_root / 'summary.json'
    promotion_readiness_path = run_root / 'promotion_readiness.json'
    snapshot_manifest_path = run_root / 'mlx-snapshot-manifest.json'
    _write_history_jsonl(history_path, history)
    _write_results_tsv(results_tsv_path, history)
    research_dossier_path.write_text(
        json.dumps(program_payload, indent=2, sort_keys=True),
        encoding='utf-8',
    )
    write_mlx_snapshot_manifest(snapshot_manifest_path, manifest)
    proposal_diagnostics = _proposal_diagnostics(
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        history=history,
    )
    mlx_exports = write_mlx_notebook_exports(
        run_root=run_root,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        proposal_diagnostics=proposal_diagnostics,
    )
    notebook_paths = write_autoresearch_notebooks(run_root)
    summary: dict[str, Any] = {
        'status': status,
        'runner_run_id': runner_run_id,
        'program_id': program_id,
        'run_root': str(run_root),
        'frontier_run_count': frontier_runs,
        'objective_met': objective_met,
        'objective_scope': 'research_only',
        'history_path': str(history_path),
        'results_tsv_path': str(results_tsv_path),
        'research_dossier_path': str(research_dossier_path),
        'promotion_readiness_path': str(promotion_readiness_path),
        'snapshot_manifest_path': str(snapshot_manifest_path),
        'mlx_exports': dict(mlx_exports),
        'notebooks': [str(path) for path in notebook_paths],
        'best_candidate': _best_history_record(history),
        'live_progress': _live_progress_payload(
            run_root=run_root,
            frontier_runs=frontier_runs,
            worklist=worklist,
            history=history,
            descriptors=descriptors,
            proposal_scores=proposal_scores,
            selected_for_replay=selected_for_replay,
            selected_descriptor=selected_descriptor,
        ),
    }
    best_candidate = cast(dict[str, Any] | None, summary['best_candidate'])
    summary['promotion_readiness'] = summary_promotion_readiness(best_candidate)
    runtime_closure = write_runtime_closure_bundle(
        run_root=run_root,
        runner_run_id=runner_run_id,
        program=program,
        best_candidate=best_candidate,
        manifest=manifest,
        execution_context=closure_execution_context,
    )
    summary['runtime_closure'] = runtime_closure.to_payload()
    if error is not None:
        summary['error'] = dict(error)
    promotion_readiness_path.write_text(
        json.dumps(summary['promotion_readiness'], indent=2, sort_keys=True),
        encoding='utf-8',
    )
    summary_path.write_text(
        json.dumps(summary, indent=2, sort_keys=True),
        encoding='utf-8',
    )
    return summary


def run_strategy_autoresearch_loop(args: argparse.Namespace) -> dict[str, Any]:
    program = load_strategy_autoresearch_program(
        args.program.resolve(),
        family_dir=args.family_template_dir.resolve(),
    )
    runner_run_id = run_id('strategy-autoresearch')
    run_root = (args.output_dir.resolve() / runner_run_id)
    run_root.mkdir(parents=True, exist_ok=True)
    (run_root / 'experiments').mkdir(parents=True, exist_ok=True)

    worklist: list[WorkItem] = []
    seen_sweeps: set[str] = set()
    for family_plan in program.families:
        seed_sweep = _load_yaml(family_plan.seed_sweep_config)
        seed_sweep = apply_program_objective(
            sweep_config=seed_sweep,
            objective=program.objective,
            train_day_count=max(1, int(args.train_days)),
            holdout_day_count=max(1, int(args.holdout_days)),
            full_window_day_count=_default_full_window_day_count(args),
        )
        worklist.append(
            WorkItem(
                family_plan=family_plan,
                iteration=1,
                sweep_config=seed_sweep,
                mutation_label='seed',
                parent_candidate_id=None,
            )
        )

    history: list[dict[str, Any]] = []
    descriptors: list[MlxCandidateDescriptor] = []
    proposal_scores: list[ProposalScore] = []
    tape_freshness_receipts: list[dict[str, Any]] = []
    snapshot_symbols = _snapshot_symbols(args=args, worklist=worklist)
    bundle_paths = _mlx_bundle_paths(run_root)
    resolved_full_window_start_date = _string(args.full_window_start_date)
    resolved_full_window_end_date = _string(args.full_window_end_date)
    signal_bundle_stats: MlxSignalBundleStats | None = None
    closure_execution_context = RuntimeClosureExecutionContext(
        strategy_configmap_path=args.strategy_configmap.resolve(),
        clickhouse_http_url=str(args.clickhouse_http_url),
        clickhouse_username=(_string(args.clickhouse_username) or None),
        clickhouse_password=(_string(args.clickhouse_password) or None),
        start_equity=Decimal(str(args.start_equity)),
        chunk_minutes=max(1, int(args.chunk_minutes)),
        symbols=snapshot_symbols,
        progress_log_interval_seconds=max(1, int(args.progress_log_seconds)),
        shadow_validation_artifact_path=(
            args.shadow_validation_artifact.resolve()
            if args.shadow_validation_artifact is not None
            else None
        ),
    )

    def _refresh_manifest() -> MlxSnapshotManifest:
        latest_receipt = tape_freshness_receipts[-1] if tape_freshness_receipts else {}
        return build_mlx_snapshot_manifest(
            runner_run_id=runner_run_id,
            program=program,
            symbols=','.join(snapshot_symbols),
            train_days=int(args.train_days),
            holdout_days=int(args.holdout_days),
            full_window_start_date=resolved_full_window_start_date,
            full_window_end_date=resolved_full_window_end_date,
            tape_freshness_receipts=tuple(tape_freshness_receipts),
            row_counts={
                'receipt_count': len(tape_freshness_receipts),
                'latest_receipt_row_count': int(latest_receipt.get('row_count') or 0),
                'signal_row_count': signal_bundle_stats.row_count if signal_bundle_stats is not None else 0,
                'signal_symbol_count': (
                    signal_bundle_stats.symbol_count if signal_bundle_stats is not None else len(snapshot_symbols)
                ),
            },
            tensor_bundle_paths=bundle_paths,
        )

    manifest = _refresh_manifest()
    frontier_runs = 0
    objective_met = False
    _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status='running',
        closure_execution_context=closure_execution_context,
    )
    signal_bundle_stats = _maybe_write_signal_bundle(
        args=args,
        snapshot_symbols=snapshot_symbols,
        bundle_paths=bundle_paths,
        full_window_start_date=resolved_full_window_start_date,
        full_window_end_date=resolved_full_window_end_date,
        existing=signal_bundle_stats,
    )
    manifest = _refresh_manifest()
    _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status='running',
        closure_execution_context=closure_execution_context,
    )
    try:
        while worklist:
            if int(args.max_frontier_runs) > 0 and frontier_runs >= int(args.max_frontier_runs):
                break
            pending_descriptors = [
                descriptor_from_sweep_config(
                    candidate_id=_work_item_candidate_id(item),
                    family_plan=item.family_plan,
                    sweep_config=item.sweep_config,
                )
                for item in worklist
            ]
            pending_scores = rank_candidate_descriptors(
                descriptors=pending_descriptors,
                history_rows=history,
                policy=cast(ProposalModelPolicy, program.proposal_model_policy),
            )
            proposal_scores.extend(pending_scores)
            score_by_candidate = {item.candidate_id: item for item in pending_scores}
            ordered_pending = sorted(
                zip(worklist, pending_descriptors, strict=False),
                key=lambda item: (
                    score_by_candidate[item[1].candidate_id].rank,
                    item[0].family_plan.family_template.family_id,
                ),
            )
            current, current_descriptor = ordered_pending[0]
            descriptors.append(current_descriptor)
            worklist = [item for item, _ in ordered_pending[1:]]
            sweep_hash = stable_payload_hash(current.sweep_config)
            if sweep_hash in seen_sweeps:
                continue
            seen_sweeps.add(sweep_hash)
            frontier_runs += 1
            experiment_index = frontier_runs
            experiment_slug = _slug(
                f'{experiment_index:03d}-{current.family_plan.family_template.family_id}-iter-{current.iteration}'
            )
            experiment_root = run_root / 'experiments' / experiment_slug
            experiment_root.mkdir(parents=True, exist_ok=True)
            sweep_config_path = experiment_root / 'sweep.yaml'
            sweep_config_path.write_text(
                yaml.safe_dump(current.sweep_config, sort_keys=False),
                encoding='utf-8',
            )
            result_path = experiment_root / 'result.json'
            selected_score = score_by_candidate.get(current_descriptor.candidate_id)
            selected_for_replay = (
                ProposalSelectionEntry(
                    candidate_id=current_descriptor.candidate_id,
                    descriptor_id=current_descriptor.descriptor_id,
                    selection_reason='frontier_seed',
                    score=selected_score.score,
                    rank=selected_score.rank,
                    family_template_id=current_descriptor.family_template_id,
                    side_policy=current_descriptor.side_policy,
                )
                if selected_score is not None
                else None
            )
            _persist_run_outputs(
                run_root=run_root,
                program=program,
                program_payload=program.to_payload(),
                runner_run_id=runner_run_id,
                program_id=program.program_id,
                frontier_runs=frontier_runs,
                objective_met=objective_met,
                history=history,
                manifest=manifest,
                descriptors=descriptors,
                proposal_scores=proposal_scores,
                worklist=worklist,
                status='running',
                selected_for_replay=selected_for_replay,
                selected_descriptor=current_descriptor,
                closure_execution_context=closure_execution_context,
            )
            frontier_payload = run_consistent_profitability_frontier(
                _frontier_args(
                    args=args,
                    program=program,
                    family_plan=current.family_plan,
                    sweep_config_path=sweep_config_path,
                    json_output_path=result_path,
                )
            )
            result_path.write_text(
                json.dumps(frontier_payload, indent=2, sort_keys=True),
                encoding='utf-8',
            )
            dataset_snapshot_id = _string(
                _mapping(frontier_payload.get('dataset_snapshot_receipt')).get('snapshot_id')
            )
            receipt_payload = _mapping(frontier_payload.get('dataset_snapshot_receipt'))
            if receipt_payload:
                tape_freshness_receipts.append(receipt_payload)
            frontier_window = _mapping(frontier_payload.get('window'))
            resolved_full_window_start_date = (
                _string(frontier_window.get('full_window_start_date')) or resolved_full_window_start_date
            )
            resolved_full_window_end_date = (
                _string(frontier_window.get('full_window_end_date')) or resolved_full_window_end_date
            )
            signal_bundle_stats = _maybe_write_signal_bundle(
                args=args,
                snapshot_symbols=snapshot_symbols,
                bundle_paths=bundle_paths,
                full_window_start_date=resolved_full_window_start_date,
                full_window_end_date=resolved_full_window_end_date,
                existing=signal_bundle_stats,
            )
            manifest = _refresh_manifest()
            top_candidates = cast(list[dict[str, Any]], frontier_payload.get('top') or [])
            keep_candidates = [
                candidate
                for candidate in top_candidates
                if not bool(_mapping(candidate.get('ranking')).get('vetoed'))
            ]
            frontier_descriptors = [
                descriptor_from_candidate_payload(
                    candidate_payload=candidate,
                    family_plan=current.family_plan,
                )
                for candidate in top_candidates
            ]
            descriptors.extend(frontier_descriptors)
            frontier_candidate_scores = rank_candidate_descriptors(
                descriptors=frontier_descriptors,
                history_rows=history,
                policy=cast(ProposalModelPolicy, program.proposal_model_policy),
            )
            proposal_scores.extend(frontier_candidate_scores)
            frontier_descriptor_by_candidate = {item.candidate_id: item for item in frontier_descriptors}
            frontier_score_by_candidate = {item.candidate_id: item for item in frontier_candidate_scores}
            keep_limit = _keep_candidate_limit(
                family_plan=current.family_plan,
                replay_budget_max_candidates_per_round=int(program.replay_budget.max_candidates_per_round),
            )
            non_vetoed_descriptors = [
                frontier_descriptor_by_candidate[_string(candidate.get('candidate_id'))]
                for candidate in keep_candidates
                if _string(candidate.get('candidate_id')) in frontier_descriptor_by_candidate
            ]
            non_vetoed_scores = [
                frontier_score_by_candidate[_string(candidate.get('candidate_id'))]
                for candidate in keep_candidates
                if _string(candidate.get('candidate_id')) in frontier_score_by_candidate
            ]
            exploration_slots = min(
                max(0, int(program.proposal_model_policy.exploration_slots)),
                max(0, int(program.replay_budget.exploration_slots)),
            )
            selected_keep_entries = select_proposal_batch(
                descriptors=non_vetoed_descriptors,
                proposal_scores=non_vetoed_scores,
                limit=keep_limit,
                top_k=max(1, int(program.proposal_model_policy.top_k)),
                exploration_slots=exploration_slots,
            )
            if not selected_keep_entries and current.family_plan.force_keep_top_candidate_if_all_vetoed and top_candidates:
                first_candidate = top_candidates[0]
                first_candidate_id = _string(first_candidate.get('candidate_id'))
                descriptor = frontier_descriptor_by_candidate.get(first_candidate_id)
                score = frontier_score_by_candidate.get(first_candidate_id)
                if descriptor is not None and score is not None:
                    selected_keep_entries = [
                        ProposalSelectionEntry(
                            candidate_id=first_candidate_id,
                            descriptor_id=descriptor.descriptor_id,
                            selection_reason='fallback_force_keep',
                            score=score.score,
                            rank=score.rank,
                            family_template_id=descriptor.family_template_id,
                            side_policy=descriptor.side_policy,
                        )
                    ]
            keep_ids = {item.candidate_id for item in selected_keep_entries}
            keep_reason_by_candidate = {item.candidate_id: item.selection_reason for item in selected_keep_entries}
            for rank, candidate in enumerate(top_candidates, start=1):
                candidate_id = _string(candidate.get('candidate_id'))
                candidate_status = 'keep' if candidate_id in keep_ids else 'discard'
                candidate_objective_met = candidate_meets_objective(candidate, objective=program.objective)
                candidate_descriptor = frontier_descriptor_by_candidate[candidate_id]
                history.append(
                    _history_record(
                        runner_run_id=runner_run_id,
                        experiment_index=experiment_index,
                        family_plan=current.family_plan,
                        iteration=current.iteration,
                        mutation_label=current.mutation_label,
                        parent_candidate_id=current.parent_candidate_id,
                        sweep_config_path=sweep_config_path,
                        result_path=result_path,
                        candidate_payload=candidate,
                        rank=rank,
                        status=candidate_status,
                        objective_met=candidate_objective_met,
                        dataset_snapshot_id=dataset_snapshot_id,
                        descriptor=candidate_descriptor,
                        proposal_score=frontier_score_by_candidate.get(candidate_id),
                        proposal_selected=candidate_id in keep_ids,
                        proposal_selection_reason=keep_reason_by_candidate.get(candidate_id, ''),
                        disable_other_strategies=bool(current.sweep_config.get('disable_other_strategies', True)),
                    )
                )
                if candidate_objective_met:
                    objective_met = True
                if candidate_status != 'keep':
                    continue
                if current.iteration >= current.family_plan.max_iterations:
                    continue
                next_sweep_config, mutation_label = build_mutated_sweep_config(
                    base_sweep_config=current.sweep_config,
                    candidate_payload=candidate,
                    family_plan=current.family_plan,
                )
                next_sweep_config = apply_program_objective(
                    sweep_config=next_sweep_config,
                    objective=program.objective,
                    train_day_count=max(1, int(args.train_days)),
                    holdout_day_count=max(1, int(args.holdout_days)),
                    full_window_day_count=_default_full_window_day_count(args),
                )
                worklist.append(
                    WorkItem(
                        family_plan=current.family_plan,
                        iteration=current.iteration + 1,
                        sweep_config=next_sweep_config,
                        mutation_label=mutation_label,
                        parent_candidate_id=candidate_id,
                    )
                )
            _persist_run_outputs(
                run_root=run_root,
                program=program,
                program_payload=program.to_payload(),
                runner_run_id=runner_run_id,
                program_id=program.program_id,
                frontier_runs=frontier_runs,
                objective_met=objective_met,
                history=history,
                manifest=manifest,
                descriptors=descriptors,
                proposal_scores=proposal_scores,
                worklist=worklist,
                status='running',
                closure_execution_context=closure_execution_context,
            )
            if objective_met and program.objective.stop_when_objective_met:
                break
    except Exception as exc:
        return _persist_run_outputs(
            run_root=run_root,
            program=program,
            program_payload=program.to_payload(),
            runner_run_id=runner_run_id,
            program_id=program.program_id,
            frontier_runs=frontier_runs,
            objective_met=objective_met,
            history=history,
            manifest=manifest,
            descriptors=descriptors,
            proposal_scores=proposal_scores,
            worklist=worklist,
            status='error',
            closure_execution_context=closure_execution_context,
            error={
                'type': exc.__class__.__name__,
                'message': str(exc),
            },
        )

    return _persist_run_outputs(
        run_root=run_root,
        program=program,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        manifest=manifest,
        descriptors=descriptors,
        proposal_scores=proposal_scores,
        worklist=worklist,
        status='ok',
        closure_execution_context=closure_execution_context,
    )


def main() -> int:
    args = _parse_args()
    payload = run_strategy_autoresearch_loop(args)
    if args.json_output is not None:
        args.json_output.write_text(
            json.dumps(payload, indent=2, sort_keys=True),
            encoding='utf-8',
        )
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload.get('status') == 'ok' else 1


if __name__ == '__main__':
    raise SystemExit(main())
