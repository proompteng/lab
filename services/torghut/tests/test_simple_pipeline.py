from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.config import settings
from app.models import Strategy
from app.trading.models import StrategyDecision
from app.trading.scheduler.simple_pipeline import (
    SimpleTradingPipeline,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_metadata_from_decision,
)
from app.trading.runtime_window_import import (
    _runtime_promotion_blocking_reasons,
    resolve_hypothesis_manifest,
)
from scripts.import_hypothesis_runtime_windows import (
    POST_COST_BASIS_RUNTIME_LEDGER,
    _build_realized_strategy_pnl_rows,
    _runtime_ledger_bucket_profit_proof_present,
)


def test_live_paper_runtime_ledger_close_loop_still_respects_profitability_gates() -> None:
    rows = _build_realized_strategy_pnl_rows(
        [
            {
                'execution_id': 'execution-buy',
                'computed_at': datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                'execution_event_at': datetime(
                    2026, 3, 6, 14, 31, tzinfo=timezone.utc
                ),
                'symbol': 'AAPL',
                'side': 'buy',
                'filled_qty': Decimal('1'),
                'avg_fill_price': Decimal('100'),
                'cost_amount': Decimal('0.20'),
                'cost_basis': 'broker_reported_commission_and_fees',
                'decision_hash': 'decision-buy',
                'alpaca_order_id': 'order-buy',
                'execution_policy_hash': 'policy-sha',
                'cost_model_hash': 'cost-sha',
                'lineage_hash': 'lineage-sha',
            },
            {
                'execution_id': 'execution-sell',
                'computed_at': datetime(2026, 3, 6, 14, 31, tzinfo=timezone.utc),
                'execution_event_at': datetime(
                    2026, 3, 6, 14, 32, tzinfo=timezone.utc
                ),
                'symbol': 'AAPL',
                'side': 'sell',
                'filled_qty': Decimal('1'),
                'avg_fill_price': Decimal('101'),
                'cost_amount': Decimal('0.10'),
                'cost_basis': 'broker_reported_commission_and_fees',
                'decision_hash': 'decision-sell',
                'alpaca_order_id': 'order-sell',
                'execution_policy_hash': 'policy-sha',
                'cost_model_hash': 'cost-sha',
                'lineage_hash': 'lineage-sha',
            },
        ],
        decision_lifecycle_rows=[
            {
                'computed_at': datetime(2026, 3, 6, 14, 29, tzinfo=timezone.utc),
                'event_type': 'decision',
                'symbol': 'AAPL',
                'account_label': 'TORGHUT_SIM',
                'strategy_id': 'microbar-cross-sectional-pairs-v1',
                'decision_hash': 'decision-buy',
                'source_decision_mode': 'strategy_signal_paper',
                'profit_proof_eligible': True,
                'lineage_hash': 'lineage-sha',
            },
            {
                'computed_at': datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                'event_type': 'decision',
                'symbol': 'AAPL',
                'account_label': 'TORGHUT_SIM',
                'strategy_id': 'microbar-cross-sectional-pairs-v1',
                'decision_hash': 'decision-sell',
                'source_decision_mode': 'strategy_signal_paper',
                'profit_proof_eligible': True,
                'lineage_hash': 'lineage-sha',
            },
        ],
        order_lifecycle_rows=[
            {
                'execution_order_event_id': 'event-new-buy',
                'trade_decision_id': 'decision-buy',
                'event_ts': datetime(2026, 3, 6, 14, 30, 1, tzinfo=timezone.utc),
                'event_type': 'new',
                'symbol': 'AAPL',
                'decision_hash': 'decision-buy',
                'alpaca_order_id': 'order-buy',
                'execution_policy_hash': 'policy-sha',
                'lineage_hash': 'lineage-sha',
                'source_topic': 'alpaca.trade_updates',
                'source_partition': 0,
                'source_offset': 210,
                'source_window_id': 'source-window-new-buy',
            },
            {
                'execution_order_event_id': 'event-fill-buy',
                'trade_decision_id': 'decision-buy',
                'execution_id': 'execution-buy',
                'event_ts': datetime(2026, 3, 6, 14, 31, 1, tzinfo=timezone.utc),
                'event_type': 'filled',
                'symbol': 'AAPL',
                'decision_hash': 'decision-buy',
                'alpaca_order_id': 'order-buy',
                'execution_policy_hash': 'policy-sha',
                'lineage_hash': 'lineage-sha',
                'source_topic': 'alpaca.trade_updates',
                'source_partition': 0,
                'source_offset': 211,
                'source_window_id': 'source-window-fill-buy',
            },
            {
                'execution_order_event_id': 'event-new-sell',
                'trade_decision_id': 'decision-sell',
                'event_ts': datetime(2026, 3, 6, 14, 31, 1, tzinfo=timezone.utc),
                'event_type': 'new',
                'symbol': 'AAPL',
                'decision_hash': 'decision-sell',
                'alpaca_order_id': 'order-sell',
                'execution_policy_hash': 'policy-sha',
                'lineage_hash': 'lineage-sha',
                'source_topic': 'alpaca.trade_updates',
                'source_partition': 0,
                'source_offset': 212,
                'source_window_id': 'source-window-new-sell',
            },
            {
                'execution_order_event_id': 'event-fill-sell',
                'trade_decision_id': 'decision-sell',
                'execution_id': 'execution-sell',
                'event_ts': datetime(2026, 3, 6, 14, 32, 1, tzinfo=timezone.utc),
                'event_type': 'filled',
                'symbol': 'AAPL',
                'decision_hash': 'decision-sell',
                'alpaca_order_id': 'order-sell',
                'execution_policy_hash': 'policy-sha',
                'lineage_hash': 'lineage-sha',
                'source_topic': 'alpaca.trade_updates',
                'source_partition': 0,
                'source_offset': 213,
                'source_window_id': 'source-window-fill-sell',
            },
        ],
        allow_authoritative_runtime_ledger_materialization=True,
    )

    assert len(rows) == 1
    assert rows[0]['post_cost_expectancy_basis'] == POST_COST_BASIS_RUNTIME_LEDGER
    assert rows[0]['authoritative'] is True
    bucket = rows[0]['runtime_ledger_bucket']
    assert isinstance(bucket, dict)
    assert bucket['blockers'] == []
    assert bucket['closed_trade_count'] == 1
    assert bucket['open_position_count'] == 0
    assert bucket['cost_amount'] == '0.30'
    assert bucket['source_window_ids'] == [
        'source-window-new-buy',
        'source-window-fill-buy',
        'source-window-new-sell',
        'source-window-fill-sell',
    ]
    assert bucket['execution_order_event_ids'] == [
        'event-new-buy',
        'event-fill-buy',
        'event-new-sell',
        'event-fill-sell',
    ]
    assert _runtime_ledger_bucket_profit_proof_present(bucket)

    _, manifest = resolve_hypothesis_manifest(
        hypothesis_id='H-MICRO-01',
        strategy_family='microstructure_breakout',
    )
    final_gate_blockers = _runtime_promotion_blocking_reasons(
        observed_stage='live',
        inserted=1,
        total_session_samples=manifest.min_sample_count_for_live_canary,
        total_decision_count=2,
        total_trade_count=2,
        total_order_count=2,
        total_post_cost_promotion_sample_count=1,
        runtime_ledger_notional_weighted_sample_count=1,
        total_post_cost_basis_counts={POST_COST_BASIS_RUNTIME_LEDGER: 1},
        average_slippage=Decimal('0'),
        average_post_cost=Decimal('34.82587064676616915422885572'),
        runtime_ledger_daily_summary={
            'runtime_ledger_observed_trading_day_count': '1',
            'runtime_ledger_mean_daily_net_pnl_after_costs': '0.70',
            'runtime_ledger_median_daily_net_pnl_after_costs': '0.70',
            'runtime_ledger_p10_daily_net_pnl_after_costs': '0.70',
            'runtime_ledger_worst_day_net_pnl_after_costs': '0.70',
            'runtime_ledger_max_intraday_drawdown': '0',
            'runtime_ledger_avg_daily_filled_notional': '201',
        },
        latest_three_budget_ok=True,
        all_continuity_ok=True,
        all_drift_ok=True,
        dependency_quorum_allowed=True,
        manifest=manifest,
        budget=Decimal('100'),
    )

    assert 'runtime_ledger_mean_daily_net_pnl_after_costs_below_target' in final_gate_blockers


def test_paper_route_target_metadata_is_collection_only_without_live_capital_mutation() -> None:
    trading_mode_before = settings.trading_mode
    target = {
        'hypothesis_id': 'H-PAIRS-01',
        'candidate_id': 'c88421d619759b2cfaa6f4d0',
        'account_label': 'TORGHUT_SIM',
        'observed_stage': 'paper',
        'runtime_strategy_name': 'microbar-cross-sectional-pairs-v1',
        'source_kind': 'paper_route_probe_runtime_observed',
        'paper_probation_authorized': True,
        'evidence_collection_ok': True,
        'canary_collection_authorized': True,
        'bounded_evidence_collection_authorized': True,
        'bounded_live_paper_collection_authorized': True,
        'bounded_evidence_collection_scope': 'paper_route_probe_next_session_only',
        'paper_route_probe_symbols': ['AAPL', 'AMZN'],
        'source_manifest_ref': 'config/trading/hypotheses/h-pairs-01.json',
        'source_decision_readiness': {'ready': True, 'blockers': []},
    }

    metadata = SimpleTradingPipeline._paper_route_target_source_decision_metadata(
        target=target,
        strategy=Strategy(
            name='microbar-cross-sectional-pairs-v1',
            description='metadata fixture',
            enabled=True,
            base_timeframe='1Sec',
            universe_type='static',
            universe_symbols=['AAPL', 'AMZN'],
        ),
        symbol='AAPL',
        window_start=datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc),
        window_end=datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc),
        max_notional=Decimal('25'),
    )

    assert settings.trading_mode == trading_mode_before
    assert metadata['bounded_evidence_collection_authorized'] is True
    assert metadata['bounded_live_paper_collection_authorized'] is True
    assert metadata['canary_collection_authorized'] is True
    assert metadata['promotion_allowed'] is False
    assert metadata['final_authority_ok'] is False
    assert metadata['final_promotion_allowed'] is False
    assert metadata['account_stage_runtime_identity'] == {
        'account_label': 'TORGHUT_SIM',
        'source_account_label': None,
        'observed_stage': 'paper',
        'runtime_strategy_name': 'microbar-cross-sectional-pairs-v1',
        'source_kind': 'paper_route_probe_runtime_observed',
    }


def _bounded_hpairs_target(**overrides: object) -> dict[str, object]:
    target: dict[str, object] = {
        'hypothesis_id': 'H-PAIRS-01',
        'candidate_id': 'c88421d619759b2cfaa6f4d0',
        'account_label': 'TORGHUT_SIM',
        'source_account_label': 'TORGHUT_SIM',
        'observed_stage': 'paper',
        'strategy_family': 'microbar_cross_sectional_pairs',
        'strategy_name': 'microbar-cross-sectional-pairs-v1',
        'runtime_strategy_name': 'microbar-cross-sectional-pairs-v1',
        'source_kind': 'paper_route_probe_runtime_observed',
        'source_manifest_ref': 'config/trading/hypotheses/h-pairs-01.json',
        'paper_route_probe_symbols': ['AAPL', 'AMZN'],
        'paper_route_probe_pair_balance_state': 'balanced',
        'evidence_collection_ok': True,
        'canary_collection_authorized': True,
        'bounded_evidence_collection_authorized': True,
        'bounded_live_paper_collection_authorized': True,
        'bounded_evidence_collection_scope': 'paper_route_probe_next_session_only',
        'bounded_evidence_collection_blockers': [],
        'runtime_window_import_health_gate_blockers': [],
        'paper_route_account_pre_session_blockers': [],
        'paper_route_hpairs_symbol_blockers': [],
        'source_decision_readiness': {'ready': True, 'blockers': []},
        'promotion_allowed': False,
        'final_promotion_authorized': False,
        'final_promotion_allowed': False,
        'capital_promotion_allowed': False,
    }
    target.update(overrides)
    return target


def test_bounded_sim_collection_authorizes_non_final_hpairs_target_only() -> None:
    target = _bounded_hpairs_target()

    assert _bounded_sim_collection_blockers(target, account_label='TORGHUT_SIM') == []

    assert 'bounded_sim_collection_runtime_account_not_torghut_sim' in (
        _bounded_sim_collection_blockers(target, account_label='TORGHUT_LIVE')
    )
    assert 'bounded_sim_collection_non_final_state_required' in (
        _bounded_sim_collection_blockers(
            _bounded_hpairs_target(final_promotion_allowed=True),
            account_label='TORGHUT_SIM',
        )
    )


def test_bounded_sim_collection_blocks_missing_source_lineage_prerequisites() -> None:
    blockers = _bounded_sim_collection_blockers(
        _bounded_hpairs_target(
            candidate_id='',
            hypothesis_id='',
            source_manifest_ref='',
            evidence_collection_ok=False,
            source_decision_readiness={'ready': False, 'blockers': ['source_strategy_missing']},
        ),
        account_label='TORGHUT_SIM',
    )

    assert 'bounded_sim_collection_candidate_id_missing' in blockers
    assert 'bounded_sim_collection_hypothesis_id_missing' in blockers
    assert 'bounded_sim_collection_source_manifest_missing' in blockers
    assert 'bounded_sim_collection_evidence_collection_not_ready' in blockers
    assert 'bounded_sim_collection_source_decision_not_ready' in blockers
    assert 'source_strategy_missing' in blockers


def test_simple_submit_disabled_bypass_requires_explicit_bounded_sim_collection() -> None:
    ordinary_probe = StrategyDecision(
        strategy_id='00000000-0000-0000-0000-000000000001',
        symbol='AAPL',
        event_ts=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
        timeframe='1Min',
        action='buy',
        qty=Decimal('1'),
        params={
            'paper_route_probe': {
                'source_decision_mode': 'route_acquisition',
                'profit_proof_eligible': False,
            }
        },
    )
    bounded_probe = ordinary_probe.model_copy(
        update={'params': {'paper_route_probe': _bounded_hpairs_target()}}
    )

    assert (
        _bounded_sim_collection_metadata_from_decision(
            ordinary_probe,
            account_label='TORGHUT_SIM',
            trading_mode='paper',
        )
        is None
    )
    assert (
        _bounded_sim_collection_metadata_from_decision(
            bounded_probe,
            account_label='TORGHUT_SIM',
            trading_mode='paper',
        )
        is not None
    )
    assert (
        _bounded_sim_collection_metadata_from_decision(
            bounded_probe,
            account_label='TORGHUT_LIVE',
            trading_mode='paper',
        )
        is None
    )
    assert (
        _bounded_sim_collection_metadata_from_decision(
            bounded_probe,
            account_label='TORGHUT_SIM',
            trading_mode='live',
        )
        is None
    )
