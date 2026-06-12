from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.completion_trace.support import *


class TestCompletionTracePart3(_TestCompletionTraceBase):
    def test_doc29_completion_status_uses_manifest_canary_threshold(self) -> None:
        candidate_id = "chip-paper-microbar-composite@execution-proof"
        dataset_snapshot_ref = "torghut-chip-full-day-20260505-4c330ce9-r1"
        trace = build_completion_trace(
            doc_id="doc29",
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id="sim-2026-05-06-full-day",
            dataset_snapshot_ref=dataset_snapshot_ref,
            candidate_id=candidate_id,
            workflow_name="torghut-historical-simulation",
            analysis_run_names=[],
            artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                    "acceptance_snapshot": {
                        "trade_decisions": 640,
                        "executions": 320,
                        "execution_tca_metrics": 320,
                        "execution_order_events": 320,
                        "coverage_ratio": 0.99,
                        "fill_price_error_budget_status": "within_budget",
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        paper_window_time = datetime.now(timezone.utc) - timedelta(minutes=5)
        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace)
            for job_type in (
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id="empirical-1",
                        candidate_id=candidate_id,
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f"job-{job_type}",
                        status="completed",
                        authority="empirical",
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref=dataset_snapshot_ref,
                        artifact_refs=[f"s3://artifacts/{job_type}.json"],
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f"job-{job_type}",
                            dataset_snapshot_ref=dataset_snapshot_ref,
                        ),
                    )
                )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="paper-h-micro-50",
                    candidate_id=candidate_id,
                    hypothesis_id="H-MICRO-01",
                    observed_stage="paper",
                    window_started_at=paper_window_time,
                    window_ended_at=paper_window_time,
                    market_session_count=50,
                    decision_count=50,
                    trade_count=49,
                    order_count=49,
                    evidence_provenance="paper_runtime_observed",
                    evidence_maturity="empirically_validated",
                    decision_alignment_ratio="0.98",
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="8.0",
                    post_cost_expectancy_bps="10.5",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="shadow",
                    payload_json={},
                )
            )
            session.add(
                _promotion_decision(
                    run_id="paper-h-micro-50",
                    candidate_id=candidate_id,
                    hypothesis_id="H-MICRO-01",
                    promotion_target="paper",
                    state="0.10x canary",
                )
            )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision="abc123",
                current_image_digest="sha256:test",
            )

        paper_gate = next(
            item for item in status["gates"] if item["gate_id"] == DOC29_PAPER_GATE
        )
        canary_gate = next(
            item
            for item in status["gates"]
            if item["gate_id"] == DOC29_LIVE_CANARY_GATE
        )
        self.assertEqual(paper_gate["status"], "satisfied")
        self.assertEqual(canary_gate["status"], "blocked")
        self.assertEqual(
            canary_gate["blocked_reason"], "insufficient_paper_runtime_sessions"
        )

    def test_doc29_completion_status_blocks_stale_live_windows(self) -> None:
        trace = build_completion_trace(
            doc_id="doc29",
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id="sim-2026-03-06-full-day",
            dataset_snapshot_ref="snapshot-1",
            candidate_id="cand-1",
            workflow_name="torghut-historical-simulation",
            analysis_run_names=[],
            artifact_refs=["s3://artifacts/run-full-lifecycle-manifest.json"],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/run-full-lifecycle-manifest.json",
                    "acceptance_snapshot": {
                        "trade_decisions": 640,
                        "executions": 320,
                        "execution_tca_metrics": 320,
                        "execution_order_events": 320,
                        "coverage_ratio": 0.99,
                        "fill_price_error_budget_status": "within_budget",
                        "fill_price_error_budget_artifact_ref": (
                            "s3://artifacts/gates/fill-price-error-budget-report-v1.json"
                        ),
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        stale_time = datetime(2026, 2, 20, tzinfo=timezone.utc)
        with self.session_local() as session:
            persist_completion_trace(
                session=session,
                trace_payload=trace,
                default_artifact_ref="s3://artifacts/completion-trace.json",
            )
            for job_type in (
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id="run-1",
                        candidate_id="cand-1",
                        job_name=job_type,
                        job_type=job_type,
                        job_run_id=f"job-{job_type}",
                        status="completed",
                        authority="empirical",
                        promotion_authority_eligible=True,
                        dataset_snapshot_ref="snapshot-1",
                        artifact_refs=[f"s3://artifacts/{job_type}.json"],
                        payload_json=_truthful_empirical_payload(
                            job_run_id=f"job-{job_type}",
                        ),
                    )
                )
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="paper-old",
                    candidate_id="cand-1",
                    hypothesis_id="legacy_macd_rsi",
                    observed_stage="paper",
                    window_started_at=stale_time,
                    window_ended_at=stale_time,
                    market_session_count=50,
                    decision_count=200,
                    trade_count=194,
                    order_count=194,
                    evidence_provenance="paper_runtime_observed",
                    evidence_maturity="empirically_validated",
                    decision_alignment_ratio="0.97",
                    avg_abs_slippage_bps="4.2",
                    slippage_budget_bps="8.0",
                    post_cost_expectancy_bps="1.1",
                    continuity_ok=True,
                    drift_ok=True,
                    dependency_quorum_decision="allow",
                    capital_stage="shadow",
                    payload_json={},
                    created_at=stale_time,
                    updated_at=stale_time,
                )
            )
            session.commit()

            status = build_doc29_completion_status(
                session=session,
                stale_after_seconds=86400,
                current_git_revision="abc123",
                current_image_digest="sha256:test",
            )

        canary_gate = next(
            item
            for item in status["gates"]
            if item["gate_id"] == DOC29_LIVE_CANARY_GATE
        )
        self.assertEqual(canary_gate["status"], "blocked")
        self.assertEqual(
            canary_gate["blocked_reason"], "insufficient_paper_runtime_sessions"
        )
