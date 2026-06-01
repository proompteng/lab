from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase
from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.db import get_session
from app.main import (
    _build_current_evidence_epoch,
    _daily_runtime_ledger_portfolio_summary,
    _env_json_string_list,
    app,
)
from app.models import Base, EvidenceEpochRecord, StrategyRuntimeLedgerBucket
from app.trading.evidence_epochs import (
    compile_evidence_epoch,
    load_evidence_epoch_payload,
    load_latest_evidence_epoch_payload,
)
from app.trading.evidence_receipts import (
    EvidenceReceipt,
    build_artifact_parity_receipt,
    build_data_freshness_receipt,
    build_empirical_jobs_receipt,
    build_jangar_authority_receipt,
    build_portfolio_proof_receipt,
    build_schema_receipt,
    build_service_health_receipt,
)
from app.trading.scheduler import TradingScheduler


def _runtime_ledger_source_authority_payload() -> dict[str, object]:
    return {
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
        "filled_notional": "1000",
        "cost_amount": "1",
        "cost_basis_counts": {"alpaca_2026_equity_fee_schedule": 2},
        "cost_model_hash_counts": {"cost": 2},
    }


class TestEvidenceEpochs(TestCase):
    def test_env_json_string_list_accepts_json_and_fail_closed_values(self) -> None:
        with patch.dict(
            "os.environ",
            {"TORGHUT_RUNTIME_PULL_FAILURES_JSON": '[" pull-failed ", 7, ""]'},
        ):
            self.assertEqual(
                _env_json_string_list("TORGHUT_RUNTIME_PULL_FAILURES_JSON"),
                ("pull-failed", "7"),
            )

        with patch.dict(
            "os.environ",
            {"TORGHUT_RUNTIME_PULL_FAILURES_JSON": '{"not": "a list"}'},
        ):
            self.assertEqual(
                _env_json_string_list("TORGHUT_RUNTIME_PULL_FAILURES_JSON"),
                (),
            )

        with patch.dict(
            "os.environ",
            {"TORGHUT_RUNTIME_PULL_FAILURES_JSON": "not-json"},
        ):
            self.assertEqual(
                _env_json_string_list("TORGHUT_RUNTIME_PULL_FAILURES_JSON"),
                ("not-json",),
            )

    def test_receipt_builders_cover_fail_closed_branches(self) -> None:
        observed_at = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
        default_receipt = EvidenceReceipt(
            receipt_id="ter-default",
            receipt_type="service_health",
            producer="torghut",
            subject_ref="torghut-live",
            state="pass",
            observed_at=observed_at,
            fresh_until=observed_at,
        )
        self.assertEqual(default_receipt.to_payload()["payload"], {})

        delay_receipt = build_jangar_authority_receipt(
            quorum_payload={"decision": "delay", "reasons": []},
            observed_at=observed_at,
        )
        block_receipt = build_jangar_authority_receipt(
            quorum_payload={"decision": "block", "reasons": []},
            observed_at=observed_at,
        )
        self.assertEqual(delay_receipt.state, "fail")
        self.assertEqual(block_receipt.state, "fail")

        naive_observed_at = datetime(2026, 5, 5, 12, 0)
        liveness_receipt = build_service_health_receipt(
            role="torghut-live",
            liveness_ok=False,
            readiness_ok=True,
            observed_at=naive_observed_at,
        )
        db_receipt = build_service_health_receipt(
            role="torghut-live",
            liveness_ok=True,
            readiness_ok=True,
            db_check_ok=False,
            observed_at=observed_at,
        )
        trading_receipt = build_service_health_receipt(
            role="torghut-live",
            liveness_ok=True,
            readiness_ok=True,
            trading_status_ok=False,
            observed_at=observed_at,
        )
        self.assertEqual(liveness_receipt.observed_at.tzinfo, timezone.utc)
        self.assertIn("service_liveness_failed", liveness_receipt.reason_codes)
        self.assertIn("db_check_failed", db_receipt.reason_codes)
        self.assertIn("trading_status_failed", trading_receipt.reason_codes)

        schema_receipt = build_schema_receipt(
            schema_current=True,
            lineage_ready=False,
            observed_at=observed_at,
        )
        missing_freshness_receipt = build_data_freshness_receipt(
            source="database_contract",
            fresh=True,
            as_of=None,
            observed_at=observed_at,
        )
        failed_freshness_receipt = build_data_freshness_receipt(
            source="database_contract",
            fresh=False,
            as_of=observed_at,
            observed_at=observed_at,
        )
        self.assertIn("schema_lineage_not_ready", schema_receipt.reason_codes)
        self.assertEqual(missing_freshness_receipt.state, "unknown")
        self.assertIn("data_freshness_failed", failed_freshness_receipt.reason_codes)

        ineligible_jobs_receipt = build_empirical_jobs_receipt(
            empirical_status={
                "ready": False,
                "stale_jobs": [],
                "missing_jobs": [],
                "ineligible_jobs": ["alpha_probe"],
            },
            observed_at=observed_at,
        )
        self.assertIn("empirical_jobs_ineligible", ineligible_jobs_receipt.reason_codes)

        pull_failure_receipt = build_artifact_parity_receipt(
            consumer_ref="torghut-live",
            image_ref="registry.example/torghut@sha256:abc",
            required_platforms=("linux/amd64",),
            observed_platforms=("linux/amd64",),
            runtime_pull_failures=("ImagePullBackOff",),
            observed_at=observed_at,
        )
        unknown_parity_receipt = build_artifact_parity_receipt(
            consumer_ref="torghut-live",
            image_ref="registry.example/torghut@sha256:abc",
            required_platforms=(),
            observed_platforms=(),
            observed_at=observed_at,
        )
        self.assertEqual(pull_failure_receipt.decision, "fail_pull_observed")
        self.assertEqual(unknown_parity_receipt.state, "unknown")

        holdout_missing_receipt = build_portfolio_proof_receipt(
            portfolio_candidate_id="portfolio-1",
            target_net_pnl_per_day=Decimal("500"),
            post_cost_net_pnl_per_day=Decimal("525"),
            holdout_result=None,
            runtime_closure_artifact_refs=("runtime-closure/summary.json",),
            observed_at=observed_at,
        )
        refs_missing_receipt = build_portfolio_proof_receipt(
            portfolio_candidate_id="portfolio-1",
            target_net_pnl_per_day=Decimal("500"),
            post_cost_net_pnl_per_day=Decimal("525"),
            holdout_result={"status": "pass"},
            runtime_closure_artifact_refs=(),
            observed_at=observed_at,
        )
        serializable_receipt = build_portfolio_proof_receipt(
            portfolio_candidate_id="portfolio-2",
            target_net_pnl_per_day=Decimal("500"),
            post_cost_net_pnl_per_day=Decimal("525"),
            holdout_result={
                "status": "pass",
                "checked_at": observed_at,
                "score": Decimal("1.5"),
            },
            runtime_closure_artifact_refs=("runtime-closure/summary.json",),
            observed_at=observed_at,
        )
        non_evidence_grade_receipt = build_portfolio_proof_receipt(
            portfolio_candidate_id="portfolio-1",
            target_net_pnl_per_day=Decimal("500"),
            post_cost_net_pnl_per_day=Decimal("525"),
            holdout_result={"status": "pass"},
            runtime_closure_artifact_refs=("runtime-closure/summary.json",),
            runtime_ledger_summary={"evidence_grade_bucket_count": 0},
            require_runtime_ledger_summary=True,
            observed_at=observed_at,
        )
        self.assertIn("portfolio_holdout_missing", holdout_missing_receipt.reason_codes)
        self.assertIn(
            "portfolio_runtime_closure_refs_missing",
            refs_missing_receipt.reason_codes,
        )
        self.assertEqual(non_evidence_grade_receipt.state, "fail")
        self.assertIn(
            "portfolio_runtime_ledger_summary_not_evidence_grade",
            non_evidence_grade_receipt.reason_codes,
        )
        self.assertEqual(serializable_receipt.state, "pass")

    def test_current_epoch_reports_stopped_trading_scheduler(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        scheduler = TradingScheduler()
        scheduler.state.running = False
        original_scheduler = getattr(app.state, "trading_scheduler", None)
        original_enabled = settings.trading_enabled
        original_grace = settings.trading_startup_readiness_grace_seconds
        settings.trading_enabled = True
        settings.trading_startup_readiness_grace_seconds = 0
        app.state.trading_scheduler = scheduler
        try:
            with (
                session_local() as session,
                patch(
                    "app.main._evaluate_database_contract",
                    return_value={
                        "ok": True,
                        "schema_current": True,
                        "schema_graph_lineage_ready": True,
                        "schema_graph_lineage_errors": [],
                        "schema_head_signature": "abc123",
                    },
                ),
                patch(
                    "app.main.build_empirical_jobs_status", return_value={"ready": True}
                ),
            ):
                epoch = _build_current_evidence_epoch(
                    session=session,
                    account_label="paper",
                    stage_scope="paper",
                )
        finally:
            settings.trading_enabled = original_enabled
            settings.trading_startup_readiness_grace_seconds = original_grace
            if original_scheduler is None:
                del app.state.trading_scheduler
            else:
                app.state.trading_scheduler = original_scheduler

        service_receipts = [
            receipt
            for receipt in epoch.receipts
            if receipt.receipt_type == "service_health"
        ]
        self.assertEqual(len(service_receipts), 1)
        self.assertEqual(service_receipts[0].state, "fail")
        self.assertIn("trading_status_failed", service_receipts[0].reason_codes)
        self.assertEqual(
            service_receipts[0].payload["trading_status_ok"],
            False,
        )
        self.assertIn(
            "service_health:trading_status_failed",
            epoch.reason_codes,
        )

    def test_current_epoch_portfolio_proof_uses_stage_account_runtime_ledger(
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
        day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        bucket_started_at = day_start - timedelta(minutes=15)
        bucket_ended_at = max(day_start, now - timedelta(seconds=1))
        with session_local() as session:
            for suffix, observed_stage, account_label, net_pnl in (
                ("wrong-stage", "live", "paper", Decimal("999")),
                ("wrong-account", "paper", "other-paper", Decimal("999")),
                ("right", "paper", "paper", Decimal("525")),
            ):
                session.add(
                    StrategyRuntimeLedgerBucket(
                        run_id=f"portfolio-proof-{suffix}",
                        candidate_id=f"candidate-{suffix}",
                        hypothesis_id="H-PORTFOLIO-PROOF",
                        observed_stage=observed_stage,
                        bucket_started_at=bucket_started_at,
                        bucket_ended_at=bucket_ended_at,
                        account_label=account_label,
                        runtime_strategy_name="portfolio-proof-strategy",
                        strategy_family="portfolio_proof",
                        fill_count=2,
                        decision_count=2,
                        submitted_order_count=2,
                        closed_trade_count=1,
                        open_position_count=0,
                        filled_notional=Decimal("1000"),
                        gross_strategy_pnl=net_pnl + Decimal("1"),
                        cost_amount=Decimal("1"),
                        net_strategy_pnl_after_costs=net_pnl,
                        post_cost_expectancy_bps=Decimal("1250"),
                        ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                        pnl_basis="realized_strategy_pnl_after_explicit_costs",
                        execution_policy_hash_counts={"policy": 2},
                        cost_model_hash_counts={"cost": 2},
                        lineage_hash_counts={"lineage": 2},
                        blockers_json=[],
                        payload_json=_runtime_ledger_source_authority_payload(),
                    )
                )
            session.commit()
            with (
                patch(
                    "app.main._evaluate_database_contract",
                    return_value={
                        "ok": True,
                        "schema_current": True,
                        "schema_graph_lineage_ready": True,
                        "schema_graph_lineage_errors": [],
                        "schema_head_signature": "abc123",
                    },
                ),
                patch(
                    "app.main.build_empirical_jobs_status", return_value={"ready": True}
                ),
            ):
                epoch = _build_current_evidence_epoch(
                    session=session,
                    account_label="paper",
                    stage_scope="paper",
                )

        receipt = next(
            item for item in epoch.receipts if item.receipt_type == "portfolio_proof"
        )
        self.assertEqual(receipt.payload["post_cost_net_pnl_per_day"], "525")
        self.assertEqual(receipt.payload["portfolio_candidate_id"], "candidate-right")
        summary = receipt.payload["runtime_ledger_summary"]
        self.assertEqual(summary["bucket_count"], 1)
        self.assertEqual(summary["evidence_grade_bucket_count"], 1)
        self.assertEqual(
            summary["filters"],
            {
                "account_label": "paper",
                "stage_scope": "paper",
                "observed_stage": "paper",
            },
        )
        self.assertIn("portfolio_holdout_missing", receipt.reason_codes)

    def test_daily_runtime_ledger_portfolio_summary_fails_non_evidence_rows(
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
        observed_at = datetime.now(timezone.utc)
        day_start = observed_at.replace(hour=0, minute=0, second=0, microsecond=0)
        with session_local() as session:
            session.add(
                StrategyRuntimeLedgerBucket(
                    run_id="portfolio-proof-blocked",
                    candidate_id="candidate-blocked",
                    hypothesis_id="H-PORTFOLIO-PROOF",
                    observed_stage="paper",
                    bucket_started_at=day_start - timedelta(minutes=15),
                    bucket_ended_at=max(day_start, observed_at - timedelta(seconds=1)),
                    account_label="paper",
                    runtime_strategy_name="portfolio-proof-strategy",
                    strategy_family="portfolio_proof",
                    fill_count=2,
                    decision_count=2,
                    submitted_order_count=2,
                    closed_trade_count=1,
                    open_position_count=0,
                    filled_notional=Decimal("1000"),
                    gross_strategy_pnl=Decimal("526"),
                    cost_amount=Decimal("1"),
                    net_strategy_pnl_after_costs=Decimal("525"),
                    post_cost_expectancy_bps=Decimal("1250"),
                    ledger_schema_version="torghut.runtime-ledger-bucket.v1",
                    pnl_basis="realized_strategy_pnl_after_explicit_costs",
                    execution_policy_hash_counts={"policy": 2},
                    cost_model_hash_counts={"cost": 2},
                    lineage_hash_counts={"lineage": 2},
                    blockers_json=["runtime_ledger_stage_not_live"],
                    payload_json=_runtime_ledger_source_authority_payload(),
                )
            )
            session.commit()

            summary = _daily_runtime_ledger_portfolio_summary(
                session=session,
                account_label="paper",
                stage_scope="paper",
                observed_at=observed_at,
            )

        self.assertEqual(summary["bucket_count"], 1)
        self.assertEqual(summary["evidence_grade_bucket_count"], 0)
        self.assertEqual(
            summary["blockers"],
            ["portfolio_runtime_ledger_summary_not_evidence_grade"],
        )

    def test_daily_runtime_ledger_portfolio_summary_uses_missing_stage_filter(
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
        observed_at = datetime(2026, 5, 26, 12, 0, tzinfo=timezone.utc)
        with session_local() as session:
            summary = _daily_runtime_ledger_portfolio_summary(
                session=session,
                account_label="paper",
                stage_scope="research",
                observed_at=observed_at,
            )

        self.assertEqual(
            summary["filters"]["observed_stage"],
            "__missing__",
        )
        self.assertEqual(
            summary["blockers"], ["portfolio_runtime_ledger_summary_missing"]
        )

    def test_current_epoch_portfolio_proof_fails_closed_without_daily_ledger(
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
                patch(
                    "app.main._evaluate_database_contract",
                    return_value={
                        "ok": True,
                        "schema_current": True,
                        "schema_graph_lineage_ready": True,
                        "schema_graph_lineage_errors": [],
                        "schema_head_signature": "abc123",
                    },
                ),
                patch(
                    "app.main.build_empirical_jobs_status", return_value={"ready": True}
                ),
            ):
                epoch = _build_current_evidence_epoch(
                    session=session,
                    account_label="paper",
                    stage_scope="paper",
                )

        receipt = next(
            item for item in epoch.receipts if item.receipt_type == "portfolio_proof"
        )
        self.assertEqual(receipt.state, "missing")
        self.assertIn(
            "portfolio_runtime_ledger_summary_missing",
            receipt.reason_codes,
        )
        self.assertEqual(receipt.payload["post_cost_net_pnl_per_day"], "0")

    def test_current_epoch_ignores_scalar_portfolio_candidate_ids(self) -> None:
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
                patch(
                    "app.main._evaluate_database_contract",
                    return_value={
                        "ok": True,
                        "schema_current": True,
                        "schema_graph_lineage_ready": True,
                        "schema_graph_lineage_errors": [],
                        "schema_head_signature": "abc123",
                    },
                ),
                patch(
                    "app.main.build_empirical_jobs_status", return_value={"ready": True}
                ),
                patch(
                    "app.main._daily_runtime_ledger_portfolio_summary",
                    return_value={
                        "bucket_count": 1,
                        "evidence_grade_bucket_count": 1,
                        "post_cost_net_pnl_per_day": "525",
                        "candidate_ids": "candidate-scalar",
                    },
                ),
            ):
                epoch = _build_current_evidence_epoch(
                    session=session,
                    account_label="paper",
                    stage_scope="paper",
                )

        receipt = next(
            item for item in epoch.receipts if item.receipt_type == "portfolio_proof"
        )
        self.assertEqual(receipt.payload["portfolio_candidate_id"], "")
        self.assertIn("portfolio_proof_missing", receipt.reason_codes)

    def test_compile_epoch_flags_missing_and_reasonless_required_receipts(self) -> None:
        observed_at = datetime(2026, 5, 5, 12, 0)
        reasonless_receipt = EvidenceReceipt(
            receipt_id="ter-reasonless",
            receipt_type="service_health",
            producer="torghut",
            subject_ref="torghut-live",
            state="fail",
            observed_at=observed_at,
            fresh_until=observed_at,
        )

        epoch = compile_evidence_epoch(
            account_label="paper",
            stage_scope="live",
            created_at=observed_at,
            receipts=[reasonless_receipt],
        )

        self.assertEqual(epoch.decision, "quarantined")
        self.assertIn("receipt_missing:portfolio_proof", epoch.reason_codes)
        self.assertIn(
            "service_health:receipt_state_fail",
            epoch.reason_codes,
        )
        self.assertEqual(epoch.created_at.tzinfo, timezone.utc)

    def test_paper_epoch_quarantines_jangar_delay_decision(self) -> None:
        observed_at = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
        base_receipts = [
            build_jangar_authority_receipt(
                quorum_payload={"decision": "delay", "reasons": []},
                observed_at=observed_at,
            ),
            build_service_health_receipt(
                role="torghut-live",
                liveness_ok=True,
                readiness_ok=True,
                db_check_ok=True,
                trading_status_ok=True,
                observed_at=observed_at,
            ),
            build_schema_receipt(
                schema_current=True,
                lineage_ready=True,
                observed_at=observed_at,
            ),
            build_data_freshness_receipt(
                source="clickhouse_guardrails",
                fresh=True,
                as_of=observed_at,
                observed_at=observed_at,
            ),
            build_empirical_jobs_receipt(
                empirical_status={"ready": True},
                observed_at=observed_at,
            ),
            build_artifact_parity_receipt(
                consumer_ref="torghut-sim",
                image_ref="registry.example/torghut@sha256:abc",
                required_platforms=("linux/amd64",),
                observed_platforms=("linux/amd64",),
                observed_at=observed_at,
            ),
            build_portfolio_proof_receipt(
                portfolio_candidate_id="portfolio-1",
                target_net_pnl_per_day=Decimal("500"),
                post_cost_net_pnl_per_day=Decimal("525"),
                holdout_result={"status": "pass"},
                runtime_closure_artifact_refs=("runtime-closure/summary.json",),
                observed_at=observed_at,
            ),
        ]

        epoch = compile_evidence_epoch(
            account_label="paper",
            stage_scope="paper",
            created_at=observed_at,
            receipts=base_receipts,
        )

        self.assertEqual(epoch.decision, "quarantined")
        self.assertIn(
            "jangar_authority:jangar_dependency_quorum_delay",
            epoch.reason_codes,
        )

    def test_persistence_loaders_return_missing_and_fallback_payloads(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)
        observed_at = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)

        with session_local() as session:
            self.assertIsNone(load_evidence_epoch_payload(session, "missing"))
            self.assertIsNone(
                load_latest_evidence_epoch_payload(
                    session,
                    account_label="paper",
                    stage_scope="paper",
                )
            )
            session.add(
                EvidenceEpochRecord(
                    evidence_epoch_id="tee-fallback",
                    account_label="paper",
                    stage_scope="paper",
                    decision="paper_allowed",
                    created_at=observed_at,
                    fresh_until=observed_at + timedelta(minutes=10),
                    reason_codes_json=["fallback_loaded"],
                    receipt_ids_json=["ter-one"],
                    payload_json=None,
                )
            )
            session.commit()

            payload = load_latest_evidence_epoch_payload(
                session,
                account_label="paper",
                stage_scope="paper",
            )
            self.assertIsNotNone(payload)
            assert payload is not None
            self.assertEqual(payload["evidence_epoch_id"], "tee-fallback")
            self.assertEqual(payload["receipt_ids"], ["ter-one"])
            self.assertIsNone(
                load_latest_evidence_epoch_payload(
                    session,
                    account_label="other",
                    stage_scope="paper",
                )
            )

    def test_paper_epoch_rejects_timeout_stale_missing_and_unknown_receipts(
        self,
    ) -> None:
        observed_at = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
        epoch = compile_evidence_epoch(
            account_label="paper",
            stage_scope="paper",
            created_at=observed_at,
            receipts=[
                build_jangar_authority_receipt(
                    quorum_payload={
                        "decision": "unknown",
                        "reasons": ["jangar_status_fetch_failed"],
                    },
                    observed_at=observed_at,
                ),
                build_service_health_receipt(
                    role="torghut-live",
                    liveness_ok=True,
                    readiness_ok=False,
                    timeout_reason_codes=["timeout:trading_status"],
                    observed_at=observed_at,
                ),
                build_schema_receipt(
                    schema_current=True,
                    lineage_ready=True,
                    observed_at=observed_at,
                ),
                build_data_freshness_receipt(
                    source="clickhouse_guardrails",
                    fresh=True,
                    as_of=observed_at - timedelta(hours=2),
                    observed_at=observed_at,
                    max_age_seconds=60,
                ),
                build_empirical_jobs_receipt(
                    empirical_status={
                        "ready": False,
                        "stale_jobs": ["benchmark_parity"],
                        "missing_jobs": [],
                        "ineligible_jobs": [],
                    },
                    observed_at=observed_at,
                ),
                build_artifact_parity_receipt(
                    consumer_ref="torghut-sim",
                    image_ref="registry.example/torghut@sha256:abc",
                    required_platforms=("linux/amd64", "linux/arm64"),
                    observed_platforms=("linux/amd64",),
                    observed_at=observed_at,
                ),
                build_portfolio_proof_receipt(
                    portfolio_candidate_id="portfolio-1",
                    target_net_pnl_per_day=Decimal("500"),
                    post_cost_net_pnl_per_day=Decimal("499"),
                    holdout_result={"status": "pass"},
                    runtime_closure_artifact_refs=("runtime-closure/summary.json",),
                    observed_at=observed_at,
                ),
            ],
        )

        self.assertEqual(epoch.decision, "quarantined")
        self.assertIn(
            "jangar_authority:jangar_dependency_quorum_missing",
            epoch.reason_codes,
        )
        self.assertIn("service_health:timeout:trading_status", epoch.reason_codes)
        self.assertIn("data_freshness:data_freshness_stale", epoch.reason_codes)
        self.assertIn("empirical_jobs:empirical_jobs_stale", epoch.reason_codes)
        self.assertIn(
            "artifact_parity:artifact_required_platform_missing:linux/arm64",
            epoch.reason_codes,
        )
        self.assertIn(
            "portfolio_proof:portfolio_proof_below_target", epoch.reason_codes
        )

    def test_shadow_epoch_remains_available_with_blockers(self) -> None:
        observed_at = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
        epoch = compile_evidence_epoch(
            account_label="paper",
            stage_scope="shadow",
            created_at=observed_at,
            receipts=[
                build_jangar_authority_receipt(
                    quorum_payload={"decision": "unknown", "reasons": []},
                    observed_at=observed_at,
                )
            ],
        )

        self.assertEqual(epoch.decision, "shadow_only")
        self.assertEqual(epoch.reason_codes, ())

    def test_research_and_paper_epoch_pass_with_fresh_base_and_portfolio_receipts(
        self,
    ) -> None:
        observed_at = datetime(2026, 5, 5, 12, 0, tzinfo=timezone.utc)
        base_receipts = [
            build_jangar_authority_receipt(
                quorum_payload={"decision": "allow", "reasons": []},
                observed_at=observed_at,
            ),
            build_service_health_receipt(
                role="torghut-live",
                liveness_ok=True,
                readiness_ok=True,
                db_check_ok=True,
                trading_status_ok=True,
                observed_at=observed_at,
            ),
            build_schema_receipt(
                schema_current=True,
                lineage_ready=True,
                observed_at=observed_at,
            ),
            build_data_freshness_receipt(
                source="clickhouse_guardrails",
                fresh=True,
                as_of=observed_at,
                observed_at=observed_at,
            ),
            build_empirical_jobs_receipt(
                empirical_status={"ready": True},
                observed_at=observed_at,
            ),
            build_artifact_parity_receipt(
                consumer_ref="torghut-sim",
                image_ref="registry.example/torghut@sha256:abc",
                required_platforms=("linux/amd64", "linux/arm64"),
                observed_platforms=("linux/amd64", "linux/arm64"),
                observed_at=observed_at,
            ),
        ]
        research_epoch = compile_evidence_epoch(
            account_label="paper",
            stage_scope="research",
            created_at=observed_at,
            receipts=base_receipts,
        )
        paper_epoch = compile_evidence_epoch(
            account_label="paper",
            stage_scope="paper",
            created_at=observed_at,
            receipts=[
                *base_receipts,
                build_portfolio_proof_receipt(
                    portfolio_candidate_id="portfolio-1",
                    target_net_pnl_per_day=Decimal("500"),
                    post_cost_net_pnl_per_day=Decimal("525"),
                    holdout_result={"status": "pass"},
                    runtime_closure_artifact_refs=("runtime-closure/summary.json",),
                    observed_at=observed_at,
                ),
            ],
        )

        self.assertEqual(research_epoch.decision, "research_allowed")
        self.assertEqual(paper_epoch.decision, "paper_allowed")

    def test_latest_endpoint_persists_and_returns_epoch_detail(self) -> None:
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_local = sessionmaker(bind=engine, expire_on_commit=False, future=True)

        def _override_session() -> Session:
            with session_local() as session:
                yield session

        app.dependency_overrides[get_session] = _override_session
        try:
            client = TestClient(app)
            response = client.get("/trading/evidence-epochs/latest?stage_scope=paper")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["schema_version"], "torghut.evidence-epoch.v1")
            self.assertEqual(payload["stage_scope"], "paper")
            self.assertEqual(payload["decision"], "quarantined")
            self.assertTrue(payload["persisted"])
            self.assertGreaterEqual(len(payload["receipt_ids"]), 6)
            self.assertIn(
                "portfolio_proof",
                {item["receipt_type"] for item in payload["receipts"]},
            )

            detail_response = client.get(
                f"/trading/evidence-epochs/{payload['evidence_epoch_id']}"
            )
            self.assertEqual(detail_response.status_code, 200)
            self.assertEqual(
                detail_response.json()["evidence_epoch_id"],
                payload["evidence_epoch_id"],
            )

            cached_response = client.get(
                "/trading/evidence-epochs/latest?stage_scope=paper&refresh=false"
            )
            self.assertEqual(cached_response.status_code, 200)
            self.assertEqual(
                cached_response.json()["evidence_epoch_id"],
                payload["evidence_epoch_id"],
            )

            no_persist_response = client.get(
                "/trading/evidence-epochs/latest?stage_scope=paper&persist=false"
            )
            self.assertEqual(no_persist_response.status_code, 200)
            self.assertFalse(no_persist_response.json()["persisted"])

            with patch(
                "app.main.persist_evidence_epoch",
                side_effect=SQLAlchemyError("boom"),
            ):
                persist_error_response = client.get(
                    "/trading/evidence-epochs/latest?stage_scope=paper"
                )
            self.assertEqual(persist_error_response.status_code, 200)
            self.assertFalse(persist_error_response.json()["persisted"])
            self.assertEqual(
                persist_error_response.json()["persist_error"],
                "SQLAlchemyError",
            )

            with patch(
                "app.main._evaluate_database_contract",
                side_effect=RuntimeError("database contract unavailable"),
            ):
                degraded_response = client.get(
                    "/trading/evidence-epochs/latest?stage_scope=paper&persist=false"
                )
            self.assertEqual(degraded_response.status_code, 200)
            degraded_schema_receipts = [
                receipt
                for receipt in degraded_response.json()["receipts"]
                if receipt["receipt_type"] == "schema"
            ]
            self.assertEqual(len(degraded_schema_receipts), 1)
            self.assertIn(
                "database_contract_unavailable:RuntimeError",
                degraded_schema_receipts[0]["reason_codes"],
            )

            with patch(
                "app.main.build_empirical_jobs_status",
                side_effect=SQLAlchemyError("empirical query failed"),
            ):
                empirical_error_response = client.get(
                    "/trading/evidence-epochs/latest?stage_scope=paper&persist=false"
                )
            self.assertEqual(empirical_error_response.status_code, 200)
            empirical_receipts = [
                receipt
                for receipt in empirical_error_response.json()["receipts"]
                if receipt["receipt_type"] == "empirical_jobs"
            ]
            self.assertEqual(len(empirical_receipts), 1)
            self.assertEqual(empirical_receipts[0]["state"], "fail")
            self.assertIn(
                "empirical_jobs_status_unavailable:SQLAlchemyError",
                empirical_receipts[0]["reason_codes"],
            )
        finally:
            app.dependency_overrides.pop(get_session, None)
