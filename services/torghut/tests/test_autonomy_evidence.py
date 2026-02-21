from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models import (
    Base,
    ResearchCandidate,
    ResearchFoldMetrics,
    ResearchPromotion,
    ResearchRun,
    ResearchStressMetrics,
)
from app.trading.autonomy.evidence import evaluate_evidence_continuity


class TestEvidenceContinuity(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
        )
        Base.metadata.create_all(self.engine)
        self.session_factory = sessionmaker(
            bind=self.engine, expire_on_commit=False, future=True
        )

    def tearDown(self) -> None:
        self.engine.dispose()

    def test_reports_missing_research_chain_rows(self) -> None:
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-missing", status="passed"))
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 1)
        self.assertEqual(report.failed_runs, 1)
        self.assertEqual(report.missing_runs[0]["run_id"], "run-missing")
        self.assertIn("research_candidates", report.missing_runs[0]["missing_tables"])
        self.assertFalse(report.to_payload()["ok"])

    def test_passes_with_full_research_chain(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-ok", status="passed"))
            session.add(
                ResearchCandidate(
                    run_id="run-ok",
                    candidate_id="cand-ok",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-ok",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-ok",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-ok",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                    decision_action="promote",
                    decision_rationale="promotion_allowed",
                    evidence_bundle={
                        "fold_metrics_count": 1,
                        "stress_metrics_count": 1,
                    },
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 1)
        self.assertEqual(report.failed_runs, 0)
        self.assertEqual(report.missing_runs, [])
        self.assertTrue(report.to_payload()["ok"])

    def test_ignores_skipped_runs(self) -> None:
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-skipped", status="skipped"))
            session.commit()
            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.checked_runs, 0)
        self.assertEqual(report.failed_runs, 0)

    def test_flags_missing_promotion_audit_bundle(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-audit-missing", status="passed"))
            session.add(
                ResearchCandidate(
                    run_id="run-audit-missing",
                    candidate_id="cand-audit-missing",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-audit-missing",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-audit-missing",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-audit-missing",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.failed_runs, 1)
        self.assertIn(
            "promotion_decision_audit", report.missing_runs[0]["missing_tables"]
        )

    def test_accepts_legacy_promotion_audit_reason_fields(self) -> None:
        now = datetime(2026, 2, 19, 0, 0, tzinfo=timezone.utc)
        with self.session_factory() as session:
            session.add(ResearchRun(run_id="run-legacy-audit", status="passed"))
            session.add(
                ResearchCandidate(
                    run_id="run-legacy-audit",
                    candidate_id="cand-legacy-audit",
                    decision_count=1,
                    trade_count=1,
                    promotion_target="paper",
                )
            )
            session.add(
                ResearchFoldMetrics(
                    candidate_id="cand-legacy-audit",
                    fold_name="fold-1",
                    fold_order=1,
                    train_start=now,
                    train_end=now,
                    test_start=now,
                    test_end=now,
                    decision_count=1,
                    trade_count=1,
                    gross_pnl=Decimal("1"),
                    net_pnl=Decimal("1"),
                    max_drawdown=Decimal("0.1"),
                    turnover_ratio=Decimal("0.2"),
                    cost_bps=Decimal("1"),
                    regime_label="neutral",
                )
            )
            session.add(
                ResearchStressMetrics(
                    candidate_id="cand-legacy-audit",
                    stress_case="spread",
                    metric_bundle={"ok": True},
                )
            )
            session.add(
                ResearchPromotion(
                    candidate_id="cand-legacy-audit",
                    requested_mode="paper",
                    approved_mode="paper",
                    approver="scheduler",
                    approver_role="system",
                    approve_reason="legacy_promotion_allowed",
                )
            )
            session.commit()

            report = evaluate_evidence_continuity(session, run_limit=5)

        self.assertEqual(report.failed_runs, 0)
