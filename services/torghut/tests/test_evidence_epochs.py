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

from app.db import get_session
from app.main import _env_json_string_list, app
from app.models import Base, EvidenceEpochRecord
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
        self.assertEqual(delay_receipt.state, "warn")
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
        self.assertIn("portfolio_holdout_missing", holdout_missing_receipt.reason_codes)
        self.assertIn(
            "portfolio_runtime_closure_refs_missing",
            refs_missing_receipt.reason_codes,
        )
        self.assertEqual(serializable_receipt.state, "pass")

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
        finally:
            app.dependency_overrides.pop(get_session, None)
