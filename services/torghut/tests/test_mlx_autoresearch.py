from __future__ import annotations

from argparse import Namespace
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from app.trading.discovery.autoresearch import (
    ProposalModelPolicy,
    ReplayBudget,
    RuntimeClosurePolicy,
    SnapshotPolicy,
    StrategyAutoresearchProgram,
    StrategyObjective,
)
from app.trading.discovery.family_templates import FamilyTemplate
from app.trading.discovery.mlx_features import (
    MlxCandidateDescriptor,
    descriptor_from_sweep_config,
    descriptor_numeric_vector,
)
from app.trading.discovery.mlx_proposal_models import (
    ProposalScore,
    build_proposal_diagnostics,
    rank_candidate_descriptors,
    select_proposal_batch,
)
from app.trading.discovery.mlx_snapshot import (
    build_mlx_snapshot_manifest,
    write_mlx_signal_bundle,
    write_mlx_snapshot_manifest,
)
from app.trading.models import SignalEnvelope


def _template() -> FamilyTemplate:
    return FamilyTemplate(
        family_id='breakout_reclaim_v2',
        economic_mechanism='Breakout reclaim.',
        supported_markets=('us_equities_intraday',),
        required_features=('prior_day_open45_rank', 'cross_section_rank', 'quote_quality'),
        allowed_normalizations=('price_scaled',),
        entry_motifs=('breakout_reclaim',),
        exit_motifs=('time_exit',),
        risk_controls=('stop_loss',),
        activity_model={'min_active_day_ratio': '0.5'},
        liquidity_assumptions={'max_spread_bps': '30'},
        regime_activation_rules=({'rule_id': 'regime-bull'},),
        day_veto_rules=(),
        default_hard_vetoes={},
        default_selection_objectives={},
        runtime_harness={
            'family': 'breakout_continuation_consistent',
            'strategy_name': 'breakout-continuation-long-v1',
            'disable_other_strategies': True,
        },
    )


def _program() -> StrategyAutoresearchProgram:
    return StrategyAutoresearchProgram(
        program_id='program-1',
        description='desc',
        objective=StrategyObjective(
            target_net_pnl_per_day=Decimal('500'),
            min_active_day_ratio=Decimal('1.0'),
            min_positive_day_ratio=Decimal('0.6'),
            min_daily_notional=Decimal('300000'),
            max_best_day_share=Decimal('0.3'),
            max_worst_day_loss=Decimal('350'),
            max_drawdown=Decimal('900'),
            require_every_day_active=True,
            min_regime_slice_pass_rate=Decimal('0.45'),
            stop_when_objective_met=True,
        ),
        snapshot_policy=SnapshotPolicy(
            bar_interval='PT1S',
            feature_set_id='torghut.mlx-autoresearch.v1',
            quote_quality_policy_id='scheduler_v3_default',
            symbol_policy='args_or_sweep',
            allow_prior_day_features=True,
            allow_cross_sectional_features=True,
        ),
        forbidden_mutations=('runtime_code_path',),
        proposal_model_policy=ProposalModelPolicy(
            enabled=True,
            mode='ranking_only',
            backend_preference='mlx',
            top_k=4,
            exploration_slots=1,
            minimum_history_rows=1,
        ),
        replay_budget=ReplayBudget(
            max_candidates_per_round=8,
            exploration_slots=1,
            max_candidates_per_frontier_run=16,
        ),
        runtime_closure_policy=RuntimeClosurePolicy(
            enabled=False,
            execute_parity_replay=True,
            execute_approval_replay=True,
            parity_window='full_window',
            approval_window='holdout',
            shadow_validation_mode='require_live_evidence',
            promotion_target='shadow',
        ),
        parity_requirements=('scheduler_v3_parity_replay',),
        promotion_policy='research_only',
        ledger_policy={'append_only': True},
        research_sources=(),
        families=(),
    )


class TestMlxAutoresearch(TestCase):
    def test_build_snapshot_manifest_uses_program_snapshot_policy(self) -> None:
        manifest = build_mlx_snapshot_manifest(
            runner_run_id='run-1',
            program=_program(),
            symbols='AAPL,NVDA',
            train_days=6,
            holdout_days=2,
            full_window_start_date='2026-03-20',
            full_window_end_date='2026-04-09',
            row_counts={'receipt_count': 1, 'latest_row_count': 123},
        )

        self.assertEqual(manifest.feature_set_id, 'torghut.mlx-autoresearch.v1')
        self.assertEqual(manifest.quote_quality_policy_id, 'scheduler_v3_default')
        self.assertEqual(manifest.symbols, ('AAPL', 'NVDA'))
        self.assertEqual(manifest.row_counts['latest_row_count'], 123)

        with TemporaryDirectory() as tmpdir:
            path = write_mlx_snapshot_manifest(Path(tmpdir) / 'manifest.json', manifest)
            self.assertTrue(path.exists())

    def test_descriptor_from_sweep_config_captures_runtime_relevant_fields(self) -> None:
        family_plan = Namespace(family_template=_template())
        descriptor = descriptor_from_sweep_config(
            candidate_id='cand-1',
            family_plan=family_plan,  # type: ignore[arg-type]
            sweep_config={
                'parameters': {
                    'leader_reclaim_start_minutes_since_open': ['45'],
                    'max_hold_seconds': ['900'],
                    'max_entries_per_session': ['2'],
                },
                'strategy_overrides': {
                    'max_notional_per_trade': ['315900.20'],
                    'normalization_regime': ['price_scaled'],
                },
            },
        )

        self.assertEqual(descriptor.family_template_id, 'breakout_reclaim_v2')
        self.assertEqual(descriptor.entry_window_start_minute, 45)
        self.assertEqual(descriptor.max_hold_minutes, 15)
        self.assertEqual(descriptor.rank_count, 2)
        self.assertTrue(descriptor.requires_prev_day_features)
        self.assertTrue(descriptor.requires_cross_sectional_features)
        self.assertEqual(len(descriptor_numeric_vector(descriptor)), 7)

    def test_write_mlx_signal_bundle_persists_signal_rows(self) -> None:
        rows = [
            SignalEnvelope(
                event_ts=datetime(2026, 4, 9, 13, 30, tzinfo=UTC),
                symbol='NVDA',
                seq=1,
                source='ta',
                timeframe='1Sec',
                payload={'price': '123.45', 'spread_bps': '8.2'},
            ),
            SignalEnvelope(
                event_ts=datetime(2026, 4, 9, 13, 31, tzinfo=UTC),
                symbol='AMAT',
                seq=2,
                source='ta',
                timeframe='1Sec',
                payload={'price': '180.10', 'spread_bps': '6.4'},
            ),
        ]

        with TemporaryDirectory() as tmpdir:
            bundle_path = Path(tmpdir) / 'signals.jsonl'
            stats = write_mlx_signal_bundle(bundle_path, rows)
            payload = bundle_path.read_text(encoding='utf-8').splitlines()

        self.assertEqual(stats.row_count, 2)
        self.assertEqual(stats.symbol_count, 2)
        self.assertEqual(stats.first_event_ts, '2026-04-09 13:30:00+00:00')
        self.assertEqual(stats.last_event_ts, '2026-04-09 13:31:00+00:00')
        self.assertEqual(len(payload), 2)
        self.assertIn('"symbol": "NVDA"', payload[0])

    def test_rank_candidate_descriptors_orders_candidates_from_history_signal(self) -> None:
        family_plan = Namespace(family_template=_template())
        strong = descriptor_from_sweep_config(
            candidate_id='strong',
            family_plan=family_plan,  # type: ignore[arg-type]
            sweep_config={'parameters': {'leader_reclaim_start_minutes_since_open': ['45']}, 'strategy_overrides': {}},
        )
        weak = descriptor_from_sweep_config(
            candidate_id='weak',
            family_plan=family_plan,  # type: ignore[arg-type]
            sweep_config={'parameters': {'leader_reclaim_start_minutes_since_open': ['0']}, 'strategy_overrides': {}},
        )
        history_rows = [
            {
                'entry_window_start_minute': 45,
                'entry_window_end_minute': 75,
                'max_hold_minutes': 30,
                'rank_count': 1,
                'requires_prev_day_features': True,
                'requires_cross_sectional_features': True,
                'requires_quote_quality_gate': True,
                'net_pnl_per_day': '600',
                'active_day_ratio': '1.0',
                'best_day_share': '0.2',
                'hard_vetoes': [],
            },
            {
                'entry_window_start_minute': 0,
                'entry_window_end_minute': 30,
                'max_hold_minutes': 30,
                'rank_count': 1,
                'requires_prev_day_features': False,
                'requires_cross_sectional_features': False,
                'requires_quote_quality_gate': False,
                'net_pnl_per_day': '-50',
                'active_day_ratio': '0.2',
                'best_day_share': '0.8',
                'hard_vetoes': ['bad'],
            },
        ]

        ranked = rank_candidate_descriptors(
            descriptors=[weak, strong],
            history_rows=history_rows,
            policy=_program().proposal_model_policy,
        )

        self.assertEqual(ranked[0].candidate_id, 'strong')
        self.assertEqual(ranked[0].rank, 1)
        self.assertIn(ranked[0].backend, {'mlx', 'numpy-fallback'})

    def test_rank_candidate_descriptors_respects_numpy_backend_preference(self) -> None:
        family_plan = Namespace(family_template=_template())
        descriptor = descriptor_from_sweep_config(
            candidate_id='strong',
            family_plan=family_plan,  # type: ignore[arg-type]
            sweep_config={'parameters': {'leader_reclaim_start_minutes_since_open': ['45']}, 'strategy_overrides': {}},
        )
        import numpy as np

        with patch(
            'app.trading.discovery.mlx_proposal_models._import_mlx_backend',
            side_effect=AssertionError('mlx backend should not be used'),
        ), patch(
            'app.trading.discovery.mlx_proposal_models._import_numpy_backend',
            return_value=('numpy-fallback', np),
        ):
            ranked = rank_candidate_descriptors(
                descriptors=[descriptor],
                history_rows=[],
                policy=ProposalModelPolicy(
                    enabled=True,
                    mode='ranking_only',
                    backend_preference='numpy-fallback',
                    top_k=4,
                    exploration_slots=1,
                    minimum_history_rows=1,
                ),
            )

        self.assertEqual(ranked[0].backend, 'numpy-fallback')

    def test_select_proposal_batch_reserves_exploration_slot_for_diversity(self) -> None:
        long_descriptor = MlxCandidateDescriptor(
            descriptor_id='desc-long',
            candidate_id='long-1',
            family_template_id='breakout_reclaim_v2',
            runtime_family='breakout_continuation_consistent',
            strategy_name='breakout-continuation-long-v1',
            side_policy='long',
            entry_window_start_minute=45,
            entry_window_end_minute=75,
            max_hold_minutes=30,
            entry_type='breakout_reclaim',
            exit_type='time_exit',
            rank_policy='rank',
            rank_count=1,
            gross_budget_usd='30000',
            per_leg_budget_usd='15000',
            normalization_regime='runtime_default',
            regime_gate_id='regime-bull',
            requires_prev_day_features=True,
            requires_cross_sectional_features=True,
            requires_quote_quality_gate=True,
            expected_fill_mode='market',
            approval_path='scheduler_v3',
        )
        similar_long_descriptor = MlxCandidateDescriptor(
            descriptor_id='desc-long-2',
            candidate_id='long-2',
            family_template_id='breakout_reclaim_v2',
            runtime_family='breakout_continuation_consistent',
            strategy_name='breakout-continuation-long-v1',
            side_policy='long',
            entry_window_start_minute=46,
            entry_window_end_minute=76,
            max_hold_minutes=30,
            entry_type='breakout_reclaim',
            exit_type='time_exit',
            rank_policy='rank',
            rank_count=1,
            gross_budget_usd='30000',
            per_leg_budget_usd='15000',
            normalization_regime='runtime_default',
            regime_gate_id='regime-bull',
            requires_prev_day_features=True,
            requires_cross_sectional_features=True,
            requires_quote_quality_gate=True,
            expected_fill_mode='market',
            approval_path='scheduler_v3',
        )
        short_descriptor = MlxCandidateDescriptor(
            descriptor_id='desc-short',
            candidate_id='short-1',
            family_template_id='exhaustion_short_v1',
            runtime_family='mean_reversion_exhaustion_short',
            strategy_name='mean-reversion-exhaustion-short-v1',
            side_policy='short',
            entry_window_start_minute=45,
            entry_window_end_minute=75,
            max_hold_minutes=30,
            entry_type='fade_exhaustion',
            exit_type='time_exit',
            rank_policy='rank',
            rank_count=1,
            gross_budget_usd='30000',
            per_leg_budget_usd='15000',
            normalization_regime='runtime_default',
            regime_gate_id='regime-bear',
            requires_prev_day_features=True,
            requires_cross_sectional_features=False,
            requires_quote_quality_gate=True,
            expected_fill_mode='market',
            approval_path='scheduler_v3',
        )
        proposal_scores = [
            ProposalScore('long-1', 'desc-long', 10.0, 1, 'numpy-fallback', 'ranking_only'),
            ProposalScore('long-2', 'desc-long-2', 9.0, 2, 'numpy-fallback', 'ranking_only'),
            ProposalScore('short-1', 'desc-short', 1.0, 3, 'numpy-fallback', 'ranking_only'),
        ]

        selected = select_proposal_batch(
            descriptors=[long_descriptor, similar_long_descriptor, short_descriptor],
            proposal_scores=proposal_scores,
            limit=2,
            top_k=1,
            exploration_slots=1,
        )

        self.assertEqual([item.candidate_id for item in selected], ['long-1', 'short-1'])
        self.assertEqual(selected[0].selection_reason, 'exploitation')
        self.assertEqual(selected[1].selection_reason, 'exploration')

    def test_build_proposal_diagnostics_reports_lift_and_failure_tables(self) -> None:
        descriptors = [
            MlxCandidateDescriptor(
                descriptor_id='desc-a',
                candidate_id='cand-a',
                family_template_id='breakout_reclaim_v2',
                runtime_family='breakout_continuation_consistent',
                strategy_name='breakout-continuation-long-v1',
                side_policy='long',
                entry_window_start_minute=45,
                entry_window_end_minute=75,
                max_hold_minutes=30,
                entry_type='breakout_reclaim',
                exit_type='time_exit',
                rank_policy='rank',
                rank_count=1,
                gross_budget_usd='30000',
                per_leg_budget_usd='15000',
                normalization_regime='runtime_default',
                regime_gate_id='regime-bull',
                requires_prev_day_features=True,
                requires_cross_sectional_features=True,
                requires_quote_quality_gate=True,
                expected_fill_mode='market',
                approval_path='scheduler_v3',
            ),
            MlxCandidateDescriptor(
                descriptor_id='desc-b',
                candidate_id='cand-b',
                family_template_id='exhaustion_short_v1',
                runtime_family='mean_reversion_exhaustion_short',
                strategy_name='mean-reversion-exhaustion-short-v1',
                side_policy='short',
                entry_window_start_minute=45,
                entry_window_end_minute=75,
                max_hold_minutes=30,
                entry_type='fade_exhaustion',
                exit_type='time_exit',
                rank_policy='rank',
                rank_count=1,
                gross_budget_usd='30000',
                per_leg_budget_usd='15000',
                normalization_regime='runtime_default',
                regime_gate_id='regime-bear',
                requires_prev_day_features=True,
                requires_cross_sectional_features=False,
                requires_quote_quality_gate=True,
                expected_fill_mode='market',
                approval_path='scheduler_v3',
            ),
        ]
        scores = [
            ProposalScore('cand-a', 'desc-a', 8.0, 1, 'numpy-fallback', 'ranking_only'),
            ProposalScore('cand-b', 'desc-b', 2.0, 2, 'numpy-fallback', 'ranking_only'),
        ]
        selected = select_proposal_batch(
            descriptors=descriptors,
            proposal_scores=scores,
            limit=2,
            top_k=1,
            exploration_slots=1,
        )

        diagnostics = build_proposal_diagnostics(
            descriptors=descriptors,
            proposal_scores=scores,
            history_rows=[
                {
                    'candidate_id': 'cand-a',
                    'net_pnl_per_day': '-25',
                    'active_day_ratio': '0.60',
                    'objective_met': False,
                    'promotion_status': 'blocked_pending_runtime_parity',
                    'status': 'discard',
                },
                {
                    'candidate_id': 'cand-b',
                    'net_pnl_per_day': '410',
                    'active_day_ratio': '0.95',
                    'objective_met': True,
                    'promotion_status': 'blocked_pending_runtime_parity',
                    'status': 'keep',
                },
            ],
            selected_candidates=selected,
        )

        self.assertEqual(diagnostics.parity_matrix['replayed_count'], 2)
        self.assertEqual(diagnostics.selected_candidates[0].candidate_id, 'cand-a')
        self.assertEqual(diagnostics.selected_candidates[1].selection_reason, 'exploration')
        self.assertTrue(diagnostics.rank_bucket_lift)
        self.assertEqual(diagnostics.worst_false_positives[0]['candidate_id'], 'cand-a')
        self.assertEqual(diagnostics.best_false_negatives[0]['candidate_id'], 'cand-b')
