#!/usr/bin/env python3
"""Run an autoresearch-style outer loop for Torghut strategy discovery."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, cast

import yaml

from app.trading.discovery.autoresearch import (
    FamilyAutoresearchPlan,
    apply_program_objective,
    build_mutated_sweep_config,
    candidate_meets_objective,
    load_strategy_autoresearch_program,
    run_id,
    stable_payload_hash,
)
from app.trading.discovery.autoresearch_notebooks import write_autoresearch_notebooks
from app.trading.discovery.family_templates import family_template_dir
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


def _frontier_args(
    *,
    args: argparse.Namespace,
    family_plan: FamilyAutoresearchPlan,
    sweep_config_path: Path,
    json_output_path: Path,
) -> argparse.Namespace:
    top_n = max(family_plan.frontier_top_n, family_plan.keep_top_candidates)
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
) -> dict[str, Any]:
    full_window = _mapping(candidate_payload.get('full_window'))
    scorecard = _mapping(candidate_payload.get('objective_scorecard'))
    ranking = _mapping(candidate_payload.get('ranking'))
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


def _persist_run_outputs(
    *,
    run_root: Path,
    program_payload: Mapping[str, Any],
    runner_run_id: str,
    program_id: str,
    frontier_runs: int,
    objective_met: bool,
    history: list[dict[str, Any]],
    status: str,
    error: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    history_path = run_root / 'history.jsonl'
    results_tsv_path = run_root / 'results.tsv'
    research_dossier_path = run_root / 'research_dossier.json'
    summary_path = run_root / 'summary.json'
    _write_history_jsonl(history_path, history)
    _write_results_tsv(results_tsv_path, history)
    research_dossier_path.write_text(
        json.dumps(program_payload, indent=2, sort_keys=True),
        encoding='utf-8',
    )
    notebook_paths = write_autoresearch_notebooks(run_root)
    summary: dict[str, Any] = {
        'status': status,
        'runner_run_id': runner_run_id,
        'program_id': program_id,
        'run_root': str(run_root),
        'frontier_run_count': frontier_runs,
        'objective_met': objective_met,
        'history_path': str(history_path),
        'results_tsv_path': str(results_tsv_path),
        'research_dossier_path': str(research_dossier_path),
        'notebooks': [str(path) for path in notebook_paths],
        'best_candidate': _best_history_record(history),
    }
    if error is not None:
        summary['error'] = dict(error)
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
    frontier_runs = 0
    objective_met = False
    _persist_run_outputs(
        run_root=run_root,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        status='running',
    )
    try:
        while worklist:
            if int(args.max_frontier_runs) > 0 and frontier_runs >= int(args.max_frontier_runs):
                break
            current = worklist.pop(0)
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
            frontier_payload = run_consistent_profitability_frontier(
                _frontier_args(
                    args=args,
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
            top_candidates = cast(list[dict[str, Any]], frontier_payload.get('top') or [])
            keep_candidates = [
                candidate
                for candidate in top_candidates
                if not bool(_mapping(candidate.get('ranking')).get('vetoed'))
            ][: current.family_plan.keep_top_candidates]
            if not keep_candidates and current.family_plan.force_keep_top_candidate_if_all_vetoed and top_candidates:
                keep_candidates = [top_candidates[0]]
            keep_ids = {
                _string(candidate.get('candidate_id'))
                for candidate in keep_candidates
            }
            for rank, candidate in enumerate(top_candidates, start=1):
                candidate_id = _string(candidate.get('candidate_id'))
                candidate_status = 'keep' if candidate_id in keep_ids else 'discard'
                candidate_objective_met = candidate_meets_objective(candidate, objective=program.objective)
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
                    )
                )
                if candidate_status != 'keep':
                    continue
                if candidate_objective_met:
                    objective_met = True
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
                program_payload=program.to_payload(),
                runner_run_id=runner_run_id,
                program_id=program.program_id,
                frontier_runs=frontier_runs,
                objective_met=objective_met,
                history=history,
                status='running',
            )
            if objective_met and program.objective.stop_when_objective_met:
                break
    except Exception as exc:
        return _persist_run_outputs(
            run_root=run_root,
            program_payload=program.to_payload(),
            runner_run_id=runner_run_id,
            program_id=program.program_id,
            frontier_runs=frontier_runs,
            objective_met=objective_met,
            history=history,
            status='error',
            error={
                'type': exc.__class__.__name__,
                'message': str(exc),
            },
        )

    return _persist_run_outputs(
        run_root=run_root,
        program_payload=program.to_payload(),
        runner_run_id=runner_run_id,
        program_id=program.program_id,
        frontier_runs=frontier_runs,
        objective_met=objective_met,
        history=history,
        status='ok',
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
