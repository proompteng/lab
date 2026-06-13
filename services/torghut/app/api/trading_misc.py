"""Torghut API trading misc helpers."""

from __future__ import annotations

from typing import Any

from . import trading_misc_modules as _trading_misc_modules
from .proxy import capture_module_exports

_IMPLEMENTATION_MODULES: tuple[object, ...] = getattr(
    _trading_misc_modules,
    "_IMPLEMENTATION_MODULES",
)

router: Any = getattr(_trading_misc_modules, "router")
_consumer_evidence_dependency_quorum: Any = getattr(
    _trading_misc_modules, "_consumer_evidence_dependency_quorum"
)
_build_consumer_evidence_receipt_projection: Any = getattr(
    _trading_misc_modules, "_build_consumer_evidence_receipt_projection"
)
_consumer_evidence_summary_view: Any = getattr(
    _trading_misc_modules, "_consumer_evidence_summary_view"
)
_revenue_repair_topline_fields: Any = getattr(
    _trading_misc_modules, "_revenue_repair_topline_fields"
)
_build_trading_consumer_evidence_payload: Any = getattr(
    _trading_misc_modules, "_build_trading_consumer_evidence_payload"
)
trading_consumer_evidence: Any = getattr(
    _trading_misc_modules, "trading_consumer_evidence"
)
trading_metrics: Any = getattr(_trading_misc_modules, "trading_metrics")
trading_simulation_progress: Any = getattr(
    _trading_misc_modules, "trading_simulation_progress"
)
submit_lean_backtest: Any = getattr(_trading_misc_modules, "submit_lean_backtest")
get_lean_backtest: Any = getattr(_trading_misc_modules, "get_lean_backtest")
get_lean_shadow_parity: Any = getattr(_trading_misc_modules, "get_lean_shadow_parity")
trading_autonomy: Any = getattr(_trading_misc_modules, "trading_autonomy")
_runtime_ledger_bucket_evidence_grade: Any = getattr(
    _trading_misc_modules, "_runtime_ledger_bucket_evidence_grade"
)
_daily_runtime_ledger_portfolio_summary: Any = getattr(
    _trading_misc_modules, "_daily_runtime_ledger_portfolio_summary"
)
_build_current_evidence_epoch: Any = getattr(
    _trading_misc_modules, "_build_current_evidence_epoch"
)
trading_evidence_epoch_latest: Any = getattr(
    _trading_misc_modules, "trading_evidence_epoch_latest"
)
trading_evidence_epoch_detail: Any = getattr(
    _trading_misc_modules, "trading_evidence_epoch_detail"
)
trading_empirical_jobs: Any = getattr(_trading_misc_modules, "trading_empirical_jobs")
trading_completion_doc29: Any = getattr(
    _trading_misc_modules, "trading_completion_doc29"
)
trading_completion_doc29_gate: Any = getattr(
    _trading_misc_modules, "trading_completion_doc29_gate"
)
trading_autonomy_evidence_continuity: Any = getattr(
    _trading_misc_modules, "trading_autonomy_evidence_continuity"
)
trading_llm_evaluation: Any = getattr(_trading_misc_modules, "trading_llm_evaluation")
prometheus_metrics: Any = getattr(_trading_misc_modules, "prometheus_metrics")
trading_decisions: Any = getattr(_trading_misc_modules, "trading_decisions")
trading_executions: Any = getattr(_trading_misc_modules, "trading_executions")

__all__ = (
    "router",
    "_consumer_evidence_dependency_quorum",
    "_build_consumer_evidence_receipt_projection",
    "_consumer_evidence_summary_view",
    "_revenue_repair_topline_fields",
    "_build_trading_consumer_evidence_payload",
    "trading_consumer_evidence",
    "trading_metrics",
    "trading_simulation_progress",
    "submit_lean_backtest",
    "get_lean_backtest",
    "get_lean_shadow_parity",
    "trading_autonomy",
    "_runtime_ledger_bucket_evidence_grade",
    "_daily_runtime_ledger_portfolio_summary",
    "_build_current_evidence_epoch",
    "trading_evidence_epoch_latest",
    "trading_evidence_epoch_detail",
    "trading_empirical_jobs",
    "trading_completion_doc29",
    "trading_completion_doc29_gate",
    "trading_autonomy_evidence_continuity",
    "trading_llm_evaluation",
    "prometheus_metrics",
    "trading_decisions",
    "trading_executions",
)

capture_module_exports(globals(), __all__)
