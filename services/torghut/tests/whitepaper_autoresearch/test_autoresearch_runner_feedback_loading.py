from __future__ import annotations

import app.trading.discovery.evidence_bundles as evidence_bundles
import scripts.whitepaper_autoresearch_runner.candidate_identity as candidate_identity
import scripts.whitepaper_autoresearch_runner.feedback_loading as feedback_loading
import scripts.whitepaper_autoresearch_runner.persisted_feedback_sources as persisted_feedback_sources
import scripts.whitepaper_autoresearch_runner.proposal_building as proposal_building
import scripts.whitepaper_autoresearch_runner.rejected_signal_feedback as rejected_signal_feedback

from tests.whitepaper_autoresearch.autoresearch_runner_base import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    Decimal,
    Path,
    RejectedSignalOutcomeEvent,
    Session,
    TemporaryDirectory,
    WhitepaperAutoresearchRunnerTestCaseBase,
    datetime,
    json,
    patch,
    replace,
)


class TestAutoresearchRunnerFeedbackLoading(WhitepaperAutoresearchRunnerTestCaseBase):
    def test_workflow_template_surfaces_feedback_and_fails_closed_on_stale_tape(
        self,
    ) -> None:
        template_path = (
            Path(__file__).parents[4]
            / "argocd"
            / "applications"
            / "torghut"
            / "whitepaper-autoresearch-workflowtemplate.yaml"
        )
        template = template_path.read_text()

        self.assertIn("name: feedbackEvidenceJsonlB64", template)
        self.assertIn("name: candidateSpecsJsonlB64", template)
        self.assertIn("name: candidateSpecsConfigMapName", template)
        self.assertIn("name: candidateSpecsConfigMapKey", template)
        self.assertIn("--candidate-specs", template)
        self.assertIn("TORGHUT_WHITEPAPER_CANDIDATE_SPECS_JSONL_B64", template)
        self.assertIn("TORGHUT_WHITEPAPER_CANDIDATE_SPECS_CONFIGMAP_PATH", template)
        self.assertIn("name: feedbackEvidenceConfigMapName", template)
        self.assertIn("name: feedbackEvidenceConfigMapKey", template)
        self.assertIn("--feedback-evidence-jsonl", template)
        self.assertIn("TORGHUT_WHITEPAPER_FEEDBACK_EVIDENCE_JSONL_B64", template)
        self.assertIn("TORGHUT_WHITEPAPER_FEEDBACK_EVIDENCE_CONFIGMAP_PATH", template)
        self.assertIn("TORGHUT_WHITEPAPER_SOURCE_JSONL_B64", template)
        self.assertIn('--epoch-id "${RUN_ID}"', template)
        self.assertIn("name: feedback-evidence", template)
        self.assertIn("name: candidate-specs", template)
        self.assertNotIn(
            "printf '%s' \"{{inputs.parameters.feedbackEvidenceJsonlB64}}\"",
            template,
        )
        self.assertNotIn(
            "printf '%s' \"{{inputs.parameters.candidateSpecsJsonlB64}}\"",
            template,
        )
        self.assertNotIn(
            "printf '%s' \"{{inputs.parameters.sourceJsonlB64}}\"",
            template,
        )
        self.assertIn(
            'if [ -n "{{inputs.parameters.fullWindowStartDate}}" ]; then',
            template,
        )
        self.assertIn(
            'if [ -n "{{inputs.parameters.expectedLastTradingDay}}" ]; then',
            template,
        )
        self.assertIn("parallelism: 1", template)
        self.assertIn("name: torghut-whitepaper-autoresearch-profit-target", template)
        self.assertIn("podGC:\n    strategy: OnPodCompletion", template)
        self.assertIn("secondsAfterCompletion: 172800", template)
        self.assertIn("name: maxCandidates\n        value: '128'", template)
        self.assertIn("name: topK\n        value: '64'", template)
        self.assertIn("name: explorationSlots\n        value: '48'", template)
        self.assertIn("name: feedbackBlockReauditSlots\n        value: '32'", template)
        self.assertIn(
            "name: maxFrontierCandidatesPerSpec\n        value: '2'", template
        )
        self.assertIn(
            "name: maxTotalFrontierCandidates\n        value: '128'", template
        )
        self.assertIn("name: realReplayTimeoutSeconds\n        value: '7200'", template)
        self.assertIn(
            "name: realReplayShardTimeoutSeconds\n        value: '900'", template
        )
        self.assertIn("name: realReplayShardWorkers\n        value: '4'", template)
        self.assertIn("name: trainDays\n        value: '12'", template)
        self.assertIn("name: holdoutDays\n        value: '8'", template)
        self.assertIn("name: secondOosDays\n        value: '5'", template)
        self.assertIn('--train-days "{{inputs.parameters.trainDays}}"', template)
        self.assertIn('--holdout-days "{{inputs.parameters.holdoutDays}}"', template)
        self.assertIn(
            '--second-oos-days "{{inputs.parameters.secondOosDays}}"', template
        )
        self.assertIn(
            '--latest-complete-window-min-days "{{inputs.parameters.latestCompleteWindowMinDays}}"',
            template,
        )
        self.assertIn(
            '--min-executable-rows-per-symbol-day "{{inputs.parameters.minExecutableRowsPerSymbolDay}}"',
            template,
        )
        self.assertIn("replay-source-coverage-diagnostics.json", template)
        self.assertIn("cpu: 4", template)
        self.assertIn("memory: 12Gi", template)
        self.assertIn("cpu: 8", template)
        self.assertIn("memory: 32Gi", template)
        self.assertIn("--feedback-block-reaudit-slots", template)
        self.assertIn(
            "--program config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml",
            template,
        )
        self.assertNotIn("--require-no-flat-days", template)
        self.assertNotIn(
            '--min-daily-net-pnl "{{inputs.parameters.targetNetPnlPerDay}}"', template
        )
        self.assertIn("activeDeadlineSeconds: 9000", template)
        self.assertIn("name: allowStaleTape\n        value: 'false'", template)
        self.assertIn("name: selectionOnly\n        value: 'false'", template)
        self.assertIn("name: selectionOnly", template)
        self.assertIn(
            'if [ "{{inputs.parameters.selectionOnly}}" = "true" ]; then',
            template,
        )
        self.assertIn("SCRIPT_ARGS+=(--selection-only)", template)
        self.assertNotIn("value: '2026-04-24'", template)
        self.assertNotIn("value: '2026-05-01'", template)

    def test_pre_replay_ranker_ingests_feedback_evidence_bundles(self) -> None:
        losing_spec = self._candidate_spec(
            "spec-losing",
            entry_minute_after_open="45",
            selection_mode="reversal",
        )
        unexplored_spec = self._candidate_spec(
            "spec-unexplored",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="90",
            selection_mode="continuation",
        )
        capital_unsafe_spec = self._candidate_spec(
            "spec-capital-unsafe",
            family_template_id="momentum_pullback_v1",
            entry_minute_after_open="75",
            selection_mode="continuation",
        )
        losing_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=losing_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-losing",
                "family_template_id": losing_spec.family_template_id,
                "runtime_family": losing_spec.runtime_family,
                "runtime_strategy_name": losing_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-120",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 6,
                    "best_day_share": "1",
                    "worst_day_loss": "430",
                    "max_drawdown": "997",
                    "avg_filled_notional_per_day": "50000",
                    "hard_vetoes": ["positive_day_ratio_below_oracle"],
                    "daily_net": {
                        "2026-05-01": "-100",
                        "2026-05-04": "-140",
                    },
                },
            },
            dataset_snapshot_id="snap-feedback",
            result_path="feedback://losing",
        )
        capital_unsafe_bundle = (
            evidence_bundles.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=capital_unsafe_spec.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-capital-unsafe",
                    "family_template_id": capital_unsafe_spec.family_template_id,
                    "runtime_family": capital_unsafe_spec.runtime_family,
                    "runtime_strategy_name": capital_unsafe_spec.runtime_strategy_name,
                    "objective_scorecard": {
                        "net_pnl_per_day": "750",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "best_day_share": "0.25",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "max_gross_exposure_pct_equity": "2.5",
                        "min_cash": "-500",
                        "negative_cash_observation_count": 8,
                        "avg_filled_notional_per_day": "500000",
                    },
                },
                dataset_snapshot_id="snap-feedback",
                result_path="feedback://capital-unsafe",
            )
        )

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(losing_spec, unexplored_spec, capital_unsafe_spec),
            feedback_evidence_bundles=(losing_bundle, capital_unsafe_bundle),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_evidence_bundle_count"], 2)
        self.assertEqual(model["feedback_matched_spec_count"], 2)
        self.assertEqual(
            model["training_source_counts"],
            {"feedback_real_replay": 2, "synthetic_prior": 1},
        )
        self.assertEqual(
            row_by_spec[losing_spec.candidate_spec_id]["training_source"],
            "feedback_real_replay",
        )
        self.assertEqual(
            row_by_spec[losing_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_blocked",
        )
        self.assertEqual(
            row_by_spec[capital_unsafe_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_penalized",
        )
        self.assertGreater(
            row_by_spec[losing_spec.candidate_spec_id]["rank"],
            row_by_spec[unexplored_spec.candidate_spec_id]["rank"],
        )
        self.assertGreater(
            row_by_spec[capital_unsafe_spec.candidate_spec_id]["proposal_score"],
            -999999,
        )
        self.assertEqual(
            row_by_spec[unexplored_spec.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )
        self.assertIn(
            "history_daily_target_shortfall",
            row_by_spec[losing_spec.candidate_spec_id]["features"],
        )
        self.assertIn(
            "history_market_impact_stress_passed",
            row_by_spec[losing_spec.candidate_spec_id]["features"],
        )
        self.assertIn(
            "history_delay_adjusted_depth_stress_passed",
            row_by_spec[losing_spec.candidate_spec_id]["features"],
        )
        self.assertIn(
            "history_double_oos_cost_shock_net_pnl_per_day",
            row_by_spec[losing_spec.candidate_spec_id]["features"],
        )

    def test_feedback_evidence_jsonl_round_trips(self) -> None:
        spec = self._candidate_spec("spec-feedback-jsonl")
        bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-jsonl",
                "objective_scorecard": {
                    "net_pnl_per_day": "42",
                    "active_day_ratio": "1",
                },
            },
            dataset_snapshot_id="snap-feedback",
            result_path="feedback://jsonl",
        )

        with TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "feedback.jsonl"
            path.write_text(
                json.dumps(bundle.to_payload(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            loaded = feedback_loading._load_feedback_evidence_bundles((path,))

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)

    def test_feedback_evidence_loads_recent_persisted_epoch_bundles(self) -> None:
        spec = self._candidate_spec("spec-feedback-persisted")
        bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-persisted",
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-210",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 5,
                    "daily_net": {
                        "2026-05-01": "-120",
                        "2026-05-04": "-300",
                    },
                },
            },
            dataset_snapshot_id="snap-feedback-persisted",
            result_path="db://autoresearch/prior-epoch/candidate-evidence-bundles.jsonl",
        )
        with (
            Session(self.engine) as session,
            patch(
                "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchEpoch(
                    epoch_id="prior-feedback-epoch",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={
                        "candidate_evidence_bundle_payloads": [bundle.to_payload()]
                    },
                    started_at=datetime(2026, 5, 12, 14, 0, 0),
                    completed_at=datetime(2026, 5, 12, 14, 5, 0),
                    failure_reason=None,
                )
            )
            session.commit()

            loaded, manifest = (
                persisted_feedback_sources._load_autoresearch_feedback_evidence_bundles(
                    (), include_persisted=True
                )
            )

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(manifest["combined_bundle_count"], 1)
        self.assertEqual(manifest["persisted"]["status"], "loaded")
        self.assertEqual(
            manifest["persisted"]["source_epoch_ids"], ["prior-feedback-epoch"]
        )
        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(rows[0]["feedback_match_scope"], "candidate_spec_id")

    def test_feedback_evidence_loads_labeled_rejected_signal_outcomes(self) -> None:
        spec = self._candidate_spec("spec-rejected-outcome-feedback")
        required_fields = [
            "counterfactual_return",
            "route_tca",
            "post_cost_net_pnl",
            "executable_quote",
        ]
        with (
            Session(self.engine) as session,
            patch(
                "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add_all(
                [
                    RejectedSignalOutcomeEvent(
                        event_id="reject-outcome-labeled",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="paper",
                        symbol="AAPL",
                        event_ts=datetime(2026, 5, 18, 14, 30, 0),
                        timeframe="1Min",
                        seq="1",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="labeled",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={
                            "candidate_spec_id": spec.candidate_spec_id
                        },
                        outcome_payload_json={
                            "candidate_id": "cand-rejected-outcome",
                            "candidate_spec_id": spec.candidate_spec_id,
                            "family_template_id": spec.family_template_id,
                            "runtime_family": spec.runtime_family,
                            "runtime_strategy_name": spec.runtime_strategy_name,
                            "counterfactual_return": "-0.0042",
                            "route_tca": {"post_cost_expectancy_bps_proxy": "-11.5"},
                            "post_cost_net_pnl": "-84.25",
                            "executable_quote": {"bid": "100.00", "ask": "100.02"},
                            "objective_scorecard": {
                                "net_pnl_per_day": "-84.25",
                                "active_day_ratio": "1",
                                "positive_day_ratio": "0",
                                "negative_day_count": 1,
                            },
                        },
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-outcome-pending",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="paper",
                        symbol="MSFT",
                        event_ts=datetime(2026, 5, 18, 14, 31, 0),
                        timeframe="1Min",
                        seq="2",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={
                            "candidate_spec_id": spec.candidate_spec_id
                        },
                        outcome_payload_json=None,
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-outcome-incomplete",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="paper",
                        symbol="NVDA",
                        event_ts=datetime(2026, 5, 18, 14, 32, 0),
                        timeframe="1Min",
                        seq="3",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="labeled",
                        counterfactual_required=True,
                        required_outcome_fields_json=required_fields,
                        event_payload_json={
                            "candidate_spec_id": spec.candidate_spec_id
                        },
                        outcome_payload_json={
                            "candidate_spec_id": spec.candidate_spec_id,
                            "counterfactual_return": "-0.001",
                        },
                    ),
                ]
            )
            session.commit()

            loaded, manifest = (
                persisted_feedback_sources._load_autoresearch_feedback_evidence_bundles(
                    (), include_persisted=True
                )
            )

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(manifest["combined_bundle_count"], 1)
        self.assertEqual(
            manifest["persisted"]["rejected_signal_outcome_scanned_count"], 2
        )
        self.assertEqual(
            manifest["persisted"]["rejected_signal_outcome_bundle_count"], 1
        )
        self.assertEqual(
            manifest["persisted"]["rejected_signal_outcome_invalid_count"], 1
        )
        self.assertEqual(
            manifest["persisted"]["rejected_signal_outcome_event_ids"],
            ["reject-outcome-labeled"],
        )
        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(rows[0]["feedback_match_scope"], "candidate_spec_id")
        self.assertEqual(
            loaded[0].dataset_snapshot_id,
            "rejected-signal-outcome:reject-outcome-labeled",
        )

    def test_feedback_evidence_dedupe_handles_missing_bundle_ids(self) -> None:
        spec = self._candidate_spec("spec-feedback-dedupe")
        bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-dedupe",
                "objective_scorecard": {"net_pnl_per_day": "10"},
            },
            dataset_snapshot_id="snap-feedback-dedupe",
            result_path="feedback://dedupe",
        )
        no_id_bundle = replace(bundle, evidence_bundle_id="")

        deduped = feedback_loading._dedupe_feedback_evidence_bundles(
            (no_id_bundle, no_id_bundle)
        )

        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0].candidate_spec_id, spec.candidate_spec_id)

    def test_feedback_evidence_persisted_loader_reports_unavailable_store(self) -> None:
        with patch(
            "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
            side_effect=RuntimeError("db unavailable"),
        ):
            loaded, manifest = (
                persisted_feedback_sources._load_autoresearch_feedback_evidence_bundles(
                    (), include_persisted=True
                )
            )

        self.assertEqual(loaded, ())
        self.assertEqual(manifest["combined_bundle_count"], 0)
        self.assertEqual(manifest["persisted"]["status"], "unavailable")
        self.assertIn("db unavailable", manifest["persisted"]["error"])

    def test_feedback_evidence_persisted_loader_reconstructs_summary_scorecards(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-summary-scorecard")
        scorecard = {
            "candidate_id": "cand-summary-scorecard",
            "execution_signature": candidate_identity._candidate_spec_execution_signature(
                spec
            ),
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "net_pnl_per_day": "-121.10",
            "negative_day_count": "6",
            "daily_net": {"2026-05-01": "-90.25"},
            "hard_vetoes": ["train_net_per_day_below_screen"],
        }

        with (
            Session(self.engine) as session,
            patch(
                "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchEpoch(
                    epoch_id="summary-feedback-epoch",
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("500"),
                    paper_run_ids_json=[],
                    snapshot_manifest_json={},
                    runner_config_json={},
                    summary_json={
                        "build": {"commit": "abc123"},
                        "candidate_search_remediation": {
                            "partial_scorecards": [
                                {
                                    **scorecard,
                                    "execution_signature": "unmatched-signature",
                                },
                                scorecard,
                            ]
                        },
                    },
                    started_at=datetime(2026, 5, 12, 14, 0, 0),
                    completed_at=datetime(2026, 5, 12, 14, 5, 0),
                    failure_reason=None,
                )
            )
            session.add(
                AutoresearchCandidateSpec(
                    candidate_spec_id=spec.candidate_spec_id,
                    epoch_id="summary-feedback-epoch",
                    hypothesis_id=spec.hypothesis_id,
                    candidate_kind=spec.candidate_kind,
                    family_template_id=spec.family_template_id,
                    payload_json=spec.to_payload(),
                    payload_hash="summary-feedback-hash",
                    status="eligible",
                    blockers_json=None,
                )
            )
            session.commit()

            loaded, manifest = (
                persisted_feedback_sources._load_recent_persisted_feedback_evidence_bundles()
            )

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(loaded[0].candidate_id, "cand-summary-scorecard")
        self.assertEqual(
            loaded[0].dataset_snapshot_id,
            "autoresearch-epoch:summary-feedback-epoch:summary-scorecards",
        )
        self.assertEqual(manifest["status"], "loaded")
        self.assertEqual(manifest["source_epoch_ids"], [])
        self.assertEqual(
            manifest["legacy_summary_source_epoch_ids"], ["summary-feedback-epoch"]
        )
        self.assertEqual(manifest["legacy_summary_scorecard_count"], 2)
        self.assertEqual(manifest["legacy_summary_matched_scorecard_count"], 1)
        self.assertEqual(manifest["legacy_summary_unmatched_scorecard_count"], 1)
        self.assertEqual(manifest["legacy_summary_bundle_count"], 1)

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(rows[0]["selection_reason"], "pre_replay_mlx_feedback_blocked")

    def test_feedback_evidence_persisted_loader_reconstructs_blocked_portfolio_candidates(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-portfolio-feedback")
        scorecard = {
            "net_pnl_per_day": "306.12",
            "portfolio_post_cost_net_pnl_per_day": "306.12",
            "active_day_ratio": "0.72",
            "positive_day_ratio": "0.68",
            "max_drawdown": "6400",
            "max_single_symbol_contribution_share": "0.91",
            "profit_target_oracle": {
                "passed": False,
                "blockers": [
                    "portfolio_post_cost_net_pnl_per_day_failed",
                    "max_single_symbol_contribution_share_failed",
                    "max_drawdown_failed",
                ],
            },
        }
        sleeve = {
            "candidate_id": "candidate-portfolio-feedback",
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "weight": "0.50",
            "expected_net_pnl_per_day": "153.06",
            "source_expected_net_pnl_per_day": "306.12",
            "risk_contribution": "3200",
            "source_risk_contribution": "6400",
            "correlation_cluster": "NVDA",
            "params": {
                "signal_motif": "order_flow_continuation",
                "selection_mode": "top",
                "rank_feature": "ofi_z",
                "capital_profile": "feedback_escape",
                "top_n": "2",
            },
            "universe_symbols": ["NVDA", "AMD"],
        }

        with (
            Session(self.engine) as session,
            patch(
                "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-feedback-blocked",
                    epoch_id="portfolio-feedback-epoch",
                    source_candidate_ids_json=["candidate-portfolio-feedback"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json=scorecard,
                    optimizer_report_json={"method": "test"},
                    payload_json={
                        "schema_version": "torghut.portfolio-candidate-spec.v1",
                        "portfolio_candidate_id": "portfolio-feedback-blocked",
                        "source_candidate_ids": ["candidate-portfolio-feedback"],
                        "target_net_pnl_per_day": "500",
                        "sleeves": [sleeve],
                        "objective_scorecard": scorecard,
                        "optimizer_report": {"method": "test"},
                    },
                    status="blocked",
                )
            )
            session.commit()

            loaded, manifest = (
                persisted_feedback_sources._load_recent_persisted_feedback_evidence_bundles()
            )

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(loaded[0].candidate_id, "candidate-portfolio-feedback")
        self.assertEqual(
            loaded[0].dataset_snapshot_id,
            "autoresearch-portfolio-candidate:portfolio-feedback-epoch:portfolio-feedback-blocked",
        )
        self.assertEqual(
            loaded[0].objective_scorecard["portfolio_candidate_id"],
            "portfolio-feedback-blocked",
        )
        self.assertEqual(loaded[0].objective_scorecard["portfolio_status"], "blocked")
        self.assertIn(
            "portfolio_post_cost_net_pnl_per_day_failed",
            loaded[0].objective_scorecard["portfolio_blockers"],
        )
        self.assertIn(
            "max_drawdown_failed",
            loaded[0].objective_scorecard["hard_vetoes"],
        )
        self.assertTrue(loaded[0].objective_scorecard["feedback_shape_key"])
        self.assertTrue(loaded[0].objective_scorecard["feedback_risk_profile_key"])
        self.assertEqual(manifest["status"], "loaded")
        self.assertEqual(manifest["portfolio_candidate_scanned_count"], 1)
        self.assertEqual(manifest["portfolio_candidate_bundle_count"], 1)
        self.assertEqual(
            manifest["portfolio_candidate_ids"], ["portfolio-feedback-blocked"]
        )

        model, rows = proposal_building._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(
            rows[0]["selection_reason"], "pre_replay_mlx_feedback_penalized"
        )

    def test_portfolio_candidate_feedback_skips_non_feedback_and_empty_scorecards(
        self,
    ) -> None:
        non_feedback_status = AutoresearchPortfolioCandidate(
            portfolio_candidate_id="portfolio-feedback-ready",
            epoch_id="portfolio-feedback-skip-epoch",
            source_candidate_ids_json=["candidate-feedback-ready"],
            target_net_pnl_per_day=Decimal("500"),
            objective_scorecard_json={"net_pnl_per_day": "520"},
            optimizer_report_json={},
            payload_json={
                "sleeves": [{"candidate_spec_id": "candidate-feedback-ready"}],
            },
            status="promotion_ready",
        )
        empty_scorecard = AutoresearchPortfolioCandidate(
            portfolio_candidate_id="portfolio-feedback-empty",
            epoch_id="portfolio-feedback-skip-epoch",
            source_candidate_ids_json=["candidate-feedback-empty"],
            target_net_pnl_per_day=Decimal("500"),
            objective_scorecard_json={},
            optimizer_report_json={},
            payload_json={
                "sleeves": [{"candidate_spec_id": "candidate-feedback-empty"}],
            },
            status="blocked",
        )

        self.assertEqual(
            rejected_signal_feedback._portfolio_candidate_row_to_feedback_bundles(
                non_feedback_status
            ),
            (),
        )
        self.assertEqual(
            rejected_signal_feedback._portfolio_candidate_row_to_feedback_bundles(
                empty_scorecard
            ),
            (),
        )

    def test_portfolio_candidate_feedback_uses_fallback_sleeves_and_skips_invalid_ones(
        self,
    ) -> None:
        scorecard = {
            "net_pnl_per_day": "520",
            "profit_target_oracle": {
                "passed": False,
                "blockers": ["profit_factor_below_oracle"],
            },
        }
        fallback_row = AutoresearchPortfolioCandidate(
            portfolio_candidate_id="portfolio-feedback-fallback",
            epoch_id="portfolio-feedback-fallback-epoch",
            source_candidate_ids_json=["candidate-feedback-fallback"],
            target_net_pnl_per_day=Decimal("500"),
            objective_scorecard_json=scorecard,
            optimizer_report_json={},
            payload_json={"objective_scorecard": scorecard},
            status="paper_probation",
        )
        invalid_sleeve_row = AutoresearchPortfolioCandidate(
            portfolio_candidate_id="portfolio-feedback-invalid-sleeve",
            epoch_id="portfolio-feedback-fallback-epoch",
            source_candidate_ids_json=[],
            target_net_pnl_per_day=Decimal("500"),
            objective_scorecard_json=scorecard,
            optimizer_report_json={},
            payload_json={"sleeves": [{}], "objective_scorecard": scorecard},
            status="blocked",
        )

        fallback_bundles = (
            rejected_signal_feedback._portfolio_candidate_row_to_feedback_bundles(
                fallback_row
            )
        )

        self.assertEqual(len(fallback_bundles), 1)
        self.assertEqual(
            fallback_bundles[0].candidate_spec_id, "candidate-feedback-fallback"
        )
        self.assertEqual(
            fallback_bundles[0].objective_scorecard["portfolio_status"],
            "paper_probation",
        )
        self.assertIn(
            "profit_factor_below_oracle",
            fallback_bundles[0].objective_scorecard["portfolio_blockers"],
        )
        self.assertEqual(
            rejected_signal_feedback._portfolio_candidate_row_to_feedback_bundles(
                invalid_sleeve_row
            ),
            (),
        )

    def test_feedback_evidence_persisted_loader_skips_empty_invalid_and_limited_payloads(
        self,
    ) -> None:
        valid_spec = self._candidate_spec("spec-feedback-limit")
        valid_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=valid_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-limit",
                "objective_scorecard": {"net_pnl_per_day": "25"},
            },
            dataset_snapshot_id="snap-feedback-limit",
            result_path="feedback://limit",
        )
        extra_bundle = evidence_bundles.evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-feedback-extra",
            candidate={
                "candidate_id": "cand-feedback-extra",
                "objective_scorecard": {"net_pnl_per_day": "30"},
            },
            dataset_snapshot_id="snap-feedback-limit",
            result_path="feedback://limit-extra",
        )
        invalid_payload = {"schema_version": "torghut.invalid-feedback.v1"}

        with (
            Session(self.engine) as session,
            patch(
                "scripts.whitepaper_autoresearch_runner.persisted_feedback_sources.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add_all(
                [
                    AutoresearchEpoch(
                        epoch_id="feedback-empty-epoch",
                        status="no_profit_target_candidate",
                        target_net_pnl_per_day=Decimal("500"),
                        paper_run_ids_json=[],
                        snapshot_manifest_json={},
                        runner_config_json={},
                        summary_json={},
                        started_at=datetime(2026, 5, 13, 14, 0, 0),
                        completed_at=datetime(2026, 5, 13, 14, 5, 0),
                        failure_reason=None,
                    ),
                    AutoresearchEpoch(
                        epoch_id="feedback-invalid-and-limited-epoch",
                        status="no_profit_target_candidate",
                        target_net_pnl_per_day=Decimal("500"),
                        paper_run_ids_json=[],
                        snapshot_manifest_json={},
                        runner_config_json={},
                        summary_json={
                            "candidate_evidence_bundle_payloads": [
                                invalid_payload,
                                valid_bundle.to_payload(),
                                extra_bundle.to_payload(),
                            ]
                        },
                        started_at=datetime(2026, 5, 12, 14, 0, 0),
                        completed_at=datetime(2026, 5, 12, 14, 5, 0),
                        failure_reason=None,
                    ),
                    AutoresearchEpoch(
                        epoch_id="feedback-unscanned-after-limit-epoch",
                        status="no_profit_target_candidate",
                        target_net_pnl_per_day=Decimal("500"),
                        paper_run_ids_json=[],
                        snapshot_manifest_json={},
                        runner_config_json={},
                        summary_json={
                            "candidate_evidence_bundle_payloads": [
                                extra_bundle.to_payload()
                            ]
                        },
                        started_at=datetime(2026, 5, 11, 14, 0, 0),
                        completed_at=datetime(2026, 5, 11, 14, 5, 0),
                        failure_reason=None,
                    ),
                ]
            )
            session.commit()

            loaded, manifest = (
                persisted_feedback_sources._load_recent_persisted_feedback_evidence_bundles(
                    limit=1
                )
            )

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, valid_spec.candidate_spec_id)
        self.assertEqual(manifest["status"], "loaded")
        self.assertEqual(manifest["invalid_payload_count"], 1)
        self.assertEqual(
            manifest["source_epoch_ids"], ["feedback-invalid-and-limited-epoch"]
        )
