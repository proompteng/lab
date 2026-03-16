#!/usr/bin/env python3
"""Build profitability proof artifacts from historical simulation run directories."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping

import yaml

from app.trading.evaluation import (
    build_profitability_evidence_v4,
    execute_profitability_benchmark_v4,
    validate_profitability_evidence_v4,
)

_SERVICE_ROOT = Path(__file__).resolve().parent.parent
_PROFITABILITY_PROOF_SCHEMA_VERSION = 'torghut.historical-profitability-proof.v1'
_DEFAULT_BASELINE_ID = 'cash-flat@baseline'


@dataclass(frozen=True)
class HistoricalRunSummary:
    run_id: str
    run_dir: Path
    trading_day: str
    candidate_id: str
    baseline_candidate_id: str
    strategy_spec_ref: str
    model_refs: list[str]
    runtime_version_refs: list[str]
    net_pnl: Decimal
    max_drawdown: Decimal
    cost_bps: Decimal
    trade_count: int
    decision_count: int
    execution_notional_total: Decimal
    estimated_cost_total: Decimal
    confidence_value: Decimal
    verdict_status: str
    signal_hash: str
    strategy_config_hash: str
    gate_policy_hash: str
    simulation_report_path: Path
    replay_report_path: Path | None
    trade_pnl_csv_path: Path | None


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='Build profitability proof artifacts from historical Torghut simulation outputs.',
    )
    parser.add_argument('--run-dir', action='append', required=True, help='Historical simulation run directory.')
    parser.add_argument(
        '--baseline-run-dir',
        action='append',
        default=[],
        help='Optional baseline historical simulation run directory.',
    )
    parser.add_argument('--output-dir', required=True, help='Directory for generated proof artifacts.')
    parser.add_argument('--hypothesis', default='', help='Explicit hypothesis text for the proof manifest.')
    parser.add_argument('--baseline-id', default='', help='Optional baseline identifier override.')
    parser.add_argument('--json', action='store_true')
    return parser.parse_args()


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f'json_mapping_required:{path}')
    return {str(key): value for key, value in payload.items()}


def _load_yaml(path: Path) -> dict[str, Any]:
    payload = yaml.safe_load(path.read_text(encoding='utf-8'))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f'yaml_mapping_required:{path}')
    return {str(key): value for key, value in payload.items()}


def _as_dict(value: Any) -> dict[str, Any]:
    return {str(key): item for key, item in value.items()} if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> list[Any]:
    return list(value) if isinstance(value, list) else []


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal('0')


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except Exception:
        return 0


def _clamp_confidence(value: Decimal) -> Decimal:
    if value < 0:
        return Decimal('0')
    if value > 1:
        return Decimal('1')
    return value


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _sha256_json(payload: Mapping[str, Any]) -> str:
    return _sha256_bytes(
        json.dumps(payload, indent=2, sort_keys=True, default=str).encode('utf-8')
    )


def _stable_hash_payload(payload: Any) -> str:
    return _sha256_bytes(
        json.dumps(payload, sort_keys=True, separators=(',', ':'), default=str).encode('utf-8')
    )


def _resolve_manifest_path(run_dir: Path, report: Mapping[str, Any]) -> Path | None:
    run_metadata = _as_dict(report.get('run_metadata'))
    raw = _as_text(run_metadata.get('manifest_path'))
    if raw is None:
        return None
    candidate = Path(raw)
    if candidate.is_absolute() and candidate.exists():
        return candidate
    for resolved in (_SERVICE_ROOT / raw, run_dir / raw, Path.cwd() / raw):
        if resolved.exists():
            return resolved
    return None


def _load_source_manifest(run_dir: Path, report: Mapping[str, Any]) -> tuple[dict[str, Any], Path | None]:
    path = _resolve_manifest_path(run_dir, report)
    if path is None:
        return {}, None
    if path.suffix.lower() in {'.yaml', '.yml'}:
        return _load_yaml(path), path
    return _load_json(path), path


def _lineage_text(
    *,
    key: str,
    run_manifest: Mapping[str, Any],
    source_manifest: Mapping[str, Any],
) -> str | None:
    lineage = _as_dict(run_manifest.get('evidence_lineage'))
    return _as_text(lineage.get(key)) or _as_text(source_manifest.get(key))


def _lineage_list(
    *,
    key: str,
    run_manifest: Mapping[str, Any],
    source_manifest: Mapping[str, Any],
) -> list[str]:
    lineage = _as_dict(run_manifest.get('evidence_lineage'))
    raw = lineage.get(key)
    if isinstance(raw, list):
        return [text for item in raw if (text := _as_text(item))]
    source_raw = source_manifest.get(key)
    if isinstance(source_raw, list):
        return [text for item in source_raw if (text := _as_text(item))]
    return []


def _load_trade_contributions(path: Path | None) -> list[Decimal]:
    if path is None or not path.exists():
        return []
    contributions: list[Decimal] = []
    with path.open(newline='', encoding='utf-8') as handle:
        reader = csv.DictReader(handle)
        rows = sorted(reader, key=lambda row: str(row.get('created_at') or ''))
        for row in rows:
            contributions.append(_as_decimal(row.get('realized_pnl_contribution')))
    return contributions


def _estimate_day_drawdown(*, net_pnl: Decimal, trade_pnl_csv_path: Path | None) -> Decimal:
    equity = Decimal('0')
    peak = Decimal('0')
    max_drawdown = Decimal('0')
    realized_total = Decimal('0')
    for contribution in _load_trade_contributions(trade_pnl_csv_path):
        realized_total += contribution
        equity += contribution
        if equity > peak:
            peak = equity
        drawdown = peak - equity
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    residual = net_pnl - realized_total
    equity += residual
    if equity > peak:
        peak = equity
    drawdown = peak - equity
    if drawdown > max_drawdown:
        max_drawdown = drawdown
    if max_drawdown == 0 and net_pnl < 0:
        return abs(net_pnl)
    return max_drawdown


def _best_signal_hash(run_dir: Path, replay_report: Mapping[str, Any]) -> str:
    replay_hash = _as_text(replay_report.get('dump_sha256'))
    if replay_hash:
        return replay_hash
    dump_manifest_path = run_dir / 'source-dump.jsonl.zst.manifest.json'
    if dump_manifest_path.exists():
        dump_manifest = _load_json(dump_manifest_path)
        chunks = _as_list(dump_manifest.get('chunks'))
        chunk_hashes = [
            _as_text(_as_dict(item).get('payload_sha256')) or _as_text(_as_dict(item).get('sha256')) or ''
            for item in chunks
        ]
        normalized = [item for item in chunk_hashes if item]
        if normalized:
            return _stable_hash_payload(normalized)
        return _sha256_bytes(dump_manifest_path.read_bytes())
    source_dump_path = run_dir / 'source-dump.jsonl.zst'
    if source_dump_path.exists():
        return _sha256_bytes(source_dump_path.read_bytes())
    raise RuntimeError(f'signal_hash_missing:{run_dir}')


def _load_run_summary(run_dir: Path) -> HistoricalRunSummary:
    run_manifest_path = run_dir / 'run-manifest.json'
    simulation_report_path = run_dir / 'report' / 'simulation-report.json'
    replay_report_path = run_dir / 'replay-report.json'
    trade_pnl_csv_path = run_dir / 'report' / 'trade-pnl.csv'

    run_manifest = _load_json(run_manifest_path)
    report = _load_json(simulation_report_path)
    replay_report = _load_json(replay_report_path) if replay_report_path.exists() else {}
    source_manifest, source_manifest_path = _load_source_manifest(run_dir, report)

    candidate_id = _lineage_text(
        key='candidate_id',
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    if candidate_id is None:
        raise RuntimeError(f'candidate_id_missing:{run_dir}')
    baseline_candidate_id = _lineage_text(
        key='baseline_candidate_id',
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    ) or _DEFAULT_BASELINE_ID
    strategy_spec_ref = _lineage_text(
        key='strategy_spec_ref',
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    if strategy_spec_ref is None:
        raise RuntimeError(f'strategy_spec_ref_missing:{run_dir}')
    model_refs = _lineage_list(
        key='model_refs',
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    runtime_version_refs = _lineage_list(
        key='runtime_version_refs',
        run_manifest=run_manifest,
        source_manifest=source_manifest,
    )
    if not model_refs or not runtime_version_refs:
        raise RuntimeError(f'evidence_lineage_incomplete:{run_dir}')

    coverage = _as_dict(report.get('coverage'))
    trading_day = (
        _as_text(_as_dict(source_manifest.get('window')).get('trading_day'))
        or _as_text(coverage.get('window_start'),)
    )
    if trading_day is None:
        raise RuntimeError(f'trading_day_missing:{run_dir}')
    if 'T' in trading_day:
        trading_day = trading_day.split('T', 1)[0]

    funnel = _as_dict(report.get('funnel'))
    pnl = _as_dict(report.get('pnl'))
    llm = _as_dict(report.get('llm'))
    verdict = (_as_text(_as_dict(report.get('verdict')).get('status')) or 'FAIL').upper()
    if verdict == 'FAIL':
        raise RuntimeError(f'simulation_report_failed:{run_dir}')

    net_pnl = _as_decimal(
        pnl.get('net_pnl_estimated')
        or pnl.get('gross_pnl')
        or pnl.get('realized_pnl')
        or '0'
    )
    execution_notional_total = _as_decimal(pnl.get('execution_notional_total'))
    estimated_cost_total = _as_decimal(pnl.get('estimated_cost_total'))
    cost_bps = Decimal('0')
    if execution_notional_total > 0:
        cost_bps = (estimated_cost_total / execution_notional_total) * Decimal('10000')

    raw_confidence = _as_text(llm.get('avg_confidence'))
    confidence_value = (
        _clamp_confidence(_as_decimal(raw_confidence))
        if raw_confidence is not None
        else Decimal('1') if net_pnl > 0 else Decimal('0')
    )

    signal_hash = _best_signal_hash(run_dir, replay_report)
    strategy_config_hash = (
        _sha256_bytes(source_manifest_path.read_bytes())
        if source_manifest_path is not None
        else _sha256_bytes(strategy_spec_ref.encode('utf-8'))
    )
    gate_policy_hash = _stable_hash_payload(
        {
            'monitor': _as_dict(source_manifest.get('monitor')),
            'window': _as_dict(source_manifest.get('window')),
            'report_window': coverage,
        }
    )

    return HistoricalRunSummary(
        run_id=_as_text(run_manifest.get('run_id')) or run_dir.name,
        run_dir=run_dir,
        trading_day=trading_day,
        candidate_id=candidate_id,
        baseline_candidate_id=baseline_candidate_id,
        strategy_spec_ref=strategy_spec_ref,
        model_refs=model_refs,
        runtime_version_refs=runtime_version_refs,
        net_pnl=net_pnl,
        max_drawdown=_estimate_day_drawdown(net_pnl=net_pnl, trade_pnl_csv_path=trade_pnl_csv_path),
        cost_bps=cost_bps,
        trade_count=_as_int(funnel.get('executions')),
        decision_count=_as_int(funnel.get('trade_decisions')),
        execution_notional_total=execution_notional_total,
        estimated_cost_total=estimated_cost_total,
        confidence_value=confidence_value,
        verdict_status=verdict,
        signal_hash=signal_hash,
        strategy_config_hash=strategy_config_hash,
        gate_policy_hash=gate_policy_hash,
        simulation_report_path=simulation_report_path,
        replay_report_path=replay_report_path if replay_report_path.exists() else None,
        trade_pnl_csv_path=trade_pnl_csv_path if trade_pnl_csv_path.exists() else None,
    )


def _require_consistent_lineage(run_summaries: list[HistoricalRunSummary], *, label: str) -> None:
    if not run_summaries:
        raise RuntimeError(f'{label}_run_set_empty')
    trading_days = [item.trading_day for item in run_summaries]
    if len(set(trading_days)) != len(trading_days):
        raise RuntimeError(f'{label}_trading_day_duplicate')
    candidate_ids = {item.candidate_id for item in run_summaries}
    if len(candidate_ids) != 1:
        raise RuntimeError(f'{label}_candidate_id_mismatch')
    strategy_specs = {item.strategy_spec_ref for item in run_summaries}
    if len(strategy_specs) != 1:
        raise RuntimeError(f'{label}_strategy_spec_mismatch')
    model_refs = {tuple(item.model_refs) for item in run_summaries}
    if len(model_refs) != 1:
        raise RuntimeError(f'{label}_model_refs_mismatch')
    runtime_refs = {tuple(item.runtime_version_refs) for item in run_summaries}
    if len(runtime_refs) != 1:
        raise RuntimeError(f'{label}_runtime_refs_mismatch')


def _window_max_drawdown(run_summaries: list[HistoricalRunSummary]) -> Decimal:
    equity = Decimal('0')
    peak = Decimal('0')
    max_drawdown = Decimal('0')
    for item in sorted(run_summaries, key=lambda value: value.trading_day):
        equity += item.net_pnl
        if equity > peak:
            peak = equity
        drawdown = peak - equity
        if drawdown > max_drawdown:
            max_drawdown = drawdown
    return max_drawdown


def _build_report_payload(run_summaries: list[HistoricalRunSummary]) -> dict[str, object]:
    ordered = sorted(run_summaries, key=lambda value: value.trading_day)
    total_net = sum((item.net_pnl for item in ordered), Decimal('0'))
    total_notional = sum((item.execution_notional_total for item in ordered), Decimal('0'))
    total_cost = sum((item.estimated_cost_total for item in ordered), Decimal('0'))
    total_trades = sum(item.trade_count for item in ordered)
    total_decisions = sum(item.decision_count for item in ordered)
    market_cost_bps = (
        (total_cost / total_notional) * Decimal('10000')
        if total_notional > 0
        else Decimal('0')
    )
    folds = [
        {
            'fold_name': item.trading_day,
            'trade_count': item.trade_count,
            'net_pnl': str(item.net_pnl),
            'max_drawdown': str(item.max_drawdown),
            'cost_bps': str(item.cost_bps),
            'turnover_ratio': '0',
            'regime_label': item.trading_day,
        }
        for item in ordered
    ]
    return {
        'metrics': {
            'net_pnl': str(total_net),
            'max_drawdown': str(_window_max_drawdown(ordered)),
            'cost_bps': str(market_cost_bps),
            'trade_count': total_trades,
            'decision_count': total_decisions,
            'turnover_ratio': '0',
        },
        'robustness': {
            'folds': folds,
        },
        'impact_assumptions': {
            'decisions_with_spread': total_decisions,
            'decisions_with_volatility': total_decisions,
            'decisions_with_adv': total_decisions,
            'assumptions': {
                'recorded_inputs_count': str(total_decisions),
                'fallback_inputs_count': '0',
            },
        },
    }


def _build_zero_baseline_payload(trading_days: list[str]) -> dict[str, object]:
    return {
        'metrics': {
            'net_pnl': '0',
            'max_drawdown': '0',
            'cost_bps': '0',
            'trade_count': 0,
            'decision_count': 0,
            'turnover_ratio': '0',
        },
        'robustness': {
            'folds': [
                {
                    'fold_name': trading_day,
                    'trade_count': 0,
                    'net_pnl': '0',
                    'max_drawdown': '0',
                    'cost_bps': '0',
                    'turnover_ratio': '0',
                    'regime_label': trading_day,
                }
                for trading_day in trading_days
            ],
        },
        'impact_assumptions': {
            'decisions_with_spread': 0,
            'decisions_with_volatility': 0,
            'decisions_with_adv': 0,
            'assumptions': {
                'recorded_inputs_count': '0',
                'fallback_inputs_count': '0',
            },
        },
    }


def _effect_size(candidate_report_payload: Mapping[str, Any]) -> Decimal:
    folds = _as_list(_as_dict(candidate_report_payload.get('robustness')).get('folds'))
    daily_values = [_as_decimal(_as_dict(item).get('net_pnl')) for item in folds]
    if not daily_values:
        return Decimal('0')
    mean_value = sum(daily_values, Decimal('0')) / Decimal(len(daily_values))
    if len(daily_values) <= 1:
        return mean_value
    variance = sum((value - mean_value) ** 2 for value in daily_values) / Decimal(len(daily_values))
    std_dev = variance.sqrt()
    if std_dev <= 0:
        return mean_value
    return mean_value / std_dev


def _artifact_refs(run_summaries: list[HistoricalRunSummary]) -> list[str]:
    refs: list[str] = []
    for item in run_summaries:
        refs.append(str(item.simulation_report_path))
        if item.replay_report_path is not None:
            refs.append(str(item.replay_report_path))
        if item.trade_pnl_csv_path is not None:
            refs.append(str(item.trade_pnl_csv_path))
    return sorted(set(refs))


def _proof_passed(
    *,
    candidate_report_payload: Mapping[str, Any],
    validation_payload: Mapping[str, Any],
    proof_payload: Mapping[str, Any],
) -> tuple[bool, list[str]]:
    reasons: list[str] = []
    if not bool(validation_payload.get('passed')):
        reasons.append('profitability_evidence_validation_failed')
    market_net = _as_decimal(_as_dict(candidate_report_payload.get('metrics')).get('net_pnl'))
    if market_net <= 0:
        reasons.append('market_net_pnl_not_positive')
    p_value = _as_decimal(_as_dict(proof_payload.get('statistics')).get('p_value'))
    if p_value > Decimal('0.05'):
        reasons.append('p_value_above_0_05')
    return (not reasons, reasons)


def build_historical_profitability_bundle(
    *,
    run_dirs: list[Path],
    output_dir: Path,
    hypothesis: str = '',
    baseline_run_dirs: list[Path] | None = None,
    baseline_id: str = '',
    generated_at: datetime | None = None,
) -> dict[str, Any]:
    timestamp = generated_at or datetime.now(timezone.utc)
    output_dir.mkdir(parents=True, exist_ok=True)

    candidate_runs = [_load_run_summary(path) for path in run_dirs]
    _require_consistent_lineage(candidate_runs, label='candidate')

    candidate_id = candidate_runs[0].candidate_id
    inferred_baseline_id = baseline_id.strip() or candidate_runs[0].baseline_candidate_id or _DEFAULT_BASELINE_ID

    candidate_report_payload = _build_report_payload(candidate_runs)
    baseline_report_payload: dict[str, object]
    if baseline_run_dirs:
        baseline_runs = [_load_run_summary(path) for path in baseline_run_dirs]
        _require_consistent_lineage(baseline_runs, label='baseline')
        baseline_report_payload = _build_report_payload(baseline_runs)
        inferred_baseline_id = baseline_id.strip() or baseline_runs[0].candidate_id
    else:
        baseline_report_payload = _build_zero_baseline_payload(
            [item.trading_day for item in sorted(candidate_runs, key=lambda value: value.trading_day)]
        )

    candidate_report_path = output_dir / 'candidate-report.json'
    baseline_report_path = output_dir / 'baseline-report.json'
    candidate_report_path.write_text(json.dumps(candidate_report_payload, indent=2), encoding='utf-8')
    baseline_report_path.write_text(json.dumps(baseline_report_payload, indent=2), encoding='utf-8')

    reproducibility_hashes = {
        'signals': _stable_hash_payload([item.signal_hash for item in candidate_runs]),
        'strategy_config': _stable_hash_payload(
            {
                'candidate_id': candidate_id,
                'strategy_spec_ref': candidate_runs[0].strategy_spec_ref,
                'model_refs': candidate_runs[0].model_refs,
                'runtime_version_refs': candidate_runs[0].runtime_version_refs,
                'per_run_hashes': [item.strategy_config_hash for item in candidate_runs],
            }
        ),
        'gate_policy': _stable_hash_payload([item.gate_policy_hash for item in candidate_runs]),
        'candidate_report': _sha256_json(candidate_report_payload),
        'baseline_report': _sha256_json(baseline_report_payload),
    }

    benchmark = execute_profitability_benchmark_v4(
        candidate_id=candidate_id,
        baseline_id=inferred_baseline_id,
        candidate_report_payload=dict(candidate_report_payload),
        baseline_report_payload=dict(baseline_report_payload),
        executed_at=timestamp,
    )
    benchmark_path = output_dir / 'profitability-benchmark-v4.json'
    benchmark_path.write_text(json.dumps(benchmark.to_payload(), indent=2), encoding='utf-8')

    confidence_values = [item.confidence_value for item in candidate_runs]
    evidence = build_profitability_evidence_v4(
        run_id='historical-oos-profitability',
        candidate_id=candidate_id,
        baseline_id=inferred_baseline_id,
        candidate_report_payload=dict(candidate_report_payload),
        benchmark=benchmark,
        confidence_values=confidence_values,
        reproducibility_hashes=reproducibility_hashes,
        artifact_refs=[* _artifact_refs(candidate_runs), str(candidate_report_path), str(baseline_report_path)],
        generated_at=timestamp,
    )
    evidence_payload = evidence.to_payload()
    evidence_path = output_dir / 'profitability-evidence-v4.json'
    evidence_path.write_text(json.dumps(evidence_payload, indent=2), encoding='utf-8')

    validation = validate_profitability_evidence_v4(evidence, checked_at=timestamp)
    validation_payload = validation.to_payload()
    validation_path = output_dir / 'profitability-evidence-validation.json'
    validation_path.write_text(json.dumps(validation_payload, indent=2), encoding='utf-8')

    benchmark_payload = benchmark.to_payload()
    market_slice = _as_dict(
        next(
            (
                item
                for item in _as_list(benchmark_payload.get('slices'))
                if _as_text(_as_dict(item).get('slice_key')) == 'market:all'
            ),
            {},
        )
    )
    proof_payload: dict[str, Any] = {
        'schema_version': _PROFITABILITY_PROOF_SCHEMA_VERSION,
        'generated_at': timestamp.isoformat(),
        'hypothesis': hypothesis.strip()
        or f'{candidate_id} is profitable over the historical OOS replay window',
        'sample_size': len(candidate_runs),
        'window_days': len(candidate_runs),
        'statistics': {
            'effect_size': float(_effect_size(candidate_report_payload)),
            'p_value': float(_as_decimal(_as_dict(evidence_payload.get('significance')).get('p_value_two_sided'))),
            'ci_95_low': _as_text(_as_dict(evidence_payload.get('significance')).get('ci_95_low')) or '0',
            'ci_95_high': _as_text(_as_dict(evidence_payload.get('significance')).get('ci_95_high')) or '0',
        },
        'risk_controls': {
            'max_drawdown_delta': float(_as_decimal(_as_dict(market_slice.get('deltas')).get('max_drawdown_delta'))),
            'market_net_pnl_delta': _as_text(_as_dict(market_slice.get('deltas')).get('net_pnl_delta')) or '0',
            'return_over_drawdown': _as_text(
                _as_dict(evidence_payload.get('risk_adjusted_metrics')).get('return_over_drawdown')
            )
            or '0',
        },
        'candidate_id': candidate_id,
        'baseline_id': inferred_baseline_id,
        'source_runs': [
            {
                'run_id': item.run_id,
                'trading_day': item.trading_day,
                'verdict_status': item.verdict_status,
                'trade_count': item.trade_count,
                'decision_count': item.decision_count,
                'net_pnl': str(item.net_pnl),
                'max_drawdown': str(item.max_drawdown),
            }
            for item in sorted(candidate_runs, key=lambda value: value.trading_day)
        ],
        'artifacts': {
            'candidate_report': str(candidate_report_path),
            'baseline_report': str(baseline_report_path),
            'profitability_benchmark': str(benchmark_path),
            'profitability_evidence': str(evidence_path),
            'profitability_validation': str(validation_path),
        },
    }
    passed, failed_reasons = _proof_passed(
        candidate_report_payload=candidate_report_payload,
        validation_payload=validation_payload,
        proof_payload=proof_payload,
    )
    proof_payload['passed'] = passed
    proof_payload['failed_reasons'] = failed_reasons
    proof_path = output_dir / 'profitability-proof.json'
    proof_path.write_text(json.dumps(proof_payload, indent=2), encoding='utf-8')

    summary = {
        'candidate_id': candidate_id,
        'baseline_id': inferred_baseline_id,
        'output_dir': str(output_dir),
        'profitability_proof_path': str(proof_path),
        'profitability_benchmark_path': str(benchmark_path),
        'profitability_evidence_path': str(evidence_path),
        'profitability_validation_path': str(validation_path),
        'passed': passed,
        'failed_reasons': failed_reasons,
    }
    return summary


def main() -> int:
    args = _parse_args()
    summary = build_historical_profitability_bundle(
        run_dirs=[Path(path) for path in args.run_dir],
        baseline_run_dirs=[Path(path) for path in args.baseline_run_dir],
        output_dir=Path(args.output_dir),
        hypothesis=args.hypothesis,
        baseline_id=args.baseline_id,
    )
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(json.dumps(summary))
    if not summary.get('passed'):
        raise SystemExit(1)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
