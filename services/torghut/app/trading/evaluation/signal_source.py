"""Walk-forward evaluation harness for offline backtests."""

from __future__ import annotations

import hashlib
import importlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Protocol, cast

from ...models import Strategy
from ..decisions import DecisionEngine
from ..evidence_contracts import (
    ArtifactProvenance,
    EvidenceMaturity,
    evidence_contract_payload,
)
from ..features import SignalFeatures, extract_signal_features
from ..models import SignalEnvelope, StrategyDecision


def _bootstrap_helpers() -> Any:
    return importlib.import_module(f"{__package__}.bootstrap_mean_samples")


def _calibration_helpers() -> Any:
    return importlib.import_module(
        f"{__package__}.build_simulation_calibration_report_v1"
    )


def _decimal(value: Any) -> Decimal | None:
    return _bootstrap_helpers()._decimal(value)


def _as_dict(value: Any) -> dict[str, Any]:
    return _bootstrap_helpers()._as_dict(value)


def _as_int(value: Any) -> int | None:
    return _bootstrap_helpers()._as_int(value)


def _report_fold_net_pnls(report_payload: dict[str, Any]) -> list[Decimal]:
    return _bootstrap_helpers()._report_fold_net_pnls(report_payload)


def _decimal_mean(values: list[Decimal]) -> Decimal:
    return _bootstrap_helpers()._decimal_mean(values)


def _decimal_std(values: list[Decimal], mean: Decimal) -> Decimal:
    return _bootstrap_helpers()._decimal_std(values, mean)


def _reproducibility_payload(hashes: dict[str, str]) -> dict[str, object]:
    return _bootstrap_helpers()._reproducibility_payload(hashes)


def _safe_ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    return _bootstrap_helpers()._safe_ratio(numerator, denominator)


def _extract_report_slices(report_payload: dict[str, Any]) -> dict[str, dict[str, str]]:
    return _calibration_helpers()._extract_report_slices(report_payload)


def _empty_slice_metrics() -> dict[str, str]:
    return _calibration_helpers().empty_slice_metrics()


def _slice_deltas(
    candidate: dict[str, str],
    baseline: dict[str, str],
) -> dict[str, str]:
    return _calibration_helpers().slice_deltas(candidate, baseline)


def _benchmark_summary(benchmark: Any) -> dict[str, Decimal]:
    return _calibration_helpers().benchmark_summary(benchmark)


def _confidence_summary(
    confidence_values: list[Decimal], net_pnl: Decimal
) -> dict[str, object]:
    return _calibration_helpers().confidence_summary(confidence_values, net_pnl)


def _significance_summary(benchmark: Any) -> dict[str, object]:
    return _calibration_helpers().significance_summary(benchmark)


def _validate_profitability_schema_versions(*args: Any, **kwargs: Any) -> None:
    _calibration_helpers().validate_profitability_schema_versions(*args, **kwargs)


def _validate_profitability_risk_metrics(*args: Any, **kwargs: Any) -> None:
    _calibration_helpers().validate_profitability_risk_metrics(*args, **kwargs)


def _validate_profitability_cost_metrics(*args: Any, **kwargs: Any) -> None:
    _calibration_helpers().validate_profitability_cost_metrics(*args, **kwargs)


def _validate_profitability_confidence_metrics(*args: Any, **kwargs: Any) -> None:
    _calibration_helpers().validate_profitability_confidence_metrics(*args, **kwargs)


def _validate_profitability_significance_metrics(*args: Any, **kwargs: Any) -> None:
    _calibration_helpers().validate_profitability_significance_metrics(*args, **kwargs)


def _validate_profitability_reproducibility(*args: Any, **kwargs: Any) -> None:
    _calibration_helpers().validate_profitability_reproducibility(*args, **kwargs)


class SignalSource(Protocol):
    def fetch_signals(self, start: datetime, end: datetime) -> list[SignalEnvelope]:
        """Return signals between start (inclusive) and end (exclusive)."""
        ...


@dataclass(frozen=True)
class WalkForwardFold:
    name: str
    train_start: datetime
    train_end: datetime
    test_start: datetime
    test_end: datetime


@dataclass(frozen=True)
class WalkForwardDecision:
    decision: StrategyDecision
    features: SignalFeatures


def _empty_decisions() -> list[WalkForwardDecision]:
    return []


@dataclass
class FoldResult:
    fold: WalkForwardFold
    decisions: list[WalkForwardDecision] = field(default_factory=_empty_decisions)
    signals_count: int = 0

    def to_payload(self) -> dict[str, object]:
        regime = _fold_regime_payload(self.decisions)
        metrics = self.fold_metrics(regime=regime)
        return {
            "fold": _fold_payload(self.fold),
            "signals_count": self.signals_count,
            "metrics": metrics,
            "regime_label": regime["label"],
            "regime": regime,
            "decisions": [self._decision_payload(item) for item in self.decisions],
        }

    def fold_metrics(self, regime: dict[str, str] | None = None) -> dict[str, object]:
        resolved_regime = regime or _fold_regime_payload(self.decisions)
        action_counts = {"buy": 0, "sell": 0, "hold": 0}
        for item in self.decisions:
            action = item.decision.action
            if action in action_counts:
                action_counts[action] += 1

        return {
            "signals_count": self.signals_count,
            "decision_count": len(self.decisions),
            "buy_count": action_counts["buy"],
            "sell_count": action_counts["sell"],
            "hold_count": action_counts["hold"],
            "regime_label": resolved_regime["label"],
            "regime": resolved_regime,
        }

    @staticmethod
    def _decision_payload(item: WalkForwardDecision) -> dict[str, object]:
        return {
            "decision": item.decision.model_dump(mode="json"),
            "features": {
                "macd": _decimal_str(item.features.macd),
                "macd_signal": _decimal_str(item.features.macd_signal),
                "rsi": _decimal_str(item.features.rsi),
                "price": _decimal_str(item.features.price),
            },
        }


@dataclass
class WalkForwardResults:
    generated_at: datetime
    folds: list[FoldResult]
    feature_spec: str = "app.trading.features.extract_signal_features"

    def to_payload(self) -> dict[str, object]:
        return {
            "generated_at": self.generated_at.isoformat(),
            "feature_spec": self.feature_spec,
            "folds": [fold.to_payload() for fold in self.folds],
        }


@dataclass(frozen=True)
class FixtureSignalSource:
    signals: list[SignalEnvelope]

    @classmethod
    def from_path(cls, path: Path) -> "FixtureSignalSource":
        raw = path.read_text(encoding="utf-8")
        payload = json.loads(raw)
        if not isinstance(payload, list):
            raise ValueError("fixture payload must be a list")
        payload_list = cast(list[dict[str, Any]], payload)
        signals = [SignalEnvelope.model_validate(item) for item in payload_list]
        return cls(signals=signals)

    def fetch_signals(self, start: datetime, end: datetime) -> list[SignalEnvelope]:
        return [signal for signal in self.signals if start <= signal.event_ts < end]


def generate_walk_forward_folds(
    start: datetime,
    end: datetime,
    *,
    train_window: timedelta,
    test_window: timedelta,
    step: timedelta,
) -> list[WalkForwardFold]:
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if end <= start:
        raise ValueError("end must be after start")
    if (
        train_window <= timedelta(0)
        or test_window <= timedelta(0)
        or step <= timedelta(0)
    ):
        raise ValueError("train_window, test_window, and step must be positive")

    folds: list[WalkForwardFold] = []
    fold_index = 1
    train_start = start
    while True:
        train_end = train_start + train_window
        test_start = train_end
        test_end = test_start + test_window
        if test_end > end:
            break
        folds.append(
            WalkForwardFold(
                name=f"fold_{fold_index}",
                train_start=train_start,
                train_end=train_end,
                test_start=test_start,
                test_end=test_end,
            )
        )
        fold_index += 1
        train_start = train_start + step
    return folds


def run_walk_forward(
    folds: Iterable[WalkForwardFold],
    *,
    strategies: Iterable[Strategy],
    signal_source: SignalSource,
    decision_engine: DecisionEngine,
) -> WalkForwardResults:
    results: list[FoldResult] = []
    for fold in folds:
        signals = signal_source.fetch_signals(fold.test_start, fold.test_end)
        fold_result = FoldResult(fold=fold, signals_count=len(signals))
        for signal in signals:
            features = extract_signal_features(signal)
            for decision in decision_engine.evaluate(signal, strategies):
                fold_result.decisions.append(
                    WalkForwardDecision(decision=decision, features=features)
                )
        results.append(fold_result)

    return WalkForwardResults(generated_at=datetime.now(timezone.utc), folds=results)


def write_walk_forward_results(results: WalkForwardResults, output_path: Path) -> None:
    payload = results.to_payload()
    output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _fold_payload(fold: WalkForwardFold) -> dict[str, str]:
    return {
        "name": fold.name,
        "train_start": fold.train_start.isoformat(),
        "train_end": fold.train_end.isoformat(),
        "test_start": fold.test_start.isoformat(),
        "test_end": fold.test_end.isoformat(),
    }


def _decimal_str(value: object) -> str | None:
    if value is None:
        return None
    return str(value)


def _fold_regime_payload(decisions: list[WalkForwardDecision]) -> dict[str, str]:
    from ..regime import classify_regime

    return classify_regime(decisions).to_payload()


@dataclass(frozen=True)
class ProfitabilityBenchmarkSliceV4:
    slice_key: str
    slice_type: str
    candidate_metrics: dict[str, str]
    baseline_metrics: dict[str, str]
    deltas: dict[str, str]

    def to_payload(self) -> dict[str, object]:
        return {
            "slice_key": self.slice_key,
            "slice_type": self.slice_type,
            "candidate_metrics": dict(self.candidate_metrics),
            "baseline_metrics": dict(self.baseline_metrics),
            "deltas": dict(self.deltas),
        }


@dataclass(frozen=True)
class ProfitabilityBenchmarkV4:
    schema_version: str
    executed_at: datetime
    candidate_id: str
    baseline_id: str
    slices: list[ProfitabilityBenchmarkSliceV4]
    required_slice_keys: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "executed_at": self.executed_at.isoformat(),
            "candidate_id": self.candidate_id,
            "baseline_id": self.baseline_id,
            "required_slice_keys": list(self.required_slice_keys),
            "slices": [item.to_payload() for item in self.slices],
        }


@dataclass(frozen=True)
class ProfitabilityEvidenceV4:
    schema_version: str
    generated_at: datetime
    run_id: str
    candidate_id: str
    baseline_id: str
    risk_adjusted_metrics: dict[str, str]
    cost_fill_realism: dict[str, object]
    confidence_calibration: dict[str, object]
    significance: dict[str, object]
    reproducibility: dict[str, object]
    benchmark: ProfitabilityBenchmarkV4
    artifact_refs: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "generated_at": self.generated_at.isoformat(),
            "run_id": self.run_id,
            "candidate_id": self.candidate_id,
            "baseline_id": self.baseline_id,
            "risk_adjusted_metrics": dict(self.risk_adjusted_metrics),
            "cost_fill_realism": dict(self.cost_fill_realism),
            "confidence_calibration": dict(self.confidence_calibration),
            "significance": dict(self.significance),
            "reproducibility": dict(self.reproducibility),
            "benchmark": self.benchmark.to_payload(),
            "artifact_refs": list(self.artifact_refs),
        }


@dataclass(frozen=True)
class SimulationCalibrationReportV1:
    schema_version: str
    generated_at: datetime
    run_id: str
    candidate_id: str
    order_count: int
    expected_shortfall_sample_count: int
    expected_shortfall_coverage: Decimal
    avg_expected_shortfall_bps_p50: Decimal
    avg_expected_shortfall_bps_p95: Decimal
    avg_realized_shortfall_bps: Decimal
    avg_calibration_error_bps: Decimal
    confidence_sample_count: int
    confidence_calibration_error: Decimal
    confidence_coverage_error: Decimal
    confidence_shift_score: Decimal
    confidence_gate_action: str
    thresholds: dict[str, object]
    status: str
    artifact_authority: dict[str, object]

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "generated_at": self.generated_at.isoformat(),
            "run_id": self.run_id,
            "candidate_id": self.candidate_id,
            "order_count": self.order_count,
            "expected_shortfall_sample_count": self.expected_shortfall_sample_count,
            "expected_shortfall_coverage": str(self.expected_shortfall_coverage),
            "avg_expected_shortfall_bps_p50": str(self.avg_expected_shortfall_bps_p50),
            "avg_expected_shortfall_bps_p95": str(self.avg_expected_shortfall_bps_p95),
            "avg_realized_shortfall_bps": str(self.avg_realized_shortfall_bps),
            "avg_calibration_error_bps": str(self.avg_calibration_error_bps),
            "confidence_sample_count": self.confidence_sample_count,
            "confidence_calibration_error": str(self.confidence_calibration_error),
            "confidence_coverage_error": str(self.confidence_coverage_error),
            "confidence_shift_score": str(self.confidence_shift_score),
            "confidence_gate_action": self.confidence_gate_action,
            "thresholds": dict(self.thresholds),
            "status": self.status,
            "artifact_authority": dict(self.artifact_authority),
        }


@dataclass(frozen=True)
class ShadowLiveDeviationReportV1:
    schema_version: str
    generated_at: datetime
    run_id: str
    candidate_id: str
    order_count: int
    decision_count: int
    trade_count: int
    trade_to_decision_ratio: Decimal
    avg_abs_slippage_bps: Decimal
    avg_abs_divergence_bps: Decimal
    avg_realized_shortfall_bps_abs: Decimal
    deviation_budget_utilization: Decimal
    thresholds: dict[str, object]
    status: str
    artifact_authority: dict[str, object]

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "generated_at": self.generated_at.isoformat(),
            "run_id": self.run_id,
            "candidate_id": self.candidate_id,
            "order_count": self.order_count,
            "decision_count": self.decision_count,
            "trade_count": self.trade_count,
            "trade_to_decision_ratio": str(self.trade_to_decision_ratio),
            "avg_abs_slippage_bps": str(self.avg_abs_slippage_bps),
            "avg_abs_divergence_bps": str(self.avg_abs_divergence_bps),
            "avg_realized_shortfall_bps_abs": str(self.avg_realized_shortfall_bps_abs),
            "deviation_budget_utilization": str(self.deviation_budget_utilization),
            "thresholds": dict(self.thresholds),
            "status": self.status,
            "artifact_authority": dict(self.artifact_authority),
        }


@dataclass(frozen=True)
class FillPriceErrorBudgetReportV1:
    schema_version: str
    generated_at: datetime
    run_id: str
    venue: str
    order_count: int
    metric_observation_complete: bool
    median_abs_slippage_bps: Decimal
    p95_abs_slippage_bps: Decimal
    max_abs_slippage_bps: Decimal
    budget_median_abs_slippage_bps: Decimal
    budget_p95_abs_slippage_bps: Decimal
    status: str
    artifact_authority: dict[str, object]

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": self.schema_version,
            "generated_at": self.generated_at.isoformat(),
            "run_id": self.run_id,
            "venue": self.venue,
            "order_count": self.order_count,
            "metric_observation_complete": self.metric_observation_complete,
            "median_abs_slippage_bps": str(self.median_abs_slippage_bps),
            "p95_abs_slippage_bps": str(self.p95_abs_slippage_bps),
            "max_abs_slippage_bps": str(self.max_abs_slippage_bps),
            "budget_median_abs_slippage_bps": str(self.budget_median_abs_slippage_bps),
            "budget_p95_abs_slippage_bps": str(self.budget_p95_abs_slippage_bps),
            "status": self.status,
            "artifact_authority": dict(self.artifact_authority),
        }


@dataclass(frozen=True)
class ProfitabilityEvidenceThresholdsV4:
    min_market_net_pnl_delta: Decimal = Decimal("0")
    min_risk_adjusted_return_over_drawdown: Decimal = Decimal("0")
    min_regime_slice_pass_ratio: Decimal = Decimal("0.5")
    max_cost_bps: Decimal = Decimal("35")
    min_confidence_samples: int = 1
    min_significance_samples: int = 1
    max_calibration_error: Decimal = Decimal("0.45")
    min_reproducibility_hashes: int = 5
    required_hash_keys: tuple[str, ...] = (
        "signals",
        "strategy_config",
        "gate_policy",
        "candidate_report",
        "baseline_report",
    )

    @classmethod
    def from_payload(
        cls, payload: dict[str, Any]
    ) -> "ProfitabilityEvidenceThresholdsV4":
        return cls(
            min_market_net_pnl_delta=_decimal(payload.get("min_market_net_pnl_delta"))
            or Decimal("0"),
            min_risk_adjusted_return_over_drawdown=(
                _decimal(payload.get("min_risk_adjusted_return_over_drawdown"))
                or Decimal("0")
            ),
            min_regime_slice_pass_ratio=_decimal(
                payload.get("min_regime_slice_pass_ratio")
            )
            or Decimal("0.5"),
            max_cost_bps=_decimal(payload.get("max_cost_bps")) or Decimal("35"),
            min_confidence_samples=int(payload.get("min_confidence_samples", 1)),
            min_significance_samples=int(payload.get("min_significance_samples", 1)),
            max_calibration_error=_decimal(payload.get("max_calibration_error"))
            or Decimal("0.45"),
            min_reproducibility_hashes=int(
                payload.get("min_reproducibility_hashes", 5)
            ),
            required_hash_keys=tuple(
                str(item)
                for item in payload.get(
                    "required_hash_keys",
                    [
                        "signals",
                        "strategy_config",
                        "gate_policy",
                        "candidate_report",
                        "baseline_report",
                    ],
                )
                if isinstance(item, str)
            ),
        )

    def to_payload(self) -> dict[str, object]:
        return {
            "min_market_net_pnl_delta": str(self.min_market_net_pnl_delta),
            "min_risk_adjusted_return_over_drawdown": str(
                self.min_risk_adjusted_return_over_drawdown
            ),
            "min_regime_slice_pass_ratio": str(self.min_regime_slice_pass_ratio),
            "max_cost_bps": str(self.max_cost_bps),
            "min_confidence_samples": self.min_confidence_samples,
            "min_significance_samples": self.min_significance_samples,
            "max_calibration_error": str(self.max_calibration_error),
            "min_reproducibility_hashes": self.min_reproducibility_hashes,
            "required_hash_keys": list(self.required_hash_keys),
        }


@dataclass(frozen=True)
class ProfitabilityEvidenceValidationResultV4:
    passed: bool
    reasons: list[str]
    reason_details: list[dict[str, object]]
    artifact_refs: list[str]
    checked_at: datetime
    thresholds: ProfitabilityEvidenceThresholdsV4

    def to_payload(self) -> dict[str, object]:
        return {
            "passed": self.passed,
            "reasons": list(self.reasons),
            "reason_details": [dict(item) for item in self.reason_details],
            "artifact_refs": list(self.artifact_refs),
            "checked_at": self.checked_at.isoformat(),
            "thresholds": self.thresholds.to_payload(),
        }


def execute_profitability_benchmark_v4(
    *,
    candidate_id: str,
    baseline_id: str,
    candidate_report_payload: dict[str, Any],
    baseline_report_payload: dict[str, Any],
    required_slice_keys: list[str] | None = None,
    executed_at: datetime | None = None,
) -> ProfitabilityBenchmarkV4:
    candidate_slices = _extract_report_slices(candidate_report_payload)
    baseline_slices = _extract_report_slices(baseline_report_payload)
    keys = sorted(
        set(
            [
                *(required_slice_keys or ["market:all"]),
                *candidate_slices.keys(),
                *baseline_slices.keys(),
            ]
        )
    )
    slices: list[ProfitabilityBenchmarkSliceV4] = []
    for key in keys:
        candidate_metrics = candidate_slices.get(key, _empty_slice_metrics())
        baseline_metrics = baseline_slices.get(key, _empty_slice_metrics())
        deltas = _slice_deltas(candidate_metrics, baseline_metrics)
        slice_type = "market" if key.startswith("market:") else "regime"
        slices.append(
            ProfitabilityBenchmarkSliceV4(
                slice_key=key,
                slice_type=slice_type,
                candidate_metrics=candidate_metrics,
                baseline_metrics=baseline_metrics,
                deltas=deltas,
            )
        )

    return ProfitabilityBenchmarkV4(
        schema_version="profitability-benchmark-v4",
        executed_at=executed_at or datetime.now(timezone.utc),
        candidate_id=candidate_id,
        baseline_id=baseline_id,
        slices=slices,
        required_slice_keys=keys,
    )


def build_profitability_evidence_v4(
    *,
    run_id: str,
    candidate_id: str,
    baseline_id: str,
    candidate_report_payload: dict[str, Any],
    benchmark: ProfitabilityBenchmarkV4,
    confidence_values: list[Decimal],
    reproducibility_hashes: dict[str, str],
    artifact_refs: list[str],
    generated_at: datetime | None = None,
) -> ProfitabilityEvidenceV4:
    metrics = _as_dict(candidate_report_payload.get("metrics"))
    impact = _as_dict(candidate_report_payload.get("impact_assumptions"))
    assumptions = _as_dict(impact.get("assumptions"))
    decision_count = _as_int(metrics.get("decision_count")) or 0
    trade_count = _as_int(metrics.get("trade_count")) or 0
    cost_bps = _decimal(metrics.get("cost_bps")) or Decimal("0")
    net_pnl = _decimal(metrics.get("net_pnl")) or Decimal("0")
    max_drawdown = _decimal(metrics.get("max_drawdown")) or Decimal("0")
    return_over_drawdown = Decimal("0")
    if max_drawdown > 0:
        return_over_drawdown = net_pnl / max_drawdown

    fold_net_pnls = _report_fold_net_pnls(candidate_report_payload)
    pnl_mean = _decimal_mean(fold_net_pnls)
    pnl_std = _decimal_std(fold_net_pnls, pnl_mean)
    sharpe_like = Decimal("0")
    if pnl_std > 0:
        sharpe_like = pnl_mean / pnl_std

    benchmark_summary = _benchmark_summary(benchmark)
    confidence_summary = _confidence_summary(confidence_values, net_pnl)
    significance_summary = _significance_summary(benchmark)
    reproducibility_payload = _reproducibility_payload(reproducibility_hashes)

    return ProfitabilityEvidenceV4(
        schema_version="profitability-evidence-v4",
        generated_at=generated_at or datetime.now(timezone.utc),
        run_id=run_id,
        candidate_id=candidate_id,
        baseline_id=baseline_id,
        risk_adjusted_metrics={
            "net_pnl": str(net_pnl),
            "max_drawdown": str(max_drawdown),
            "return_over_drawdown": str(return_over_drawdown),
            "sharpe_like": str(sharpe_like),
            "regime_slice_pass_ratio": str(
                benchmark_summary["regime_slice_pass_ratio"]
            ),
            "market_net_pnl_delta": str(benchmark_summary["market_net_pnl_delta"]),
        },
        cost_fill_realism={
            "decision_count": decision_count,
            "trade_count": trade_count,
            "trade_to_decision_ratio": str(
                _safe_ratio(Decimal(trade_count), Decimal(decision_count))
            ),
            "cost_bps": str(cost_bps),
            "turnover_ratio": str(
                _decimal(metrics.get("turnover_ratio")) or Decimal("0")
            ),
            "recorded_inputs_count": _as_int(assumptions.get("recorded_inputs_count"))
            or 0,
            "fallback_inputs_count": _as_int(assumptions.get("fallback_inputs_count"))
            or 0,
            "decisions_with_spread": _as_int(impact.get("decisions_with_spread")) or 0,
            "decisions_with_volatility": _as_int(
                impact.get("decisions_with_volatility")
            )
            or 0,
            "decisions_with_adv": _as_int(impact.get("decisions_with_adv")) or 0,
        },
        confidence_calibration=confidence_summary,
        significance=significance_summary,
        reproducibility=reproducibility_payload,
        benchmark=benchmark,
        artifact_refs=sorted(set(artifact_refs)),
    )


def validate_profitability_evidence_v4(
    evidence: ProfitabilityEvidenceV4,
    *,
    thresholds: ProfitabilityEvidenceThresholdsV4 | None = None,
    checked_at: datetime | None = None,
) -> ProfitabilityEvidenceValidationResultV4:
    policy = thresholds or ProfitabilityEvidenceThresholdsV4()
    reasons: list[str] = []
    details: list[dict[str, object]] = []

    _validate_profitability_schema_versions(
        evidence=evidence,
        reasons=reasons,
        details=details,
    )
    _validate_profitability_risk_metrics(
        evidence=evidence,
        policy=policy,
        reasons=reasons,
        details=details,
    )
    _validate_profitability_cost_metrics(
        evidence=evidence,
        policy=policy,
        reasons=reasons,
        details=details,
    )
    _validate_profitability_confidence_metrics(
        evidence=evidence,
        policy=policy,
        reasons=reasons,
        details=details,
    )
    _validate_profitability_significance_metrics(
        evidence=evidence,
        policy=policy,
        reasons=reasons,
        details=details,
    )
    _validate_profitability_reproducibility(
        evidence=evidence,
        policy=policy,
        reasons=reasons,
        details=details,
    )

    return ProfitabilityEvidenceValidationResultV4(
        passed=not reasons,
        reasons=sorted(set(reasons)),
        reason_details=details,
        artifact_refs=sorted(set(evidence.artifact_refs)),
        checked_at=checked_at or datetime.now(timezone.utc),
        thresholds=policy,
    )


# Public aliases used by split-module consumers.
decimal_str = _decimal_str
empty_decisions = _empty_decisions
fold_payload = _fold_payload
fold_regime_payload = _fold_regime_payload

__all__ = (
    "SignalSource",
    "WalkForwardFold",
    "WalkForwardDecision",
    "FoldResult",
    "WalkForwardResults",
    "FixtureSignalSource",
    "generate_walk_forward_folds",
    "run_walk_forward",
    "write_walk_forward_results",
    "ProfitabilityBenchmarkSliceV4",
    "ProfitabilityBenchmarkV4",
    "ProfitabilityEvidenceV4",
    "SimulationCalibrationReportV1",
    "ShadowLiveDeviationReportV1",
    "FillPriceErrorBudgetReportV1",
    "ProfitabilityEvidenceThresholdsV4",
    "ProfitabilityEvidenceValidationResultV4",
    "execute_profitability_benchmark_v4",
    "build_profitability_evidence_v4",
    "validate_profitability_evidence_v4",
    "decimal_str",
    "empty_decisions",
    "fold_payload",
    "fold_regime_payload",
)


# Explicit module exports; keeps re-export imports intentional without file-level Ruff ignores.
__all__: tuple[str, ...] = (
    "Any",
    "ArtifactProvenance",
    "Decimal",
    "DecisionEngine",
    "EvidenceMaturity",
    "FillPriceErrorBudgetReportV1",
    "FixtureSignalSource",
    "FoldResult",
    "Iterable",
    "Path",
    "ProfitabilityBenchmarkSliceV4",
    "ProfitabilityBenchmarkV4",
    "ProfitabilityEvidenceThresholdsV4",
    "ProfitabilityEvidenceV4",
    "ProfitabilityEvidenceValidationResultV4",
    "Protocol",
    "ShadowLiveDeviationReportV1",
    "SignalEnvelope",
    "SignalFeatures",
    "SignalSource",
    "SimulationCalibrationReportV1",
    "Strategy",
    "StrategyDecision",
    "WalkForwardDecision",
    "WalkForwardFold",
    "WalkForwardResults",
    "_as_dict",
    "_as_int",
    "_benchmark_summary",
    "_bootstrap_helpers",
    "_calibration_helpers",
    "_confidence_summary",
    "_decimal",
    "_decimal_mean",
    "_decimal_std",
    "_decimal_str",
    "_empty_decisions",
    "_empty_slice_metrics",
    "_extract_report_slices",
    "_fold_payload",
    "_fold_regime_payload",
    "_report_fold_net_pnls",
    "_reproducibility_payload",
    "_safe_ratio",
    "_significance_summary",
    "_slice_deltas",
    "_validate_profitability_confidence_metrics",
    "_validate_profitability_cost_metrics",
    "_validate_profitability_reproducibility",
    "_validate_profitability_risk_metrics",
    "_validate_profitability_schema_versions",
    "_validate_profitability_significance_metrics",
    "annotations",
    "build_profitability_evidence_v4",
    "cast",
    "dataclass",
    "datetime",
    "decimal_str",
    "empty_decisions",
    "evidence_contract_payload",
    "execute_profitability_benchmark_v4",
    "extract_signal_features",
    "field",
    "fold_payload",
    "fold_regime_payload",
    "generate_walk_forward_folds",
    "hashlib",
    "importlib",
    "json",
    "run_walk_forward",
    "timedelta",
    "timezone",
    "validate_profitability_evidence_v4",
    "write_walk_forward_results",
)
