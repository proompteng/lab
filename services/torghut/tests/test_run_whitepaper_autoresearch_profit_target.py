from __future__ import annotations

from dataclasses import replace
import json
import sys
from argparse import Namespace
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Sequence, cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import scripts.compile_whitepaper_claims as claim_compiler_script
import scripts.run_whitepaper_autoresearch_profit_target as runner
import scripts.train_mlx_autoresearch_ranker as ranker_trainer
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Base,
    WhitepaperAnalysisRun,
    WhitepaperClaim,
    WhitepaperClaimRelation,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
)

_CHIP_UNIVERSE = list(runner.LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)


def _source_jsonl_payload() -> dict[str, object]:
    return {
        "run_id": "paper-jsonl-2026",
        "title": "Fresh 2026 Microstructure Paper",
        "source_url": "https://example.test/fresh-2026.pdf",
        "published_at": "2026-04-01",
        "claims": [
            {
                "claim_id": "claim-order-flow-signal",
                "claim_type": "signal_mechanism",
                "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                "data_requirements": ["order_flow_imbalance", "spread_bps"],
                "confidence": "0.8",
            },
            {
                "claim_id": "claim-liquidity-risk",
                "claim_type": "risk_constraint",
                "claim_text": "Sizing should be reduced during spread-widening regimes.",
                "data_requirements": ["spread_bps"],
                "confidence": "0.75",
            },
            {
                "claim_id": "claim-holdout-validation",
                "claim_type": "validation_requirement",
                "claim_text": "Validate the signal on held-out liquidity stress windows.",
                "data_requirements": ["spread_bps"],
                "confidence": "0.7",
            },
        ],
        "claim_relations": [
            {
                "relation_id": "rel-support",
                "relation_type": "supports",
                "source_claim_id": "claim-holdout-validation",
                "target_claim_id": "claim-order-flow-signal",
            }
        ],
    }


class TestRunWhitepaperAutoresearchProfitTarget(TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(self.engine)

    def tearDown(self) -> None:
        self.engine.dispose()

    def _args(self, output_dir: Path) -> Namespace:
        return Namespace(
            output_dir=output_dir,
            epoch_id="",
            paper_run_id=[],
            source_jsonl=[],
            feedback_evidence_jsonl=[],
            seed_recent_whitepapers=True,
            target_net_pnl_per_day="500",
            max_candidates=8,
            top_k=4,
            exploration_slots=2,
            feedback_block_reaudit_slots=0,
            portfolio_size_min=2,
            portfolio_size_max=4,
            replay_mode="synthetic",
            program=Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            ),
            strategy_configmap=Path(
                "argocd/applications/torghut/strategy-configmap.yaml"
            ),
            family_template_dir=Path("config/trading/families"),
            seed_sweep_dir=Path("config/trading"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username="torghut",
            clickhouse_password="secret",
            start_equity="31590.02",
            chunk_minutes=10,
            symbols=",".join(_CHIP_UNIVERSE),
            progress_log_seconds=30,
            max_frontier_candidates_per_spec=runner._DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
            max_total_frontier_candidates=0,
            real_replay_timeout_seconds=0,
            real_replay_shard_size=0,
            real_replay_shard_timeout_seconds=0,
            real_replay_shard_workers=1,
            real_replay_failed_spec_retries=1,
            real_replay_retry_timeout_seconds=0,
            real_replay_retry_max_frontier_candidates_per_spec=1,
            train_days=6,
            holdout_days=3,
            full_window_start_date="2026-02-23",
            full_window_end_date="2026-02-27",
            expected_last_trading_day="",
            allow_stale_tape=False,
            prefetch_full_window_rows=False,
            min_daily_net_pnl=None,
            persist_results=False,
        )

    def _source_jsonl_args(
        self,
        output_dir: Path,
        *,
        source_count: int = 1,
    ) -> Namespace:
        source_path = output_dir.parent / "source.jsonl"
        rows: list[str] = []
        for index in range(source_count):
            source_payload = _source_jsonl_payload()
            source_payload["run_id"] = f"paper-jsonl-{index}"
            rows.append(json.dumps(source_payload))
        source_path.write_text("\n".join(rows) + "\n", encoding="utf-8")
        args = self._args(output_dir)
        args.seed_recent_whitepapers = False
        args.source_jsonl = [source_path]
        return args

    def _candidate_spec(
        self,
        candidate_spec_id: str,
        *,
        family_template_id: str = "microbar_cross_sectional_pairs_v1",
        entry_minute_after_open: str = "45",
        selection_mode: str = "reversal",
    ) -> runner.CandidateSpec:
        return runner.CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id=candidate_spec_id,
            hypothesis_id=f"hyp-{candidate_spec_id}",
            family_template_id=family_template_id,
            candidate_kind="sleeve",
            runtime_family=family_template_id.replace("_v1", ""),
            runtime_strategy_name=f"{family_template_id}-runtime",
            feature_contract={
                "mechanism": "deterministic test spec",
                "required_features": ("spread_bps", "depth_proxy"),
                "source_run_id": f"source-{candidate_spec_id}",
                "family_selection": {"rank": 1},
            },
            parameter_space={},
            strategy_overrides={
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {
                    "entry_minute_after_open": entry_minute_after_open,
                    "exit_minute_after_open": "150",
                    "max_hold_seconds": "5400",
                    "entry_cooldown_seconds": "1200",
                    "long_stop_loss_bps": "8",
                    "long_trailing_stop_activation_profit_bps": "6",
                    "long_trailing_stop_drawdown_bps": "3",
                    "selection_mode": selection_mode,
                    "signal_motif": "open_window_reversal",
                    "rank_feature": "cross_section_session_open_rank",
                    "top_n": "2",
                },
                "universe_symbols": ["NVDA", "AAPL", "INTC"],
            },
            objective={"target_net_pnl_per_day": "500"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )

    def test_candidate_feedback_metadata_preserves_runtime_params_for_closure(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-prevclose-runtime"),
            strategy_overrides={
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {
                    "entry_minute_after_open": "35",
                    "entry_window_minutes": "25",
                    "exit_minute_after_open": "180",
                    "signal_motif": "opening_window_prev_close_reversal",
                    "rank_feature": "cross_section_opening_window_return_from_prev_close_rank",
                    "selection_mode": "reversal",
                    "top_n": "2",
                    "gate_feature": "cross_section_positive_opening_window_return_from_prev_close_ratio",
                    "gate_min": "0.20",
                    "gate_max": "0.85",
                    "long_stop_loss_bps": "5",
                    "long_trailing_stop_activation_profit_bps": "5",
                    "long_trailing_stop_drawdown_bps": "2",
                },
                "universe_symbols": ["NVDA", "AVGO", "AMD"],
            },
        )

        candidate = runner._candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": "candidate-prevclose",
                "objective_scorecard": {"net_pnl_per_day": "401.8"},
            },
        )

        scorecard = candidate["objective_scorecard"]
        self.assertEqual(
            scorecard["runtime_params"]["signal_motif"],
            "opening_window_prev_close_reversal",
        )
        self.assertEqual(
            scorecard["runtime_params"]["gate_feature"],
            "cross_section_positive_opening_window_return_from_prev_close_ratio",
        )
        self.assertEqual(scorecard["universe_symbols"], ["NVDA", "AVGO", "AMD"])

    def test_parse_args_defaults_to_500_daily_profit_program(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with patch.object(
                sys,
                "argv",
                [
                    "run_whitepaper_autoresearch_profit_target.py",
                    "--output-dir",
                    tmpdir,
                ],
            ):
                args = runner._parse_args()

        self.assertEqual(args.target_net_pnl_per_day, "500")
        self.assertEqual(args.epoch_id, "")
        self.assertEqual(
            args.program,
            Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            ),
        )
        self.assertIsNone(args.min_daily_net_pnl)
        self.assertEqual(args.symbols.split(","), _CHIP_UNIVERSE)
        self.assertEqual(args.feedback_evidence_jsonl, [])

    def test_workflow_template_surfaces_feedback_and_fails_closed_on_stale_tape(
        self,
    ) -> None:
        template_path = (
            Path(__file__).parents[3]
            / "argocd"
            / "applications"
            / "torghut"
            / "whitepaper-autoresearch-workflowtemplate.yaml"
        )
        template = template_path.read_text()

        self.assertIn("name: feedbackEvidenceJsonlB64", template)
        self.assertIn("name: feedbackEvidenceConfigMapName", template)
        self.assertIn("name: feedbackEvidenceConfigMapKey", template)
        self.assertIn("--feedback-evidence-jsonl", template)
        self.assertIn("TORGHUT_WHITEPAPER_FEEDBACK_EVIDENCE_JSONL_B64", template)
        self.assertIn("TORGHUT_WHITEPAPER_FEEDBACK_EVIDENCE_CONFIGMAP_PATH", template)
        self.assertIn("TORGHUT_WHITEPAPER_SOURCE_JSONL_B64", template)
        self.assertIn('--epoch-id "${RUN_ID}"', template)
        self.assertIn("name: feedback-evidence", template)
        self.assertNotIn(
            "printf '%s' \"{{inputs.parameters.feedbackEvidenceJsonlB64}}\"",
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
        self.assertIn(
            "name: realReplayTimeoutSeconds\n        value: '7200'", template
        )
        self.assertIn(
            "name: realReplayShardTimeoutSeconds\n        value: '900'", template
        )
        self.assertIn("name: realReplayShardWorkers\n        value: '4'", template)
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
        losing_bundle = runner.evidence_bundle_from_frontier_candidate(
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
        capital_unsafe_bundle = runner.evidence_bundle_from_frontier_candidate(
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

        model, rows = runner._pre_replay_proposal_model_and_rows(
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

    def test_feedback_evidence_jsonl_round_trips(self) -> None:
        spec = self._candidate_spec("spec-feedback-jsonl")
        bundle = runner.evidence_bundle_from_frontier_candidate(
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
            loaded = runner._load_feedback_evidence_bundles((path,))

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)

    def test_feedback_evidence_loads_recent_persisted_epoch_bundles(self) -> None:
        spec = self._candidate_spec("spec-feedback-persisted")
        bundle = runner.evidence_bundle_from_frontier_candidate(
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
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
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

            loaded, manifest = runner._load_autoresearch_feedback_evidence_bundles(
                (), include_persisted=True
            )

        model, rows = runner._pre_replay_proposal_model_and_rows(
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

    def test_feedback_evidence_dedupe_handles_missing_bundle_ids(self) -> None:
        spec = self._candidate_spec("spec-feedback-dedupe")
        bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-dedupe",
                "objective_scorecard": {"net_pnl_per_day": "10"},
            },
            dataset_snapshot_id="snap-feedback-dedupe",
            result_path="feedback://dedupe",
        )
        no_id_bundle = replace(bundle, evidence_bundle_id="")

        deduped = runner._dedupe_feedback_evidence_bundles((no_id_bundle, no_id_bundle))

        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0].candidate_spec_id, spec.candidate_spec_id)

    def test_feedback_evidence_persisted_loader_reports_unavailable_store(self) -> None:
        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=RuntimeError("db unavailable"),
        ):
            loaded, manifest = runner._load_autoresearch_feedback_evidence_bundles(
                (), include_persisted=True
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
            "execution_signature": runner._candidate_spec_execution_signature(spec),
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
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
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

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles()

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

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,), feedback_evidence_bundles=loaded
        )

        self.assertEqual(model["feedback_evidence_bundle_count"], 1)
        self.assertEqual(model["feedback_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(rows[0]["selection_reason"], "pre_replay_mlx_feedback_blocked")

    def test_feedback_evidence_persisted_loader_skips_empty_invalid_and_limited_payloads(
        self,
    ) -> None:
        valid_spec = self._candidate_spec("spec-feedback-limit")
        valid_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=valid_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-feedback-limit",
                "objective_scorecard": {"net_pnl_per_day": "25"},
            },
            dataset_snapshot_id="snap-feedback-limit",
            result_path="feedback://limit",
        )
        extra_bundle = runner.evidence_bundle_from_frontier_candidate(
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
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
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

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles(
                limit=1
            )

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, valid_spec.candidate_spec_id)
        self.assertEqual(manifest["status"], "loaded")
        self.assertEqual(manifest["invalid_payload_count"], 1)
        self.assertEqual(
            manifest["source_epoch_ids"], ["feedback-invalid-and-limited-epoch"]
        )

    def test_feedback_evidence_jsonl_reports_missing_and_invalid_lines(self) -> None:
        with TemporaryDirectory() as tmpdir:
            missing_path = Path(tmpdir) / "missing.jsonl"
            with self.assertRaisesRegex(
                ValueError,
                "feedback_evidence_jsonl_missing",
            ):
                runner._load_feedback_evidence_bundles((missing_path,))

            invalid_path = Path(tmpdir) / "invalid.jsonl"
            invalid_path.write_text("\n[]\n", encoding="utf-8")
            with self.assertRaisesRegex(
                ValueError,
                "feedback_evidence_jsonl_invalid",
            ):
                runner._load_feedback_evidence_bundles((invalid_path,))

    def test_candidate_quality_gate_flags_capital_safety_failures(self) -> None:
        policy = runner.ProfitTargetOraclePolicy()

        failures = runner._candidate_quality_gate_failures(
            {
                "net_pnl_per_day": "750",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.1",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "max_gross_exposure_pct_equity": "1.2",
                "min_cash": "-10",
                "negative_cash_observation_count": "1",
                "avg_filled_notional_per_day": "500000",
                "regime_slice_pass_rate": "1",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                "executable_replay_passed": True,
                "executable_replay_artifact_ref": "/tmp/replay.json",
                "executable_replay_order_count": "5",
                "executable_replay_account_buying_power": "10000",
                "executable_replay_max_notional_per_trade": "9000",
            },
            oracle_policy=policy,
        )

        self.assertIn("max_gross_exposure_above_oracle", failures)
        self.assertIn("min_cash_below_oracle", failures)
        self.assertIn("negative_cash_observed", failures)

    def test_pre_replay_ranker_keeps_best_duplicate_feedback_and_blocks_rejections(
        self,
    ) -> None:
        string_veto_spec = self._candidate_spec("spec-string-veto")
        min_cash_spec = self._candidate_spec("spec-min-cash")
        negative_cash_spec = self._candidate_spec("spec-negative-cash")
        unexplored_spec = self._candidate_spec(
            "spec-unexplored-feedback",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="90",
            selection_mode="continuation",
        )

        def feedback(
            spec: runner.CandidateSpec,
            *,
            candidate_id: str,
            scorecard: dict[str, object],
        ) -> runner.CandidateEvidenceBundle:
            return runner.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": candidate_id,
                    "family_template_id": spec.family_template_id,
                    "runtime_family": spec.runtime_family,
                    "runtime_strategy_name": spec.runtime_strategy_name,
                    "objective_scorecard": {
                        "net_pnl_per_day": "100",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "negative_day_count": 0,
                        "best_day_share": "0.2",
                        "worst_day_loss": "0",
                        "max_drawdown": "0",
                        "max_gross_exposure_pct_equity": "0.5",
                        "min_cash": "0",
                        "negative_cash_observation_count": 0,
                        "avg_filled_notional_per_day": "500000",
                        **scorecard,
                    },
                },
                dataset_snapshot_id="snap-feedback-blockers",
                result_path=f"feedback://{candidate_id}",
            )

        lower_duplicate = feedback(
            string_veto_spec,
            candidate_id="cand-string-veto-low",
            scorecard={"net_pnl_per_day": "-500"},
        )
        higher_blocked_duplicate = feedback(
            string_veto_spec,
            candidate_id="cand-string-veto-high",
            scorecard={
                "net_pnl_per_day": "250",
                "hard_vetoes": "positive_day_ratio_below_oracle",
            },
        )
        min_cash_blocked = feedback(
            min_cash_spec,
            candidate_id="cand-min-cash",
            scorecard={"min_cash": "-1"},
        )
        negative_cash_blocked = feedback(
            negative_cash_spec,
            candidate_id="cand-negative-cash",
            scorecard={"negative_cash_observation_count": "1"},
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(
                string_veto_spec,
                min_cash_spec,
                negative_cash_spec,
                unexplored_spec,
            ),
            feedback_evidence_bundles=(
                lower_duplicate,
                higher_blocked_duplicate,
                min_cash_blocked,
                negative_cash_blocked,
            ),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_evidence_bundle_count"], 4)
        self.assertEqual(model["feedback_matched_spec_count"], 3)
        self.assertEqual(
            row_by_spec[string_veto_spec.candidate_spec_id]["feedback_replay_target"],
            85.0,
        )
        self.assertEqual(
            row_by_spec[string_veto_spec.candidate_spec_id]["features"][
                "history_observed_replay_viability_penalty"
            ],
            50.0,
        )
        self.assertEqual(
            row_by_spec[string_veto_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_penalized",
        )
        self.assertEqual(
            row_by_spec[min_cash_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_penalized",
        )
        self.assertEqual(
            row_by_spec[negative_cash_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_feedback_penalized",
        )
        self.assertEqual(
            row_by_spec[unexplored_spec.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )

    def test_pre_replay_ranker_blocks_feedback_execution_signature_drift(
        self,
    ) -> None:
        original_spec = self._candidate_spec("spec-original-signature")
        drifted_spec = replace(
            original_spec,
            candidate_spec_id="spec-drifted-signature",
            hypothesis_id="hyp-spec-drifted-signature",
            feature_contract={
                **dict(original_spec.feature_contract),
                "source_run_id": "source-spec-drifted-signature",
            },
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=original_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-original-signature",
                "family_template_id": original_spec.family_template_id,
                "runtime_family": original_spec.runtime_family,
                "runtime_strategy_name": original_spec.runtime_strategy_name,
                "execution_signature": runner._candidate_spec_execution_signature(
                    original_spec
                ),
                "objective_scorecard": {
                    "net_pnl_per_day": "-33",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 5,
                    "daily_net": {
                        "2026-05-01": "-12",
                        "2026-05-04": "-54",
                    },
                },
            },
            dataset_snapshot_id="snap-feedback-signature",
            result_path="feedback://signature-drift",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(drifted_spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(model["feedback_matched_spec_count"], 0)
        self.assertEqual(model["feedback_execution_signature_matched_spec_count"], 1)
        row = rows[0]
        self.assertEqual(row["candidate_spec_id"], drifted_spec.candidate_spec_id)
        self.assertEqual(row["training_source"], "feedback_execution_signature_replay")
        self.assertEqual(
            row["selection_reason"], "pre_replay_mlx_signature_feedback_blocked"
        )
        self.assertEqual(
            row["feedback_source_candidate_spec_id"],
            original_spec.candidate_spec_id,
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(drifted_spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_feedback_blocked_candidate_count"], 1
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_signature_feedback_blocked",
        )

    def test_pre_replay_ranker_penalizes_family_feedback_without_blocking_mutations(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-family-source")
        mutated_family_spec = self._candidate_spec(
            "spec-family-mutated",
            entry_minute_after_open="60",
        )
        unrelated_spec = self._candidate_spec(
            "spec-unrelated-family",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="90",
            selection_mode="continuation",
        )
        family_feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-family-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "125",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "negative_day_count": 0,
                    "daily_net": {
                        "2026-05-01": "250",
                        "2026-05-04": "-25",
                    },
                },
            },
            dataset_snapshot_id="snap-family-feedback",
            result_path="feedback://family",
        )
        no_family_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-not-in-current-epoch",
            candidate={
                "candidate_id": "cand-no-family",
                "objective_scorecard": {
                    "net_pnl_per_day": "-999",
                    "daily_net": {"2026-05-01": "-999"},
                },
            },
            dataset_snapshot_id="snap-no-family",
            result_path="feedback://no-family",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(mutated_family_spec, unrelated_spec),
            feedback_evidence_bundles=(family_feedback_bundle, no_family_bundle),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_family_matched_spec_count"], 1)
        self.assertEqual(model["training_source_counts"]["feedback_family_replay"], 1)
        self.assertEqual(
            row_by_spec[mutated_family_spec.candidate_spec_id]["training_source"],
            "feedback_family_replay",
        )
        self.assertEqual(
            row_by_spec[mutated_family_spec.candidate_spec_id]["feedback_match_scope"],
            "family_template_id",
        )
        self.assertEqual(
            row_by_spec[mutated_family_spec.candidate_spec_id][
                "feedback_source_candidate_spec_id"
            ],
            source_spec.candidate_spec_id,
        )
        self.assertEqual(
            row_by_spec[mutated_family_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_family_feedback_penalized",
        )
        self.assertEqual(
            row_by_spec[unrelated_spec.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )

    def test_candidate_selection_blocks_nonpositive_family_feedback(self) -> None:
        source_spec = self._candidate_spec("spec-family-negative-source")
        mutated_family_spec = self._candidate_spec(
            "spec-family-negative-mutated",
            entry_minute_after_open="60",
        )
        family_feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-family-negative-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-250",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 4,
                    "daily_net": {
                        "2026-05-01": "-150",
                        "2026-05-04": "-350",
                    },
                },
            },
            dataset_snapshot_id="snap-family-negative-feedback",
            result_path="feedback://family-negative",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(mutated_family_spec,),
            feedback_evidence_bundles=(family_feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_family_replay")
        self.assertEqual(
            rows[0]["selection_reason"], "pre_replay_mlx_family_feedback_blocked"
        )
        self.assertLessEqual(
            Decimal(str(rows[0]["proposal_score"])), Decimal("-999999")
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(mutated_family_spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_feedback_blocked_candidate_count"], 1
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_family_feedback_blocked",
        )

    def test_candidate_selection_can_reaudit_feedback_blocked_candidates(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-reaudit-source")
        blocked_spec = self._candidate_spec(
            "spec-reaudit-blocked",
            entry_minute_after_open="60",
        )
        capital_unsafe_spec = replace(
            self._candidate_spec(
                "spec-reaudit-capital-unsafe",
                family_template_id="breakout_reclaim_v2",
            ),
            strategy_overrides={
                **self._candidate_spec(
                    "spec-reaudit-capital-unsafe",
                    family_template_id="breakout_reclaim_v2",
                ).strategy_overrides,
                "max_notional_per_trade": "157950",
                "max_position_pct_equity": "4",
            },
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-reaudit-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-250",
                    "active_day_ratio": "1",
                    "positive_day_ratio": "0",
                    "negative_day_count": 4,
                    "daily_net": {"2026-05-01": "-250"},
                },
            },
            dataset_snapshot_id="snap-reaudit-feedback",
            result_path="feedback://reaudit",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(blocked_spec, capital_unsafe_spec),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(blocked_spec, capital_unsafe_spec),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            feedback_block_reaudit_slots=1,
            max_candidates=2,
            portfolio_size_min=1,
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in selection["rows"]}

        self.assertEqual(selected, [blocked_spec])
        self.assertEqual(selection["budget"]["selected_count"], 1)
        self.assertEqual(
            selection["budget"]["feedback_block_reaudit_selected_count"], 1
        )
        self.assertEqual(
            row_by_spec[blocked_spec.candidate_spec_id]["selection_reason"],
            "feedback_block_reaudit",
        )
        self.assertFalse(
            row_by_spec[capital_unsafe_spec.candidate_spec_id]["selected_for_replay"]
        )

    def test_candidate_selection_replays_feedback_reaudit_before_synthetic_probe(
        self,
    ) -> None:
        feedback_spec = self._candidate_spec("spec-feedback-first")
        synthetic_probe_spec = self._candidate_spec(
            "spec-synthetic-probe",
            family_template_id="mean_reversion_rebound_v1",
            entry_minute_after_open="75",
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(synthetic_probe_spec, feedback_spec),
            proposal_rows=[
                {
                    "candidate_spec_id": synthetic_probe_spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": -12.5,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": 1,
                },
                {
                    "candidate_spec_id": feedback_spec.candidate_spec_id,
                    "rank": 2,
                    "proposal_score": -1_000_000,
                    "selection_reason": "pre_replay_mlx_feedback_blocked",
                    "training_source": "feedback_real_replay",
                },
            ],
            top_k=1,
            exploration_slots=1,
            feedback_block_reaudit_slots=1,
            max_candidates=2,
            portfolio_size_min=1,
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in selection["rows"]}

        self.assertEqual(selected, [feedback_spec, synthetic_probe_spec])
        self.assertEqual(
            row_by_spec[feedback_spec.candidate_spec_id]["selection_reason"],
            "feedback_block_reaudit",
        )
        self.assertEqual(
            row_by_spec[synthetic_probe_spec.candidate_spec_id]["selection_reason"],
            "synthetic_prior_exploration",
        )
        self.assertEqual(row_by_spec[feedback_spec.candidate_spec_id]["replay_order"], 1)
        self.assertEqual(
            row_by_spec[synthetic_probe_spec.candidate_spec_id]["replay_order"], 2
        )

    def test_candidate_selection_keeps_positive_blocked_feedback_repair_candidates(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-positive-blocked-feedback")
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-positive-blocked-feedback",
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "959.07",
                    "active_day_ratio": "0.2",
                    "positive_day_ratio": "0.2",
                    "negative_day_count": 2,
                    "min_cash": "-100",
                    "negative_cash_observation_count": 8,
                    "daily_net": {
                        "2026-05-01": "4795.37",
                        "2026-05-04": "-980.59",
                    },
                },
            },
            dataset_snapshot_id="snap-positive-blocked-feedback",
            result_path="feedback://positive-blocked",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(
            rows[0]["selection_reason"], "pre_replay_mlx_feedback_penalized"
        )
        self.assertGreater(Decimal(str(rows[0]["proposal_score"])), Decimal("-999999"))

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [spec])
        self.assertEqual(selection["budget"]["selected_count"], 1)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "exploitation",
        )

    def test_candidate_selection_blocks_capital_infeasible_replay_candidates(
        self,
    ) -> None:
        base_unsafe_spec = self._candidate_spec("spec-unsafe-capital")
        unsafe_spec = replace(
            base_unsafe_spec,
            strategy_overrides={
                **base_unsafe_spec.strategy_overrides,
                "max_notional_per_trade": "157950",
                "max_position_pct_equity": "8.0",
            },
            promotion_contract={
                "profit_target_oracle_policy": {"max_gross_exposure_pct_equity": "1.0"}
            },
        )
        safe_spec = self._candidate_spec("spec-safe-capital")
        proposal_rows = [
            {
                "candidate_spec_id": unsafe_spec.candidate_spec_id,
                "proposal_score": 1000,
                "rank": 1,
                "selection_reason": "pre_replay_mlx_rank",
                "training_source": "synthetic_prior",
            },
            {
                "candidate_spec_id": safe_spec.candidate_spec_id,
                "proposal_score": 10,
                "rank": 2,
                "selection_reason": "pre_replay_mlx_rank",
                "training_source": "synthetic_prior",
            },
        ]

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(unsafe_spec, safe_spec),
            proposal_rows=proposal_rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [safe_spec])
        row_by_spec = {row["candidate_spec_id"]: row for row in selection["rows"]}
        self.assertEqual(
            row_by_spec[unsafe_spec.candidate_spec_id]["selection_reason"],
            "pre_replay_capital_budget_blocked",
        )
        self.assertFalse(
            row_by_spec[unsafe_spec.candidate_spec_id]["selected_for_replay"]
        )
        self.assertEqual(
            selection["budget"]["pre_replay_capital_blocked_candidate_count"], 1
        )
        self.assertTrue(
            row_by_spec[safe_spec.candidate_spec_id]["capital_budget"][
                "capital_feasible"
            ]
        )

    def test_candidate_selection_keeps_positive_signature_feedback_repair_candidates(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-positive-signature-source")
        matching_spec = self._candidate_spec("spec-positive-signature-match")
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-positive-signature-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "execution_signature": runner._candidate_spec_execution_signature(
                    source_spec
                ),
                "objective_scorecard": {
                    "net_pnl_per_day": "741.86",
                    "active_day_ratio": "0.3333333333",
                    "positive_day_ratio": "0.1666666667",
                    "negative_day_count": 3,
                    "daily_net": {
                        "2026-05-01": "4451.21",
                        "2026-05-04": "-1668.80",
                    },
                },
            },
            dataset_snapshot_id="snap-positive-signature-feedback",
            result_path="feedback://positive-signature",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(matching_spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(
            rows[0]["training_source"], "feedback_execution_signature_replay"
        )
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_signature_feedback_penalized",
        )
        self.assertGreater(Decimal(str(rows[0]["proposal_score"])), Decimal("-999999"))

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(matching_spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [matching_spec])
        self.assertEqual(selection["budget"]["selected_count"], 1)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)

    def test_pre_replay_ranker_blocks_shape_and_penalizes_risk_profile_feedback(
        self,
    ) -> None:
        failed_spec = self._candidate_spec("spec-daily-coverage-source")
        same_shape_probe = replace(
            failed_spec,
            candidate_spec_id="spec-same-shape-probe",
            hypothesis_id="hyp-spec-same-shape-probe",
            hard_vetoes={"required_min_daily_notional": "400000"},
        )
        different_shape_same_risk_probe = replace(
            failed_spec,
            candidate_spec_id="spec-risk-profile-probe",
            hypothesis_id="hyp-spec-risk-profile-probe",
            hard_vetoes={"required_min_daily_notional": "450000"},
            strategy_overrides={
                **failed_spec.strategy_overrides,
                "params": {
                    **cast(dict[str, Any], failed_spec.strategy_overrides["params"]),
                    "entry_minute_after_open": "90",
                },
            },
        )
        clean_probe = self._candidate_spec(
            "spec-clean-probe",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="120",
            selection_mode="continuation",
        )
        self.assertNotEqual(
            runner._candidate_spec_execution_signature(failed_spec),
            runner._candidate_spec_execution_signature(same_shape_probe),
        )
        self.assertEqual(
            runner._candidate_spec_feedback_shape_key(failed_spec),
            runner._candidate_spec_feedback_shape_key(same_shape_probe),
        )
        self.assertNotEqual(
            runner._candidate_spec_feedback_shape_key(failed_spec),
            runner._candidate_spec_feedback_shape_key(different_shape_same_risk_probe),
        )
        self.assertEqual(
            runner._candidate_spec_feedback_risk_profile_key(failed_spec),
            runner._candidate_spec_feedback_risk_profile_key(
                different_shape_same_risk_probe
            ),
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=failed_spec,
                candidate={
                    "candidate_id": "cand-daily-coverage-source",
                    "objective_scorecard": {
                        "net_pnl_per_day": "959.07",
                        "active_day_ratio": "0.2",
                        "positive_day_ratio": "0.2",
                        "negative_day_count": 0,
                        "best_day_share": "0.92",
                        "daily_net": {
                            "2026-05-01": "4795.37",
                            "2026-05-04": "0",
                        },
                    },
                },
            ),
            dataset_snapshot_id="snap-daily-coverage-feedback",
            result_path="feedback://daily-coverage",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(same_shape_probe, different_shape_same_risk_probe, clean_probe),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertEqual(model["feedback_shape_matched_spec_count"], 1)
        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 1)
        self.assertEqual(
            row_by_spec[same_shape_probe.candidate_spec_id]["training_source"],
            "feedback_shape_prior",
        )
        self.assertEqual(
            row_by_spec[same_shape_probe.candidate_spec_id]["selection_reason"],
            "pre_replay_mlx_shape_feedback_blocked",
        )
        self.assertLessEqual(
            Decimal(
                str(row_by_spec[same_shape_probe.candidate_spec_id]["proposal_score"])
            ),
            Decimal("-999999"),
        )
        self.assertEqual(
            row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                "training_source"
            ],
            "feedback_risk_profile_prior",
        )
        self.assertEqual(
            row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                "selection_reason"
            ],
            "pre_replay_mlx_risk_profile_feedback_penalized",
        )
        self.assertLessEqual(
            Decimal(
                str(
                    row_by_spec[different_shape_same_risk_probe.candidate_spec_id][
                        "proposal_score"
                    ]
                )
            ),
            Decimal("-500000"),
        )
        self.assertEqual(
            row_by_spec[clean_probe.candidate_spec_id]["training_source"],
            "synthetic_prior",
        )

    def test_candidate_selection_blocks_terminal_risk_profile_feedback(self) -> None:
        failed_spec = self._candidate_spec("spec-risk-terminal-source")
        matching_risk_probe = replace(
            failed_spec,
            candidate_spec_id="spec-risk-terminal-probe",
            hypothesis_id="hyp-spec-risk-terminal-probe",
            hard_vetoes={"required_min_daily_notional": "450000"},
            strategy_overrides={
                **failed_spec.strategy_overrides,
                "params": {
                    **cast(dict[str, Any], failed_spec.strategy_overrides["params"]),
                    "entry_minute_after_open": "90",
                },
            },
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=failed_spec,
                candidate={
                    "candidate_id": "cand-terminal-risk-feedback",
                    "objective_scorecard": {
                        "net_pnl_per_day": "-72.11",
                        "active_day_ratio": "0.8",
                        "positive_day_ratio": "0",
                        "negative_day_count": 4,
                        "best_day_share": "1",
                        "daily_net": {
                            "2026-05-04": "-287.72",
                            "2026-05-05": "-22.05",
                            "2026-05-06": "-13.51",
                            "2026-05-07": "-37.30",
                            "2026-05-12": "0",
                        },
                    },
                },
            ),
            dataset_snapshot_id="snap-terminal-risk-feedback",
            result_path="feedback://terminal-risk",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(matching_risk_probe,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_risk_profile_prior")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_risk_profile_feedback_blocked",
        )
        self.assertLessEqual(
            Decimal(str(rows[0]["proposal_score"])), Decimal("-999999")
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(matching_risk_probe,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_feedback_blocked_candidate_count"], 1
        )

    def test_terminal_risk_profile_block_covers_capital_paths(self) -> None:
        self.assertFalse(runner._feedback_risk_profile_has_terminal_block({}))

        penalty_scorecard = {
            "profit_target_oracle": {
                "blockers": ["max_single_day_contribution_share_failed"]
            },
            "net_pnl_per_day": "250",
            "active_day_ratio": "1",
            "positive_day_ratio": "1",
            "best_day_share": "0.25",
        }
        self.assertTrue(
            runner._feedback_risk_profile_has_terminal_block(
                {
                    **penalty_scorecard,
                    "max_gross_exposure_pct_equity": "1.01",
                }
            )
        )
        self.assertTrue(
            runner._feedback_risk_profile_has_terminal_block(
                {
                    **penalty_scorecard,
                    "min_cash": "-0.01",
                }
            )
        )
        self.assertTrue(
            runner._feedback_risk_profile_has_terminal_block(
                {
                    **penalty_scorecard,
                    "negative_cash_observation_count": "1",
                }
            )
        )

    def test_feedback_shape_prior_penalizes_cash_blocks_without_family_veto(
        self,
    ) -> None:
        failed_spec = self._candidate_spec("spec-shape-cash-source")
        same_shape_probe = replace(
            failed_spec,
            candidate_spec_id="spec-shape-cash-probe",
            hypothesis_id="hyp-spec-shape-cash-probe",
            hard_vetoes={"required_min_daily_notional": "400000"},
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=failed_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=failed_spec,
                candidate={
                    "candidate_id": "cand-shape-cash-source",
                    "objective_scorecard": {
                        "net_pnl_per_day": "250",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                        "best_day_share": "0.25",
                        "min_cash": "-1",
                    },
                },
            ),
            dataset_snapshot_id="snap-shape-cash-feedback",
            result_path="feedback://shape-cash",
        )

        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(same_shape_probe,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(model["feedback_shape_matched_spec_count"], 1)
        self.assertEqual(rows[0]["training_source"], "feedback_shape_prior")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_family_feedback_penalized",
        )

    def test_feedback_scorecard_helpers_cover_veto_and_penalty_edges(self) -> None:
        invalid_universe_spec = replace(
            self._candidate_spec("spec-invalid-universe"),
            strategy_overrides={
                **self._candidate_spec("spec-invalid-universe").strategy_overrides,
                "universe_symbols": "NVDA",
            },
        )
        self.assertEqual(runner._candidate_spec_universe_key(invalid_universe_spec), "")
        self.assertTrue(
            runner._feedback_scorecard_has_hard_veto(
                {
                    "profit_target_oracle": {
                        "blockers": ["positive_day_ratio_below_oracle"]
                    }
                }
            )
        )
        self.assertTrue(
            runner._feedback_scorecard_has_hard_veto({"oracle_passed": False})
        )
        self.assertFalse(runner._feedback_daily_net_has_loss({"daily_net": "bad"}))
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block(
                {
                    "profit_target_oracle": {
                        "blockers": ["active_day_ratio_below_oracle"]
                    }
                }
            )
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block({"positive_day_ratio": "0.5"})
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block({"best_day_share": "0.51"})
        )
        self.assertTrue(
            runner._feedback_family_prior_has_hard_block(
                {
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "best_day_share": "0.25",
                    "daily_net": {"2026-05-01": "0"},
                }
            )
        )
        for scorecard in (
            {
                "profit_target_oracle": {
                    "blockers": ["max_single_day_contribution_share_failed"]
                }
            },
            {"best_day_share": "0.36"},
            {"max_single_day_contribution_share": "0.36"},
            {"max_single_symbol_contribution_share": "0.36"},
            {"max_cluster_contribution_share": "0.41"},
        ):
            self.assertTrue(runner._feedback_risk_profile_has_penalty(scorecard))
        self.assertEqual(runner._feedback_risk_profile_key_from_scorecard({}), "")

        spec = self._candidate_spec("spec-empty-risk-key")
        orphan_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id="spec-unmatched-risk-feedback",
            candidate={
                "candidate_id": "cand-unmatched-risk-feedback",
                "objective_scorecard": {"positive_day_ratio": "0.5"},
            },
            dataset_snapshot_id="snap-empty-risk-key",
            result_path="feedback://empty-risk-key",
        )
        model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,),
            feedback_evidence_bundles=(orphan_bundle,),
        )

        self.assertEqual(model["feedback_risk_profile_matched_spec_count"], 0)
        self.assertEqual(rows[0]["training_source"], "synthetic_prior")

    def test_real_replay_evidence_carries_feedback_shape_metadata(self) -> None:
        spec = self._candidate_spec("spec-real-replay-shape-metadata")
        with TemporaryDirectory() as tmpdir:
            result_path = Path(tmpdir) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real-replay-shape",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "650",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )

            replay = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "candidate_spec_id": spec.candidate_spec_id,
                            "result_path": str(result_path),
                            "dataset_snapshot_id": "snap-real-replay-shape",
                        }
                    ]
                },
                specs_by_id={spec.candidate_spec_id: spec},
            )

        self.assertEqual(len(replay.evidence_bundles), 1)
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(
            scorecard["feedback_shape_key"],
            runner._candidate_spec_feedback_shape_key(spec),
        )
        self.assertEqual(
            scorecard["feedback_risk_profile_key"],
            runner._candidate_spec_feedback_risk_profile_key(spec),
        )
        self.assertEqual(
            scorecard["execution_signature"],
            runner._candidate_spec_execution_signature(spec),
        )

    def test_candidate_selection_blocks_synthetic_nonpositive_expected_value(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-negative-synthetic-prior")

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": 0.0,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": 1,
                }
            ],
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_candidate_count"], 1
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_synthetic_nonpositive_expected_value",
        )

    def test_candidate_selection_uses_exploration_for_synthetic_nonpositive_prior(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-negative-synthetic-prior-probe")

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": -12.5,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": 1,
                }
            ],
            top_k=1,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [spec])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_candidate_count"], 1
        )
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_exploration_count"],
            1,
        )
        self.assertEqual(selection["budget"]["pre_replay_blocked_candidate_count"], 0)
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "synthetic_prior_exploration",
        )
        self.assertTrue(selection["rows"][0]["selected_for_replay"])

    def test_candidate_selection_ignores_malformed_feedback_context_for_synthetic_prior(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-malformed-feedback-context")

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": 0.0,
                    "selection_reason": "pre_replay_mlx_rank",
                    "training_source": "synthetic_prior",
                    "feedback_evidence_context_count": "bad-int",
                }
            ],
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [spec])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_candidate_count"],
            0,
        )

    def test_candidate_selection_handles_scalar_universe_overrides(self) -> None:
        scalar_universe_spec = replace(
            self._candidate_spec("spec-scalar-universe"),
            strategy_overrides={
                "max_notional_per_trade": "7500",
                "max_position_pct_equity": "0.25",
                "params": {"entry_minute_after_open": "45"},
                "universe_symbols": "NVDA",
            },
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(scalar_universe_spec,),
            proposal_rows=[
                {
                    "candidate_spec_id": scalar_universe_spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": 10.0,
                    "training_source": "synthetic_prior",
                }
            ],
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [scalar_universe_spec])
        self.assertEqual(selection["rows"][0]["universe_key"], "")

    def test_parse_args_defaults_strategy_configmap_to_runtime_env_path(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with patch.dict(
                "os.environ",
                {"TRADING_STRATEGY_CONFIG_PATH": "/etc/torghut/strategies.yaml"},
            ):
                with patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ):
                    args = runner._parse_args()

        self.assertEqual(args.strategy_configmap, Path("/etc/torghut/strategies.yaml"))

    def test_seed_recent_whitepapers_runs_end_to_end_and_writes_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.epoch_id = "whitepaper-autoresearch-test-epoch"
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            self.assertEqual(payload["epoch_id"], "whitepaper-autoresearch-test-epoch")
            self.assertEqual(payload["status"], "no_profit_target_candidate")
            self.assertEqual(
                payload["status_reason"],
                "portfolio_candidate_failed_profit_target_oracle",
            )
            self.assertGreaterEqual(payload["source_count"], 4)
            self.assertGreaterEqual(payload["candidate_spec_count"], 4)
            self.assertIsNotNone(payload["best_portfolio_candidate"])
            self.assertFalse(payload["promotion_readiness"]["promotable"])

            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )
            self.assertEqual(summary["epoch_id"], payload["epoch_id"])
            self.assertEqual(
                summary["false_positive_table"], payload["false_positive_table"]
            )
            self.assertEqual(
                summary["best_false_negative_table"],
                payload["best_false_negative_table"],
            )
            profitability_goal = json.loads(
                (output_dir / "profitability-search-goal.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                profitability_goal["schema_version"],
                "torghut.whitepaper-autoresearch-profitability-goal.v1",
            )
            self.assertEqual(
                profitability_goal["objective"]["target_net_pnl_per_trading_day"],
                "500",
            )
            self.assertFalse(profitability_goal["objective"]["oracle_candidate_found"])
            self.assertTrue(profitability_goal["candidate_framework"]["families"])
            self.assertTrue(profitability_goal["sleeve_plan"]["rows"])
            self.assertTrue(profitability_goal["system_change_backlog"])
            self.assertEqual(
                profitability_goal["recommended_next_epoch"]["flags"][
                    "--target-net-pnl-per-day"
                ],
                "500",
            )
            self.assertIn(
                "lowering target_net_pnl_per_day to make a candidate pass",
                profitability_goal["no_cheating_contract"]["forbidden"],
            )
            self.assertEqual(
                summary["artifacts"]["profitability_search_goal"],
                str((output_dir / "profitability-search-goal.json").resolve()),
            )
            self.assertTrue((output_dir / "hypothesis-cards.jsonl").exists())
            self.assertTrue((output_dir / "whitepaper-sources.jsonl").exists())
            self.assertTrue((output_dir / "candidate-specs.jsonl").exists())
            self.assertTrue((output_dir / "candidate-compiler-report.json").exists())
            self.assertTrue((output_dir / "candidate-selection-manifest.json").exists())
            self.assertTrue((output_dir / "pre-replay-mlx-ranker-model.json").exists())
            self.assertTrue(
                (output_dir / "pre-replay-mlx-proposal-scores.jsonl").exists()
            )
            self.assertTrue((output_dir / "mlx-snapshot-manifest.json").exists())
            self.assertTrue((output_dir / "mlx-ranker-model.json").exists())
            self.assertTrue((output_dir / "mlx-proposal-scores.jsonl").exists())
            self.assertTrue((output_dir / "candidate-evidence-bundles.jsonl").exists())
            self.assertTrue((output_dir / "portfolio-candidates.jsonl").exists())
            self.assertTrue((output_dir / "runtime-closure" / "summary.json").exists())
            self.assertTrue(
                (
                    output_dir
                    / "runtime-closure"
                    / "replay"
                    / "candidate-configmap.yaml"
                ).exists()
            )
            runtime_summary = json.loads(
                (output_dir / "runtime-closure" / "summary.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(runtime_summary["status"], "pending_runtime_parity")
            self.assertTrue(runtime_summary["candidate_configmap_path"])
            replay_plan = json.loads(
                (
                    output_dir
                    / "runtime-closure"
                    / "replay"
                    / "runtime-replay-plan.json"
                ).read_text(encoding="utf-8")
            )
            self.assertIsNotNone(replay_plan["execution_context"])
            self.assertFalse(
                replay_plan["runtime_closure_policy"]["execute_parity_replay"]
            )
            self.assertFalse(
                replay_plan["runtime_closure_policy"]["execute_approval_replay"]
            )
            snapshot_manifest = json.loads(
                (output_dir / "mlx-snapshot-manifest.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                replay_plan["dataset_snapshot_ref"], snapshot_manifest["snapshot_id"]
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["candidate_specs"],
                payload["candidate_spec_count"],
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["candidate_evidence_bundles"],
                payload["evidence_bundle_count"],
            )
            self.assertEqual(
                snapshot_manifest["row_counts"]["pre_replay_proposal_scores"],
                payload["pre_replay_proposal_score_count"],
            )
            self.assertEqual(
                snapshot_manifest["tensor_bundle_paths"][
                    "candidate_selection_manifest_json"
                ],
                str((output_dir / "candidate-selection-manifest.json").resolve()),
            )
            self.assertEqual(
                payload["artifacts"]["mlx_snapshot_manifest"],
                str((output_dir / "mlx-snapshot-manifest.json").resolve()),
            )
            self.assertTrue(
                (output_dir / "whitepaper-autoresearch-diagnostics.ipynb").exists()
            )
            model_payload = json.loads(
                (output_dir / "mlx-ranker-model.json").read_text(encoding="utf-8")
            )
            pre_replay_model_payload = json.loads(
                (output_dir / "pre-replay-mlx-ranker-model.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(pre_replay_model_payload["proposal_stage"], "pre_replay")
            self.assertEqual(
                pre_replay_model_payload["row_count"], payload["candidate_spec_count"]
            )
            self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v1")
            self.assertEqual(
                model_payload["row_count"], payload["candidate_spec_count"]
            )
            self.assertIn("rank_bucket_lift", model_payload)
            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                selection["budget"]["selected_count"],
                payload["replay_candidate_spec_count"],
            )
            self.assertEqual(
                payload["evidence_bundle_count"], payload["replay_candidate_spec_count"]
            )
            self.assertEqual(
                selection["proposal_model"]["proposal_stage"], "pre_replay"
            )
            candidate_specs = [
                json.loads(line)
                for line in (output_dir / "candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            self.assertTrue(candidate_specs)
            candidate_universes = [
                spec["strategy_overrides"]["universe_symbols"]
                for spec in candidate_specs
            ]
            self.assertTrue(
                all(
                    set(symbols) <= set(_CHIP_UNIVERSE)
                    for symbols in candidate_universes
                )
            )
            self.assertTrue(
                any(symbols != _CHIP_UNIVERSE for symbols in candidate_universes)
            )

            portfolio = payload["best_portfolio_candidate"]
            self.assertFalse(portfolio["objective_scorecard"]["target_met"])
            self.assertFalse(portfolio["objective_scorecard"]["oracle_passed"])
            self.assertFalse(payload["oracle_candidate_found"])
            self.assertIn(
                "portfolio_post_cost_net_pnl_per_day_failed",
                payload["profit_target_oracle"]["blockers"],
            )
            self.assertNotIn(
                "min_daily_net_pnl_failed",
                payload["profit_target_oracle"]["blockers"],
            )
            self.assertEqual(
                payload["profit_target_oracle_policy"]["min_daily_net_pnl"],
                "-999999999",
            )
            self.assertIn(
                "executable_replay_passed_failed",
                payload["profit_target_oracle"]["blockers"],
            )
            self.assertLess(
                float(portfolio["objective_scorecard"]["net_pnl_per_day"]), 500.0
            )
            self.assertTrue(payload["false_positive_table"])
            false_positive_reasons = {
                reason
                for row in payload["false_positive_table"]
                for reason in row["failure_reasons"]
            }
            self.assertIn("active_day_ratio_below_oracle", false_positive_reasons)
            self.assertLess(
                selection["budget"]["unique_execution_signature_count"],
                payload["candidate_spec_count"],
            )
            self.assertTrue(
                any(
                    row["selection_reason"] == "duplicate_execution_signature"
                    for row in selection["rows"]
                )
            )

    def test_candidate_universe_symbols_filter_to_live_chip_coverage(self) -> None:
        symbols = runner._candidate_universe_symbols_from_args(
            Namespace(symbols="NVDA,AAPL,MSFT,AMAT,TSM,nvda")
        )

        self.assertEqual(symbols, ("NVDA", "AAPL"))

    def test_program_research_sources_feed_whitepaper_claim_compiler(self) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.program = Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            )
            program = runner._load_epoch_program(args)
            sources = runner._program_whitepaper_sources(program)

        source_ids = {source.run_id for source in sources}
        self.assertIn("weighted_microprice_momentum_2026", source_ids)
        self.assertIn("macro_announcement_intraday_momentum_2025", source_ids)

        weighted_microprice = next(
            source
            for source in sources
            if source.run_id == "weighted_microprice_momentum_2026"
        )
        claim_types = {str(claim["claim_type"]) for claim in weighted_microprice.claims}
        self.assertIn("feature_recipe", claim_types)
        self.assertIn("validation_requirement", claim_types)
        self.assertTrue(
            runner.compile_sources_to_hypothesis_cards([weighted_microprice])
        )

    def test_runtime_closure_replay_is_disabled_when_candidate_already_failed_oracle(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.program = Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            )
            program = runner._load_epoch_program(args)

        manifest = runner.MlxSnapshotManifest(
            snapshot_id="mlx-snap-test",
            created_at="2026-05-06T00:00:00+00:00",
            source_window_start="",
            source_window_end="",
            train_days=6,
            holdout_days=3,
            full_window_days=9,
            symbols=tuple(_CHIP_UNIVERSE),
            bar_interval="PT1S",
            quote_quality_policy_id="scheduler_v3_default",
            feature_set_id="torghut.mlx-autoresearch.v1",
            cross_sectional_feature_flags={},
            prior_day_feature_flags={},
            tape_freshness_receipts=(),
            row_counts={},
            tensor_bundle_paths={},
            manifest_hash="hash",
        )
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"oracle_passed": False},
            optimizer_report={},
        )

        runtime_program = runner._runtime_closure_program_for_candidate(
            program=program,
            manifest=manifest,
            portfolio=portfolio,
            oracle_candidate_found=False,
        )

        self.assertFalse(runtime_program.runtime_closure_policy.execute_parity_replay)
        self.assertFalse(runtime_program.runtime_closure_policy.execute_approval_replay)

    def test_runtime_closure_replay_stays_enabled_for_proof_only_oracle_failure(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.program = Path(
                "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
            )
            args.replay_mode = "real"
            program = runner._load_epoch_program(args)

        manifest = runner.MlxSnapshotManifest(
            snapshot_id="mlx-snap-test",
            created_at="2026-05-06T00:00:00+00:00",
            source_window_start="2026-03-20",
            source_window_end="2026-04-09",
            train_days=6,
            holdout_days=3,
            full_window_days=9,
            symbols=tuple(_CHIP_UNIVERSE),
            bar_interval="PT1S",
            quote_quality_policy_id="scheduler_v3_default",
            feature_set_id="torghut.mlx-autoresearch.v1",
            cross_sectional_feature_flags={},
            prior_day_feature_flags={},
            tape_freshness_receipts=(),
            row_counts={},
            tensor_bundle_paths={},
            manifest_hash="hash",
        )
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={
                "target_met": True,
                "oracle_passed": False,
                "profit_target_oracle": {
                    "passed": False,
                    "blockers": [
                        "shadow_parity_status_failed",
                        "executable_replay_passed_failed",
                        "executable_replay_artifact_present_failed",
                    ],
                },
            },
            optimizer_report={},
        )

        runtime_program = runner._runtime_closure_program_for_candidate(
            program=program,
            manifest=manifest,
            portfolio=portfolio,
            oracle_candidate_found=False,
        )

        self.assertTrue(runtime_program.runtime_closure_policy.execute_parity_replay)
        self.assertTrue(runtime_program.runtime_closure_policy.execute_approval_replay)

    def test_runtime_closure_proof_updates_portfolio_oracle_from_real_artifacts(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            run_root = Path(tmpdir)
            runtime_root = run_root / "runtime-closure"
            replay_dir = runtime_root / "replay"
            gates_dir = runtime_root / "gates"
            promotion_dir = runtime_root / "promotion"
            replay_dir.mkdir(parents=True)
            gates_dir.mkdir(parents=True)
            promotion_dir.mkdir(parents=True)
            parity_replay_path = replay_dir / "scheduler-v3-parity-replay.json"
            approval_replay_path = replay_dir / "scheduler-v3-approval-replay.json"
            parity_report_path = replay_dir / "scheduler-v3-parity-report.json"
            approval_report_path = replay_dir / "scheduler-v3-approval-report.json"
            shadow_path = replay_dir / "shadow-validation-plan.json"
            replay_plan_path = replay_dir / "runtime-replay-plan.json"
            gate_path = gates_dir / "gate-evaluation.json"
            proof_path = promotion_dir / "portfolio-proof-receipt.json"
            summary_path = runtime_root / "summary.json"
            for artifact_path in (
                parity_replay_path,
                approval_replay_path,
                gate_path,
                proof_path,
                summary_path,
            ):
                artifact_path.write_text("{}\n", encoding="utf-8")
            parity_report_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "summary": {"filled_count": 3, "decision_count": 4},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            approval_report_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "summary": {"filled_count": 2, "decision_count": 3},
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            shadow_path.write_text(
                json.dumps(
                    {
                        "schema_version": "torghut.runtime-closure-shadow-validation-plan.v1",
                        "status": "within_budget",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            replay_plan_path.write_text(
                json.dumps({"execution_context": {"start_equity": "31590.02"}}) + "\n",
                encoding="utf-8",
            )
            policy = runner.ProfitTargetOraclePolicy()
            scorecard: dict[str, object] = {
                "net_pnl_per_day": "620",
                "portfolio_post_cost_net_pnl_per_day": "620",
                "target_met": True,
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "daily_net": {"2026-03-20": "620", "2026-03-21": "620"},
                "trading_day_count": 2,
                "best_day_share": "0.25",
                "max_single_day_contribution_share": "0.25",
                "max_cluster_contribution_share": "0.30",
                "max_single_symbol_contribution_share": "0.30",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "avg_filled_notional_per_day": "300000",
                "regime_slice_pass_rate": "0.60",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "missing",
                "executable_replay_passed": False,
                "executable_replay_artifact_ref": "",
                "executable_replay_order_count": 0,
                "executable_replay_account_buying_power": "0",
                "executable_replay_max_notional_per_trade": "0",
            }
            scorecard["profit_target_oracle"] = runner.evaluate_profit_target_oracle(
                scorecard,
                target_net_pnl_per_day=Decimal("500"),
                policy=policy,
            )
            scorecard["oracle_passed"] = False
            portfolio = runner.PortfolioCandidateSpec(
                schema_version="torghut.portfolio-candidate-spec.v1",
                portfolio_candidate_id="portfolio-test",
                source_candidate_ids=("candidate-test",),
                target_net_pnl_per_day=Decimal("500"),
                sleeves=(
                    {
                        "candidate_id": "candidate-test",
                        "candidate_spec_id": "spec-test",
                        "runtime_family": "breakout_continuation_consistent",
                        "runtime_strategy_name": "breakout-sleeve-1",
                        "weight": "0.5",
                    },
                ),
                capital_budget={},
                correlation_budget={},
                drawdown_budget={},
                evidence_refs=(),
                objective_scorecard=scorecard,
                optimizer_report={},
            )

            updated = runner._portfolio_with_runtime_closure_proof(
                portfolio=portfolio,
                runtime_closure={
                    "status": "ready_for_promotion_review",
                    "root": str(runtime_root),
                    "gate_report_path": str(gate_path),
                    "parity_replay_path": str(parity_replay_path),
                    "parity_report_path": str(parity_report_path),
                    "approval_replay_path": str(approval_replay_path),
                    "approval_report_path": str(approval_report_path),
                    "shadow_validation_path": str(shadow_path),
                    "portfolio_proof_receipt_path": str(proof_path),
                    "replay_plan_path": str(replay_plan_path),
                },
                target=Decimal("500"),
                oracle_policy=policy,
            )

        self.assertTrue(updated.objective_scorecard["oracle_passed"])
        self.assertTrue(updated.objective_scorecard["executable_replay_passed"])
        self.assertEqual(
            updated.objective_scorecard["shadow_parity_status"], "within_budget"
        )
        self.assertEqual(
            updated.objective_scorecard["executable_replay_order_count"], 2
        )
        self.assertEqual(
            updated.objective_scorecard["executable_replay_artifact_ref"],
            str(approval_replay_path),
        )
        self.assertIn(str(approval_replay_path), updated.evidence_refs)

    def test_runtime_closure_proof_helpers_stay_fail_closed_on_edge_inputs(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            invalid_json_path = Path(tmpdir) / "invalid.json"
            invalid_json_path.write_text("{", encoding="utf-8")
            args = self._args(Path(tmpdir) / "epoch")
            program = runner._load_epoch_program(args)

        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(
                {"candidate_id": "candidate-test", "max_notional_per_trade": "123"},
                {"candidate_id": "candidate-two", "weight": "-1"},
            ),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"target_met": True, "oracle_passed": True},
            optimizer_report={},
        )
        manifest = runner.MlxSnapshotManifest(
            snapshot_id="mlx-snap-test",
            created_at="2026-05-06T00:00:00+00:00",
            source_window_start="2026-03-20",
            source_window_end="2026-04-09",
            train_days=6,
            holdout_days=3,
            full_window_days=9,
            symbols=tuple(_CHIP_UNIVERSE),
            bar_interval="PT1S",
            quote_quality_policy_id="scheduler_v3_default",
            feature_set_id="torghut.mlx-autoresearch.v1",
            cross_sectional_feature_flags={},
            prior_day_feature_flags={},
            tape_freshness_receipts=(),
            row_counts={},
            tensor_bundle_paths={},
            manifest_hash="hash",
        )

        self.assertEqual(runner._oracle_blockers({}), frozenset())
        self.assertEqual(runner._load_json_mapping_artifact(invalid_json_path), {})
        self.assertEqual(
            runner._runtime_report_summary_int(
                {"summary": {"filled_count": "bad"}}, "filled_count", default=7
            ),
            7,
        )
        self.assertEqual(
            runner._portfolio_executable_max_notional(portfolio), Decimal("50000")
        )
        self.assertFalse(runner._portfolio_needs_runtime_closure_proof(portfolio))
        self.assertIs(
            runner._runtime_closure_program_for_candidate(
                program=program,
                manifest=manifest,
                portfolio=None,
                oracle_candidate_found=False,
            ),
            program,
        )

    def test_candidate_universe_symbols_default_to_chip_coverage_when_empty(
        self,
    ) -> None:
        symbols = runner._candidate_universe_symbols_from_args(
            Namespace(symbols="MSFT,SHOP")
        )

        self.assertEqual(symbols, tuple(_CHIP_UNIVERSE))

    def test_full_chip_universe_is_compile_allowlist_not_profile_override(
        self,
    ) -> None:
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
                Namespace(symbols=",".join(_CHIP_UNIVERSE))
            ),
            (),
        )
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
                Namespace(symbols="MSFT,SHOP")
            ),
            (),
        )
        self.assertEqual(
            runner._candidate_universe_symbols_for_compilation(
                Namespace(symbols="NVDA,AMAT,AAPL")
            ),
            ("NVDA", "AAPL"),
        )

    def test_rejects_candidate_universe_larger_than_twelve_symbols(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.symbols = "A,B,C,D,E,F,G,H,I,J,K,L,M"

            payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "invalid_universe")
        self.assertEqual(payload["failure_reason"], "candidate_universe_too_large:13")
        self.assertFalse((output_dir / "candidate-specs.jsonl").exists())

    def test_seed_recent_whitepapers_honors_top_k_and_exploration_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 1
            args.exploration_slots = 1
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            proposal_rows = [
                json.loads(line)
                for line in (output_dir / "mlx-proposal-scores.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            pre_replay_rows = [
                json.loads(line)
                for line in (output_dir / "pre-replay-mlx-proposal-scores.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(
            payload["profit_target_oracle_policy"]["min_daily_net_pnl"], "-999999999"
        )
        self.assertEqual(selection["budget"]["exploration_slots_requested"], 1)
        self.assertGreaterEqual(selection["budget"]["exploration_slots_effective"], 1)
        self.assertEqual(selection["budget"]["selected_count"], 3)
        self.assertEqual(payload["replay_candidate_spec_count"], 3)
        self.assertEqual(payload["evidence_bundle_count"], 3)
        self.assertGreater(payload["candidate_spec_count"], args.max_candidates)
        self.assertEqual(
            selection["budget"]["compiled_candidate_count"],
            payload["candidate_spec_count"],
        )
        self.assertTrue(payload["best_false_negative_table"])
        self.assertEqual(
            payload["best_false_negative_table"][0]["evidence_status"], "not_replayed"
        )
        self.assertFalse(payload["best_false_negative_table"][0]["selected_for_replay"])
        selected_rows = [row for row in selection["rows"] if row["selected_for_replay"]]
        self.assertGreater(selection["budget"]["capital_feasible_candidate_count"], 0)
        self.assertTrue(
            all(row["capital_budget"]["capital_feasible"] for row in selected_rows)
        )
        self.assertEqual(
            {row["selection_reason"] for row in selected_rows},
            {"exploitation", "exploration", "budget_backfill"},
        )
        proposal_selected = [row for row in proposal_rows if row["selected_for_replay"]]
        self.assertEqual(len(proposal_selected), 3)
        self.assertEqual(
            {row["replay_selection_reason"] for row in proposal_selected},
            {"exploitation", "exploration", "budget_backfill"},
        )
        self.assertEqual(len(pre_replay_rows), payload["candidate_spec_count"])
        self.assertEqual(
            {row["selection_reason"] for row in pre_replay_rows},
            {"pre_replay_mlx_rank"},
        )

    def test_best_false_negative_table_excludes_pre_replay_blocked_specs(self) -> None:
        table = runner._best_false_negative_table(
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-feedback-blocked",
                        "rank": 1,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_feedback_blocked",
                    },
                    {
                        "candidate_spec_id": "spec-capital-blocked",
                        "rank": 2,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_capital_budget_blocked",
                    },
                    {
                        "candidate_spec_id": "spec-negative-prior",
                        "rank": 3,
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_synthetic_nonpositive_expected_value",
                    },
                    {
                        "candidate_spec_id": "spec-duplicate",
                        "rank": 4,
                        "selected_for_replay": False,
                        "selection_reason": "duplicate_execution_signature",
                    },
                    {
                        "candidate_spec_id": "spec-clean-budget-miss",
                        "rank": 5,
                        "selected_for_replay": False,
                        "selection_reason": "not_selected_budget",
                    },
                ]
            },
            pre_replay_proposal_rows=[
                {
                    "candidate_spec_id": "spec-clean-budget-miss",
                    "proposal_score": 25,
                }
            ],
            evidence_bundles=(),
        )

        self.assertEqual(len(table), 1)
        self.assertEqual(table[0]["candidate_spec_id"], "spec-clean-budget-miss")
        self.assertEqual(table[0]["reason"], "not_replayed_budget")

    def test_seed_recent_whitepapers_diversifies_exploitation_slots(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 3
            args.exploration_slots = 0
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        exploitation_rows = [
            row
            for row in selection["rows"]
            if row["selected_for_replay"] and row["selection_reason"] == "exploitation"
        ]
        replay_rows = sorted(
            [row for row in selection["rows"] if row["selected_for_replay"]],
            key=lambda row: row["replay_order"],
        )
        self.assertEqual(len(exploitation_rows), 3)
        self.assertGreater(
            len({row["family_template_id"] for row in exploitation_rows}),
            1,
        )
        self.assertEqual(
            selection["selected_candidate_spec_ids"],
            [row["candidate_spec_id"] for row in replay_rows],
        )
        self.assertEqual([row["replay_order"] for row in replay_rows], [1, 2, 3])
        self.assertGreater(
            len({row["family_template_id"] for row in replay_rows[:2]}),
            1,
        )

    def test_seed_recent_whitepapers_dedupes_execution_signatures(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._source_jsonl_args(output_dir, source_count=2)
            args.top_k = 6
            args.exploration_slots = 4
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        selected_rows = [row for row in selection["rows"] if row["selected_for_replay"]]
        duplicate_rows = [
            row
            for row in selection["rows"]
            if row["selection_reason"] == "duplicate_execution_signature"
        ]
        self.assertEqual(
            len({row["execution_signature"] for row in selected_rows}),
            len(selected_rows),
        )
        self.assertGreater(len(duplicate_rows), 0)
        self.assertGreaterEqual(
            selection["budget"]["unique_execution_signature_count"],
            len(selected_rows),
        )
        self.assertLessEqual(len(selected_rows), args.max_candidates)
        self.assertEqual(payload["replay_candidate_spec_count"], len(selected_rows))

    def test_main_returns_nonzero_when_no_oracle_candidate_found(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch.object(
                runner,
                "_parse_args",
                return_value=Namespace(
                    **{
                        **vars(self._args(Path(tmpdir) / "epoch")),
                        "target_net_pnl_per_day": "999999",
                    }
                ),
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()
            output_dir = Path(tmpdir) / "epoch"
            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )
            remediation = json.loads(
                (output_dir / "candidate-search-remediation.json").read_text(
                    encoding="utf-8"
                )
            )
            portfolio_report_exists = (
                output_dir / "portfolio-optimizer-report.json"
            ).exists()

        self.assertEqual(exit_code, 2)
        self.assertEqual(summary["status"], "no_profit_target_candidate")
        self.assertEqual(
            summary["status_reason"], "portfolio_candidate_failed_profit_target_oracle"
        )
        self.assertFalse(summary["oracle_candidate_found"])
        self.assertIn(
            "portfolio_post_cost_net_pnl_per_day_failed",
            summary["profit_target_oracle"]["blockers"],
        )
        self.assertEqual(
            remediation["schema_version"],
            "torghut.whitepaper-autoresearch-remediation.v1",
        )
        self.assertTrue(remediation["next_actions"])
        self.assertIn("candidate_search_remediation", summary["artifacts"])
        self.assertIn("profitability_search_goal", summary["artifacts"])
        self.assertEqual(
            summary["profitability_search_goal"]["objective"][
                "target_net_pnl_per_trading_day"
            ],
            "999999",
        )
        self.assertTrue(portfolio_report_exists)

    def test_seed_recent_whitepapers_persists_epoch_ledgers(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            args = self._args(Path(tmpdir) / "epoch")
            args.persist_results = True
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            with Session(self.engine) as session:
                epoch = session.execute(select(AutoresearchEpoch)).scalar_one()
                specs = (
                    session.execute(select(AutoresearchCandidateSpec)).scalars().all()
                )
                proposals = (
                    session.execute(select(AutoresearchProposalScore)).scalars().all()
                )
                portfolios = (
                    session.execute(select(AutoresearchPortfolioCandidate))
                    .scalars()
                    .all()
                )

        self.assertEqual(epoch.epoch_id, payload["epoch_id"])
        self.assertEqual(epoch.status, "no_profit_target_candidate")
        self.assertEqual(len(specs), payload["candidate_spec_count"])
        self.assertEqual(len(proposals), payload["proposal_score_count"])
        self.assertEqual(len(portfolios), 1)
        self.assertEqual(portfolios[0].status, "blocked")
        self.assertEqual(
            epoch.summary_json["candidate_evidence_bundle_payload_count"],
            len(epoch.summary_json["candidate_evidence_bundle_payloads"]),
        )

    def test_epoch_ledgers_allow_repeated_candidate_specs_across_epochs(
        self,
    ) -> None:
        candidate_spec = runner.CandidateSpec(
            schema_version="torghut.candidate-spec.v1",
            candidate_spec_id="spec-repeatable",
            hypothesis_id="hyp-repeatable",
            family_template_id="microbar_cross_sectional_pairs_v1",
            candidate_kind="sleeve",
            runtime_family="microbar_cross_sectional_pairs_v1",
            runtime_strategy_name="microbar_cross_sectional_pairs",
            feature_contract={"mechanism": "repeatable deterministic spec"},
            parameter_space={},
            strategy_overrides={},
            objective={"target_net_pnl_per_day": "300"},
            hard_vetoes={},
            expected_failure_modes=(),
            promotion_contract={},
        )
        started_at = datetime(2026, 5, 8, 17, 0, 0)
        completed_at = datetime(2026, 5, 8, 17, 1, 0)

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            for epoch_id in ("epoch-repeat-1", "epoch-repeat-2"):
                runner._persist_epoch_ledgers(
                    epoch_id=epoch_id,
                    status="no_profit_target_candidate",
                    target_net_pnl_per_day=Decimal("300"),
                    paper_run_ids=[],
                    sources=[],
                    candidate_specs=[candidate_spec],
                    proposal_rows=[],
                    portfolio=None,
                    summary={},
                    runner_config={},
                    started_at=started_at,
                    completed_at=completed_at,
                )

        with Session(self.engine) as session:
            specs = (
                session.execute(
                    select(AutoresearchCandidateSpec).order_by(
                        AutoresearchCandidateSpec.epoch_id.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(
            [spec.epoch_id for spec in specs],
            ["epoch-repeat-1", "epoch-repeat-2"],
        )
        self.assertEqual(
            {spec.candidate_spec_id for spec in specs}, {"spec-repeatable"}
        )

    def test_persistence_failure_preserves_artifacts_and_returns_infra_failure(
        self,
    ) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=RuntimeError("db offline"),
            ),
        ):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.persist_results = True
            payload = runner.run_whitepaper_autoresearch_profit_target(args)
            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )
            persistence_error = json.loads(
                (output_dir / "persistence-error-summary.json").read_text(
                    encoding="utf-8"
                )
            )
            evidence_artifact_exists = (
                output_dir / "candidate-evidence-bundles.jsonl"
            ).exists()
            portfolio_artifact_exists = (
                output_dir / "portfolio-candidates.jsonl"
            ).exists()
            notebook_exists = (
                output_dir / "whitepaper-autoresearch-diagnostics.ipynb"
            ).exists()

        self.assertEqual(payload["status"], "persistence_failed")
        self.assertEqual(
            payload["pre_persistence_status"], "no_profit_target_candidate"
        )
        self.assertEqual(payload["persistence_status"], "failed")
        self.assertIn("db offline", payload["persistence_error"])
        self.assertEqual(summary["status"], "persistence_failed")
        self.assertEqual(persistence_error["epoch_id"], payload["epoch_id"])
        self.assertTrue(evidence_artifact_exists)
        self.assertTrue(portfolio_artifact_exists)
        self.assertTrue(notebook_exists)

    def test_main_returns_infra_failure_when_persistence_fails(self) -> None:
        with (
            patch.object(runner, "_parse_args", return_value=Namespace()),
            patch.object(
                runner,
                "run_whitepaper_autoresearch_profit_target",
                return_value={"status": "persistence_failed"},
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 1)

    def test_train_ranker_script_helper_reads_runner_artifacts(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            payload = runner.run_whitepaper_autoresearch_profit_target(
                self._source_jsonl_args(output_dir)
            )

            model_payload, scores = ranker_trainer.train_from_artifacts(
                candidate_specs_path=output_dir / "candidate-specs.jsonl",
                evidence_bundles_path=output_dir / "candidate-evidence-bundles.jsonl",
                backend_preference="numpy-fallback",
            )

        self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v1")
        self.assertEqual(model_payload["backend"], "numpy-fallback")
        self.assertIn("rank_bucket_lift", model_payload)
        self.assertIn(model_payload["model_status"], {"active", "demoted_to_heuristic"})
        self.assertEqual(len(scores), payload["candidate_spec_count"])
        self.assertEqual(scores[0]["rank"], 1)
        self.assertIn(
            scores[0]["selection_reason"],
            {"exploitation", "heuristic_negative_lift_fallback"},
        )

    def test_replay_failures_write_error_summary_and_exit_code_three(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch.object(
                runner,
                "_parse_args",
                return_value=Namespace(
                    **{
                        **vars(self._source_jsonl_args(Path(tmpdir) / "epoch")),
                        "replay_mode": "real",
                    }
                ),
            ),
            patch.object(
                runner,
                "_run_real_replay",
                side_effect=RuntimeError("forced replay failure"),
            ),
            patch.object(
                runner,
                "_collect_partial_real_replay",
                return_value=runner.EpochReplayResult(
                    evidence_bundles=(
                        runner.evidence_bundle_from_frontier_candidate(
                            candidate_spec_id="spec-partial",
                            candidate={
                                "candidate_id": "cand-partial",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "-1",
                                    "active_day_ratio": "0.4",
                                    "positive_day_ratio": "0.2",
                                },
                            },
                            dataset_snapshot_id="snap-partial",
                            result_path="/tmp/partial-result.json",
                        ),
                    ),
                    replay_results=({"status": "partial_replay_artifacts_collected"},),
                ),
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()
            partial_artifact_exists = (
                Path(tmpdir) / "epoch" / "candidate-evidence-bundles.partial.jsonl"
            ).exists()
            remediation_path = (
                Path(tmpdir) / "epoch" / "candidate-search-remediation.json"
            )
            remediation_exists = remediation_path.exists()
            remediation = json.loads(remediation_path.read_text(encoding="utf-8"))
            notebook_exists = (
                Path(tmpdir) / "epoch" / "whitepaper-autoresearch-diagnostics.ipynb"
            ).exists()
            summary = json.loads(
                (Path(tmpdir) / "epoch" / "error-summary.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(exit_code, 3)
        self.assertEqual(summary["status"], "replay_failed")
        self.assertEqual(summary["partial_evidence_bundle_count"], 1)
        self.assertTrue(partial_artifact_exists)
        self.assertTrue(remediation_exists)
        self.assertTrue(notebook_exists)
        self.assertGreater(remediation["selected_missing_evidence_count"], 0)
        self.assertTrue(
            any(
                row.get("evidence_status") == "missing"
                for row in summary["false_positive_table"]
            )
        )
        self.assertEqual(
            remediation["schema_version"],
            "torghut.whitepaper-autoresearch-remediation.v1",
        )
        self.assertTrue(remediation["next_actions"])
        self.assertIn("candidate_search_remediation", summary)

    def test_timeout_remediation_recommends_smaller_replay_frontier(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="TimeoutError:real_replay_timeout_seconds:3600",
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-selected",
                        "selected_for_replay": True,
                    }
                ]
            },
            evidence_bundles=(),
            false_positive_table=(),
            best_false_negative_table=(),
            replay_timeout_seconds=3600,
            max_frontier_candidates_per_spec=8,
        )

        timeout_action = remediation["next_actions"][0]
        self.assertEqual(
            timeout_action["action"], "shrink_per_spec_frontier_or_extend_timeout"
        )
        self.assertEqual(
            timeout_action["recommended_flags"]["--max-frontier-candidates-per-spec"],
            "2",
        )
        self.assertEqual(
            timeout_action["recommended_flags"]["--real-replay-timeout-seconds"],
            "7200",
        )

    def test_remediation_prioritizes_missing_promotion_proof(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {"compiled_candidate_count": "not-an-int"},
                "rows": [
                    {
                        "candidate_spec_id": "spec-selected",
                        "selected_for_replay": True,
                    }
                ],
            },
            evidence_bundles=(),
            false_positive_table=(
                {
                    "candidate_spec_id": "spec-selected",
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "shadow_parity_status_not_within_budget",
                        "executable_replay_not_passed",
                        "executable_replay_artifact_missing",
                        "executable_replay_account_buying_power_missing",
                        "executable_replay_max_notional_missing",
                    ],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
        )

        proof_action = remediation["next_actions"][0]
        self.assertEqual(
            proof_action["action"],
            "complete_executable_replay_and_shadow_parity_evidence",
        )
        self.assertEqual(
            proof_action["blocking_failure_counts"]["executable_replay_not_passed"],
            1,
        )
        self.assertIn(
            "executable_replay_artifact_ref",
            proof_action["required_scorecard_fields"],
        )

    def test_remediation_defers_promotion_proof_until_profit_gates_pass(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_candidate_failed_profit_target_oracle",
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-selected",
                        "selected_for_replay": True,
                    }
                ]
            },
            evidence_bundles=(),
            false_positive_table=(
                {
                    "candidate_spec_id": "spec-selected",
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "positive_day_ratio_below_oracle",
                        "max_drawdown_above_oracle",
                        "shadow_parity_status_not_within_budget",
                        "executable_replay_not_passed",
                    ],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
            current_top_k=24,
            current_exploration_slots=16,
            current_portfolio_size_min=3,
            current_max_candidates=96,
            current_max_total_frontier_candidates=48,
        )

        self.assertEqual(
            remediation["next_actions"][0]["action"],
            "increase_breadth_and_portfolio_diversity",
        )
        proof_action = next(
            action
            for action in remediation["next_actions"]
            if action["action"]
            == "complete_executable_replay_and_shadow_parity_evidence"
        )
        self.assertEqual(
            proof_action["deferred_until"],
            "portfolio_profit_and_risk_oracle_failures_clear",
        )
        self.assertEqual(
            proof_action["blocked_by_non_proof_failure_counts"][
                "positive_day_ratio_below_oracle"
            ],
            1,
        )
        self.assertEqual(proof_action["priority"], 7)

    def test_remediation_increases_breadth_from_current_epoch(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": "spec-selected",
                        "selected_for_replay": True,
                    }
                ]
            },
            evidence_bundles=(),
            false_positive_table=(
                {
                    "candidate_spec_id": "spec-selected",
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "active_day_ratio_below_oracle",
                        "positive_day_ratio_below_oracle",
                    ],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
            current_top_k=16,
            current_exploration_slots=8,
            current_portfolio_size_min=2,
            current_max_candidates=64,
            current_max_total_frontier_candidates=24,
        )

        breadth_action = remediation["next_actions"][0]
        self.assertEqual(
            breadth_action["action"], "increase_breadth_and_portfolio_diversity"
        )
        self.assertEqual(breadth_action["recommended_flags"]["--top-k"], "24")
        self.assertEqual(
            breadth_action["recommended_flags"]["--exploration-slots"], "16"
        )
        self.assertEqual(breadth_action["recommended_flags"]["--max-candidates"], "96")
        self.assertEqual(
            breadth_action["recommended_flags"]["--max-total-frontier-candidates"],
            "48",
        )
        self.assertEqual(
            breadth_action["recommended_flags"]["--portfolio-size-min"], "3"
        )

    def test_remediation_recommends_profile_surface_when_selection_budget_exhausted(
        self,
    ) -> None:
        selected_rows = [
            {
                "candidate_spec_id": f"spec-selected-{index}",
                "family_template_id": family_template_id,
                "selected_for_replay": True,
            }
            for index, family_template_id in enumerate(
                (
                    "breakout_reclaim_v2",
                    "intraday_tsmom_v2",
                    "mean_reversion_rebound_v1",
                    "microbar_cross_sectional_pairs_v1",
                    "microstructure_continuation_matched_filter_v1",
                )
                * 3,
                start=1,
            )
        ]
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {
                    "compiled_candidate_count": 54,
                    "unique_execution_signature_count": 15,
                    "selected_count": 15,
                    "max_candidates": 1032,
                    "top_k": 520,
                    "exploration_slots_effective": 512,
                },
                "rows": selected_rows,
            },
            evidence_bundles=(),
            false_positive_table=tuple(
                {
                    "candidate_spec_id": row["candidate_spec_id"],
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "active_day_ratio_below_oracle",
                        "positive_day_ratio_below_oracle",
                    ],
                }
                for row in selected_rows
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
            current_top_k=520,
            current_exploration_slots=512,
            current_portfolio_size_min=3,
            current_max_candidates=1032,
            current_max_total_frontier_candidates=128,
        )

        self.assertTrue(remediation["candidate_surface_exhausted"])
        surface_action = remediation["next_actions"][0]
        self.assertEqual(surface_action["action"], "expand_execution_profile_surface")
        self.assertEqual(
            surface_action["observed_selection_budget"][
                "unique_execution_signature_count"
            ],
            15,
        )
        self.assertEqual(
            surface_action["target_family_template_ids"],
            [
                "breakout_reclaim_v2",
                "intraday_tsmom_v2",
                "mean_reversion_rebound_v1",
                "microbar_cross_sectional_pairs_v1",
                "microstructure_continuation_matched_filter_v1",
            ],
        )
        self.assertNotIn("recommended_flags", surface_action)
        self.assertFalse(
            [
                action
                for action in remediation["next_actions"]
                if action["action"] == "increase_breadth_and_portfolio_diversity"
            ]
        )

    def test_remediation_recommends_surface_mutation_when_only_eligible_specs_replayed(
        self,
    ) -> None:
        selected_rows = [
            {
                "candidate_spec_id": "spec-eligible",
                "family_template_id": "end_of_day_reversal_v1",
                "selected_for_replay": True,
            }
        ]
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {
                    "compiled_candidate_count": 2250,
                    "unique_execution_signature_count": 375,
                    "eligible_candidate_count": 1,
                    "selected_count": 1,
                    "pre_replay_feedback_blocked_candidate_count": 179,
                    "pre_replay_nonpositive_synthetic_candidate_count": 185,
                    "pre_replay_blocked_candidate_count": 364,
                    "max_candidates": 264,
                    "top_k": 136,
                    "exploration_slots_effective": 128,
                },
                "rows": selected_rows,
            },
            evidence_bundles=(),
            false_positive_table=(
                {
                    "candidate_spec_id": "spec-eligible",
                    "evidence_status": "replayed",
                    "failure_reasons": [
                        "active_day_ratio_below_oracle",
                        "positive_day_ratio_below_oracle",
                        "non_positive_net_pnl_per_day",
                    ],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
            current_top_k=136,
            current_exploration_slots=128,
            current_portfolio_size_min=3,
            current_max_candidates=264,
            current_max_total_frontier_candidates=128,
        )

        self.assertFalse(remediation["candidate_surface_exhausted"])
        self.assertTrue(remediation["replayable_candidate_surface_exhausted"])
        surface_action = remediation["next_actions"][0]
        self.assertEqual(surface_action["action"], "expand_execution_profile_surface")
        self.assertIn("currently eligible", surface_action["reason"])
        self.assertEqual(
            surface_action["target_family_template_ids"], ["end_of_day_reversal_v1"]
        )
        self.assertFalse(
            [
                action
                for action in remediation["next_actions"]
                if action["action"] == "increase_breadth_and_portfolio_diversity"
            ]
        )

    def test_remediation_recommends_surface_mutation_when_mlx_blocks_synthetic_prior(
        self,
    ) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {
                    "compiled_candidate_count": 12,
                    "unique_execution_signature_count": 12,
                    "eligible_candidate_count": 0,
                    "selected_count": 0,
                    "pre_replay_nonpositive_synthetic_candidate_count": 12,
                    "pre_replay_blocked_candidate_count": 12,
                    "max_candidates": 12,
                    "top_k": 8,
                    "exploration_slots_effective": 4,
                },
                "rows": [
                    {
                        "candidate_spec_id": "spec-negative-prior",
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_synthetic_nonpositive_expected_value",
                    }
                ],
            },
            evidence_bundles=(),
            false_positive_table=(),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
        )

        self.assertEqual(
            remediation["next_actions"][0]["action"],
            "expand_or_mutate_strategy_surface_after_negative_mlx_prior",
        )
        self.assertEqual(
            remediation["next_actions"][0]["observed_selection_budget"][
                "pre_replay_nonpositive_synthetic_candidate_count"
            ],
            12,
        )

    def test_remediation_recommends_surface_mutation_when_feedback_blocks_all_candidates(
        self,
    ) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="portfolio_optimizer_produced_no_candidate",
            candidate_selection={
                "budget": {
                    "compiled_candidate_count": 8,
                    "unique_execution_signature_count": 8,
                    "eligible_candidate_count": 0,
                    "selected_count": 0,
                    "pre_replay_feedback_blocked_candidate_count": 8,
                    "pre_replay_blocked_candidate_count": 8,
                    "max_candidates": 8,
                    "top_k": 4,
                    "exploration_slots_effective": 4,
                },
                "rows": [
                    {
                        "candidate_spec_id": "spec-feedback-blocked",
                        "selected_for_replay": False,
                        "selection_reason": "pre_replay_mlx_feedback_blocked",
                    }
                ],
            },
            evidence_bundles=(),
            false_positive_table=(),
            best_false_negative_table=(),
            replay_timeout_seconds=7200,
            max_frontier_candidates_per_spec=2,
        )

        self.assertEqual(
            remediation["next_actions"][0]["action"],
            "expand_or_mutate_strategy_surface_after_feedback_blocks_all_candidates",
        )
        self.assertEqual(
            remediation["next_actions"][0]["observed_selection_budget"][
                "pre_replay_feedback_blocked_candidate_count"
            ],
            8,
        )

    def test_next_epoch_plan_rejects_breadth_shrinking_remediation_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.max_candidates = 64
            args.top_k = 16
            args.exploration_slots = 8
            args.portfolio_size_min = 2
            args.replay_mode = "real"
            remediation = {
                "next_actions": [
                    {
                        "action": "increase_breadth_and_portfolio_diversity",
                        "recommended_flags": {
                            "--top-k": "11",
                            "--exploration-slots": "4",
                            "--portfolio-size-min": "3",
                        },
                    }
                ]
            }

            plan = runner._profitability_next_epoch_plan(
                args=args, target=Decimal("500"), remediation=remediation
            )

        self.assertEqual(plan["flags"]["--target-net-pnl-per-day"], "500")
        self.assertEqual(plan["flags"]["--replay-mode"], "real")
        self.assertEqual(plan["flags"]["--max-candidates"], "64")
        self.assertEqual(plan["flags"]["--top-k"], "16")
        self.assertEqual(plan["flags"]["--exploration-slots"], "8")
        self.assertEqual(plan["flags"]["--portfolio-size-min"], "3")
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--top-k",
                "current_value": "16",
                "recommended_value": "11",
                "reason": "rejected_to_preserve_or_increase_search_breadth",
            },
            plan["rejected_recommended_flags"],
        )
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--exploration-slots",
                "current_value": "8",
                "recommended_value": "4",
                "reason": "rejected_to_preserve_or_increase_search_breadth",
            },
            plan["rejected_recommended_flags"],
        )
        self.assertIn(
            "timeout remediation may reduce --max-frontier-candidates-per-spec only to finish complete evidence",
            plan["no_fast_path_policy"]["allowed_decreases"],
        )

    def test_next_epoch_plan_allows_timeout_frontier_shrink_only(self) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.max_frontier_candidates_per_spec = 8
            remediation = {
                "next_actions": [
                    {
                        "action": "shrink_per_spec_frontier_or_extend_timeout",
                        "recommended_flags": {
                            "--max-frontier-candidates-per-spec": "2",
                            "--real-replay-timeout-seconds": "7200",
                        },
                    }
                ]
            }

            plan = runner._profitability_next_epoch_plan(
                args=args, target=Decimal("500"), remediation=remediation
            )

        self.assertEqual(plan["flags"]["--max-frontier-candidates-per-spec"], "2")
        self.assertEqual(plan["flags"]["--real-replay-timeout-seconds"], "7200")
        self.assertFalse(plan["rejected_recommended_flags"])

    def test_next_epoch_plan_preserves_runtime_flags_and_rejects_invalid_numbers(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.max_candidates = "not-a-number"
            args.max_total_frontier_candidates = 24
            args.real_replay_timeout_seconds = 7200
            args.real_replay_shard_size = 2
            args.real_replay_shard_timeout_seconds = 900
            args.real_replay_shard_workers = 3
            args.real_replay_failed_spec_retries = 2
            args.real_replay_retry_timeout_seconds = 1800
            args.real_replay_retry_max_frontier_candidates_per_spec = 3
            args.shadow_validation_artifact = Path("/tmp/shadow-validation.json")
            remediation = {
                "next_actions": [
                    {
                        "action": "increase_breadth_and_portfolio_diversity",
                        "recommended_flags": {
                            "--top-k": "not-a-number",
                            "--max-total-frontier-candidates": "48",
                        },
                    }
                ]
            }

            plan = runner._profitability_next_epoch_plan(
                args=args, target=Decimal("500"), remediation=remediation
            )
            flags = runner._profitability_next_epoch_flags(
                args=args, target=Decimal("500"), remediation=remediation
            )

        self.assertEqual(flags, plan["flags"])
        self.assertEqual(plan["flags"]["--max-candidates"], "64")
        self.assertEqual(plan["flags"]["--top-k"], "16")
        self.assertEqual(plan["flags"]["--max-total-frontier-candidates"], "48")
        self.assertEqual(plan["flags"]["--real-replay-timeout-seconds"], "7200")
        self.assertEqual(plan["flags"]["--real-replay-shard-size"], "2")
        self.assertEqual(plan["flags"]["--real-replay-shard-timeout-seconds"], "900")
        self.assertEqual(plan["flags"]["--real-replay-shard-workers"], "3")
        self.assertEqual(plan["flags"]["--real-replay-failed-spec-retries"], "2")
        self.assertEqual(plan["flags"]["--real-replay-retry-timeout-seconds"], "1800")
        self.assertEqual(
            plan["flags"]["--real-replay-retry-max-frontier-candidates-per-spec"],
            "3",
        )
        self.assertEqual(
            plan["flags"]["--shadow-validation-artifact"],
            "/tmp/shadow-validation.json",
        )
        self.assertIn(
            {
                "action": "increase_breadth_and_portfolio_diversity",
                "flag": "--top-k",
                "current_value": "16",
                "recommended_value": "not-a-number",
                "reason": "rejected_invalid_numeric_remediation_flag",
            },
            plan["rejected_recommended_flags"],
        )

    def test_train_ranker_script_main_writes_model_and_scores(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            payload = runner.run_whitepaper_autoresearch_profit_target(
                self._source_jsonl_args(output_dir)
            )
            model_output = Path(tmpdir) / "ranker" / "model.json"
            scores_output = Path(tmpdir) / "ranker" / "scores.jsonl"

            with (
                patch(
                    "sys.argv",
                    [
                        "train_mlx_autoresearch_ranker.py",
                        "--candidate-specs",
                        str(output_dir / "candidate-specs.jsonl"),
                        "--evidence-bundles",
                        str(output_dir / "candidate-evidence-bundles.jsonl"),
                        "--model-output",
                        str(model_output),
                        "--scores-output",
                        str(scores_output),
                        "--backend-preference",
                        "numpy-fallback",
                    ],
                ),
                patch("builtins.print") as mock_print,
            ):
                exit_code = ranker_trainer.main()

            model_payload = json.loads(model_output.read_text(encoding="utf-8"))
            score_rows = scores_output.read_text(encoding="utf-8").splitlines()

        self.assertEqual(exit_code, 0)
        self.assertEqual(model_payload["backend"], "numpy-fallback")
        self.assertIn("rank_bucket_lift", model_payload)
        self.assertEqual(len(score_rows), payload["candidate_spec_count"])
        self.assertIn("selection_reason", json.loads(score_rows[0]))
        self.assertTrue(mock_print.called)

    def test_compile_claims_script_main_writes_recent_seed_cards(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "claims" / "hypothesis-cards.jsonl"
            with (
                patch(
                    "sys.argv",
                    [
                        "compile_whitepaper_claims.py",
                        "--output",
                        str(output_path),
                        "--seed-recent-whitepapers",
                    ],
                ),
                patch("builtins.print") as mock_print,
            ):
                parsed = claim_compiler_script._parse_args()
                exit_code = claim_compiler_script.main()

            rows = output_path.read_text(encoding="utf-8").splitlines()

        self.assertEqual(parsed.output, output_path)
        self.assertTrue(parsed.seed_recent_whitepapers)
        self.assertEqual(exit_code, 0)
        self.assertGreaterEqual(len(rows), 4)
        self.assertTrue(mock_print.called)

    def test_compile_claims_script_reads_source_jsonl(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            source_path.write_text(
                json.dumps(_source_jsonl_payload(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            output_path = root / "hypothesis-cards.jsonl"
            with (
                patch(
                    "sys.argv",
                    [
                        "compile_whitepaper_claims.py",
                        "--source-jsonl",
                        str(source_path),
                        "--output",
                        str(output_path),
                    ],
                ),
                patch("builtins.print") as mock_print,
            ):
                parsed = claim_compiler_script._parse_args()
                exit_code = claim_compiler_script.main()

            rows = output_path.read_text(encoding="utf-8").splitlines()

        self.assertEqual(parsed.source_jsonl, [source_path])
        self.assertEqual(exit_code, 0)
        self.assertEqual(len(rows), 1)
        self.assertTrue(mock_print.called)

    def test_compile_claims_script_loads_completed_persisted_run_claims(
        self,
    ) -> None:
        with Session(self.engine) as session:
            document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00001",
                title="Persisted Claims Paper",
                metadata_json={"source_url": "https://example.test/paper.pdf"},
            )
            version = WhitepaperDocumentVersion(
                document=document,
                version_number=1,
                checksum_sha256="a" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="paper.pdf",
            )
            run = WhitepaperAnalysisRun(
                run_id="paper-run-db",
                document=document,
                document_version=version,
                status="completed",
            )
            session.add_all(
                [
                    document,
                    version,
                    run,
                    WhitepaperClaim(
                        analysis_run=run,
                        claim_id="claim-flow",
                        claim_type="signal_mechanism",
                        claim_text="Order-flow bursts can predict short-horizon continuation.",
                        data_requirements_json=["order_flow_imbalance"],
                        confidence="0.82",
                    ),
                    WhitepaperClaim(
                        analysis_run=run,
                        claim_id="claim-validation",
                        claim_type="validation_requirement",
                        claim_text="The signal must pass held-out liquidity stress windows.",
                        data_requirements_json=["spread_bps"],
                        confidence="0.76",
                    ),
                    WhitepaperClaimRelation(
                        analysis_run=run,
                        relation_id="rel-supports",
                        relation_type="supports",
                        source_claim_id="claim-validation",
                        target_claim_id="claim-flow",
                    ),
                ]
            )
            session.commit()

        with (
            TemporaryDirectory() as tmpdir,
            patch(
                "scripts.compile_whitepaper_claims.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
            patch(
                "sys.argv",
                [
                    "compile_whitepaper_claims.py",
                    "--paper-run-id",
                    "paper-run-db",
                    "--output",
                    str(Path(tmpdir) / "hypothesis-cards.jsonl"),
                    "--sources-output",
                    str(Path(tmpdir) / "sources.jsonl"),
                ],
            ),
            patch("builtins.print") as mock_print,
        ):
            exit_code = claim_compiler_script.main()
            card_rows = (
                (Path(tmpdir) / "hypothesis-cards.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            )
            source_rows = (
                (Path(tmpdir) / "sources.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(len(card_rows), 1)
        self.assertEqual(len(source_rows), 1)
        source_payload = json.loads(source_rows[0])
        self.assertEqual(source_payload["run_id"], "paper-run-db")
        self.assertEqual(len(source_payload["claims"]), 2)
        self.assertEqual(len(source_payload["claim_relations"]), 1)
        self.assertTrue(mock_print.called)

    def test_runner_db_source_loader_ignores_incomplete_whitepaper_runs(
        self,
    ) -> None:
        with Session(self.engine) as session:
            completed_document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00002",
                title="Completed Claims Paper",
                metadata_json={"source_url": "https://example.test/completed.pdf"},
            )
            completed_version = WhitepaperDocumentVersion(
                document=completed_document,
                version_number=1,
                checksum_sha256="b" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="completed.pdf",
            )
            completed_run = WhitepaperAnalysisRun(
                run_id="paper-completed",
                document=completed_document,
                document_version=completed_version,
                status="completed",
            )
            running_document = WhitepaperDocument(
                source="arxiv",
                source_identifier="2501.00003",
                title="Running Claims Paper",
                metadata_json={"source_url": "https://example.test/running.pdf"},
            )
            running_version = WhitepaperDocumentVersion(
                document=running_document,
                version_number=1,
                checksum_sha256="c" * 64,
                ceph_bucket="whitepapers",
                ceph_object_key="running.pdf",
            )
            running_run = WhitepaperAnalysisRun(
                run_id="paper-running",
                document=running_document,
                document_version=running_version,
                status="running",
            )
            session.add_all(
                [
                    completed_document,
                    completed_version,
                    completed_run,
                    WhitepaperClaim(
                        analysis_run=completed_run,
                        claim_id="claim-completed",
                        claim_type="signal_mechanism",
                        claim_text="Completed paper claim.",
                        data_requirements_json=["order_flow_imbalance"],
                    ),
                    running_document,
                    running_version,
                    running_run,
                    WhitepaperClaim(
                        analysis_run=running_run,
                        claim_id="claim-running",
                        claim_type="signal_mechanism",
                        claim_text="Running paper claim.",
                        data_requirements_json=["order_flow_imbalance"],
                    ),
                ]
            )
            session.commit()

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            sources = runner._load_sources_from_db(["paper-completed", "paper-running"])

        self.assertEqual([source.run_id for source in sources], ["paper-completed"])

    def test_runner_parse_args_covers_cli_defaults_and_flags(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            source_path = Path(tmpdir) / "sources.jsonl"
            with patch(
                "sys.argv",
                [
                    "run_whitepaper_autoresearch_profit_target.py",
                    "--output-dir",
                    str(output_dir),
                    "--epoch-id",
                    "whitepaper-autoresearch-cli-epoch",
                    "--seed-recent-whitepapers",
                    "--replay-mode",
                    "synthetic",
                    "--source-jsonl",
                    str(source_path),
                    "--clickhouse-password-env",
                    "TORGHUT_CLICKHOUSE_PASSWORD",
                    "--max-total-frontier-candidates",
                    "7",
                    "--no-persist-results",
                ],
            ):
                parsed = runner._parse_args()

        self.assertEqual(parsed.output_dir, output_dir)
        self.assertEqual(parsed.epoch_id, "whitepaper-autoresearch-cli-epoch")
        self.assertTrue(parsed.seed_recent_whitepapers)
        self.assertEqual(parsed.replay_mode, "synthetic")
        self.assertEqual(parsed.source_jsonl, [source_path])
        self.assertEqual(parsed.clickhouse_password_env, "TORGHUT_CLICKHOUSE_PASSWORD")
        self.assertEqual(parsed.symbols, ",".join(_CHIP_UNIVERSE))
        self.assertEqual(
            parsed.max_frontier_candidates_per_spec,
            runner._DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
        )
        self.assertEqual(parsed.max_total_frontier_candidates, 7)
        self.assertEqual(parsed.real_replay_shard_size, 0)
        self.assertEqual(parsed.real_replay_shard_timeout_seconds, 0)
        self.assertEqual(parsed.real_replay_shard_workers, 1)
        self.assertFalse(parsed.persist_results)

    def test_decimal_arg_or_default_uses_explicit_cli_override(self) -> None:
        value = runner._decimal_arg_or_default(
            Namespace(min_daily_net_pnl="-125.50"),
            "min_daily_net_pnl",
            Decimal("-350"),
        )

        self.assertEqual(value, Decimal("-125.50"))

    def test_clickhouse_password_env_resolution_keeps_secret_out_of_argv(
        self,
    ) -> None:
        with patch.dict("os.environ", {"TORGHUT_TEST_CLICKHOUSE_PASSWORD": "from-env"}):
            resolved = runner._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="",
                    clickhouse_password_env="TORGHUT_TEST_CLICKHOUSE_PASSWORD",
                )
            )
            direct = runner._resolved_clickhouse_password(
                Namespace(
                    clickhouse_password="direct",
                    clickhouse_password_env="TORGHUT_TEST_CLICKHOUSE_PASSWORD",
                )
            )

        self.assertEqual(resolved, "from-env")
        self.assertEqual(direct, "direct")

    def test_runner_reads_source_jsonl_end_to_end(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            source_path.write_text(
                json.dumps(_source_jsonl_payload(), sort_keys=True) + "\n",
                encoding="utf-8",
            )
            output_dir = root / "epoch"
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.source_jsonl = [source_path]
            args.persist_results = False
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            manifest = json.loads(
                (output_dir / "epoch-manifest.json").read_text(encoding="utf-8")
            )
            sources = [
                json.loads(line)
                for line in (output_dir / "whitepaper-sources.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
            ]

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(payload["source_count"], 1)
        self.assertEqual(manifest["paper_sources"][0]["run_id"], "paper-jsonl-2026")
        self.assertEqual(sources[0]["run_id"], "paper-jsonl-2026")

    def test_candidate_budget_does_not_truncate_compiled_hypothesis_universe(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            source_path = root / "sources.jsonl"
            rows: list[dict[str, object]] = []
            for index in range(1):
                payload = dict(_source_jsonl_payload())
                payload["run_id"] = f"paper-jsonl-coverage-{index}"
                payload["title"] = f"Coverage Paper {index}"
                payload["source_url"] = f"https://example.test/coverage-{index}.pdf"
                claims = [
                    dict(item)
                    for item in cast(list[dict[str, object]], payload["claims"])
                ]
                claims[0]["claim_text"] = (
                    f"Order-flow momentum continuation signal {index} with late-day reversal validation."
                )
                payload["claims"] = claims
                rows.append(payload)
            source_path.write_text(
                "\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n",
                encoding="utf-8",
            )
            output_dir = root / "epoch"
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.source_jsonl = [source_path]
            args.max_candidates = 2
            args.top_k = 1
            args.exploration_slots = 1
            args.persist_results = False

            payload = runner.run_whitepaper_autoresearch_profit_target(args)
            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertGreater(payload["candidate_spec_count"], args.max_candidates)
        self.assertEqual(
            selection["budget"]["compiled_candidate_count"],
            payload["candidate_spec_count"],
        )
        self.assertEqual(
            selection["budget"]["selected_count"],
            payload["replay_candidate_spec_count"],
        )
        self.assertLessEqual(
            payload["replay_candidate_spec_count"], args.max_candidates
        )

    def test_real_replay_builds_evidence_and_skips_incomplete_results(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "real"
            empty_result_path = Path(tmpdir) / "empty.json"
            valid_result_path = Path(tmpdir) / "valid.json"
            empty_result_path.write_text(json.dumps({"top": []}), encoding="utf-8")
            valid_result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "250",
                                    "active_day_ratio": "1.0",
                                    "positive_day_ratio": "0.8",
                                },
                            },
                            {
                                "candidate_id": "cand-real-diversifier",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "175",
                                    "active_day_ratio": "1.0",
                                    "positive_day_ratio": "0.8",
                                },
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {"experiment_id": "missing-path"},
                    {
                        "experiment_id": "empty-top",
                        "result_path": str(empty_result_path),
                    },
                    {
                        "experiment_id": "spec-real",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(valid_result_path),
                        "promotion_readiness": {"status": "blocked"},
                    },
                ]
            }

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2",
                return_value=factory_payload,
            ):
                result = runner._run_real_replay(
                    self._args(output_dir), output_dir=output_dir
                )

        self.assertEqual(len(result.evidence_bundles), 2)
        self.assertEqual(result.evidence_bundles[0].candidate_spec_id, "spec-real")
        self.assertEqual(result.evidence_bundles[1].candidate_spec_id, "spec-real")
        self.assertEqual(
            result.evidence_bundles[1].candidate_id, "cand-real-diversifier"
        )
        self.assertEqual(result.evidence_bundles[0].dataset_snapshot_id, "snap-real")

    def test_real_replay_injects_spec_metadata_into_evidence_bundle(self) -> None:
        spec = self._candidate_spec("spec-real-replay-signature")
        with TemporaryDirectory() as tmpdir:
            result_path = Path(tmpdir) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "25",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            result = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "candidate_spec_id": spec.candidate_spec_id,
                            "experiment_id": "exp-real",
                            "dataset_snapshot_id": "snap-real",
                            "result_path": str(result_path),
                        }
                    ]
                },
                specs_by_id={spec.candidate_spec_id: spec},
            )

        self.assertEqual(len(result.evidence_bundles), 1)
        scorecard = result.evidence_bundles[0].objective_scorecard
        self.assertEqual(scorecard["family_template_id"], spec.family_template_id)
        self.assertEqual(scorecard["runtime_family"], spec.runtime_family)
        self.assertEqual(scorecard["runtime_strategy_name"], spec.runtime_strategy_name)
        self.assertEqual(
            scorecard["execution_signature"],
            runner._candidate_spec_execution_signature(spec),
        )

    def test_real_replay_uses_spec_universe_instead_of_global_symbols(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "1",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_symbols: list[str] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_symbols.append(str(factory_args.symbols))
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                result = runner._run_real_replay(
                    self._args(output_dir),
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_symbols, [""])
        self.assertEqual(len(result.evidence_bundles), 1)

    def test_real_replay_passes_global_frontier_candidate_budget(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-real",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "1",
                                    "active_day_ratio": "1",
                                    "positive_day_ratio": "1",
                                },
                            }
                        ]
                    }
                ),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_budget: list[int] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_budget.append(
                    int(factory_args.max_total_candidates_to_evaluate)
                )
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_total_frontier_candidates = 11
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_budget, [11])
        self.assertEqual(len(result.evidence_bundles), 1)

    def test_real_replay_defaults_global_frontier_budget_to_candidate_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            result_path = output_dir / "result.json"
            result_path.parent.mkdir(parents=True)
            result_path.write_text(
                json.dumps({"top": []}),
                encoding="utf-8",
            )
            factory_payload = {
                "experiments": [
                    {
                        "experiment_id": "spec-real-exp",
                        "dataset_snapshot_id": "snap-real",
                        "result_path": str(result_path),
                    }
                ]
            }
            captured_budget: list[int] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_budget.append(
                    int(factory_args.max_total_candidates_to_evaluate)
                )
                return factory_payload

            with patch.object(
                runner.strategy_factory_runner,
                "run_strategy_factory_v2_from_specs",
                side_effect=fake_run,
            ):
                cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                    [runner.RECENT_WHITEPAPER_SEEDS[0]]
                )
                compilation = runner.compile_whitepaper_candidate_specs(
                    hypothesis_cards=cards,
                    family_template_dir=Path("config/trading/families"),
                    seed_sweep_dir=Path("config/trading"),
                )
                args = self._args(output_dir)
                args.max_candidates = 24
                args.max_frontier_candidates_per_spec = 8
                args.max_total_frontier_candidates = 0
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_budget, [24])
        self.assertEqual(len(result.evidence_bundles), 0)

    def test_sharded_real_replay_continues_after_candidate_timeout(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            calls: list[list[str]] = []

            def fake_replay(
                _args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                spec_ids = [spec.candidate_spec_id for spec in specs]
                calls.append(spec_ids)
                if len(calls) == 2:
                    raise TimeoutError("real_replay_timeout_seconds:7")
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=spec_ids[0],
                    candidate={
                        "candidate_id": f"cand-{spec_ids[0]}",
                        "objective_scorecard": {
                            "net_pnl_per_day": "10",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                        },
                    },
                    dataset_snapshot_id="snap-shard",
                    result_path=str(output_dir / f"{spec_ids[0]}.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok", "spec_ids": spec_ids},),
                )

            args = self._args(output_dir)
            args.replay_mode = "real"
            args.real_replay_shard_size = 1
            args.real_replay_shard_timeout_seconds = 7
            args.real_replay_failed_spec_retries = 0
            with patch.object(runner, "_run_real_replay", side_effect=fake_replay):
                result = runner._run_replay_with_optional_timeout(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                )

        self.assertEqual(len(calls), 3)
        self.assertTrue(result.incomplete)
        self.assertEqual(len(result.evidence_bundles), 2)
        self.assertTrue(
            any(
                item.get("status") == "partial_replay_shards_interrupted"
                for item in result.replay_results
            )
        )
        shard_summary = next(
            item
            for item in result.replay_results
            if item.get("status") == "partial_replay_shards_interrupted"
        )
        self.assertEqual(shard_summary["shard_workers"], 1)
        self.assertIn(
            "TimeoutError:real_replay_timeout_seconds:7", result.failure_reasons
        )

    def test_sharded_real_replay_retries_failed_specs_individually(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            calls: list[tuple[list[str], int, int, int]] = []

            def fake_replay(
                args: Namespace,
                *,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                spec_ids = [spec.candidate_spec_id for spec in specs]
                calls.append(
                    (
                        spec_ids,
                        int(args.max_candidates),
                        int(args.top_k),
                        int(args.max_total_frontier_candidates),
                    )
                )
                if len(calls) == 2:
                    raise TimeoutError("real_replay_timeout_seconds:7")
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=spec_ids[0],
                    candidate={
                        "candidate_id": f"cand-{spec_ids[0]}",
                        "objective_scorecard": {
                            "net_pnl_per_day": "10",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                        },
                    },
                    dataset_snapshot_id="snap-shard",
                    result_path=str(output_dir / f"{spec_ids[0]}.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok", "spec_ids": spec_ids},),
                )

            args = self._args(output_dir)
            args.replay_mode = "real"
            args.real_replay_shard_size = 1
            args.real_replay_shard_timeout_seconds = 7
            args.real_replay_failed_spec_retries = 1
            args.real_replay_retry_timeout_seconds = 11
            args.real_replay_retry_max_frontier_candidates_per_spec = 1
            with patch.object(runner, "_run_real_replay", side_effect=fake_replay):
                result = runner._run_replay_with_optional_timeout(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                )

        self.assertEqual(len(calls), 4)
        self.assertFalse(result.incomplete)
        self.assertEqual(len(result.evidence_bundles), 3)
        self.assertEqual(calls[-1][1:], (1, 1, 1))
        retry_summary = next(
            item
            for item in result.replay_results
            if item.get("status") == "failed_shard_specs_retried"
        )
        self.assertEqual(retry_summary["retry_timeout_seconds"], 11)
        self.assertEqual(
            retry_summary["completed_candidate_spec_ids"],
            [calls[1][0][0]],
        )
        self.assertEqual(result.failure_reasons, ())

    def test_failed_shard_retry_skips_malformed_and_unknown_spec_ids(self) -> None:
        self.assertEqual(
            runner._failed_shard_spec_ids(
                (
                    {"candidate_spec_ids": "spec-not-a-list"},
                    {"candidate_spec_ids": ["spec-a", "", "spec-a", "spec-b"]},
                )
            ),
            ("spec-a", "spec-b"),
        )

        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            evidence, replay_results, failures, summary = (
                runner._retry_real_replay_failed_shard_specs(
                    args=args,
                    output_dir=Path(tmpdir) / "epoch",
                    specs=(self._candidate_spec("spec-known"),),
                    shard_failures=({"candidate_spec_ids": ["spec-missing"]},),
                    shard_timeout_seconds=7,
                    starting_shard_index=1,
                )
            )

        self.assertEqual(evidence, ())
        self.assertEqual(replay_results, ())
        self.assertEqual(failures, ({"candidate_spec_ids": ["spec-missing"]},))
        self.assertIsNone(summary)

    def test_failed_shard_retry_defaults_timeout_and_reports_retry_failures(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-retry-fails")
        calls: list[tuple[int, int, int]] = []

        def fake_execute(
            plan: runner._ReplayShardPlan,
        ) -> runner._ReplayShardOutcome:
            calls.append(
                (
                    plan.shard_index,
                    plan.timeout_seconds,
                    int(plan.args.max_total_frontier_candidates),
                )
            )
            return runner._ReplayShardOutcome(
                shard_index=plan.shard_index,
                candidate_spec_ids=(spec.candidate_spec_id,),
                result=runner.EpochReplayResult(
                    evidence_bundles=(),
                    replay_results=(),
                ),
                failure={
                    "shard_index": plan.shard_index,
                    "candidate_spec_ids": [spec.candidate_spec_id],
                    "reason": "nested_shard_incomplete",
                },
            )

        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.real_replay_failed_spec_retries = 2
            args.real_replay_retry_timeout_seconds = 0
            args.real_replay_retry_max_frontier_candidates_per_spec = 2
            with patch.object(
                runner, "_execute_real_replay_shard", side_effect=fake_execute
            ):
                evidence, replay_results, failures, summary = (
                    runner._retry_real_replay_failed_shard_specs(
                        args=args,
                        output_dir=Path(tmpdir) / "epoch",
                        specs=(spec,),
                        shard_failures=(
                            {"candidate_spec_ids": [spec.candidate_spec_id]},
                        ),
                        shard_timeout_seconds=7,
                        starting_shard_index=3,
                    )
                )

        self.assertEqual(evidence, ())
        self.assertEqual(replay_results, ())
        self.assertEqual(calls, [(4, 900, 2), (5, 900, 2)])
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["retry_attempt"], 2)
        self.assertEqual(failures[0]["retry_candidate_spec_id"], spec.candidate_spec_id)
        self.assertEqual(failures[0]["retry_timeout_seconds"], 900)
        self.assertEqual(failures[0]["retry_max_frontier_candidates_per_spec"], 2)
        assert summary is not None
        self.assertEqual(len(summary["attempts"]), 2)
        self.assertEqual(
            summary["remaining_failed_candidate_spec_ids"], [spec.candidate_spec_id]
        )

    def test_failed_shard_retry_stops_after_all_specs_complete(self) -> None:
        spec = self._candidate_spec("spec-retry-completes")
        calls: list[int] = []

        def fake_execute(
            plan: runner._ReplayShardPlan,
        ) -> runner._ReplayShardOutcome:
            calls.append(plan.shard_index)
            bundle = runner.evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate={
                    "candidate_id": "cand-retry-completes",
                    "objective_scorecard": {
                        "net_pnl_per_day": "10",
                        "active_day_ratio": "1",
                        "positive_day_ratio": "1",
                    },
                },
                dataset_snapshot_id="snap-retry-completes",
                result_path="feedback://retry-completes",
            )
            return runner._ReplayShardOutcome(
                shard_index=plan.shard_index,
                candidate_spec_ids=(spec.candidate_spec_id,),
                result=runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok"},),
                ),
            )

        with TemporaryDirectory() as tmpdir:
            args = self._args(Path(tmpdir) / "epoch")
            args.real_replay_failed_spec_retries = 2
            with patch.object(
                runner, "_execute_real_replay_shard", side_effect=fake_execute
            ):
                evidence, replay_results, failures, summary = (
                    runner._retry_real_replay_failed_shard_specs(
                        args=args,
                        output_dir=Path(tmpdir) / "epoch",
                        specs=(spec,),
                        shard_failures=(
                            {"candidate_spec_ids": [spec.candidate_spec_id]},
                        ),
                        shard_timeout_seconds=7,
                        starting_shard_index=3,
                    )
                )

        self.assertEqual(calls, [4])
        self.assertEqual(evidence[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(replay_results, ({"status": "ok"},))
        self.assertEqual(failures, ())
        assert summary is not None
        self.assertEqual(len(summary["attempts"]), 1)
        self.assertEqual(
            summary["completed_candidate_spec_ids"], [spec.candidate_spec_id]
        )

    def test_real_replay_shards_use_isolated_output_dirs_and_bounded_budget(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            args = self._args(output_dir)
            args.max_candidates = 24
            args.top_k = 12
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 5

            plans = runner._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=1,
                shard_timeout_seconds=7,
            )

        self.assertEqual(len(plans), 3)
        self.assertEqual(
            [plan.output_dir.name for plan in plans],
            ["shard-001", "shard-002", "shard-003"],
        )
        self.assertTrue(
            all(
                plan.output_dir.parent == output_dir / "strategy-factory-shards"
                for plan in plans
            )
        )
        self.assertEqual(
            [plan.args.max_total_frontier_candidates for plan in plans],
            [2, 2, 2],
        )
        self.assertEqual([plan.args.top_k for plan in plans], [1, 1, 1])

    def test_real_replay_shards_runs_bounded_worker_pool(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            cards = claim_compiler_script.compile_sources_to_hypothesis_cards(
                [runner.RECENT_WHITEPAPER_SEEDS[0]]
            )
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
            )
            specs = compilation.executable_specs[:3]
            args = self._args(output_dir)
            args.real_replay_shard_workers = 8
            workers_seen: list[int] = []
            submitted: list[tuple[Any, runner._ReplayShardPlan]] = []

            class _FakeFuture:
                def __init__(self, outcome: runner._ReplayShardOutcome) -> None:
                    self._outcome = outcome

                def result(self) -> runner._ReplayShardOutcome:
                    return self._outcome

            class _FakeExecutor:
                def __init__(self, max_workers: int) -> None:
                    workers_seen.append(max_workers)

                def __enter__(self) -> _FakeExecutor:
                    return self

                def __exit__(self, *_args: object) -> None:
                    return None

                def submit(
                    self,
                    fn: Any,
                    plan: runner._ReplayShardPlan,
                ) -> _FakeFuture:
                    submitted.append((fn, plan))
                    return _FakeFuture(
                        runner._ReplayShardOutcome(
                            shard_index=plan.shard_index,
                            candidate_spec_ids=tuple(
                                spec.candidate_spec_id for spec in plan.specs
                            ),
                            result=runner.EpochReplayResult(
                                evidence_bundles=(),
                                replay_results=(
                                    {
                                        "status": "ok",
                                        "shard_index": plan.shard_index,
                                    },
                                ),
                            ),
                        )
                    )

            def fake_as_completed(futures: object) -> list[_FakeFuture]:
                return list(cast(Sequence[_FakeFuture], list(futures)))[::-1]

            with (
                patch.object(runner, "ProcessPoolExecutor", _FakeExecutor),
                patch.object(runner, "as_completed", side_effect=fake_as_completed),
            ):
                result = runner._run_real_replay_shards(
                    args=args,
                    output_dir=output_dir,
                    specs=specs,
                    shard_size=1,
                    shard_timeout_seconds=7,
                )

        self.assertEqual(workers_seen, [3])
        self.assertEqual(len(submitted), 3)
        self.assertTrue(
            all(fn is runner._execute_real_replay_shard for fn, _plan in submitted)
        )
        self.assertEqual(
            [item["shard_index"] for item in result.replay_results],
            [1, 2, 3],
        )

    def test_incomplete_sharded_replay_cannot_report_oracle_candidate_found(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"

            def fake_replay(
                *,
                args: Namespace,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                spec = specs[0]
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=spec.candidate_spec_id,
                    candidate={
                        "candidate_id": "cand-incomplete",
                        "objective_scorecard": {
                            "net_pnl_per_day": "400",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                            "daily_net": {
                                "2026-02-23": "400",
                                "2026-02-24": "400",
                                "2026-02-25": "400",
                                "2026-02-26": "400",
                            },
                            "avg_filled_notional_per_day": "350000",
                        },
                    },
                    dataset_snapshot_id="snap-incomplete",
                    result_path=str(output_dir / "incomplete.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "partial_replay_shards_interrupted"},),
                    incomplete=True,
                    failure_reasons=("TimeoutError:real_replay_timeout_seconds:7",),
                )

            args = self._source_jsonl_args(output_dir)
            args.replay_mode = "real"
            args.portfolio_size_min = 1
            with patch.object(
                runner, "_run_replay_with_optional_timeout", side_effect=fake_replay
            ):
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        self.assertEqual(payload["status_reason"], "selected_replay_incomplete")
        self.assertTrue(payload["replay_incomplete"])
        self.assertFalse(payload["oracle_candidate_found"])
        self.assertIn(
            "selected_replay_incomplete", payload["promotion_readiness"]["blockers"]
        )

    def test_main_returns_nonzero_without_sources(self) -> None:
        with (
            TemporaryDirectory() as tmpdir,
            patch.object(
                runner,
                "_parse_args",
                return_value=Namespace(
                    **{
                        **vars(self._args(Path(tmpdir) / "epoch")),
                        "seed_recent_whitepapers": False,
                        "paper_run_id": [],
                    }
                ),
            ),
            patch("builtins.print") as mock_print,
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 2)
        self.assertTrue(mock_print.called)
