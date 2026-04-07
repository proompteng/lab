#!/usr/bin/env python3
"""Compile claim-linked experiment specs into Harness v2 discovery runs."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, ROUND_CEILING
from pathlib import Path
from typing import Any, Mapping, cast

import yaml
from sqlalchemy import delete, select

from app.db import SessionLocal
from app.models import VNextExperimentRun, VNextExperimentSpec
from app.trading.discovery.family_templates import FamilyTemplate, family_template_dir, load_family_template
from scripts.search_consistent_profitability_frontier import (
    run_consistent_profitability_frontier,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Run strategy-factory v2 from mirrored experiment specs.',
    )
    parser.add_argument('--output-dir', type=Path, required=True, help='Artifact output directory.')
    parser.add_argument(
        '--experiment-id',
        action='append',
        default=[],
        help='Experiment id filter. May be repeated.',
    )
    parser.add_argument(
        '--paper-run-id',
        action='append',
        default=[],
        help='Source paper run id filter. May be repeated.',
    )
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument(
        '--strategy-configmap',
        type=Path,
        default=Path('argocd/applications/torghut/strategy-configmap.yaml'),
    )
    parser.add_argument(
        '--family-template-dir',
        type=Path,
        default=family_template_dir(),
    )
    parser.add_argument(
        '--seed-sweep-dir',
        type=Path,
        default=Path('config/trading'),
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
    parser.add_argument('--top-n', type=int, default=5)
    parser.add_argument(
        '--persist-results',
        dest='persist_results',
        action='store_true',
        help='Persist compiled and executed experiment runs.',
    )
    parser.add_argument(
        '--no-persist-results',
        dest='persist_results',
        action='store_false',
        help='Skip database persistence.',
    )
    parser.set_defaults(persist_results=True)
    return parser.parse_args()


@dataclass(frozen=True)
class CompiledExperimentSweep:
    source_run_id: str
    experiment_id: str
    family_template: FamilyTemplate
    experiment_payload: dict[str, Any]
    sweep_config: dict[str, Any]


def _mapping(value: Any) -> dict[str, Any]:
    return {str(key): item for key, item in value.items()} if isinstance(value, Mapping) else {}


def _list_of_strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if str(item).strip()]


def _coerce_decimal(value: Any, *, default: str) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int | float):
        return Decimal(str(value))
    text = str(value or '').strip()
    return Decimal(text or default)


def _coerce_ratio_days(*, ratio: Decimal, total_days: int) -> int:
    if total_days <= 0 or ratio <= 0:
        return 0
    scaled = (ratio * Decimal(total_days)).quantize(Decimal('1'), rounding=ROUND_CEILING)
    return max(1, int(scaled))


def _singleton_grid(value: Any) -> list[Any]:
    return [json.loads(json.dumps(value))]


def _load_seed_sweep_config(
    family_template_id: str,
    *,
    seed_dir: Path,
) -> dict[str, Any] | None:
    for candidate in sorted(seed_dir.glob('profitability-frontier-consistent-*.yaml')):
        payload = yaml.safe_load(candidate.read_text(encoding='utf-8'))
        if not isinstance(payload, Mapping):
            continue
        if str(payload.get('family_template_id') or '').strip() == family_template_id:
            return json.loads(json.dumps(payload))
    return None


def _compile_sweep_config(
    *,
    experiment_row: VNextExperimentSpec,
    family_dir: Path,
    seed_dir: Path,
    train_days: int,
    holdout_days: int,
) -> CompiledExperimentSweep:
    experiment_payload = _mapping(experiment_row.payload_json)
    experiment_id = str(experiment_row.experiment_id).strip()
    family_template_id = str(experiment_payload.get('family_template_id') or '').strip()
    if not family_template_id:
        raise ValueError(f'experiment_family_template_missing:{experiment_id}')

    family_template = load_family_template(
        family_template_id,
        directory=family_dir,
    )
    runtime_harness = _mapping(family_template.runtime_harness)
    seed_config = _load_seed_sweep_config(family_template_id, seed_dir=seed_dir) or {}

    selection_objectives = {
        **dict(family_template.default_selection_objectives),
        **_mapping(experiment_payload.get('selection_objectives')),
    }
    hard_vetoes = {
        **dict(family_template.default_hard_vetoes),
        **_mapping(experiment_payload.get('hard_vetoes')),
    }
    template_overrides = _mapping(experiment_payload.get('template_overrides'))
    param_overrides = _mapping(template_overrides.pop('params', None))
    feature_variants = _list_of_strings(experiment_payload.get('feature_variants'))
    veto_variants_raw = experiment_payload.get('veto_controller_variants')
    veto_variants = cast(list[Any], veto_variants_raw) if isinstance(veto_variants_raw, list) else []

    total_days = max(1, train_days + holdout_days)
    min_active_ratio = _coerce_decimal(
        hard_vetoes.get(
            'required_min_active_day_ratio',
            family_template.activity_model.get('min_active_day_ratio', '0'),
        ),
        default='0',
    )
    min_daily_notional = _coerce_decimal(
        hard_vetoes.get(
            'required_min_daily_notional',
            family_template.activity_model.get('min_daily_notional', '0'),
        ),
        default='0',
    )
    positive_day_ratio = _coerce_decimal(
        selection_objectives.get('require_positive_day_ratio'),
        default='0',
    )
    target_net_per_day = _coerce_decimal(
        selection_objectives.get('target_net_pnl_per_day'),
        default='0',
    )
    min_active_days = _coerce_ratio_days(ratio=min_active_ratio, total_days=total_days)
    min_active_holdout_days = _coerce_ratio_days(ratio=min_active_ratio, total_days=max(1, holdout_days))
    min_positive_days = _coerce_ratio_days(ratio=positive_day_ratio, total_days=total_days)
    min_avg_filled_notional_per_active_day = min_daily_notional
    if min_active_ratio > 0:
        min_avg_filled_notional_per_active_day = (
            min_daily_notional / min_active_ratio
        ).quantize(Decimal('1'))

    strategy_overrides = _mapping(seed_config.get('strategy_overrides'))
    for key, value in template_overrides.items():
        strategy_overrides[str(key)] = _singleton_grid(value)
    if feature_variants:
        strategy_overrides['normalization_regime'] = feature_variants
    if veto_variants:
        strategy_overrides['veto_controller_variant'] = veto_variants

    parameters = _mapping(seed_config.get('parameters'))
    for key, value in param_overrides.items():
        parameters[str(key)] = _singleton_grid(value)

    family = str(seed_config.get('family') or runtime_harness.get('family') or '').strip()
    strategy_name = str(seed_config.get('strategy_name') or runtime_harness.get('strategy_name') or '').strip()
    if not family or not strategy_name:
        raise ValueError(f'family_template_runtime_harness_incomplete:{family_template_id}')

    holdout_constraints = {
        **_mapping(seed_config.get('constraints')),
        'holdout_target_net_per_day': str(target_net_per_day),
        'min_active_holdout_days': min_active_holdout_days,
        'max_worst_holdout_day_loss': str(
            _coerce_decimal(hard_vetoes.get('required_max_worst_day_loss'), default='0')
        ),
        'min_profit_factor': str(
            _coerce_decimal(selection_objectives.get('min_profit_factor'), default='1.0')
        ),
        'require_training_decisions': True,
        'require_holdout_decisions': True,
    }
    consistency_constraints = {
        **_mapping(seed_config.get('consistency_constraints')),
        'target_net_per_day': str(target_net_per_day),
        'min_active_days': min_active_days,
        'min_active_ratio': str(min_active_ratio),
        'min_positive_days': min_positive_days,
        'max_worst_day_loss': str(
            _coerce_decimal(hard_vetoes.get('required_max_worst_day_loss'), default='0')
        ),
        'max_negative_days': max(0, total_days - min_positive_days),
        'max_drawdown': str(
            _coerce_decimal(hard_vetoes.get('required_max_drawdown'), default='0')
        ),
        'max_best_day_share_of_total_pnl': str(
            _coerce_decimal(hard_vetoes.get('required_max_best_day_share'), default='1')
        ),
        'min_avg_filled_notional_per_day': str(min_daily_notional),
        'min_avg_filled_notional_per_active_day': str(min_avg_filled_notional_per_active_day),
        'require_every_day_active': bool(min_active_ratio >= Decimal('1')),
        'min_regime_slice_pass_rate': str(
            _coerce_decimal(hard_vetoes.get('required_min_regime_slice_pass_rate'), default='0')
        ),
    }

    sweep_config = {
        'schema_version': str(seed_config.get('schema_version') or 'torghut.replay-frontier-sweep.v1'),
        'family': family,
        'family_template_id': family_template.family_id,
        'strategy_name': strategy_name,
        'disable_other_strategies': bool(
            seed_config.get(
                'disable_other_strategies',
                runtime_harness.get('disable_other_strategies', True),
            )
        ),
        'constraints': holdout_constraints,
        'consistency_constraints': consistency_constraints,
        'strategy_overrides': strategy_overrides,
        'parameters': parameters,
        'experiment_spec': {
            'source_run_id': experiment_row.run_id,
            'experiment_id': experiment_id,
            'paper_claim_links': experiment_payload.get('paper_claim_links') or [],
            'expected_failure_modes': experiment_payload.get('expected_failure_modes') or [],
            'promotion_contract': experiment_payload.get('promotion_contract') or {},
        },
    }
    return CompiledExperimentSweep(
        source_run_id=str(experiment_row.run_id),
        experiment_id=experiment_id,
        family_template=family_template,
        experiment_payload=experiment_payload,
        sweep_config=sweep_config,
    )


def _frontier_args(
    *,
    args: argparse.Namespace,
    strategy_configmap: Path,
    sweep_config: Path,
    json_output: Path,
) -> argparse.Namespace:
    return argparse.Namespace(
        strategy_configmap=strategy_configmap,
        sweep_config=sweep_config,
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
        family_template_dir=args.family_template_dir,
        prefetch_full_window_rows=bool(args.prefetch_full_window_rows),
        top_n=int(args.top_n),
        json_output=json_output,
        symbol_prune_iterations=0,
        symbol_prune_candidates=1,
        symbol_prune_min_universe_size=2,
    )


def _load_source_experiment_specs(args: argparse.Namespace) -> list[VNextExperimentSpec]:
    experiment_ids = {item.strip() for item in args.experiment_id if str(item).strip()}
    run_ids = {item.strip() for item in args.paper_run_id if str(item).strip()}
    with SessionLocal() as session:
        stmt = select(VNextExperimentSpec).where(VNextExperimentSpec.candidate_id.is_(None))
        if experiment_ids:
            stmt = stmt.where(VNextExperimentSpec.experiment_id.in_(sorted(experiment_ids)))
        if run_ids:
            stmt = stmt.where(VNextExperimentSpec.run_id.in_(sorted(run_ids)))
        rows = session.execute(
            stmt.order_by(VNextExperimentSpec.created_at.desc()).limit(max(1, int(args.limit)))
        ).scalars()
        return list(rows)


def _persist_result(
    *,
    runner_run_id: str,
    experiment: CompiledExperimentSweep,
    result_payload: Mapping[str, Any],
    compiled_sweep_path: Path,
    result_path: Path,
) -> None:
    top_candidates = cast(list[dict[str, Any]], result_payload.get('top') or [])
    best_candidate_id = (
        str(top_candidates[0].get('candidate_id') or '').strip()
        if top_candidates
        else None
    ) or None
    experiment_payload = {
        **experiment.experiment_payload,
        'compiled_family_template': experiment.family_template.to_payload(),
        'compiled_sweep_path': str(compiled_sweep_path),
        'result_path': str(result_path),
        'runner': 'run_strategy_factory_v2',
        'runner_run_id': runner_run_id,
        'result': result_payload,
    }
    with SessionLocal() as session:
        session.execute(
            delete(VNextExperimentRun).where(
                VNextExperimentRun.run_id == runner_run_id,
                VNextExperimentRun.experiment_id == experiment.experiment_id,
            )
        )
        session.execute(
            delete(VNextExperimentSpec).where(
                VNextExperimentSpec.run_id == runner_run_id,
                VNextExperimentSpec.experiment_id == experiment.experiment_id,
            )
        )
        session.add(
            VNextExperimentSpec(
                run_id=runner_run_id,
                candidate_id=best_candidate_id,
                experiment_id=experiment.experiment_id,
                payload_json=experiment_payload,
            )
        )
        session.add(
            VNextExperimentRun(
                run_id=runner_run_id,
                candidate_id=best_candidate_id,
                experiment_id=experiment.experiment_id,
                stage_lineage_root=None,
                payload_json={
                    'compiled_sweep_path': str(compiled_sweep_path),
                    'result_path': str(result_path),
                    'dataset_snapshot_receipt': result_payload.get('dataset_snapshot_receipt'),
                    'top_candidate': top_candidates[0] if top_candidates else None,
                },
            )
        )
        session.commit()


def run_strategy_factory_v2(args: argparse.Namespace) -> dict[str, Any]:
    source_specs = _load_source_experiment_specs(args)
    if not source_specs:
        return {'status': 'no_experiments', 'count': 0, 'experiments': []}

    runner_run_id = f"strategy-factory-v2-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    results: list[dict[str, Any]] = []
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for experiment_row in source_specs:
        compiled = _compile_sweep_config(
            experiment_row=experiment_row,
            family_dir=args.family_template_dir.resolve(),
            seed_dir=args.seed_sweep_dir.resolve(),
            train_days=max(1, int(args.train_days)),
            holdout_days=max(1, int(args.holdout_days)),
        )
        experiment_root = args.output_dir / compiled.experiment_id
        experiment_root.mkdir(parents=True, exist_ok=True)
        compiled_sweep_path = experiment_root / 'compiled-sweep.yaml'
        compiled_sweep_path.write_text(
            yaml.safe_dump(compiled.sweep_config, sort_keys=False),
            encoding='utf-8',
        )
        result_path = experiment_root / 'result.json'
        frontier_payload = run_consistent_profitability_frontier(
            _frontier_args(
                args=args,
                strategy_configmap=args.strategy_configmap.resolve(),
                sweep_config=compiled_sweep_path,
                json_output=result_path,
            )
        )
        result_path.write_text(
            json.dumps(frontier_payload, indent=2, sort_keys=True),
            encoding='utf-8',
        )
        if args.persist_results:
            _persist_result(
                runner_run_id=runner_run_id,
                experiment=compiled,
                result_payload=frontier_payload,
                compiled_sweep_path=compiled_sweep_path,
                result_path=result_path,
            )
        top_candidates = cast(list[dict[str, Any]], frontier_payload.get('top') or [])
        results.append(
            {
                'source_run_id': compiled.source_run_id,
                'experiment_id': compiled.experiment_id,
                'family_template_id': compiled.family_template.family_id,
                'compiled_sweep_path': str(compiled_sweep_path),
                'result_path': str(result_path),
                'dataset_snapshot_id': str(
                    _mapping(frontier_payload.get('dataset_snapshot_receipt')).get('snapshot_id') or ''
                ),
                'top_candidate_id': (
                    str(top_candidates[0].get('candidate_id') or '').strip()
                    if top_candidates
                    else ''
                ),
                'top_net_per_day': (
                    str(_mapping(top_candidates[0].get('full_window')).get('net_per_day') or '')
                    if top_candidates
                    else ''
                ),
            }
        )

    summary = {
        'status': 'ok',
        'runner_run_id': runner_run_id,
        'count': len(results),
        'persisted': bool(args.persist_results),
        'experiments': results,
    }
    return summary


def main() -> int:
    args = _parse_args()
    payload = run_strategy_factory_v2(args)
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
