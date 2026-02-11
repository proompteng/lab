#!/usr/bin/env python3
"""Run Torghut v3 autonomous lane: research -> gate eval -> paper candidate patch."""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, cast

import yaml

from app.models import Strategy
from app.trading.autonomy import (
    build_metrics_bundle,
    build_paper_candidate_patch,
    build_research_artifact,
    derive_deterministic_run_id,
    evaluate_gate_policy_matrix,
    load_gate_policy,
    write_json,
)
from app.trading.decisions import DecisionEngine
from app.trading.evaluation import (
    FixtureSignalSource,
    generate_walk_forward_folds,
    run_walk_forward,
    write_walk_forward_results,
)
from app.trading.reporting import (
    EvaluationGatePolicy,
    EvaluationReportConfig,
    generate_evaluation_report,
    write_evaluation_report,
)


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _resolve_git_sha() -> str | None:
    try:
        result = subprocess.run(
            ['git', 'rev-parse', 'HEAD'],
            check=True,
            capture_output=True,
            text=True,
        )
    except (subprocess.SubprocessError, FileNotFoundError):
        return None
    return result.stdout.strip() or None


def _load_candidate_spec(path: Path) -> dict[str, Any]:
    raw_payload: Any = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(raw_payload, dict):
        raise ValueError('candidate spec must be a JSON object')
    return cast(dict[str, Any], raw_payload)


def _load_strategy_config(path: Path, candidate_spec: dict[str, Any]) -> list[Strategy]:
    payload: Any
    if path.suffix.lower() in {'.yaml', '.yml'}:
        payload = yaml.safe_load(path.read_text(encoding='utf-8'))
    elif path.suffix.lower() == '.json':
        payload = json.loads(path.read_text(encoding='utf-8'))
    else:
        raise ValueError(f'unsupported strategy config extension: {path.suffix}')
    if isinstance(payload, dict):
        payload_map = cast(dict[str, Any], payload)
        if 'data' in payload_map and isinstance(payload_map.get('data'), dict):
            data = cast(dict[str, Any], payload_map.get('data'))
            strategies_blob = data.get('strategies.yaml')
            if isinstance(strategies_blob, str):
                parsed = yaml.safe_load(strategies_blob)
                if isinstance(parsed, dict):
                    parsed_map = cast(dict[str, Any], parsed)
                    payload = parsed_map.get('strategies', [])
                else:
                    payload = []
            else:
                payload = payload_map.get('strategies', payload_map)
        else:
            payload = payload_map.get('strategies', payload_map)
    if not isinstance(payload, list):
        raise ValueError('strategy config must be a list or include a strategies key')

    strategies: list[Strategy] = []
    for item in cast(list[Any], payload):
        if not isinstance(item, dict):
            continue
        item_map = cast(dict[str, Any], item)
        strategies.append(
            Strategy(
                name=str(item_map.get('name', candidate_spec.get('strategy_name', 'candidate'))),
                description=str(item_map.get('description', 'runtime=v3')),
                enabled=bool(item_map.get('enabled', True)),
                base_timeframe=str(item_map.get('base_timeframe', '1Min')),
                universe_type=str(item_map.get('universe_type', 'legacy_macd_rsi')),
                universe_symbols=item_map.get('universe_symbols') or item_map.get('symbols'),
                max_notional_per_trade=item_map.get('max_notional_per_trade'),
                max_position_pct_equity=item_map.get('max_position_pct_equity'),
            )
        )
    if not strategies:
        strategies.append(
            Strategy(
                name=str(candidate_spec.get('strategy_name', 'candidate-default')),
                description='runtime=v3',
                enabled=True,
                base_timeframe=str(candidate_spec.get('base_timeframe', '1Min')),
                universe_type=str(candidate_spec.get('strategy_type', 'legacy_macd_rsi')),
                universe_symbols=candidate_spec.get('universe_symbols'),
                max_notional_per_trade=candidate_spec.get('max_notional_per_trade'),
                max_position_pct_equity=candidate_spec.get('max_position_pct_equity'),
            )
        )
    return strategies


def main() -> int:
    parser = argparse.ArgumentParser(description='Run deterministic autonomous lane for Torghut v3.')
    parser.add_argument('--candidate-spec', type=Path, required=True, help='Path to candidate spec JSON')
    parser.add_argument('--signals', type=Path, required=True, help='Fixture signals JSON')
    parser.add_argument('--strategy-config', type=Path, required=True, help='Strategy config YAML/JSON')
    parser.add_argument('--gate-policy', type=Path, required=True, help='Gate policy JSON')
    parser.add_argument('--artifact-dir', type=Path, required=True, help='Output artifact directory')
    parser.add_argument('--start', type=str, required=True, help='Evaluation start datetime (ISO)')
    parser.add_argument('--end', type=str, required=True, help='Evaluation end datetime (ISO)')
    parser.add_argument('--train-window-minutes', type=int, default=60)
    parser.add_argument('--test-window-minutes', type=int, default=30)
    parser.add_argument('--step-minutes', type=int, default=30)
    parser.add_argument('--promotion-target', choices=('shadow', 'paper', 'live'), default='paper')
    args = parser.parse_args()

    candidate_spec = _load_candidate_spec(args.candidate_spec)
    context = {
        'signals': str(args.signals),
        'strategy_config': str(args.strategy_config),
        'gate_policy': str(args.gate_policy),
        'start': args.start,
        'end': args.end,
        'promotion_target': args.promotion_target,
    }
    run_id = derive_deterministic_run_id(candidate_spec, context)
    args.artifact_dir.mkdir(parents=True, exist_ok=True)

    research_artifact = build_research_artifact(candidate_spec, run_id=run_id)
    write_json(args.artifact_dir / 'research-artifact.json', research_artifact)

    signal_source = FixtureSignalSource.from_path(args.signals)
    start = _parse_datetime(args.start)
    end = _parse_datetime(args.end)
    folds = generate_walk_forward_folds(
        start,
        end,
        train_window=timedelta(minutes=args.train_window_minutes),
        test_window=timedelta(minutes=args.test_window_minutes),
        step=timedelta(minutes=args.step_minutes),
    )
    strategies = _load_strategy_config(args.strategy_config, candidate_spec)
    results = run_walk_forward(
        folds,
        strategies=strategies,
        signal_source=signal_source,
        decision_engine=DecisionEngine(),
    )
    write_walk_forward_results(results, args.artifact_dir / 'walkforward-results.json')

    evaluation_report = generate_evaluation_report(
        results,
        config=EvaluationReportConfig(
            evaluation_start=start,
            evaluation_end=end,
            signal_source='fixture',
            strategies=strategies,
            git_sha=_resolve_git_sha(),
            run_id=run_id,
            strategy_config_path=str(args.strategy_config),
            variant_count=len(strategies),
        ),
        gate_policy=EvaluationGatePolicy.from_path(args.gate_policy),
        promotion_target=args.promotion_target,
    )
    write_evaluation_report(evaluation_report, args.artifact_dir / 'evaluation-report.json')

    metrics_bundle = build_metrics_bundle(evaluation_report.to_payload())
    write_json(args.artifact_dir / 'metrics-bundle.json', metrics_bundle)

    gate_policy = load_gate_policy(args.gate_policy)
    gate_report = evaluate_gate_policy_matrix(
        metrics_bundle,
        gate_policy,
        code_version=_resolve_git_sha() or 'dev',
        promotion_target=args.promotion_target,
    )
    write_json(args.artifact_dir / 'gate-report.json', gate_report.to_payload())

    patch = build_paper_candidate_patch(candidate_spec, gate_report, run_id=run_id)
    (args.artifact_dir / 'paper-candidate-patch.yaml').write_text(
        yaml.safe_dump(patch, sort_keys=False),
        encoding='utf-8',
    )

    manifest = {
        'run_id': run_id,
        'artifacts': [
            'research-artifact.json',
            'walkforward-results.json',
            'evaluation-report.json',
            'metrics-bundle.json',
            'gate-report.json',
            'paper-candidate-patch.yaml',
        ],
        'promotion_allowed': gate_report.promotion_allowed,
        'recommended_mode': gate_report.recommended_mode,
        'live_enabled': False,
        'generated_at': datetime.now(timezone.utc).isoformat(),
    }
    write_json(args.artifact_dir / 'lane-manifest.json', manifest)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
