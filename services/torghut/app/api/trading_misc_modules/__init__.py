"""Explicit exports for Torghut trading misc helpers."""

from __future__ import annotations

from typing import Any

from . import shared_context as _consumer_evidence
from . import trading_autonomy as _autonomy
from . import trading_executions as _executions
from ..proxy import capture_module_exports

_IMPLEMENTATION_MODULES: tuple[object, ...] = (
    _consumer_evidence,
    _autonomy,
    _executions,
)

router: Any = getattr(_executions, "router")
_consumer_evidence_dependency_quorum: Any = getattr(
    _executions, "_consumer_evidence_dependency_quorum"
)
_build_consumer_evidence_receipt_projection: Any = getattr(
    _executions, "_build_consumer_evidence_receipt_projection"
)
_consumer_evidence_summary_view: Any = getattr(
    _executions, "_consumer_evidence_summary_view"
)
_revenue_repair_topline_fields: Any = getattr(
    _executions, "_revenue_repair_topline_fields"
)
_build_trading_consumer_evidence_payload: Any = getattr(
    _executions, "_build_trading_consumer_evidence_payload"
)
trading_consumer_evidence: Any = getattr(_executions, "trading_consumer_evidence")
trading_metrics: Any = getattr(_executions, "trading_metrics")
trading_simulation_progress: Any = getattr(_executions, "trading_simulation_progress")
submit_lean_backtest: Any = getattr(_executions, "submit_lean_backtest")
get_lean_backtest: Any = getattr(_executions, "get_lean_backtest")
get_lean_shadow_parity: Any = getattr(_executions, "get_lean_shadow_parity")
trading_autonomy: Any = getattr(_executions, "trading_autonomy")
_runtime_ledger_bucket_evidence_grade: Any = getattr(
    _executions, "_runtime_ledger_bucket_evidence_grade"
)
_daily_runtime_ledger_portfolio_summary: Any = getattr(
    _executions, "_daily_runtime_ledger_portfolio_summary"
)
_build_current_evidence_epoch: Any = getattr(
    _executions, "_build_current_evidence_epoch"
)
trading_evidence_epoch_latest: Any = getattr(
    _executions, "trading_evidence_epoch_latest"
)
trading_evidence_epoch_detail: Any = getattr(
    _executions, "trading_evidence_epoch_detail"
)
trading_empirical_jobs: Any = getattr(_executions, "trading_empirical_jobs")
trading_completion_doc29: Any = getattr(_executions, "trading_completion_doc29")
trading_completion_doc29_gate: Any = getattr(
    _executions, "trading_completion_doc29_gate"
)
trading_autonomy_evidence_continuity: Any = getattr(
    _executions, "trading_autonomy_evidence_continuity"
)
trading_llm_evaluation: Any = getattr(_executions, "trading_llm_evaluation")
prometheus_metrics: Any = getattr(_executions, "prometheus_metrics")
trading_decisions: Any = getattr(_executions, "trading_decisions")
trading_executions: Any = getattr(_executions, "trading_executions")

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
