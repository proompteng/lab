from __future__ import annotations

import json
import os
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
    _runtime_ledger_repair_reason_codes,
    _runtime_ledger_status_query_timeout_ms,
    _refresh_runtime_summary_totals,
    _runtime_ledger_paper_probation_blockers,
    _runtime_ledger_paper_probation_import_plan,
    _runtime_ledger_source_collection_candidates,
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


class TestSubmissionCouncil(TestCase):
    def setUp(self) -> None:
        self._settings_snapshot = {
            "trading_enabled": settings.trading_enabled,
            "trading_mode": settings.trading_mode,
            "trading_autonomy_enabled": settings.trading_autonomy_enabled,
            "trading_autonomy_allow_live_promotion": settings.trading_autonomy_allow_live_promotion,
            "trading_kill_switch_enabled": settings.trading_kill_switch_enabled,
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

    def test_hpairs_target_plan_materializes_auditable_source_decisions(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        generated_at = datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc)
        with session_local() as session:
            session.add(
                Strategy(
                    name="microbar-cross-sectional-pairs-v1",
                    description="H-PAIRS bounded paper materialization fixture",
                    enabled=True,
                    base_timeframe="1Min",
                    universe_type="static",
                    universe_symbols=["AAPL", "AMZN"],
                    max_notional_per_trade=Decimal("20"),
                )
            )
            session.commit()

            result = materialize_bounded_paper_route_target_plan(
                session,
                self._hpairs_clean_target_plan(),
                generated_at=generated_at,
                bounded_notional_limit=Decimal("25"),
            )
            session.commit()

            rows = list(
                session.execute(
                    select(TradeDecision).order_by(TradeDecision.symbol.asc())
                ).scalars()
            )

        self.assertFalse(result["promotion_allowed"])
        self.assertFalse(result["final_promotion_authorized"])
        self.assertFalse(result["live_capital_routing_enabled"])
        self.assertEqual(result["materialized_decision_count"], 2)
        self.assertEqual(result["route_submission_count"], 2)
        self.assertEqual(result["blocked_target_count"], 0)
        self.assertEqual(
            result["source_decision_mode"],
            BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
        )
        self.assertEqual(len(rows), 2)
        self.assertEqual([row.symbol for row in rows], ["AAPL", "AMZN"])
        for row in rows:
            payload = row.decision_json
            self.assertEqual(row.alpaca_account_label, "TORGHUT_SIM")
            self.assertEqual(row.status, "planned")
            self.assertEqual(
                payload["source_decision_mode"],
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE,
            )
            self.assertEqual(payload["hypothesis_id"], "H-PAIRS-01")
            self.assertEqual(payload["candidate_id"], "c88421d619759b2cfaa6f4d0")
            self.assertEqual(
                payload["runtime_strategy_name"],
                "microbar-cross-sectional-pairs-v1",
            )
            self.assertEqual(payload["account_label"], "TORGHUT_SIM")
            self.assertEqual(
                payload["source_plan_ref"],
                "paper-route-plan:c88421d619759b2cfaa6f4d0",
            )
            self.assertEqual(payload["target_notional"], "20")
            self.assertEqual(
                payload["bounded_collection_stage"],
                "bounded_paper_collection",
            )
            self.assertFalse(payload["promotion_allowed"])
            self.assertFalse(payload["final_promotion_authorized"])
            self.assertFalse(payload["live_capital_routing_enabled"])
            self.assertTrue(payload["route_submission_enabled"])
            route_submission = payload["paper_route_order_submission"]
            self.assertTrue(route_submission["submission_enabled"])
            self.assertFalse(route_submission["live_capital_routing_enabled"])
            self.assertEqual(route_submission["account_label"], "TORGHUT_SIM")
            self.assertEqual(
                route_submission["submission_authority"],
                "bounded_paper_collection_only",
            )
            self.assertEqual(
                route_submission["execution_adapter_scope"], "paper_or_sim"
            )
            self.assertEqual(
                route_submission["idempotency_key_basis"],
                "trade_decision_hash_client_order_id",
            )
            self.assertEqual(
                route_submission["order_feed_linkage_keys"],
                ["alpaca_account_label", "client_order_id"],
            )
            self.assertEqual(
                payload["target_plan_identity"]["hypothesis_id"],
                "H-PAIRS-01",
            )
            self.assertEqual(
                payload["target_plan_identity"]["candidate_id"],
                "c88421d619759b2cfaa6f4d0",
            )
            self.assertEqual(payload["target_plan_identity"]["target_notional"], "20")
            self.assertEqual(payload["target_plan_identity"]["target_quantity"], "0.20")
            self.assertEqual(
                payload["target_plan_identity"]["target_symbol_quantities"],
                {"AAPL": "0.10", "AMZN": "0.10"},
            )

    def test_hpairs_target_plan_materialization_blocks_dirty_incomplete_or_unbounded_targets(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        plan = self._hpairs_clean_target_plan()
        target_template = cast(list[dict[str, Any]], plan["targets"])[0]
        dirty_target = dict(target_template)
        dirty_target["paper_route_clean_window_baseline_state"] = {
            "state": "blocked",
            "blockers": ["paper_route_account_contamination_detected"],
        }
        missing_target = dict(target_template)
        missing_target.pop("paper_route_clean_window_baseline_state")
        wrong_account_target = dict(target_template)
        wrong_account_target["account_label"] = "paper"
        unbounded_target = dict(target_template)
        unbounded_target["target_notional"] = "250"

        with session_local() as session:
            result = materialize_bounded_paper_route_target_plan(
                session,
                {
                    **plan,
                    "targets": [
                        dirty_target,
                        missing_target,
                        wrong_account_target,
                        unbounded_target,
                    ],
                },
                generated_at=datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc),
                bounded_notional_limit=Decimal("25"),
            )
            row_count = session.execute(
                select(func.count()).select_from(TradeDecision)
            ).scalar_one()

        self.assertEqual(result["materialized_decision_count"], 0)
        self.assertEqual(result["blocked_target_count"], 4)
        self.assertEqual(row_count, 0)
        self.assertIn("paper_route_account_contamination_detected", result["blockers"])
        self.assertIn(
            "paper_route_clean_window_baseline_missing_or_dirty",
            result["blockers"],
        )
        self.assertIn(
            "paper_route_target_torghut_sim_account_required",
            result["blockers"],
        )
        self.assertIn(
            "paper_route_target_notional_exceeds_bounded_collection_limit",
            result["blockers"],
        )
        self.assertFalse(result["promotion_allowed"])
        self.assertFalse(result["final_promotion_authorized"])
        self.assertFalse(result["live_capital_routing_enabled"])

    def test_source_decision_mode_profit_proof_scope_is_bounded_paper_only(
        self,
    ) -> None:
        self.assertFalse(
            source_decision_mode_is_profit_proof_eligible(
                ROUTE_ACQUISITION_SOURCE_DECISION_MODE
            )
        )
        self.assertTrue(
            source_decision_mode_is_profit_proof_eligible(
                BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_DECISION_MODE
            )
        )

    def test_load_latest_runtime_ledger_summary_uses_latest_bucket_per_hypothesis(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        older = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        newer = datetime(2026, 3, 6, 15, 30, tzinfo=timezone.utc)

        with session_local() as session:
            empty_summary = _load_latest_runtime_ledger_summary(
                session,
                hypothesis_ids=[],
            )
            self.assertEqual(empty_summary["by_hypothesis"], {})
            self.assertEqual(empty_summary["runtime_ledger_buckets"], [])
            self.assertEqual(empty_summary["query_status"], "skipped")
            self.assertEqual(
                empty_summary["query_reason_codes"],
                ["runtime_ledger_hypothesis_scope_missing"],
            )
            self.assertEqual(
                empty_summary["query_scope"],
                "per_hypothesis_latest_runtime_ledger",
            )
            session.add_all(
                [
                    StrategyRuntimeLedgerBucket(
                        run_id="ledger-paper-newer",
                        candidate_id="cand-new",
                        hypothesis_id="H-CONT-01",
                        observed_stage="paper",
                        bucket_started_at=datetime(
                            2026, 3, 6, 15, 45, tzinfo=timezone.utc
                        ),
                        bucket_ended_at=datetime(
                            2026, 3, 6, 15, 45, tzinfo=timezone.utc
                        ),
                        account_label="paper",
                        runtime_strategy_name="paper-runtime",
                        strategy_family="intraday_continuation",
                        fill_count=55,
                        decision_count=55,
                        submitted_order_count=55,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=9,
                        open_position_count=0,
                        filled_notional=Decimal("2500"),
                        gross_strategy_pnl=Decimal("25"),
                        cost_amount=Decimal("4"),
                        net_strategy_pnl_after_costs=Decimal("21"),
                        post_cost_expectancy_bps=Decimal("9"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"paper-policy": 1},
                        cost_model_hash_counts={"paper-cost": 1},
                        lineage_hash_counts={"paper-lineage": 1},
                        blockers_json=[],
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="ledger-old",
                        candidate_id="cand-old",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        bucket_started_at=older,
                        bucket_ended_at=older,
                        account_label="paper",
                        runtime_strategy_name="old-runtime",
                        strategy_family="intraday_continuation",
                        fill_count=20,
                        decision_count=20,
                        submitted_order_count=20,
                        cancelled_order_count=1,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=4,
                        open_position_count=0,
                        filled_notional=Decimal("1000"),
                        gross_strategy_pnl=Decimal("12"),
                        cost_amount=Decimal("2"),
                        net_strategy_pnl_after_costs=Decimal("10"),
                        post_cost_expectancy_bps=Decimal("5"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"old-policy": 1},
                        cost_model_hash_counts={"old-cost": 1},
                        lineage_hash_counts={"old-lineage": 1},
                        blockers_json=[],
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="ledger-new",
                        candidate_id="cand-new",
                        hypothesis_id="H-CONT-01",
                        observed_stage="live",
                        bucket_started_at=newer,
                        bucket_ended_at=newer,
                        account_label="paper",
                        runtime_strategy_name="new-runtime",
                        strategy_family="intraday_continuation",
                        fill_count=45,
                        decision_count=45,
                        submitted_order_count=45,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=8,
                        open_position_count=0,
                        filled_notional=Decimal("2000"),
                        gross_strategy_pnl=Decimal("24"),
                        cost_amount=Decimal("4"),
                        net_strategy_pnl_after_costs=Decimal("20"),
                        post_cost_expectancy_bps=Decimal("8"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"new-policy": 1},
                        cost_model_hash_counts={"new-cost": 1},
                        lineage_hash_counts={"new-lineage": 1},
                        blockers_json=[],
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="ledger-rev",
                        candidate_id="cand-rev",
                        hypothesis_id="H-REV-01",
                        observed_stage="live",
                        bucket_started_at=newer,
                        bucket_ended_at=newer,
                        account_label="paper",
                        runtime_strategy_name="rev-runtime",
                        strategy_family="mean_reversion",
                        fill_count=40,
                        decision_count=40,
                        submitted_order_count=40,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=7,
                        open_position_count=0,
                        filled_notional=Decimal("1500"),
                        gross_strategy_pnl=Decimal("12"),
                        cost_amount=Decimal("3"),
                        net_strategy_pnl_after_costs=Decimal("9"),
                        post_cost_expectancy_bps=None,
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={},
                        cost_model_hash_counts={},
                        lineage_hash_counts={},
                        blockers_json=[],
                    ),
                ]
            )
            session.commit()

            summary = _load_latest_runtime_ledger_summary(
                session,
                hypothesis_ids=["", "H-CONT-01", "H-REV-01"],
            )

        by_hypothesis = summary["by_hypothesis"]
        self.assertIsInstance(by_hypothesis, dict)
        cont = by_hypothesis["H-CONT-01"]
        rev = by_hypothesis["H-REV-01"]
        self.assertEqual(cont["run_id"], "ledger-new")
        self.assertEqual(cont["candidate_id"], "cand-new")
        self.assertEqual(cont["submitted_order_count"], 45)
        self.assertEqual(cont["post_cost_expectancy_bps"], "8.00000000")
        self.assertEqual(cont["execution_policy_hash_counts"], {"new-policy": 1})
        self.assertIsNone(rev["post_cost_expectancy_bps"])
        self.assertGreaterEqual(len(summary["runtime_ledger_buckets"]), 4)

    def test_load_latest_runtime_ledger_summary_fails_closed_on_query_timeout(
        self,
    ) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        summary = _load_latest_runtime_ledger_summary(
            fake_session,  # type: ignore[arg-type]
            hypothesis_ids=["H-PAIRS-01"],
        )

        self.assertEqual(summary["by_hypothesis"], {})
        self.assertEqual(summary["runtime_ledger_buckets"], [])
        self.assertEqual(summary["query_status"], "timeout")
        self.assertTrue(summary["read_model_unavailable"])
        self.assertEqual(
            summary["query_reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(
            summary["reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(fake_session.rollback_count, 1)

    def test_load_latest_certificate_evidence_fails_closed_on_window_timeout(
        self,
    ) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        evidence = _load_latest_certificate_evidence(
            fake_session,  # type: ignore[arg-type]
            hypothesis_ids=["H-PAIRS-01"],
        )

        self.assertEqual(fake_session.rollback_count, 1)
        self.assertEqual(evidence[0]["hypothesis_id"], "H-PAIRS-01")
        self.assertIsNone(evidence[0]["metric_window"])
        self.assertIsNone(evidence[0]["promotion_decision"])
        self.assertIsNone(evidence[0]["runtime_ledger_bucket"])
        self.assertTrue(evidence[0]["read_model_unavailable"])
        self.assertEqual(evidence[0]["query_status"], "timeout")
        self.assertEqual(
            evidence[0]["query_reason_codes"], ["certificate_evidence_query_timeout"]
        )
        self.assertEqual(
            evidence[0]["reason_codes"], ["certificate_evidence_query_timeout"]
        )

    def test_load_latest_certificate_evidence_fails_closed_on_promotion_timeout(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime(2026, 6, 1, tzinfo=timezone.utc)

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-PAIRS-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=15),
                    window_ended_at=now,
                    market_session_count=1,
                    decision_count=1,
                    trade_count=1,
                    order_count=1,
                    post_cost_expectancy_bps="1.0",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="shadow",
                    payload_json={},
                )
            )
            session.commit()

            execute = session.execute

            def fail_promotion_decision_query(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                if "strategy_promotion_decisions" in str(statement):
                    raise SQLAlchemyError("statement timeout")
                return execute(statement, *args, **kwargs)

            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=fail_promotion_decision_query,
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                evidence = _load_latest_certificate_evidence(
                    session,
                    hypothesis_ids=["H-PAIRS-01"],
                    now=now,
                )

        self.assertEqual(rollback.call_count, 1)
        self.assertEqual(evidence[0]["hypothesis_id"], "H-PAIRS-01")
        self.assertIsNone(evidence[0]["metric_window"])
        self.assertIsNone(evidence[0]["promotion_decision"])
        self.assertIsNone(evidence[0]["runtime_ledger_bucket"])
        self.assertTrue(evidence[0]["read_model_unavailable"])
        self.assertEqual(evidence[0]["query_status"], "timeout")
        self.assertEqual(
            evidence[0]["query_reason_codes"], ["certificate_evidence_query_timeout"]
        )
        self.assertEqual(
            evidence[0]["reason_codes"], ["certificate_evidence_query_timeout"]
        )

    def test_load_latest_certificate_evidence_uses_bounded_status_reads(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            execute = session.execute
            statements: list[str] = []

            def capture_execute(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                statements.append(str(statement))
                return execute(statement, *args, **kwargs)

            with patch.object(session, "execute", side_effect=capture_execute):
                evidence = _load_latest_certificate_evidence(
                    session,
                    hypothesis_ids=["H-PAIRS-01", "H-REV-01"],
                )

        self.assertEqual(len(evidence), 2)
        bounded_limit = 2 * _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT
        self.assertTrue(
            any(
                "FROM strategy_hypothesis_metric_windows" in statement
                and "LIMIT" in statement
                for statement in statements
            )
        )
        self.assertTrue(
            all(
                row["reason_codes"] == ["hypothesis_window_evidence_missing"]
                for row in evidence
            )
        )
        self.assertTrue(
            all(
                row["query_limit_per_hypothesis"]
                == _CERTIFICATE_EVIDENCE_PER_HYPOTHESIS_LIMIT
                for row in evidence
            )
        )
        self.assertGreaterEqual(bounded_limit, 1)

    def test_attach_lineage_refs_fails_closed_on_query_timeout(self) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        rows = _attach_lineage_refs(
            fake_session,  # type: ignore[arg-type]
            evaluated_rows=[
                {
                    "candidate_id": "candidate-timeout",
                    "hypothesis_id": "H-TIMEOUT",
                    "reason_codes": [],
                }
            ],
        )

        self.assertEqual(fake_session.rollback_count, 1)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["reason_codes"], ["lineage_ref_query_timeout"])
        self.assertEqual(rows[0]["lineage_ref"]["status"], "unavailable")
        self.assertEqual(rows[0]["lineage_ref"]["candidate_id"], "candidate-timeout")
        self.assertEqual(rows[0]["lineage_ref"]["hypothesis_id"], "H-TIMEOUT")

    def test_load_persisted_profit_rejection_summary_fails_closed_on_timeout(
        self,
    ) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        summary = _load_persisted_profit_rejection_summary(
            fake_session,  # type: ignore[arg-type]
            account_label="PA3SX7FYNUTF",
            now=datetime(2026, 6, 1, tzinfo=timezone.utc),
        )

        self.assertEqual(fake_session.rollback_count, 1)
        self.assertEqual(summary["total"], 0)
        self.assertIsNone(summary["rejection_drag_ratio"])
        self.assertEqual(summary["status_totals"], {})
        self.assertEqual(
            summary["reason_codes"],
            ["profit_rejection_summary_query_timeout"],
        )

    def test_runtime_ledger_status_timeout_helper_applies_timeout_when_bind_lookup_fails(
        self,
    ) -> None:
        fake_session = _RaisingBindRuntimeLedgerStatusSession()

        _maybe_set_runtime_ledger_status_statement_timeout(
            fake_session,  # type: ignore[arg-type]
        )

        self.assertEqual(
            fake_session.calls,
            ["SET LOCAL statement_timeout = 2500"],
        )

    def test_runtime_ledger_status_timeout_helper_uses_configured_timeout(
        self,
    ) -> None:
        fake_session = _RaisingBindRuntimeLedgerStatusSession()

        with patch.dict(
            os.environ,
            {"TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS": "3250"},
        ):
            _maybe_set_runtime_ledger_status_statement_timeout(
                fake_session,  # type: ignore[arg-type]
            )

        self.assertEqual(
            fake_session.calls,
            ["SET LOCAL statement_timeout = 3250"],
        )

    def test_runtime_ledger_status_timeout_helper_bounds_configured_timeout(
        self,
    ) -> None:
        with patch.dict(
            os.environ,
            {"TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS": "25"},
        ):
            self.assertEqual(_runtime_ledger_status_query_timeout_ms(), 500)

        with patch.dict(
            os.environ,
            {"TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS": "25000"},
        ):
            self.assertEqual(_runtime_ledger_status_query_timeout_ms(), 10000)

        with patch.dict(
            os.environ,
            {"TORGHUT_RUNTIME_LEDGER_STATUS_QUERY_TIMEOUT_MS": "not-an-int"},
        ):
            self.assertEqual(_runtime_ledger_status_query_timeout_ms(), 2500)

    def test_runtime_ledger_status_rollback_helper_ignores_missing_rollback(
        self,
    ) -> None:
        _rollback_runtime_ledger_status_session(
            _NoRollbackRuntimeLedgerStatusSession(),  # type: ignore[arg-type]
        )

    def test_load_latest_runtime_ledger_summary_fails_closed_when_rollback_fails(
        self,
    ) -> None:
        fake_session = _RollbackFailingRuntimeLedgerStatusSession()

        summary = _load_latest_runtime_ledger_summary(
            fake_session,  # type: ignore[arg-type]
            hypothesis_ids=["H-PAIRS-01"],
        )

        self.assertEqual(summary["by_hypothesis"], {})
        self.assertEqual(summary["runtime_ledger_buckets"], [])
        self.assertEqual(summary["query_status"], "timeout")
        self.assertTrue(summary["read_model_unavailable"])
        self.assertEqual(
            summary["query_reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(
            summary["reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(fake_session.rollback_count, 1)

    def test_load_runtime_ledger_repair_candidates_fails_closed_on_query_timeout(
        self,
    ) -> None:
        fake_session = _FailingRuntimeLedgerStatusSession()

        candidates = _load_runtime_ledger_repair_candidates(
            fake_session,  # type: ignore[arg-type]
            registry_items=[
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "candidate",
                    "strategy_family": "microbar_cross_sectional_pairs",
                }
            ],
        )

        self.assertEqual(candidates, [])
        self.assertEqual(fake_session.rollback_count, 1)

    def test_build_live_submission_gate_payload_surfaces_runtime_ledger_repair_candidates(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)

        class _RegistryItem:
            def __init__(
                self,
                *,
                hypothesis_id: str,
                candidate_id: str,
                strategy_id: str,
                strategy_family: str,
                segment_dependencies: list[str] | None = None,
                paper_probation_candidate_ids: list[str] | None = None,
            ) -> None:
                self.hypothesis_id = hypothesis_id
                self._payload = {
                    "hypothesis_id": hypothesis_id,
                    "candidate_id": candidate_id,
                    "paper_probation_candidate_ids": list(
                        paper_probation_candidate_ids or []
                    ),
                    "strategy_id": strategy_id,
                    "strategy_family": strategy_family,
                    "lane_id": strategy_family,
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                    "segment_dependencies": list(segment_dependencies or []),
                }

            def model_dump(self, *, mode: str = "json") -> dict[str, object]:
                return dict(self._payload)

        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[
                _RegistryItem(
                    hypothesis_id="H-CONT-01",
                    candidate_id="chip-paper-microbar-composite@execution-proof",
                    strategy_id="microbar_volume_continuation_long_top2_chip_v1@paper",
                    strategy_family="intraday_continuation",
                ),
                _RegistryItem(
                    hypothesis_id="H-PAIRS-01",
                    candidate_id="c88421d619759b2cfaa6f4d0",
                    strategy_id="microbar_cross_sectional_pairs_v1@research",
                    strategy_family="microbar_cross_sectional_pairs",
                    paper_probation_candidate_ids=[
                        "c88421d619759b2cfaa6f4d0",
                        "3e49d7da73ac2456c3eecb02",
                    ],
                ),
                _RegistryItem(
                    hypothesis_id="H-REV-01",
                    candidate_id="rev-candidate",
                    strategy_id="microbar_prev_day_open45_reversal_long_top1_chip_v1@paper",
                    strategy_family="event_reversion",
                    segment_dependencies=["market-context"],
                ),
            ],
        )

        with session_local() as session:
            pairs_source_payload = {
                "source_window_start": (now - timedelta(minutes=45)).isoformat(),
                "source_window_end": (now - timedelta(minutes=30)).isoformat(),
                "source_refs": [
                    "strategy_runtime_ledger_buckets:pairs-realized-runtime",
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 2,
                    "strategy_runtime_ledger_buckets": 1,
                    "order_feed_source_windows": 2,
                },
                "trade_decision_ids": ["pairs-decision-buy", "pairs-decision-sell"],
                "execution_ids": ["pairs-execution-buy", "pairs-execution-sell"],
                "execution_order_event_ids": [
                    "pairs-event-new-buy",
                    "pairs-event-fill-buy",
                ],
                "source_window_ids": [
                    "pairs-source-window-buy",
                    "pairs-source-window-sell",
                ],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            }
            reversal_source_payload = {
                "source_window_start": (now - timedelta(minutes=75)).isoformat(),
                "source_window_end": (now - timedelta(minutes=60)).isoformat(),
                "source_refs": [
                    "strategy_runtime_ledger_buckets:pairs-reversal-runtime",
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 1,
                    "executions": 1,
                    "execution_order_events": 1,
                    "strategy_runtime_ledger_buckets": 1,
                    "order_feed_source_windows": 1,
                },
                "trade_decision_ids": ["reversal-decision"],
                "execution_ids": ["reversal-execution"],
                "execution_order_event_ids": ["reversal-event-fill"],
                "source_window_ids": ["reversal-source-window"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 200}
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            }
            session.add_all(
                [
                    StrategyRuntimeLedgerBucket(
                        run_id="cont-zero-fill",
                        candidate_id="chip-paper-microbar-composite@execution-proof",
                        hypothesis_id="H-CONT-01",
                        observed_stage="paper",
                        bucket_started_at=now - timedelta(minutes=30),
                        bucket_ended_at=now - timedelta(minutes=15),
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name="microbar-volume-continuation-long-top2-chip-v1",
                        strategy_family="intraday_continuation",
                        fill_count=0,
                        decision_count=9,
                        submitted_order_count=9,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=9,
                        closed_trade_count=0,
                        open_position_count=0,
                        filled_notional=Decimal("0"),
                        gross_strategy_pnl=Decimal("0"),
                        cost_amount=Decimal("0"),
                        net_strategy_pnl_after_costs=Decimal("0"),
                        post_cost_expectancy_bps=None,
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={},
                        cost_model_hash_counts={},
                        lineage_hash_counts={},
                        blockers_json=["zero_fill_runtime_ledger"],
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="pairs-realized-runtime",
                        candidate_id="c88421d619759b2cfaa6f4d0",
                        hypothesis_id="H-PAIRS-01",
                        observed_stage="paper",
                        bucket_started_at=now - timedelta(minutes=45),
                        bucket_ended_at=now - timedelta(minutes=30),
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name="microbar-pairs-vwap-cap-safe",
                        strategy_family="microbar_cross_sectional_pairs",
                        fill_count=2,
                        decision_count=2,
                        submitted_order_count=2,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=2,
                        open_position_count=0,
                        filled_notional=Decimal("127090.02495200"),
                        gross_strategy_pnl=Decimal("581.44720578"),
                        cost_amount=Decimal("14"),
                        net_strategy_pnl_after_costs=Decimal("567.44720578"),
                        post_cost_expectancy_bps=Decimal("44.64923238"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy": 2},
                        cost_model_hash_counts={"cost": 2},
                        lineage_hash_counts={"lineage": 2},
                        blockers_json=[],
                        payload_json=pairs_source_payload,
                    ),
                    StrategyRuntimeLedgerBucket(
                        run_id="pairs-reversal-runtime",
                        candidate_id="3e49d7da73ac2456c3eecb02",
                        hypothesis_id="H-PAIRS-01",
                        observed_stage="paper",
                        bucket_started_at=now - timedelta(minutes=75),
                        bucket_ended_at=now - timedelta(minutes=60),
                        account_label="TORGHUT_SIM",
                        runtime_strategy_name="microbar-pairs-vwap-reversal",
                        strategy_family="microbar_cross_sectional_pairs",
                        fill_count=1,
                        decision_count=1,
                        submitted_order_count=1,
                        cancelled_order_count=0,
                        rejected_order_count=0,
                        unfilled_order_count=0,
                        closed_trade_count=1,
                        open_position_count=0,
                        filled_notional=Decimal("316509.62015600"),
                        gross_strategy_pnl=Decimal("555.25627600"),
                        cost_amount=Decimal("123.22325790"),
                        net_strategy_pnl_after_costs=Decimal("432.03301810"),
                        post_cost_expectancy_bps=Decimal("13.64991743"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy": 1},
                        cost_model_hash_counts={"cost": 1},
                        lineage_hash_counts={"lineage": 1},
                        blockers_json=[],
                        payload_json=reversal_source_payload,
                    ),
                ]
            )
            session.commit()

            with patch(
                "app.trading.submission_council.load_hypothesis_registry",
                return_value=registry,
            ):
                gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=True,
                        last_autonomy_promotion_eligible=False,
                        last_autonomy_promotion_action=None,
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                        last_market_context_domain_states={"news": "stale"},
                        market_context_alert_active=True,
                        market_context_alert_reason="market_context_stale",
                        metrics=SimpleNamespace(
                            feature_batch_rows_total=9,
                            feature_null_rate={"price": 0.0},
                            feature_staleness_ms_p95=250,
                            feature_duplicate_ratio=0.0,
                            decision_state_total={},
                        ),
                    ),
                    hypothesis_summary={
                        "summary": {
                            "promotion_eligible_total": 0,
                            "capital_stage_totals": {"shadow": 2},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        "items": [],
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    dspy_runtime_status={"mode": "inactive"},
                    quant_health_status=self._healthy_quant_status(),
                    promotion_certificate_evidence=[
                        {
                            "hypothesis_id": "H-PAIRS-01",
                            "metric_window": self._metric_window(
                                observed_stage="paper",
                                run_id="pairs-paper-window",
                                candidate_id="c88421d619759b2cfaa6f4d0",
                                hypothesis_id="H-PAIRS-01",
                            ),
                            "promotion_decision": self._promotion_decision(
                                run_id="pairs-paper-window",
                                candidate_id="c88421d619759b2cfaa6f4d0",
                                hypothesis_id="H-PAIRS-01",
                            ),
                        },
                        {
                            "hypothesis_id": "H-REV-01",
                            "metric_window": self._metric_window(
                                observed_stage="paper",
                                run_id="rev-paper-window",
                                candidate_id="rev-candidate",
                                hypothesis_id="H-REV-01",
                            ),
                            "promotion_decision": self._promotion_decision(
                                run_id="rev-paper-window",
                                candidate_id="rev-candidate",
                                hypothesis_id="H-REV-01",
                            ),
                        },
                    ],
                    session=session,
                )

        candidates = gate["runtime_ledger_repair_candidates"]
        self.assertIsInstance(candidates, list)
        self.assertEqual(candidates[0]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(candidates[0]["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(candidates[0]["net_strategy_pnl_after_costs"], "567.44720578")
        self.assertEqual(
            candidates[0]["promotion_authority"], "runtime_ledger_candidate_only"
        )
        self.assertIn("runtime_ledger_stage_not_live", candidates[0]["reason_codes"])
        self.assertNotIn(
            "runtime_ledger_source_window_missing",
            candidates[0]["reason_codes"],
        )
        self.assertNotIn(
            "runtime_ledger_source_refs_missing",
            candidates[0]["reason_codes"],
        )
        self.assertNotIn(
            "runtime_ledger_candidate_mismatch", candidates[0]["reason_codes"]
        )
        self.assertEqual(
            candidates[0]["source_refs"],
            [
                "strategy_runtime_ledger_buckets:pairs-realized-runtime",
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
        )
        paper_candidates = gate["runtime_ledger_paper_probation_candidates"]
        self.assertEqual(gate["paper_probation_eligible_total"], 2)
        self.assertEqual(gate["runtime_ledger_paper_probation_eligible_total"], 2)
        self.assertIn(
            "paper_probation_evidence_collection_only", gate["blocked_reasons"]
        )
        self.assertNotIn("segment_market-context_blocked", gate["blocked_reasons"])
        self.assertNotIn("market_context_stale", gate["blocked_reasons"])
        self.assertNotIn("market_context_domain_news_stale", gate["blocked_reasons"])
        self.assertEqual(len(paper_candidates), 2)
        self.assertEqual(paper_candidates[0]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(paper_candidates[1]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(
            paper_candidates[1]["candidate_id"], "3e49d7da73ac2456c3eecb02"
        )
        self.assertEqual(
            paper_candidates[0]["paper_probation_scope"], "evidence_collection_only"
        )
        self.assertEqual(paper_candidates[0]["proof_mode"], "probation")
        self.assertTrue(paper_candidates[0]["evidence_collection_ok"])
        self.assertTrue(paper_candidates[0]["canary_collection_authorized"])
        self.assertTrue(paper_candidates[0]["bounded_live_paper_collection_authorized"])
        self.assertFalse(paper_candidates[0]["capital_promotion_allowed"])
        self.assertFalse(paper_candidates[0]["final_authority_ok"])
        self.assertFalse(paper_candidates[0]["final_promotion_allowed"])
        self.assertEqual(paper_candidates[0]["max_notional"], "0")
        import_plan = gate["runtime_ledger_paper_probation_import_plan"]
        self.assertIsInstance(import_plan, dict)
        self.assertEqual(
            import_plan["schema_version"],
            "torghut.runtime-ledger-paper-probation-import-plan.v1",
        )
        self.assertEqual(import_plan["target_count"], 2)
        self.assertEqual(import_plan["skipped_target_count"], 0)
        self.assertEqual(import_plan["proof_mode"], "probation")
        self.assertTrue(import_plan["evidence_collection_ok"])
        self.assertTrue(import_plan["canary_collection_authorized"])
        self.assertTrue(import_plan["bounded_live_paper_collection_authorized"])
        self.assertFalse(import_plan["capital_promotion_allowed"])
        self.assertFalse(import_plan["final_authority_ok"])
        self.assertFalse(import_plan["final_promotion_allowed"])
        target = import_plan["targets"][0]
        self.assertEqual(target["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(target["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(target["observed_stage"], "paper")
        self.assertEqual(target["strategy_family"], "microbar_cross_sectional_pairs")
        self.assertEqual(target["strategy_name"], "microbar-pairs-vwap-cap-safe")
        self.assertEqual(
            target["runtime_strategy_name"], "microbar-pairs-vwap-cap-safe"
        )
        self.assertIn("microbar-pairs-vwap-cap-safe", target["strategy_lookup_names"])
        self.assertEqual(target["account_label"], "TORGHUT_SIM")
        self.assertEqual(
            import_plan["targets"][1]["candidate_id"], "3e49d7da73ac2456c3eecb02"
        )
        self.assertEqual(
            import_plan["targets"][1]["strategy_name"],
            "microbar-pairs-vwap-reversal",
        )
        self.assertEqual(
            target["source_dsn_env"], "TORGHUT_DURABLE_RUNTIME_LEDGER_SOURCE_DSN"
        )
        self.assertEqual(target["source_kind"], "durable_runtime_ledger_bucket")
        self.assertEqual(
            target["source_manifest_ref"], "config/trading/hypotheses/h-pairs-01.json"
        )
        self.assertEqual(
            target["dataset_snapshot_ref"], "portfolio-profit-autoresearch-500-v1"
        )
        self.assertEqual(target["paper_probation_authorized"], True)
        self.assertEqual(
            target["paper_probation_authorization_scope"],
            "evidence_collection_only",
        )
        self.assertEqual(target["proof_mode"], "probation")
        self.assertTrue(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertTrue(target["evidence_collection_ok"])
        self.assertTrue(target["canary_collection_authorized"])
        self.assertTrue(target["bounded_live_paper_collection_authorized"])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertFalse(target["final_authority_ok"])
        self.assertEqual(target["promotion_allowed"], False)
        self.assertEqual(target["final_promotion_authorized"], False)
        self.assertEqual(target["final_promotion_allowed"], False)
        self.assertIn("runtime_ledger_stage_not_live", target["candidate_blockers"])
        self.assertIn(
            "live_runtime_ledger_required", target["final_promotion_blockers"]
        )
        self.assertNotIn("runtime_ledger_artifact_refs", target)
        self.assertNotIn("runtime_ledger_artifact_row_count", target)
        self.assertEqual(candidates[1]["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(candidates[1]["candidate_id"], "3e49d7da73ac2456c3eecb02")
        self.assertTrue(
            any(candidate["hypothesis_id"] == "H-CONT-01" for candidate in candidates)
        )

    def test_runtime_ledger_repair_reason_codes_require_source_authority(self) -> None:
        payload = {
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "observed_stage": "paper",
            "fill_count": 2,
            "submitted_order_count": 2,
            "closed_trade_count": 2,
            "open_position_count": 0,
            "filled_notional": "127090.02495200",
            "net_strategy_pnl_after_costs": "567.44720578",
            "post_cost_expectancy_bps": "44.64923238",
            "ledger_schema_version": "torghut.runtime-ledger-bucket.v1",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "cost_model_hash_counts": {"cost": 2},
            "lineage_hash_counts": {"lineage": 2},
            "blockers": [],
        }

        reasons = _runtime_ledger_repair_reason_codes(
            payload,
            manifest={"candidate_id": "c88421d619759b2cfaa6f4d0"},
        )

        self.assertIn("runtime_ledger_source_window_missing", reasons)
        self.assertIn("runtime_ledger_source_refs_missing", reasons)
        self.assertIn("runtime_ledger_source_window_ids_missing", reasons)
        self.assertIn("runtime_ledger_execution_order_event_refs_missing", reasons)
        self.assertIn("runtime_ledger_source_offsets_missing", reasons)
        self.assertIn("runtime_ledger_stage_not_live", reasons)

        source_backed_reasons = _runtime_ledger_repair_reason_codes(
            {
                **payload,
                "source_window_start": "2026-05-29T14:30:00+00:00",
                "source_window_end": "2026-05-29T15:00:00+00:00",
                "source_refs": [
                    "strategy_runtime_ledger_buckets:pairs-realized-runtime",
                    "postgres:trade_decisions",
                    "postgres:executions",
                    "postgres:execution_order_events",
                    "postgres:order_feed_source_windows",
                ],
                "source_row_counts": {
                    "trade_decisions": 2,
                    "executions": 2,
                    "execution_order_events": 2,
                    "strategy_runtime_ledger_buckets": 1,
                    "order_feed_source_windows": 2,
                },
                "trade_decision_ids": ["decision-buy", "decision-sell"],
                "execution_ids": ["execution-buy", "execution-sell"],
                "execution_order_event_ids": ["event-fill-buy", "event-fill-sell"],
                "source_window_ids": ["source-window-buy", "source-window-sell"],
                "source_offsets": [
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                    {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
                ],
                "source_materialization": "execution_order_events",
                "authority_class": "runtime_order_feed_execution_source",
                "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            },
            manifest={"candidate_id": "c88421d619759b2cfaa6f4d0"},
        )

        self.assertNotIn(
            "runtime_ledger_source_window_missing",
            source_backed_reasons,
        )
        self.assertNotIn("runtime_ledger_source_refs_missing", source_backed_reasons)
        self.assertNotIn(
            "runtime_ledger_source_window_ids_missing", source_backed_reasons
        )
        self.assertNotIn(
            "runtime_ledger_execution_order_event_refs_missing",
            source_backed_reasons,
        )
        self.assertEqual(source_backed_reasons, ["runtime_ledger_stage_not_live"])

    def test_paper_probation_blockers_require_source_fills_and_explicit_costs(
        self,
    ) -> None:
        candidate = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "strategy_id": "microbar_cross_sectional_pairs_v1@research",
            "strategy_family": "microbar_cross_sectional_pairs",
            "account": "TORGHUT_SIM",
            "observed_stage": "paper",
            "bucket_started_at": "2026-05-29T14:30:00+00:00",
            "bucket_ended_at": "2026-05-29T15:00:00+00:00",
            "decision_count": 2,
            "submitted_order_count": 2,
            "fill_count": 0,
            "closed_trade_count": 0,
            "open_position_count": 0,
            "filled_notional": "0",
            "net_strategy_pnl_after_costs": "12.50",
            "post_cost_expectancy_bps": "125",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "lineage_hash_counts": {"lineage": 2},
            "reason_codes": ["runtime_ledger_stage_not_live"],
        }

        blockers = _runtime_ledger_paper_probation_blockers(candidate)

        self.assertIn("runtime_ledger_fills_missing", blockers)
        self.assertIn("runtime_ledger_filled_notional_missing", blockers)
        self.assertIn("runtime_ledger_closed_round_trips_missing", blockers)
        self.assertIn("runtime_ledger_explicit_costs_missing", blockers)
        self.assertIn("runtime_ledger_cost_model_hash_missing", blockers)
        self.assertIn("runtime_ledger_source_refs_missing", blockers)
        plan = _runtime_ledger_paper_probation_import_plan([candidate])
        self.assertEqual(plan["target_count"], 0)
        self.assertEqual(plan["skipped_target_count"], 1)
        self.assertFalse(plan["canary_collection_authorized"])
        self.assertFalse(plan["bounded_live_paper_collection_authorized"])
        skipped = plan["skipped_targets"][0]
        self.assertEqual(
            skipped["reason"],
            "runtime_ledger_paper_probation_prerequisites_not_satisfied",
        )
        self.assertIn("runtime_ledger_source_refs_missing", skipped["blockers"])

        malformed = {
            "observed_stage": "exact_replay",
            "open_position_count": 1,
            "net_strategy_pnl_after_costs": "-1",
            "post_cost_expectancy_bps": "-1",
            "reason_codes": [
                "runtime_ledger_stage_not_live",
                "exact_replay_candidate_only",
            ],
        }

        malformed_blockers = _runtime_ledger_paper_probation_blockers(malformed)

        self.assertIn("exact_replay_candidate_only", malformed_blockers)
        self.assertIn("runtime_ledger_stage_not_paper", malformed_blockers)
        self.assertIn("runtime_ledger_pnl_basis_missing", malformed_blockers)
        self.assertIn("runtime_ledger_decisions_missing", malformed_blockers)
        self.assertIn("runtime_order_lifecycle_missing", malformed_blockers)
        self.assertIn("unclosed_position", malformed_blockers)
        self.assertIn("post_cost_pnl_non_positive", malformed_blockers)
        self.assertIn("post_cost_expectancy_non_positive", malformed_blockers)
        self.assertIn(
            "runtime_ledger_execution_policy_hash_missing", malformed_blockers
        )
        self.assertIn("runtime_ledger_lineage_hash_missing", malformed_blockers)

    def test_clean_source_backed_probation_requests_bounded_collection_only(
        self,
    ) -> None:
        candidate = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "c88421d619759b2cfaa6f4d0",
            "strategy_id": "microbar_cross_sectional_pairs_v1@research",
            "strategy_family": "microbar_cross_sectional_pairs",
            "account": "TORGHUT_SIM",
            "observed_stage": "paper",
            "bucket_started_at": "2026-05-29T14:30:00+00:00",
            "bucket_ended_at": "2026-05-29T15:00:00+00:00",
            "decision_count": 2,
            "submitted_order_count": 2,
            "fill_count": 2,
            "closed_trade_count": 2,
            "open_position_count": 0,
            "filled_notional": "127090.02495200",
            "cost_amount": "14",
            "net_strategy_pnl_after_costs": "567.44720578",
            "post_cost_expectancy_bps": "44.64923238",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "cost_model_hash_counts": {"cost": 2},
            "lineage_hash_counts": {"lineage": 2},
            "source_window_start": "2026-05-29T14:30:00+00:00",
            "source_window_end": "2026-05-29T15:00:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_order_events": 2,
                "order_feed_source_windows": 2,
            },
            "trade_decision_ids": ["decision-buy", "decision-sell"],
            "execution_ids": ["execution-buy", "execution-sell"],
            "execution_order_event_ids": ["event-fill-buy", "event-fill-sell"],
            "source_window_ids": ["source-window-buy", "source-window-sell"],
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 100},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 101},
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            "reason_codes": ["runtime_ledger_stage_not_live"],
        }

        plan = _runtime_ledger_paper_probation_import_plan([candidate])

        self.assertTrue(plan["evidence_collection_ok"])
        self.assertTrue(plan["canary_collection_authorized"])
        self.assertTrue(plan["bounded_live_paper_collection_authorized"])
        self.assertTrue(
            plan["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertFalse(plan["promotion_allowed"])
        self.assertFalse(plan["final_promotion_allowed"])
        target = plan["targets"][0]
        self.assertTrue(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertTrue(target["canary_collection_authorized"])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertFalse(target["final_authority_ok"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_runtime_ledger_paper_probation_import_plan_falls_back_and_skips_incomplete_targets(
        self,
    ) -> None:
        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {
                    "hypothesis_id": "H-FALLBACK-01",
                    "candidate_id": "candidate-fallback",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "account": "TORGHUT_SIM",
                    "bucket_started_at": "2026-05-13T17:00:00+00:00",
                    "bucket_ended_at": "2026-05-13T17:30:00+00:00",
                    "observed_stage": "paper",
                    "decision_count": 2,
                    "submitted_order_count": 2,
                    "fill_count": 2,
                    "closed_trade_count": 2,
                    "open_position_count": 0,
                    "filled_notional": "1000",
                    "cost_amount": "1.25",
                    "net_strategy_pnl_after_costs": "12.50",
                    "post_cost_expectancy_bps": "125",
                    "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                    "execution_policy_hash_counts": {"policy": 2},
                    "cost_model_hash_counts": {"cost": 2},
                    "lineage_hash_counts": {"lineage": 2},
                    "source_window_start": "2026-05-13T17:00:00+00:00",
                    "source_window_end": "2026-05-13T17:30:00+00:00",
                    "source_refs": [
                        "postgres:trade_decisions",
                        "postgres:executions",
                        "postgres:execution_order_events",
                        "postgres:order_feed_source_windows",
                    ],
                    "source_row_counts": {
                        "trade_decisions": 2,
                        "executions": 2,
                        "execution_order_events": 2,
                        "order_feed_source_windows": 2,
                    },
                    "trade_decision_ids": ["decision-1", "decision-2"],
                    "execution_ids": ["execution-1", "execution-2"],
                    "execution_order_event_ids": ["event-1", "event-2"],
                    "source_window_ids": ["source-window-1", "source-window-2"],
                    "source_offsets": [
                        {"topic": "alpaca.trade_updates", "partition": 0, "offset": 1},
                        {"topic": "alpaca.trade_updates", "partition": 0, "offset": 2},
                    ],
                    "source_materialization": "execution_order_events",
                    "authority_class": "runtime_order_feed_execution_source",
                    "authority_reason": "event_sourced_runtime_ledger_profit_proof",
                    "reason_codes": ["runtime_ledger_stage_not_live"],
                },
                {
                    "candidate_id": "candidate-missing",
                    "bucket_started_at": "2026-05-13T17:00:00+00:00",
                    "bucket_ended_at": "2026-05-13T17:30:00+00:00",
                },
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["skipped_target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["strategy_name"], "microbar-cross-sectional-pairs-v1")
        self.assertEqual(
            target["strategy_id"], "microbar_cross_sectional_pairs_v1@research"
        )
        self.assertEqual(
            target["runtime_strategy_name"], "microbar-cross-sectional-pairs-v1"
        )
        self.assertEqual(
            target["strategy_lookup_names"], ["microbar-cross-sectional-pairs-v1"]
        )
        self.assertEqual(
            target["source_manifest_ref"],
            "config/trading/hypotheses/h-fallback-01.json",
        )
        self.assertNotIn("runtime_ledger_bucket_ref", target)
        skipped_target = plan["skipped_targets"][0]
        self.assertEqual(skipped_target["candidate_id"], "candidate-missing")
        self.assertIn("hypothesis_id", skipped_target["missing_fields"])
        self.assertIn("strategy_name", skipped_target["missing_fields"])
        self.assertIn("source_manifest_ref", skipped_target["missing_fields"])

    def test_runtime_ledger_paper_probation_import_plan_uses_family_runtime_harness(
        self,
    ) -> None:
        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {
                    "hypothesis_id": "H-TSMOM-LIQ",
                    "candidate_id": "candidate-tsmom",
                    "strategy_id": "intraday_tsmom_v2@research",
                    "runtime_strategy_name": "intraday-tsmom-v2",
                    "strategy_family": "intraday_tsmom_consistent",
                    "account": "TORGHUT_SIM",
                    "bucket_started_at": "2026-05-29T13:30:00+00:00",
                    "bucket_ended_at": "2026-05-29T20:00:00+00:00",
                    "source_collection_candidate": True,
                    "source_collection_reason_codes": [
                        "runtime_ledger_source_collection_pending"
                    ],
                    "reason_codes": ["runtime_ledger_source_collection_pending"],
                }
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["strategy_id"], "intraday_tsmom_v2@research")
        self.assertEqual(target["strategy_name"], "intraday-tsmom-profit-v3")
        self.assertEqual(target["runtime_strategy_name"], "intraday-tsmom-profit-v3")
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")
        self.assertEqual(
            target["strategy_lookup_names"],
            ["intraday-tsmom-profit-v3", "intraday-tsmom-v2"],
        )
        self.assertFalse(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertFalse(target["bounded_live_paper_collection_authorized"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertFalse(target["final_promotion_allowed"])

    def test_runtime_ledger_paper_probation_import_plan_dedupes_same_window_targets(
        self,
    ) -> None:
        base_candidate = {
            "hypothesis_id": "H-PAIRS-01",
            "candidate_id": "candidate-pairs",
            "runtime_strategy_name": "microbar-pairs-vwap-cap-safe",
            "strategy_family": "microbar_cross_sectional_pairs",
            "account": "TORGHUT_REPLAY",
            "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
            "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
            "bucket_started_at": "2026-05-21T17:00:00+00:00",
            "bucket_ended_at": "2026-05-21T17:30:00+00:00",
            "observed_stage": "paper",
            "decision_count": 2,
            "submitted_order_count": 2,
            "fill_count": 2,
            "closed_trade_count": 2,
            "open_position_count": 0,
            "filled_notional": "1000",
            "cost_amount": "1.25",
            "net_strategy_pnl_after_costs": "12.50",
            "post_cost_expectancy_bps": "125",
            "pnl_basis": "realized_strategy_pnl_after_explicit_costs",
            "execution_policy_hash_counts": {"policy": 2},
            "cost_model_hash_counts": {"cost": 2},
            "lineage_hash_counts": {"lineage": 2},
            "source_window_start": "2026-05-21T17:00:00+00:00",
            "source_window_end": "2026-05-21T17:30:00+00:00",
            "source_refs": [
                "postgres:trade_decisions",
                "postgres:executions",
                "postgres:execution_order_events",
                "postgres:order_feed_source_windows",
            ],
            "source_row_counts": {
                "trade_decisions": 2,
                "executions": 2,
                "execution_order_events": 2,
                "order_feed_source_windows": 2,
            },
            "trade_decision_ids": ["decision-1", "decision-2"],
            "execution_ids": ["execution-1", "execution-2"],
            "execution_order_event_ids": ["event-1", "event-2"],
            "source_window_ids": ["source-window-1", "source-window-2"],
            "source_offsets": [
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 1},
                {"topic": "alpaca.trade_updates", "partition": 0, "offset": 2},
            ],
            "source_materialization": "execution_order_events",
            "authority_class": "runtime_order_feed_execution_source",
            "authority_reason": "event_sourced_runtime_ledger_profit_proof",
            "reason_codes": ["runtime_ledger_stage_not_live"],
        }

        plan = _runtime_ledger_paper_probation_import_plan(
            [
                {**base_candidate, "run_id": "better-runtime-ledger"},
                {**base_candidate, "run_id": "duplicate-runtime-ledger"},
            ]
        )

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["skipped_target_count"], 1)
        self.assertEqual(
            plan["targets"][0]["runtime_ledger_bucket_ref"],
            "strategy_runtime_ledger_buckets:better-runtime-ledger:"
            "2026-05-21T17:00:00+00:00:2026-05-21T17:30:00+00:00",
        )
        skipped_target = plan["skipped_targets"][0]
        self.assertEqual(
            skipped_target["reason"],
            "duplicate_runtime_ledger_paper_probation_target",
        )
        self.assertEqual(
            skipped_target["runtime_ledger_bucket_ref"],
            "strategy_runtime_ledger_buckets:duplicate-runtime-ledger:"
            "2026-05-21T17:00:00+00:00:2026-05-21T17:30:00+00:00",
        )

    def test_runtime_ledger_source_collection_target_does_not_grant_probation(
        self,
    ) -> None:
        candidates = _runtime_ledger_source_collection_candidates(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "account": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "bucket_started_at": "2026-05-29T17:00:00+00:00",
                    "bucket_ended_at": "2026-05-29T20:00:00+00:00",
                    "submitted_order_count": 8,
                    "fill_count": 35,
                    "closed_trade_count": 12,
                    "open_position_count": 4,
                    "filled_notional": "157941.50000000",
                    "net_strategy_pnl_after_costs": "5514.86354020",
                    "reason_codes": [
                        "runtime_ledger_stage_not_live",
                        "runtime_ledger_source_window_missing",
                        "runtime_ledger_source_refs_missing",
                        "execution_reconstruction_not_runtime_ledger_proof",
                        "unclosed_position",
                    ],
                }
            ]
        )

        self.assertEqual(len(candidates), 1)
        self.assertTrue(candidates[0]["source_collection_authorized"])
        self.assertFalse(candidates[0].get("paper_probation_eligible", False))
        plan = _runtime_ledger_paper_probation_import_plan(candidates)

        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(plan["paper_probation_target_count"], 0)
        self.assertEqual(plan["source_collection_target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["source_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")
        self.assertEqual(
            target["source_kind"], "runtime_ledger_source_collection_candidate"
        )
        self.assertFalse(target["paper_probation_authorized"])
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(target["probation_allowed"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertIn(
            "runtime_ledger_source_window_evidence_pending",
            target["final_promotion_blockers"],
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            target["source_collection_reason_codes"],
        )

    def test_runtime_ledger_source_collection_allows_unclosed_or_losing_activity(
        self,
    ) -> None:
        candidates = _runtime_ledger_source_collection_candidates(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "account": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "bucket_started_at": "2026-05-29T14:30:00+00:00",
                    "bucket_ended_at": "2026-05-29T20:00:00+00:00",
                    "submitted_order_count": 6,
                    "fill_count": 12,
                    "closed_trade_count": 0,
                    "open_position_count": 1,
                    "filled_notional": "1087.98000000",
                    "net_strategy_pnl_after_costs": "-0.31170732",
                    "reason_codes": [
                        "runtime_ledger_stage_not_live",
                        "runtime_ledger_source_window_missing",
                        "runtime_ledger_source_refs_missing",
                        "execution_reconstruction_not_runtime_ledger_proof",
                        "unclosed_position",
                        "post_cost_pnl_non_positive",
                    ],
                }
            ]
        )

        self.assertEqual(len(candidates), 1)
        source_candidate = candidates[0]
        self.assertTrue(source_candidate["source_collection_authorized"])
        self.assertEqual(source_candidate["proof_mode"], "probation")
        self.assertTrue(source_candidate["evidence_collection_ok"])
        self.assertFalse(source_candidate["canary_collection_authorized"])
        self.assertFalse(source_candidate["capital_promotion_allowed"])
        self.assertFalse(source_candidate.get("paper_probation_eligible", False))
        self.assertEqual(
            source_candidate["source_collection_scope"],
            "source_window_evidence_collection_only",
        )
        self.assertIn(
            "runtime_ledger_source_window_missing",
            source_candidate["source_collection_reason_codes"],
        )

        plan = _runtime_ledger_paper_probation_import_plan(candidates)

        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["target_dsn_env"], "SIM_DB_DSN")
        self.assertEqual(target["source_account_label"], "TORGHUT_SIM")
        self.assertFalse(target["paper_probation_authorized"])
        self.assertTrue(target["source_collection_authorized"])
        self.assertEqual(target["proof_mode"], "probation")
        self.assertTrue(target["evidence_collection_ok"])
        self.assertFalse(target["canary_collection_authorized"])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertFalse(target["probation_allowed"])
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertIn("post_cost_pnl_non_positive", target["candidate_blockers"])
        self.assertIn("unclosed_position", target["candidate_blockers"])

    def test_runtime_ledger_source_collection_requires_real_fill_activity(
        self,
    ) -> None:
        candidates = _runtime_ledger_source_collection_candidates(
            [
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "account": "TORGHUT_SIM",
                    "observed_stage": "paper",
                    "bucket_started_at": "2026-05-29T14:30:00+00:00",
                    "bucket_ended_at": "2026-05-29T20:00:00+00:00",
                    "submitted_order_count": 6,
                    "fill_count": 0,
                    "closed_trade_count": 0,
                    "open_position_count": 0,
                    "filled_notional": "0",
                    "net_strategy_pnl_after_costs": "0",
                    "reason_codes": [
                        "runtime_ledger_source_window_missing",
                        "execution_reconstruction_not_runtime_ledger_proof",
                    ],
                }
            ]
        )

        self.assertEqual(candidates, [])

    def test_live_gate_marks_source_collection_pending_without_probation(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)

        class _RegistryItem:
            hypothesis_id = "H-PAIRS-01"

            def model_dump(self, *, mode: str = "json") -> dict[str, object]:
                return {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "lane_id": "microbar_cross_sectional_pairs",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }

        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[_RegistryItem()],
        )

        with session_local() as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="pairs-source-missing-runtime",
                    candidate_id="c88421d619759b2cfaa6f4d0",
                    hypothesis_id="H-PAIRS-01",
                    observed_stage="paper",
                    bucket_started_at=now - timedelta(hours=3),
                    bucket_ended_at=now - timedelta(hours=1),
                    account_label="TORGHUT_SIM",
                    runtime_strategy_name="microbar-cross-sectional-pairs-v1",
                    strategy_family="microbar_cross_sectional_pairs",
                    fill_count=35,
                    decision_count=72,
                    submitted_order_count=35,
                    cancelled_order_count=0,
                    rejected_order_count=0,
                    unfilled_order_count=0,
                    closed_trade_count=12,
                    open_position_count=4,
                    filled_notional=Decimal("157941.50000000"),
                    gross_strategy_pnl=Decimal("5530.86354020"),
                    cost_amount=Decimal("16"),
                    net_strategy_pnl_after_costs=Decimal("5514.86354020"),
                    post_cost_expectancy_bps=None,
                    ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                    pnl_basis="runtime_reconstructed_pnl",
                    execution_policy_hash_counts={},
                    cost_model_hash_counts={},
                    lineage_hash_counts={},
                    blockers_json=["execution_reconstruction_not_runtime_ledger_proof"],
                )
            )
            session.commit()

            with patch(
                "app.trading.submission_council.load_hypothesis_registry",
                return_value=registry,
            ):
                gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=True,
                        last_autonomy_promotion_eligible=False,
                        last_autonomy_promotion_action=None,
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                        metrics=SimpleNamespace(
                            feature_batch_rows_total=9,
                            feature_null_rate={"price": 0.0},
                            feature_staleness_ms_p95=250,
                            feature_duplicate_ratio=0.0,
                            decision_state_total={},
                        ),
                    ),
                    hypothesis_summary={
                        "summary": {
                            "promotion_eligible_total": 0,
                            "capital_stage_totals": {"shadow": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        "items": [],
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    dspy_runtime_status={"mode": "inactive"},
                    quant_health_status=self._healthy_quant_status(),
                    promotion_certificate_evidence=[],
                    session=session,
                )

        self.assertEqual(gate["paper_probation_eligible_total"], 0)
        self.assertEqual(gate["runtime_ledger_paper_probation_eligible_total"], 0)
        self.assertIn(
            "runtime_ledger_source_collection_pending", gate["blocked_reasons"]
        )
        self.assertEqual(gate["runtime_ledger_source_collection_candidate_total"], 1)
        source_candidates = gate["runtime_ledger_source_collection_candidates"]
        self.assertEqual(len(source_candidates), 1)
        self.assertEqual(
            source_candidates[0]["source_collection_scope"],
            "source_window_evidence_collection_only",
        )
        import_plan = gate["runtime_ledger_paper_probation_import_plan"]
        self.assertEqual(import_plan["paper_probation_target_count"], 0)
        self.assertEqual(import_plan["source_collection_target_count"], 1)
        target = import_plan["targets"][0]
        self.assertFalse(target["paper_probation_authorized"])
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(target["promotion_allowed"])

    def test_live_gate_seeds_hpairs_bounded_collection_target_without_source_rows(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        class _RegistryItem:
            hypothesis_id = "H-PAIRS-01"

            def model_dump(self, *, mode: str = "json") -> dict[str, object]:
                return {
                    "hypothesis_id": "H-PAIRS-01",
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                    "strategy_family": "microbar_cross_sectional_pairs",
                    "lane_id": "microbar_cross_sectional_pairs",
                    "dataset_snapshot_ref": "portfolio-profit-autoresearch-500-v1",
                }

        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[_RegistryItem()],
        )

        with session_local() as session:
            with patch(
                "app.trading.submission_council.load_hypothesis_registry",
                return_value=registry,
            ):
                gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=True,
                        last_autonomy_promotion_eligible=False,
                        last_autonomy_promotion_action=None,
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                        metrics=SimpleNamespace(
                            feature_batch_rows_total=9,
                            feature_null_rate={"price": 0.0},
                            feature_staleness_ms_p95=250,
                            feature_duplicate_ratio=0.0,
                            decision_state_total={},
                        ),
                    ),
                    hypothesis_summary={
                        "summary": {
                            "promotion_eligible_total": 0,
                            "capital_stage_totals": {"shadow": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        "items": [],
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    dspy_runtime_status={"mode": "inactive"},
                    quant_health_status=self._healthy_quant_status(),
                    promotion_certificate_evidence=[],
                    session=session,
                )

        self.assertFalse(gate["allowed"])
        self.assertFalse(gate["runtime_ledger_paper_probation_candidates"])
        self.assertFalse(gate["runtime_ledger_source_collection_candidates"])
        self.assertIn(
            "runtime_ledger_source_collection_pending", gate["blocked_reasons"]
        )
        import_plan = gate["runtime_ledger_paper_probation_import_plan"]
        self.assertEqual(import_plan["target_count"], 1)
        self.assertEqual(import_plan["manifest_bounded_collection_target_count"], 1)
        self.assertFalse(import_plan["bounded_live_paper_collection_authorized"])
        self.assertFalse(
            import_plan["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertFalse(import_plan["promotion_allowed"])
        self.assertFalse(import_plan["final_promotion_allowed"])
        target = import_plan["targets"][0]
        self.assertEqual(target["hypothesis_id"], "H-PAIRS-01")
        self.assertEqual(target["candidate_id"], "c88421d619759b2cfaa6f4d0")
        self.assertEqual(target["account_label"], "TORGHUT_SIM")
        self.assertEqual(target["source_kind"], "paper_route_probe_runtime_observed")
        self.assertEqual(
            target["runtime_strategy_name"], "microbar-cross-sectional-pairs-v1"
        )
        self.assertFalse(target["bounded_evidence_collection_authorized"])
        self.assertFalse(target["bounded_live_paper_collection_authorized"])
        self.assertFalse(
            target["paper_probation_satisfied_for_bounded_live_paper_collection"]
        )
        self.assertTrue(target["source_collection_authorized"])
        self.assertFalse(target["capital_promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertIn(
            "runtime_ledger_source_decisions_missing",
            target["candidate_blockers"],
        )
        self.assertIn(
            "source_backed_paper_probation_required",
            target["candidate_blockers"],
        )

    def test_metric_window_activity_rejects_tca_proxy_expectancy(self) -> None:
        metric_window = SimpleNamespace(
            market_session_count=3,
            decision_count=3,
            trade_count=3,
            order_count=3,
            post_cost_expectancy_bps="8.5",
            avg_abs_slippage_bps="4.2",
            slippage_budget_bps="12",
            payload_json={
                "post_cost_promotion_sample_count": 0,
                "post_cost_basis_counts": {"broker_tca_shortfall_estimate": 3},
            },
        )

        reasons = _metric_window_activity_reason_codes(metric_window)

        self.assertEqual(
            reasons,
            ["hypothesis_window_post_cost_pnl_basis_missing"],
        )

    def test_metric_window_activity_rejects_live_window_without_runtime_ledger_weighted_pnl(
        self,
    ) -> None:
        metric_window = SimpleNamespace(
            observed_stage="live",
            market_session_count=3,
            decision_count=3,
            trade_count=3,
            order_count=3,
            post_cost_expectancy_bps="8.5",
            avg_abs_slippage_bps="4.2",
            slippage_budget_bps="12",
            payload_json={
                "post_cost_promotion_sample_count": 3,
                "post_cost_basis_counts": {
                    "realized_strategy_pnl_after_explicit_costs": 3
                },
                "post_cost_expectancy_aggregation": "promotion_bps_average",
                "runtime_ledger_notional_weighted_sample_count": 2,
            },
        )

        reasons = _metric_window_activity_reason_codes(metric_window)

        self.assertEqual(reasons, ["runtime_ledger_pnl_basis_missing"])

    def test_merge_runtime_certificate_evidence_surfaces_blocked_import_reason(
        self,
    ) -> None:
        merged = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "promotion_eligible": False,
                    "capital_stage": "shadow",
                    "reasons": [],
                    "observed": {},
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(observed_stage="live"),
                    "promotion_decision": self._promotion_decision(
                        allowed=False,
                        reason_summary="runtime_ledger_pnl_basis_missing",
                        payload_json={
                            "promotion_blocking_reasons": [
                                "runtime_ledger_pnl_basis_missing"
                            ]
                        },
                    ),
                }
            ],
            now=datetime.now(timezone.utc),
            max_age_seconds=3600,
        )

        self.assertEqual(len(merged), 1)
        self.assertFalse(merged[0]["promotion_eligible"])
        self.assertEqual(
            merged[0]["reasons"],
            [
                "runtime_ledger_pnl_basis_missing",
                "promotion_decision_not_allowed",
            ],
        )
        self.assertEqual(
            merged[0]["observed"]["runtime_window_rejection_reasons"],
            [
                "runtime_ledger_pnl_basis_missing",
                "promotion_decision_not_allowed",
            ],
        )

    def test_refresh_runtime_summary_totals_counts_reasons_and_rollback(self) -> None:
        refreshed = _refresh_runtime_summary_totals(
            {
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                }
            },
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "state": "shadow",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": True,
                    "reasons": ["drift_checks_missing", ""],
                    "informational_reasons": ["runtime_window_certificate_rejected"],
                },
                {
                    "hypothesis_id": "H-TSMOM-01",
                    "state": "shadow",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": True,
                    "paper_probation_eligible": True,
                    "rollback_required": False,
                    "reasons": [],
                    "informational_reasons": [],
                },
            ],
        )

        self.assertEqual(refreshed["hypotheses_total"], 2)
        self.assertEqual(refreshed["promotion_eligible_total"], 1)
        self.assertEqual(refreshed["paper_probation_eligible_total"], 1)
        self.assertEqual(refreshed["rollback_required_total"], 1)
        self.assertEqual(refreshed["reason_totals"], {"drift_checks_missing": 1})
        self.assertEqual(
            refreshed["informational_reason_totals"],
            {"runtime_window_certificate_rejected": 1},
        )

    def test_runtime_certificate_merge_keeps_invalid_evidence_shadow(self) -> None:
        now = datetime.now(timezone.utc)
        base_item = {
            "hypothesis_id": "H-CONT-01",
            "candidate_id": None,
            "capital_stage": "shadow",
            "capital_multiplier": "0",
            "promotion_eligible": False,
            "rollback_required": False,
            "reasons": ["drift_checks_missing"],
            "informational_reasons": [],
            "observed": {},
        }

        def metric_window(**overrides: object) -> SimpleNamespace:
            payload: dict[str, object] = {
                "id": "window-invalid",
                "candidate_id": "cand-runtime",
                "capital_stage": "0.10x canary",
                "window_ended_at": now,
                "created_at": now,
                "continuity_ok": True,
                "drift_ok": True,
                "dependency_quorum_decision": "allow",
                "market_session_count": 3,
                "decision_count": 42,
                "trade_count": 42,
                "order_count": 42,
                "avg_abs_slippage_bps": "4.2",
                "slippage_budget_bps": "12",
                "post_cost_expectancy_bps": "8.5",
            }
            payload.update(overrides)
            return SimpleNamespace(**payload)

        def promotion(**overrides: object) -> SimpleNamespace:
            payload: dict[str, object] = {
                "id": "promo-invalid",
                "candidate_id": "cand-runtime",
                "state": "0.10x canary",
                "allowed": True,
            }
            payload.update(overrides)
            return SimpleNamespace(**payload)

        scenarios = [
            [],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        window_ended_at=None,
                        created_at=None,
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(),
                    "promotion_decision": promotion(allowed=False),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        window_ended_at=now.replace(year=2020),
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        dependency_quorum_decision="block",
                    ),
                    "promotion_decision": promotion(),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(capital_stage="observe"),
                    "promotion_decision": promotion(state="observe"),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(capital_stage="shadow"),
                    "promotion_decision": promotion(state="shadow"),
                }
            ],
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window(
                        capital_stage="shadow",
                        observed_stage="live",
                        payload_json={
                            "post_cost_promotion_sample_count": 42,
                            "post_cost_basis_counts": {
                                "realized_strategy_pnl_after_explicit_costs": 42
                            },
                            "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                            "runtime_ledger_notional_weighted_sample_count": 42,
                        },
                    ),
                    "promotion_decision": promotion(state="shadow"),
                }
            ],
        ]

        for evidence in scenarios:
            with self.subTest(evidence=evidence):
                result = _merge_runtime_certificate_evidence(
                    [base_item],
                    evidence=evidence,
                    now=now,
                    max_age_seconds=3600,
                )

                self.assertFalse(result[0]["promotion_eligible"])
                self.assertEqual(result[0]["capital_stage"], "shadow")
                expected_reasons = ["drift_checks_missing"]
                if (
                    evidence
                    and getattr(evidence[0]["promotion_decision"], "allowed", True)
                    is False
                ):
                    expected_reasons.append("promotion_decision_not_allowed")
                self.assertEqual(result[0]["reasons"], expected_reasons)

    def test_runtime_certificate_merge_blocks_live_certificate_without_runtime_ledger(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        result = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": None,
                    "strategy_family": "intraday_continuation",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": False,
                    "reasons": ["drift_checks_missing"],
                    "informational_reasons": [],
                    "observed": {},
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(
                        run_id="runtime-proof-missing-ledger",
                        candidate_id="cand-runtime",
                    ),
                    "promotion_decision": self._promotion_decision(
                        run_id="runtime-proof-missing-ledger",
                        candidate_id="cand-runtime",
                    ),
                }
            ],
            now=now,
            max_age_seconds=3600,
        )

        self.assertFalse(result[0]["promotion_eligible"])
        self.assertEqual(result[0]["capital_stage"], "shadow")
        self.assertEqual(
            result[0]["reasons"],
            ["drift_checks_missing", "runtime_ledger_proof_missing"],
        )
        self.assertEqual(
            result[0]["observed"]["runtime_window_rejection_reasons"],
            ["runtime_ledger_proof_missing"],
        )

    def test_runtime_certificate_merge_accepts_runtime_item_ledger_observed_fallback(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        result = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": "cand-1",
                    "strategy_family": "intraday_continuation",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": False,
                    "reasons": ["drift_checks_missing"],
                    "informational_reasons": [],
                    "observed": self._runtime_ledger_observed(),
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
            now=now,
            max_age_seconds=3600,
        )

        self.assertTrue(result[0]["promotion_eligible"])
        self.assertEqual(result[0]["capital_stage"], "0.10x canary")
        self.assertEqual(result[0]["reasons"], [])
        self.assertTrue(result[0]["observed"]["runtime_window_certificate_applied"])
        self.assertEqual(
            result[0]["informational_reasons"],
            ["runtime_window_certificate_applied"],
        )

    def test_runtime_certificate_merge_rejects_explicit_missing_runtime_ledger_bucket(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        result = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": "cand-1",
                    "strategy_family": "intraday_continuation",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": False,
                    "reasons": ["drift_checks_missing"],
                    "informational_reasons": [],
                    "observed": self._runtime_ledger_observed(),
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                    "runtime_ledger_bucket": None,
                }
            ],
            now=now,
            max_age_seconds=3600,
        )

        self.assertFalse(result[0]["promotion_eligible"])
        self.assertEqual(result[0]["capital_stage"], "shadow")
        self.assertEqual(
            result[0]["observed"]["runtime_window_rejection_reasons"],
            ["runtime_ledger_proof_missing"],
        )

    def test_runtime_certificate_merge_rejects_invalid_runtime_ledger_payloads(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        base_item = {
            "hypothesis_id": "H-CONT-01",
            "candidate_id": None,
            "strategy_family": "intraday_continuation",
            "capital_stage": "shadow",
            "capital_multiplier": "0",
            "promotion_eligible": False,
            "rollback_required": False,
            "reasons": ["drift_checks_missing"],
            "informational_reasons": [],
            "observed": {},
        }
        drop = object()
        scenarios: list[tuple[str, dict[str, object], tuple[str, ...]]] = [
            (
                "hypothesis mismatch",
                {"hypothesis_id": "H-OTHER"},
                ("runtime_ledger_hypothesis_mismatch",),
            ),
            (
                "run mismatch",
                {"run_id": "runtime-proof-other"},
                ("runtime_ledger_run_id_mismatch",),
            ),
            (
                "candidate missing",
                {"candidate_id": drop},
                ("runtime_ledger_candidate_missing",),
            ),
            (
                "candidate mismatch",
                {"candidate_id": "cand-other"},
                ("runtime_ledger_candidate_mismatch",),
            ),
            (
                "stage not live",
                {"observed_stage": "paper"},
                ("runtime_ledger_stage_not_live",),
            ),
            (
                "family mismatch",
                {"strategy_family": "mean_reversion"},
                ("runtime_ledger_strategy_family_mismatch",),
            ),
            (
                "pnl basis missing",
                {"pnl_basis": drop},
                ("runtime_ledger_pnl_basis_missing",),
            ),
            (
                "filled notional missing",
                {"filled_notional": "0"},
                ("runtime_ledger_filled_notional_missing",),
            ),
            (
                "expectancy missing",
                {"post_cost_expectancy_bps": drop},
                ("runtime_ledger_expectancy_missing",),
            ),
            (
                "expectancy nonpositive",
                {"post_cost_expectancy_bps": "0"},
                ("post_cost_expectancy_non_positive",),
            ),
            (
                "closed trades missing",
                {"closed_trade_count": 0},
                ("runtime_ledger_closed_trades_missing",),
            ),
            ("open position", {"open_position_count": 1}, ("unclosed_position",)),
            (
                "orders missing",
                {"submitted_order_count": 0},
                ("runtime_order_lifecycle_missing",),
            ),
            (
                "orders below metric",
                {"submitted_order_count": 1},
                ("runtime_ledger_submitted_order_count_mismatch",),
            ),
            (
                "hash counts missing",
                {
                    "execution_policy_hash_counts": drop,
                    "cost_model_hash_counts": drop,
                    "lineage_hash_counts": drop,
                },
                (
                    "runtime_ledger_execution_policy_hash_missing",
                    "runtime_ledger_cost_model_hash_missing",
                    "runtime_ledger_lineage_hash_missing",
                ),
            ),
        ]

        for label, updates, expected_reasons in scenarios:
            with self.subTest(label=label):
                payload = self._runtime_ledger_bucket_payload()
                for key, value in updates.items():
                    if value is drop:
                        payload.pop(key, None)
                    else:
                        payload[key] = value
                result = _merge_runtime_certificate_evidence(
                    [dict(base_item)],
                    evidence=[
                        {
                            "hypothesis_id": "H-CONT-01",
                            "metric_window": self._metric_window(),
                            "promotion_decision": self._promotion_decision(),
                            "runtime_ledger_bucket": payload,
                        }
                    ],
                    now=now,
                    max_age_seconds=3600,
                )

                self.assertFalse(result[0]["promotion_eligible"])
                self.assertEqual(result[0]["capital_stage"], "shadow")
                rejection_reasons = result[0]["observed"][
                    "runtime_window_rejection_reasons"
                ]
                for reason in expected_reasons:
                    self.assertIn(reason, rejection_reasons)

    def test_runtime_certificate_merge_rejects_runtime_ledger_bucket_outside_metric_window(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        metric_window = self._metric_window()
        metric_window.window_started_at = now - timedelta(minutes=10)
        metric_window.window_ended_at = now
        payload = self._runtime_ledger_bucket_payload()
        payload["bucket_started_at"] = (now + timedelta(minutes=1)).isoformat()
        payload["bucket_ended_at"] = (now + timedelta(minutes=2)).isoformat()

        result = _merge_runtime_certificate_evidence(
            [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": None,
                    "strategy_family": "intraday_continuation",
                    "capital_stage": "shadow",
                    "capital_multiplier": "0",
                    "promotion_eligible": False,
                    "rollback_required": False,
                    "reasons": ["drift_checks_missing"],
                    "informational_reasons": [],
                    "observed": {},
                }
            ],
            evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": metric_window,
                    "promotion_decision": self._promotion_decision(),
                    "runtime_ledger_bucket": payload,
                }
            ],
            now=now,
            max_age_seconds=3600,
        )

        self.assertFalse(result[0]["promotion_eligible"])
        self.assertEqual(result[0]["capital_stage"], "shadow")
        self.assertIn(
            "runtime_ledger_window_bounds_mismatch",
            result[0]["observed"]["runtime_window_rejection_reasons"],
        )

    def test_hypothesis_runtime_summary_uses_fresh_imported_runtime_proof(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing", "post_cost_expectancy_below_edge"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now,
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 1)
        self.assertEqual(result["paper_probation_eligible_total"], 0)
        item = result["items"][0]
        self.assertTrue(item["promotion_eligible"])
        self.assertEqual(item["candidate_id"], "cand-runtime")
        self.assertEqual(item["capital_stage"], "0.10x canary")
        self.assertEqual(item["reasons"], [])
        self.assertEqual(item["observed"]["metric_window_decision_count"], 42)
        self.assertEqual(
            item["observed"]["runtime_window_prior_reasons"],
            ["drift_checks_missing", "post_cost_expectancy_below_edge"],
        )
        self.assertEqual(
            item["informational_reasons"],
            ["runtime_window_certificate_applied"],
        )

    def test_hypothesis_runtime_summary_prefers_stronger_runtime_certificate_candidate(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-good",
                    candidate_id="cand-good",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=15),
                    window_ended_at=now - timedelta(minutes=5),
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-good",
                    candidate_id="cand-good",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-good",
                    candidate_id="cand-good",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now - timedelta(minutes=5),
                )
            )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-blocked",
                    candidate_id="cand-blocked-newer",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=10),
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=0,
                    trade_count=0,
                    order_count=0,
                    avg_abs_slippage_bps="0",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="0",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 0,
                        "post_cost_basis_counts": {},
                        "post_cost_expectancy_aggregation": "no_promotion_grade_post_cost_rows",
                        "runtime_ledger_notional_weighted_sample_count": 0,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-blocked",
                    candidate_id="cand-blocked-newer",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=False,
                    reason_summary="runtime_decision_count_zero,runtime_order_count_zero",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 1)
        item = result["items"][0]
        self.assertTrue(item["promotion_eligible"])
        self.assertEqual(item["candidate_id"], "cand-good")
        self.assertEqual(item["capital_stage"], "0.10x canary")
        self.assertEqual(item["reasons"], [])

    def test_hypothesis_runtime_summary_keeps_paper_probation_when_newer_live_lacks_ledger(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-paper",
                    candidate_id="cand-paper",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now - timedelta(minutes=30),
                    window_ended_at=now - timedelta(minutes=20),
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="shadow",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-paper",
                    candidate_id="cand-paper",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="shadow",
                    allowed=True,
                    reason_summary="paper_runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-live-missing-ledger",
                    candidate_id="cand-live-missing-ledger",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=10),
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-live-missing-ledger",
                    candidate_id="cand-live-missing-ledger",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 0)
        self.assertEqual(result["paper_probation_eligible_total"], 1)
        item = result["items"][0]
        self.assertEqual(item["candidate_id"], "cand-paper")
        self.assertFalse(item["promotion_eligible"])
        self.assertTrue(item["paper_probation_eligible"])
        self.assertEqual(item["reasons"], ["paper_probation_evidence_collection_only"])
        self.assertNotIn(
            "runtime_ledger_proof_missing",
            item["observed"].get("runtime_window_rejection_reasons", []),
        )

    def test_certificate_evidence_selection_key_handles_unknown_or_missing_window(
        self,
    ) -> None:
        self.assertEqual(
            _certificate_evidence_authority_score(
                observed_stage="shadow",
                runtime_ledger_bucket=None,
            ),
            0,
        )
        self.assertEqual(
            _certificate_evidence_selection_key(
                {},
                now=datetime.now(timezone.utc),
                max_age_seconds=3600,
            ),
            (0, 0, 0, 0, 0, 0, 0, 0, Decimal("0"), 0.0),
        )

    def test_build_live_submission_gate_payload_rescues_stale_summary_with_session_live_runtime_evidence(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600

        class _RegistryItem:
            hypothesis_id = "H-CONT-01"

            def model_dump(self, *, mode: str = "json") -> dict[str, object]:
                return {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": "cand-live",
                    "strategy_id": "intraday_continuation",
                    "strategy_family": "intraday_continuation",
                    "lane_id": "continuation",
                    "dataset_snapshot_ref": "snap-live-runtime-proof",
                    "segment_dependencies": [],
                }

        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[_RegistryItem()],
        )
        stale_runtime_item = {
            "hypothesis_id": "H-CONT-01",
            "candidate_id": None,
            "strategy_id": "intraday_continuation",
            "lane_id": "continuation",
            "strategy_family": "intraday_continuation",
            "state": "shadow",
            "capital_stage": "shadow",
            "capital_multiplier": "0",
            "promotion_eligible": False,
            "rollback_required": False,
            "reasons": ["drift_checks_missing"],
            "informational_reasons": [],
            "observed": {},
        }

        with session_local() as session:
            session.add(
                StrategyHypothesis(
                    hypothesis_id="H-CONT-01",
                    lane_id="continuation",
                    strategy_family="intraday_continuation",
                    source_manifest_ref="config/trading/hypotheses/h-cont-01.json",
                    active=True,
                    payload_json={},
                )
            )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-live",
                    candidate_id="cand-live",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now - timedelta(minutes=15),
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-live",
                    candidate_id="cand-live",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-live",
                    candidate_id="cand-live",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now,
                )
            )
            session.commit()

            with patch(
                "app.trading.submission_council.load_hypothesis_registry",
                return_value=registry,
            ):
                gate = build_live_submission_gate_payload(
                    SimpleNamespace(
                        market_session_open=True,
                        last_autonomy_promotion_eligible=True,
                        last_autonomy_promotion_action="promote",
                        drift_live_promotion_eligible=False,
                        last_market_context_freshness_seconds=45,
                    ),
                    hypothesis_summary={
                        "summary": {
                            "promotion_eligible_total": 0,
                            "paper_probation_eligible_total": 0,
                            "capital_stage_totals": {"shadow": 1},
                            "reason_totals": {"drift_checks_missing": 1},
                            "dependency_quorum": {
                                "decision": "allow",
                                "reasons": [],
                                "message": "ready",
                            },
                        },
                        "items": [stale_runtime_item],
                    },
                    empirical_jobs_status={"ready": True, "status": "healthy"},
                    dspy_runtime_status={"mode": "inactive"},
                    quant_health_status=self._healthy_quant_status(),
                    session=session,
                    clickhouse_ta_status={
                        "state": "current",
                        "source_ref": "torghut.ta_signals",
                        "signal_rows": 12,
                        "symbol_count": 6,
                    },
                )

        self.assertTrue(gate["allowed"])
        self.assertEqual(gate["promotion_eligible_total"], 1)
        self.assertEqual(gate["capital_stage"], "0.10x canary")
        self.assertEqual(gate["evidence_tuple"]["candidate_id"], "cand-live")
        self.assertNotIn(
            "alpha_readiness_not_promotion_eligible", gate["blocked_reasons"]
        )

    def test_load_latest_certificate_evidence_skips_mismatched_runtime_ledger_bucket(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-wrong",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now + timedelta(seconds=1),
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    strategy_family="mean_reversion",
                    bucket_at=now + timedelta(seconds=1),
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now,
                )
            )
            session.commit()

            evidence = _load_latest_certificate_evidence(
                session,
                hypothesis_ids=["H-CONT-01"],
            )

        self.assertEqual(len(evidence), 1)
        runtime_ledger_bucket = evidence[0]["runtime_ledger_bucket"]
        self.assertIsInstance(runtime_ledger_bucket, dict)
        self.assertEqual(runtime_ledger_bucket["run_id"], "runtime-proof-1")
        self.assertEqual(
            runtime_ledger_bucket["strategy_family"], "intraday_continuation"
        )

    def test_load_latest_certificate_evidence_fails_closed_when_runtime_ledger_scan_times_out(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="live",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                    payload_json={
                        "post_cost_promotion_sample_count": 42,
                        "post_cost_basis_counts": {
                            "realized_strategy_pnl_after_explicit_costs": 42
                        },
                        "post_cost_expectancy_aggregation": "runtime_ledger_notional_weighted",
                        "runtime_ledger_notional_weighted_sample_count": 42,
                    },
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="live",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.add(
                self._runtime_ledger_bucket_row(
                    run_id="runtime-proof-1",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    bucket_at=now,
                )
            )
            session.commit()

            with patch(
                "app.trading.submission_council._maybe_set_runtime_ledger_status_statement_timeout",
                side_effect=SQLAlchemyError("statement timeout"),
            ):
                evidence = _load_latest_certificate_evidence(
                    session,
                    hypothesis_ids=["H-CONT-01"],
                )

        self.assertEqual(len(evidence), 1)
        self.assertIsNone(evidence[0]["runtime_ledger_bucket"])

    def test_hypothesis_runtime_summary_counts_allowed_paper_runtime_readiness_without_capital_promotion(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-paper-proof-1",
                    candidate_id="cand-runtime-paper",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="shadow",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-paper-proof-1",
                    candidate_id="cand-runtime-paper",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="shadow",
                    allowed=True,
                    reason_summary="paper_runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                summary = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

            gate = build_live_submission_gate_payload(
                SimpleNamespace(
                    last_autonomy_promotion_eligible=True,
                    last_autonomy_promotion_action="promote",
                    drift_live_promotion_eligible=False,
                    last_market_context_freshness_seconds=45,
                ),
                hypothesis_summary=summary,
                empirical_jobs_status={"ready": True, "status": "healthy"},
                quant_health_status=self._healthy_quant_status(),
                promotion_certificate_evidence=[
                    {
                        "hypothesis_id": "H-CONT-01",
                        "metric_window": self._metric_window(
                            capital_stage="shadow",
                            observed_stage="paper",
                        ),
                        "promotion_decision": self._promotion_decision(
                            capital_stage="shadow"
                        ),
                    }
                ],
                session=session,
            )

        self.assertEqual(summary["promotion_eligible_total"], 0)
        self.assertEqual(summary["paper_probation_eligible_total"], 1)
        item = summary["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertTrue(item["paper_probation_eligible"])
        self.assertEqual(item["paper_probation_target_capital_stage"], "shadow")
        self.assertEqual(item["candidate_id"], "cand-runtime-paper")
        self.assertEqual(item["state"], "shadow")
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["capital_multiplier"], "0")
        self.assertEqual(item["reasons"], ["paper_probation_evidence_collection_only"])
        self.assertEqual(
            item["informational_reasons"],
            [
                "runtime_window_certificate_readiness_applied",
                "runtime_window_paper_probation_applied",
            ],
        )
        self.assertEqual(
            item["observed"]["runtime_window_prior_reasons"],
            ["drift_checks_missing"],
        )
        self.assertFalse(gate["allowed"])
        self.assertIn(
            "alpha_readiness_not_promotion_eligible",
            gate["blocked_reasons"],
        )
        self.assertIn("promotion_certificate_shadow_only", gate["blocked_reasons"])
        self.assertIn("alpha_hypothesis_shadow_only", gate["blocked_reasons"])

        stale_summary = dict(summary)
        stale_summary.update(
            {
                "items": runtime_items,
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "reason_totals": {"drift_checks_missing": 1},
                "informational_reason_totals": {},
            }
        )
        stale_gate = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary=stale_summary,
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(
                        capital_stage="shadow",
                        observed_stage="paper",
                    ),
                    "promotion_decision": self._promotion_decision(
                        capital_stage="shadow"
                    ),
                }
            ],
            session=session,
        )

        self.assertEqual(stale_gate["promotion_eligible_total"], 0)
        self.assertEqual(stale_gate["paper_probation_eligible_total"], 1)
        self.assertIn(
            "alpha_readiness_not_promotion_eligible",
            stale_gate["blocked_reasons"],
        )
        self.assertIn(
            "promotion_certificate_shadow_only",
            stale_gate["blocked_reasons"],
        )
        self.assertIn("alpha_hypothesis_shadow_only", stale_gate["blocked_reasons"])

        non_shadow_paper_gate = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary=stale_summary,
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(
                        capital_stage="0.10x canary",
                        observed_stage="paper",
                    ),
                    "promotion_decision": self._promotion_decision(
                        capital_stage="0.10x canary"
                    ),
                }
            ],
            session=session,
        )

        self.assertEqual(non_shadow_paper_gate["promotion_eligible_total"], 0)
        self.assertEqual(non_shadow_paper_gate["paper_probation_eligible_total"], 1)
        self.assertIn(
            "alpha_readiness_not_promotion_eligible",
            non_shadow_paper_gate["blocked_reasons"],
        )
        self.assertIn(
            "promotion_certificate_not_live_runtime",
            non_shadow_paper_gate["blocked_reasons"],
        )

    def test_hypothesis_runtime_summary_rejects_unmatched_promotion_decision(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-current",
                    candidate_id="cand-runtime-current",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-old",
                    candidate_id="cand-runtime-old",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="old_runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

            forced_item = dict(result["items"][0])
            forced_item.update(
                {
                    "promotion_eligible": True,
                    "capital_stage": "0.10x canary",
                    "capital_multiplier": "0.10",
                    "reasons": [],
                }
            )
            forced_summary = dict(result)
            forced_summary["promotion_eligible_total"] = 1
            forced_summary["items"] = [forced_item]
            gate = build_live_submission_gate_payload(
                SimpleNamespace(market_session_open=True),
                hypothesis_summary=forced_summary,
                empirical_jobs_status={"ready": True},
                dspy_runtime_status={"mode": "inactive"},
                quant_health_status={"required": False, "ok": True},
                session=session,
            )

        self.assertEqual(result["promotion_eligible_total"], 0)
        item = result["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["reasons"], ["drift_checks_missing"])
        self.assertIn("promotion_decision_evidence_missing", gate["blocked_reasons"])
        self.assertIn("promotion_certificate_missing", gate["blocked_reasons"])

    def test_hypothesis_runtime_summary_rejects_failed_runtime_proof(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-2",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=42,
                    trade_count=42,
                    order_count=42,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=False,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-2",
                    candidate_id="cand-runtime",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 0)
        item = result["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(item["reasons"], ["drift_checks_missing"])

    def test_hypothesis_runtime_summary_rejects_zero_activity_runtime_proof(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        settings.trading_drift_live_promotion_max_evidence_age_seconds = 3600
        registry = SimpleNamespace(
            loaded=True,
            path="test-registry",
            errors=[],
            items=[SimpleNamespace(hypothesis_id="H-CONT-01")],
        )
        runtime_items = [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": None,
                "strategy_id": "intraday_continuation",
                "lane_id": "continuation",
                "strategy_family": "intraday_continuation",
                "state": "shadow",
                "capital_stage": "shadow",
                "capital_multiplier": "0",
                "promotion_eligible": False,
                "rollback_required": False,
                "reasons": ["drift_checks_missing"],
                "informational_reasons": [],
                "observed": {},
            }
        ]

        with session_local() as session:
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="runtime-proof-zero",
                    candidate_id="cand-runtime-zero",
                    hypothesis_id="H-CONT-01",
                    observed_stage="paper",
                    window_started_at=now,
                    window_ended_at=now,
                    market_session_count=3,
                    decision_count=0,
                    trade_count=0,
                    order_count=0,
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="12",
                    post_cost_expectancy_bps="8.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="0.10x canary",
                )
            )
            session.add(
                StrategyPromotionDecision(
                    run_id="runtime-proof-zero",
                    candidate_id="cand-runtime-zero",
                    hypothesis_id="H-CONT-01",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=True,
                    reason_summary="runtime_evidence_thresholds_satisfied",
                )
            )
            session.commit()

            with (
                patch(
                    "app.trading.submission_council.load_hypothesis_registry",
                    return_value=registry,
                ),
                patch(
                    "app.trading.submission_council.resolve_hypothesis_dependency_quorum",
                    return_value=JangarDependencyQuorumStatus(
                        decision="allow",
                        reasons=[],
                        message="ready",
                    ),
                ),
                patch(
                    "app.trading.submission_council.compile_hypothesis_runtime_statuses",
                    return_value=runtime_items,
                ),
                patch(
                    "app.trading.submission_council.build_tca_gate_inputs",
                    return_value={},
                ),
            ):
                result = build_hypothesis_runtime_summary(
                    session,
                    state=SimpleNamespace(market_session_open=True),
                    market_context_status={"last_freshness_seconds": 10},
                )

        self.assertEqual(result["promotion_eligible_total"], 0)
        item = result["items"][0]
        self.assertFalse(item["promotion_eligible"])
        self.assertEqual(item["capital_stage"], "shadow")
        self.assertEqual(
            item["reasons"],
            [
                "drift_checks_missing",
                "hypothesis_window_decisions_missing",
                "hypothesis_window_trades_missing",
                "hypothesis_window_orders_missing",
            ],
        )
        self.assertEqual(
            item["informational_reasons"],
            ["runtime_window_certificate_rejected"],
        )
        self.assertTrue(item["observed"]["runtime_window_certificate_rejected"])
        self.assertEqual(item["observed"]["metric_window_decision_count"], 0)
        self.assertEqual(item["observed"]["metric_window_trade_count"], 0)
        self.assertEqual(item["observed"]["metric_window_order_count"], 0)

    def test_coerce_aware_datetime_normalizes_runtime_status_values(self) -> None:
        self.assertEqual(
            _coerce_aware_datetime(datetime(2026, 5, 13, 20, 56, 16)),
            datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc),
        )
        self.assertEqual(
            _coerce_aware_datetime("2026-05-13T20:56:16Z"),
            datetime(2026, 5, 13, 20, 56, 16, tzinfo=timezone.utc),
        )
        self.assertIsNone(_coerce_aware_datetime("not-a-timestamp"))
        self.assertIsNone(_coerce_aware_datetime(None))

    def test_load_profit_promotion_counts_includes_autoresearch_ledgers(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-1",
                    epoch_id="epoch-1",
                    hypothesis_id="H-CONT-01",
                    candidate_kind="sleeve",
                    family_template_id="microbar_cross_sectional_pairs_v1",
                    payload_json={"candidate_spec_id": "spec-1"},
                    payload_hash="hash",
                    status="eligible",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchProposalScore(
                    epoch_id="epoch-1",
                    candidate_spec_id="spec-1",
                    model_id="model-1",
                    backend="numpy-fallback",
                    proposal_score=Decimal("12.5"),
                    rank=1,
                    selection_reason="exploitation",
                    feature_hash="feature-hash",
                    payload_json={},
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-1",
                    epoch_id="epoch-1",
                    source_candidate_ids_json=["spec-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={"oracle_passed": False},
                    optimizer_report_json={"selected_count": 1},
                    payload_json={"portfolio_candidate_id": "portfolio-1"},
                    status="blocked",
                )
            )
            session.commit()

            counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["research_candidates"], 0)
        self.assertEqual(counts["autoresearch_epochs"], 1)
        self.assertEqual(counts["autoresearch_candidate_specs"], 1)
        self.assertEqual(counts["autoresearch_proposal_scores"], 1)
        self.assertEqual(counts["autoresearch_portfolio_candidates"], 1)
        self.assertEqual(counts["autoresearch_portfolio_blocked"], 1)
        self.assertEqual(counts["autoresearch_portfolio_ready"], 0)
        self.assertEqual(counts["count_errors"], [])
        self.assertEqual(counts["count_basis"], "bounded_latest_rows")
        self.assertEqual(counts["count_limit"], _PROMOTION_TABLE_COUNT_SCAN_LIMIT)

    def test_load_profit_promotion_counts_use_bounded_row_reads(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="complete",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.commit()
            execute = session.execute
            statements: list[str] = []

            def capture_execute(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                statements.append(str(statement))
                return execute(statement, *args, **kwargs)

            with patch.object(session, "execute", side_effect=capture_execute):
                counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["autoresearch_epochs"], 1)
        self.assertEqual(counts["truncated_counts"], [])
        self.assertEqual(counts["read_model_scope"], "bounded_promotion_scalar_counts")
        self.assertFalse(counts["promotion_scalar_counts_exact"])
        self.assertTrue(any("count(" in statement.lower() for statement in statements))
        self.assertTrue(
            any(
                "FROM autoresearch_epochs" in statement and "LIMIT" in statement
                for statement in statements
            )
        )

    def test_load_profit_promotion_counts_fail_closed_when_portfolio_scan_truncated(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            for idx in range(_PROMOTION_PORTFOLIO_READY_SCAN_LIMIT + 1):
                session.add(
                    AutoresearchPortfolioCandidate(
                        portfolio_candidate_id=f"portfolio-{idx}",
                        epoch_id="epoch-1",
                        source_candidate_ids_json=[f"spec-{idx}"],
                        target_net_pnl_per_day=Decimal("500"),
                        objective_scorecard_json={},
                        optimizer_report_json={"selected_count": 1},
                        payload_json={"portfolio_candidate_id": f"portfolio-{idx}"},
                        status="blocked",
                    )
                )
            session.commit()

            counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(
            counts["autoresearch_portfolio_scan_limit"],
            _PROMOTION_PORTFOLIO_READY_SCAN_LIMIT,
        )
        self.assertIn(
            "autoresearch_portfolio_candidates_bounded_scan_truncated",
            counts["count_errors"],
        )

    def test_load_profit_promotion_counts_fail_closed_for_timed_out_count(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchEpoch(
                    epoch_id="epoch-1",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={},
                    started_at=datetime.now(timezone.utc),
                    completed_at=datetime.now(timezone.utc),
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-1",
                    epoch_id="epoch-1",
                    hypothesis_id="H-CONT-01",
                    candidate_kind="sleeve",
                    family_template_id="microbar_cross_sectional_pairs_v1",
                    payload_json={"candidate_spec_id": "spec-1"},
                    payload_hash="hash",
                    status="eligible",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchProposalScore(
                    epoch_id="epoch-1",
                    candidate_spec_id="spec-1",
                    model_id="model-1",
                    backend="numpy-fallback",
                    proposal_score=Decimal("12.5"),
                    rank=1,
                    selection_reason="exploitation",
                    feature_hash="feature-hash",
                    payload_json={},
                )
            )
            session.commit()

            execute = session.execute

            def fail_proposal_score_count(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                statement_text = str(statement)
                if (
                    "FROM autoresearch_proposal_scores" in statement_text
                    and "LIMIT" in statement_text
                ):
                    raise SQLAlchemyError("statement timeout")
                return execute(statement, *args, **kwargs)

            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=fail_proposal_score_count,
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["autoresearch_epochs"], 1)
        self.assertEqual(counts["autoresearch_candidate_specs"], 1)
        self.assertEqual(counts["autoresearch_proposal_scores"], 0)
        self.assertEqual(counts["read_model_scope"], "bounded_promotion_scalar_counts")
        self.assertFalse(counts["promotion_scalar_counts_exact"])
        self.assertEqual(counts["count_errors"], ["autoresearch_proposal_scores"])
        self.assertEqual(rollback.call_count, 1)

    def test_latest_runtime_ledger_summary_timeout_is_explicit(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                summary = _load_latest_runtime_ledger_summary(
                    session,
                    hypothesis_ids=["H-CONT-01"],
                )

        self.assertEqual(summary["by_hypothesis"], {})
        self.assertEqual(summary["runtime_ledger_buckets"], [])
        self.assertTrue(summary["read_model_unavailable"])
        self.assertEqual(
            summary["reason_codes"], ["runtime_ledger_summary_query_timeout"]
        )
        self.assertEqual(rollback.call_count, 1)

    def test_certificate_evidence_timeout_is_explicit_and_fail_closed(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                evidence = _load_latest_certificate_evidence(
                    session,
                    hypothesis_ids=["H-CONT-01"],
                    now=datetime.now(timezone.utc),
                    max_age_seconds=900,
                )

        self.assertEqual(len(evidence), 1)
        self.assertIsNone(evidence[0]["metric_window"])
        self.assertIsNone(evidence[0]["promotion_decision"])
        self.assertTrue(evidence[0]["read_model_unavailable"])
        self.assertEqual(
            evidence[0]["reason_codes"], ["certificate_evidence_query_timeout"]
        )
        self.assertEqual(rollback.call_count, 1)

    def test_load_profit_promotion_counts_fail_closed_for_portfolio_timeout(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            with (
                patch.object(
                    session,
                    "execute",
                    side_effect=SQLAlchemyError("statement timeout"),
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["research_candidates"], 0)
        self.assertEqual(counts["autoresearch_portfolio_candidates"], 0)
        self.assertEqual(counts["autoresearch_portfolio_ready_refs"], [])
        self.assertEqual(counts["count_errors"], ["autoresearch_portfolio_candidates"])
        self.assertEqual(rollback.call_count, 1)

    def test_load_profit_promotion_counts_keeps_ready_refs_when_spec_ref_times_out(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-1",
                    epoch_id="epoch-1",
                    source_candidate_ids_json=["spec-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={},
                    optimizer_report_json={"selected_count": 1},
                    payload_json={"portfolio_candidate_id": "portfolio-1"},
                    status="target_met",
                )
            )
            session.commit()

            execute = session.execute

            def fail_ready_spec_ref(
                statement: object, *args: object, **kwargs: object
            ) -> object:
                statement_text = str(statement)
                if (
                    "FROM autoresearch_candidate_specs" in statement_text
                    and "WHERE autoresearch_candidate_specs.candidate_spec_id IN"
                    in statement_text
                ):
                    raise SQLAlchemyError("statement timeout")
                return execute(statement, *args, **kwargs)

            with (
                patch(
                    "app.trading.submission_council._autoresearch_portfolio_current_oracle_passed",
                    return_value=True,
                ),
                patch.object(
                    session,
                    "execute",
                    side_effect=fail_ready_spec_ref,
                ),
                patch.object(session, "rollback", wraps=session.rollback) as rollback,
            ):
                counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["autoresearch_portfolio_candidates"], 1)
        self.assertEqual(counts["autoresearch_portfolio_ready"], 1)
        self.assertEqual(counts["autoresearch_portfolio_blocked"], 0)
        self.assertEqual(
            counts["autoresearch_portfolio_ready_refs"],
            [
                "candidate_spec_id:spec-1",
                "portfolio_candidate_id:portfolio-1",
                "source_candidate_id:spec-1",
            ],
        )
        self.assertEqual(counts["count_errors"], ["autoresearch_candidate_specs"])
        self.assertEqual(rollback.call_count, 1)

    def test_load_profit_promotion_counts_rejudges_ready_autoresearch_portfolios(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id="spec-2",
                    epoch_id="epoch-current",
                    hypothesis_id="H-PORT-READY",
                    candidate_kind="strategy",
                    family_template_id="portfolio_ready_family",
                    payload_json={},
                    payload_hash="spec-2-hash",
                    status="scored",
                    blockers_json=[],
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-stale-ready",
                    epoch_id="epoch-stale",
                    source_candidate_ids_json=["spec-1"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={
                        "oracle_passed": True,
                        "net_pnl_per_day": "9373",
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "0.50",
                        "best_day_share": "1.0",
                        "max_cluster_contribution_share": "1.0",
                        "max_single_symbol_contribution_share": "0.90",
                        "worst_day_loss": "2978",
                        "max_drawdown": "2978",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "1000",
                        "negative_cash_observation_count": 0,
                        "avg_filled_notional_per_day": "300000",
                        "regime_slice_pass_rate": "0.5",
                        "posterior_edge_lower": "1",
                        "shadow_parity_status": "within_budget",
                        "executable_replay_passed": True,
                        "executable_replay_order_count": 1,
                        "executable_replay_account_buying_power": "31590",
                        "executable_replay_max_notional_per_trade": "5000",
                    },
                    optimizer_report_json={"method": "old_optimizer"},
                    payload_json={"portfolio_candidate_id": "portfolio-stale-ready"},
                    status="target_met",
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-current-ready",
                    epoch_id="epoch-current",
                    source_candidate_ids_json=["spec-2"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json={
                        "net_pnl_per_day": "600",
                        "trading_day_count": 20,
                        "daily_net": {
                            "2026-05-01": "600",
                            "2026-05-02": "575",
                            "2026-05-03": "610",
                            "2026-05-04": "590",
                            "2026-05-05": "620",
                            "2026-05-06": "605",
                            "2026-05-07": "615",
                            "2026-05-08": "585",
                            "2026-05-09": "595",
                            "2026-05-10": "605",
                            "2026-05-11": "600",
                            "2026-05-12": "575",
                            "2026-05-13": "610",
                            "2026-05-14": "590",
                            "2026-05-15": "620",
                            "2026-05-16": "605",
                            "2026-05-17": "615",
                            "2026-05-18": "585",
                            "2026-05-19": "595",
                            "2026-05-20": "605",
                        },
                        "active_day_ratio": "1.0",
                        "positive_day_ratio": "1.0",
                        "best_day_share": "0.12",
                        "max_single_day_contribution_share": "0.12",
                        "max_cluster_contribution_share": "0.20",
                        "max_single_symbol_contribution_share": "0.20",
                        "worst_day_loss": "500",
                        "max_drawdown": "1000",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "1000",
                        "negative_cash_observation_count": 0,
                        "avg_filled_notional_per_day": "300000",
                        "regime_slice_pass_rate": "0.80",
                        "posterior_edge_lower": "1",
                        "shadow_parity_status": "within_budget",
                        "executable_replay_passed": True,
                        "executable_replay_artifact_ref": "s3://proof/current-ready.json",
                        "executable_replay_order_count": 4,
                        "executable_replay_account_buying_power": "31590",
                        "executable_replay_max_notional_per_trade": "5000",
                        "exact_replay_ledger_artifact_ref": "s3://proof/current-ready-ledger.json",
                        "exact_replay_ledger_artifact_row_count": 20,
                        "exact_replay_ledger_artifact_fill_count": 20,
                        "portfolio_post_cost_net_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                        "portfolio_post_cost_net_pnl_source": "exact_replay_runtime_ledger",
                        "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                        "runtime_ledger_pnl_source": "runtime_ledger",
                        "market_impact_stress_passed": True,
                        "market_impact_stress_artifact_ref": "s3://proof/current-ready-impact.json",
                        "market_impact_stress_model": "square_root",
                        "market_impact_stress_cost_bps": "6",
                        "market_impact_liquidity_evidence_present": True,
                        "market_impact_stress_net_pnl_per_day": "535",
                        "delay_adjusted_depth_stress_passed": True,
                        "delay_adjusted_depth_stress_artifact_ref": (
                            "s3://proof/current-ready-delay-depth.json"
                        ),
                        "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                        "delay_adjusted_depth_stress_ms": "250",
                        "delay_adjusted_depth_liquidity_evidence_present": True,
                        "delay_adjusted_depth_latency_grid_ms": ["50", "150", "250"],
                        "delay_adjusted_depth_grid_max_stress_ms": "250",
                        "delay_adjusted_depth_fillable_notional_per_day": "300000",
                        "delay_adjusted_depth_worst_grid_fillable_notional_per_day": "300000",
                        "delay_adjusted_depth_worst_active_day_fillable_notional": "300000",
                        "delay_adjusted_depth_p10_active_day_fillable_notional": "300000",
                        "delay_adjusted_depth_tail_coverage_passed": True,
                        "delay_adjusted_depth_stress_net_pnl_per_day": "525",
                        "delay_adjusted_depth_fill_survival_evidence_present": True,
                        "delay_adjusted_depth_fill_survival_sample_count": 20,
                        "delay_adjusted_depth_fill_survival_rate": "1.00",
                        "queue_position_survival_fill_curve_evidence_present": True,
                        "queue_position_survival_sample_count": 20,
                        "queue_position_survival_fill_rate": "1.00",
                        "queue_position_survival_queue_ratio_p95": "0.25",
                        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                        "queue_position_survival_queue_ahead_depletion_sample_count": 20,
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 20,
                        "queue_ahead_depletion_evidence_present": True,
                        "queue_ahead_depletion_sample_count": 20,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "525",
                        "double_oos_passed": True,
                        "double_oos_artifact_ref": "s3://proof/current-ready-double-oos.json",
                        "double_oos_independent_window_count": 2,
                        "double_oos_pass_rate": "1.00",
                        "double_oos_net_pnl_per_day": "540",
                        "double_oos_cost_shock_net_pnl_per_day": "515",
                    },
                    optimizer_report_json={"method": "current_optimizer"},
                    payload_json={"portfolio_candidate_id": "portfolio-current-ready"},
                    status="target_met",
                )
            )
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-invalid-scorecard",
                    epoch_id="epoch-invalid",
                    source_candidate_ids_json=["spec-3"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json=["not", "a", "scorecard"],
                    optimizer_report_json={"method": "bad_writer"},
                    payload_json={
                        "portfolio_candidate_id": "portfolio-invalid-scorecard"
                    },
                    status="target_met",
                )
            )
            session.commit()

            counts = _load_profit_promotion_table_counts(session)

        self.assertEqual(counts["autoresearch_portfolio_candidates"], 3)
        self.assertEqual(counts["autoresearch_portfolio_ready"], 1)
        self.assertEqual(counts["autoresearch_portfolio_blocked"], 2)
        self.assertEqual(
            counts["autoresearch_portfolio_ready_refs"],
            [
                "candidate_spec_id:spec-2",
                "hypothesis_id:H-PORT-READY",
                "portfolio_candidate_id:portfolio-current-ready",
                "source_candidate_id:spec-2",
            ],
        )

    def test_profit_lease_projection_uses_runtime_feature_and_persisted_decision_evidence(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        now = datetime.now(timezone.utc)
        with session_local() as session:
            strategy = Strategy(
                name="demo",
                description="demo",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=["AAPL"],
            )
            session.add(strategy)
            session.commit()
            session.add_all(
                [
                    TradeDecision(
                        strategy_id=strategy.id,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        timeframe="1Min",
                        decision_json={"action": "buy"},
                        status="planned",
                        created_at=now,
                    ),
                    TradeDecision(
                        strategy_id=strategy.id,
                        alpaca_account_label="paper",
                        symbol="AAPL",
                        timeframe="1Min",
                        decision_json={"action": "sell"},
                        status="blocked",
                        created_at=now,
                    ),
                ]
            )
            session.commit()

            result = build_live_submission_gate_payload(
                SimpleNamespace(
                    last_autonomy_promotion_eligible=True,
                    last_autonomy_promotion_action="promote",
                    drift_live_promotion_eligible=False,
                    last_market_context_freshness_seconds=45,
                    metrics=SimpleNamespace(
                        feature_batch_rows_total=9,
                        feature_null_rate={"price": 0.0},
                        feature_staleness_ms_p95=250,
                        feature_duplicate_ratio=0.0,
                        decision_state_total={},
                    ),
                ),
                hypothesis_summary={
                    "summary": {
                        "promotion_eligible_total": 1,
                        "capital_stage_totals": {"shadow": 1},
                        "dependency_quorum": {
                            "decision": "allow",
                            "reasons": [],
                            "message": "ready",
                        },
                    },
                    "items": [
                        {
                            "hypothesis_id": "H-CONT-01",
                            "lane_id": "continuation",
                            "strategy_family": "intraday_continuation",
                            "promotion_eligible": True,
                            "capital_stage": "shadow",
                            "reasons": [],
                        }
                    ],
                },
                empirical_jobs_status={"ready": True, "status": "healthy"},
                quant_health_status=self._healthy_quant_status(),
                promotion_certificate_evidence=[
                    {
                        "hypothesis_id": "H-CONT-01",
                        "metric_window": self._metric_window(),
                        "promotion_decision": self._promotion_decision(),
                    }
                ],
                session=session,
            )

        projection = result["profit_lease_projection"]
        reasons = projection["torghut_capital"]["blocking_reason_codes"]
        self.assertNotIn("equity_ta_rows_missing", reasons)
        self.assertNotIn("rejection_drag_unmeasured", reasons)
        equity_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "equity_ta"
        )
        rejection_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "rejection_drag"
        )
        self.assertEqual(equity_source["rows"], 9)
        self.assertEqual(rejection_source["rows"], 2)
        self.assertEqual(rejection_source["source_ref"], "postgres:trade_decisions:7d")

    def test_profit_lease_projection_qualifies_runtime_items_with_ready_autoresearch_refs(
        self,
    ) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        with session_local() as session:
            session.add_all(
                [
                    AutoresearchCandidateSpec(
                        candidate_spec_id="spec-ready",
                        epoch_id="epoch-current",
                        hypothesis_id="H-CONT-01",
                        candidate_kind="strategy",
                        family_template_id="portfolio_ready_family",
                        payload_json={},
                        payload_hash="spec-ready-hash",
                        status="scored",
                        blockers_json=[],
                    ),
                    AutoresearchProposalScore(
                        epoch_id="epoch-current",
                        candidate_spec_id="spec-ready",
                        model_id="mlx-ranker",
                        backend="mlx",
                        proposal_score=Decimal("11.0"),
                        rank=1,
                        selection_reason="exploitation",
                        feature_hash="feature-hash",
                        payload_json={},
                    ),
                    AutoresearchPortfolioCandidate(
                        portfolio_candidate_id="portfolio-current-ready",
                        epoch_id="epoch-current",
                        source_candidate_ids_json=["spec-ready"],
                        target_net_pnl_per_day=Decimal("500"),
                        objective_scorecard_json={
                            "net_pnl_per_day": "600",
                            "trading_day_count": 20,
                            "daily_net": {
                                "2026-05-01": "600",
                                "2026-05-02": "575",
                                "2026-05-03": "610",
                                "2026-05-04": "590",
                                "2026-05-05": "620",
                                "2026-05-06": "605",
                                "2026-05-07": "615",
                                "2026-05-08": "585",
                                "2026-05-09": "595",
                                "2026-05-10": "605",
                                "2026-05-11": "600",
                                "2026-05-12": "575",
                                "2026-05-13": "610",
                                "2026-05-14": "590",
                                "2026-05-15": "620",
                                "2026-05-16": "605",
                                "2026-05-17": "615",
                                "2026-05-18": "585",
                                "2026-05-19": "595",
                                "2026-05-20": "605",
                            },
                            "active_day_ratio": "1.0",
                            "positive_day_ratio": "1.0",
                            "best_day_share": "0.12",
                            "max_single_day_contribution_share": "0.12",
                            "max_cluster_contribution_share": "0.20",
                            "max_single_symbol_contribution_share": "0.20",
                            "worst_day_loss": "500",
                            "max_drawdown": "1000",
                            "max_gross_exposure_pct_equity": "0.5",
                            "min_cash": "1000",
                            "negative_cash_observation_count": 0,
                            "avg_filled_notional_per_day": "300000",
                            "regime_slice_pass_rate": "0.80",
                            "posterior_edge_lower": "1",
                            "shadow_parity_status": "within_budget",
                            "executable_replay_passed": True,
                            "executable_replay_artifact_ref": "s3://proof/current-ready.json",
                            "executable_replay_order_count": 4,
                            "executable_replay_account_buying_power": "31590",
                            "executable_replay_max_notional_per_trade": "5000",
                            "exact_replay_ledger_artifact_ref": "s3://proof/current-ready-ledger.json",
                            "exact_replay_ledger_artifact_row_count": 20,
                            "exact_replay_ledger_artifact_fill_count": 20,
                            "portfolio_post_cost_net_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                            "portfolio_post_cost_net_pnl_source": "exact_replay_runtime_ledger",
                            "runtime_ledger_pnl_basis": "realized_strategy_pnl_after_explicit_costs",
                            "runtime_ledger_pnl_source": "runtime_ledger",
                            "market_impact_stress_passed": True,
                            "market_impact_stress_artifact_ref": "s3://proof/current-ready-impact.json",
                            "market_impact_stress_model": "square_root",
                            "market_impact_stress_cost_bps": "6",
                            "market_impact_liquidity_evidence_present": True,
                            "market_impact_stress_net_pnl_per_day": "535",
                            "delay_adjusted_depth_stress_passed": True,
                            "delay_adjusted_depth_stress_artifact_ref": (
                                "s3://proof/current-ready-delay-depth.json"
                            ),
                            "delay_adjusted_depth_stress_model": "latency_depth_haircut",
                            "delay_adjusted_depth_stress_ms": "250",
                            "delay_adjusted_depth_liquidity_evidence_present": True,
                            "delay_adjusted_depth_latency_grid_ms": [
                                "50",
                                "150",
                                "250",
                            ],
                            "delay_adjusted_depth_grid_max_stress_ms": "250",
                            "delay_adjusted_depth_fillable_notional_per_day": "300000",
                            "delay_adjusted_depth_worst_grid_fillable_notional_per_day": "300000",
                            "delay_adjusted_depth_worst_active_day_fillable_notional": "300000",
                            "delay_adjusted_depth_p10_active_day_fillable_notional": "300000",
                            "delay_adjusted_depth_tail_coverage_passed": True,
                            "delay_adjusted_depth_stress_net_pnl_per_day": "525",
                            "delay_adjusted_depth_fill_survival_evidence_present": True,
                            "delay_adjusted_depth_fill_survival_sample_count": 20,
                            "delay_adjusted_depth_fill_survival_rate": "1.00",
                            "queue_position_survival_fill_curve_evidence_present": True,
                            "queue_position_survival_sample_count": 20,
                            "queue_position_survival_fill_rate": "1.00",
                            "queue_position_survival_queue_ratio_p95": "0.25",
                            "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                            "queue_position_survival_queue_ahead_depletion_sample_count": 20,
                            "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                            "delay_adjusted_depth_queue_ahead_depletion_sample_count": 20,
                            "queue_ahead_depletion_evidence_present": True,
                            "queue_ahead_depletion_sample_count": 20,
                            "post_cost_net_pnl_after_queue_position_survival_fill_stress": "525",
                            "double_oos_passed": True,
                            "double_oos_artifact_ref": "s3://proof/current-ready-double-oos.json",
                            "double_oos_independent_window_count": 2,
                            "double_oos_pass_rate": "1.00",
                            "double_oos_net_pnl_per_day": "540",
                            "double_oos_cost_shock_net_pnl_per_day": "515",
                        },
                        optimizer_report_json={"method": "current_optimizer"},
                        payload_json={
                            "portfolio_candidate_id": "portfolio-current-ready"
                        },
                        status="target_met",
                    ),
                ]
            )
            session.commit()

            result = build_live_submission_gate_payload(
                SimpleNamespace(
                    last_autonomy_promotion_eligible=True,
                    last_autonomy_promotion_action="promote",
                    drift_live_promotion_eligible=False,
                    last_market_context_freshness_seconds=45,
                    metrics=SimpleNamespace(
                        feature_batch_rows_total=9,
                        feature_null_rate={"price": 0.0},
                        feature_staleness_ms_p95=250,
                        feature_duplicate_ratio=0.0,
                        decision_state_total={},
                    ),
                ),
                hypothesis_summary={
                    "summary": {
                        "promotion_eligible_total": 2,
                        "capital_stage_totals": {"shadow": 2},
                        "dependency_quorum": {
                            "decision": "allow",
                            "reasons": [],
                            "message": "ready",
                        },
                    },
                    "items": [
                        {
                            "hypothesis_id": "H-CONT-01",
                            "lane_id": "continuation",
                            "strategy_family": "intraday_continuation",
                            "promotion_eligible": True,
                            "capital_stage": "shadow",
                            "reasons": [],
                        },
                        {
                            "hypothesis_id": "H-UNRELATED",
                            "lane_id": "unrelated",
                            "strategy_family": "intraday_continuation",
                            "candidate_id": "cand-unrelated",
                            "promotion_eligible": True,
                            "capital_stage": "shadow",
                            "reasons": [],
                        },
                    ],
                },
                empirical_jobs_status={"ready": True, "status": "healthy"},
                quant_health_status=self._healthy_quant_status(),
                session=session,
                clickhouse_ta_status={
                    "state": "current",
                    "source_ref": "torghut.ta_signals",
                    "signal_rows": 12,
                    "symbol_count": 6,
                },
            )

        projection = result["profit_lease_projection"]
        promotion_sources = {
            source["hypothesis_id"]: source
            for source in projection["source_provenance"]
            if source["source_class"] == "research_candidate"
        }
        self.assertEqual(promotion_sources["H-CONT-01"]["freshness_state"], "current")
        self.assertIn(
            "hypothesis_id:H-CONT-01",
            promotion_sources["H-CONT-01"]["source_ref"],
        )
        self.assertEqual(promotion_sources["H-UNRELATED"]["freshness_state"], "blocked")
        self.assertIn(
            "autoresearch_portfolio_match_unverified",
            promotion_sources["H-UNRELATED"]["blocking_reason_codes"],
        )

    def test_profit_lease_projection_uses_clickhouse_ta_readiness_after_restart(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=0,
                    feature_null_rate={},
                    feature_staleness_ms_p95=0,
                    feature_duplicate_ratio=None,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "promotion_eligible": True,
                        "capital_stage": "shadow",
                        "reasons": [],
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            clickhouse_ta_status={
                "state": "current",
                "source_ref": "torghut.ta_signals",
                "latest_signal_at": "2026-05-13T20:56:16+00:00",
                "signal_rows": 12,
                "symbol_count": 6,
            },
        )

        projection = result["profit_lease_projection"]
        reasons = projection["torghut_capital"]["blocking_reason_codes"]
        self.assertNotIn("equity_ta_rows_missing", reasons)
        equity_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "equity_ta"
        )
        self.assertEqual(equity_source["rows"], 12)
        self.assertEqual(equity_source["symbols"], 6)
        self.assertEqual(equity_source["source_ref"], "torghut.ta_signals")

    def test_build_live_submission_gate_payload_exports_runtime_window_health_inputs(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_signal_continuity_state="expected_market_closed_staleness",
                last_signal_continuity_reason="cursor_tail_stable",
                last_signal_continuity_actionable=False,
                signal_continuity_alert_active=False,
                signal_continuity_alert_reason=None,
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
        )

        self.assertEqual(result["continuity_ok"], "true")
        self.assertEqual(result["continuity_source"], "signal_continuity")
        self.assertEqual(
            result["continuity_reason"], "expected_market_closed_staleness"
        )
        self.assertEqual(result["drift_ok"], "false")
        self.assertEqual(result["drift_source"], "drift_live_promotion_eligible")
        self.assertEqual(result["drift_reason"], "drift_live_promotion_ineligible")
        gate = result["runtime_window_import_health_gate"]
        self.assertEqual(gate["source"], "live_submission_gate")
        self.assertEqual(gate["dependency_quorum_decision"], "allow")
        self.assertEqual(gate["continuity_ok"], "true")
        self.assertEqual(gate["drift_ok"], "false")
        self.assertEqual(gate["blockers"], [])
        self.assertTrue(gate["ready"])
        self.assertEqual(gate["promotion_blockers"], ["drift_checks_not_ok"])
        self.assertEqual(result["runtime_window_import_health_gate_blockers"], [])
        self.assertEqual(
            result["runtime_window_import_promotion_blockers"],
            ["drift_checks_not_ok"],
        )

    def test_build_live_submission_gate_payload_blocks_runtime_window_on_signal_alert(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=True,
                last_signal_continuity_state="signal_lag_exceeded",
                last_signal_continuity_reason="signal_lag_exceeded",
                last_signal_continuity_actionable=True,
                signal_continuity_alert_active=True,
                signal_continuity_alert_reason="signal_lag_exceeded",
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
        )

        self.assertEqual(result["continuity_ok"], "false")
        self.assertEqual(result["continuity_source"], "signal_continuity")
        self.assertEqual(result["continuity_reason"], "signal_lag_exceeded")
        self.assertEqual(result["drift_ok"], "true")
        self.assertEqual(
            result["runtime_window_import_health_gate"]["blockers"],
            ["evidence_continuity_not_ok"],
        )

    def test_build_live_submission_gate_payload_clears_signal_lag_with_fresh_clickhouse_status(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=True,
                last_signal_continuity_state="signal_lag_exceeded",
                last_signal_continuity_reason="signal_lag_exceeded",
                last_signal_continuity_actionable=True,
                signal_continuity_alert_active=True,
                signal_continuity_alert_reason="signal_lag_exceeded",
                last_market_context_freshness_seconds=45,
                metrics=SimpleNamespace(
                    feature_batch_rows_total=9,
                    feature_null_rate={"price": 0.0},
                    feature_staleness_ms_p95=250,
                    feature_duplicate_ratio=0.0,
                    decision_state_total={},
                ),
            ),
            hypothesis_summary={
                "promotion_eligible_total": 0,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            clickhouse_ta_status={
                "state": "current",
                "latest_signal_at": datetime.now(timezone.utc).isoformat(),
                "equity_ta_rows": 12,
                "equity_ta_symbols": 2,
                "source_ref": "clickhouse:ta_signals",
            },
        )

        self.assertEqual(result["continuity_ok"], "true")
        self.assertEqual(result["continuity_source"], "clickhouse_ta_status")
        self.assertEqual(result["continuity_reason"], "signals_present")
        self.assertEqual(result["runtime_window_import_health_gate"]["blockers"], [])

    def test_build_live_submission_gate_payload_fails_closed_on_empty_quant_evidence(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status={
                "required": True,
                "ok": False,
                "reason": "quant_latest_metrics_empty",
                "blocking_reasons": [
                    "quant_latest_metrics_empty",
                    "quant_latest_store_alarm",
                ],
                "account": "paper",
                "window": "15m",
                "status": "degraded",
                "latest_metrics_count": 0,
                "latest_metrics_updated_at": None,
                "empty_latest_store_alarm": True,
                "missing_update_alarm": False,
                "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
            },
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["reason"], "quant_latest_metrics_empty")
        self.assertEqual(result["capital_state"], "observe")
        self.assertIn("quant_latest_store_alarm", result["blocked_reasons"])
        self.assertEqual(result["quant_health_ref"]["window"], "15m")

    def test_build_live_submission_gate_payload_requires_valid_certificate_evidence(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"0.10x canary": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": "cand-1",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "promotion_eligible": True,
                        "capital_stage": "0.10x canary",
                        "reasons": [],
                        "observed": self._runtime_ledger_observed(),
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                    "runtime_ledger_bucket": self._runtime_ledger_bucket_payload(),
                }
            ],
        )

        self.assertTrue(result["allowed"])
        self.assertEqual(result["capital_state"], "0.10x canary")
        self.assertEqual(result["reason_codes"], ["promotion_certificate_valid"])
        self.assertEqual(result["evidence_tuple"]["hypothesis_id"], "H-CONT-01")
        self.assertEqual(result["evidence_tuple"]["candidate_id"], "cand-1")

    def test_build_live_submission_gate_payload_blocks_paper_runtime_certificate_for_live_submission(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 1,
                    "capital_stage_totals": {"0.10x canary": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "candidate_id": "cand-1",
                        "strategy_id": "intraday_tsmom_v1@paper",
                        "promotion_eligible": True,
                        "capital_stage": "0.10x canary",
                        "reasons": [],
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(observed_stage="paper"),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["capital_state"], "observe")
        self.assertIn(
            "promotion_certificate_not_live_runtime",
            result["blocked_reasons"],
        )
        self.assertNotIn(
            "promotion_certificate_valid",
            result["reason_codes"],
        )

    def test_build_live_submission_gate_payload_scopes_paper_probation_blockers_to_runtime_candidate(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=900,
                last_market_context_domain_states={"news": "stale"},
                market_context_alert_active=True,
                market_context_alert_reason="market_context_stale",
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 0,
                    "paper_probation_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 2},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-PAIRS-01",
                        "candidate_id": "c88421d619759b2cfaa6f4d0",
                        "lane_id": "microbar-cross-sectional-pairs",
                        "strategy_family": "microbar_cross_sectional_pairs",
                        "strategy_id": "microbar_cross_sectional_pairs_v1@research",
                        "promotion_eligible": False,
                        "paper_probation_eligible": True,
                        "capital_stage": "shadow",
                        "reasons": ["paper_probation_evidence_collection_only"],
                        "segment_dependencies": ["execution", "empirical", "ta-core"],
                    },
                    {
                        "hypothesis_id": "H-REV-01",
                        "candidate_id": "rev-candidate",
                        "lane_id": "event-reversion",
                        "strategy_family": "event_reversion",
                        "strategy_id": "microbar_prev_day_open45_reversal_long_top1_chip_v1@paper",
                        "promotion_eligible": False,
                        "paper_probation_eligible": False,
                        "capital_stage": "shadow",
                        "reasons": [],
                        "segment_dependencies": [
                            "execution",
                            "empirical",
                            "llm-review",
                            "market-context",
                            "ta-core",
                        ],
                    },
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-PAIRS-01",
                    "metric_window": self._metric_window(
                        observed_stage="paper",
                        run_id="pairs-paper-window",
                        candidate_id="c88421d619759b2cfaa6f4d0",
                        hypothesis_id="H-PAIRS-01",
                    ),
                    "promotion_decision": self._promotion_decision(
                        run_id="pairs-paper-window",
                        candidate_id="c88421d619759b2cfaa6f4d0",
                        hypothesis_id="H-PAIRS-01",
                    ),
                },
                {
                    "hypothesis_id": "H-REV-01",
                    "metric_window": self._metric_window(
                        run_id="rev-live-window",
                        candidate_id="rev-candidate",
                        hypothesis_id="H-REV-01",
                    ),
                    "promotion_decision": self._promotion_decision(
                        run_id="rev-live-window",
                        candidate_id="rev-candidate",
                        hypothesis_id="H-REV-01",
                    ),
                },
            ],
        )

        self.assertFalse(result["allowed"])
        self.assertIn(
            "promotion_certificate_not_live_runtime",
            result["blocked_reasons"],
        )
        self.assertNotIn("segment_market-context_blocked", result["blocked_reasons"])
        self.assertNotIn("market_context_stale", result["blocked_reasons"])
        self.assertNotIn(
            "market_context_domain_news_stale",
            result["blocked_reasons"],
        )

    def test_build_live_submission_gate_payload_blocks_without_certificate_evidence(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["capital_state"], "observe")
        self.assertEqual(result["reason"], "promotion_certificate_missing")
        self.assertIn("hypothesis_window_evidence_missing", result["blocked_reasons"])
        contract = result["profit_window_contract"]
        self.assertEqual(
            contract["schema_version"], "torghut.profit-window-contract.v1"
        )
        self.assertEqual(contract["summary"]["windows_total"], 0)

    def test_build_live_submission_gate_payload_blocks_when_hypothesis_runtime_item_is_shadow(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 1,
                    "capital_stage_totals": {"shadow": 1},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "promotion_eligible": False,
                        "capital_stage": "shadow",
                        "reasons": ["signal_continuity_alert_active"],
                        "segment_dependencies": ["ta-core", "execution"],
                    }
                ],
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["capital_state"], "observe")
        self.assertIn(
            "alpha_hypothesis_not_promotion_eligible",
            result["blocked_reasons"],
        )
        self.assertIn("alpha_hypothesis_shadow_only", result["blocked_reasons"])

    def test_build_live_submission_gate_payload_blocks_when_quant_health_is_not_configured(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=True,
                last_autonomy_promotion_action="promote",
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=45,
            ),
            hypothesis_summary={
                "promotion_eligible_total": 1,
                "capital_stage_totals": {"shadow": 1},
                "dependency_quorum": {
                    "decision": "allow",
                    "reasons": [],
                    "message": "ready",
                },
            },
            empirical_jobs_status={"ready": True, "status": "healthy"},
            quant_health_status={
                "required": True,
                "ok": False,
                "reason": "quant_health_not_configured",
                "blocking_reasons": ["quant_health_not_configured"],
                "account": "paper",
                "window": "15m",
                "status": "unknown",
                "source_url": None,
            },
            promotion_certificate_evidence=[
                {
                    "hypothesis_id": "H-CONT-01",
                    "metric_window": self._metric_window(),
                    "promotion_decision": self._promotion_decision(),
                }
            ],
        )

        self.assertFalse(result["allowed"])
        self.assertEqual(result["reason"], "quant_health_not_configured")
        self.assertIn("quant_health_not_configured", result["blocked_reasons"])

    def test_profit_window_contract_prices_stale_empirical_and_market_context_per_lane(
        self,
    ) -> None:
        result = build_live_submission_gate_payload(
            SimpleNamespace(
                last_autonomy_promotion_eligible=False,
                last_autonomy_promotion_action=None,
                drift_live_promotion_eligible=False,
                last_market_context_freshness_seconds=900,
                last_market_context_domain_states={"technicals": "down"},
                market_context_alert_active=True,
                market_context_alert_reason="market_context_down",
                market_session_open=False,
            ),
            hypothesis_summary={
                "summary": {
                    "promotion_eligible_total": 0,
                    "capital_stage_totals": {"shadow": 2},
                    "dependency_quorum": {
                        "decision": "allow",
                        "reasons": [],
                        "message": "ready",
                    },
                },
                "items": [
                    {
                        "hypothesis_id": "H-CONT-01",
                        "lane_id": "continuation",
                        "strategy_family": "intraday_continuation",
                        "state": "shadow",
                        "capital_stage": "shadow",
                        "reasons": [],
                        "dependency_capabilities": {
                            "required": [
                                "jangar_dependency_quorum",
                                "signal_continuity",
                            ],
                            "unknown": [],
                        },
                    },
                    {
                        "hypothesis_id": "H-REV-01",
                        "lane_id": "event-reversion",
                        "strategy_family": "event_reversion",
                        "state": "shadow",
                        "capital_stage": "shadow",
                        "reasons": ["market_context_stale"],
                        "dependency_capabilities": {
                            "required": [
                                "jangar_dependency_quorum",
                                "market_context_freshness",
                            ],
                            "unknown": [],
                        },
                    },
                ],
            },
            empirical_jobs_status={
                "ready": False,
                "status": "degraded",
                "stale_jobs": ["benchmark_parity"],
                "missing_jobs": [],
                "ineligible_jobs": [],
                "dataset_snapshot_refs": ["s3://torghut/empirical/cand-1"],
            },
            quant_health_status=self._healthy_quant_status(),
            promotion_certificate_evidence=[],
        )

        contract = result["profit_window_contract"]
        self.assertEqual(contract["window_session_class"], "off_session")
        self.assertEqual(contract["summary"]["windows_total"], 2)
        escrows = contract["escrows"]
        empirical_escrows = [
            item for item in escrows if item["type"] == "empirical_jobs"
        ]
        self.assertTrue(empirical_escrows)
        self.assertTrue(all(item["status"] == "expired" for item in empirical_escrows))
        rev_market_escrow = next(
            item
            for item in escrows
            if item["type"] == "market_context"
            and item["hypothesis_id"] == "H-REV-01"
            and item["evidence_escrow_id"]
            in next(
                window
                for window in contract["windows"]
                if window["hypothesis_id"] == "H-REV-01"
            )["required_escrow_ids"]
        )
        rev_window = next(
            window
            for window in contract["windows"]
            if window["hypothesis_id"] == "H-REV-01"
        )
        cont_market_escrow = next(
            item
            for item in escrows
            if item["type"] == "market_context" and item["hypothesis_id"] == "H-CONT-01"
        )
        cont_window = next(
            window
            for window in contract["windows"]
            if window["hypothesis_id"] == "H-CONT-01"
        )
        self.assertTrue(rev_market_escrow["required"])
        self.assertIn(
            rev_market_escrow["evidence_escrow_id"],
            rev_window["blocking_escrow_ids"],
        )
        self.assertFalse(cont_market_escrow["required"])
        self.assertNotIn(
            cont_market_escrow["evidence_escrow_id"],
            cont_window["blocking_escrow_ids"],
        )

    def test_resolve_quant_health_url_accepts_typed_endpoint_with_query(self) -> None:
        settings.trading_jangar_quant_health_url = " https://jangar.example/api/torghut/trading/control-plane/quant/health?window=1h "
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_market_context_url = "https://jangar.example/market/context"

        self.assertEqual(
            resolve_quant_health_url(),
            "https://jangar.example/api/torghut/trading/control-plane/quant/health?window=1h",
        )

    def test_resolve_quant_health_url_rejects_wrong_endpoint_path(self) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/status"
        )
        settings.trading_market_context_url = "https://jangar.example/market/context"

        self.assertIsNone(resolve_quant_health_url())

    def test_resolve_quant_health_url_does_not_fallback_to_control_plane_status(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_control_plane_status_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_market_context_url = (
            "https://jangar.example/api/torghut/market-context/health?symbol=NVDA"
        )

        self.assertIsNone(resolve_quant_health_url())

    def test_resolve_quant_health_url_does_not_fallback_to_market_context(self) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_control_plane_status_url = ""
        settings.trading_market_context_url = (
            "https://jangar.example/api/torghut/market-context/health?symbol=NVDA"
        )

        self.assertIsNone(resolve_quant_health_url())

    def test_load_quant_evidence_status_is_informational_when_quant_health_is_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_quant_health_required = False

        status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "not_required")
        self.assertEqual(status["reason"], "quant_health_not_configured")
        self.assertEqual(status["blocking_reasons"], [])

    def test_load_quant_evidence_status_blocks_when_quant_health_is_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = ""
        settings.trading_jangar_quant_health_required = True

        status = load_quant_evidence_status(account_label="paper")

        self.assertFalse(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["status"], "unknown")
        self.assertEqual(status["reason"], "quant_health_not_configured")
        self.assertEqual(status["blocking_reasons"], ["quant_health_not_configured"])

    def test_load_quant_evidence_status_rejects_wrong_endpoint_authority(self) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_quant_health_required = True

        status = load_quant_evidence_status(account_label="paper")

        self.assertFalse(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["reason"], "quant_health_invalid_endpoint")
        self.assertEqual(status["blocking_reasons"], ["quant_health_invalid_endpoint"])
        self.assertEqual(
            status["source_url"],
            "https://jangar.example/api/agents/control-plane/status?namespace=agents",
        )
        self.assertIn(
            "/api/torghut/trading/control-plane/quant/health",
            str(status["message"]),
        )

    def test_load_quant_evidence_status_keeps_invalid_endpoint_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/agents/control-plane/status?namespace=agents"
        )
        settings.trading_jangar_quant_health_required = False

        status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["reason"], "quant_health_invalid_endpoint")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(
            status["informational_reasons"], ["quant_health_invalid_endpoint"]
        )

    def test_load_quant_evidence_status_reads_typed_endpoint_and_uses_cache(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = "https://jangar.example/api/torghut/trading/control-plane/quant/health?source=typed"
        settings.trading_jangar_quant_health_required = True
        settings.trading_jangar_quant_window = "15m"
        settings.trading_jangar_control_plane_cache_ttl_seconds = 60
        calls: list[str] = []

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            calls.append(str(getattr(request, "full_url")))
            self.assertEqual(
                timeout, settings.trading_jangar_control_plane_timeout_seconds
            )
            return _FakeQuantHealthResponse(
                {
                    "ok": True,
                    "status": "healthy",
                    "latestMetricsCount": 4,
                    "emptyLatestStoreAlarm": False,
                    "missingUpdateAlarm": False,
                    "stages": [{"name": "metrics", "ok": "yes"}],
                    "latestMetricsUpdatedAt": "2026-04-30T20:59:00Z",
                    "metricsPipelineLagSeconds": 3,
                    "maxStageLagSeconds": 5,
                    "asOf": "2026-04-30T20:59:03Z",
                }
            )

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")
            cached_status = load_quant_evidence_status(account_label="paper")

        self.assertEqual(len(calls), 1)
        self.assertIn("source=typed", calls[0])
        self.assertIn("account=paper", calls[0])
        self.assertIn("window=15m", calls[0])
        self.assertTrue(status["ok"])
        self.assertTrue(status["required"])
        self.assertEqual(status["reason"], "ready")
        self.assertEqual(status["stage_count"], 1)
        self.assertEqual(cached_status, status)

    def test_load_quant_evidence_status_reports_quant_pipeline_blockers(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = True
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        payloads = [
            {
                "ok": True,
                "status": "healthy",
                "latestMetricsCount": 0,
                "emptyLatestStoreAlarm": True,
                "missingUpdateAlarm": True,
                "stages": [],
            },
            {
                "ok": True,
                "status": "healthy",
                "latestMetricsCount": 1,
                "emptyLatestStoreAlarm": False,
                "missingUpdateAlarm": False,
                "stages": [{"name": "metrics", "ok": "false"}],
            },
            {
                "ok": True,
                "status": "stale",
                "latestMetricsCount": 1,
                "emptyLatestStoreAlarm": False,
                "missingUpdateAlarm": False,
                "stages": [{"name": "metrics", "ok": True}],
            },
        ]

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            return _FakeQuantHealthResponse(payloads.pop(0))

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            empty_status = load_quant_evidence_status(account_label="paper")
            stage_status = load_quant_evidence_status(account_label="paper")
            stale_status = load_quant_evidence_status(account_label="paper")

        self.assertEqual(
            empty_status["blocking_reasons"],
            [
                "quant_latest_metrics_empty",
                "quant_latest_store_alarm",
                "quant_metrics_update_missing",
                "quant_pipeline_stages_missing",
            ],
        )
        self.assertEqual(stage_status["blocking_reasons"], ["quant_pipeline_degraded"])
        self.assertEqual(stale_status["blocking_reasons"], ["quant_health_degraded"])

    def test_load_quant_evidence_status_keeps_configured_degraded_endpoint_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = False
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            return _FakeQuantHealthResponse(
                {
                    "ok": True,
                    "status": "healthy",
                    "latestMetricsCount": 0,
                    "emptyLatestStoreAlarm": True,
                    "missingUpdateAlarm": False,
                    "stages": [],
                }
            )

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "degraded")
        self.assertEqual(status["reason"], "quant_latest_metrics_empty")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(
            status["informational_reasons"],
            [
                "quant_latest_metrics_empty",
                "quant_latest_store_alarm",
                "quant_pipeline_stages_missing",
            ],
        )

    def test_load_quant_evidence_status_keeps_configured_fetch_failure_informational_when_not_required(
        self,
    ) -> None:
        settings.trading_jangar_quant_health_url = (
            "https://jangar.example/api/torghut/trading/control-plane/quant/health"
        )
        settings.trading_jangar_quant_health_required = False
        settings.trading_jangar_control_plane_cache_ttl_seconds = 0

        def fake_urlopen(request: object, timeout: object) -> _FakeQuantHealthResponse:
            del request, timeout
            raise RuntimeError("network unavailable")

        with patch("app.trading.submission_council.urlopen", fake_urlopen):
            status = load_quant_evidence_status(account_label="paper")

        self.assertTrue(status["ok"])
        self.assertFalse(status["required"])
        self.assertEqual(status["status"], "unknown")
        self.assertEqual(status["reason"], "quant_health_fetch_failed")
        self.assertEqual(status["blocking_reasons"], [])
        self.assertEqual(status["informational_reasons"], ["quant_health_fetch_failed"])
        self.assertEqual(status["message"], "network unavailable")
