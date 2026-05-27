from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import json
import sys
from argparse import Namespace
from datetime import date, datetime, timezone
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
    RejectedSignalOutcomeEvent,
    WhitepaperAnalysisRun,
    WhitepaperClaim,
    WhitepaperClaimRelation,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
)
from app.trading.discovery import fast_replay
from app.trading.discovery.replay_tape import (
    build_source_query_digest,
    materialize_signal_tape,
)
from app.trading.discovery.evidence_bundles import evidence_bundle_blockers
from app.trading.models import SignalEnvelope

_CHIP_UNIVERSE = list(runner.LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)


def _authoritative_exact_replay_ledger_rows() -> list[dict[str, object]]:
    base_row: dict[str, object] = {
        "account_label": "paper",
        "strategy_id": "intraday-tsmom-profit-v3",
        "symbol": "AAPL",
        "source": "exact_replay",
        "execution_policy_hash": "execution-policy-hash",
        "cost_model_hash": "cost-model-hash",
        "lineage_hash": "lineage-hash",
        "replay_data_hash": "replay-data-hash",
    }
    return [
        {
            **base_row,
            "event_type": "decision",
            "executed_at": "2026-05-20T14:00:00Z",
            "side": "buy",
            "decision_id": "decision-1",
            "order_id": "order-1",
        },
        {
            **base_row,
            "event_type": "order_submitted",
            "executed_at": "2026-05-20T14:00:01Z",
            "side": "buy",
            "decision_id": "decision-1",
            "order_id": "order-1",
        },
        {
            **base_row,
            "event_type": "fill",
            "executed_at": "2026-05-20T14:00:02Z",
            "side": "buy",
            "decision_id": "decision-1",
            "order_id": "order-1",
            "filled_qty": "1",
            "avg_fill_price": "100",
            "filled_notional": "100",
            "cost_amount": "0.10",
            "cost_basis": "explicit_replay_fee_model",
        },
        {
            **base_row,
            "event_type": "decision",
            "executed_at": "2026-05-20T14:10:00Z",
            "side": "sell",
            "decision_id": "decision-2",
            "order_id": "order-2",
        },
        {
            **base_row,
            "event_type": "order_submitted",
            "executed_at": "2026-05-20T14:10:01Z",
            "side": "sell",
            "decision_id": "decision-2",
            "order_id": "order-2",
        },
        {
            **base_row,
            "event_type": "fill",
            "executed_at": "2026-05-20T14:10:02Z",
            "side": "sell",
            "decision_id": "decision-2",
            "order_id": "order-2",
            "filled_qty": "1",
            "avg_fill_price": "101",
            "filled_notional": "101",
            "cost_amount": "0.10",
            "cost_basis": "explicit_replay_fee_model",
        },
    ]


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


def _source_from_payload(payload: dict[str, object]) -> runner.WhitepaperResearchSource:
    return runner.WhitepaperResearchSource(
        run_id=str(payload["run_id"]),
        title=str(payload["title"]),
        source_url=str(payload["source_url"]),
        published_at=str(payload["published_at"]),
        claims=tuple(
            cast(dict[str, object], claim)
            for claim in cast(list[object], payload["claims"])
        ),
        claim_relations=tuple(
            cast(dict[str, object], relation)
            for relation in cast(list[object], payload["claim_relations"])
        ),
    )


@contextmanager
def _compact_recent_whitepaper_sources(
    source_count: int = 4,
) -> Any:
    sources: list[runner.WhitepaperResearchSource] = []
    for index in range(source_count):
        payload = _source_jsonl_payload()
        payload["run_id"] = f"compact-seed-2026-{index}"
        payload["title"] = f"Compact 2026 Microstructure Seed {index}"
        sources.append(_source_from_payload(payload))

    midpoint = max(1, source_count // 2)
    with (
        patch.object(
            runner, "_program_whitepaper_sources", return_value=sources[:midpoint]
        ),
        patch.object(runner, "RECENT_WHITEPAPER_SEEDS", tuple(sources[midpoint:])),
    ):
        yield


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
            candidate_specs=[],
            seed_recent_whitepapers=True,
            target_net_pnl_per_day="500",
            max_candidates=8,
            top_k=4,
            exploration_slots=2,
            feedback_block_reaudit_slots=0,
            selection_only=False,
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
            staged_train_screen_multiplier=0,
            capture_rejected_seed_full_window_ledger=False,
            capture_positive_rejected_full_window_ledgers=0,
            symbol_prune_iterations=0,
            symbol_prune_candidates=0,
            symbol_prune_min_universe_size=0,
            loss_repair_iterations=0,
            loss_repair_candidates=0,
            consistency_repair_iterations=0,
            consistency_repair_candidates=0,
            real_replay_timeout_seconds=0,
            real_replay_shard_size=0,
            real_replay_shard_timeout_seconds=0,
            real_replay_shard_workers=1,
            real_replay_max_parallel_frontier_candidates=runner._DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
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
            replay_tape_path=None,
            replay_tape_manifest=None,
            replay_tape_preview_top_k=0,
            replay_tape_preview_min_rows=2,
            materialize_replay_tape=False,
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

    def test_candidate_board_adds_factor_acceptance_replay_metadata(self) -> None:
        spec = replace(
            self._candidate_spec("spec-factor-acceptance"),
            feature_contract={
                "mechanism": "rankic signal discovery",
                "required_features": ("cross_section_session_open_rank", "spread_bps"),
                "factor_acceptance_artifact": {
                    "status": "rejected",
                    "factor_expression": "cross_section_session_open_rank",
                    "source_idea": "static_rankic_compile_contract",
                    "allowed_feature_dependencies": [
                        "cross_section_session_open_rank",
                        "spread_bps",
                    ],
                    "rejection_reasons": ["rank_ic_below_floor"],
                    "lineage_hash": "static-factor-lineage",
                },
            },
            parameter_space={
                "mechanism_overlay_ids": ["rankic_factor_acceptance_harness"]
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-factor-acceptance",
            candidate_id="candidate-factor-acceptance",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-factor-acceptance",
            feature_spec_hash="feature-hash",
            code_commit="commit-sha",
            replay_artifact_refs=("replay-factor.json",),
            objective_scorecard={
                "rank_ic": "0.061",
                "rank_ir": "0.71",
                "p_value": "0.006",
                "decision_count": 144,
                "net_pnl_per_day": "34",
                "avg_filled_notional_per_day": "100000",
                "market_impact_stress_cost_bps": "1.8",
                "train_window": {"start": "2026-01-02", "end": "2026-03-31"},
                "holdout_window": {"start": "2026-04-01", "end": "2026-04-30"},
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-factor-acceptance",
            output_dir=Path("/tmp/torghut-factor-acceptance"),
            target=Decimal("500"),
            candidate_specs=[spec],
            candidate_selection={
                "budget": {"compiled_candidate_count": 4},
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "top_k",
                        "rank": 1,
                    }
                ],
            },
            pre_replay_proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "0.9",
                }
            ],
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "0.9",
                }
            ],
            evidence_bundles=[evidence],
            portfolio=None,
            promotion_readiness={"promotable": False},
            runtime_closure={"status": "blocked"},
        )

        row = board["rows"][0]
        metadata = row["factor_acceptance_replay_metadata"]
        artifact = metadata["replay_artifact"]

        self.assertEqual(board["factor_acceptance_summary"]["accepted_count"], 1)
        self.assertEqual(metadata["status"], "accepted")
        self.assertEqual(metadata["evidence_status"], "replayed")
        self.assertFalse(metadata["promotion_allowed"])
        self.assertFalse(metadata["final_promotion_authorized"])
        self.assertEqual(artifact["deflated_p_value"], "0.024")
        self.assertEqual(artifact["cost_stressed_net_expectancy_bps"], "1.60000")
        self.assertFalse(row["factor_acceptance_promotion_allowed"])
        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")

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

    def test_candidate_feedback_metadata_preserves_validation_contract(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-validation-contract"),
            feature_contract={
                "mechanism": "scale-invariant trade-flow stress contract",
                "required_features": ("trade_flow", "relative_volume"),
                "source_run_id": "paper-arxiv-2602-23784",
                "family_selection": {"rank": 1},
                "validation_requirements": [
                    {
                        "claim_id": "synthetic-rollout-stress",
                        "claim_type": "validation_requirement",
                        "claim_text": (
                            "Synthetic trade-flow rollouts are stress inputs, not "
                            "promotion proof."
                        ),
                        "data_requirements": [
                            "historical_replay",
                            "live_paper_parity",
                            "market_impact_stress",
                        ],
                    }
                ],
            },
            promotion_contract={
                "requires_historical_replay": True,
                "requires_live_paper_parity": True,
                "synthetic_evidence_policy": "validation_only_not_promotion_proof",
            },
        )

        candidate = runner._candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": "candidate-validation-contract",
                "objective_scorecard": {"net_pnl_per_day": "525"},
                "promotion_readiness": {
                    "stage": "research_candidate",
                    "status": "blocked_pending_runtime_parity",
                    "promotable": False,
                    "blockers": ["scheduler_v3_parity_missing"],
                },
            },
        )
        bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate=candidate,
            dataset_snapshot_id="historical-market-replay-2026-05-18",
            result_path="/tmp/historical-replay.json",
        )

        validation_contract = bundle.objective_scorecard["validation_contract"]
        self.assertEqual(
            validation_contract["validation_requirement_claim_ids"],
            ["synthetic-rollout-stress"],
        )
        self.assertEqual(
            bundle.promotion_readiness["validation_contract"],
            validation_contract,
        )
        self.assertIn(
            "validation_live_paper_parity_pending",
            bundle.promotion_readiness["blockers"],
        )
        self.assertNotIn(
            "synthetic_evidence_not_promotion_proof",
            evidence_bundle_blockers(bundle),
        )

    def test_validation_contract_rejects_synthetic_evidence_as_profit_proof(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-synthetic-contract"),
            feature_contract={
                **self._candidate_spec("spec-synthetic-contract").feature_contract,
                "validation_requirements": [
                    {
                        "claim_id": "synthetic-stress",
                        "claim_type": "validation_requirement",
                        "claim_text": "Synthetic rollouts are stress-only evidence.",
                        "data_requirements": ["historical_replay"],
                    }
                ],
            },
            promotion_contract={
                "requires_historical_replay": True,
                "synthetic_evidence_policy": "validation_only_not_promotion_proof",
            },
        )
        candidate = runner._candidate_payload_with_feedback_metadata(
            spec=spec,
            candidate={
                "candidate_id": "candidate-synthetic-contract",
                "objective_scorecard": {"net_pnl_per_day": "800"},
            },
        )

        bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate=candidate,
            dataset_snapshot_id="synthetic-recent-whitepaper-2025-2026",
            result_path="/tmp/synthetic-replay.json",
        )

        self.assertIn(
            "synthetic_evidence_not_promotion_proof",
            evidence_bundle_blockers(bundle),
        )

    def test_paper_mechanism_contract_prior_selects_replay_only_candidate(
        self,
    ) -> None:
        control_spec = self._candidate_spec(
            "spec-paper-control",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="75",
            selection_mode="continuation",
        )
        paper_spec_base = self._candidate_spec(
            "spec-paper-contract",
            family_template_id="breakout_reclaim_v2",
            entry_minute_after_open="75",
            selection_mode="continuation",
        )
        paper_spec = replace(
            paper_spec_base,
            feature_contract={
                **paper_spec_base.feature_contract,
                "source_claims": [
                    {
                        "claim_id": "claim-route-tca",
                        "claim_type": "execution_assumption",
                        "data_requirements": ["route_tca", "execution_shortfall"],
                    },
                    {
                        "claim_id": "claim-live-parity",
                        "claim_type": "validation_requirement",
                        "data_requirements": ["live_paper_parity"],
                    },
                ],
                "validation_requirements": [
                    {
                        "claim_id": "validate-fill-curve",
                        "claim_type": "validation_requirement",
                        "data_requirements": [
                            "fill_outcomes",
                            "runtime_ledger",
                        ],
                    }
                ],
                "mechanism_overlays": [
                    {
                        "overlay_id": "queue_position_survival_fill_curve",
                        "required_evidence": [
                            "queue_position_survival_fill_curve",
                            "order_lifecycle_fill_evidence",
                        ],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": [
                    "mixed_market_limit_execution_policy",
                    "queue_position_survival_fill_curve",
                ]
            },
            promotion_contract={
                "requires_route_tca": True,
                "requires_live_paper_parity": True,
                "requires_runtime_ledger": True,
                "rejects_synthetic_evidence": True,
            },
        )

        self.assertGreater(
            runner._pre_replay_candidate_score(paper_spec),
            runner._pre_replay_candidate_score(control_spec),
        )

        prior_bundle = runner._pre_replay_prior_bundle(paper_spec)
        self.assertFalse(prior_bundle.promotion_readiness["promotable"])
        self.assertIn(
            "runtime_replay_required", prior_bundle.promotion_readiness["blockers"]
        )
        self.assertIn(
            "validation_live_paper_parity_pending",
            prior_bundle.promotion_readiness["blockers"],
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(control_spec, paper_spec),
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in rows}

        self.assertGreater(
            Decimal(str(row_by_spec[paper_spec.candidate_spec_id]["proposal_score"])),
            Decimal(str(row_by_spec[control_spec.candidate_spec_id]["proposal_score"])),
        )
        self.assertLess(
            row_by_spec[paper_spec.candidate_spec_id]["rank"],
            row_by_spec[control_spec.candidate_spec_id]["rank"],
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(control_spec, paper_spec),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [paper_spec])
        self.assertEqual(
            selection["selected_candidate_spec_ids"], [paper_spec.candidate_spec_id]
        )
        paper_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == paper_spec.candidate_spec_id
        )
        control_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == control_spec.candidate_spec_id
        )
        self.assertTrue(paper_selection_row["selected_for_replay"])
        self.assertEqual(paper_selection_row["selection_reason"], "exploitation")
        self.assertEqual(
            control_selection_row["selection_reason"], "duplicate_execution_signature"
        )
        self.assertGreater(
            Decimal(str(paper_selection_row["paper_contract_prior_score"])),
            Decimal("0"),
        )
        self.assertEqual(
            paper_selection_row["paper_mechanism_overlay_ids"],
            [
                "mixed_market_limit_execution_policy",
                "queue_position_survival_fill_curve",
            ],
        )
        self.assertIn(
            "route_tca", paper_selection_row["paper_required_evidence_tokens"]
        )
        self.assertIn(
            "live_paper_parity", paper_selection_row["paper_required_evidence_tokens"]
        )
        self.assertGreaterEqual(paper_selection_row["paper_required_evidence_count"], 6)
        self.assertEqual(
            selection["budget"]["paper_contract_candidate_selected_count"], 0
        )

        exploration_selected, exploration_selection = (
            runner._select_candidate_specs_for_replay(
                specs=(control_spec, paper_spec),
                proposal_rows=rows,
                top_k=0,
                exploration_slots=1,
                max_candidates=1,
                portfolio_size_min=1,
            )
        )

        self.assertEqual(exploration_selected, [paper_spec])
        self.assertEqual(
            exploration_selection["budget"]["paper_contract_candidate_selected_count"],
            1,
        )
        exploration_paper_row = next(
            row
            for row in exploration_selection["rows"]
            if row["candidate_spec_id"] == paper_spec.candidate_spec_id
        )
        self.assertEqual(
            exploration_paper_row["selection_reason"], "paper_contract_exploration"
        )

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

    def test_parse_args_uses_reachable_clickhouse_env_defaults(self) -> None:
        with TemporaryDirectory() as tmpdir:
            with (
                patch.dict(
                    "os.environ",
                    {
                        "TA_CLICKHOUSE_URL": "http://127.0.0.1:8123",
                        "TA_CLICKHOUSE_USERNAME": "reader",
                    },
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ),
            ):
                args = runner._parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://127.0.0.1:8123")
        self.assertEqual(args.clickhouse_username, "reader")
        self.assertEqual(args.clickhouse_password_env, "TA_CLICKHOUSE_PASSWORD")

    def test_parse_args_prefers_explicit_clickhouse_http_url_over_ta_jdbc(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            with (
                patch.dict(
                    "os.environ",
                    {
                        "TA_CLICKHOUSE_URL": "jdbc:clickhouse://clickhouse/torghut",
                        "CLICKHOUSE_HTTP_URL": "http://127.0.0.1:8123",
                    },
                ),
                patch.object(
                    sys,
                    "argv",
                    [
                        "run_whitepaper_autoresearch_profit_target.py",
                        "--output-dir",
                        tmpdir,
                    ],
                ),
            ):
                args = runner._parse_args()

        self.assertEqual(args.clickhouse_http_url, "http://127.0.0.1:8123")

    def test_clickhouse_preflight_fails_fast_for_unresolved_in_cluster_dns(
        self,
    ) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            clickhouse_http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.socket.getaddrinfo",
            side_effect=runner.socket.gaierror("not known"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertIn("clickhouse_endpoint_unreachable", failure)
        self.assertIn("TA_CLICKHOUSE_URL", failure)
        self.assertIn("--clickhouse-http-url", failure)

    def test_clickhouse_preflight_skips_explicit_non_cluster_endpoint(self) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            clickhouse_http_url="http://127.0.0.1:8123",
        )

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.socket.getaddrinfo",
            side_effect=AssertionError("non-cluster endpoints are replay-checked"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertEqual(failure, "")

    def test_clickhouse_preflight_skips_when_replay_tape_is_supplied(self) -> None:
        args = Namespace(
            replay_mode="real",
            selection_only=False,
            replay_tape_path=Path("/tmp/replay-tape.jsonl"),
            clickhouse_http_url="http://torghut-clickhouse.torghut.svc.cluster.local:8123",
        )

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.socket.getaddrinfo",
            side_effect=AssertionError("replay tape should bypass DNS preflight"),
        ):
            failure = runner._clickhouse_endpoint_preflight_failure(args)

        self.assertEqual(failure, "")

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
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
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

            loaded, manifest = runner._load_autoresearch_feedback_evidence_bundles(
                (), include_persisted=True
            )

        model, rows = runner._pre_replay_proposal_model_and_rows(
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
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
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

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles()

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

        model, rows = runner._pre_replay_proposal_model_and_rows(
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
            runner._portfolio_candidate_row_to_feedback_bundles(non_feedback_status),
            (),
        )
        self.assertEqual(
            runner._portfolio_candidate_row_to_feedback_bundles(empty_scorecard),
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

        fallback_bundles = runner._portfolio_candidate_row_to_feedback_bundles(
            fallback_row
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
            runner._portfolio_candidate_row_to_feedback_bundles(invalid_sleeve_row),
            (),
        )

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

    def test_candidate_quality_gate_preserves_current_oracle_blockers(self) -> None:
        policy = runner.ProfitTargetOraclePolicy()

        failures = runner._candidate_quality_gate_failures(
            {
                "net_pnl_per_day": "750",
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "profit_factor": "2",
                "best_day_share": "0.1",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "max_gross_exposure_pct_equity": "0.5",
                "min_cash": "0",
                "negative_cash_observation_count": "0",
                "avg_filled_notional_per_day": "500000",
                "regime_slice_pass_rate": "1",
                "posterior_edge_lower": "0.01",
                "shadow_parity_status": "within_budget",
                "executable_replay_passed": True,
                "executable_replay_artifact_ref": "/tmp/replay.json",
                "executable_replay_order_count": "5",
                "executable_replay_account_buying_power": "10000",
                "executable_replay_max_notional_per_trade": "9000",
                "profit_target_oracle": {
                    "passed": False,
                    "blockers": [
                        "min_daily_net_pnl_failed",
                        "max_single_day_contribution_share_failed",
                        "max_single_symbol_contribution_share_failed",
                        "max_cluster_contribution_share_failed",
                        "market_impact_liquidity_evidence_present_failed",
                        "delay_adjusted_depth_stress_model_failed",
                    ],
                },
            },
            oracle_policy=policy,
        )

        self.assertIn("min_daily_net_pnl_failed", failures)
        self.assertIn("max_single_day_contribution_share_failed", failures)
        self.assertIn("max_single_symbol_contribution_share_failed", failures)
        self.assertIn("max_cluster_contribution_share_failed", failures)
        self.assertIn("market_impact_liquidity_evidence_present_failed", failures)
        self.assertIn("delay_adjusted_depth_stress_model_failed", failures)

    def test_candidate_quality_gate_flags_weak_profit_factor(self) -> None:
        policy = runner.ProfitTargetOraclePolicy()

        failures = runner._candidate_quality_gate_failures(
            {
                "net_pnl_per_day": "750",
                "active_day_ratio": "1",
                "positive_day_ratio": "0.67",
                "profit_factor": "1.20",
                "best_day_share": "0.1",
                "worst_day_loss": "0",
                "max_drawdown": "0",
                "max_gross_exposure_pct_equity": "0.5",
                "min_cash": "0",
                "negative_cash_observation_count": "0",
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

        self.assertEqual(failures, ["profit_factor_below_oracle"])

    def test_oracle_policy_from_args_carries_full_promotion_risk_parameters(
        self,
    ) -> None:
        policy = runner._oracle_policy_from_args(
            Namespace(
                min_profit_factor="1.65",
                max_worst_day_loss="999999999",
                max_drawdown="999999999",
                max_worst_day_loss_pct_equity="0.06",
                max_drawdown_pct_equity="0.09",
                extended_max_worst_day_loss_pct_equity="0.10",
                extended_max_drawdown_pct_equity="0.14",
                min_total_net_pnl_to_drawdown_ratio="3.50",
                max_gross_exposure_pct_equity="0.85",
                min_cash="250",
                max_negative_cash_observation_count=0,
            )
        )

        self.assertEqual(policy.min_profit_factor, Decimal("1.65"))
        self.assertEqual(policy.max_worst_day_loss, Decimal("999999999"))
        self.assertEqual(policy.max_drawdown, Decimal("999999999"))
        self.assertEqual(policy.max_worst_day_loss_pct_equity, Decimal("0.06"))
        self.assertEqual(policy.max_drawdown_pct_equity, Decimal("0.09"))
        self.assertEqual(policy.extended_max_worst_day_loss_pct_equity, Decimal("0.10"))
        self.assertEqual(policy.extended_max_drawdown_pct_equity, Decimal("0.14"))
        self.assertEqual(policy.min_total_net_pnl_to_drawdown_ratio, Decimal("3.50"))
        self.assertEqual(policy.max_gross_exposure_pct_equity, Decimal("0.85"))
        self.assertEqual(policy.min_cash, Decimal("250"))

    def test_candidate_spec_contract_exposes_full_promotion_risk_parameters(
        self,
    ) -> None:
        policy = runner.ProfitTargetOraclePolicy(
            max_gross_exposure_pct_equity=Decimal("0.85"),
            min_cash=Decimal("250"),
            max_negative_cash_observation_count=0,
        )

        updated = runner._candidate_spec_with_oracle_policy(
            self._candidate_spec("spec-full-promotion-policy"),
            oracle_policy=policy,
        )

        self.assertEqual(
            updated.hard_vetoes["required_max_gross_exposure_pct_equity"],
            "0.85",
        )
        self.assertEqual(updated.hard_vetoes["required_min_cash"], "250")
        self.assertEqual(
            updated.hard_vetoes["required_max_negative_cash_observation_count"],
            "0",
        )
        self.assertEqual(
            updated.promotion_contract["profit_target_oracle_policy"][
                "max_gross_exposure_pct_equity"
            ],
            "0.85",
        )

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
                        "market_impact_stress_passed": True,
                        "market_impact_stress_artifact_ref": "feedback://market-impact",
                        "market_impact_stress_model": "almgren_chriss_proxy",
                        "market_impact_stress_cost_bps": "6",
                        "market_impact_stress_components": {
                            "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                            "selected_model": "almgren_chriss_proxy",
                            "selected_cost_bps": "6",
                        },
                        "nonlinear_market_impact_stress_passed": True,
                        "nonlinear_market_impact_stress_model": "almgren_chriss_proxy",
                        "nonlinear_market_impact_stress_cost_bps": "6",
                        "nonlinear_market_impact_stress_net_pnl_per_day": "500",
                        "market_impact_liquidity_evidence_present": True,
                        "market_impact_stress_net_pnl_per_day": "500",
                        "delay_adjusted_depth_stress_passed": True,
                        "delay_adjusted_depth_stress_artifact_ref": "feedback://delay-depth",
                        "delay_adjusted_depth_fillable_notional_per_day": "500000",
                        "delay_adjusted_depth_stress_net_pnl_per_day": "500",
                        "delay_adjusted_depth_fill_survival_evidence_present": True,
                        "delay_adjusted_depth_fill_survival_sample_count": 12,
                        "delay_adjusted_depth_fill_survival_rate": "0.85",
                        "queue_position_survival_fill_curve_evidence_present": True,
                        "queue_position_survival_sample_count": 12,
                        "queue_position_survival_fill_rate": "0.85",
                        "queue_position_survival_queue_ratio_p95": "0.25",
                        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                        "queue_position_survival_queue_ahead_depletion_sample_count": 12,
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 12,
                        "queue_ahead_depletion_evidence_present": True,
                        "queue_ahead_depletion_sample_count": 12,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "500",
                        "double_oos_passed": True,
                        "double_oos_artifact_ref": "feedback://double-oos",
                        "double_oos_independent_window_count": 2,
                        "double_oos_pass_rate": "1",
                        "double_oos_net_pnl_per_day": "500",
                        "double_oos_cost_shock_net_pnl_per_day": "500",
                        "implementation_uncertainty_stability_passed": True,
                        "implementation_uncertainty_lower_net_pnl_per_day": "500",
                        "conformal_tail_risk_passed": True,
                        "conformal_tail_risk_adjusted_net_pnl_per_day": "500",
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
            -727.5,
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

    def test_candidate_selection_keeps_active_loss_counter_candidate(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-active-loss-source")
        adaptive_base = self._candidate_spec(
            "spec-active-loss-adaptive",
            entry_minute_after_open="75",
        )
        adaptive_params = dict(
            cast(dict[str, Any], adaptive_base.strategy_overrides["params"])
        )
        adaptive_params["feedback_remediation_profile"] = (
            "adverse_selection_feedback_escape"
        )
        adaptive_spec = replace(
            adaptive_base,
            strategy_overrides={
                **adaptive_base.strategy_overrides,
                "params": adaptive_params,
            },
        )
        family_feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-active-loss-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-50",
                    "active_day_ratio": "0.67",
                    "positive_day_ratio": "0",
                    "negative_day_count": 2,
                    "decision_count": 4,
                    "filled_count": 4,
                    "avg_filled_notional_per_day": "40000",
                    "worst_day_loss": "90",
                    "max_drawdown": "130",
                    "daily_net": {
                        "2026-05-06": "-40",
                        "2026-05-07": "-90",
                    },
                },
            },
            dataset_snapshot_id="snap-active-loss-feedback",
            result_path="feedback://active-loss",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(adaptive_spec,),
            feedback_evidence_bundles=(family_feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_family_replay")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_active_loss_counter_candidate",
        )
        self.assertGreater(Decimal(str(rows[0]["proposal_score"])), Decimal("-999999"))

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(adaptive_spec,),
            proposal_rows=rows,
            top_k=0,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [adaptive_spec])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)
        self.assertEqual(
            selection["budget"]["active_loss_counter_candidate_selected_count"],
            1,
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "active_loss_counter_candidate",
        )

    def test_candidate_selection_keeps_positive_consistency_repair_candidate(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-consistency-source")
        repair_base = self._candidate_spec(
            "spec-consistency-repair",
            entry_minute_after_open="75",
        )
        repair_params = dict(
            cast(dict[str, Any], repair_base.strategy_overrides["params"])
        )
        repair_params["feedback_remediation_profile"] = (
            "consistency_guard_feedback_escape"
        )
        repair_spec = replace(
            repair_base,
            strategy_overrides={
                **repair_base.strategy_overrides,
                "params": repair_params,
            },
        )
        family_feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-consistency-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "900",
                    "active_day_ratio": "0.40",
                    "positive_day_ratio": "0.20",
                    "negative_day_count": 0,
                    "decision_count": 5,
                    "filled_count": 5,
                    "avg_filled_notional_per_day": "350000",
                    "best_day_share": "0.84",
                    "max_cluster_contribution_share": "0.70",
                    "worst_day_loss": "0",
                    "max_drawdown": "0",
                    "min_daily_net_pnl": "0",
                    "daily_net": {
                        "2026-05-06": "4500",
                        "2026-05-07": "0",
                    },
                },
            },
            dataset_snapshot_id="snap-consistency-feedback",
            result_path="feedback://consistency",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(repair_spec,),
            feedback_evidence_bundles=(family_feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_family_replay")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_consistency_repair_candidate",
        )
        self.assertGreater(Decimal(str(rows[0]["proposal_score"])), Decimal("-999999"))
        self.assertEqual(rows[0]["consistency_repair_tags"], ["loss_control_shortfall"])
        self.assertIn(
            "daily_coverage_shortfall",
            rows[0]["consistency_repair_feedback_reasons"],
        )
        self.assertIn(
            "loss_control_shortfall",
            rows[0]["consistency_repair_feedback_reasons"],
        )
        self.assertIn(
            "symbol_concentration_shortfall",
            rows[0]["consistency_repair_feedback_reasons"],
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(repair_spec,),
            proposal_rows=rows,
            top_k=0,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [repair_spec])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 1)
        self.assertEqual(
            selection["budget"]["consistency_repair_candidate_selected_count"],
            1,
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "consistency_repair_candidate",
        )

    def test_active_loss_counter_candidates_keep_relative_scores(
        self,
    ) -> None:
        source_spec = self._candidate_spec("spec-active-loss-score-source")
        daily_base = self._candidate_spec("spec-active-loss-score-daily")
        adverse_base = self._candidate_spec("spec-active-loss-score-adverse")
        daily_params = dict(
            cast(dict[str, Any], daily_base.strategy_overrides["params"])
        )
        daily_params["feedback_remediation_profile"] = "daily_coverage_feedback_escape"
        adverse_params = dict(
            cast(dict[str, Any], adverse_base.strategy_overrides["params"])
        )
        adverse_params["feedback_remediation_profile"] = (
            "adverse_selection_feedback_escape"
        )
        adverse_params["max_stop_loss_exits_per_session"] = "1"
        adverse_params["stop_loss_lockout_seconds"] = "2400"
        daily_spec = replace(
            daily_base,
            strategy_overrides={
                **daily_base.strategy_overrides,
                "params": daily_params,
            },
        )
        adverse_spec = replace(
            adverse_base,
            strategy_overrides={
                **adverse_base.strategy_overrides,
                "params": adverse_params,
            },
        )
        family_feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-active-loss-score-source",
                "family_template_id": source_spec.family_template_id,
                "runtime_family": source_spec.runtime_family,
                "runtime_strategy_name": source_spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "-50",
                    "active_day_ratio": "0.50",
                    "positive_day_ratio": "0",
                    "negative_day_count": 2,
                    "decision_count": 4,
                    "filled_count": 4,
                    "avg_filled_notional_per_day": "40000",
                    "worst_day_loss": "90",
                    "max_drawdown": "130",
                    "daily_net": {
                        "2026-05-06": "-40",
                        "2026-05-07": "-90",
                    },
                },
            },
            dataset_snapshot_id="snap-active-loss-score-feedback",
            result_path="feedback://active-loss-score",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(daily_spec, adverse_spec),
            feedback_evidence_bundles=(family_feedback_bundle,),
        )

        row_by_spec = {row["candidate_spec_id"]: row for row in rows}
        self.assertGreater(
            Decimal(str(row_by_spec[adverse_spec.candidate_spec_id]["proposal_score"])),
            Decimal(str(row_by_spec[daily_spec.candidate_spec_id]["proposal_score"])),
        )
        self.assertEqual(
            row_by_spec[adverse_spec.candidate_spec_id]["active_loss_counter_tags"],
            [
                "adverse_selection_shortfall",
                "daily_coverage_shortfall",
                "loss_control_shortfall",
                "notional_throughput_shortfall",
            ],
        )
        self.assertIn(
            "notional_throughput_shortfall",
            row_by_spec[adverse_spec.candidate_spec_id][
                "active_loss_counter_feedback_reasons"
            ],
        )

    def test_candidate_selection_caps_active_loss_counter_for_small_batches(
        self,
    ) -> None:
        active_breakout = replace(
            self._candidate_spec(
                "spec-active-breakout",
                family_template_id="breakout_reclaim_v2",
            ),
            runtime_family="breakout_continuation_consistent",
            runtime_strategy_name="breakout-continuation-long-v1",
        )
        active_microbar = replace(
            self._candidate_spec(
                "spec-active-microbar",
                family_template_id="microbar_cross_sectional_pairs_v1",
            ),
            runtime_family="microbar_cross_sectional_pairs",
            runtime_strategy_name="microbar-cross-sectional-pairs-v1",
        )
        active_late_day = replace(
            self._candidate_spec(
                "spec-active-late-day",
                family_template_id="late_day_continuation_v1",
            ),
            runtime_family="late_day_continuation_consistent",
            runtime_strategy_name="late-day-continuation-long-v1",
        )
        runtime_intraday = replace(
            self._candidate_spec(
                "spec-runtime-intraday",
                family_template_id="intraday_tsmom_v2",
            ),
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
        )
        runtime_late_day = replace(
            self._candidate_spec(
                "spec-runtime-late-day",
                family_template_id="opening_drive_leader_reclaim_v1",
            ),
            runtime_family="late_day_continuation_consistent",
            runtime_strategy_name="late-day-continuation-long-v1",
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(
                active_breakout,
                active_microbar,
                active_late_day,
                runtime_intraday,
                runtime_late_day,
            ),
            proposal_rows=[
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": index,
                    "proposal_score": 100.0 - index,
                    "selection_reason": "pre_replay_mlx_active_loss_counter_candidate",
                }
                for index, spec in enumerate(
                    (active_breakout, active_microbar, active_late_day),
                    start=1,
                )
            ]
            + [
                {
                    "candidate_spec_id": runtime_intraday.candidate_spec_id,
                    "rank": 4,
                    "proposal_score": 1.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
                {
                    "candidate_spec_id": runtime_late_day.candidate_spec_id,
                    "rank": 5,
                    "proposal_score": 0.5,
                    "selection_reason": "pre_replay_mlx_rank",
                },
            ],
            top_k=0,
            exploration_slots=4,
            max_candidates=4,
            portfolio_size_min=2,
        )

        selected_reasons = {
            row["candidate_spec_id"]: row["selection_reason"]
            for row in selection["rows"]
            if row["selected_for_replay"]
        }
        self.assertEqual(len(selected), 4)
        self.assertEqual(
            selection["budget"]["active_loss_counter_candidate_selected_count"],
            2,
        )
        self.assertEqual(
            sum(
                1
                for reason in selected_reasons.values()
                if reason == "active_loss_counter_candidate"
            ),
            2,
        )
        self.assertGreaterEqual(
            sum(
                1
                for reason in selected_reasons.values()
                if reason == "runtime_strategy_floor"
            ),
            1,
        )

    def test_candidate_selection_blocks_no_activity_feedback_from_reaudit(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-no-activity-feedback")
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=spec.candidate_spec_id,
            candidate={
                "candidate_id": "cand-no-activity-feedback",
                "family_template_id": spec.family_template_id,
                "runtime_family": spec.runtime_family,
                "runtime_strategy_name": spec.runtime_strategy_name,
                "objective_scorecard": {
                    "net_pnl_per_day": "75",
                    "active_day_ratio": "0",
                    "positive_day_ratio": "0",
                    "decision_count": 0,
                    "filled_count": 0,
                    "orders_submitted_count": 0,
                    "avg_filled_notional_per_day": "0",
                },
            },
            dataset_snapshot_id="snap-no-activity-feedback",
            result_path="feedback://no-activity",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_real_replay")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_no_activity_feedback_blocked",
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=0,
            feedback_block_reaudit_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(
            selection["budget"]["feedback_block_reaudit_selected_count"], 0
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_no_activity_feedback_blocked",
        )

    def test_candidate_selection_blocks_failed_false_negative_rescue_family(
        self,
    ) -> None:
        source_spec_base = self._candidate_spec(
            "spec-fn-rescue-negative-source",
            selection_mode="continuation",
        )
        source_params = cast(
            dict[str, Any], source_spec_base.strategy_overrides["params"]
        )
        source_spec = replace(
            source_spec_base,
            parameter_space={
                "mechanism_overlay_ids": ["rejected_signal_outcome_calibration"]
            },
            strategy_overrides={
                **source_spec_base.strategy_overrides,
                "params": {
                    **source_params,
                    "signal_motif": "rejected_signal_false_negative_replay",
                    "outcome_label_filter": "profitable_after_costs",
                    "veto_relaxation_scope": "labeled_false_negative_only",
                    "rank_feature": "rejected_signal_counterfactual_return_rank",
                },
            },
        )
        probe_spec_base = self._candidate_spec(
            "spec-fn-rescue-negative-probe",
            selection_mode="continuation",
        )
        probe_params = cast(
            dict[str, Any], probe_spec_base.strategy_overrides["params"]
        )
        probe_spec = replace(
            probe_spec_base,
            parameter_space={
                "mechanism_overlay_ids": ["rejected_signal_outcome_calibration"]
            },
            strategy_overrides={
                **probe_spec_base.strategy_overrides,
                "params": {
                    **probe_params,
                    "signal_motif": "rejected_signal_false_negative_replay",
                    "outcome_label_filter": "profitable_after_costs",
                    "veto_relaxation_scope": "labeled_false_negative_only",
                    "rank_feature": "rejected_signal_opening_drive_rank",
                },
            },
        )
        feedback_bundle = runner.evidence_bundle_from_frontier_candidate(
            candidate_spec_id=source_spec.candidate_spec_id,
            candidate=runner._candidate_payload_with_feedback_metadata(
                spec=source_spec,
                candidate={
                    "candidate_id": "cand-fn-rescue-negative-source",
                    "objective_scorecard": {
                        "net_pnl_per_day": "-47.54",
                        "active_day_ratio": "0.66",
                        "positive_day_ratio": "0",
                        "negative_day_count": 3,
                        "daily_net": {
                            "2026-05-06": "-77.11",
                            "2026-05-07": "-65.51",
                        },
                    },
                },
            ),
            dataset_snapshot_id="snap-fn-rescue-negative-feedback",
            result_path="feedback://fn-rescue-negative",
        )

        _model, rows = runner._pre_replay_proposal_model_and_rows(
            specs=(probe_spec,),
            feedback_evidence_bundles=(feedback_bundle,),
        )

        self.assertEqual(rows[0]["training_source"], "feedback_family_replay")
        self.assertEqual(
            rows[0]["selection_reason"],
            "pre_replay_mlx_false_negative_rescue_feedback_blocked",
        )
        self.assertLessEqual(
            Decimal(str(rows[0]["proposal_score"])), Decimal("-999999")
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(probe_spec,),
            proposal_rows=rows,
            top_k=1,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["selected_count"], 0)
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_mlx_false_negative_rescue_feedback_blocked",
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
        self.assertEqual(
            row_by_spec[feedback_spec.candidate_spec_id]["replay_order"], 1
        )
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

    def test_feedback_risk_profile_uses_oracle_policy_and_allows_down_days(
        self,
    ) -> None:
        policy = runner.ProfitTargetOraclePolicy(
            min_active_day_ratio=Decimal("0.90"),
            min_positive_day_ratio=Decimal("0.60"),
            max_best_day_share=Decimal("0.25"),
            max_single_symbol_contribution_share=Decimal("0.35"),
            max_cluster_contribution_share=Decimal("0.40"),
            max_gross_exposure_pct_equity=Decimal("1.25"),
            min_cash=Decimal("-10"),
            max_negative_cash_observation_count=1,
        )
        scorecard = {
            "net_pnl_per_day": "250",
            "active_day_ratio": "0.95",
            "positive_day_ratio": "0.65",
            "best_day_share": "0.20",
            "max_single_day_contribution_share": "0.20",
            "max_single_symbol_contribution_share": "0.30",
            "max_cluster_contribution_share": "0.35",
            "max_gross_exposure_pct_equity": "1.10",
            "min_cash": "-5",
            "negative_cash_observation_count": "1",
            "negative_day_count": "1",
            "daily_net": {
                "2026-05-01": "-50",
                "2026-05-02": "300",
            },
        }

        self.assertFalse(
            runner._feedback_risk_profile_has_penalty(scorecard, oracle_policy=policy)
        )
        self.assertFalse(runner._feedback_is_blocked(scorecard, oracle_policy=policy))
        self.assertFalse(
            runner._feedback_family_prior_has_hard_block(
                scorecard, oracle_policy=policy
            )
        )
        self.assertFalse(
            runner._feedback_risk_profile_has_terminal_block(
                {
                    **scorecard,
                    "profit_target_oracle": {
                        "blockers": ["max_single_day_contribution_share_failed"]
                    },
                },
                oracle_policy=policy,
            )
        )

        strict_policy = replace(
            policy,
            max_gross_exposure_pct_equity=Decimal("1.0"),
            min_cash=Decimal("0"),
            max_negative_cash_observation_count=0,
        )
        self.assertTrue(
            runner._feedback_is_blocked(scorecard, oracle_policy=strict_policy)
        )
        self.assertTrue(
            runner._feedback_risk_profile_has_penalty(
                {
                    "active_day_ratio": "1",
                    "positive_day_ratio": "1",
                    "best_day_share": "0.20",
                },
                oracle_policy=policy,
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

            with patch.object(runner, "_current_code_commit", return_value="abc123"):
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
        self.assertEqual(replay.evidence_bundles[0].code_commit, "abc123")
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

    def test_current_code_commit_uses_git_when_env_commit_is_missing(self) -> None:
        rev_parse = runner.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=0,
            stdout="abc123\n",
        )
        clean_diff = runner.subprocess.CompletedProcess(
            args=("git", "diff", "--quiet"),
            returncode=0,
            stdout="",
        )
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(
                runner.subprocess,
                "run",
                side_effect=[rev_parse, clean_diff, clean_diff],
            ) as run,
        ):
            self.assertEqual(runner._current_code_commit(), "abc123")

        self.assertEqual(run.call_count, 3)

    def test_current_code_commit_prefers_env_commit(self) -> None:
        with (
            patch.object(
                runner.os,
                "getenv",
                side_effect=lambda name: (
                    "env123" if name == "TORGHUT_CODE_COMMIT" else ""
                ),
            ),
            patch.object(runner.subprocess, "run") as run,
        ):
            self.assertEqual(runner._current_code_commit(), "env123")

        run.assert_not_called()

    def test_current_code_commit_marks_dirty_or_unknown_git_state(self) -> None:
        rev_parse = runner.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=0,
            stdout="abc123\n",
        )
        dirty_diff = runner.subprocess.CompletedProcess(
            args=("git", "diff", "--quiet"),
            returncode=1,
            stdout="",
        )
        bad_rev_parse = runner.subprocess.CompletedProcess(
            args=("git", "rev-parse", "HEAD"),
            returncode=128,
            stdout="",
        )
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(
                runner.subprocess,
                "run",
                side_effect=[rev_parse, dirty_diff],
            ),
        ):
            self.assertEqual(runner._current_code_commit(), "abc123-dirty")
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(runner.subprocess, "run", side_effect=OSError("git missing")),
        ):
            self.assertEqual(runner._current_code_commit(), "unknown")
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(runner.subprocess, "run", return_value=bad_rev_parse),
        ):
            self.assertEqual(runner._current_code_commit(), "unknown")
        with (
            patch.object(runner.os, "getenv", return_value=""),
            patch.object(
                runner.subprocess,
                "run",
                side_effect=[rev_parse, OSError("diff missing")],
            ),
        ):
            self.assertEqual(runner._current_code_commit(), "abc123-dirty")

    def test_synthetic_replay_evidence_carries_code_commit(self) -> None:
        spec = self._candidate_spec("spec-synthetic-replay-code-commit")
        with TemporaryDirectory() as tmpdir:
            with patch.object(
                runner, "_current_code_commit", return_value="synthetic123"
            ):
                replay = runner._run_synthetic_replay(
                    specs=(spec,),
                    output_dir=Path(tmpdir),
                    max_candidates=1,
                )

        self.assertEqual(len(replay.evidence_bundles), 1)
        self.assertEqual(replay.evidence_bundles[0].code_commit, "synthetic123")

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

    def test_candidate_selection_blocks_capacity_short_synthetic_probe(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-capacity-short-synthetic-prior-probe")

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
                    "features": {
                        "configured_daily_notional_required_ratio": 0.2,
                    },
                }
            ],
            top_k=1,
            exploration_slots=1,
            max_candidates=1,
            portfolio_size_min=1,
        )

        self.assertEqual(selected, [])
        self.assertEqual(selection["budget"]["eligible_candidate_count"], 0)
        self.assertEqual(
            selection["budget"][
                "pre_replay_synthetic_capacity_insufficient_candidate_count"
            ],
            1,
        )
        self.assertEqual(
            selection["budget"]["pre_replay_nonpositive_synthetic_exploration_count"],
            0,
        )
        self.assertEqual(
            selection["rows"][0]["selection_reason"],
            "pre_replay_synthetic_capacity_insufficient",
        )

    def test_real_replay_evidence_promotes_summary_activity_counts(self) -> None:
        with TemporaryDirectory() as tmp:
            result_path = Path(tmp) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "summary": {
                            "decision_count": 0,
                            "filled_count": 0,
                            "orders_submitted_count": 0,
                            "avg_filled_notional_per_day": "0",
                        },
                        "top": [
                            {
                                "candidate_id": "cand-summary-activity",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "0",
                                    "active_day_ratio": "0",
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            replay = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "result_path": str(result_path),
                            "candidate_spec_id": "spec-summary-activity",
                            "dataset_snapshot_id": "real-summary-activity",
                        }
                    ]
                }
            )

        self.assertEqual(len(replay.evidence_bundles), 1)
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(scorecard["decision_count"], 0)
        self.assertEqual(scorecard["filled_count"], 0)
        self.assertEqual(scorecard["orders_submitted_count"], 0)
        self.assertEqual(scorecard["avg_filled_notional_per_day"], "0")

    def test_real_replay_evidence_derives_activity_counts_from_decomposition(
        self,
    ) -> None:
        with TemporaryDirectory() as tmp:
            result_path = Path(tmp) / "result.json"
            result_path.write_text(
                json.dumps(
                    {
                        "top": [
                            {
                                "candidate_id": "cand-decomposition-activity",
                                "objective_scorecard": {
                                    "net_pnl_per_day": "-13.37",
                                    "active_day_ratio": "0",
                                },
                                "decomposition": {
                                    "families": {
                                        "opening_drive_leader_reclaim_v1": {
                                            "evaluations": 2,
                                            "fills": 2,
                                        }
                                    },
                                    "symbols": {
                                        "NVDA": {
                                            "filled_count": 2,
                                            "net_pnl": "-40.13",
                                        }
                                    },
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            replay = runner._real_replay_result_from_factory_payload(
                {
                    "experiments": [
                        {
                            "result_path": str(result_path),
                            "candidate_spec_id": "spec-decomposition-activity",
                            "dataset_snapshot_id": "real-decomposition-activity",
                        }
                    ]
                }
            )

        self.assertEqual(len(replay.evidence_bundles), 1)
        scorecard = replay.evidence_bundles[0].objective_scorecard
        self.assertEqual(scorecard["decision_count"], 2)
        self.assertEqual(scorecard["filled_count"], 2)
        self.assertEqual(scorecard["filled_order_count"], 2)

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
        with TemporaryDirectory() as tmpdir, _compact_recent_whitepaper_sources(4):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.epoch_id = "whitepaper-autoresearch-test-epoch"
            args.max_candidates = 4
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 8
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
            candidate_board = json.loads(
                (output_dir / "candidate-board.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                candidate_board["schema_version"],
                "torghut.profit-candidate-board.v1",
            )
            self.assertEqual(
                candidate_board["current_answer"], "no_promotion_ready_candidate"
            )
            self.assertEqual(candidate_board["best_research_candidate"]["rank"], 1)
            self.assertTrue(candidate_board["best_research_candidate"]["blockers"])
            self.assertEqual(summary["candidate_board"], candidate_board)
            self.assertEqual(
                summary["artifacts"]["candidate_board"],
                str((output_dir / "candidate-board.json").resolve()),
            )
            paper_probation_handoff = json.loads(
                (output_dir / "paper-probation-handoff.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                paper_probation_handoff["schema_version"],
                "torghut.paper-probation-handoff.v1",
            )
            self.assertFalse(paper_probation_handoff["promotion_allowed"])
            self.assertFalse(paper_probation_handoff["final_promotion_allowed"])
            self.assertEqual(
                paper_probation_handoff["runtime_window_import_plan"],
                candidate_board["runtime_window_import_plan"],
            )
            self.assertEqual(
                summary["paper_probation_handoff"],
                paper_probation_handoff,
            )
            self.assertEqual(
                summary["artifacts"]["paper_probation_handoff"],
                str((output_dir / "paper-probation-handoff.json").resolve()),
            )
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
            self.assertTrue((output_dir / "selected-candidate-specs.jsonl").exists())
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
            self.assertEqual(
                payload["artifacts"]["selected_candidate_specs"],
                str((output_dir / "selected-candidate-specs.jsonl").resolve()),
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
            self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v7")
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
            selected_candidate_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            self.assertEqual(
                [spec["candidate_spec_id"] for spec in selected_candidate_specs],
                selection["selected_candidate_spec_ids"],
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

    def test_selection_only_writes_pre_replay_artifacts_without_replay_or_persistence(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            args = self._source_jsonl_args(output_dir)
            args.epoch_id = "whitepaper-autoresearch-selection-only"
            args.replay_mode = "real"
            args.persist_results = True
            args.selection_only = True
            args.max_candidates = 4
            args.top_k = 2

            with (
                patch.object(
                    runner,
                    "_run_replay_with_optional_timeout",
                    side_effect=AssertionError("selection-only must not run replay"),
                ) as replay_mock,
                patch.object(
                    runner,
                    "_persist_vnext_specs",
                    side_effect=AssertionError("selection-only must not persist specs"),
                ) as persist_mock,
                patch.object(
                    runner,
                    "_persist_epoch_ledgers",
                    side_effect=AssertionError(
                        "selection-only must not persist epoch ledgers"
                    ),
                ) as ledger_mock,
                patch.object(
                    runner,
                    "optimize_portfolio_candidate",
                    side_effect=AssertionError(
                        "selection-only must not optimize a portfolio"
                    ),
                ) as optimizer_mock,
                patch.object(
                    runner,
                    "_runtime_closure_payload",
                    side_effect=AssertionError(
                        "selection-only must not build runtime closure"
                    ),
                ) as runtime_mock,
            ):
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

            summary = json.loads(
                (output_dir / "summary.json").read_text(encoding="utf-8")
            )

            self.assertTrue((output_dir / "epoch-manifest.json").exists())
            self.assertTrue((output_dir / "whitepaper-sources.jsonl").exists())
            self.assertTrue((output_dir / "hypothesis-cards.jsonl").exists())
            self.assertTrue((output_dir / "candidate-specs.jsonl").exists())
            self.assertTrue((output_dir / "candidate-compiler-report.json").exists())
            self.assertTrue(
                (output_dir / "feedback-evidence-source-manifest.json").exists()
            )
            self.assertTrue((output_dir / "pre-replay-mlx-ranker-model.json").exists())
            self.assertTrue(
                (output_dir / "pre-replay-mlx-proposal-scores.jsonl").exists()
            )
            self.assertTrue((output_dir / "candidate-selection-manifest.json").exists())
            self.assertTrue((output_dir / "selected-candidate-specs.jsonl").exists())
            self.assertTrue(
                (output_dir / "whitepaper-autoresearch-diagnostics.ipynb").exists()
            )
            self.assertFalse((output_dir / "strategy-factory").exists())
            self.assertFalse((output_dir / "synthetic-replays").exists())
            self.assertFalse((output_dir / "candidate-evidence-bundles.jsonl").exists())
            self.assertFalse((output_dir / "mlx-ranker-model.json").exists())
            self.assertFalse((output_dir / "mlx-proposal-scores.jsonl").exists())
            self.assertFalse((output_dir / "portfolio-candidates.jsonl").exists())
            self.assertFalse((output_dir / "portfolio-optimizer-report.json").exists())
            self.assertFalse((output_dir / "candidate-board.json").exists())
            self.assertFalse((output_dir / "profitability-search-goal.json").exists())
            self.assertFalse((output_dir / "runtime-closure" / "summary.json").exists())
            selected_candidate_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]

        self.assertEqual(payload["status"], "selection_only")
        self.assertEqual(payload["status_reason"], "pre_replay_selection_only")
        self.assertEqual(payload["epoch_id"], "whitepaper-autoresearch-selection-only")
        self.assertEqual(summary["status"], "selection_only")
        self.assertFalse(payload["oracle_candidate_found"])
        self.assertFalse(payload["promotion_readiness"]["promotable"])
        self.assertIn(
            "real_replay_not_run",
            payload["promotion_readiness"]["blockers"],
        )
        self.assertGreater(payload["candidate_spec_count"], 0)
        self.assertGreater(payload["pre_replay_proposal_score_count"], 0)
        self.assertGreater(payload["replay_candidate_spec_count"], 0)
        self.assertEqual(
            payload["artifacts"]["selected_candidate_specs"],
            str((output_dir / "selected-candidate-specs.jsonl").resolve()),
        )
        self.assertEqual(
            [spec["candidate_spec_id"] for spec in selected_candidate_specs],
            payload["selected_candidate_spec_ids"],
        )
        replay_mock.assert_not_called()
        persist_mock.assert_not_called()
        ledger_mock.assert_not_called()
        optimizer_mock.assert_not_called()
        runtime_mock.assert_not_called()

    def test_replay_tape_preview_narrows_direct_specs_without_promotion_proof(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            specs_path = root / "candidate-specs.jsonl"
            tape_path = root / "preview-tape.jsonl"
            base_nvda = self._candidate_spec("spec-nvda-continuation")
            nvda_spec = replace(
                base_nvda,
                strategy_overrides={
                    **base_nvda.strategy_overrides,
                    "universe_symbols": ["NVDA"],
                },
            )
            base_aapl = self._candidate_spec("spec-aapl-continuation")
            aapl_spec = replace(
                base_aapl,
                strategy_overrides={
                    **base_aapl.strategy_overrides,
                    "universe_symbols": ["AAPL"],
                },
            )
            specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True)
                    for spec in (nvda_spec, aapl_spec)
                )
                + "\n",
                encoding="utf-8",
            )
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                        symbol=symbol,
                        timeframe="1Sec",
                        seq=seq,
                        source="ta",
                        payload={
                            "price": Decimal(price),
                            "spread_bps": Decimal("2"),
                        },
                    )
                    for seq, (day, symbol, price) in enumerate(
                        (
                            (23, "NVDA", "100"),
                            (24, "NVDA", "101"),
                            (25, "NVDA", "102"),
                            (26, "NVDA", "103"),
                            (27, "NVDA", "104"),
                        ),
                        start=1,
                    )
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="preview-snapshot",
                symbols=("NVDA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 27),
                source_query_digest=build_source_query_digest({"query": "preview"}),
            )
            args = self._args(output_dir)
            args.candidate_specs = [specs_path]
            args.seed_recent_whitepapers = False
            args.replay_mode = "real"
            args.selection_only = True
            args.replay_tape_path = tape_path
            args.replay_tape_preview_top_k = 1
            args.symbols = "NVDA"

            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            selected_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            preview_scores_exists = (
                output_dir / "replay-tape-preview-scores.jsonl"
            ).exists()

        self.assertEqual(payload["status"], "selection_only")
        self.assertEqual(payload["replay_candidate_spec_count"], 1)
        self.assertEqual(
            selection["selected_candidate_spec_ids"], ["spec-nvda-continuation"]
        )
        self.assertEqual(
            [spec["candidate_spec_id"] for spec in selected_specs],
            ["spec-nvda-continuation"],
        )
        self.assertFalse(selection["replay_tape_preview"]["promotion_proof"])
        self.assertIn(
            "exact_replay_required", selection["replay_tape_preview"]["blockers"]
        )
        self.assertTrue(preview_scores_exists)
        aapl_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == "spec-aapl-continuation"
        )
        self.assertTrue(aapl_row["pre_fast_replay_preview_selected_for_replay"])
        self.assertFalse(aapl_row["selected_for_replay"])
        self.assertEqual(aapl_row["selection_reason"], "fast_replay_preview_filtered")

    def test_materialize_replay_tape_writes_run_artifacts_and_updates_args(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            strategy_configmap = root / "strategy-configmap.yaml"
            strategy_configmap.write_text("{}", encoding="utf-8")
            args = self._args(output_dir)
            args.strategy_configmap = strategy_configmap
            args.replay_mode = "real"
            args.materialize_replay_tape = True
            args.symbols = "NVDA"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    timeframe="1Sec",
                    seq=seq,
                    source="ta",
                    payload={"price": Decimal("100"), "spread": Decimal("0.01")},
                )
                for seq, day in enumerate(range(23, 28), start=1)
            ]

            with patch.object(
                runner.replay_mod, "_iter_signal_rows", return_value=rows
            ):
                updated_args, receipt = runner._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-materialized",
                )
            tape = runner.load_replay_tape(updated_args.replay_tape_path)
            self.assertIsNotNone(receipt)
            assert receipt is not None
            self.assertEqual(
                updated_args.replay_tape_path, output_dir / "replay-tape.jsonl"
            )
            self.assertEqual(
                updated_args.replay_tape_manifest,
                output_dir / "replay-tape.jsonl.manifest.json",
            )
            self.assertEqual(receipt["status"], "materialized")
            self.assertEqual(receipt["row_count"], 5)
            self.assertEqual(receipt["row_symbols"], ["NVDA"])
            self.assertTrue((output_dir / "replay-tape-receipt.json").exists())
            self.assertEqual(tape.manifest.dataset_snapshot_ref, "epoch-materialized")
            self.assertEqual(tape.manifest.row_count, 5)
            self.assertEqual(tape.manifest.missing_trading_days, ())

    def test_materialize_replay_tape_fails_closed_on_missing_days(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            strategy_configmap = root / "strategy-configmap.yaml"
            strategy_configmap.write_text("{}", encoding="utf-8")
            args = self._args(output_dir)
            args.strategy_configmap = strategy_configmap
            args.replay_mode = "real"
            args.materialize_replay_tape = True
            args.symbols = "NVDA"
            rows = [
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    timeframe="1Sec",
                    seq=1,
                    source="ta",
                    payload={"price": Decimal("100"), "spread": Decimal("0.01")},
                )
            ]

            with patch.object(
                runner.replay_mod, "_iter_signal_rows", return_value=rows
            ):
                with self.assertRaisesRegex(
                    ValueError,
                    "replay_tape_incomplete_coverage:missing_days=2026-02-24,2026-02-25,2026-02-26,2026-02-27",
                ):
                    runner._maybe_materialize_epoch_replay_tape(
                        args=args,
                        output_dir=output_dir,
                        epoch_id="epoch-materialized",
                    )

            self.assertFalse((output_dir / "replay-tape.jsonl").exists())
            self.assertFalse((output_dir / "replay-tape.jsonl.manifest.json").exists())

    def test_materialize_replay_tape_skips_provided_tape_and_fails_closed(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            output_dir.mkdir()
            args = self._args(output_dir)
            args.materialize_replay_tape = True
            args.replay_tape_path = root / "provided-tape.jsonl"

            updated_args, receipt = runner._maybe_materialize_epoch_replay_tape(
                args=args,
                output_dir=output_dir,
                epoch_id="epoch-skip",
            )

            self.assertIs(updated_args, args)
            self.assertIsNone(receipt)

            args.replay_tape_path = None
            args.replay_mode = "synthetic"
            with self.assertRaisesRegex(
                ValueError, "replay_tape_materialization_requires_real_replay"
            ):
                runner._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-synthetic",
                )

            args.replay_mode = "real"
            args.selection_only = True
            with self.assertRaisesRegex(
                ValueError, "replay_tape_materialization_requires_replay_execution"
            ):
                runner._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-selection-only",
                )

            args.selection_only = False
            args.full_window_start_date = ""
            with self.assertRaisesRegex(
                ValueError,
                "replay_tape_materialization_requires_full_window_start_date",
            ):
                runner._maybe_materialize_epoch_replay_tape(
                    args=args,
                    output_dir=output_dir,
                    epoch_id="epoch-missing-window",
                )

    def test_replay_tape_preview_error_paths_and_fallback_selection(self) -> None:
        with TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            output_dir = root / "epoch"
            tape_path = root / "preview-tape.jsonl"
            materialize_signal_tape(
                rows=[
                    SignalEnvelope(
                        event_ts=datetime(2026, 2, day, 15, 30, tzinfo=timezone.utc),
                        symbol="NVDA",
                        timeframe="1Sec",
                        seq=seq,
                        source="ta",
                        payload={"price": Decimal("100")},
                    )
                    for seq, day in enumerate(range(23, 28), start=1)
                ],
                tape_path=tape_path,
                dataset_snapshot_ref="preview-snapshot",
                symbols=("NVDA",),
                start_date=date(2026, 2, 23),
                end_date=date(2026, 2, 27),
                source_query_digest=build_source_query_digest({"query": "preview"}),
            )
            spec = self._candidate_spec("spec-preview-fallback")
            selection = {
                "selected_candidate_spec_ids": [spec.candidate_spec_id],
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ],
                "budget": {"selected_count": 1},
            }
            args = self._args(output_dir)
            args.replay_tape_preview_top_k = 1
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_real_replay"
            ):
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )
            args.replay_mode = "real"
            args.replay_tape_path = None
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_replay_tape_path"
            ):
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )
            args.replay_tape_path = tape_path
            args.full_window_start_date = ""
            with self.assertRaisesRegex(
                ValueError, "fast_replay_preview_requires_full_window_start_date"
            ):
                runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )

            class UnknownPreview:
                selected_candidate_spec_ids = ("missing-spec",)
                rows = ()

                def to_manifest_payload(self) -> dict[str, object]:
                    return {
                        "schema_version": "torghut.fast-replay-preview.v1",
                        "promotion_proof": False,
                    }

            args.full_window_start_date = "2026-02-23"
            args.symbols = "NVDA"
            with patch.object(
                runner,
                "build_fast_replay_preview",
                return_value=UnknownPreview(),
            ):
                narrowed, updated = runner._apply_fast_replay_preview_narrowing(
                    args=args,
                    output_dir=output_dir,
                    specs=[spec],
                    candidate_selection=selection,
                )

        self.assertEqual(
            [item.candidate_spec_id for item in narrowed], [spec.candidate_spec_id]
        )
        self.assertEqual(
            updated["selected_candidate_spec_ids"], [spec.candidate_spec_id]
        )

    def test_fast_replay_preview_covers_signal_field_fallbacks(self) -> None:
        no_universe_spec = replace(
            self._candidate_spec("spec-no-universe"),
            runtime_strategy_name="NVDA",
            strategy_overrides={
                "params": {
                    "selection_mode": "continuation",
                    "signal_motif": "opening_continuation",
                }
            },
        )
        self.assertEqual(fast_replay._candidate_symbols(no_universe_spec), ("NVDA",))
        self.assertEqual(fast_replay._candidate_direction(no_universe_spec), 1.0)
        self.assertEqual(
            fast_replay._extract_price(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"bid": Decimal("100"), "ask": Decimal("102")},
                )
            ),
            101.0,
        )
        self.assertIsNone(
            fast_replay._extract_price(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={},
                )
            )
        )
        bid_ask_spread = fast_replay._extract_spread_bps(
            SignalEnvelope(
                event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                symbol="NVDA",
                payload={"bid": Decimal("100"), "ask": Decimal("101")},
            )
        )
        self.assertAlmostEqual(bid_ask_spread or 0.0, 99.50248756218905)
        self.assertEqual(
            fast_replay._extract_spread_bps(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={"price": Decimal("100"), "spread": Decimal("0.05")},
                )
            ),
            5.0,
        )
        self.assertIsNone(
            fast_replay._extract_spread_bps(
                SignalEnvelope(
                    event_ts=datetime(2026, 2, 23, 15, 30, tzinfo=timezone.utc),
                    symbol="NVDA",
                    payload={},
                )
            )
        )
        self.assertIsNone(fast_replay._float_or_none("not-a-number"))
        self.assertIsNone(fast_replay._float_or_none(float("nan")))
        self.assertEqual(fast_replay._mapping("not-a-mapping"), {})

    def test_candidate_specs_replay_skips_compiler_and_replays_selected_specs(
        self,
    ) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            selected_specs_path = Path(tmpdir) / "selected-candidate-specs.jsonl"
            direct_a_base = self._candidate_spec("spec-direct-a")
            direct_a_spec = replace(
                direct_a_base,
                feature_contract={
                    **direct_a_base.feature_contract,
                    "source_claims": [
                        {
                            "claim_id": "direct-route-tca-required",
                            "claim_type": "execution_assumption",
                            "data_requirements": ["route_tca"],
                        }
                    ],
                },
                parameter_space={
                    "mechanism_overlay_ids": ["queue_position_survival_fill_curve"]
                },
                promotion_contract={
                    "requires_route_tca": True,
                    "requires_runtime_ledger": True,
                },
            )
            specs = (
                direct_a_spec,
                self._candidate_spec(
                    "spec-direct-b",
                    family_template_id="momentum_pullback_v1",
                    selection_mode="pullback",
                ),
            )
            selected_specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True) for spec in specs
                )
                + "\n",
                encoding="utf-8",
            )
            captured_spec_ids: list[str] = []

            def fake_replay(
                *,
                args: Namespace,
                output_dir: Path,
                specs: Sequence[runner.CandidateSpec],
            ) -> runner.EpochReplayResult:
                del args
                captured_spec_ids.extend(spec.candidate_spec_id for spec in specs)
                bundle = runner.evidence_bundle_from_frontier_candidate(
                    candidate_spec_id=specs[0].candidate_spec_id,
                    candidate={
                        "candidate_id": "cand-direct-a",
                        "objective_scorecard": {
                            "net_pnl_per_day": "25",
                            "active_day_ratio": "1",
                            "positive_day_ratio": "1",
                            "exact_replay_ledger_artifact_ref": "direct-exact-ledger.json",
                            "runtime_ledger_artifact_ref": "direct-runtime-ledger.json",
                            "runtime_ledger_artifact_row_count": 12,
                            "runtime_ledger_artifact_fill_count": 4,
                            "runtime_window_start": "2026-05-18T13:30:00+00:00",
                            "runtime_window_end": "2026-05-18T20:00:00+00:00",
                        },
                    },
                    dataset_snapshot_id="snap-direct",
                    result_path=str(output_dir / "direct-a.json"),
                )
                return runner.EpochReplayResult(
                    evidence_bundles=(bundle,),
                    replay_results=({"status": "ok"},),
                )

            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.candidate_specs = [selected_specs_path]
            args.replay_mode = "real"
            args.portfolio_size_min = 1

            with (
                patch.object(
                    runner,
                    "compile_sources_to_hypothesis_cards",
                    side_effect=AssertionError("source compiler must not run"),
                ) as source_compiler_mock,
                patch.object(
                    runner,
                    "compile_whitepaper_candidate_specs",
                    side_effect=AssertionError("candidate compiler must not run"),
                ) as candidate_compiler_mock,
                patch.object(
                    runner,
                    "_select_candidate_specs_for_replay",
                    side_effect=AssertionError("selection must not run"),
                ) as selection_mock,
                patch.object(
                    runner,
                    "_run_replay_with_optional_timeout",
                    side_effect=fake_replay,
                ) as replay_mock,
            ):
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            selected_candidate_specs = [
                json.loads(line)
                for line in (output_dir / "selected-candidate-specs.jsonl")
                .read_text(encoding="utf-8")
                .splitlines()
                if line
            ]
            compiler_report = json.loads(
                (output_dir / "candidate-compiler-report.json").read_text(
                    encoding="utf-8"
                )
            )
            profitability_goal = json.loads(
                (output_dir / "profitability-search-goal.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(captured_spec_ids, ["spec-direct-a", "spec-direct-b"])
        self.assertEqual(payload["candidate_spec_count"], 2)
        self.assertEqual(payload["replay_candidate_spec_count"], 2)
        self.assertEqual(
            payload["selected_candidate_spec_ids"], ["spec-direct-a", "spec-direct-b"]
        )
        self.assertEqual(selection["selection_mode"], "direct_candidate_specs_handoff")
        self.assertEqual(
            selection["selected_candidate_spec_ids"],
            ["spec-direct-a", "spec-direct-b"],
        )
        direct_selection_row = next(
            row
            for row in selection["rows"]
            if row["candidate_spec_id"] == "spec-direct-a"
        )
        self.assertGreater(
            Decimal(str(direct_selection_row["paper_contract_prior_score"])),
            Decimal("0"),
        )
        self.assertEqual(
            direct_selection_row["paper_mechanism_overlay_ids"],
            ["queue_position_survival_fill_curve"],
        )
        self.assertIn(
            "runtime_ledger", direct_selection_row["paper_required_evidence_tokens"]
        )
        self.assertEqual(
            [spec["candidate_spec_id"] for spec in selected_candidate_specs],
            ["spec-direct-a", "spec-direct-b"],
        )
        self.assertEqual(
            compiler_report["status"], "loaded_candidate_specs_for_direct_replay"
        )
        self.assertEqual(
            profitability_goal["recommended_next_epoch"][
                "direct_candidate_specs_artifacts"
            ],
            [str(selected_specs_path)],
        )
        self.assertIn(
            "--candidate-specs",
            profitability_goal["recommended_next_epoch"]["argv"],
        )
        self.assertIn(
            str(selected_specs_path),
            profitability_goal["recommended_next_epoch"]["argv"],
        )
        direct_sleeve_row = next(
            row
            for row in profitability_goal["sleeve_plan"]["rows"]
            if row["candidate_spec_id"] == "spec-direct-a"
        )
        self.assertEqual(
            direct_sleeve_row["replay_selection_reason"],
            "direct_candidate_specs_handoff",
        )
        self.assertTrue(direct_sleeve_row["paper_contract_candidate"])
        self.assertTrue(direct_sleeve_row["paper_contract_selected_for_replay"])
        self.assertEqual(
            direct_sleeve_row["paper_mechanism_overlay_ids"],
            ["queue_position_survival_fill_curve"],
        )
        self.assertIn(
            "runtime_ledger", direct_sleeve_row["paper_required_evidence_tokens"]
        )
        self.assertEqual(
            direct_sleeve_row["runtime_ledger_artifact_refs"],
            ["direct-exact-ledger.json", "direct-runtime-ledger.json"],
        )
        self.assertEqual(direct_sleeve_row["runtime_ledger_artifact_row_count"], 12)
        self.assertEqual(direct_sleeve_row["runtime_ledger_artifact_fill_count"], 4)
        source_compiler_mock.assert_not_called()
        candidate_compiler_mock.assert_not_called()
        selection_mock.assert_not_called()
        replay_mock.assert_called_once()

    def test_candidate_specs_replay_rejects_duplicate_spec_ids(self) -> None:
        with TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "epoch"
            selected_specs_path = Path(tmpdir) / "selected-candidate-specs.jsonl"
            spec = self._candidate_spec("spec-direct-duplicate")
            selected_specs_path.write_text(
                "\n".join(
                    json.dumps(spec.to_payload(), sort_keys=True) for _ in range(2)
                )
                + "\n",
                encoding="utf-8",
            )
            args = self._args(output_dir)
            args.seed_recent_whitepapers = False
            args.candidate_specs = [selected_specs_path]
            args.replay_mode = "real"

            with patch.object(
                runner,
                "_run_replay_with_optional_timeout",
                side_effect=AssertionError("invalid input must not run replay"),
            ) as replay_mock:
                payload = runner.run_whitepaper_autoresearch_profit_target(args)

        self.assertEqual(payload["status"], "invalid_candidate_specs")
        self.assertIn(
            "candidate_specs_jsonl_duplicate_candidate_spec_id",
            payload["failure_reason"],
        )
        replay_mock.assert_not_called()

    def test_main_treats_selection_only_as_success(self) -> None:
        with (
            patch.object(runner, "_parse_args", return_value=Namespace()),
            patch.object(
                runner,
                "run_whitepaper_autoresearch_profit_target",
                return_value={"status": "selection_only"},
            ),
            patch("builtins.print"),
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 0)

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
        self.assertIn("intraday_ofi_news_dynamics_2025", source_ids)
        self.assertIn("order_flow_filtration_2025", source_ids)
        self.assertIn("realistic_market_impact_rl_envs_2026", source_ids)
        self.assertIn("vwap_regime_classification_intraday_2026", source_ids)
        self.assertIn("structural_limits_ohlcv_intraday_2026", source_ids)
        self.assertIn("latent_microstructure_regime_detection_2026", source_ids)
        self.assertIn("unified_order_flow_impact_volatility_2026", source_ids)
        self.assertIn("closing_auction_market_making_2026", source_ids)
        self.assertIn("mixed_market_limit_execution_2026", source_ids)
        self.assertIn("regime_weighted_conformal_var_2026", source_ids)
        self.assertIn("retail_limit_orders_2025", source_ids)
        self.assertIn("retail_order_flow_segmentation_2026", source_ids)
        self.assertIn("lobdiff_event_stream_prediction_2026", source_ids)
        self.assertIn("neural_hawkes_lob_simulation_2025", source_ids)
        self.assertIn("algorithmic_retail_options_intraday_2026", source_ids)
        self.assertIn("learning_from_book_short_run_efficiency_2026", source_ids)
        self.assertIn("idiosyncratic_trade_imbalance_2026", source_ids)
        self.assertIn("intraday_price_asymmetry_sp500_2026", source_ids)
        self.assertIn("market_depth_execution_delays_2026", source_ids)

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

        impact_source = next(
            source
            for source in sources
            if source.run_id == "realistic_market_impact_rl_envs_2026"
        )
        impact_claim_types = {
            str(claim["claim_type"]) for claim in impact_source.claims
        }
        self.assertIn("feature_recipe", impact_claim_types)
        self.assertIn("risk_constraint", impact_claim_types)
        self.assertIn("route_tca", impact_source.claims[0]["data_requirements"])
        self.assertEqual(impact_source.claims[0]["horizon_scope"], "intraday_execution")
        self.assertTrue(runner.compile_sources_to_hypothesis_cards([impact_source]))

        latent_regime_source = next(
            source
            for source in sources
            if source.run_id == "latent_microstructure_regime_detection_2026"
        )
        latent_claim_types = {
            str(claim["claim_type"]) for claim in latent_regime_source.claims
        }
        self.assertIn("feature_recipe", latent_claim_types)
        self.assertIn("validation_requirement", latent_claim_types)

        book_source = next(
            source
            for source in sources
            if source.run_id == "learning_from_book_short_run_efficiency_2026"
        )
        book_claim_types = {str(claim["claim_type"]) for claim in book_source.claims}
        self.assertIn("feature_recipe", book_claim_types)
        self.assertIn("validation_requirement", book_claim_types)

        depth_delay_source = next(
            source
            for source in sources
            if source.run_id == "market_depth_execution_delays_2026"
        )
        depth_delay_claim_types = {
            str(claim["claim_type"]) for claim in depth_delay_source.claims
        }
        self.assertIn("feature_recipe", depth_delay_claim_types)
        self.assertIn("validation_requirement", depth_delay_claim_types)
        self.assertIn("market_depth", depth_delay_source.claims[0]["data_requirements"])
        self.assertIn(
            "execution_delay", depth_delay_source.claims[0]["data_requirements"]
        )

        retail_limit_source = next(
            source for source in sources if source.run_id == "retail_limit_orders_2025"
        )
        self.assertTrue(
            runner.compile_sources_to_hypothesis_cards([retail_limit_source])
        )
        self.assertIn(
            "order_type_ablation", retail_limit_source.claims[0]["data_requirements"]
        )
        self.assertIn(
            "opportunity_cost", retail_limit_source.claims[1]["data_requirements"]
        )

        ofi_news_source = next(
            source
            for source in sources
            if source.run_id == "intraday_ofi_news_dynamics_2025"
        )
        self.assertTrue(runner.compile_sources_to_hypothesis_cards([ofi_news_source]))
        self.assertIn(
            "price_flow_impact", ofi_news_source.claims[0]["data_requirements"]
        )
        self.assertEqual(ofi_news_source.claims[0]["claim_type"], "signal_mechanism")
        self.assertEqual(ofi_news_source.claims[1]["claim_type"], "market_regime")

        filtration_source = next(
            source
            for source in sources
            if source.run_id == "order_flow_filtration_2025"
        )
        self.assertTrue(runner.compile_sources_to_hypothesis_cards([filtration_source]))
        self.assertIn(
            "filtered_orderbook_imbalance",
            filtration_source.claims[0]["data_requirements"],
        )
        self.assertEqual(filtration_source.claims[0]["claim_type"], "feature_recipe")
        self.assertEqual(
            filtration_source.claims[1]["claim_type"], "validation_requirement"
        )

    def test_compiled_program_research_sources_have_no_missing_feature_aliases(
        self,
    ) -> None:
        args = self._args(Path("/tmp/torghut-program-source-alias-check"))
        args.program = Path(
            "config/trading/research-programs/portfolio-profit-autoresearch-500-v1.yaml"
        )
        program = runner._load_epoch_program(args)
        sources = runner._program_whitepaper_sources(program)
        failures: dict[str, list[dict[str, object]]] = {}
        compiled_source_count = 0

        for source in sources:
            cards = runner.compile_sources_to_hypothesis_cards([source])
            if not cards:
                continue
            compiled_source_count += 1
            compilation = runner.compile_whitepaper_candidate_specs(
                hypothesis_cards=cards,
                target_net_pnl_per_day=Decimal("500"),
                family_template_dir=Path("config/trading/families"),
                seed_sweep_dir=Path("config/trading"),
                universe_symbols=("NVDA",),
            )
            missing_feature_blockers = [
                blocker.to_payload()
                for blocker in compilation.blockers
                if blocker.reason == "required_features_missing_from_family_template"
            ]
            if missing_feature_blockers:
                failures[source.run_id] = missing_feature_blockers

        self.assertGreaterEqual(compiled_source_count, 10)
        self.assertEqual(failures, {})

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

    def test_runtime_closure_exact_replay_ledger_rejects_summary_counts_without_rows(
        self,
    ) -> None:
        self.assertIsNone(runner._runtime_closure_ledger_datetime(None))
        self.assertIsNone(runner._runtime_closure_ledger_datetime("not-a-date"))
        self.assertEqual(
            runner._runtime_closure_ledger_datetime("2026-05-20T14:00:00"),
            datetime(2026, 5, 20, 14, tzinfo=timezone.utc),
        )
        self.assertEqual(
            runner._runtime_closure_ledger_datetime("2026-05-20T14:00:00-04:00"),
            datetime(2026, 5, 20, 18, tzinfo=timezone.utc),
        )
        self.assertIsNone(
            runner._runtime_closure_exact_replay_bucket(
                ledger={"window_start": "2026-05-20", "window_end": "2026-05-19"},
                rows=_authoritative_exact_replay_ledger_rows(),
            )
        )
        with patch.object(runner, "build_runtime_ledger_buckets", return_value=[]):
            self.assertIsNone(
                runner._runtime_closure_exact_replay_bucket(
                    ledger={
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                    },
                    rows=_authoritative_exact_replay_ledger_rows(),
                )
            )
        with TemporaryDirectory() as tmpdir:
            artifact_path = Path(tmpdir) / "ledger.json"
            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "runtime_summary",
                        "row_count": 99,
                        "filled_count": 99,
                        "summary": {"filled_count": 99},
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.runtime_summary.v1",
                        "runtime_ledger_rows": [{"id": 1}],
                        "fill_row_count": 1,
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "row_count": 99,
                        "filled_count": 99,
                        "summary": {"filled_count": 99},
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": ["not-a-row"],
                        "fill_row_count": 1,
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "runtime_ledger_rows": [{"id": 1}],
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                        "row_count": 99,
                        "fill_row_count": 1,
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                        "fill_row_count": 1,
                        "runtime_ledger_rows": _authoritative_exact_replay_ledger_rows(),
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            self.assertEqual(
                runner._runtime_closure_exact_replay_ledger_update(
                    {"exact_replay_ledger_artifact_path": str(artifact_path)}
                ),
                {},
            )

            artifact_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                        "fill_row_count": 2,
                        "runtime_ledger_rows": _authoritative_exact_replay_ledger_rows(),
                    }
                )
                + "\n",
                encoding="utf-8",
            )

            update = runner._runtime_closure_exact_replay_ledger_update(
                {"exact_replay_ledger_artifact_path": str(artifact_path)}
            )

        self.assertEqual(update["exact_replay_ledger_artifact_row_count"], 6)
        self.assertEqual(update["runtime_ledger_artifact_row_count"], 6)
        self.assertEqual(update["exact_replay_ledger_artifact_fill_count"], 2)
        self.assertEqual(update["runtime_ledger_artifact_fill_count"], 2)
        self.assertEqual(update["runtime_ledger_closed_trade_count"], 1)
        self.assertEqual(update["runtime_ledger_open_position_count"], 0)
        self.assertEqual(update["runtime_ledger_filled_notional"], "201")
        self.assertEqual(update["runtime_ledger_net_strategy_pnl_after_costs"], "0.80")
        self.assertEqual(
            update["portfolio_post_cost_net_pnl_basis"],
            "realized_strategy_pnl_after_explicit_costs",
        )
        self.assertEqual(
            update["portfolio_post_cost_net_pnl_source"],
            "exact_replay_runtime_ledger",
        )

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
            exact_ledger_path = replay_dir / "exact-replay-ledger.json"
            market_impact_path = replay_dir / "market-impact-stress.json"
            delay_depth_path = replay_dir / "delay-adjusted-depth-stress.json"
            double_oos_path = replay_dir / "double-oos-walkforward.json"
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
            exact_ledger_path.write_text(
                json.dumps(
                    {
                        "artifact_kind": "exact_replay_ledger",
                        "schema_version": "torghut.exact_replay_ledger.rows.v1",
                        "window_start": "2026-05-20",
                        "window_end": "2026-05-20",
                        "runtime_ledger_rows": _authoritative_exact_replay_ledger_rows(),
                        "fill_row_count": 2,
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            market_impact_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "model": "square_root",
                        "impact_cost_bps": "5",
                        "liquidity_evidence_present": True,
                        "net_pnl_per_day": "999",
                        "post_impact_net_pnl_per_day": "610",
                        "source_markers": [
                            "realistic_market_impact_arxiv_2603_29086_2026"
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            delay_depth_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "model": "latency_depth_haircut",
                        "stress_delay_ms": "250",
                        "case_count": 2,
                        "generated_at": "2026-05-19T13:00:00Z",
                        "fillable_notional_per_day": "300000",
                        "fill_survival_evidence_present": True,
                        "fill_survival_sample_count": 2,
                        "fill_survival_rate": "0.85",
                        "queue_position_survival_fill_curve_evidence_present": True,
                        "queue_position_survival_sample_count": 2,
                        "queue_position_survival_fill_rate": "0.85",
                        "queue_position_survival_queue_ratio_p95": "0.25",
                        "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                        "queue_position_survival_queue_ahead_depletion_sample_count": 2,
                        "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                        "delay_adjusted_depth_queue_ahead_depletion_sample_count": 2,
                        "post_cost_net_pnl_after_queue_position_survival_fill_stress": "605",
                        "post_delay_depth_net_pnl_per_day": "605",
                        "source_markers": [
                            "lob_simulation_reality_gap_arxiv_2603_24137_2026"
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            double_oos_path.write_text(
                json.dumps(
                    {
                        "objective_met": True,
                        "independent_window_count": 2,
                        "pass_rate": "1.00",
                        "post_double_oos_net_pnl_per_day": "615",
                        "post_cost_shock_net_pnl_per_day": "575",
                        "source_markers": [
                            "double_oos_walkforward_arxiv_2602_10785_2026"
                        ],
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            policy = runner.ProfitTargetOraclePolicy(min_observed_trading_days=2)
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
            self.assertIn(
                "market_impact_stress_artifact_present_failed",
                scorecard["profit_target_oracle"]["blockers"],
            )
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
                    "exact_replay_ledger_artifact_path": str(exact_ledger_path),
                    "market_impact_stress_report_path": str(market_impact_path),
                    "delay_adjusted_depth_stress_report_path": str(delay_depth_path),
                    "double_oos_report_path": str(double_oos_path),
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
        self.assertEqual(
            updated.objective_scorecard["exact_replay_ledger_artifact_ref"],
            str(exact_ledger_path),
        )
        self.assertEqual(
            updated.objective_scorecard["exact_replay_ledger_artifact_row_count"],
            6,
        )
        self.assertEqual(
            updated.objective_scorecard["exact_replay_ledger_artifact_fill_count"],
            2,
        )
        self.assertEqual(
            updated.objective_scorecard["market_impact_stress_artifact_ref"],
            str(market_impact_path),
        )
        self.assertEqual(
            updated.objective_scorecard["market_impact_stress_model"], "square_root"
        )
        self.assertEqual(
            updated.objective_scorecard["market_impact_stress_net_pnl_per_day"],
            "610",
        )
        self.assertEqual(
            updated.objective_scorecard["market_impact_stress_source_markers"],
            ["realistic_market_impact_arxiv_2603_29086_2026"],
        )
        self.assertEqual(
            updated.objective_scorecard["delay_adjusted_depth_stress_checks_total"],
            2,
        )
        self.assertEqual(
            updated.objective_scorecard["delay_adjusted_depth_stress_checked_at"],
            "2026-05-19T13:00:00Z",
        )
        self.assertTrue(
            updated.objective_scorecard["delay_adjusted_depth_stress_passed"]
        )
        self.assertTrue(
            updated.objective_scorecard[
                "delay_adjusted_depth_fill_survival_evidence_present"
            ]
        )
        self.assertEqual(
            updated.objective_scorecard[
                "delay_adjusted_depth_fill_survival_sample_count"
            ],
            2,
        )
        self.assertEqual(
            updated.objective_scorecard["delay_adjusted_depth_fill_survival_rate"],
            "0.85",
        )
        self.assertTrue(
            updated.objective_scorecard[
                "queue_position_survival_fill_curve_evidence_present"
            ]
        )
        self.assertEqual(
            updated.objective_scorecard["queue_position_survival_sample_count"],
            2,
        )
        self.assertTrue(
            updated.objective_scorecard[
                "queue_position_survival_queue_ahead_depletion_evidence_present"
            ]
        )
        self.assertEqual(
            updated.objective_scorecard[
                "queue_position_survival_queue_ahead_depletion_sample_count"
            ],
            2,
        )
        self.assertEqual(
            updated.objective_scorecard[
                "post_cost_net_pnl_after_queue_position_survival_fill_stress"
            ],
            "605",
        )
        self.assertEqual(
            updated.objective_scorecard["delay_adjusted_depth_stress_source_markers"],
            ["lob_simulation_reality_gap_arxiv_2603_24137_2026"],
        )
        self.assertEqual(
            updated.objective_scorecard["double_oos_artifact_ref"],
            str(double_oos_path),
        )
        self.assertEqual(
            updated.objective_scorecard["double_oos_independent_window_count"],
            2,
        )
        self.assertEqual(updated.objective_scorecard["double_oos_pass_rate"], "1.00")
        self.assertEqual(
            updated.objective_scorecard["double_oos_cost_shock_net_pnl_per_day"],
            "575",
        )
        self.assertEqual(
            updated.objective_scorecard["double_oos_source_markers"],
            ["double_oos_walkforward_arxiv_2602_10785_2026"],
        )
        self.assertEqual(
            updated.objective_scorecard["runtime_closure_source_markers"],
            [
                "double_oos_walkforward_arxiv_2602_10785_2026",
                "lob_simulation_reality_gap_arxiv_2603_24137_2026",
                "realistic_market_impact_arxiv_2603_29086_2026",
            ],
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
        self.assertEqual(runner._runtime_report_int("bad", default=11), 11)
        self.assertEqual(
            runner._portfolio_executable_max_notional(portfolio), Decimal("50000")
        )
        self.assertFalse(runner._portfolio_needs_runtime_closure_proof(portfolio))
        market_impact_only_portfolio = replace(
            portfolio,
            objective_scorecard={
                "target_met": True,
                "oracle_passed": False,
                "profit_target_oracle": {
                    "passed": False,
                    "blockers": [
                        "market_impact_stress_passed_failed",
                        "market_impact_stress_artifact_present_failed",
                        "market_impact_liquidity_evidence_present_failed",
                        "market_impact_stress_model_failed",
                        "market_impact_stress_cost_bps_failed",
                        "market_impact_stress_net_pnl_per_day_failed",
                    ],
                },
            },
        )
        self.assertTrue(
            runner._portfolio_needs_runtime_closure_proof(market_impact_only_portfolio)
        )
        self.assertIs(
            runner._runtime_closure_program_for_candidate(
                program=program,
                manifest=manifest,
                portfolio=None,
                oracle_candidate_found=False,
            ),
            program,
        )

    def test_candidate_board_helpers_keep_blockers_explicit(self) -> None:
        spec = replace(
            self._candidate_spec("spec-regime-diagnostics"),
            hard_vetoes={"required_min_regime_slice_pass_rate": "0.45"},
            feature_contract={
                "source_claims": [
                    {
                        "claim_id": "risk-sensitive-routing",
                        "claim_type": "market_regime",
                    },
                    {
                        "claim_id": "vvg-validation",
                        "claim_type": "validation_requirement",
                    },
                ]
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-test",
            candidate_id="candidate-test",
            candidate_spec_id="spec-test",
            dataset_snapshot_id="snapshot-test",
            feature_spec_hash="hash-test",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={},
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={},
        )

        self.assertEqual(runner._candidate_board_int_field({"bad": object()}, "bad"), 0)
        self.assertEqual(
            runner._candidate_board_market_impact_proof_summary(
                {
                    "market_impact_stress_model": "almgren_chriss_proxy",
                    "market_impact_stress_cost_bps": "150",
                    "market_impact_stress_net_pnl_per_day": "510",
                    "market_impact_stress_artifact_ref": "/tmp/impact.json",
                    "market_impact_stress_components": {
                        "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                        "selected_model": "almgren_chriss_proxy",
                        "selected_cost_bps": "150",
                    },
                    "nonlinear_market_impact_stress_passed": True,
                }
            )["state"],
            "passed",
        )
        missing_impact = runner._candidate_board_market_impact_proof_summary(
            {"target_met": True}
        )
        self.assertEqual(missing_impact["state"], "blocked")
        self.assertIn(
            "nonlinear_market_impact_components_missing",
            missing_impact["blockers"],
        )
        regime_summary = runner._candidate_board_regime_specialist_summary(
            spec, {"regime_slice_pass_rate": "0.30"}
        )
        self.assertEqual(regime_summary["state"], "blocked")
        self.assertIn(
            "regime_slice_pass_rate_below_specialist_threshold",
            regime_summary["blockers"],
        )
        self.assertEqual(
            regime_summary["regime_claim_ids"],
            ["risk-sensitive-routing", "vvg-validation"],
        )
        self.assertEqual(
            runner._candidate_board_blockers(
                selected_for_replay=True,
                evidence=None,
                scorecard={},
            ),
            ["replay_evidence_missing"],
        )
        self.assertEqual(
            runner._candidate_board_blockers(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"target_met": True, "oracle_passed": False},
            ),
            ["profit_target_oracle_failed"],
        )
        dirty_lineage = runner._candidate_board_evidence_lineage_summary(
            replace(evidence, code_commit="commit-test-dirty")
        )
        self.assertEqual(dirty_lineage["blockers"], ["code_commit_dirty"])
        self.assertEqual(
            runner._candidate_board_status(
                selected_for_replay=True,
                evidence=None,
                scorecard={},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "selected_pending_replay_evidence",
        )
        self.assertEqual(
            runner._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"oracle_passed": True},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "candidate_oracle_passed",
        )
        self.assertEqual(
            runner._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={"target_met": True, "oracle_passed": False},
                in_best_portfolio=False,
                portfolio_oracle_passed=False,
            ),
            "blocked_by_oracle",
        )
        self.assertEqual(
            runner._candidate_board_status(
                selected_for_replay=True,
                evidence=evidence,
                scorecard={},
                in_best_portfolio=True,
                portfolio_oracle_passed=True,
            ),
            "portfolio_component_passed_oracle",
        )
        denied_readiness = runner._promotion_readiness_payload(
            oracle_candidate_found=True,
            status="ready_for_promotion_review",
            blockers=[],
            runtime_closure={
                "status": "ready_for_promotion_review",
                "next_required_steps": ["promotion_review"],
                "promotion_prerequisites": {
                    "allowed": False,
                    "reasons": ["promotion_gate_report_denied"],
                },
            },
        )
        self.assertFalse(denied_readiness["promotable"])
        self.assertEqual(
            denied_readiness["status"], "blocked_pending_promotion_prerequisites"
        )
        self.assertEqual(denied_readiness["blockers"], ["promotion_gate_report_denied"])
        allowed_readiness = runner._promotion_readiness_payload(
            oracle_candidate_found=True,
            status="ready_for_promotion_review",
            blockers=[],
            runtime_closure={
                "status": "ready_for_promotion_review",
                "next_required_steps": ["promotion_review"],
                "promotion_prerequisites": {"allowed": True, "reasons": []},
            },
        )
        self.assertTrue(allowed_readiness["promotable"])
        self.assertEqual(allowed_readiness["status"], "promotion_ready")

    def test_candidate_sleeve_goal_rows_carry_order_type_proof_refs(self) -> None:
        base_spec = self._candidate_spec("spec-sleeve-order-type-proof")
        spec = replace(
            base_spec,
            feature_contract={
                **base_spec.feature_contract,
                "source_claims": [
                    {
                        "claim_id": "route-tca-required",
                        "claim_type": "execution_assumption",
                        "data_requirements": ["route_tca"],
                    }
                ],
            },
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-sleeve-order-type-proof",
            candidate_id="cand-sleeve-order-type-proof",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-sleeve-order-type-proof",
            feature_spec_hash="hash-sleeve-order-type-proof",
            code_commit="commit-test",
            replay_artifact_refs=(
                "replay.json",
                "order-type-ablation.json",
                "route-tca.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "active_day_ratio": "1.0",
                "positive_day_ratio": "1.0",
                "order_type_ablation_passed": True,
                "order_type_ablation_artifact_ref": "order-type-ablation.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_artifact_ref": "route-tca.json",
                "order_type_opportunity_cost_bps": "4",
                "market_order_spread_bps": "4",
                "exact_replay_ledger_artifact_ref": "sleeve-exact-replay-ledger.json",
                "runtime_ledger_artifact_ref": "sleeve-runtime-ledger.json",
                "runtime_ledger_artifact_row_count": 30,
                "runtime_ledger_artifact_fill_count": 10,
                "runtime_window_start": "2026-05-18T13:30:00+00:00",
                "runtime_window_end": "2026-05-18T20:00:00+00:00",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )
        candidate_selection = {
            "rows": [
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "selected_for_replay": True,
                    "rank": 1,
                    "selection_reason": "paper_contract_exploration",
                    "paper_contract_prior_score": "29",
                    "paper_mechanism_overlay_ids": [
                        "mixed_market_limit_execution_policy"
                    ],
                    "paper_required_evidence_tokens": [
                        "route_tca",
                        "runtime_ledger",
                    ],
                    "paper_required_evidence_count": 2,
                }
            ]
        }

        rows = runner._candidate_sleeve_goal_rows(
            candidate_specs=(spec,),
            candidate_selection=candidate_selection,
            evidence_bundles=(evidence,),
            false_positive_table=(),
            best_false_negative_table=(),
            portfolio=None,
        )

        self.assertEqual(
            rows[0]["replay_artifact_refs"], list(evidence.replay_artifact_refs)
        )
        self.assertTrue(rows[0]["evidence_lineage"]["passed"])
        self.assertEqual(rows[0]["evidence_lineage"]["code_commit"], "commit-test")
        self.assertEqual(rows[0]["evidence_lineage"]["replay_artifact_ref_count"], 3)
        self.assertEqual(
            rows[0]["order_type_execution_quality"]["artifact_refs"],
            ["order-type-ablation.json"],
        )
        self.assertEqual(rows[0]["order_type_execution_quality"]["sample_count"], 60)
        self.assertTrue(rows[0]["order_type_execution_quality"]["passed"])
        self.assertEqual(
            rows[0]["replay_selection_reason"], "paper_contract_exploration"
        )
        self.assertTrue(rows[0]["paper_contract_candidate"])
        self.assertTrue(rows[0]["paper_contract_selected_for_replay"])
        self.assertEqual(rows[0]["paper_contract_prior_score"], "29")
        self.assertEqual(
            rows[0]["paper_mechanism_overlay_ids"],
            ["mixed_market_limit_execution_policy"],
        )
        self.assertEqual(
            rows[0]["paper_required_evidence_tokens"],
            ["route_tca", "runtime_ledger"],
        )
        self.assertEqual(rows[0]["paper_required_evidence_count"], 2)
        self.assertEqual(
            rows[0]["runtime_ledger_artifact_refs"],
            ["sleeve-exact-replay-ledger.json", "sleeve-runtime-ledger.json"],
        )
        self.assertEqual(
            rows[0]["exact_replay_ledger_artifact_ref"],
            "sleeve-exact-replay-ledger.json",
        )
        self.assertEqual(
            rows[0]["runtime_ledger_artifact_ref"], "sleeve-runtime-ledger.json"
        )
        self.assertEqual(rows[0]["runtime_ledger_artifact_row_count"], 30)
        self.assertEqual(rows[0]["runtime_ledger_artifact_fill_count"], 10)
        self.assertEqual(rows[0]["runtime_window_start"], "2026-05-18T13:30:00+00:00")
        fallback_rows = runner._candidate_sleeve_goal_rows(
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "rank": 1,
                    }
                ]
            },
            evidence_bundles=(evidence,),
            false_positive_table=(),
            best_false_negative_table=(),
            portfolio=None,
        )
        self.assertGreater(
            Decimal(str(fallback_rows[0]["paper_contract_prior_score"])),
            Decimal("0"),
        )
        self.assertEqual(
            fallback_rows[0]["paper_mechanism_overlay_ids"],
            ["mixed_market_limit_execution_policy"],
        )
        self.assertIn("route_tca", fallback_rows[0]["paper_required_evidence_tokens"])
        self.assertGreater(fallback_rows[0]["paper_required_evidence_count"], 0)

        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-sleeve-order-type-proof",
            source_candidate_ids=(evidence.candidate_id,),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(
                {
                    "candidate_id": evidence.candidate_id,
                    "candidate_spec_id": spec.candidate_spec_id,
                    "weight": "1",
                },
            ),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"target_met": True, "oracle_passed": True},
            optimizer_report={},
        )
        portfolio_rows = runner._candidate_sleeve_goal_rows(
            candidate_specs=(spec,),
            candidate_selection=candidate_selection,
            evidence_bundles=(evidence,),
            false_positive_table=(),
            best_false_negative_table=(),
            portfolio=portfolio,
        )

        self.assertEqual(portfolio_rows[0]["evidence_status"], "replayed")
        self.assertEqual(
            portfolio_rows[0]["replay_artifact_refs"],
            list(evidence.replay_artifact_refs),
        )
        self.assertTrue(portfolio_rows[0]["evidence_lineage"]["passed"])
        self.assertTrue(portfolio_rows[0]["order_type_execution_quality"]["passed"])
        self.assertEqual(portfolio_rows[0]["market_impact_proof"]["state"], "blocked")
        self.assertEqual(
            portfolio_rows[0]["replay_selection_reason"], "paper_contract_exploration"
        )
        self.assertTrue(portfolio_rows[0]["paper_contract_selected_for_replay"])
        self.assertEqual(
            portfolio_rows[0]["runtime_ledger_artifact_refs"],
            ["sleeve-exact-replay-ledger.json", "sleeve-runtime-ledger.json"],
        )

    def test_candidate_board_marks_portfolio_promotion_found_when_portfolio_oracle_passes(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-portfolio-promotion-subject")
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-portfolio-promotion-subject",
            candidate_id="cand-portfolio-promotion-subject",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-portfolio-promotion-subject",
            feature_spec_hash="hash-portfolio-promotion-subject",
            code_commit="commit-test",
            replay_artifact_refs=("component-replay.json",),
            objective_scorecard={
                "target_met": False,
                "oracle_passed": False,
                "net_pnl_per_day": "260",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={},
            null_comparator={},
            promotion_readiness={},
        )
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-promotion-subject",
            source_candidate_ids=(evidence.candidate_id,),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(
                {
                    "candidate_id": evidence.candidate_id,
                    "candidate_spec_id": spec.candidate_spec_id,
                    "weight": "1",
                },
            ),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=("portfolio-replay.json",),
            objective_scorecard={
                "target_met": True,
                "oracle_passed": True,
                "net_pnl_per_day": "535",
                "market_impact_stress_artifact_ref": "portfolio-impact.json",
                "market_impact_stress_model": "almgren_chriss_proxy",
                "market_impact_stress_cost_bps": "8",
                "market_impact_stress_net_pnl_per_day": "515",
                "market_impact_stress_components": {
                    "source_marker": "realistic_market_impact_arxiv_2603_29086_2026",
                    "selected_model": "almgren_chriss_proxy",
                    "selected_cost_bps": "8",
                },
                "nonlinear_market_impact_stress_passed": True,
            },
            optimizer_report={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-portfolio-promotion-subject",
            output_dir=Path("/tmp/torghut-test"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "rank": 1,
                    }
                ]
            },
            pre_replay_proposal_rows=(),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=portfolio,
            promotion_readiness={"status": "promotion_ready", "promotable": True},
            runtime_closure={"status": "ready_for_promotion_review"},
        )

        self.assertEqual(board["current_answer"], "promotion_candidate_found")
        self.assertEqual(board["promotion_subject"]["type"], "portfolio")
        self.assertEqual(
            board["promotion_subject"]["portfolio_candidate_id"],
            "portfolio-promotion-subject",
        )
        self.assertTrue(board["promotion_subject"]["oracle_passed"])
        self.assertTrue(board["promotion_subject"]["promotable"])
        self.assertEqual(
            board["promotion_subject"]["market_impact_proof"]["state"], "passed"
        )
        self.assertFalse(board["closest_promotion_candidate"]["oracle_passed"])
        self.assertEqual(
            board["rows"][0]["status"], "portfolio_component_passed_oracle"
        )

    def test_candidate_board_fails_rejected_signal_candidate_without_labels(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-rejected-signal-proof"),
            parameter_space={
                "mechanism_overlay_ids": ["rejected_signal_outcome_calibration"]
            },
            hard_vetoes={
                "required_min_rejected_signal_outcome_label_count": "120",
                "required_min_rejected_signal_reason_coverage": "0.80",
                "required_max_rejected_signal_outcome_pending_ratio": "0.05",
                "required_rejected_signal_counterfactual_fields": [
                    "counterfactual_return",
                    "route_tca",
                    "post_cost_net_pnl",
                    "executable_quote",
                ],
                "required_rejected_signal_outcome_persistence_state": "ok",
            },
            promotion_contract={"requires_rejected_signal_outcome_learning": True},
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-rejected-signal-proof",
            candidate_id="cand-rejected-signal-proof",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-rejected-signal-proof",
            feature_spec_hash="hash-rejected-signal-proof",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "trade_decision_count": 9,
                "orders_submitted_count": 9,
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-rejected-signal-board",
            output_dir=Path("/tmp/epoch-rejected-signal-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["oracle_passed"])
        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")
        self.assertIn("rejected_signal_outcome_labeled_count_failed", row["blockers"])
        self.assertIn("rejected_signal_reason_coverage_failed", row["blockers"])
        self.assertIn(
            "rejected_signal_counterfactual_fields_present_failed", row["blockers"]
        )
        self.assertFalse(row["rejected_signal_outcome_learning"]["passed"])

    def test_candidate_board_rejects_unknown_code_commit_lineage(self) -> None:
        spec = self._candidate_spec("spec-unknown-lineage")
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-unknown-lineage",
            candidate_id="cand-unknown-lineage",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-unknown-lineage",
            feature_spec_hash="hash-unknown-lineage",
            code_commit="unknown",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "700",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-unknown-lineage-board",
            output_dir=Path("/tmp/epoch-unknown-lineage-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["oracle_passed"])
        self.assertFalse(row["evidence_lineage"]["passed"])
        self.assertIn("code_commit_missing_or_unknown", row["blockers"])
        self.assertIn(
            "code_commit_missing_or_unknown",
            row["evidence_lineage"]["blockers"],
        )
        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")

    def test_candidate_board_fails_market_limit_candidate_without_order_type_evidence(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-proof"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-proof",
            candidate_id="cand-market-limit-proof",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-proof",
            feature_spec_hash="hash-market-limit-proof",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_sample_count": 59,
                "order_type_opportunity_cost_bps": "9",
                "market_order_spread_bps": "9",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-board",
            output_dir=Path("/tmp/epoch-market-limit-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["oracle_passed"])
        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")
        self.assertIn("order_type_ablation_passed_failed", row["blockers"])
        self.assertIn("order_type_ablation_artifact_present_failed", row["blockers"])
        self.assertIn("order_type_ablation_sample_count_failed", row["blockers"])
        self.assertIn("market_limit_order_mix_evidence_present_failed", row["blockers"])
        self.assertIn("limit_fill_probability_evidence_present_failed", row["blockers"])
        self.assertIn("route_tca_evidence_present_failed", row["blockers"])
        self.assertIn("market_order_spread_bps_failed", row["blockers"])
        self.assertFalse(row["order_type_execution_quality"]["passed"])

    def test_candidate_board_accepts_market_limit_candidate_with_order_type_evidence(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-pass"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-pass",
            candidate_id="cand-market-limit-pass",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-pass",
            feature_spec_hash="hash-market-limit-pass",
            code_commit="commit-test",
            replay_artifact_refs=(
                "replay.json",
                "order-type-ablation.json",
                "route-tca.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_passed": True,
                "order_type_ablation_artifact_ref": "order-type-ablation.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_artifact_ref": "route-tca.json",
                "order_type_opportunity_cost_bps": "8",
                "market_order_spread_bps": "8",
                "replay_lineage": {
                    "lineage_hash": "lineage-market-limit-pass",
                    "expected_windows": ["train", "holdout", "full_window"],
                    "present_windows": ["train", "holdout", "full_window"],
                    "missing_windows": [],
                },
                "replay_window_coverage": {
                    "lineage_hash": "lineage-market-limit-pass",
                    "expected_windows": ["train", "holdout", "full_window"],
                    "present_windows": ["train", "holdout", "full_window"],
                    "missing_windows": [],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-pass-board",
            output_dir=Path("/tmp/epoch-market-limit-pass-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertTrue(row["order_type_execution_quality"]["passed"])
        self.assertTrue(row["oracle_passed"])

    def test_candidate_board_rejects_queue_survival_overlay_without_lifecycle_depth(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-queue-survival-proof"),
            parameter_space={
                "mechanism_overlay_ids": ["queue_position_survival_fill_curve"]
            },
            hard_vetoes={
                "required_queue_position_survival_fill_curve": True,
                "required_min_queue_position_survival_sample_count": "60",
                "required_max_queue_position_nonfill_opportunity_cost_bps": "8",
                "required_time_to_fill_quantiles": True,
                "required_order_lifecycle_fill_evidence": True,
            },
            promotion_contract={
                "requires_queue_position_survival_fill_curve": True,
                "requires_time_to_fill_quantiles": True,
                "requires_nonfill_opportunity_cost": True,
                "requires_order_lifecycle_fill_evidence": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-queue-survival-proof",
            candidate_id="cand-queue-survival-proof",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-queue-survival-proof",
            feature_spec_hash="hash-queue-survival-proof",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 12,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 12,
                "queue_position_survival_nonfill_opportunity_cost_bps": "12",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-queue-survival-board",
            output_dir=Path("/tmp/epoch-queue-survival-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        queue_summary = row["queue_position_survival_fill_quality"]
        self.assertFalse(row["oracle_passed"])
        self.assertFalse(queue_summary["passed"])
        self.assertIn("queue_position_survival_sample_count_failed", row["blockers"])
        self.assertIn(
            "queue_position_survival_nonfill_opportunity_cost_bps_failed",
            row["blockers"],
        )
        self.assertIn("time_to_fill_quantiles_present_failed", row["blockers"])
        self.assertEqual(queue_summary["min_sample_count"], 60)

    def test_candidate_board_accepts_queue_survival_overlay_with_lifecycle_depth(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-queue-survival-pass"),
            parameter_space={
                "mechanism_overlay_ids": ["queue_position_survival_fill_curve"]
            },
            hard_vetoes={
                "required_queue_position_survival_fill_curve": True,
                "required_min_queue_position_survival_sample_count": "60",
                "required_max_queue_position_nonfill_opportunity_cost_bps": "8",
                "required_time_to_fill_quantiles": True,
            },
            promotion_contract={
                "requires_queue_position_survival_fill_curve": True,
                "requires_time_to_fill_quantiles": True,
                "requires_nonfill_opportunity_cost": True,
            },
        )

        summary = runner._candidate_board_queue_position_survival_summary(
            spec,
            {
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 60,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 60,
                "queue_position_survival_nonfill_opportunity_cost_bps": "8",
                "fill_time_ms_p50": "110",
                "fill_time_ms_p95": "450",
            },
        )

        self.assertTrue(summary["required"])
        self.assertTrue(summary["passed"])
        self.assertEqual(summary["blockers"], [])
        self.assertTrue(summary["time_to_fill_quantiles_present"])

    def test_candidate_board_rejects_market_limit_candidate_with_unreachable_artifacts(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-missing-artifact-ref"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-missing-artifact-ref",
            candidate_id="cand-market-limit-missing-artifact-ref",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-missing-artifact-ref",
            feature_spec_hash="hash-market-limit-missing-artifact-ref",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_passed": True,
                "order_type_ablation_artifact_ref": "order-type-ablation.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_artifact_ref": "route-tca.json",
                "order_type_opportunity_cost_bps": "8",
                "market_order_spread_bps": "8",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-missing-artifact-ref-board",
            output_dir=Path("/tmp/epoch-market-limit-missing-artifact-ref-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["order_type_execution_quality"]["passed"])
        self.assertFalse(row["oracle_passed"])
        self.assertIn(
            "order_type_proof_artifact_ref_missing_from_bundle", row["blockers"]
        )
        self.assertEqual(
            row["order_type_execution_quality"]["missing_replay_artifact_refs"],
            ["order-type-ablation.json", "route-tca.json"],
        )

    def test_candidate_board_rejects_route_tca_boolean_without_artifact(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-route-bool"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-route-bool",
            candidate_id="cand-market-limit-route-bool",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-route-bool",
            feature_spec_hash="hash-market-limit-route-bool",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_passed": True,
                "order_type_ablation_artifact_ref": "order-type-ablation.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_evidence_present": True,
                "order_type_opportunity_cost_bps": "8",
                "market_order_spread_bps": "8",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-route-bool-board",
            output_dir=Path("/tmp/epoch-market-limit-route-bool-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["order_type_execution_quality"]["passed"])
        self.assertIn("route_tca_evidence_present_failed", row["blockers"])

    def test_candidate_board_rejects_route_tca_as_order_type_ablation_artifact(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-market-limit-route-artifact"),
            parameter_space={
                "mechanism_overlay_ids": ["mixed_market_limit_execution_policy"]
            },
            hard_vetoes={
                "required_order_type_ablation_passed": True,
                "required_min_order_type_ablation_sample_count": "60",
                "required_limit_fill_probability_evidence": True,
                "required_price_improvement_evidence": True,
                "required_opportunity_cost_evidence": True,
                "required_execution_shortfall_evidence": True,
                "required_max_order_type_opportunity_cost_bps": "8",
                "required_max_market_order_spread_bps": "8",
            },
            promotion_contract={
                "requires_order_type_execution_quality": True,
                "requires_market_limit_order_mix": True,
                "requires_limit_fill_probability": True,
                "requires_execution_shortfall": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-market-limit-route-artifact",
            candidate_id="cand-market-limit-route-artifact",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-market-limit-route-artifact",
            feature_spec_hash="hash-market-limit-route-artifact",
            code_commit="commit-test",
            replay_artifact_refs=("replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "640",
                "target_met": True,
                "oracle_passed": True,
                "profit_target_oracle": {"blockers": []},
                "order_type_ablation_passed": True,
                "order_type_execution_artifact_ref": "order-type-execution.json",
                "order_type_ablation_sample_count": 60,
                "market_limit_order_mix_evidence_present": True,
                "limit_fill_probability_evidence_present": True,
                "price_improvement_evidence_present": True,
                "opportunity_cost_evidence_present": True,
                "execution_shortfall_evidence_present": True,
                "route_tca_artifact_ref": "route-tca.json",
                "order_type_opportunity_cost_bps": "8",
                "market_order_spread_bps": "8",
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "calibrated", "source": "route_tca"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-market-limit-route-artifact-board",
            output_dir=Path("/tmp/epoch-market-limit-route-artifact-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": True},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["order_type_execution_quality"]["passed"])
        self.assertIn("order_type_ablation_artifact_present_failed", row["blockers"])
        self.assertNotIn("route_tca_evidence_present_failed", row["blockers"])

    def test_candidate_board_separates_research_rank_from_executed_candidate(
        self,
    ) -> None:
        research_spec = self._candidate_spec(
            "spec-83161ae16d17828eabcc58cc",
            family_template_id="intraday_tsmom_v2",
        )
        executed_spec = self._candidate_spec(
            "spec-hmicro-proof",
            family_template_id="microstructure_continuation_matched_filter_v1",
        )
        executed_evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-hmicro-proof",
            candidate_id="chip-paper-microbar-composite@execution-proof",
            candidate_spec_id=executed_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-hmicro-runtime-proof",
            feature_spec_hash="hash-hmicro-proof",
            code_commit="commit-test",
            replay_artifact_refs=(
                "paper-window.json",
                "paper-window-exact-replay-ledger.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "82.50",
                "market_impact_stress_passed": True,
                "market_impact_stress_net_pnl_per_day": "82.50",
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_net_pnl_per_day": "82.50",
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "82.50",
                "double_oos_passed": True,
                "double_oos_net_pnl_per_day": "82.50",
                "double_oos_cost_shock_net_pnl_per_day": "82.50",
                "implementation_uncertainty_stability_passed": True,
                "implementation_uncertainty_lower_net_pnl_per_day": "82.50",
                "conformal_tail_risk_passed": True,
                "conformal_tail_risk_adjusted_net_pnl_per_day": "82.50",
                "delay_adjusted_depth_fill_survival_evidence_present": True,
                "delay_adjusted_depth_fill_survival_sample_count": 7,
                "delay_adjusted_depth_fill_survival_rate": "0.85",
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 7,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 7,
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 7,
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 7,
                "target_met": False,
                "oracle_passed": False,
                "trading_day_count": 3,
                "trade_decision_count": 7,
                "orders_submitted_count": 7,
                "trade_count": 7,
                "executable_replay_submitted_order_count": 7,
                "exact_replay_ledger_artifact_ref": "paper-window-exact-replay-ledger.json",
                "runtime_ledger_artifact_row_count": 21,
                "runtime_ledger_artifact_fill_count": 7,
                "replay_lineage": {
                    "windows": {
                        "full_window": {
                            "start_date": "2026-05-18",
                            "end_date": "2026-05-20",
                        }
                    }
                },
                "profit_target_oracle": {
                    "blockers": [
                        "portfolio_post_cost_net_pnl_per_day_failed",
                        "min_observed_trading_days_failed",
                    ],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-candidate-board-split",
            output_dir=Path("/tmp/epoch-candidate-board-split"),
            target=Decimal("500"),
            candidate_specs=(research_spec, executed_spec),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": executed_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": research_spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "2.52157822",
                },
                {
                    "candidate_spec_id": executed_spec.candidate_spec_id,
                    "rank": 2,
                    "proposal_score": "1.4",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(executed_evidence,),
            portfolio=None,
            promotion_readiness={"promotable": False, "blockers": ["not_ready"]},
            runtime_closure={"status": "blocked"},
        )

        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")
        self.assertEqual(
            board["best_research_candidate"]["candidate_spec_id"],
            research_spec.candidate_spec_id,
        )
        self.assertEqual(
            board["best_executed_candidate"]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            board["closest_promotion_candidate"]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            board["paper_probation_candidate"]["candidate_id"],
            "chip-paper-microbar-composite@execution-proof",
        )
        self.assertEqual(
            board["paper_probation_candidate"]["selection_reason"],
            "closest_lower_bound_economics_below_target",
        )
        self.assertEqual(board["best_executed_candidate"]["decision_count"], 7)
        self.assertEqual(board["best_executed_candidate"]["submitted_order_count"], 7)
        self.assertEqual(board["best_executed_candidate"]["filled_order_count"], 7)
        self.assertEqual(board["double_oos_summary"]["replayed_candidate_count"], 1)
        self.assertEqual(
            board["double_oos_summary"]["missing_artifact_candidate_count"], 1
        )
        self.assertIn(
            "double_oos_artifact_missing_for_replayed_candidates",
            board["double_oos_summary"]["blockers"],
        )
        self.assertRegex(board["status_digest"], r"^[0-9a-f]{64}$")

    def test_candidate_board_rejects_alpha_decay_overlay_without_stress(
        self,
    ) -> None:
        spec = replace(
            self._candidate_spec("spec-alpha-decay-missing-stress"),
            parameter_space={
                "mechanism_overlay_ids": ["alpha_decay_predictability_stress"]
            },
            promotion_contract={
                "requires_predictability_decay_stress": True,
                "requires_horizon_decay_curve": True,
                "requires_spread_adjusted_label_replay": True,
            },
        )
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-alpha-decay-missing-stress",
            candidate_id="cand-alpha-decay-missing-stress",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-alpha-decay-missing-stress",
            feature_spec_hash="hash-alpha-decay-missing-stress",
            code_commit="commit-test",
            replay_artifact_refs=("alpha-decay-replay.json",),
            objective_scorecard={
                "net_pnl_per_day": "725",
                "target_met": True,
                "oracle_passed": True,
                "trade_decision_count": 14,
                "orders_submitted_count": 14,
                "trade_count": 14,
                "profit_target_oracle": {"blockers": []},
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-alpha-decay-missing-stress",
            output_dir=Path("/tmp/epoch-alpha-decay-missing-stress"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                    }
                ]
            },
            pre_replay_proposal_rows=(),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": False},
            runtime_closure={},
        )

        row = board["rows"][0]
        self.assertFalse(row["oracle_passed"])
        self.assertFalse(row["predictability_decay_stress"]["passed"])
        self.assertIn(
            "predictability_decay_stress_passed_failed",
            row["predictability_decay_stress"]["blockers"],
        )
        self.assertIn(
            "predictability_decay_stress_passed_failed",
            row["blockers"],
        )
        self.assertEqual(
            row["predictability_decay_stress"]["source_marker"],
            "tkan_lob_alpha_decay_arxiv_2601_02310_2026",
        )

    def test_candidate_board_surfaces_paper_probation_without_promotion(
        self,
    ) -> None:
        spec = self._candidate_spec("spec-paper-probation")
        evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-paper-probation",
            candidate_id="cand-paper-probation",
            candidate_spec_id=spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-paper-probation",
            feature_spec_hash="hash-paper-probation",
            code_commit="commit-test",
            replay_artifact_refs=(
                "paper-probation.json",
                "paper-probation-exact-ledger.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "525",
                "market_impact_stress_passed": True,
                "market_impact_stress_net_pnl_per_day": "525",
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_net_pnl_per_day": "525",
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "525",
                "double_oos_passed": True,
                "double_oos_cost_shock_net_pnl_per_day": "525",
                "implementation_uncertainty_stability_passed": True,
                "implementation_uncertainty_lower_net_pnl_per_day": "525",
                "conformal_tail_risk_passed": True,
                "conformal_tail_risk_adjusted_net_pnl_per_day": "525",
                "delay_adjusted_depth_fill_survival_evidence_present": True,
                "delay_adjusted_depth_fill_survival_sample_count": 9,
                "delay_adjusted_depth_fill_survival_rate": "0.85",
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 9,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 9,
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 9,
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 9,
                "target_met": True,
                "oracle_passed": False,
                "trade_decision_count": 9,
                "orders_submitted_count": 9,
                "trade_count": 9,
                "exact_replay_ledger_artifact_ref": "paper-probation-exact-ledger.json",
                "runtime_ledger_artifact_row_count": 27,
                "runtime_ledger_artifact_fill_count": 9,
                "replay_lineage": {
                    "windows": {
                        "full_window": {
                            "start_date": "2026-05-18",
                            "end_date": "2026-05-20",
                        }
                    }
                },
                "profit_target_oracle": {
                    "blockers": ["delay_adjusted_depth_tail_coverage_passed_failed"]
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-paper-probation-board",
            output_dir=Path("/tmp/epoch-paper-probation-board"),
            target=Decimal("500"),
            candidate_specs=(spec,),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": spec.candidate_spec_id,
                        "selected_for_replay": True,
                        "selection_reason": "paper_contract_exploration",
                        "paper_contract_prior_score": "31.5",
                        "paper_mechanism_overlay_ids": [
                            "mixed_market_limit_execution_policy",
                            "queue_position_survival_fill_curve",
                        ],
                        "paper_required_evidence_tokens": [
                            "live_paper_parity",
                            "route_tca",
                            "runtime_ledger",
                        ],
                    }
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(evidence,),
            portfolio=None,
            promotion_readiness={"promotable": False},
            runtime_closure={},
        )

        self.assertEqual(board["current_answer"], "no_promotion_ready_candidate")
        row = board["rows"][0]
        self.assertEqual(row["replay_selection_reason"], "paper_contract_exploration")
        self.assertTrue(row["paper_contract_candidate"])
        self.assertTrue(row["paper_contract_selected_for_replay"])
        self.assertEqual(row["paper_contract_prior_score"], "31.5")
        self.assertEqual(
            row["paper_mechanism_overlay_ids"],
            [
                "mixed_market_limit_execution_policy",
                "queue_position_survival_fill_curve",
            ],
        )
        self.assertEqual(
            row["paper_required_evidence_tokens"],
            ["live_paper_parity", "route_tca", "runtime_ledger"],
        )
        self.assertEqual(row["paper_required_evidence_count"], 3)
        self.assertEqual(
            board["paper_probation_candidate"]["candidate_id"], "cand-paper-probation"
        )
        probation_candidate = board["paper_probation_candidate"]
        self.assertEqual(
            probation_candidate["candidate_selection"],
            "oracle_recommended_paper_probation",
        )
        self.assertTrue(probation_candidate["paper_probation_authorized"])
        self.assertTrue(probation_candidate["probation_allowed"])
        self.assertEqual(
            probation_candidate["paper_probation_authorization_scope"],
            "evidence_collection_only",
        )
        self.assertEqual(probation_candidate["evidence_collection_stage"], "paper")
        self.assertEqual(
            probation_candidate["selection_reason"], "target_met_but_oracle_blocked"
        )
        self.assertFalse(probation_candidate["promotion_allowed"])
        self.assertFalse(probation_candidate["final_promotion_authorized"])
        self.assertFalse(probation_candidate["final_promotion_allowed"])
        self.assertIn(
            "delay_adjusted_depth_tail_coverage_passed_failed",
            probation_candidate["final_promotion_blockers"],
        )
        plan = board["runtime_window_import_plan"]
        self.assertEqual(
            plan["schema_version"], "torghut.runtime-window-import-plan.v1"
        )
        self.assertEqual(plan["status"], "ready")
        self.assertEqual(plan["target_count"], 1)
        target = plan["targets"][0]
        self.assertEqual(target["candidate_id"], "cand-paper-probation")
        self.assertEqual(target["candidate_spec_id"], spec.candidate_spec_id)
        self.assertEqual(target["hypothesis_id"], spec.hypothesis_id)
        self.assertEqual(target["strategy_family"], spec.runtime_family)
        self.assertEqual(target["strategy_name"], spec.runtime_strategy_name)
        self.assertEqual(target["observed_stage"], "paper")
        self.assertEqual(
            target["source_kind"], "simulation_exact_replay_runtime_ledger"
        )
        self.assertEqual(target["account_label"], "TORGHUT_REPLAY")
        self.assertEqual(target["window_start"], "2026-05-18T13:30:00+00:00")
        self.assertEqual(target["window_end"], "2026-05-20T20:00:00+00:00")
        self.assertEqual(target["dataset_snapshot_ref"], "snapshot-paper-probation")
        self.assertEqual(
            target["artifact_refs"],
            ["paper-probation.json", "paper-probation-exact-ledger.json"],
        )
        self.assertEqual(
            target["runtime_ledger_artifact_refs"],
            ["paper-probation-exact-ledger.json"],
        )
        self.assertEqual(
            target["exact_replay_ledger_artifact_ref"],
            "paper-probation-exact-ledger.json",
        )
        self.assertEqual(target["runtime_ledger_artifact_row_count"], 27)
        self.assertEqual(target["runtime_ledger_artifact_fill_count"], 9)
        self.assertEqual(
            target["replay_selection_reason"], "paper_contract_exploration"
        )
        self.assertTrue(target["paper_contract_candidate"])
        self.assertTrue(target["paper_contract_selected_for_replay"])
        self.assertEqual(target["paper_contract_prior_score"], "31.5")
        self.assertEqual(
            target["paper_required_evidence_tokens"],
            ["live_paper_parity", "route_tca", "runtime_ledger"],
        )
        self.assertIn("--artifact-ref", target["import_command_args"])
        self.assertIn(
            "paper-probation-exact-ledger.json", target["import_command_args"]
        )
        self.assertIn("--target-metadata-json", target["import_command_args"])
        metadata_arg_index = (
            target["import_command_args"].index("--target-metadata-json") + 1
        )
        import_metadata = json.loads(target["import_command_args"][metadata_arg_index])
        self.assertEqual(
            import_metadata["runtime_ledger_artifact_refs"],
            ["paper-probation-exact-ledger.json"],
        )
        self.assertEqual(import_metadata["runtime_ledger_artifact_row_count"], 27)
        self.assertEqual(import_metadata["runtime_ledger_artifact_fill_count"], 9)
        self.assertEqual(
            import_metadata["exact_replay_ledger_artifact_ref"],
            "paper-probation-exact-ledger.json",
        )
        self.assertEqual(import_metadata["window_start"], target["window_start"])
        self.assertEqual(import_metadata["window_end"], target["window_end"])
        self.assertEqual(
            import_metadata["replay_selection_reason"], "paper_contract_exploration"
        )
        self.assertEqual(
            import_metadata["paper_mechanism_overlay_ids"],
            [
                "mixed_market_limit_execution_policy",
                "queue_position_survival_fill_curve",
            ],
        )
        self.assertEqual(
            import_metadata["paper_required_evidence_tokens"],
            ["live_paper_parity", "route_tca", "runtime_ledger"],
        )
        self.assertTrue(import_metadata["paper_probation_authorized"])
        self.assertFalse(import_metadata["promotion_allowed"])
        self.assertFalse(import_metadata["final_promotion_authorized"])
        self.assertEqual(target["handoff"], "runtime_window_import_only")
        self.assertEqual(
            target["promotion_gate"], "existing_runtime_governance_fail_closed"
        )
        self.assertTrue(target["paper_probation_authorized"])
        self.assertEqual(target["evidence_collection_stage"], "paper")
        self.assertFalse(target["promotion_allowed"])
        self.assertFalse(target["final_promotion_authorized"])
        self.assertFalse(target["final_promotion_allowed"])
        self.assertEqual(target["selection_reason"], "target_met_but_oracle_blocked")
        handoff = runner._paper_probation_handoff_payload(board)
        self.assertEqual(
            handoff["schema_version"], "torghut.paper-probation-handoff.v1"
        )
        self.assertEqual(handoff["status"], "ready")
        self.assertTrue(handoff["paper_probation_authorized"])
        self.assertFalse(handoff["promotion_allowed"])
        self.assertFalse(handoff["final_promotion_allowed"])
        self.assertEqual(handoff["candidate_count"], 1)
        self.assertEqual(
            handoff["candidates"][0]["candidate_id"], "cand-paper-probation"
        )
        self.assertEqual(
            handoff["runtime_window_import_plan"]["target_count"],
            1,
        )

    def test_candidate_board_paper_probation_prefers_lower_bound_economics(
        self,
    ) -> None:
        weak_spec = self._candidate_spec("spec-weak-probation")
        close_spec = self._candidate_spec("spec-close-probation")
        bridge_spec = self._candidate_spec("spec-bridge-probation")
        raw_only_spec = self._candidate_spec("spec-raw-only-probation")
        weak_evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-weak-probation",
            candidate_id="cand-weak-probation",
            candidate_spec_id=weak_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-weak-probation",
            feature_spec_hash="hash-weak-probation",
            code_commit="commit-test",
            replay_artifact_refs=("weak-probation.json",),
            objective_scorecard={
                "net_pnl_per_day": "125",
                "market_impact_stress_passed": True,
                "market_impact_stress_net_pnl_per_day": "125",
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_net_pnl_per_day": "125",
                "delay_adjusted_depth_fill_survival_evidence_present": True,
                "delay_adjusted_depth_fill_survival_sample_count": 12,
                "delay_adjusted_depth_fill_survival_rate": "0.85",
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 12,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 12,
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 12,
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 12,
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "125",
                "double_oos_passed": True,
                "double_oos_net_pnl_per_day": "125",
                "double_oos_cost_shock_net_pnl_per_day": "125",
                "implementation_uncertainty_stability_passed": True,
                "implementation_uncertainty_lower_net_pnl_per_day": "125",
                "conformal_tail_risk_passed": True,
                "conformal_tail_risk_adjusted_net_pnl_per_day": "125",
                "target_met": False,
                "oracle_passed": False,
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.10",
                "worst_day_loss": "0",
                "trade_decision_count": 12,
                "orders_submitted_count": 12,
                "trade_count": 12,
                "profit_target_oracle": {
                    "blockers": ["min_daily_net_pnl_failed"],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )
        close_evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-close-probation",
            candidate_id="cand-close-probation",
            candidate_spec_id=close_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-close-probation",
            feature_spec_hash="hash-close-probation",
            code_commit="commit-test",
            replay_artifact_refs=(
                "close-probation.json",
                "close-probation-exact-replay-ledger.json",
            ),
            objective_scorecard={
                "net_pnl_per_day": "480",
                "market_impact_stress_passed": True,
                "market_impact_stress_net_pnl_per_day": "460",
                "delay_adjusted_depth_stress_passed": True,
                "delay_adjusted_depth_stress_net_pnl_per_day": "450",
                "delay_adjusted_depth_fill_survival_evidence_present": True,
                "delay_adjusted_depth_fill_survival_sample_count": 8,
                "delay_adjusted_depth_fill_survival_rate": "0.85",
                "queue_position_survival_fill_curve_evidence_present": True,
                "queue_position_survival_sample_count": 8,
                "queue_position_survival_fill_rate": "0.85",
                "queue_position_survival_queue_ratio_p95": "0.25",
                "queue_position_survival_queue_ahead_depletion_evidence_present": True,
                "queue_position_survival_queue_ahead_depletion_sample_count": 8,
                "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
                "delay_adjusted_depth_queue_ahead_depletion_sample_count": 8,
                "queue_ahead_depletion_evidence_present": True,
                "queue_ahead_depletion_sample_count": 8,
                "post_cost_net_pnl_after_queue_position_survival_fill_stress": "430",
                "double_oos_passed": True,
                "double_oos_net_pnl_per_day": "440",
                "double_oos_cost_shock_net_pnl_per_day": "440",
                "implementation_uncertainty_stability_passed": True,
                "implementation_uncertainty_lower_net_pnl_per_day": "430",
                "conformal_tail_risk_passed": True,
                "conformal_tail_risk_adjusted_net_pnl_per_day": "430",
                "target_met": False,
                "oracle_passed": False,
                "active_day_ratio": "0.82",
                "positive_day_ratio": "0.68",
                "best_day_share": "0.32",
                "worst_day_loss": "40",
                "trade_decision_count": 8,
                "orders_submitted_count": 8,
                "trade_count": 8,
                "exact_replay_ledger_artifact_ref": "close-probation-exact-replay-ledger.json",
                "runtime_ledger_artifact_row_count": 24,
                "runtime_ledger_artifact_fill_count": 8,
                "replay_lineage": {
                    "windows": {
                        "full_window": {
                            "start_date": "2026-05-18",
                            "end_date": "2026-05-21",
                        }
                    }
                },
                "profit_target_oracle": {
                    "blockers": [
                        "min_daily_net_pnl_failed",
                        "delay_adjusted_depth_stress_net_pnl_per_day_failed",
                    ],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )
        raw_only_evidence = runner.CandidateEvidenceBundle(
            schema_version="torghut.candidate-evidence-bundle.v1",
            evidence_bundle_id="ev-raw-only-probation",
            candidate_id="cand-raw-only-probation",
            candidate_spec_id=raw_only_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-raw-only-probation",
            feature_spec_hash="hash-raw-only-probation",
            code_commit="commit-test",
            replay_artifact_refs=("raw-only-probation.json",),
            objective_scorecard={
                "net_pnl_per_day": "900",
                "target_met": False,
                "oracle_passed": False,
                "active_day_ratio": "1",
                "positive_day_ratio": "1",
                "best_day_share": "0.10",
                "worst_day_loss": "0",
                "trade_decision_count": 20,
                "orders_submitted_count": 20,
                "trade_count": 20,
                "profit_target_oracle": {
                    "blockers": ["deployable_lower_bound_proof_missing"],
                },
            },
            fold_metrics=(),
            stress_metrics=(),
            cost_calibration={"status": "provisional", "source": "paper_runtime"},
            null_comparator={},
            promotion_readiness={},
        )
        bridge_scorecard = {
            **close_evidence.objective_scorecard,
            "net_pnl_per_day": "315",
            "market_impact_stress_net_pnl_per_day": "290",
            "delay_adjusted_depth_stress_net_pnl_per_day": "280",
            "post_cost_net_pnl_after_queue_position_survival_fill_stress": "260",
            "double_oos_net_pnl_per_day": "270",
            "double_oos_cost_shock_net_pnl_per_day": "270",
            "implementation_uncertainty_lower_net_pnl_per_day": "260",
            "conformal_tail_risk_adjusted_net_pnl_per_day": "260",
            "exact_replay_ledger_artifact_ref": "bridge-probation-exact-replay-ledger.json",
            "runtime_ledger_artifact_row_count": 18,
            "runtime_ledger_artifact_fill_count": 6,
        }
        bridge_evidence = replace(
            close_evidence,
            evidence_bundle_id="ev-bridge-probation",
            candidate_id="cand-bridge-probation",
            candidate_spec_id=bridge_spec.candidate_spec_id,
            dataset_snapshot_id="snapshot-bridge-probation",
            feature_spec_hash="hash-bridge-probation",
            replay_artifact_refs=(
                "bridge-probation.json",
                "bridge-probation-exact-replay-ledger.json",
            ),
            objective_scorecard=bridge_scorecard,
        )

        board = runner._candidate_board_payload(
            epoch_id="epoch-paper-probation-economics",
            output_dir=Path("/tmp/epoch-paper-probation-economics"),
            target=Decimal("500"),
            candidate_specs=(weak_spec, close_spec, bridge_spec, raw_only_spec),
            candidate_selection={
                "rows": [
                    {
                        "candidate_spec_id": weak_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    },
                    {
                        "candidate_spec_id": close_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    },
                    {
                        "candidate_spec_id": bridge_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    },
                    {
                        "candidate_spec_id": raw_only_spec.candidate_spec_id,
                        "selected_for_replay": True,
                    },
                ]
            },
            pre_replay_proposal_rows=(
                {
                    "candidate_spec_id": weak_spec.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": "9.0",
                },
                {
                    "candidate_spec_id": close_spec.candidate_spec_id,
                    "rank": 2,
                    "proposal_score": "8.0",
                },
                {
                    "candidate_spec_id": raw_only_spec.candidate_spec_id,
                    "rank": 3,
                    "proposal_score": "7.0",
                },
                {
                    "candidate_spec_id": bridge_spec.candidate_spec_id,
                    "rank": 4,
                    "proposal_score": "6.0",
                },
            ),
            proposal_rows=(),
            evidence_bundles=(
                weak_evidence,
                close_evidence,
                bridge_evidence,
                raw_only_evidence,
            ),
            portfolio=None,
            promotion_readiness={"promotable": False},
            runtime_closure={},
            paper_probation_target_limit=2,
        )

        probation_candidate = board["paper_probation_candidate"]
        self.assertEqual(probation_candidate["candidate_id"], "cand-close-probation")
        self.assertEqual(board["paper_probation_target_limit"], 2)
        self.assertEqual(
            [
                candidate["candidate_id"]
                for candidate in board["paper_probation_candidates"]
            ],
            ["cand-close-probation", "cand-bridge-probation"],
        )
        self.assertEqual(
            probation_candidate["selection_reason"],
            "closest_lower_bound_economics_below_target",
        )
        self.assertEqual(
            probation_candidate["probation_lower_bound_net_pnl_per_day"], "430"
        )
        self.assertEqual(probation_candidate["probation_target_shortfall"], "70")
        self.assertEqual(
            probation_candidate["deployable_lower_bound_missing_count"],
            0,
        )
        self.assertFalse(probation_candidate["final_promotion_allowed"])
        self.assertEqual(board["runtime_window_import_plan"]["target_count"], 2)
        self.assertEqual(
            [
                target["candidate_id"]
                for target in board["runtime_window_import_plan"]["targets"]
            ],
            ["cand-close-probation", "cand-bridge-probation"],
        )

    def test_candidate_board_paper_probation_requires_runtime_ledger_admission(
        self,
    ) -> None:
        generic_row = {
            "candidate_spec_id": "spec-generic-paper",
            "candidate_id": "cand-generic-paper",
            "hypothesis_id": "hyp-generic-paper",
            "runtime_family": "microbar_cross_sectional_pairs",
            "runtime_strategy_name": "microbar_cross_sectional_pairs-runtime",
            "replay_artifact_refs": ["generic-replay.json"],
        }
        ledger_row = {
            **generic_row,
            "candidate_spec_id": "spec-ledger-paper",
            "candidate_id": "cand-ledger-paper",
            "exact_replay_ledger_artifact_ref": "ledger-exact-replay-ledger.json",
            "runtime_ledger_artifact_row_count": 18,
            "runtime_ledger_artifact_fill_count": 6,
            "runtime_window_start": "2026-05-18",
            "runtime_window_end": "2026-05-20",
        }

        self.assertEqual(
            runner._candidate_board_paper_probation_admission_blockers(generic_row),
            [
                "paper_probation_runtime_ledger_artifact_missing",
                "paper_probation_runtime_ledger_row_count_missing",
                "paper_probation_runtime_ledger_fill_count_missing",
                "paper_probation_runtime_window_bounds_missing",
            ],
        )
        self.assertEqual(
            runner._candidate_board_paper_probation_admission_blockers(ledger_row),
            [],
        )

    def test_candidate_board_single_paper_probation_fallback_blocker(self) -> None:
        row = {
            "candidate_spec_id": "spec-single-probation",
            "candidate_id": "cand-single-probation",
            "hypothesis_id": "H-MICRO-01",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "has_replay_evidence": True,
            "oracle_passed": False,
            "target_met": False,
            "decision_count": 4,
            "submitted_order_count": 4,
            "filled_order_count": 4,
            "exact_replay_ledger_artifact_ref": "single-exact-replay-ledger.json",
            "runtime_ledger_artifact_row_count": 12,
            "runtime_ledger_artifact_fill_count": 4,
            "runtime_window_start": "2026-05-18",
            "runtime_window_end": "2026-05-20",
            "net_pnl_per_day": "215",
            "market_impact_stress_passed": True,
            "market_impact_stress_net_pnl_per_day": "190",
            "delay_adjusted_depth_stress_passed": True,
            "delay_adjusted_depth_stress_net_pnl_per_day": "180",
            "post_cost_net_pnl_after_queue_position_survival_fill_stress": "170",
            "double_oos_passed": True,
            "double_oos_cost_shock_net_pnl_per_day": "175",
            "implementation_uncertainty_stability_passed": True,
            "implementation_uncertainty_lower_net_pnl_per_day": "165",
            "conformal_tail_risk_passed": True,
            "conformal_tail_risk_adjusted_net_pnl_per_day": "160",
            "delay_adjusted_depth_fill_survival_evidence_present": True,
            "delay_adjusted_depth_fill_survival_sample_count": 4,
            "delay_adjusted_depth_fill_survival_rate": "0.85",
            "queue_position_survival_fill_curve_evidence_present": True,
            "queue_position_survival_sample_count": 4,
            "queue_position_survival_fill_rate": "0.85",
            "queue_position_survival_queue_ratio_p95": "0.25",
            "queue_position_survival_queue_ahead_depletion_evidence_present": True,
            "queue_position_survival_queue_ahead_depletion_sample_count": 4,
            "delay_adjusted_depth_queue_ahead_depletion_evidence_present": True,
            "delay_adjusted_depth_queue_ahead_depletion_sample_count": 4,
            "queue_ahead_depletion_evidence_present": True,
            "queue_ahead_depletion_sample_count": 4,
            "blockers": [],
        }

        candidate = runner._candidate_board_paper_probation_candidate(
            [row],
            target=Decimal("500"),
        )

        self.assertIsNotNone(candidate)
        assert candidate is not None
        self.assertEqual(candidate["candidate_id"], "cand-single-probation")
        self.assertEqual(
            candidate["final_promotion_blockers"],
            ["final_promotion_requires_runtime_governance"],
        )
        self.assertFalse(candidate["final_promotion_allowed"])
        self.assertIsNone(
            runner._candidate_board_paper_probation_candidate(
                [],
                target=Decimal("500"),
            )
        )

    def test_candidate_board_runtime_window_plan_dedupes_and_blocks_incomplete_targets(
        self,
    ) -> None:
        row = {
            "candidate_spec_id": "spec-runtime-plan",
            "candidate_id": "cand-runtime-plan",
            "hypothesis_id": "H-MICRO-01",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "dataset_snapshot_id": "snapshot-runtime-plan",
            "replay_artifact_refs": [
                "paper-runtime-plan.json",
                "paper-runtime-plan-exact-replay-ledger.json",
            ],
            "exact_replay_ledger_artifact_ref": "paper-runtime-plan-exact-replay-ledger.json",
            "runtime_ledger_artifact_row_count": 36,
            "runtime_ledger_artifact_fill_count": 12,
            "runtime_window_start": "2026-05-18T13:30:00+00:00",
            "runtime_window_end": "2026-05-20T20:00:00+00:00",
            "account_label": "TORGHUT_REPLAY",
            "blockers": ["delay_adjusted_depth_tail_coverage_passed_failed"],
        }
        fallback_row = {
            "candidate_spec_id": "spec-runtime-plan-fallback",
            "candidate_id": "cand-runtime-plan-fallback",
            "hypothesis_id": "H-MICRO-02",
            "runtime_family": "microstructure_breakout",
            "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            "dataset_snapshot_id": "snapshot-runtime-plan-fallback",
            "exact_replay_ledger_artifact_refs": "fallback-exact-replay-ledger.json",
            "runtime_ledger_artifact_refs": [
                "fallback-runtime-ledger.json",
                "",
            ],
            "runtime_window_start": "2026-05-21T13:30:00+00:00",
            "runtime_window_end": "2026-05-21T20:00:00+00:00",
        }

        plan = runner._candidate_board_runtime_window_import_plan(
            rows=(row,),
            paper_probation_candidate=row,
            promotion_subject={
                "target_met": True,
                "sleeve_candidate_spec_ids": ["spec-runtime-plan"],
            },
        )
        fallback_plan = runner._candidate_board_runtime_window_import_plan(
            rows=(),
            paper_probation_candidate=fallback_row,
            promotion_subject=None,
        )
        incomplete_plan = runner._candidate_board_runtime_window_import_plan(
            rows=(),
            paper_probation_candidate={
                "candidate_spec_id": "spec-incomplete",
                "candidate_id": "",
                "hypothesis_id": "",
                "runtime_family": "microstructure_breakout",
                "runtime_strategy_name": "microbar-volume-continuation-long-top2-chip-v1",
            },
            promotion_subject=None,
        )

        self.assertEqual(
            runner._candidate_board_hypothesis_manifest_ref(None),
            "",
        )
        self.assertEqual(
            runner._candidate_board_runtime_window_bounds(
                {
                    "runtime_window_start": "2026-05-01",
                    "runtime_window_end": "2026-05-02",
                }
            ),
            ("2026-05-01", "2026-05-02"),
        )
        self.assertEqual(plan["target_count"], 1)
        self.assertEqual(
            plan["targets"][0]["source_manifest_ref"],
            "config/trading/hypotheses/h-micro-01.json",
        )
        self.assertEqual(plan["targets"][0]["candidate_blockers"], row["blockers"])
        self.assertEqual(
            plan["targets"][0]["runtime_ledger_artifact_refs"],
            ["paper-runtime-plan-exact-replay-ledger.json"],
        )
        self.assertEqual(
            plan["targets"][0]["window_start"], "2026-05-18T13:30:00+00:00"
        )
        self.assertEqual(plan["targets"][0]["window_end"], "2026-05-20T20:00:00+00:00")
        self.assertEqual(plan["targets"][0]["account_label"], "TORGHUT_REPLAY")
        self.assertIn(
            "paper-runtime-plan-exact-replay-ledger.json",
            plan["targets"][0]["import_command_args"],
        )
        self.assertIn(
            "--target-metadata-json",
            plan["targets"][0]["import_command_args"],
        )
        metadata_arg_index = (
            plan["targets"][0]["import_command_args"].index("--target-metadata-json")
            + 1
        )
        import_metadata = json.loads(
            plan["targets"][0]["import_command_args"][metadata_arg_index]
        )
        self.assertEqual(
            import_metadata["runtime_ledger_artifact_refs"],
            ["paper-runtime-plan-exact-replay-ledger.json"],
        )
        self.assertEqual(import_metadata["runtime_ledger_artifact_row_count"], 36)
        self.assertEqual(import_metadata["runtime_ledger_artifact_fill_count"], 12)
        self.assertEqual(import_metadata["window_start"], "2026-05-18T13:30:00+00:00")
        self.assertEqual(import_metadata["window_end"], "2026-05-20T20:00:00+00:00")
        self.assertEqual(fallback_plan["status"], "ready")
        self.assertEqual(fallback_plan["target_count"], 1)
        self.assertEqual(
            fallback_plan["targets"][0]["runtime_ledger_artifact_refs"],
            [
                "fallback-exact-replay-ledger.json",
                "fallback-runtime-ledger.json",
            ],
        )
        self.assertEqual(
            fallback_plan["targets"][0]["exact_replay_ledger_artifact_ref"],
            "fallback-exact-replay-ledger.json",
        )
        self.assertEqual(
            fallback_plan["targets"][0]["runtime_ledger_artifact_ref"],
            "fallback-exact-replay-ledger.json",
        )
        self.assertEqual(
            fallback_plan["targets"][0]["account_label"],
            "TORGHUT_REPLAY",
        )
        self.assertEqual(incomplete_plan["status"], "blocked")
        self.assertEqual(incomplete_plan["target_count"], 0)
        self.assertEqual(
            incomplete_plan["blockers"][0]["missing_fields"],
            [
                "candidate_id",
                "hypothesis_id",
                "window_start",
                "window_end",
                "account_label",
            ],
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
        with TemporaryDirectory() as tmpdir, _compact_recent_whitepaper_sources(4):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 1
            args.exploration_slots = 1
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 6
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
        selected_reasons = {row["selection_reason"] for row in selected_rows}
        self.assertIn("runtime_strategy_floor", selected_reasons)
        self.assertLessEqual(
            selected_reasons,
            {
                "runtime_strategy_floor",
                "exploitation",
                "exploration",
                "budget_backfill",
            },
        )
        proposal_selected = [row for row in proposal_rows if row["selected_for_replay"]]
        self.assertEqual(len(proposal_selected), 3)
        proposal_reasons = {row["replay_selection_reason"] for row in proposal_selected}
        self.assertIn("runtime_strategy_floor", proposal_reasons)
        self.assertLessEqual(
            proposal_reasons,
            {
                "runtime_strategy_floor",
                "exploitation",
                "exploration",
                "budget_backfill",
            },
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
        with TemporaryDirectory() as tmpdir, _compact_recent_whitepaper_sources(4):
            output_dir = Path(tmpdir) / "epoch"
            args = self._args(output_dir)
            args.top_k = 3
            args.exploration_slots = 0
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 6
            payload = runner.run_whitepaper_autoresearch_profit_target(args)

            selection = json.loads(
                (output_dir / "candidate-selection-manifest.json").read_text(
                    encoding="utf-8"
                )
            )

        self.assertEqual(payload["status"], "no_profit_target_candidate")
        replay_rows = sorted(
            [row for row in selection["rows"] if row["selected_for_replay"]],
            key=lambda row: row["replay_order"],
        )
        self.assertEqual(len(replay_rows), 3)
        self.assertGreater(
            sum(
                1
                for row in replay_rows
                if row["selection_reason"] == "runtime_strategy_floor"
            ),
            0,
        )
        self.assertGreater(
            len({row["runtime_strategy_name"] for row in replay_rows}),
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

    def test_candidate_selection_reserves_distinct_runtime_strategy_floor(
        self,
    ) -> None:
        breakout_primary = replace(
            self._candidate_spec(
                "spec-breakout-primary",
                family_template_id="microstructure_continuation_matched_filter_v1",
            ),
            runtime_family="breakout_continuation_consistent",
            runtime_strategy_name="breakout-continuation-long-v1",
        )
        breakout_secondary = replace(
            self._candidate_spec(
                "spec-breakout-secondary",
                family_template_id="opening_drive_leader_reclaim_v1",
            ),
            runtime_family="breakout_continuation_consistent",
            runtime_strategy_name="breakout-continuation-long-v1",
        )
        intraday = replace(
            self._candidate_spec(
                "spec-intraday", family_template_id="intraday_tsmom_v2"
            ),
            runtime_family="intraday_tsmom_consistent",
            runtime_strategy_name="intraday-tsmom-profit-v3",
        )
        late_day = replace(
            self._candidate_spec(
                "spec-late-day", family_template_id="late_day_continuation_v1"
            ),
            runtime_family="late_day_continuation_consistent",
            runtime_strategy_name="late-day-continuation-long-v1",
        )

        selected, selection = runner._select_candidate_specs_for_replay(
            specs=(breakout_primary, breakout_secondary, intraday, late_day),
            proposal_rows=[
                {
                    "candidate_spec_id": breakout_primary.candidate_spec_id,
                    "rank": 1,
                    "proposal_score": 100.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
                {
                    "candidate_spec_id": breakout_secondary.candidate_spec_id,
                    "rank": 2,
                    "proposal_score": 99.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
                {
                    "candidate_spec_id": intraday.candidate_spec_id,
                    "rank": 3,
                    "proposal_score": 10.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
                {
                    "candidate_spec_id": late_day.candidate_spec_id,
                    "rank": 4,
                    "proposal_score": 5.0,
                    "selection_reason": "pre_replay_mlx_rank",
                },
            ],
            top_k=2,
            exploration_slots=0,
            max_candidates=3,
            portfolio_size_min=2,
        )

        selected_runtime_names = {spec.runtime_strategy_name for spec in selected}
        self.assertEqual(
            selected_runtime_names,
            {
                "breakout-continuation-long-v1",
                "intraday-tsmom-profit-v3",
                "late-day-continuation-long-v1",
            },
        )
        row_by_spec = {row["candidate_spec_id"]: row for row in selection["rows"]}
        self.assertEqual(
            row_by_spec[intraday.candidate_spec_id]["selection_reason"],
            "runtime_strategy_floor",
        )
        self.assertEqual(
            row_by_spec[late_day.candidate_spec_id]["selection_reason"],
            "runtime_strategy_floor",
        )
        self.assertEqual(
            selection["budget"]["runtime_strategy_floor_selected_count"],
            3,
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
                        **vars(self._source_jsonl_args(Path(tmpdir) / "epoch")),
                        "target_net_pnl_per_day": "999999",
                        "exploration_slots": 0,
                        "max_candidates": 1,
                        "max_frontier_candidates_per_spec": 1,
                        "max_total_frontier_candidates": 1,
                        "portfolio_size_min": 1,
                        "portfolio_size_max": 1,
                        "top_k": 1,
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
            summary["status_reason"], "portfolio_optimizer_produced_no_candidate"
        )
        self.assertFalse(summary["oracle_candidate_found"])
        self.assertIsNone(summary["profit_target_oracle"])
        self.assertEqual(
            summary["promotion_readiness"]["status"],
            "no_candidate",
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
            _compact_recent_whitepaper_sources(4),
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            args = self._args(Path(tmpdir) / "epoch")
            args.max_frontier_candidates_per_spec = 2
            args.max_total_frontier_candidates = 6
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

    def test_epoch_ledgers_persist_promotion_ready_only_from_readiness_payload(
        self,
    ) -> None:
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-readiness-test",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"oracle_passed": True, "target_met": True},
            optimizer_report={},
        )
        started_at = datetime(2026, 5, 8, 17, 0, 0)
        completed_at = datetime(2026, 5, 8, 17, 1, 0)

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            runner._persist_epoch_ledgers(
                epoch_id="epoch-readiness-blocked",
                status="ok",
                target_net_pnl_per_day=Decimal("500"),
                paper_run_ids=[],
                sources=[],
                candidate_specs=[],
                proposal_rows=[],
                portfolio=portfolio,
                summary={
                    "promotion_readiness": {
                        "status": "blocked_pending_promotion_prerequisites",
                        "promotable": False,
                        "blockers": ["promotion_gate_report_denied"],
                    }
                },
                runner_config={},
                started_at=started_at,
                completed_at=completed_at,
            )
            runner._persist_epoch_ledgers(
                epoch_id="epoch-readiness-ready",
                status="ok",
                target_net_pnl_per_day=Decimal("500"),
                paper_run_ids=[],
                sources=[],
                candidate_specs=[],
                proposal_rows=[],
                portfolio=replace(
                    portfolio, portfolio_candidate_id="portfolio-readiness-ready"
                ),
                summary={
                    "promotion_readiness": {
                        "status": "promotion_ready",
                        "promotable": True,
                        "blockers": [],
                    }
                },
                runner_config={},
                started_at=started_at,
                completed_at=completed_at,
            )

        with Session(self.engine) as session:
            portfolios = (
                session.execute(
                    select(AutoresearchPortfolioCandidate).order_by(
                        AutoresearchPortfolioCandidate.portfolio_candidate_id.asc()
                    )
                )
                .scalars()
                .all()
            )

        self.assertEqual(
            [item.status for item in portfolios], ["promotion_ready", "target_met"]
        )
        blocked_payload = next(
            item
            for item in portfolios
            if item.portfolio_candidate_id == "portfolio-readiness-test"
        )
        self.assertEqual(
            blocked_payload.payload_json["promotion_readiness"]["blockers"],
            ["promotion_gate_report_denied"],
        )

    def test_epoch_ledgers_persist_target_met_oracle_failed_as_paper_probation(
        self,
    ) -> None:
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-paper-probation",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"oracle_passed": False, "target_met": True},
            optimizer_report={},
        )
        started_at = datetime(2026, 5, 8, 17, 0, 0)
        completed_at = datetime(2026, 5, 8, 17, 1, 0)

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            runner._persist_epoch_ledgers(
                epoch_id="epoch-paper-probation",
                status="ok",
                target_net_pnl_per_day=Decimal("500"),
                paper_run_ids=[],
                sources=[],
                candidate_specs=[],
                proposal_rows=[],
                portfolio=portfolio,
                summary={
                    "promotion_readiness": {
                        "status": "blocked_pending_promotion_prerequisites",
                        "promotable": False,
                        "blockers": ["oracle_blocked"],
                    },
                    "candidate_board": {
                        "paper_probation_candidate": {
                            "candidate_id": "candidate-test",
                            "paper_probation_authorized": True,
                        }
                    },
                },
                runner_config={},
                started_at=started_at,
                completed_at=completed_at,
            )

        with Session(self.engine) as session:
            saved = session.execute(select(AutoresearchPortfolioCandidate)).scalar_one()

        self.assertEqual(saved.status, "paper_probation")
        self.assertFalse(saved.payload_json["promotion_readiness"]["promotable"])
        self.assertEqual(
            saved.payload_json["promotion_readiness"]["blockers"], ["oracle_blocked"]
        )

    def test_epoch_ledgers_keep_target_met_oracle_failed_blocked_without_paper_probation_authority(
        self,
    ) -> None:
        portfolio = runner.PortfolioCandidateSpec(
            schema_version="torghut.portfolio-candidate-spec.v1",
            portfolio_candidate_id="portfolio-paper-probation-blocked",
            source_candidate_ids=("candidate-test",),
            target_net_pnl_per_day=Decimal("500"),
            sleeves=(),
            capital_budget={},
            correlation_budget={},
            drawdown_budget={},
            evidence_refs=(),
            objective_scorecard={"oracle_passed": False, "target_met": True},
            optimizer_report={},
        )
        started_at = datetime(2026, 5, 8, 17, 0, 0)
        completed_at = datetime(2026, 5, 8, 17, 1, 0)

        with patch(
            "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
            side_effect=lambda: Session(self.engine),
        ):
            runner._persist_epoch_ledgers(
                epoch_id="epoch-paper-probation-blocked",
                status="ok",
                target_net_pnl_per_day=Decimal("500"),
                paper_run_ids=[],
                sources=[],
                candidate_specs=[],
                proposal_rows=[],
                portfolio=portfolio,
                summary={
                    "promotion_readiness": {
                        "status": "blocked_pending_promotion_prerequisites",
                        "promotable": False,
                        "blockers": ["oracle_blocked"],
                    }
                },
                runner_config={},
                started_at=started_at,
                completed_at=completed_at,
            )

        with Session(self.engine) as session:
            saved = session.execute(select(AutoresearchPortfolioCandidate)).scalar_one()

        self.assertEqual(saved.status, "blocked")
        self.assertFalse(saved.payload_json["promotion_readiness"]["promotable"])

    def test_feedback_evidence_loader_reconstructs_paper_probation_candidates(
        self,
    ) -> None:
        spec = self._candidate_spec("candidate-portfolio-probation")
        scorecard = {
            "target_met": True,
            "oracle_passed": False,
            "net_pnl_per_day": "525",
            "profit_target_oracle": {
                "blockers": ["delay_adjusted_depth_tail_coverage_passed_failed"]
            },
        }
        sleeve = {
            "candidate_id": "candidate-portfolio-probation",
            "candidate_spec_id": spec.candidate_spec_id,
            "family_template_id": spec.family_template_id,
            "runtime_family": spec.runtime_family,
            "runtime_strategy_name": spec.runtime_strategy_name,
            "weight": "1.00",
            "expected_net_pnl_per_day": "525",
            "source_expected_net_pnl_per_day": "525",
            "risk_contribution": "2500",
            "source_risk_contribution": "2500",
            "correlation_cluster": "NVDA",
            "params": {"signal_motif": "order_flow_continuation"},
            "universe_symbols": ["NVDA"],
        }

        with (
            Session(self.engine) as session,
            patch(
                "scripts.run_whitepaper_autoresearch_profit_target.SessionLocal",
                side_effect=lambda: Session(self.engine),
            ),
        ):
            session.add(
                AutoresearchPortfolioCandidate(
                    portfolio_candidate_id="portfolio-feedback-probation",
                    epoch_id="portfolio-feedback-probation-epoch",
                    source_candidate_ids_json=["candidate-portfolio-probation"],
                    target_net_pnl_per_day=Decimal("500"),
                    objective_scorecard_json=scorecard,
                    optimizer_report_json={"method": "test"},
                    payload_json={
                        "schema_version": "torghut.portfolio-candidate-spec.v1",
                        "portfolio_candidate_id": "portfolio-feedback-probation",
                        "source_candidate_ids": ["candidate-portfolio-probation"],
                        "target_net_pnl_per_day": "500",
                        "sleeves": [sleeve],
                        "objective_scorecard": scorecard,
                        "optimizer_report": {"method": "test"},
                        "promotion_readiness": {
                            "stage": "research_portfolio",
                            "status": "blocked_pending_promotion_prerequisites",
                            "promotable": False,
                            "blockers": [
                                "delay_adjusted_depth_tail_coverage_passed_failed"
                            ],
                        },
                    },
                    status="paper_probation",
                )
            )
            session.commit()

            loaded, manifest = runner._load_recent_persisted_feedback_evidence_bundles()

        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].candidate_spec_id, spec.candidate_spec_id)
        self.assertEqual(
            loaded[0].objective_scorecard["portfolio_status"], "paper_probation"
        )
        self.assertIn(
            "delay_adjusted_depth_tail_coverage_passed_failed",
            loaded[0].objective_scorecard["portfolio_blockers"],
        )
        self.assertEqual(manifest["portfolio_candidate_bundle_count"], 1)

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
            args = self._source_jsonl_args(output_dir)
            args.max_candidates = 1
            args.max_frontier_candidates_per_spec = 1
            args.max_total_frontier_candidates = 1
            args.portfolio_size_min = 1
            args.portfolio_size_max = 1
            args.top_k = 1
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

        self.assertEqual(model_payload["schema_version"], "torghut.mlx-ranker.v7")
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

    def test_remediation_surfaces_recent_trading_day_shortfall(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason="ValueError:insufficient_recent_trading_days:9<11",
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
                    "evidence_status": "missing",
                    "failure_reasons": ["replay_evidence_missing"],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=600,
            max_frontier_candidates_per_spec=1,
            current_train_days=6,
            current_holdout_days=3,
            current_second_oos_days=2,
        )

        self.assertEqual(
            remediation["recent_trading_days"]["available_recent_trading_days"],
            9,
        )
        self.assertEqual(
            remediation["recent_trading_days"]["required_recent_trading_days"],
            11,
        )
        self.assertEqual(
            remediation["recent_trading_days"]["required_window"],
            {"train_days": 6, "holdout_days": 3, "second_oos_days": 2},
        )
        day_action = remediation["next_actions"][0]
        self.assertEqual(
            day_action["action"], "inspect_or_backfill_recent_ta_signal_days"
        )
        self.assertIn("torghut.ta_signals", day_action["recommended_operator_probe"])
        self.assertIn(
            "torghut.ta_microbars",
            remediation["recent_trading_days"][
                "clickhouse_signal_microbar_coverage_query"
            ],
        )
        self.assertIn(
            "torghut.ta_microbars",
            remediation["recent_trading_days"][
                "clickhouse_signal_microbar_day_gap_query"
            ],
        )
        self.assertEqual(
            day_action["recommended_coverage_probe"],
            remediation["recent_trading_days"]["clickhouse_coverage_probe_queries"][
                "signal_microbar_coverage"
            ],
        )
        self.assertEqual(
            day_action["recommended_day_gap_probe"],
            remediation["recent_trading_days"]["clickhouse_coverage_probe_queries"][
                "signal_microbar_day_gap"
            ],
        )

    def test_remediation_surfaces_stale_tape_shortfall(self) -> None:
        remediation = runner._candidate_search_remediation(
            failure_reason=(
                "ValueError:stale_tape:"
                "expected_last_trading_day=2026-05-19:end_day=2026-05-18"
            ),
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
                    "evidence_status": "missing",
                    "failure_reasons": ["replay_evidence_missing"],
                },
            ),
            best_false_negative_table=(),
            replay_timeout_seconds=600,
            max_frontier_candidates_per_spec=1,
        )

        self.assertEqual(
            remediation["stale_tape"],
            {
                "expected_last_trading_day": "2026-05-19",
                "available_end_day": "2026-05-18",
            },
        )
        stale_action = remediation["next_actions"][0]
        self.assertEqual(
            stale_action["action"], "inspect_or_backfill_latest_ta_signal_day"
        )
        self.assertIn("torghut.ta_signals", stale_action["recommended_operator_probe"])
        self.assertIn("2026-05-18", stale_action["diagnostic_replay_note"])

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
                        "market_impact_liquidity_evidence_present_failed",
                        "market_impact_stress_model_failed",
                        "market_impact_stress_cost_bps_failed",
                        "delay_adjusted_depth_stress_model_failed",
                        "delay_adjusted_depth_stress_ms_failed",
                        "double_oos_artifact_present_failed",
                        "double_oos_cost_shock_net_pnl_per_day_failed",
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
            "complete_runtime_closure_double_oos_and_shadow_evidence",
        )
        self.assertEqual(
            proof_action["blocking_failure_counts"]["executable_replay_not_passed"],
            1,
        )
        self.assertIn(
            "executable_replay_artifact_ref",
            proof_action["required_scorecard_fields"],
        )
        self.assertIn(
            "market_impact_liquidity_evidence_present",
            proof_action["required_scorecard_fields"],
        )
        self.assertIn(
            "delay_adjusted_depth_stress_model",
            proof_action["required_scorecard_fields"],
        )
        self.assertIn(
            "double_oos_cost_shock_net_pnl_per_day",
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
            == "complete_runtime_closure_double_oos_and_shadow_evidence"
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
                    "--candidate-specs",
                    str(Path(tmpdir) / "selected-candidate-specs.jsonl"),
                    "--clickhouse-password-env",
                    "TORGHUT_CLICKHOUSE_PASSWORD",
                    "--max-total-frontier-candidates",
                    "7",
                    "--staged-train-screen-multiplier",
                    "4",
                    "--capture-rejected-seed-full-window-ledger",
                    "--capture-positive-rejected-full-window-ledgers",
                    "3",
                    "--symbol-prune-iterations",
                    "1",
                    "--symbol-prune-candidates",
                    "2",
                    "--symbol-prune-min-universe-size",
                    "4",
                    "--loss-repair-iterations",
                    "1",
                    "--loss-repair-candidates",
                    "2",
                    "--consistency-repair-iterations",
                    "1",
                    "--consistency-repair-candidates",
                    "5",
                    "--replay-tape-path",
                    str(Path(tmpdir) / "tape.jsonl"),
                    "--replay-tape-manifest",
                    str(Path(tmpdir) / "tape.manifest.json"),
                    "--materialize-replay-tape",
                    "--selection-only",
                    "--no-persist-results",
                ],
            ):
                parsed = runner._parse_args()

        self.assertEqual(parsed.output_dir, output_dir)
        self.assertEqual(parsed.epoch_id, "whitepaper-autoresearch-cli-epoch")
        self.assertTrue(parsed.seed_recent_whitepapers)
        self.assertEqual(parsed.replay_mode, "synthetic")
        self.assertEqual(parsed.source_jsonl, [source_path])
        self.assertEqual(
            parsed.candidate_specs, [Path(tmpdir) / "selected-candidate-specs.jsonl"]
        )
        self.assertEqual(parsed.clickhouse_password_env, "TORGHUT_CLICKHOUSE_PASSWORD")
        self.assertEqual(parsed.symbols, ",".join(_CHIP_UNIVERSE))
        self.assertEqual(
            parsed.max_frontier_candidates_per_spec,
            runner._DEFAULT_MAX_FRONTIER_CANDIDATES_PER_SPEC,
        )
        self.assertEqual(parsed.max_total_frontier_candidates, 7)
        self.assertEqual(parsed.staged_train_screen_multiplier, 4)
        self.assertTrue(parsed.capture_rejected_seed_full_window_ledger)
        self.assertEqual(parsed.capture_positive_rejected_full_window_ledgers, 3)
        self.assertEqual(parsed.symbol_prune_iterations, 1)
        self.assertEqual(parsed.symbol_prune_candidates, 2)
        self.assertEqual(parsed.symbol_prune_min_universe_size, 4)
        self.assertEqual(parsed.loss_repair_iterations, 1)
        self.assertEqual(parsed.loss_repair_candidates, 2)
        self.assertEqual(parsed.consistency_repair_iterations, 1)
        self.assertEqual(parsed.consistency_repair_candidates, 5)
        self.assertEqual(parsed.real_replay_shard_size, 0)
        self.assertEqual(parsed.real_replay_shard_timeout_seconds, 0)
        self.assertEqual(parsed.real_replay_shard_workers, 1)
        self.assertEqual(
            parsed.real_replay_max_parallel_frontier_candidates,
            runner._DEFAULT_REAL_REPLAY_MAX_PARALLEL_FRONTIER_CANDIDATES,
        )
        self.assertEqual(parsed.replay_tape_path, Path(tmpdir) / "tape.jsonl")
        self.assertEqual(
            parsed.replay_tape_manifest, Path(tmpdir) / "tape.manifest.json"
        )
        self.assertTrue(parsed.materialize_replay_tape)
        self.assertTrue(parsed.selection_only)
        self.assertEqual(parsed.max_worst_day_loss, "999999999")
        self.assertEqual(parsed.max_drawdown, "999999999")
        self.assertEqual(parsed.min_profit_factor, "1.50")
        self.assertEqual(parsed.max_worst_day_loss_pct_equity, "0.05")
        self.assertEqual(parsed.max_drawdown_pct_equity, "0.08")
        self.assertEqual(parsed.extended_max_worst_day_loss_pct_equity, "0.08")
        self.assertEqual(parsed.extended_max_drawdown_pct_equity, "0.12")
        self.assertEqual(parsed.min_total_net_pnl_to_drawdown_ratio, "3.00")
        self.assertEqual(parsed.max_gross_exposure_pct_equity, "1.0")
        self.assertEqual(parsed.min_cash, "0")
        self.assertEqual(parsed.max_negative_cash_observation_count, 0)
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
            args.exploration_slots = 0
            args.max_candidates = 1
            args.max_frontier_candidates_per_spec = 1
            args.max_total_frontier_candidates = 1
            args.portfolio_size_min = 1
            args.portfolio_size_max = 1
            args.top_k = 1
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
            args.max_frontier_candidates_per_spec = 1
            args.max_total_frontier_candidates = 4
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
            captured_replay_tapes: list[tuple[Path | None, Path | None]] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_symbols.append(str(factory_args.symbols))
                captured_replay_tapes.append(
                    (
                        factory_args.replay_tape_path,
                        factory_args.replay_tape_manifest,
                    )
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
                args.replay_tape_path = output_dir / "tape.jsonl"
                args.replay_tape_manifest = output_dir / "tape.manifest.json"
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_symbols, [""])
        self.assertEqual(
            captured_replay_tapes,
            [(output_dir / "tape.jsonl", output_dir / "tape.manifest.json")],
        )
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

    def test_real_replay_caps_source_spec_frontier_budget_from_global_budget(
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
                captured_budget.append(int(factory_args.max_candidates_to_evaluate))
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
                args.max_frontier_candidates_per_spec = 64
                args.max_total_frontier_candidates = 8
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:8],
                )

        self.assertEqual(captured_budget, [1])
        self.assertEqual(len(result.evidence_bundles), 0)

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

    def test_real_replay_forwards_frontier_repair_and_proof_capture_controls(
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
            captured_multiplier: list[int] = []
            captured_controls: list[dict[str, object]] = []

            def fake_run(
                factory_args: Namespace, *, source_specs: object
            ) -> dict[str, object]:
                captured_multiplier.append(
                    int(factory_args.staged_train_screen_multiplier)
                )
                captured_controls.append(
                    {
                        "capture_rejected_seed_full_window_ledger": bool(
                            factory_args.capture_rejected_seed_full_window_ledger
                        ),
                        "capture_positive_rejected_full_window_ledgers": int(
                            factory_args.capture_positive_rejected_full_window_ledgers
                        ),
                        "symbol_prune_iterations": int(
                            factory_args.symbol_prune_iterations
                        ),
                        "symbol_prune_candidates": int(
                            factory_args.symbol_prune_candidates
                        ),
                        "symbol_prune_min_universe_size": int(
                            factory_args.symbol_prune_min_universe_size
                        ),
                        "loss_repair_iterations": int(
                            factory_args.loss_repair_iterations
                        ),
                        "loss_repair_candidates": int(
                            factory_args.loss_repair_candidates
                        ),
                        "consistency_repair_iterations": int(
                            factory_args.consistency_repair_iterations
                        ),
                        "consistency_repair_candidates": int(
                            factory_args.consistency_repair_candidates
                        ),
                    }
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
                args.staged_train_screen_multiplier = 3
                args.capture_rejected_seed_full_window_ledger = True
                args.capture_positive_rejected_full_window_ledgers = 2
                args.symbol_prune_iterations = 1
                args.symbol_prune_candidates = 2
                args.symbol_prune_min_universe_size = 4
                args.loss_repair_iterations = 1
                args.loss_repair_candidates = 1
                args.consistency_repair_iterations = 1
                args.consistency_repair_candidates = 2
                result = runner._run_real_replay(
                    args,
                    output_dir=output_dir,
                    specs=compilation.executable_specs[:1],
                )

        self.assertEqual(captured_multiplier, [3])
        self.assertEqual(
            captured_controls,
            [
                {
                    "capture_rejected_seed_full_window_ledger": True,
                    "capture_positive_rejected_full_window_ledgers": 2,
                    "symbol_prune_iterations": 1,
                    "symbol_prune_candidates": 2,
                    "symbol_prune_min_universe_size": 4,
                    "loss_repair_iterations": 1,
                    "loss_repair_candidates": 1,
                    "consistency_repair_iterations": 1,
                    "consistency_repair_candidates": 2,
                }
            ],
        )
        self.assertEqual(len(result.evidence_bundles), 0)

    def test_program_replay_budget_supplies_staged_train_screen_multiplier(
        self,
    ) -> None:
        args = self._args(Path("/tmp/epoch"))
        program = runner._load_epoch_program(args)
        controls = runner._resolved_real_replay_frontier_controls(args, program)

        self.assertEqual(
            runner._resolved_staged_train_screen_multiplier(args, program),
            3,
        )
        self.assertEqual(controls["symbol_prune_iterations"], 1)
        self.assertEqual(controls["symbol_prune_candidates"], 2)
        self.assertEqual(controls["symbol_prune_min_universe_size"], 5)
        self.assertEqual(controls["loss_repair_iterations"], 1)
        self.assertEqual(controls["loss_repair_candidates"], 1)
        self.assertEqual(controls["consistency_repair_iterations"], 1)
        self.assertEqual(controls["consistency_repair_candidates"], 2)
        self.assertFalse(controls["capture_rejected_seed_full_window_ledger"])
        self.assertEqual(controls["capture_positive_rejected_full_window_ledgers"], 0)
        args.staged_train_screen_multiplier = 4
        args.symbol_prune_candidates = 5
        args.capture_positive_rejected_full_window_ledgers = 6
        override_controls = runner._resolved_real_replay_frontier_controls(
            args, program
        )
        self.assertEqual(
            runner._resolved_staged_train_screen_multiplier(args, program),
            4,
        )
        self.assertEqual(override_controls["symbol_prune_candidates"], 5)
        self.assertEqual(
            override_controls["capture_positive_rejected_full_window_ledgers"], 6
        )

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

    def test_real_replay_shards_distribute_global_budget_across_one_spec_shards(
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
            specs = compilation.executable_specs[:8]
            args = self._args(output_dir)
            args.max_candidates = 24
            args.top_k = 16
            args.max_frontier_candidates_per_spec = 64
            args.max_total_frontier_candidates = 8

            plans = runner._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=1,
                shard_timeout_seconds=7,
            )

        self.assertEqual(len(plans), 8)
        self.assertEqual(
            [int(plan.args.max_total_frontier_candidates) for plan in plans],
            [1] * 8,
        )

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

    def test_real_replay_shards_caps_workers_by_parallel_frontier_budget(
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
            specs = compilation.executable_specs[:6]
            args = self._args(output_dir)
            args.max_frontier_candidates_per_spec = 4
            args.max_total_frontier_candidates = 24
            args.real_replay_shard_workers = 8
            args.real_replay_max_parallel_frontier_candidates = 10

            plans = runner._build_real_replay_shards(
                args=args,
                output_dir=output_dir,
                specs=specs,
                shard_size=2,
                shard_timeout_seconds=7,
            )

        self.assertEqual(
            [runner._replay_shard_frontier_candidate_budget(plan) for plan in plans],
            [8, 8, 8],
        )
        self.assertEqual(
            runner._bounded_real_replay_shard_workers(args=args, plans=plans),
            1,
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
            patch.object(runner, "_program_whitepaper_sources", return_value=()),
            patch("builtins.print") as mock_print,
        ):
            exit_code = runner.main()

        self.assertEqual(exit_code, 2)
        self.assertTrue(mock_print.called)
