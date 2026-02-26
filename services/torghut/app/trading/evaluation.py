"""Walk-forward evaluation harness for offline backtests."""

from __future__ import annotations

import json
import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable, Protocol, cast

from ..models import Strategy
from .decisions import DecisionEngine
from .features import SignalFeatures, extract_signal_features
from .models import SignalEnvelope, StrategyDecision


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
    from .regime import classify_regime

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


def _append_profitability_reason(
    *,
    reasons: list[str],
    details: list[dict[str, object]],
    reason: str,
    payload: dict[str, object],
) -> None:
    reasons.append(reason)
    detail_payload: dict[str, object] = {"reason": reason}
    detail_payload.update(payload)
    details.append(detail_payload)


def _validate_profitability_schema_versions(
    *,
    evidence: ProfitabilityEvidenceV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    if evidence.schema_version != "profitability-evidence-v4":
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="profitability_evidence_schema_invalid",
            payload={"expected": "profitability-evidence-v4"},
        )
    if evidence.benchmark.schema_version != "profitability-benchmark-v4":
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="profitability_benchmark_schema_invalid",
            payload={"expected": "profitability-benchmark-v4"},
        )


def _validate_profitability_risk_metrics(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    market_delta = _decimal(
        evidence.risk_adjusted_metrics.get("market_net_pnl_delta")
    ) or Decimal("0")
    if market_delta < policy.min_market_net_pnl_delta:
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="market_net_pnl_delta_below_threshold",
            payload={
                "actual": str(market_delta),
                "minimum": str(policy.min_market_net_pnl_delta),
            },
        )

    return_over_drawdown = _decimal(
        evidence.risk_adjusted_metrics.get("return_over_drawdown")
    ) or Decimal("0")
    if return_over_drawdown < policy.min_risk_adjusted_return_over_drawdown:
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="risk_adjusted_return_over_drawdown_below_threshold",
            payload={
                "actual": str(return_over_drawdown),
                "minimum": str(policy.min_risk_adjusted_return_over_drawdown),
            },
        )

    regime_ratio = _decimal(
        evidence.risk_adjusted_metrics.get("regime_slice_pass_ratio")
    ) or Decimal("0")
    if regime_ratio < policy.min_regime_slice_pass_ratio:
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="regime_slice_pass_ratio_below_threshold",
            payload={
                "actual": str(regime_ratio),
                "minimum": str(policy.min_regime_slice_pass_ratio),
            },
        )


def _validate_profitability_cost_metrics(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    cost_bps = _decimal(evidence.cost_fill_realism.get("cost_bps")) or Decimal("0")
    if cost_bps <= policy.max_cost_bps:
        return
    _append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="cost_bps_exceeds_threshold",
        payload={
            "actual": str(cost_bps),
            "maximum": str(policy.max_cost_bps),
        },
    )


def _validate_profitability_confidence_metrics(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    confidence_samples = _as_int(evidence.confidence_calibration.get("sample_count")) or 0
    if confidence_samples < policy.min_confidence_samples:
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="confidence_samples_below_minimum",
            payload={
                "actual": confidence_samples,
                "minimum": policy.min_confidence_samples,
            },
        )

    calibration_error = _decimal(
        evidence.confidence_calibration.get("calibration_error")
    ) or Decimal("1")
    if calibration_error <= policy.max_calibration_error:
        return
    _append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="calibration_error_exceeds_threshold",
        payload={
            "actual": str(calibration_error),
            "maximum": str(policy.max_calibration_error),
        },
    )


def _validate_profitability_significance_metrics(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    significance = _as_dict(evidence.significance)
    schema_version = str(significance.get("schema_version", "")).strip()
    if schema_version != "significance_snapshot_v1":
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="significance_schema_invalid",
            payload={"expected": "significance_snapshot_v1"},
        )
    sample_count = _as_int(significance.get("sample_count")) or 0
    if sample_count < policy.min_significance_samples:
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="significance_samples_below_minimum",
            payload={
                "actual": sample_count,
                "minimum": policy.min_significance_samples,
            },
        )


def _validate_profitability_reproducibility(
    *,
    evidence: ProfitabilityEvidenceV4,
    policy: ProfitabilityEvidenceThresholdsV4,
    reasons: list[str],
    details: list[dict[str, object]],
) -> None:
    reproducibility = _as_dict(evidence.reproducibility)
    hashes = {
        str(key): str(value)
        for key, value in _as_dict(reproducibility.get("artifact_hashes")).items()
        if str(key).strip() and str(value).strip()
    }
    if len(hashes) < policy.min_reproducibility_hashes:
        _append_profitability_reason(
            reasons=reasons,
            details=details,
            reason="reproducibility_hash_count_below_minimum",
            payload={
                "actual": len(hashes),
                "minimum": policy.min_reproducibility_hashes,
            },
        )

    missing_hash_keys = sorted(
        [key for key in policy.required_hash_keys if key not in hashes]
    )
    if not missing_hash_keys:
        return
    _append_profitability_reason(
        reasons=reasons,
        details=details,
        reason="reproducibility_hash_keys_missing",
        payload={"missing_keys": missing_hash_keys},
    )


def _extract_report_slices(report_payload: dict[str, Any]) -> dict[str, dict[str, str]]:
    metrics = _as_dict(report_payload.get("metrics"))
    slices: dict[str, dict[str, str]] = {
        "market:all": _slice_metrics(
            net_pnl=_decimal(metrics.get("net_pnl")),
            max_drawdown=_decimal(metrics.get("max_drawdown")),
            cost_bps=_decimal(metrics.get("cost_bps")),
            turnover_ratio=_decimal(metrics.get("turnover_ratio")),
            trade_count=_as_int(metrics.get("trade_count")),
        )
    }
    robustness = _as_dict(report_payload.get("robustness"))
    folds = robustness.get("folds")
    if isinstance(folds, list):
        grouped: dict[str, list[dict[str, Any]]] = {}
        for raw in cast(list[object], folds):
            if not isinstance(raw, dict):
                continue
            fold = cast(dict[str, Any], raw)
            regime = str(fold.get("regime_label", "")).strip() or "unknown"
            grouped.setdefault(regime, []).append(fold)
        for regime, entries in grouped.items():
            net_pnl = sum(
                ((_decimal(item.get("net_pnl")) or Decimal("0")) for item in entries),
                Decimal("0"),
            )
            max_drawdown = max(
                (_decimal(item.get("max_drawdown")) or Decimal("0")) for item in entries
            )
            cost_values = [
                (_decimal(item.get("cost_bps")) or Decimal("0")) for item in entries
            ]
            turnover_values = [
                (_decimal(item.get("turnover_ratio")) or Decimal("0"))
                for item in entries
            ]
            trade_count = sum(
                (_as_int(item.get("trade_count")) or 0) for item in entries
            )
            slices[f"regime:{regime}"] = _slice_metrics(
                net_pnl=net_pnl,
                max_drawdown=max_drawdown,
                cost_bps=_decimal_mean(cost_values),
                turnover_ratio=_decimal_mean(turnover_values),
                trade_count=trade_count,
            )
    return slices


def _slice_metrics(
    *,
    net_pnl: Decimal | None,
    max_drawdown: Decimal | None,
    cost_bps: Decimal | None,
    turnover_ratio: Decimal | None,
    trade_count: int | None,
) -> dict[str, str]:
    return {
        "net_pnl": str(net_pnl or Decimal("0")),
        "max_drawdown": str(max_drawdown or Decimal("0")),
        "cost_bps": str(cost_bps or Decimal("0")),
        "turnover_ratio": str(turnover_ratio or Decimal("0")),
        "trade_count": str(trade_count or 0),
    }


def _empty_slice_metrics() -> dict[str, str]:
    return _slice_metrics(
        net_pnl=Decimal("0"),
        max_drawdown=Decimal("0"),
        cost_bps=Decimal("0"),
        turnover_ratio=Decimal("0"),
        trade_count=0,
    )


def _slice_deltas(
    candidate: dict[str, str], baseline: dict[str, str]
) -> dict[str, str]:
    candidate_net = _decimal(candidate.get("net_pnl")) or Decimal("0")
    baseline_net = _decimal(baseline.get("net_pnl")) or Decimal("0")
    candidate_dd = _decimal(candidate.get("max_drawdown")) or Decimal("0")
    baseline_dd = _decimal(baseline.get("max_drawdown")) or Decimal("0")
    candidate_cost = _decimal(candidate.get("cost_bps")) or Decimal("0")
    baseline_cost = _decimal(baseline.get("cost_bps")) or Decimal("0")
    candidate_trades = _as_int(candidate.get("trade_count")) or 0
    baseline_trades = _as_int(baseline.get("trade_count")) or 0
    return {
        "net_pnl_delta": str(candidate_net - baseline_net),
        "max_drawdown_delta": str(candidate_dd - baseline_dd),
        "cost_bps_delta": str(candidate_cost - baseline_cost),
        "trade_count_delta": str(candidate_trades - baseline_trades),
    }


def _benchmark_summary(benchmark: ProfitabilityBenchmarkV4) -> dict[str, Decimal]:
    market_delta = Decimal("0")
    regime_total = 0
    regime_pass = 0
    for slice_item in benchmark.slices:
        net_delta = _decimal(slice_item.deltas.get("net_pnl_delta")) or Decimal("0")
        if slice_item.slice_key == "market:all":
            market_delta = net_delta
        if slice_item.slice_type == "regime":
            regime_total += 1
            if net_delta >= 0:
                regime_pass += 1
    pass_ratio = _safe_ratio(Decimal(regime_pass), Decimal(regime_total))
    return {
        "market_net_pnl_delta": market_delta,
        "regime_slice_pass_ratio": pass_ratio,
    }


def _confidence_summary(
    confidence_values: list[Decimal], net_pnl: Decimal
) -> dict[str, object]:
    target_coverage = Decimal("0.90")
    calibration_target = Decimal("1") if net_pnl > 0 else Decimal("0")
    if not confidence_values:
        return {
            "sample_count": 0,
            "mean_confidence": "0",
            "std_confidence": "0",
            "calibration_target": str(calibration_target),
            "calibration_error": "1",
            "target_coverage": str(target_coverage),
            "observed_coverage": "0",
            "coverage_error": "1",
            "avg_interval_width": "0",
            "shift_state": "unknown",
            "shift_score": "1",
            "gate_action": "abstain",
            "schema_version": "calibration_snapshot_v1",
            "recalibration_run_id": None,
            "recalibration_artifact_ref": None,
        }
    mean_confidence = _decimal_mean(confidence_values)
    std_confidence = _decimal_std(confidence_values, mean_confidence)
    calibration_error = abs(mean_confidence - calibration_target)
    coverage_error = min(
        Decimal("1"),
        (calibration_error * Decimal("0.08")) + (std_confidence * Decimal("0.02")),
    )
    observed_coverage = max(Decimal("0"), target_coverage - coverage_error)
    avg_interval_width = min(
        Decimal("2"),
        Decimal("0.5") + (std_confidence * Decimal("2")) + calibration_error,
    )
    shift_score = min(
        Decimal("1"),
        abs(mean_confidence - calibration_target) + std_confidence,
    )
    if shift_score >= Decimal("0.95"):
        shift_state = "severe"
    elif shift_score >= Decimal("0.80"):
        shift_state = "high"
    elif shift_score >= Decimal("0.60"):
        shift_state = "elevated"
    else:
        shift_state = "stable"
    gate_action = "pass"
    if shift_score >= Decimal("0.95"):
        gate_action = "fail"
    elif coverage_error > Decimal("0.08") or shift_score >= Decimal("0.80"):
        gate_action = "abstain"
    elif coverage_error > Decimal("0.05") or shift_score >= Decimal("0.60"):
        gate_action = "degrade"
    return {
        "sample_count": len(confidence_values),
        "mean_confidence": str(mean_confidence),
        "std_confidence": str(std_confidence),
        "calibration_target": str(calibration_target),
        "calibration_error": str(calibration_error),
        "target_coverage": str(target_coverage),
        "observed_coverage": str(observed_coverage),
        "coverage_error": str(coverage_error),
        "avg_interval_width": str(avg_interval_width),
        "shift_state": shift_state,
        "shift_score": str(shift_score),
        "gate_action": gate_action,
        "schema_version": "calibration_snapshot_v1",
        "recalibration_run_id": None,
        "recalibration_artifact_ref": None,
    }


def _significance_summary(benchmark: ProfitabilityBenchmarkV4) -> dict[str, object]:
    deltas = [
        _decimal(item.deltas.get("net_pnl_delta")) or Decimal("0")
        for item in benchmark.slices
        if item.slice_type in {"market", "regime"}
    ]
    if not deltas:
        return {
            "schema_version": "significance_snapshot_v1",
            "sample_count": 0,
            "net_pnl_delta_mean": "0",
            "net_pnl_delta_std": "0",
            "ci_95_low": "0",
            "ci_95_high": "0",
            "p_value_two_sided": "1",
            "statistically_positive": False,
            "statistically_negative": False,
            "bootstrap_samples": 0,
        }

    mean_delta = _decimal_mean(deltas)
    std_delta = _decimal_std(deltas, mean_delta)
    bootstrap_samples = _bootstrap_mean_samples(deltas, sample_count=512)
    sorted_samples = sorted(bootstrap_samples)
    ci_low = _quantile_decimal(sorted_samples, Decimal("0.025"))
    ci_high = _quantile_decimal(sorted_samples, Decimal("0.975"))
    non_positive_count = sum(1 for value in sorted_samples if value <= 0)
    non_negative_count = sum(1 for value in sorted_samples if value >= 0)
    sample_size = max(len(sorted_samples), 1)
    p_two_sided = min(
        Decimal("1"),
        Decimal("2")
        * min(
            Decimal(non_positive_count) / Decimal(sample_size),
            Decimal(non_negative_count) / Decimal(sample_size),
        ),
    )
    return {
        "schema_version": "significance_snapshot_v1",
        "sample_count": len(deltas),
        "net_pnl_delta_mean": str(mean_delta),
        "net_pnl_delta_std": str(std_delta),
        "ci_95_low": str(ci_low),
        "ci_95_high": str(ci_high),
        "p_value_two_sided": str(p_two_sided),
        "statistically_positive": bool(ci_low > 0),
        "statistically_negative": bool(ci_high < 0),
        "bootstrap_samples": len(sorted_samples),
    }


def _bootstrap_mean_samples(
    values: list[Decimal], *, sample_count: int
) -> list[Decimal]:
    if not values:
        return []
    payload = [str(value) for value in values]
    seed = int(hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()[:16], 16)
    samples: list[Decimal] = []
    values_count = len(values)
    for _ in range(sample_count):
        sample_sum: Decimal = Decimal("0")
        for _ in range(values_count):
            seed = (1664525 * seed + 1013904223) % (2**32)
            index: int = seed % values_count
            sample_sum = sample_sum + values[index]
        sample_mean: Decimal = sample_sum / Decimal(values_count)
        samples.append(sample_mean)
    return samples


def _quantile_decimal(values: list[Decimal], quantile: Decimal) -> Decimal:
    if not values:
        return Decimal("0")
    if quantile <= 0:
        return values[0]
    if quantile >= 1:
        return values[-1]
    index = int((Decimal(len(values) - 1) * quantile).to_integral_value())
    index = max(0, min(index, len(values) - 1))
    return values[index]


def _reproducibility_payload(hashes: dict[str, str]) -> dict[str, object]:
    normalized = {
        str(key): str(value)
        for key, value in hashes.items()
        if str(key).strip() and str(value).strip()
    }
    manifest = json.dumps(sorted(normalized.items()), separators=(",", ":")).encode(
        "utf-8"
    )
    manifest_hash = hashlib.sha256(manifest).hexdigest()
    return {
        "hash_algorithm": "sha256",
        "artifact_hashes": normalized,
        "manifest_hash": manifest_hash,
    }


def _report_fold_net_pnls(report_payload: dict[str, Any]) -> list[Decimal]:
    robustness = _as_dict(report_payload.get("robustness"))
    folds = robustness.get("folds")
    if not isinstance(folds, list):
        return []
    values: list[Decimal] = []
    for raw in cast(list[object], folds):
        if not isinstance(raw, dict):
            continue
        fold = cast(dict[str, Any], raw)
        value = _decimal(fold.get("net_pnl"))
        if value is not None:
            values.append(value)
    return values


def _decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, TypeError, ValueError):
        return None


def _decimal_mean(values: list[Decimal]) -> Decimal:
    if not values:
        return Decimal("0")
    return sum(values, Decimal("0")) / Decimal(len(values))


def _decimal_std(values: list[Decimal], mean: Decimal) -> Decimal:
    if len(values) <= 1:
        return Decimal("0")
    variance = sum((value - mean) ** 2 for value in values) / Decimal(len(values))
    return variance.sqrt()


def _safe_ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= 0:
        return Decimal("0")
    return numerator / denominator


def _as_dict(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    return cast(dict[str, Any], value)


def _as_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


__all__ = [
    "FixtureSignalSource",
    "FoldResult",
    "ProfitabilityBenchmarkSliceV4",
    "ProfitabilityBenchmarkV4",
    "ProfitabilityEvidenceThresholdsV4",
    "ProfitabilityEvidenceV4",
    "ProfitabilityEvidenceValidationResultV4",
    "SignalSource",
    "WalkForwardDecision",
    "WalkForwardFold",
    "WalkForwardResults",
    "build_profitability_evidence_v4",
    "execute_profitability_benchmark_v4",
    "generate_walk_forward_folds",
    "run_walk_forward",
    "validate_profitability_evidence_v4",
    "write_walk_forward_results",
]
