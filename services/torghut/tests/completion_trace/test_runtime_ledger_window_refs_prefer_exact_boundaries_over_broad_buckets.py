from __future__ import annotations

from tests.completion_trace.support import (
    DOC29_LIVE_CANARY_GATE,
    DOC29_LIVE_SCALE_GATE,
    DOC29_PAPER_GATE,
    DOC29_SIMULATION_FULL_DAY_GATE,
    StrategyHypothesisMetricWindow,
    TRACE_STATUS_SATISFIED,
    VNextEmpiricalJobRun,
    _TestCompletionTraceBase,
    _add_truthful_empirical_jobs,
    _promotion_decision,
    _runtime_ledger_bucket,
    _runtime_ledger_bucket_refs_for_windows,
    _runtime_ledger_source_authority_payload,
    _truthful_empirical_payload,
    build_completion_trace,
    build_doc29_completion_status,
    datetime,
    persist_completion_trace,
    timedelta,
    timezone,
)


class TestRuntimeLedgerWindowRefsPreferExactBoundariesOverBroadBuckets(
    _TestCompletionTraceBase
):
    def test_runtime_ledger_window_refs_prefer_exact_boundaries_over_broad_buckets(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        with self.session_local() as session:
            window = StrategyHypothesisMetricWindow(
                run_id="exact-boundary-run",
                candidate_id="cand-1",
                hypothesis_id="legacy_macd_rsi",
                observed_stage="live",
                window_started_at=window_start,
                window_ended_at=window_end,
                market_session_count=1,
                decision_count=20,
                trade_count=12,
                order_count=12,
                evidence_provenance="live_runtime_observed",
                evidence_maturity="empirically_validated",
                decision_alignment_ratio="0.98",
                avg_abs_slippage_bps="4.5",
                slippage_budget_bps="8.0",
                post_cost_expectancy_bps="1.4",
                continuity_ok=True,
                drift_ok=True,
                dependency_quorum_decision="allow",
                capital_stage="0.50x live",
                payload_json={},
            )
            broad = _runtime_ledger_bucket(
                run_id="exact-boundary-run",
                bucket_started_at=window_start - timedelta(minutes=30),
                bucket_ended_at=window_end + timedelta(minutes=30),
            )
            exact = _runtime_ledger_bucket(
                run_id="exact-boundary-run",
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
            )
            partial = _runtime_ledger_bucket(
                run_id="exact-boundary-run",
                bucket_started_at=window_start + timedelta(minutes=1),
                bucket_ended_at=window_end + timedelta(minutes=1),
            )
            session.add_all([window, broad, exact, partial])
            session.commit()

            backed_windows, matched_buckets, unbacked_window_refs = (
                _runtime_ledger_bucket_refs_for_windows(
                    session,
                    [window],
                )
            )

        self.assertEqual(backed_windows, [window])
        self.assertEqual(matched_buckets, [exact])
        self.assertEqual(unbacked_window_refs, [])

    def test_runtime_ledger_window_refs_reject_legacy_aggregate_only_bucket(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        with self.session_local() as session:
            window = StrategyHypothesisMetricWindow(
                run_id="legacy-aggregate-run",
                candidate_id="cand-1",
                hypothesis_id="legacy_macd_rsi",
                observed_stage="live",
                window_started_at=window_start,
                window_ended_at=window_end,
            )
            source_less = _runtime_ledger_bucket(
                run_id="legacy-aggregate-run",
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
                payload_json={"source": "legacy-aggregate-runtime-ledger"},
            )
            session.add_all([window, source_less])
            session.commit()

            backed_windows, matched_buckets, unbacked_window_refs = (
                _runtime_ledger_bucket_refs_for_windows(
                    session,
                    [window],
                )
            )

        self.assertEqual(backed_windows, [])
        self.assertEqual(matched_buckets, [])
        self.assertEqual(unbacked_window_refs, [str(window.id)])

    def test_runtime_ledger_window_refs_reject_non_promotion_cost_basis(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        with self.session_local() as session:
            window = StrategyHypothesisMetricWindow(
                run_id="modeled-cost-run",
                candidate_id="cand-1",
                hypothesis_id="legacy_macd_rsi",
                observed_stage="live",
                window_started_at=window_start,
                window_ended_at=window_end,
            )
            modeled_cost = _runtime_ledger_bucket(
                run_id="modeled-cost-run",
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
                payload_json=_runtime_ledger_source_authority_payload(
                    cost_basis="modeled_paper_cost_budget",
                    cost_basis_counts={"modeled_paper_cost_budget": 12},
                ),
            )
            session.add_all([window, modeled_cost])
            session.commit()

            backed_windows, matched_buckets, unbacked_window_refs = (
                _runtime_ledger_bucket_refs_for_windows(
                    session,
                    [window],
                )
            )

        self.assertEqual(backed_windows, [])
        self.assertEqual(matched_buckets, [])
        self.assertEqual(unbacked_window_refs, [str(window.id)])

    def test_runtime_ledger_window_refs_reject_exact_replay_aggregate_ledgers(
        self,
    ) -> None:
        window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
        window_end = datetime(2026, 3, 6, 15, 0, tzinfo=timezone.utc)
        with self.session_local() as session:
            window = StrategyHypothesisMetricWindow(
                run_id="exact-replay-run",
                candidate_id="cand-1",
                hypothesis_id="legacy_macd_rsi",
                observed_stage="live",
                window_started_at=window_start,
                window_ended_at=window_end,
            )
            exact_replay = _runtime_ledger_bucket(
                run_id="exact-replay-run",
                bucket_started_at=window_start,
                bucket_ended_at=window_end,
                ledger_schema_version="torghut.exact_replay_ledger.v1",
            )
            session.add_all([window, exact_replay])
            session.commit()

            backed_windows, matched_buckets, unbacked_window_refs = (
                _runtime_ledger_bucket_refs_for_windows(
                    session,
                    [window],
                )
            )

        self.assertEqual(backed_windows, [])
        self.assertEqual(matched_buckets, [])
        self.assertEqual(unbacked_window_refs, [str(window.id)])

    def test_doc29_live_scale_blocks_non_runtime_ledger_window_pnl(self) -> None:
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
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace)
            _add_truthful_empirical_jobs(session)

            now = datetime.now(timezone.utc)
            paper_window_start = now - timedelta(days=2)
            for index in range(4):
                run_id = f"paper-ledger-missing-{index}"
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        observed_stage="paper",
                        window_started_at=paper_window_start,
                        window_ended_at=paper_window_start,
                        market_session_count=10,
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
                    )
                )
                session.add(
                    _promotion_decision(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        promotion_target="paper",
                        state="0.10x canary",
                    )
                )

            live_window_start = now - timedelta(days=1)
            for index in range(10):
                run_id = f"live-ledger-missing-{index}"
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        observed_stage="live",
                        window_started_at=live_window_start,
                        window_ended_at=live_window_start
                        + timedelta(minutes=index + 1),
                        market_session_count=12,
                        decision_count=220,
                        trade_count=215,
                        order_count=215,
                        evidence_provenance="live_runtime_observed",
                        evidence_maturity="empirically_validated",
                        decision_alignment_ratio="0.98",
                        avg_abs_slippage_bps="4.5",
                        slippage_budget_bps="8.0",
                        post_cost_expectancy_bps="1.4",
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        capital_stage="0.50x live",
                        payload_json={},
                    )
                )
                session.add(
                    _promotion_decision(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        promotion_target="live",
                        state="0.50x live",
                    )
                )
                if index == 0:
                    session.add(
                        _runtime_ledger_bucket(
                            run_id=run_id,
                            candidate_id="other-candidate",
                            bucket_started_at=live_window_start,
                            bucket_ended_at=live_window_start
                            + timedelta(minutes=index + 1),
                        )
                    )
                if index == 1:
                    session.add(
                        _runtime_ledger_bucket(
                            run_id=run_id,
                            bucket_started_at=live_window_start,
                            bucket_ended_at=live_window_start
                            + timedelta(minutes=index + 1),
                            ledger_schema_version="torghut.loose_runtime_ledger.v0",
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
        scale_gate = next(
            item for item in status["gates"] if item["gate_id"] == DOC29_LIVE_SCALE_GATE
        )
        self.assertEqual(canary_gate["status"], "satisfied")
        self.assertEqual(scale_gate["status"], "blocked")
        self.assertEqual(
            scale_gate["blocked_reason"], "runtime_ledger_profit_proof_missing"
        )
        self.assertTrue(status["promotion_authority"]["evidence_collection_ok"])
        self.assertTrue(status["promotion_authority"]["canary_collection_authorized"])
        self.assertFalse(status["promotion_authority"]["capital_promotion_allowed"])
        self.assertFalse(status["promotion_authority"]["promotion_allowed"])
        self.assertFalse(status["promotion_authority"]["final_authority_ok"])
        self.assertFalse(status["promotion_authority"]["final_promotion_allowed"])
        self.assertIn(
            DOC29_LIVE_SCALE_GATE,
            status["promotion_authority"]["final_promotion_blockers"],
        )
        self.assertEqual(
            scale_gate["db_row_refs"]["strategy_runtime_ledger_buckets"], []
        )
        self.assertEqual(
            len(
                scale_gate["db_row_refs"][
                    "runtime_ledger_unbacked_hypothesis_metric_windows"
                ]
            ),
            10,
        )

    def test_doc29_live_canary_requires_allowed_promotion_decision(self) -> None:
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
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        window_time = datetime.now(timezone.utc) - timedelta(minutes=5)
        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace)
            _add_truthful_empirical_jobs(session)
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="paper-denied",
                    candidate_id="cand-1",
                    hypothesis_id="legacy_macd_rsi",
                    observed_stage="paper",
                    window_started_at=window_time,
                    window_ended_at=window_time,
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
                )
            )
            session.add(
                _promotion_decision(
                    run_id="paper-denied",
                    candidate_id="cand-1",
                    hypothesis_id="legacy_macd_rsi",
                    promotion_target="paper",
                    state="0.10x canary",
                    allowed=False,
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
            canary_gate["blocked_reason"], "promotion_decision_not_allowed"
        )

    def test_doc29_live_scale_requires_allowed_promotion_decision(self) -> None:
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
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        window_time = datetime.now(timezone.utc) - timedelta(minutes=5)
        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace)
            _add_truthful_empirical_jobs(session)
            session.add(
                StrategyHypothesisMetricWindow(
                    run_id="paper-allowed",
                    candidate_id="cand-1",
                    hypothesis_id="legacy_macd_rsi",
                    observed_stage="paper",
                    window_started_at=window_time,
                    window_ended_at=window_time,
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
                )
            )
            session.add(
                _promotion_decision(
                    run_id="paper-allowed",
                    candidate_id="cand-1",
                    hypothesis_id="legacy_macd_rsi",
                    promotion_target="paper",
                    state="0.10x canary",
                )
            )
            for index in range(10):
                run_id = f"live-missing-decision-{index}"
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=run_id,
                        candidate_id="cand-1",
                        hypothesis_id="legacy_macd_rsi",
                        observed_stage="live",
                        window_started_at=window_time,
                        window_ended_at=window_time,
                        market_session_count=12,
                        decision_count=220,
                        trade_count=215,
                        order_count=215,
                        evidence_provenance="live_runtime_observed",
                        evidence_maturity="empirically_validated",
                        decision_alignment_ratio="0.98",
                        avg_abs_slippage_bps="4.5",
                        slippage_budget_bps="8.0",
                        post_cost_expectancy_bps="1.4",
                        continuity_ok=True,
                        drift_ok=True,
                        dependency_quorum_decision="allow",
                        capital_stage="0.50x live",
                        payload_json={},
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
        scale_gate = next(
            item for item in status["gates"] if item["gate_id"] == DOC29_LIVE_SCALE_GATE
        )
        self.assertEqual(canary_gate["status"], "satisfied")
        self.assertEqual(scale_gate["status"], "blocked")
        self.assertEqual(
            scale_gate["blocked_reason"], "promotion_decision_evidence_missing"
        )

    def test_doc29_completion_status_scopes_paper_gate_to_empirical_lineage(
        self,
    ) -> None:
        trace_matching = build_completion_trace(
            doc_id="doc29",
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id="sim-match",
            dataset_snapshot_ref="snapshot-1",
            candidate_id="cand-1",
            workflow_name="torghut-historical-simulation",
            analysis_run_names=[],
            artifact_refs=["s3://artifacts/match.json"],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/match.json",
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
        trace_matching["measured_at"] = "2026-03-07T00:00:00+00:00"
        trace_newer_wrong = build_completion_trace(
            doc_id="doc29",
            gate_ids_attempted=[DOC29_SIMULATION_FULL_DAY_GATE],
            run_id="sim-wrong",
            dataset_snapshot_ref="snapshot-2",
            candidate_id="cand-2",
            workflow_name="torghut-historical-simulation",
            analysis_run_names=[],
            artifact_refs=["s3://artifacts/wrong.json"],
            db_row_refs={},
            status_snapshot={},
            result_by_gate={
                DOC29_SIMULATION_FULL_DAY_GATE: {
                    "status": TRACE_STATUS_SATISFIED,
                    "artifact_ref": "s3://artifacts/wrong.json",
                    "acceptance_snapshot": {
                        "trade_decisions": 900,
                        "executions": 450,
                        "execution_tca_metrics": 450,
                        "execution_order_events": 450,
                        "coverage_ratio": 0.99,
                        "fill_price_error_budget_status": "within_budget",
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
        trace_newer_wrong["measured_at"] = "2026-03-08T00:00:00+00:00"

        with self.session_local() as session:
            persist_completion_trace(session=session, trace_payload=trace_matching)
            persist_completion_trace(session=session, trace_payload=trace_newer_wrong)
            for job_type in (
                "benchmark_parity",
                "foundation_router_parity",
                "janus_event_car",
                "janus_hgrm_reward",
            ):
                session.add(
                    VNextEmpiricalJobRun(
                        run_id="empirical-1",
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
        self.assertEqual(paper_gate["status"], "satisfied")
        self.assertEqual(paper_gate["latest_run"], "sim-match")

    def test_doc29_completion_status_scopes_live_canary_windows_to_paper_candidate(
        self,
    ) -> None:
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
                    },
                }
            },
            blocked_reasons={},
            git_revision="abc123",
            image_digest="sha256:test",
        )
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

            paper_window_start = datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc)
            for index in range(4):
                session.add(
                    StrategyHypothesisMetricWindow(
                        run_id=f"paper-run-{index}",
                        candidate_id="cand-2",
                        hypothesis_id="legacy_macd_rsi",
                        observed_stage="paper",
                        window_started_at=paper_window_start,
                        window_ended_at=paper_window_start,
                        market_session_count=10,
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
