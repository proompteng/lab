from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from unittest import TestCase

from app.trading.profit_leases import (
    PROFIT_LEASE_PROJECTION_SCHEMA_VERSION,
    build_profit_lease_projection,
)


def _runtime_item(**overrides: object) -> dict[str, object]:
    item: dict[str, object] = {
        "hypothesis_id": "H-CONT-01",
        "lane_id": "continuation",
        "strategy_family": "intraday_continuation",
        "promotion_eligible": True,
        "expected_net_edge_bps": 12.5,
    }
    item.update(overrides)
    return item


def _healthy_quant() -> dict[str, object]:
    return {
        "required": True,
        "ok": True,
        "reason": "ready",
        "blocking_reasons": [],
        "informational_reasons": [],
        "account": "paper",
        "window": "15m",
        "status": "healthy",
        "source_url": "http://torghut.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
        "latest_metrics_count": 6,
        "latest_metrics_updated_at": "2026-05-06T12:00:00+00:00",
    }


def _current_empirical() -> dict[str, object]:
    return {
        "ready": True,
        "status": "healthy",
        "completed_jobs": 4,
        "dataset_snapshot_refs": ["s3://torghut/empirical/current"],
        "last_completed_at": "2026-05-06T12:00:00+00:00",
    }


def _promotion_counts(count: int = 1) -> dict[str, Any]:
    return {
        "research_candidates": count,
        "research_promotions": count,
        "strategy_promotion_decisions": count,
        "vnext_promotion_decisions": count,
    }


class TestProfitLeaseProjection(TestCase):
    def test_stale_empirical_jobs_force_repair_only(self) -> None:
        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status={
                "ready": False,
                "status": "degraded",
                "stale_jobs": ["benchmark_parity"],
                "missing_jobs": [],
                "ineligible_jobs": [],
                "dataset_snapshot_refs": ["s3://torghut/empirical/march"],
                "last_completed_at": "2026-03-21T09:03:22+00:00",
            },
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=_promotion_counts(),
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 6, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        self.assertEqual(
            projection["schema_version"], PROFIT_LEASE_PROJECTION_SCHEMA_VERSION
        )
        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(lease["proof_state"], "stale")
        self.assertEqual(lease["rehydration_lane"], "empirical_replay")
        self.assertFalse(projection["torghut_capital"]["allowed"])
        empirical_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "empirical_job"
        )
        self.assertEqual(empirical_source["freshness_state"], "stale")
        self.assertIn("job_stale:benchmark_parity", lease["blocking_reason_codes"])

    def test_missing_empirical_jobs_route_to_empirical_replay(self) -> None:
        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status={
                "ready": False,
                "status": "degraded",
                "stale_jobs": [],
                "missing_jobs": ["benchmark_parity"],
                "ineligible_jobs": ["fill_quality"],
                "dataset_snapshot_refs": [],
            },
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=_promotion_counts(),
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 6, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(lease["proof_state"], "missing")
        self.assertEqual(lease["rehydration_lane"], "empirical_replay")
        self.assertIn("job_missing:benchmark_parity", lease["blocking_reason_codes"])
        self.assertIn("job_ineligible:fill_quality", lease["blocking_reason_codes"])

    def test_live_candidate_requires_deployer_approval(self) -> None:
        base_payload = {
            "runtime_items": [_runtime_item()],
            "quant_evidence": _healthy_quant(),
            "empirical_jobs_status": _current_empirical(),
            "dependency_quorum": {"decision": "allow", "reasons": []},
            "rejection_summary": {
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            "promotion_table_counts": _promotion_counts(),
            "data_readiness": {"equity_ta_rows": 100, "equity_ta_symbols": 20},
            "now": datetime(2026, 5, 6, 12, 0, tzinfo=timezone.utc),
        }

        pending_approval = build_profit_lease_projection(
            **base_payload,
            live_controls={
                "live_submission_enabled": True,
                "rollback_ready": True,
                "deployer_approved": False,
            },
        )
        approved = build_profit_lease_projection(
            **base_payload,
            live_controls={
                "live_submission_enabled": True,
                "rollback_ready": True,
                "deployer_approved": True,
            },
        )

        self.assertEqual(
            pending_approval["leases"][0]["capital_decision"], "paper_candidate"
        )
        self.assertEqual(approved["leases"][0]["capital_decision"], "live_candidate")

    def test_empty_options_features_block_options_paper_candidate(self) -> None:
        projection = build_profit_lease_projection(
            runtime_items=[
                _runtime_item(
                    hypothesis_id="H-OPT-01",
                    lane_id="options-profit",
                    strategy_family="options_intraday",
                )
            ],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=_promotion_counts(),
            data_readiness={"options_feature_rows": 0, "options_symbols": 0},
            now=datetime(2026, 5, 6, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        options_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "options_features"
        )
        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(options_source["freshness_state"], "missing")
        self.assertIn("options_feature_rows_missing", lease["blocking_reason_codes"])
        self.assertEqual(lease["rehydration_lane"], "options_data_readiness")

    def test_empty_promotion_tables_block_capital_graduation(self) -> None:
        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=_promotion_counts(0),
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 6, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(lease["proof_state"], "missing")
        self.assertIn("research_candidates_empty", lease["blocking_reason_codes"])
        self.assertIn(
            "strategy_promotion_decisions_empty", lease["blocking_reason_codes"]
        )
        self.assertEqual(lease["rehydration_lane"], "promotion_table_repair")

    def test_autoresearch_ledgers_replace_false_empty_legacy_research_blockers(
        self,
    ) -> None:
        counts = _promotion_counts(0)
        counts.update(
            {
                "autoresearch_candidate_specs": 558,
                "autoresearch_proposal_scores": 558,
                "autoresearch_portfolio_candidates": 5,
                "autoresearch_portfolio_ready": 0,
                "autoresearch_portfolio_blocked": 5,
            }
        )

        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=counts,
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 13, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        promotion_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "research_candidate"
        )

        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(lease["proof_state"], "blocked")
        self.assertEqual(lease["rehydration_lane"], "autoresearch_promotion_repair")
        self.assertFalse(projection["torghut_capital"]["allowed"])
        self.assertEqual(
            promotion_source["source_ref"], "postgres:autoresearch_ledgers"
        )
        self.assertEqual(promotion_source["freshness_state"], "blocked")
        self.assertEqual(promotion_source["rows"], 1121)
        self.assertNotIn("research_candidates_empty", lease["blocking_reason_codes"])
        self.assertNotIn("research_promotions_empty", lease["blocking_reason_codes"])
        self.assertNotIn(
            "vnext_promotion_decisions_empty", lease["blocking_reason_codes"]
        )
        self.assertIn(
            "autoresearch_portfolio_ready_empty", lease["blocking_reason_codes"]
        )
        self.assertIn(
            "autoresearch_portfolio_candidates_blocked",
            lease["blocking_reason_codes"],
        )

    def test_autoresearch_ledgers_block_on_missing_candidate_specs(self) -> None:
        counts = _promotion_counts(0)
        counts.update(
            {
                "autoresearch_candidate_specs": 0,
                "autoresearch_proposal_scores": 2,
                "autoresearch_portfolio_candidates": 1,
                "autoresearch_portfolio_ready": 0,
                "autoresearch_portfolio_blocked": 1,
            }
        )

        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=counts,
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 13, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(lease["proof_state"], "blocked")
        self.assertIn(
            "autoresearch_candidate_specs_empty", lease["blocking_reason_codes"]
        )

    def test_promotion_table_read_errors_fail_closed_with_specific_blockers(
        self,
    ) -> None:
        counts = _promotion_counts(0)
        counts.update(
            {
                "autoresearch_candidate_specs": 2,
                "autoresearch_proposal_scores": 2,
                "autoresearch_portfolio_candidates": 1,
                "autoresearch_portfolio_ready": 1,
                "autoresearch_portfolio_ready_refs": [
                    "hypothesis_id:H-CONT-01",
                ],
                "count_errors": ["autoresearch_portfolio_candidates"],
                "truncated_counts": ["autoresearch_epochs"],
            }
        )

        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 0,
                "blocked": 0,
                "filled": 10,
                "total": 10,
            },
            promotion_table_counts=counts,
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 13, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertIn(
            "promotion_table_read_unavailable:autoresearch_portfolio_candidates",
            lease["blocking_reason_codes"],
        )
        self.assertIn(
            "promotion_table_count_truncated:autoresearch_epochs",
            lease["blocking_reason_codes"],
        )

    def test_autoresearch_ledgers_block_on_missing_proposal_scores(self) -> None:
        counts = _promotion_counts(0)
        counts.update(
            {
                "autoresearch_candidate_specs": 2,
                "autoresearch_proposal_scores": 0,
                "autoresearch_portfolio_candidates": 1,
                "autoresearch_portfolio_ready": 0,
                "autoresearch_portfolio_blocked": 1,
            }
        )

        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=counts,
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 13, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(lease["proof_state"], "blocked")
        self.assertIn(
            "autoresearch_proposal_scores_empty", lease["blocking_reason_codes"]
        )

    def test_autoresearch_ledgers_block_on_missing_portfolios(self) -> None:
        counts = _promotion_counts(0)
        counts.update(
            {
                "autoresearch_candidate_specs": 2,
                "autoresearch_proposal_scores": 2,
                "autoresearch_portfolio_candidates": 0,
                "autoresearch_portfolio_ready": 0,
                "autoresearch_portfolio_blocked": 0,
            }
        )

        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=counts,
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 13, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        promotion_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "research_candidate"
        )

        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(lease["proof_state"], "missing")
        self.assertEqual(promotion_source["freshness_state"], "missing")
        self.assertIn(
            "autoresearch_portfolio_candidates_empty",
            lease["blocking_reason_codes"],
        )

    def test_autoresearch_ready_portfolio_allows_paper_candidate(self) -> None:
        counts = _promotion_counts(0)
        counts.update(
            {
                "autoresearch_candidate_specs": 3,
                "autoresearch_proposal_scores": 3,
                "autoresearch_portfolio_candidates": 1,
                "autoresearch_portfolio_ready": 1,
                "autoresearch_portfolio_blocked": 0,
                "autoresearch_portfolio_ready_refs": [
                    "portfolio_candidate_id:portfolio-current-ready",
                    "candidate_spec_id:spec-current-ready",
                    "source_candidate_id:spec-current-ready",
                ],
            }
        )

        projection = build_profit_lease_projection(
            runtime_items=[
                _runtime_item(
                    portfolio_candidate_id="portfolio-current-ready",
                    candidate_spec_id="spec-current-ready",
                )
            ],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=counts,
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 13, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        promotion_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "research_candidate"
        )

        self.assertEqual(lease["capital_decision"], "paper_candidate")
        self.assertEqual(lease["proof_state"], "current")
        self.assertTrue(projection["torghut_capital"]["allowed"])
        self.assertIn(
            "portfolio_candidate_id:portfolio-current-ready",
            promotion_source["source_ref"],
        )
        self.assertEqual(promotion_source["freshness_state"], "current")
        self.assertEqual(promotion_source["rows"], 7)

    def test_autoresearch_ready_portfolio_does_not_unlock_unqualified_runtime_item(
        self,
    ) -> None:
        counts = _promotion_counts(0)
        counts.update(
            {
                "autoresearch_candidate_specs": 3,
                "autoresearch_proposal_scores": 3,
                "autoresearch_portfolio_candidates": 1,
                "autoresearch_portfolio_ready": 1,
                "autoresearch_portfolio_blocked": 0,
                "autoresearch_portfolio_ready_refs": [
                    "portfolio_candidate_id:portfolio-current-ready",
                    "candidate_spec_id:spec-current-ready",
                    "source_candidate_id:spec-current-ready",
                    "hypothesis_id:H-PORT-READY",
                ],
            }
        )

        projection = build_profit_lease_projection(
            runtime_items=[
                _runtime_item(
                    hypothesis_id="H-PORT-READY",
                    lane_id="portfolio-ready",
                    portfolio_candidate_id="portfolio-current-ready",
                    candidate_spec_id="spec-current-ready",
                ),
                _runtime_item(
                    hypothesis_id="H-UNRELATED",
                    lane_id="unrelated",
                    candidate_id="cand-unrelated",
                ),
            ],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=counts,
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 13, 12, 0, tzinfo=timezone.utc),
        )

        leases = {lease["hypothesis_id"]: lease for lease in projection["leases"]}
        self.assertEqual(leases["H-PORT-READY"]["capital_decision"], "paper_candidate")
        self.assertEqual(leases["H-UNRELATED"]["capital_decision"], "repair_only")
        self.assertIn(
            "autoresearch_portfolio_match_unverified",
            leases["H-UNRELATED"]["blocking_reason_codes"],
        )
        promotion_sources = {
            source["hypothesis_id"]: source
            for source in projection["source_provenance"]
            if source["source_class"] == "research_candidate"
        }
        self.assertEqual(
            promotion_sources["H-PORT-READY"]["freshness_state"], "current"
        )
        self.assertEqual(promotion_sources["H-UNRELATED"]["freshness_state"], "blocked")

    def test_optional_quant_evidence_does_not_force_repair_lane(self) -> None:
        quant = _healthy_quant()
        quant.update(
            {
                "required": False,
                "ok": True,
                "status": "degraded",
                "reason": "quant_pipeline_stages_missing",
                "blocking_reasons": [],
                "informational_reasons": ["quant_pipeline_stages_missing"],
            }
        )

        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=quant,
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={"decision": "allow", "reasons": []},
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=_promotion_counts(),
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 6, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        quant_source = next(
            source
            for source in projection["source_provenance"]
            if source["source_class"] == "quant_metrics"
        )

        self.assertEqual(lease["capital_decision"], "paper_candidate")
        self.assertEqual(lease["proof_state"], "current")
        self.assertNotIn(
            "quant_pipeline_stages_missing", lease["blocking_reason_codes"]
        )
        self.assertEqual(quant_source["decision"], "observe_only")
        self.assertEqual(quant_source["freshness_state"], "current")
        self.assertTrue(projection["torghut_capital"]["allowed"])

    def test_torghut_capital_holdback_blocks_consumer_allowed(self) -> None:
        projection = build_profit_lease_projection(
            runtime_items=[_runtime_item()],
            quant_evidence=_healthy_quant(),
            empirical_jobs_status=_current_empirical(),
            dependency_quorum={
                "decision": "block",
                "reasons": ["torghut_capital.source_schema.database_unroutable"],
            },
            rejection_summary={
                "rejected": 1,
                "blocked": 1,
                "filled": 10,
                "total": 12,
            },
            promotion_table_counts=_promotion_counts(),
            data_readiness={"equity_ta_rows": 100, "equity_ta_symbols": 20},
            now=datetime(2026, 5, 6, 12, 0, tzinfo=timezone.utc),
        )

        lease = projection["leases"][0]
        self.assertEqual(lease["capital_decision"], "repair_only")
        self.assertEqual(lease["proof_state"], "blocked")
        self.assertFalse(projection["torghut_capital"]["allowed"])
        self.assertIn(
            "torghut_capital.source_schema.database_unroutable",
            projection["torghut_capital"]["blocking_reason_codes"],
        )
