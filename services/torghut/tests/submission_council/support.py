from __future__ import annotations


import json
import os
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Any, cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Base,
    Strategy,
    StrategyHypothesis,
    StrategyHypothesisMetricWindow,
    StrategyPromotionDecision,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from app.trading.hypotheses import JangarDependencyQuorumStatus
from app.trading.paper_route_target_summaries import _next_paper_route_target_summaries
from app.trading.paper_route_target_plan import (
    materialize_bounded_paper_route_target_plan,
)
from app.trading.runtime_decision_authority import (
    BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
    ROUTE_ACQUISITION_SOURCE_DECISION_MODE,
    source_decision_mode_is_profit_proof_eligible,
)
from app.trading.submission_council import (
    _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT,
    _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
    _PROMOTION_TABLE_COUNT_SCAN_LIMIT,
    _QUANT_HEALTH_CACHE,
    _bounded_source_collection_probe_window,
    _certificate_evidence_authority_score,
    _certificate_evidence_selection_key,
    _coerce_aware_datetime,
    _load_latest_certificate_evidence,
    _load_latest_runtime_ledger_summary,
    _attach_lineage_refs,
    _load_persisted_profit_rejection_summary,
    _load_profit_promotion_table_counts,
    _load_runtime_ledger_repair_candidates,
    _merge_runtime_certificate_evidence,
    _maybe_set_runtime_ledger_status_statement_timeout,
    _metric_window_activity_reason_codes,
    _rollback_runtime_ledger_status_session,
    _runtime_ledger_aggregate_candidate_payloads,
    _runtime_ledger_latest_payloads_per_symbol,
    _runtime_ledger_merge_count_maps,
    _runtime_ledger_paper_probation_candidates,
    _runtime_ledger_repair_reason_codes,
    _runtime_ledger_repair_score,
    _runtime_ledger_status_query_timeout_ms,
    _refresh_runtime_summary_totals,
    _runtime_ledger_paper_probation_blockers,
    _runtime_ledger_paper_probation_import_plan,
    _runtime_ledger_source_collection_candidates,
    _runtime_ledger_source_collection_target_progress_payload,
    _runtime_ledger_unique_sequence,
    build_hypothesis_runtime_summary,
    build_live_submission_gate_payload,
    load_quant_evidence_status,
    resolve_quant_health_url,
)


class _FakeQuantHealthResponse:
    def __init__(self, payload: dict[str, object], *, status: int = 200) -> None:
        self._payload = payload
        self.status = status

    def __enter__(self) -> "_FakeQuantHealthResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


class _FailingRuntimeLedgerStatusSession:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.rollback_count = 0

    def execute(self, statement: object) -> object:
        self.calls.append(str(statement))
        raise SQLAlchemyError("statement timeout")

    def rollback(self) -> None:
        self.rollback_count += 1


class _RaisingBindRuntimeLedgerStatusSession:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def get_bind(self) -> object:
        raise RuntimeError("fake bind unavailable")

    def execute(self, statement: object) -> object:
        self.calls.append(str(statement))
        return object()


class _NoRollbackRuntimeLedgerStatusSession:
    def execute(self, statement: object) -> object:
        raise SQLAlchemyError(f"statement timeout: {statement}")


class _RollbackFailingRuntimeLedgerStatusSession(_FailingRuntimeLedgerStatusSession):
    def rollback(self) -> None:
        self.rollback_count += 1
        raise SQLAlchemyError("rollback failed")


class SubmissionCouncilTestCase(TestCase):
    def setUp(self) -> None:
        self._settings_snapshot = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
            "trading_live_submit_activation_expires_at": settings.trading_live_submit_activation_expires_at,
            "trading_simple_paper_route_probe_enabled": settings.trading_simple_paper_route_probe_enabled,
            "trading_simple_paper_route_probe_allow_live_mode": settings.trading_simple_paper_route_probe_allow_live_mode,
            "trading_simple_paper_route_probe_max_notional": settings.trading_simple_paper_route_probe_max_notional,
            "trading_simple_submit_enabled": settings.trading_simple_submit_enabled,
            "trading_jangar_quant_health_url": settings.trading_jangar_quant_health_url,
            "trading_jangar_quant_health_required": settings.trading_jangar_quant_health_required,
            "trading_jangar_quant_window": settings.trading_jangar_quant_window,
            "trading_jangar_control_plane_cache_ttl_seconds": settings.trading_jangar_control_plane_cache_ttl_seconds,
            "trading_jangar_control_plane_status_url": settings.trading_jangar_control_plane_status_url,
            "trading_market_context_url": settings.trading_market_context_url,
            "trading_drift_live_promotion_max_evidence_age_seconds": settings.trading_drift_live_promotion_max_evidence_age_seconds,
        }
        _QUANT_HEALTH_CACHE.clear()
        settings.trading_enabled = True
        settings.trading_mode = "live"
        settings.trading_autonomy_enabled = False
        settings.trading_autonomy_allow_live_promotion = False
        settings.trading_kill_switch_enabled = False
        settings.trading_live_submit_activation_expires_at = None

    def tearDown(self) -> None:
        settings.trading_enabled = self._settings_snapshot["trading_enabled"]
        settings.trading_mode = self._settings_snapshot["trading_mode"]
        settings.trading_autonomy_enabled = self._settings_snapshot[
            "trading_autonomy_enabled"
        ]
        settings.trading_autonomy_allow_live_promotion = self._settings_snapshot[
            "trading_autonomy_allow_live_promotion"
        ]
        settings.trading_kill_switch_enabled = self._settings_snapshot[
            "trading_kill_switch_enabled"
        ]
        settings.trading_live_submit_activation_expires_at = self._settings_snapshot[
            "trading_live_submit_activation_expires_at"
        ]
        settings.trading_simple_paper_route_probe_enabled = self._settings_snapshot[
            "trading_simple_paper_route_probe_enabled"
        ]
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            self._settings_snapshot["trading_simple_paper_route_probe_allow_live_mode"]
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            self._settings_snapshot["trading_simple_paper_route_probe_max_notional"]
        )
        settings.trading_simple_submit_enabled = self._settings_snapshot[
            "trading_simple_submit_enabled"
        ]
        settings.trading_jangar_quant_health_url = self._settings_snapshot[
            "trading_jangar_quant_health_url"
        ]
        settings.trading_jangar_quant_health_required = self._settings_snapshot[
            "trading_jangar_quant_health_required"
        ]
        settings.trading_jangar_quant_window = self._settings_snapshot[
            "trading_jangar_quant_window"
        ]
        settings.trading_jangar_control_plane_cache_ttl_seconds = (
            self._settings_snapshot["trading_jangar_control_plane_cache_ttl_seconds"]
        )
        settings.trading_jangar_control_plane_status_url = self._settings_snapshot[
            "trading_jangar_control_plane_status_url"
        ]
        settings.trading_market_context_url = self._settings_snapshot[
            "trading_market_context_url"
        ]
        settings.trading_drift_live_promotion_max_evidence_age_seconds = (
            self._settings_snapshot[
                "trading_drift_live_promotion_max_evidence_age_seconds"
            ]
        )
        _QUANT_HEALTH_CACHE.clear()

    def _metric_window(
        self,
        capital_stage: str = "0.10x canary",
        observed_stage: str | None = "live",
        *,
        run_id: str = "runtime-proof-1",
        candidate_id: str = "cand-1",
        hypothesis_id: str = "H-CONT-01",
    ) -> SimpleNamespace:
        observed_at = datetime.now(timezone.utc)
        payload = {
            "id": "window-1",
            "run_id": run_id,
            "candidate_id": candidate_id,
            "hypothesis_id": hypothesis_id,
            "capital_stage": capital_stage,
            "window_ended_at": observed_at,
            "created_at": observed_at,
            "market_session_count": 3,
            "decision_count": 42,
            "trade_count": 42,
            "order_count": 42,
            "avg_abs_slippage_bps": "4.2",
            "slippage_budget_bps": "12",
            "post_cost_expectancy_bps": "8.5",
            "continuity_ok": True,
            "drift_ok": True,
            "dependency_quorum_decision": "allow",
            "payload_json": {
                "post_cost_promotion_sample_count": 42,
                "post_cost_basis_counts": {
                    "realized_strategy_pnl_after_explicit_costs": 42
                },
                "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                "runtime_ledger_notional_weighted_sample_count": 42,
            },
        }
        if observed_stage is not None:
            payload["observed_stage"] = observed_stage
        return SimpleNamespace(**payload)

    def _promotion_decision(
        self,
        capital_stage: str = "0.10x canary",
        *,
        run_id: str = "runtime-proof-1",
        candidate_id: str = "cand-1",
        hypothesis_id: str = "H-CONT-01",
        allowed: bool = True,
        reason_summary: str | None = None,
        payload_json: dict[str, object] | None = None,
    ) -> SimpleNamespace:
        return SimpleNamespace(
            id="promo-1",
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            promotion_target="live",
            state=capital_stage,
            allowed=allowed,
            reason_summary=reason_summary,
            payload_json=payload_json,
        )

    def _runtime_ledger_bucket_payload(
        self,
        *,
        run_id: str = "runtime-proof-1",
        candidate_id: str = "cand-1",
        hypothesis_id: str = "H-CONT-01",
        observed_stage: str = "live",
        strategy_family: str = "intraday_continuation",
    ) -> dict[str, object]:
        return {
            "run_id": run_id,
            "candidate_id": candidate_id,
            "hypothesis_id": hypothesis_id,
            "observed_stage": observed_stage,
            "bucket_started_at": datetime.now(timezone.utc).isoformat(),
            "bucket_ended_at": datetime.now(timezone.utc).isoformat(),
            "account_label": "paper",
            "runtime_strategy_name": "intraday-continuation-runtime",
            "strategy_family": strategy_family,
            "fill_count": 42,
            "decision_count": 42,
            "submitted_order_count": 42,
            "cancelled_order_count": 0,
            "rejected_order_count": 0,
            "unfilled_order_count": 0,
            "closed_trade_count": 6,
            "open_position_count": 0,
            "filled_notional": "50000",
            "gross_strategy_pnl": "75",
            "cost_amount": "15",
            "net_strategy_pnl_after_costs": "60",
            "post_cost_expectancy_bps": "12",
            "ledger_schema_version": "torghut.runtime-ledger-bucket.v1",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 42},
            "cost_model_hash_counts": {"cost": 42},
            "lineage_hash_counts": {"lineage": 42},
            "source_window_start": datetime.now(timezone.utc).isoformat(),
            "source_window_end": datetime.now(timezone.utc).isoformat(),
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_order_events": 4,
                "order_feed_source_windows": 4,
            },
            "trade_decision_ids": ["decision-buy", "decision-sell"],
            "execution_ids": ["execution-buy", "execution-sell"],
            "execution_order_event_ids": [
                "event-new-buy",
                "event-fill-buy",
                "event-new-sell",
                "event-fill-sell",
            ],
            "source_window_ids": [
                "source-window-new-buy",
                "source-window-fill-buy",
                "source-window-new-sell",
                "source-window-fill-sell",
            ],
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 102},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 103},
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            "blockers": [],
        }

    def _runtime_ledger_observed(
        self,
        *,
        run_id: str = "runtime-proof-1",
        candidate_id: str = "cand-1",
        hypothesis_id: str = "H-CONT-01",
        observed_stage: str = "live",
        strategy_family: str = "intraday_continuation",
    ) -> dict[str, object]:
        payload = self._runtime_ledger_bucket_payload(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            observed_stage=observed_stage,
            strategy_family=strategy_family,
        )
        return {
            "runtime_ledger_proof_present": True,
            "runtime_ledger_candidate_id": payload["candidate_id"],
            "runtime_ledger_observed_stage": payload["observed_stage"],
            "runtime_ledger_runtime_strategy_name": payload["runtime_strategy_name"],
            "runtime_ledger_strategy_family": payload["strategy_family"],
            "runtime_ledger_fill_count": payload["fill_count"],
            "runtime_ledger_submitted_order_count": payload["submitted_order_count"],
            "runtime_ledger_closed_trade_count": payload["closed_trade_count"],
            "runtime_ledger_open_position_count": payload["open_position_count"],
            "runtime_ledger_filled_notional": payload["filled_notional"],
            "runtime_ledger_net_strategy_pnl_after_costs": payload[
                "net_strategy_pnl_after_costs"
            ],
            "runtime_ledger_post_cost_expectancy_bps": payload[
                "post_cost_expectancy_bps"
            ],
            "runtime_ledger_blockers": payload["blockers"],
            "runtime_ledger_execution_policy_hash_count": 42,
            "runtime_ledger_cost_model_hash_count": 42,
            "runtime_ledger_lineage_hash_count": 42,
            "runtime_ledger_schema_version": payload["ledger_schema_version"],
            "runtime_ledger_pnl_basis": payload["pnl_basis"],
            "runtime_ledger_source_window_start": payload["source_window_start"],
            "runtime_ledger_source_window_end": payload["source_window_end"],
            "runtime_ledger_source_refs": payload["source_refs"],
            "runtime_ledger_source_row_counts": payload["source_row_counts"],
            "runtime_ledger_source_window_ids": payload["source_window_ids"],
            "runtime_ledger_trade_decision_ids": payload["trade_decision_ids"],
            "runtime_ledger_execution_ids": payload["execution_ids"],
            "runtime_ledger_execution_order_event_ids": payload[
                "execution_order_event_ids"
            ],
            "runtime_ledger_source_offsets": payload["source_offsets"],
            "runtime_ledger_source_materialization": payload["source_materialization"],
            "runtime_ledger_authority_class": payload["authority_class"],
        }

    def _runtime_ledger_bucket_row(
        self,
        *,
        run_id: str = "runtime-proof-1",
        candidate_id: str = "cand-1",
        hypothesis_id: str = "H-CONT-01",
        observed_stage: str = "live",
        strategy_family: str = "intraday_continuation",
        bucket_at: datetime | None = None,
    ) -> StrategyRuntimeLedgerBucket:
        payload = self._runtime_ledger_bucket_payload(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            observed_stage=observed_stage,
            strategy_family=strategy_family,
        )
        observed_at = bucket_at or datetime.now(timezone.utc)
        return StrategyRuntimeLedgerBucket(
            run_id=run_id,
            candidate_id=candidate_id,
            hypothesis_id=hypothesis_id,
            observed_stage=observed_stage,
            bucket_started_at=observed_at,
            bucket_ended_at=observed_at,
            account_label="paper",
            runtime_strategy_name=str(payload["runtime_strategy_name"]),
            strategy_family=strategy_family,
            fill_count=42,
            decision_count=42,
            submitted_order_count=42,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=6,
            open_position_count=0,
            filled_notional=Decimal("50000"),
            gross_strategy_pnl=Decimal("75"),
            cost_amount=Decimal("15"),
            net_strategy_pnl_after_costs=Decimal("60"),
            post_cost_expectancy_bps=Decimal("12"),
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
            execution_policy_hash_counts={"policy": 42},
            cost_model_hash_counts={"cost": 42},
            lineage_hash_counts={"lineage": 42},
            blockers_json=[],
            payload_json=payload,
        )

    def _healthy_quant_status(self) -> dict[str, object]:
        return {
            "required": True,
            "ok": True,
            "reason": "ready",
            "blocking_reasons": [],
            "account": "paper",
            "window": "15m",
            "status": "healthy",
            "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
        }

    def _hpairs_clean_target_plan(self) -> dict[str, Any]:
        return {
            "schema_version": "torghut.next-paper-route-runtime-window-targets.v1",
            "source": "paper_route_evidence_audit",
            "purpose": "next_session_paper_route_runtime_window_evidence_collection",
            "promotion_allowed": False,
            "final_promotion_authorized": False,
            "targets": [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
                    "strategy_name": "microbar-cross-sectional-pairs-v1",
                    "account_label": "TORGHUT_SIM",
                    "source_plan_ref": "paper-route-plan:c88421d619759b2cfaa6f4d0",
                    "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
                    "target_notional": "20",
                    "bounded_collection_stage": "paper",
                    "evidence_collection_stage": "paper",
                    "window_start": "2026-06-01T13:30:00+00:00",
                    "window_end": "2026-06-01T20:00:00+00:00",
                    "paper_route_probe_symbol_actions": {
                        "AAPL": "buy",
                        "AMZN": "sell",
                    },
                    "paper_route_probe_symbol_quantities": {
                        "AAPL": "0.10",
                        "AMZN": "0.10",
                    },
                    "paper_route_clean_window_state": "clean_window_collection_ready",
                    "paper_route_clean_window_baseline_state": {
                        "state": "clean",
                        "blockers": [],
                    },
                    "paper_route_clean_window_baseline_blockers": [],
                    "source_decision_readiness": {
                        "schema_version": "torghut.paper-route-source-decision-readiness.v1",
                        "ready": True,
                        "blockers": [],
                        "strategy_lookup_names": ["microbar-cross-sectional-pairs-v1"],
                        "matched_strategy": {
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                            "enabled": True,
                            "base_timeframe": "1Min",
                            "universe_symbols": ["AAPL", "AMZN"],
                            "max_notional_per_trade": "20",
                        },
                        "raw_probe_symbols": ["AAPL", "AMZN"],
                        "scoped_probe_symbols": ["AAPL", "AMZN"],
                    },
                    "evidence_collection_ok": True,
                    "bounded_evidence_collection_authorized": True,
                    "capital_promotion_allowed": False,
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_promotion_allowed": False,
                }
            ],
        }


__all__ = ("SubmissionCouncilTestCase",)

__all__: tuple[str, ...] = (
    "Any",
    "AutoresearchCandidateSpec",
    "AutoresearchEpoch",
    "AutoresearchPortfolioCandidate",
    "AutoresearchProposalScore",
    "BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE",
    "Base",
    "Decimal",
    "JangarDependencyQuorumStatus",
    "Mapping",
    "ROUTE_ACQUISITION_SOURCE_DECISION_MODE",
    "SQLAlchemyError",
    "SimpleNamespace",
    "StaticPool",
    "Strategy",
    "StrategyHypothesis",
    "StrategyHypothesisMetricWindow",
    "StrategyPromotionDecision",
    "StrategyRuntimeLedgerBucket",
    "SubmissionCouncilTestCase",
    "TestCase",
    "TradeDecision",
    "_CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT",
    "_FailingRuntimeLedgerStatusSession",
    "_FakeQuantHealthResponse",
    "_NoRollbackRuntimeLedgerStatusSession",
    "_PROMOTION_PORTFOLIO_READY_SCAN_LIMIT",
    "_PROMOTION_TABLE_COUNT_SCAN_LIMIT",
    "_QUANT_HEALTH_CACHE",
    "_RaisingBindRuntimeLedgerStatusSession",
    "_RollbackFailingRuntimeLedgerStatusSession",
    "_attach_lineage_refs",
    "_bounded_source_collection_probe_window",
    "_certificate_evidence_authority_score",
    "_certificate_evidence_selection_key",
    "_coerce_aware_datetime",
    "_load_latest_certificate_evidence",
    "_load_latest_runtime_ledger_summary",
    "_load_persisted_profit_rejection_summary",
    "_load_profit_promotion_table_counts",
    "_load_runtime_ledger_repair_candidates",
    "_maybe_set_runtime_ledger_status_statement_timeout",
    "_merge_runtime_certificate_evidence",
    "_metric_window_activity_reason_codes",
    "_next_paper_route_target_summaries",
    "_refresh_runtime_summary_totals",
    "_rollback_runtime_ledger_status_session",
    "_runtime_ledger_aggregate_candidate_payloads",
    "_runtime_ledger_latest_payloads_per_symbol",
    "_runtime_ledger_merge_count_maps",
    "_runtime_ledger_paper_probation_blockers",
    "_runtime_ledger_paper_probation_candidates",
    "_runtime_ledger_paper_probation_import_plan",
    "_runtime_ledger_repair_reason_codes",
    "_runtime_ledger_repair_score",
    "_runtime_ledger_source_collection_candidates",
    "_runtime_ledger_source_collection_target_progress_payload",
    "_runtime_ledger_status_query_timeout_ms",
    "_runtime_ledger_unique_sequence",
    "build_hypothesis_runtime_summary",
    "build_live_submission_gate_payload",
    "cast",
    "create_engine",
    "datetime",
    "func",
    "json",
    "load_quant_evidence_status",
    "materialize_bounded_paper_route_target_plan",
    "os",
    "patch",
    "resolve_quant_health_url",
    "select",
    "sessionmaker",
    "settings",
    "source_decision_mode_is_profit_proof_eligible",
    "timedelta",
    "timezone",
)
