"""Walk-forward evaluation harness for offline backtests."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable, Protocol

from ..models import Strategy
from .decisions import DecisionEngine
from .features import SignalFeatures, extract_signal_features
from .models import SignalEnvelope, StrategyDecision


class SignalSource(Protocol):
    def fetch_signals(self, start: datetime, end: datetime) -> list[SignalEnvelope]:
        """Return signals between start (inclusive) and end (exclusive)."""


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


@dataclass
class FoldResult:
    fold: WalkForwardFold
    decisions: list[WalkForwardDecision] = field(default_factory=list)
    signals_count: int = 0

    def to_payload(self) -> dict[str, object]:
        return {
            "fold": _fold_payload(self.fold),
            "signals_count": self.signals_count,
            "decisions": [self._decision_payload(item) for item in self.decisions],
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
        signals = [SignalEnvelope.model_validate(item) for item in payload]
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
    if train_window <= timedelta(0) or test_window <= timedelta(0) or step <= timedelta(0):
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
                fold_result.decisions.append(WalkForwardDecision(decision=decision, features=features))
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


__all__ = [
    "FixtureSignalSource",
    "FoldResult",
    "SignalSource",
    "WalkForwardDecision",
    "WalkForwardFold",
    "WalkForwardResults",
    "generate_walk_forward_folds",
    "run_walk_forward",
    "write_walk_forward_results",
]
