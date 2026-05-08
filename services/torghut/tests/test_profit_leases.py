from __future__ import annotations

from datetime import datetime, timezone
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
        "source_url": "http://jangar.test/api/torghut/trading/control-plane/quant/health?account=paper&window=15m",
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


def _promotion_counts(count: int = 1) -> dict[str, int]:
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
        self.assertFalse(projection["jangar_consumer"]["allowed"])
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

    def test_jangar_capital_holdback_blocks_consumer_allowed(self) -> None:
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
        self.assertFalse(projection["jangar_consumer"]["allowed"])
        self.assertIn(
            "torghut_capital.source_schema.database_unroutable",
            projection["jangar_consumer"]["blocking_reason_codes"],
        )
