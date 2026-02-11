"""Deterministic autonomous lane: research -> gate evaluation -> paper candidate patch."""
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from ...models import Strategy
from ..evaluation import FoldResult, WalkForwardDecision, WalkForwardFold, WalkForwardResults, write_walk_forward_results
from ..features import extract_signal_features
from ..models import SignalEnvelope
from ..reporting import EvaluationReportConfig, generate_evaluation_report, write_evaluation_report
from .gates import GateInputs, GatePolicyMatrix, PromotionTarget, evaluate_gate_matrix
from .runtime import StrategyRuntime, StrategyRuntimeConfig, default_runtime_registry


@dataclass(frozen=True)
class AutonomousLaneResult:
    run_id: str
    candidate_id: str
    output_dir: Path
    gate_report_path: Path
    paper_patch_path: Path | None


def run_autonomous_lane(
    *,
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    output_dir: Path,
    promotion_target: PromotionTarget = 'paper',
    strategy_configmap_path: Path | None = None,
    code_version: str = 'local',
    approval_token: str | None = None,
    evaluated_at: datetime | None = None,
) -> AutonomousLaneResult:
    """Run deterministic phase-1/2 autonomous lane and emit artifacts."""

    signals = _load_signals(signals_path)
    runtime_strategies = load_runtime_strategy_config(strategy_config_path)
    if not signals:
        raise ValueError('signals fixture is empty')

    run_id = _deterministic_run_id(signals_path, strategy_config_path, gate_policy_path, promotion_target)
    candidate_id = f'cand-{run_id[:12]}'

    output_dir.mkdir(parents=True, exist_ok=True)
    research_dir = output_dir / 'research'
    backtest_dir = output_dir / 'backtest'
    gates_dir = output_dir / 'gates'
    paper_dir = output_dir / 'paper-candidate'
    for path in (research_dir, backtest_dir, gates_dir, paper_dir):
        path.mkdir(parents=True, exist_ok=True)

    now = evaluated_at or datetime.now(timezone.utc)
    runtime = StrategyRuntime(default_runtime_registry())
    walk_decisions: list[WalkForwardDecision] = []
    runtime_errors: list[str] = []

    for signal in sorted(signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0)):
        result = runtime.evaluate(signal, runtime_strategies)
        runtime_errors.extend(result.errors)
        features = extract_signal_features(signal)
        for decision in result.decisions:
            walk_decisions.append(WalkForwardDecision(decision=decision, features=features))

    walk_fold = WalkForwardFold(
        name='autonomous_lane',
        train_start=signals[0].event_ts,
        train_end=signals[0].event_ts,
        test_start=signals[0].event_ts,
        test_end=signals[-1].event_ts,
    )
    walk_results = WalkForwardResults(
        generated_at=now,
        folds=[FoldResult(fold=walk_fold, decisions=walk_decisions, signals_count=len(signals))],
        feature_spec='app.trading.features.normalize_feature_vector_v3',
    )

    walk_results_path = backtest_dir / 'walkforward-results.json'
    write_walk_forward_results(walk_results, walk_results_path)

    report_config = EvaluationReportConfig(
        evaluation_start=signals[0].event_ts,
        evaluation_end=signals[-1].event_ts,
        signal_source=str(signals_path),
        strategies=_to_orm_strategies(runtime_strategies),
        run_id=run_id,
        strategy_config_path=str(strategy_config_path),
        git_sha=code_version,
    )
    report = generate_evaluation_report(walk_results, config=report_config, promotion_target=promotion_target)
    evaluation_report_path = backtest_dir / 'evaluation-report.json'
    write_evaluation_report(report, evaluation_report_path)

    gate_policy = GatePolicyMatrix.from_path(gate_policy_path)
    gate_inputs = GateInputs(
        feature_schema_version='3.0.0',
        required_feature_null_rate=_required_feature_null_rate(signals),
        staleness_ms_p95=0,
        symbol_coverage=len({signal.symbol for signal in signals}),
        metrics=report.metrics.to_payload(),
        robustness=report.robustness.to_payload(),
        llm_metrics={'error_ratio': '0'},
        operational_ready=True,
        runbook_validated=True,
        kill_switch_dry_run_passed=True,
        rollback_dry_run_passed=True,
        approval_token=approval_token,
    )
    gate_report = evaluate_gate_matrix(
        gate_inputs,
        policy=gate_policy,
        promotion_target=promotion_target,
        code_version=code_version,
        evaluated_at=now,
    )

    gate_report_path = gates_dir / 'gate-evaluation.json'
    gate_report_path.write_text(json.dumps(gate_report.to_payload(), indent=2), encoding='utf-8')

    research_spec = {
        'run_id': run_id,
        'candidate_id': candidate_id,
        'promotion_target': promotion_target,
        'bounded_llm': {
            'enabled': False,
            'actuation_allowed': False,
            'notes': 'LLM path is advisory only. Deterministic risk/firewall are final authority.',
        },
        'runtime_errors': sorted(runtime_errors),
        'artifacts': {
            'walkforward_results': str(walk_results_path),
            'evaluation_report': str(evaluation_report_path),
            'gate_report': str(gate_report_path),
        },
    }
    candidate_spec_path = research_dir / 'candidate-spec.json'
    candidate_spec_path.write_text(json.dumps(research_spec, indent=2), encoding='utf-8')

    patch_path: Path | None = None
    if gate_report.promotion_allowed and gate_report.recommended_mode == 'paper':
        resolved_configmap = strategy_configmap_path or _default_strategy_configmap_path()
        patch_path = _write_paper_candidate_patch(
            configmap_path=resolved_configmap,
            runtime_strategies=runtime_strategies,
            candidate_id=candidate_id,
            output_path=paper_dir / 'strategy-configmap-patch.yaml',
        )

    return AutonomousLaneResult(
        run_id=run_id,
        candidate_id=candidate_id,
        output_dir=output_dir,
        gate_report_path=gate_report_path,
        paper_patch_path=patch_path,
    )


def load_runtime_strategy_config(path: Path) -> list[StrategyRuntimeConfig]:
    raw = path.read_text(encoding='utf-8')
    if path.suffix.lower() in {'.yaml', '.yml'}:
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)

    if isinstance(payload, dict):
        payload = payload.get('strategies', payload)
    if not isinstance(payload, list):
        raise ValueError('strategy config must be a list or include strategies key')

    strategies: list[StrategyRuntimeConfig] = []
    for index, item in enumerate(payload):
        if not isinstance(item, dict):
            raise ValueError(f'invalid strategy entry at index {index}')
        strategy_id = str(item.get('strategy_id') or item.get('name') or f'strategy-{index + 1}')
        strategy_type = str(item.get('strategy_type', 'legacy_macd_rsi'))
        version = str(item.get('version', '1.0.0'))
        params = item.get('params')
        if params is None:
            params = {
                'buy_rsi_threshold': item.get('buy_rsi_threshold', 35),
                'sell_rsi_threshold': item.get('sell_rsi_threshold', 65),
                'qty': item.get('qty', 1),
            }
        if not isinstance(params, dict):
            raise ValueError(f'params for strategy {strategy_id} must be an object')
        strategies.append(
            StrategyRuntimeConfig(
                strategy_id=strategy_id,
                strategy_type=strategy_type,
                version=version,
                params=params,
                base_timeframe=str(item.get('base_timeframe', '1Min')),
                enabled=bool(item.get('enabled', True)),
                priority=int(item.get('priority', 100)),
            )
        )

    return sorted(strategies, key=lambda item: (item.priority, item.strategy_id))


def _load_signals(path: Path) -> list[SignalEnvelope]:
    payload = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(payload, list):
        raise ValueError('signals payload must be a list')
    signals = [SignalEnvelope.model_validate(item) for item in payload]
    return sorted(signals, key=lambda item: (item.event_ts, item.symbol, item.seq or 0))


def _deterministic_run_id(
    signals_path: Path,
    strategy_config_path: Path,
    gate_policy_path: Path,
    promotion_target: PromotionTarget,
) -> str:
    hasher = hashlib.sha256()
    hasher.update(signals_path.read_bytes())
    hasher.update(strategy_config_path.read_bytes())
    hasher.update(gate_policy_path.read_bytes())
    hasher.update(promotion_target.encode('utf-8'))
    return hasher.hexdigest()[:24]


def _required_feature_null_rate(signals: list[SignalEnvelope]) -> Decimal:
    required_keys = ('macd', 'rsi', 'price')
    missing = 0
    total = 0
    for signal in signals:
        payload = signal.payload or {}
        for key in required_keys:
            total += 1
            if key == 'macd':
                macd_block = payload.get('macd')
                if not isinstance(macd_block, dict) or macd_block.get('macd') is None or macd_block.get('signal') is None:
                    missing += 1
            elif key == 'rsi':
                if payload.get('rsi14') is None and payload.get('rsi') is None:
                    missing += 1
            elif payload.get(key) is None:
                missing += 1
    if total == 0:
        return Decimal('1')
    return Decimal(missing) / Decimal(total)


def _default_strategy_configmap_path() -> Path:
    return Path(__file__).resolve().parents[5] / 'argocd' / 'applications' / 'torghut' / 'strategy-configmap.yaml'


def _to_orm_strategies(runtime_strategies: list[StrategyRuntimeConfig]) -> list[Strategy]:
    strategies: list[Strategy] = []
    for item in runtime_strategies:
        strategies.append(
            Strategy(
                name=item.strategy_id,
                description=f'{item.strategy_type}@{item.version}',
                enabled=item.enabled,
                base_timeframe=item.base_timeframe,
                universe_type='static',
                universe_symbols=None,
                max_position_pct_equity=None,
                max_notional_per_trade=None,
            )
        )
    return strategies


def _write_paper_candidate_patch(
    *,
    configmap_path: Path,
    runtime_strategies: list[StrategyRuntimeConfig],
    candidate_id: str,
    output_path: Path,
) -> Path:
    configmap_payload = yaml.safe_load(configmap_path.read_text(encoding='utf-8'))
    if not isinstance(configmap_payload, dict):
        raise ValueError('invalid configmap payload')

    candidate_strategies: list[dict[str, Any]] = []
    for strategy in runtime_strategies:
        if not strategy.enabled:
            continue
        candidate_strategies.append(
            {
                'name': strategy.strategy_id,
                'description': f'Autonomous candidate {candidate_id} ({strategy.strategy_type}@{strategy.version})',
                'enabled': True,
                'base_timeframe': strategy.base_timeframe,
                'universe_type': 'static',
                'symbols': [],
                'max_notional_per_trade': 250,
                'max_position_pct_equity': 0.025,
            }
        )

    candidate_strategies.sort(key=lambda item: str(item['name']))

    patch_payload = {
        'apiVersion': 'v1',
        'kind': 'ConfigMap',
        'metadata': {
            'name': configmap_payload.get('metadata', {}).get('name', 'torghut-strategy-config'),
            'namespace': configmap_payload.get('metadata', {}).get('namespace', 'torghut'),
            'annotations': {
                'torghut.proompteng.ai/candidate-id': candidate_id,
                'torghut.proompteng.ai/recommended-mode': 'paper',
            },
        },
        'data': {
            'strategies.yaml': yaml.safe_dump({'strategies': candidate_strategies}, sort_keys=False),
        },
    }
    output_path.write_text(yaml.safe_dump(patch_payload, sort_keys=False), encoding='utf-8')
    return output_path


__all__ = ['AutonomousLaneResult', 'load_runtime_strategy_config', 'run_autonomous_lane']
