from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.models import Base, Execution, Strategy, TradeDecision
from app.trading.models import StrategyDecision
from app.trading.prices import MarketSnapshot
from app.trading.paper_route_target_plan import _blocked_target_readiness
from app.trading.scheduler.simple_pipeline import (
    SimpleTradingPipeline,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_metadata_from_decision,
    _quote_snapshot_reference_price,
    _quote_snapshot_matches_symbol,
    _target_metadata_quote_snapshot,
    _target_active_in_window,
    _target_probe_symbol_notional_budget,
    _target_probe_symbol_quantities,
    _target_probe_window,
    _target_runtime_account_matches,
    _target_symbols,
)
from app.trading.runtime_window_import import resolve_hypothesis_manifest
from app.trading.runtime_window_import_modules.evidence_gates import (
    RuntimePromotionInputs,
    runtime_promotion_blocking_reasons as _runtime_promotion_blocking_reasons_impl,
)
from scripts.import_hypothesis_runtime_windows import (
    POST_COST_BASIS_RUNTIME_LEDGER,
    _build_realized_strategy_pnl_rows,
    _runtime_ledger_bucket_profit_proof_present,
)


def _bounded_hpairs_target(**overrides: object) -> dict[str, object]:
    target: dict[str, object] = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "c88421d619759b2cfaa6f4d0",
        "account_label": "TORGHUT_SIM",
        "source_account_label": "TORGHUT_SIM",
        "observed_stage": "paper",
        "strategy_family": "microbar_cross_sectional_pairs",
        "strategy_name": "microbar-cross-sectional-pairs-v1",
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
        "source_kind": "paper_route_probe_runtime_observed",
        "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
        "paper_route_probe_symbols": ["AAPL", "AMZN"],
        "paper_route_probe_pair_balance_state": "balanced",
        "evidence_collection_ok": True,
        "canary_collection_authorized": True,
        "bounded_evidence_collection_authorized": True,
        "bounded_live_paper_collection_authorized": True,
        "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
        "bounded_evidence_collection_blockers": [],
        "runtime_window_import_health_gate_blockers": [],
        "paper_route_target_account_audit_state": {
            "schema_version": "torghut.paper-route-target-account-audit.v1",
            "scope": "local_torghut_sim_paper_runtime_account_state",
            "state": "available",
            "account_label": "TORGHUT_SIM",
            "required_account_label": "TORGHUT_SIM",
            "symbols": ["AAPL", "AMZN"],
            "audit_available": True,
            "blockers": [],
        },
        "paper_route_target_account_audit_blockers": [],
        "paper_route_account_pre_session_blockers": [],
        "paper_route_account_contamination_blockers": [],
        "paper_route_hpairs_symbol_blockers": [],
        "source_decision_readiness": {"ready": True, "blockers": []},
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "capital_promotion_allowed": False,
    }
    target.update(overrides)
    return target


def _routeability_decision(
    *,
    symbol: str = "AAPL",
    params: dict[str, object] | None = None,
) -> StrategyDecision:
    return StrategyDecision(
        strategy_id="00000000-0000-0000-0000-000000000001",
        symbol=symbol,
        event_ts=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
        timeframe="1Sec",
        action="buy",
        qty=Decimal("1"),
        params=params
        or {
            "paper_route_target_plan_source_decision": _bounded_hpairs_target(),
            "source_decision_mode": "bounded_paper_route_collection",
            "promotion_allowed": False,
            "final_authority_ok": False,
        },
    )


def _runtime_promotion_blocking_reasons(**inputs: Any) -> list[str]:
    return _runtime_promotion_blocking_reasons_impl(RuntimePromotionInputs(**inputs))


__all__ = [
    "Base",
    "Decimal",
    "Execution",
    "MarketSnapshot",
    "POST_COST_BASIS_RUNTIME_LEDGER",
    "Session",
    "SimpleNamespace",
    "SimpleTradingPipeline",
    "StaticPool",
    "Strategy",
    "StrategyDecision",
    "TradeDecision",
    "_blocked_target_readiness",
    "_bounded_hpairs_target",
    "_bounded_sim_collection_blockers",
    "_bounded_sim_collection_metadata_from_decision",
    "_build_realized_strategy_pnl_rows",
    "_quote_snapshot_matches_symbol",
    "_quote_snapshot_reference_price",
    "_routeability_decision",
    "_runtime_ledger_bucket_profit_proof_present",
    "_runtime_promotion_blocking_reasons",
    "_target_active_in_window",
    "_target_metadata_quote_snapshot",
    "_target_probe_symbol_notional_budget",
    "_target_probe_symbol_quantities",
    "_target_probe_window",
    "_target_runtime_account_matches",
    "_target_symbols",
    "create_engine",
    "datetime",
    "resolve_hypothesis_manifest",
    "settings",
    "timedelta",
    "timezone",
]
