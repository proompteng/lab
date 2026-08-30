"""Walk-forward evaluation harness for offline backtests."""

from __future__ import annotations

from .signal_source import (
    FillPriceErrorBudgetReportV1,
    FixtureSignalSource,
    FoldResult,
    ProfitabilityBenchmarkSliceV4,
    ProfitabilityBenchmarkV4,
    ProfitabilityEvidenceThresholdsV4,
    ProfitabilityEvidenceV4,
    ProfitabilityEvidenceValidationResultV4,
    SignalSource,
    WalkForwardDecision,
    WalkForwardFold,
    WalkForwardResults,
    build_profitability_evidence_v4,
    execute_profitability_benchmark_v4,
    generate_walk_forward_folds,
    run_walk_forward,
    validate_profitability_evidence_v4,
    write_walk_forward_results,
)
from .build_simulation_calibration_report_v1 import (
    build_fill_price_error_budget_report_v1,
)
from .numeric_helpers import (
    as_int,
    bootstrap_mean_samples,
    decimal_mean,
    decimal_std,
    quantile_decimal,
    report_fold_net_pnls,
    reproducibility_payload,
    safe_ratio,
)


__all__ = [
    "FixtureSignalSource",
    "FillPriceErrorBudgetReportV1",
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
    "as_int",
    "bootstrap_mean_samples",
    "build_fill_price_error_budget_report_v1",
    "decimal_mean",
    "decimal_std",
    "build_profitability_evidence_v4",
    "execute_profitability_benchmark_v4",
    "generate_walk_forward_folds",
    "quantile_decimal",
    "reproducibility_payload",
    "report_fold_net_pnls",
    "run_walk_forward",
    "safe_ratio",
    "validate_profitability_evidence_v4",
    "write_walk_forward_results",
]
