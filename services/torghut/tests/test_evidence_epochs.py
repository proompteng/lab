from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest import TestCase

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.db import get_session
from app.main import app
from app.models import Base
from app.trading.evidence_epochs import compile_evidence_epoch
from app.trading.evidence_receipts import (
    build_artifact_parity_receipt,
    build_data_freshness_receipt,
    build_empirical_jobs_receipt,
    build_jangar_authority_receipt,
    build_portfolio_proof_receipt,
    build_schema_receipt,
    build_service_health_receipt,
)


class TestEvidenceEpochs(TestCase):
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
        finally:
            app.dependency_overrides.pop(get_session, None)
