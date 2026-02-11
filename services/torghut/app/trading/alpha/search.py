"""Parameter search utilities for offline alpha research."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Optional

import pandas as pd

from .metrics import PerformanceSummary, summarize_equity_curve
from .tsmom import TSMOMConfig, backtest_tsmom


@dataclass(frozen=True)
class CandidateConfig:
    lookback_days: int
    vol_lookback_days: int
    target_daily_vol: float
    max_gross_leverage: float


@dataclass(frozen=True)
class CandidateResult:
    config: CandidateConfig
    train: PerformanceSummary
    test: PerformanceSummary


@dataclass(frozen=True)
class SearchResult:
    best: CandidateResult
    accepted: bool
    reason: str
    candidates: list[CandidateResult]


def run_tsmom_grid_search(
    train_prices: pd.DataFrame,
    test_prices: pd.DataFrame,
    *,
    lookback_days: Iterable[int],
    vol_lookback_days: Iterable[int],
    target_daily_vols: Iterable[float],
    max_gross_leverages: Iterable[float],
    long_only: bool,
    cost_bps_per_turnover: float,
) -> SearchResult:
    candidates: list[CandidateResult] = []
    for lookback in lookback_days:
        for vol_lookback in vol_lookback_days:
            for target_vol in target_daily_vols:
                for max_gross in max_gross_leverages:
                    cfg = CandidateConfig(
                        lookback_days=int(lookback),
                        vol_lookback_days=int(vol_lookback),
                        target_daily_vol=float(target_vol),
                        max_gross_leverage=float(max_gross),
                    )
                    tsmom_cfg = TSMOMConfig(
                        lookback_days=cfg.lookback_days,
                        vol_lookback_days=cfg.vol_lookback_days,
                        target_daily_vol=cfg.target_daily_vol,
                        max_gross_leverage=cfg.max_gross_leverage,
                        long_only=long_only,
                        cost_bps_per_turnover=cost_bps_per_turnover,
                    )
                    train_equity, _ = backtest_tsmom(train_prices, tsmom_cfg)
                    test_equity, _ = backtest_tsmom(test_prices, tsmom_cfg)
                    candidates.append(
                        CandidateResult(
                            config=cfg,
                            train=summarize_equity_curve(train_equity),
                            test=summarize_equity_curve(test_equity),
                        )
                    )

    if not candidates:
        raise ValueError('no candidates generated')

    best = _select_best(candidates)
    accepted, reason = _evaluate_acceptance(best)
    return SearchResult(
        best=best,
        accepted=accepted,
        reason=reason,
        candidates=sorted(candidates, key=_ranking_key, reverse=True),
    )


def _select_best(candidates: list[CandidateResult]) -> CandidateResult:
    ranked = sorted(candidates, key=_ranking_key, reverse=True)
    return ranked[0]


def _ranking_key(item: CandidateResult) -> tuple[float, float, float]:
    return (
        _safe(item.train.sharpe),
        _safe(item.train.cagr),
        _safe(item.train.total_return),
    )


def _evaluate_acceptance(result: CandidateResult) -> tuple[bool, str]:
    test_return = result.test.total_return
    test_sharpe = result.test.sharpe
    if test_return <= 0:
        return False, 'test_total_return_non_positive'
    if (test_sharpe or 0.0) <= 0:
        return False, 'test_sharpe_non_positive'
    return True, 'accepted'


def _safe(value: Optional[float]) -> float:
    return float(value) if value is not None else float('-inf')


def summary_to_jsonable(summary: PerformanceSummary) -> dict[str, object]:
    return {
        'total_return': summary.total_return,
        'cagr': summary.cagr,
        'annualized_vol': summary.annualized_vol,
        'sharpe': summary.sharpe,
        'max_drawdown': summary.max_drawdown,
        'days': summary.days,
    }


def candidate_to_jsonable(candidate: CandidateResult) -> dict[str, object]:
    return {
        'config': {
            'lookback_days': candidate.config.lookback_days,
            'vol_lookback_days': candidate.config.vol_lookback_days,
            'target_daily_vol': candidate.config.target_daily_vol,
            'max_gross_leverage': candidate.config.max_gross_leverage,
        },
        'train': summary_to_jsonable(candidate.train),
        'test': summary_to_jsonable(candidate.test),
    }


__all__ = [
    'CandidateConfig',
    'CandidateResult',
    'SearchResult',
    'candidate_to_jsonable',
    'run_tsmom_grid_search',
]

