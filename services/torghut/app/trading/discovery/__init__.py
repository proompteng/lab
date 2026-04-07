"""Strategy-factory discovery helpers."""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .sequential_trials import (
        SequentialTrialSummary,
        build_sequential_trial_summary,
    )
    from .validation import (
        CostCalibrationRecord,
        StrategyFactoryEvaluation,
        ValidationTestResult,
        build_strategy_factory_evaluation,
    )

__all__ = [
    'CostCalibrationRecord',
    'SequentialTrialSummary',
    'StrategyFactoryEvaluation',
    'ValidationTestResult',
    'build_sequential_trial_summary',
    'build_strategy_factory_evaluation',
]

_EXPORTS = {
    'SequentialTrialSummary': ('.sequential_trials', 'SequentialTrialSummary'),
    'build_sequential_trial_summary': ('.sequential_trials', 'build_sequential_trial_summary'),
    'CostCalibrationRecord': ('.validation', 'CostCalibrationRecord'),
    'StrategyFactoryEvaluation': ('.validation', 'StrategyFactoryEvaluation'),
    'ValidationTestResult': ('.validation', 'ValidationTestResult'),
    'build_strategy_factory_evaluation': ('.validation', 'build_strategy_factory_evaluation'),
}


def __getattr__(name: str) -> Any:
    if name not in _EXPORTS:
        raise AttributeError(f'module {__name__!r} has no attribute {name!r}')
    module_name, attribute = _EXPORTS[name]
    module = import_module(module_name, __name__)
    value = getattr(module, attribute)
    globals()[name] = value
    return value
