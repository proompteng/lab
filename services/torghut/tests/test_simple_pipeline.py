from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace

from app.config import settings
from app.models import Strategy
from app.trading.models import StrategyDecision
from app.trading.prices import MarketSnapshot
from app.trading.paper_route_target_plan import _blocked_target_readiness
from app.trading.scheduler.simple_pipeline import (
    SimpleTradingPipeline,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_metadata_from_decision,
    _quote_snapshot_matches_symbol,
    _target_metadata_quote_snapshot,
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


def test_live_paper_runtime_ledger_close_loop_still_respects_profitability_gates() -> (
    None
):
    rows = _build_realized_strategy_pnl_rows(
        [
            {
                "execution_id": "execution-buy",
                "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                "execution_event_at": datetime(2026, 3, 6, 14, 31, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "side": "buy",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("100"),
                "cost_amount": Decimal("0.20"),
                "cost_basis": "broker_reported_commission_and_fees",
                "decision_hash": "decision-buy",
                "alpaca_order_id": "order-buy",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
            },
            {
                "execution_id": "execution-sell",
                "computed_at": datetime(2026, 3, 6, 14, 31, tzinfo=timezone.utc),
                "execution_event_at": datetime(2026, 3, 6, 14, 32, tzinfo=timezone.utc),
                "symbol": "AAPL",
                "side": "sell",
                "filled_qty": Decimal("1"),
                "avg_fill_price": Decimal("101"),
                "cost_amount": Decimal("0.10"),
                "cost_basis": "broker_reported_commission_and_fees",
                "decision_hash": "decision-sell",
                "alpaca_order_id": "order-sell",
                "execution_policy_hash": "policy-sha",
                "cost_model_hash": "cost-sha",
                "lineage_hash": "lineage-sha",
            },
        ],
        decision_lifecycle_rows=[
            {
                "computed_at": datetime(2026, 3, 6, 14, 29, tzinfo=timezone.utc),
                "event_type": "decision",
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-buy",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
                "lineage_hash": "lineage-sha",
            },
            {
                "computed_at": datetime(2026, 3, 6, 14, 30, tzinfo=timezone.utc),
                "event_type": "decision",
                "symbol": "AAPL",
                "account_label": "TORGHUT_SIM",
                "strategy_id": "microbar-cross-sectional-pairs-v1",
                "decision_hash": "decision-sell",
                "source_decision_mode": "strategy_signal_paper",
                "profit_proof_eligible": True,
                "lineage_hash": "lineage-sha",
            },
        ],
        order_lifecycle_rows=[
            {
                "execution_order_event_id": "event-new-buy",
                "trade_decision_id": "decision-buy",
                "event_ts": datetime(2026, 3, 6, 14, 30, 1, tzinfo=timezone.utc),
                "event_type": "new",
                "symbol": "AAPL",
                "decision_hash": "decision-buy",
                "alpaca_order_id": "order-buy",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 210,
                "source_window_id": "source-window-new-buy",
            },
            {
                "execution_order_event_id": "event-fill-buy",
                "trade_decision_id": "decision-buy",
                "execution_id": "execution-buy",
                "event_ts": datetime(2026, 3, 6, 14, 31, 1, tzinfo=timezone.utc),
                "event_type": "filled",
                "symbol": "AAPL",
                "decision_hash": "decision-buy",
                "alpaca_order_id": "order-buy",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 211,
                "source_window_id": "source-window-fill-buy",
            },
            {
                "execution_order_event_id": "event-new-sell",
                "trade_decision_id": "decision-sell",
                "event_ts": datetime(2026, 3, 6, 14, 31, 1, tzinfo=timezone.utc),
                "event_type": "new",
                "symbol": "AAPL",
                "decision_hash": "decision-sell",
                "alpaca_order_id": "order-sell",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 212,
                "source_window_id": "source-window-new-sell",
            },
            {
                "execution_order_event_id": "event-fill-sell",
                "trade_decision_id": "decision-sell",
                "execution_id": "execution-sell",
                "event_ts": datetime(2026, 3, 6, 14, 32, 1, tzinfo=timezone.utc),
                "event_type": "filled",
                "symbol": "AAPL",
                "decision_hash": "decision-sell",
                "alpaca_order_id": "order-sell",
                "execution_policy_hash": "policy-sha",
                "lineage_hash": "lineage-sha",
                "source_topic": "alpaca.trade_updates",
                "source_partition": 0,
                "source_offset": 213,
                "source_window_id": "source-window-fill-sell",
            },
        ],
        allow_authoritative_runtime_ledger_materialization=True,
    )

    assert len(rows) == 1
    assert rows[0]["post_cost_expectancy_basis"] == POST_COST_BASIS_RUNTIME_LEDGER
    assert rows[0]["authoritative"] is True
    bucket = rows[0]["runtime_ledger_bucket"]
    assert isinstance(bucket, dict)
    assert bucket["blockers"] == []
    assert bucket["closed_trade_count"] == 1
    assert bucket["open_position_count"] == 0
    assert bucket["cost_amount"] == "0.30"
    assert bucket["source_window_ids"] == [
        "source-window-new-buy",
        "source-window-fill-buy",
        "source-window-new-sell",
        "source-window-fill-sell",
    ]
    assert bucket["execution_order_event_ids"] == [
        "event-new-buy",
        "event-fill-buy",
        "event-new-sell",
        "event-fill-sell",
    ]
    assert _runtime_ledger_bucket_profit_proof_present(bucket)

    _, manifest = resolve_hypothesis_manifest(
        hypothesis_id="H-MICRO-01",
        strategy_family="microstructure_breakout",
    )
    final_gate_blockers = _runtime_promotion_blocking_reasons(
        observed_stage="live",
        inserted=1,
        total_session_samples=manifest.min_sample_count_for_live_canary,
        total_decision_count=2,
        total_trade_count=2,
        total_order_count=2,
        total_post_cost_promotion_sample_count=1,
        runtime_ledger_notional_weighted_sample_count=1,
        total_post_cost_basis_counts={POST_COST_BASIS_RUNTIME_LEDGER: 1},
        average_slippage=Decimal("0"),
        average_post_cost=Decimal("34.82587064676616915422885572"),
        runtime_ledger_daily_summary={
            "runtime_ledger_observed_trading_day_count": "1",
            "runtime_ledger_mean_daily_net_pnl_after_costs": "0.70",
            "runtime_ledger_median_daily_net_pnl_after_costs": "0.70",
            "runtime_ledger_p10_daily_net_pnl_after_costs": "0.70",
            "runtime_ledger_worst_day_net_pnl_after_costs": "0.70",
            "runtime_ledger_max_intraday_drawdown": "0",
            "runtime_ledger_avg_daily_filled_notional": "201",
        },
        latest_three_budget_ok=True,
        all_continuity_ok=True,
        all_drift_ok=True,
        dependency_quorum_allowed=True,
        manifest=manifest,
        budget=Decimal("100"),
    )

    assert (
        "runtime_ledger_mean_daily_net_pnl_after_costs_below_target"
        in final_gate_blockers
    )


def test_paper_route_target_metadata_is_collection_only_without_live_capital_mutation() -> (
    None
):
    trading_mode_before = settings.trading_mode
    target = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "c88421d619759b2cfaa6f4d0",
        "account_label": "TORGHUT_SIM",
        "observed_stage": "paper",
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
        "source_kind": "paper_route_probe_runtime_observed",
        "paper_probation_authorized": True,
        "evidence_collection_ok": True,
        "canary_collection_authorized": True,
        "bounded_evidence_collection_authorized": True,
        "bounded_live_paper_collection_authorized": True,
        "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
        "paper_route_probe_symbols": ["AAPL", "AMZN"],
        "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
        "source_decision_readiness": {"ready": True, "blockers": []},
    }

    metadata = SimpleTradingPipeline._paper_route_target_source_decision_metadata(
        target=target,
        strategy=Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="metadata fixture",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
        ),
        symbol="AAPL",
        window_start=datetime(2026, 6, 1, 13, 30, tzinfo=timezone.utc),
        window_end=datetime(2026, 6, 1, 20, 0, tzinfo=timezone.utc),
        max_notional=Decimal("25"),
    )

    assert settings.trading_mode == trading_mode_before
    assert metadata["bounded_evidence_collection_authorized"] is True
    assert metadata["bounded_live_paper_collection_authorized"] is True
    assert metadata["canary_collection_authorized"] is True
    assert metadata["promotion_allowed"] is False
    assert metadata["final_authority_ok"] is False
    assert metadata["final_promotion_allowed"] is False
    assert metadata["account_stage_runtime_identity"] == {
        "account_label": "TORGHUT_SIM",
        "source_account_label": None,
        "observed_stage": "paper",
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
        "source_kind": "paper_route_probe_runtime_observed",
    }


def _bounded_hpairs_target(**overrides: object) -> dict[str, object]:
    target: dict[str, object] = {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "c88421d619759b2cfaa6f4d0",
        "account_label": "TORGHUT_SIM",
        "source_account_label": "TORGHUT_SIM",
        "observed_stage": "paper",
        "strategy_family": "microbar_cross_sectional_pairs",
        "strategy_name": "microbar-cross-sectional-pairs-v1",
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
        "source_kind": "paper_route_probe_runtime_observed",
        "source_manifest_ref": "config/trading/hypotheses/h-pairs-01.json",
        "paper_route_probe_symbols": ["AAPL", "AMZN"],
        "paper_route_probe_pair_balance_state": "balanced",
        "evidence_collection_ok": True,
        "canary_collection_authorized": True,
        "bounded_evidence_collection_authorized": True,
        "bounded_live_paper_collection_authorized": True,
        "bounded_evidence_collection_scope": "paper_route_probe_next_session_only",
        "bounded_evidence_collection_blockers": [],
        "runtime_window_import_health_gate_blockers": [],
        "paper_route_target_account_audit_state": {
            "schema_version": "torghut.paper-route-target-account-audit.v1",
            "scope": "local_torghut_sim_paper_runtime_account_state",
            "state": "available",
            "account_label": "TORGHUT_SIM",
            "required_account_label": "TORGHUT_SIM",
            "symbols": ["AAPL", "AMZN"],
            "audit_available": True,
            "blockers": [],
        },
        "paper_route_target_account_audit_blockers": [],
        "paper_route_account_pre_session_blockers": [],
        "paper_route_account_contamination_blockers": [],
        "paper_route_hpairs_symbol_blockers": [],
        "source_decision_readiness": {"ready": True, "blockers": []},
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "capital_promotion_allowed": False,
    }
    target.update(overrides)
    return target


def test_bounded_sim_collection_authorizes_non_final_hpairs_target_only() -> None:
    target = _bounded_hpairs_target()

    assert _bounded_sim_collection_blockers(target, account_label="TORGHUT_SIM") == []
    assert target["promotion_allowed"] is False
    assert target["final_promotion_authorized"] is False
    assert target["final_promotion_allowed"] is False
    assert target["capital_promotion_allowed"] is False

    assert "bounded_sim_collection_runtime_account_not_target" in (
        _bounded_sim_collection_blockers(target, account_label="TORGHUT_LIVE")
    )
    assert "bounded_sim_collection_non_final_state_required" in (
        _bounded_sim_collection_blockers(
            _bounded_hpairs_target(final_promotion_allowed=True),
            account_label="TORGHUT_SIM",
        )
    )


def test_bounded_sim_collection_blocks_missing_source_lineage_prerequisites() -> None:
    blockers = _bounded_sim_collection_blockers(
        _bounded_hpairs_target(
            candidate_id="",
            hypothesis_id="",
            source_manifest_ref="",
            evidence_collection_ok=False,
            source_decision_readiness={
                "ready": False,
                "blockers": ["source_strategy_missing"],
            },
        ),
        account_label="TORGHUT_SIM",
    )

    assert "bounded_sim_collection_candidate_id_missing" in blockers
    assert "bounded_sim_collection_hypothesis_id_missing" in blockers
    assert "bounded_sim_collection_source_manifest_missing" in blockers
    assert "bounded_sim_collection_evidence_collection_not_ready" in blockers
    assert "bounded_sim_collection_source_decision_not_ready" in blockers
    assert "source_strategy_missing" in blockers


def _routeability_decision(
    *,
    symbol: str = "AAPL",
    params: dict[str, object] | None = None,
) -> StrategyDecision:
    return StrategyDecision(
        strategy_id="00000000-0000-0000-0000-000000000001",
        symbol=symbol,
        event_ts=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
        timeframe="1Sec",
        action="buy",
        qty=Decimal("1"),
        params=params
        or {
            "paper_route_target_plan_source_decision": _bounded_hpairs_target(),
            "source_decision_mode": "bounded_paper_route_collection",
            "promotion_allowed": False,
            "final_authority_ok": False,
        },
    )


def test_paper_route_quote_routeability_uses_target_metadata_quote_snapshot() -> None:
    pipeline = object.__new__(SimpleTradingPipeline)
    target = _bounded_hpairs_target(
        paper_route_probe_symbol_quotes={
            "AAPL": {
                "price": "190.01",
                "bid_px": "190.00",
                "ask_px": "190.02",
                "quote_as_of": "2026-06-01T14:29:59+00:00",
                "quote_source": "target_plan_h_pairs_quote",
            },
            "AMZN": {
                "price": "185.01",
                "bid_px": "185.00",
                "ask_px": "185.02",
                "quote_as_of": "2026-06-01T14:29:59+00:00",
                "quote_source": "target_plan_h_pairs_quote",
            },
        }
    )
    decision = _routeability_decision(
        params={
            "price": Decimal("999"),
            "paper_route_target_plan_source_decision": target,
            "source_decision_mode": "bounded_paper_route_collection",
            "promotion_allowed": False,
            "final_authority_ok": False,
        }
    )

    status, routeability = pipeline._paper_route_quote_routeability(
        decision,
        snapshot=None,
    )

    assert status.valid is True
    assert status.price == Decimal("190.01")
    assert status.bid == Decimal("190.00")
    assert status.ask == Decimal("190.02")
    assert status.source == "target_plan_h_pairs_quote"
    assert routeability["status"] == "accepted"
    assert routeability["operator_next_action"] == "allow_bounded_collection"
    assert routeability["bounded_evidence_collection_ready"] is True
    assert routeability["promotion_allowed"] is False
    assert routeability["final_authority_ok"] is False


def test_paper_route_quote_routeability_prefers_executable_snapshot_price() -> None:
    pipeline = object.__new__(SimpleTradingPipeline)
    decision = _routeability_decision(
        params={"paper_route_target_plan_source_decision": _bounded_hpairs_target()}
    )
    snapshot = MarketSnapshot(
        symbol="AAPL",
        as_of=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
        price=Decimal("190.01"),
        spread=Decimal("0.02"),
        source="alpaca_snapshot",
        bid=Decimal("190.00"),
        ask=Decimal("190.02"),
        quote_as_of=datetime(2026, 6, 1, 14, 29, 59, tzinfo=timezone.utc),
        quote_source="alpaca_latest_quote",
    )
    signal_priced_decision = decision.model_copy(
        update={"params": {**decision.params, "price": Decimal("999")}}
    )

    status, routeability = pipeline._paper_route_quote_routeability(
        signal_priced_decision,
        snapshot=snapshot,
    )

    assert status.valid is True
    assert status.price == Decimal("190.01")
    assert routeability["source"] == "alpaca_latest_quote"
    assert routeability["readiness"]["state"] == "ready"


def test_paper_route_quote_routeability_uses_target_quote_when_snapshot_price_only() -> (
    None
):
    pipeline = object.__new__(SimpleTradingPipeline)
    target = _bounded_hpairs_target(
        paper_route_probe_symbol_quotes={
            "AAPL": {
                "price": "190.01",
                "bid": "190.00",
                "ask": "190.02",
                "quote_as_of": "2026-06-01T14:29:59+00:00",
                "quote_source": "target_plan_h_pairs_quote",
            }
        }
    )
    decision = _routeability_decision(
        params={
            "price_snapshot": {
                "price": "190.01",
                "as_of": "2026-06-01T14:30:00+00:00",
                "source": "price_only_snapshot",
            },
            "paper_route_target_plan_source_decision": target,
            "source_decision_mode": "bounded_paper_route_collection",
            "promotion_allowed": False,
            "final_authority_ok": False,
        }
    )

    status, routeability = pipeline._paper_route_quote_routeability(
        decision,
        snapshot=None,
    )

    assert status.valid is True
    assert status.bid == Decimal("190.00")
    assert status.ask == Decimal("190.02")
    assert status.source == "target_plan_h_pairs_quote"
    assert routeability["quote_as_of"] == "2026-06-01T14:29:59+00:00"
    assert routeability["bounded_evidence_collection_ready"] is True
    assert routeability["promotion_allowed"] is False
    assert routeability["final_promotion_allowed"] is False


def test_paper_route_quote_helpers_read_target_snapshot_fallbacks() -> None:
    direct_snapshot = {
        "symbol": "AAPL",
        "bid": "190.00",
        "ask": "190.02",
        "feed": "direct_feed",
    }
    readiness_snapshot = {
        "symbol": "AMZN",
        "bid": "185.00",
        "ask": "185.02",
        "feed": "readiness_feed",
    }

    assert _quote_snapshot_matches_symbol(direct_snapshot, symbol="AAPL")
    assert not _quote_snapshot_matches_symbol(direct_snapshot, symbol="AMZN")
    assert (
        _target_metadata_quote_snapshot(
            {"paper_route_probe": {"executable_quote": direct_snapshot}},
            symbol="AAPL",
        )
        == direct_snapshot
    )
    assert (
        _target_metadata_quote_snapshot(
            {
                "strategy_signal_paper": {
                    "source_decision_readiness": {
                        "price_snapshot": readiness_snapshot,
                    }
                }
            },
            symbol="AMZN",
        )
        == readiness_snapshot
    )
    assert (
        _target_metadata_quote_snapshot(
            {
                "paper_route_target_plan": {
                    "paper_route_probe_symbol_quotes": {
                        "MSFT": {"bid": "300.00", "ask": "300.02"}
                    }
                }
            },
            symbol="AAPL",
        )
        is None
    )


def test_ensure_decision_price_backfills_target_quote_when_snapshot_missing() -> None:
    pipeline = object.__new__(SimpleTradingPipeline)
    pipeline.price_fetcher = SimpleNamespace(fetch_market_snapshot=lambda _signal: None)
    decision = _routeability_decision(
        params={
            "paper_route_target_plan_source_decision": _bounded_hpairs_target(
                paper_route_probe_symbol_quotes={
                    "AAPL": {
                        "bid": "190.00",
                        "ask": "190.02",
                        "timestamp": "2026-06-01T14:29:59+00:00",
                        "feed": "target_feed",
                    }
                }
            )
        }
    )

    updated, snapshot = pipeline._ensure_decision_price(decision, signal_price=None)

    assert snapshot is None
    assert updated.params["price"] == Decimal("190.01")
    assert updated.params["imbalance_bid_px"] == Decimal("190.00")
    assert updated.params["imbalance_ask_px"] == Decimal("190.02")
    assert updated.params["spread"] == Decimal("0.02")
    assert updated.params["price_snapshot"] == {
        "source": "target_feed",
        "quote_source": "target_feed",
        "as_of": "2026-06-01T14:29:59+00:00",
        "quote_as_of": "2026-06-01T14:29:59+00:00",
        "price": "190.01",
        "bid": "190.00",
        "ask": "190.02",
        "spread": "0.02",
    }


def test_ensure_decision_price_backfills_target_quote_when_snapshot_price_only() -> (
    None
):
    pipeline = object.__new__(SimpleTradingPipeline)
    pipeline.price_fetcher = SimpleNamespace(
        fetch_market_snapshot=lambda _signal: MarketSnapshot(
            symbol="AAPL",
            as_of=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
            price=Decimal("190.01"),
            spread=None,
            source="price_only_snapshot",
        )
    )
    decision = _routeability_decision(
        params={
            "paper_route_target_plan_source_decision": _bounded_hpairs_target(
                paper_route_probe_symbol_quotes={
                    "AAPL": {
                        "bid": "190.00",
                        "ask": "190.02",
                        "timestamp": "2026-06-01T14:29:59+00:00",
                        "feed": "target_feed",
                    }
                }
            )
        }
    )

    updated, snapshot = pipeline._ensure_decision_price(decision, signal_price=None)

    assert snapshot is None
    assert updated.params["price"] == Decimal("190.01")
    assert updated.params["imbalance_bid_px"] == Decimal("190.00")
    assert updated.params["imbalance_ask_px"] == Decimal("190.02")
    assert updated.params["spread"] == Decimal("0.02")
    assert updated.params["price_snapshot"]["source"] == "target_feed"


def test_target_plan_source_mismatch_readback_handles_no_metadata_and_symbol_field() -> (
    None
):
    assert (
        SimpleTradingPipeline._paper_route_target_plan_source_mismatch(
            _routeability_decision(params={})
        )
        is None
    )

    mismatch = SimpleTradingPipeline._paper_route_target_plan_source_mismatch(
        _routeability_decision(
            params={
                "paper_route_target_plan_source_decision": {
                    **_bounded_hpairs_target(),
                    "symbol": "AMZN",
                }
            }
        )
    )

    assert mismatch is not None
    assert mismatch["mismatches"] == ["target_plan_symbol_mismatch"]
    assert mismatch["symbol"] == "AAPL"
    assert mismatch["metadata_symbol"] == "AMZN"


def test_target_plan_source_mismatch_rejects_pair_leg_side_mismatch() -> None:
    mismatch = SimpleTradingPipeline._paper_route_target_plan_source_mismatch(
        _routeability_decision(
            params={
                "paper_route_target_plan_source_decision": _bounded_hpairs_target(
                    paper_route_probe_symbol_actions={"AAPL": "sell", "AMZN": "buy"}
                )
            }
        )
    )

    assert mismatch is not None
    assert mismatch["mismatches"] == ["target_plan_side_mismatch"]
    assert mismatch["symbol"] == "AAPL"
    assert mismatch["decision_action"] == "buy"
    assert mismatch["target_action"] == "sell"


def test_blocked_target_readiness_maps_collection_gate_to_wait_for_fresh_quote() -> (
    None
):
    readiness = _blocked_target_readiness(
        ["paper_route_bounded_collection_not_authorized"]
    )

    assert readiness["state"] == "blocked"
    assert readiness["next_operator_action"] == "wait_for_fresh_quote"
    assert readiness["promotion_allowed"] is False
    assert readiness["final_authority_ok"] is False


def test_paper_route_quote_routeability_blocks_fillability_absent_and_mismatch() -> (
    None
):
    pipeline = object.__new__(SimpleTradingPipeline)
    stale_before = settings.trading_executable_quote_lookback_seconds
    spread_before = settings.trading_signal_max_executable_spread_bps
    try:
        settings.trading_executable_quote_lookback_seconds = 30
        settings.trading_signal_max_executable_spread_bps = Decimal("50")
        cases = [
            (
                _routeability_decision(
                    params={
                        "paper_route_target_plan_source_decision": _bounded_hpairs_target()
                    }
                ),
                "absent_snapshot_fallback",
                "refresh_source_snapshot",
            ),
            (
                _routeability_decision(
                    params={
                        "paper_route_target_plan_source_decision": _bounded_hpairs_target(),
                        "price_snapshot": {
                            "price": "100",
                            "bid": "99",
                            "ask": "101",
                            "quote_as_of": "2026-06-01T14:29:59+00:00",
                            "quote_source": "wide_quote",
                        },
                    }
                ),
                "spread_bps_exceeded",
                "wait_for_fresh_quote",
            ),
            (
                _routeability_decision(
                    params={
                        "paper_route_target_plan_source_decision": _bounded_hpairs_target(),
                        "price_snapshot": {
                            "price": "190.01",
                            "bid": "190.00",
                            "ask": "190.02",
                            "quote_as_of": "2026-06-01T14:29:00+00:00",
                            "quote_source": "stale_quote",
                        },
                    }
                ),
                "stale_quote",
                "wait_for_fresh_quote",
            ),
            (
                _routeability_decision(
                    params={
                        "paper_route_target_plan_source_decision": _bounded_hpairs_target(),
                        "price_snapshot": {
                            "price": "190.01",
                            "bid": "190.02",
                            "ask": "190.00",
                            "quote_as_of": "2026-06-01T14:29:59+00:00",
                            "quote_source": "crossed_quote",
                        },
                    }
                ),
                "crossed_quote",
                "wait_for_fresh_quote",
            ),
            (
                _routeability_decision(
                    symbol="MSFT",
                    params={
                        "paper_route_target_plan_source_decision": _bounded_hpairs_target(
                            paper_route_probe_symbol_quotes={
                                "MSFT": {
                                    "price": "300.01",
                                    "bid": "300.00",
                                    "ask": "300.02",
                                    "quote_as_of": "2026-06-01T14:29:59+00:00",
                                    "quote_source": "target_quote",
                                }
                            }
                        )
                    },
                ),
                "target_plan_source_mismatch",
                "skip_symbol",
            ),
        ]

        for decision, reason, next_action in cases:
            status, routeability = pipeline._paper_route_quote_routeability(
                decision,
                snapshot=None,
            )

            assert status.valid is False
            assert status.reason == reason
            assert routeability["status"] == "blocked"
            assert routeability["reason"] == reason
            assert routeability["operator_next_action"] == next_action
            assert routeability["bounded_evidence_collection_ready"] is False
            assert routeability["readiness"]["blockers"] == [reason]
            assert routeability["readiness"]["promotion_allowed"] is False
            assert routeability["readiness"]["final_authority_ok"] is False
    finally:
        settings.trading_executable_quote_lookback_seconds = stale_before
        settings.trading_signal_max_executable_spread_bps = spread_before


def test_bounded_sim_collection_fails_closed_when_account_audit_missing() -> None:
    target = _bounded_hpairs_target()
    target.pop("paper_route_target_account_audit_state")
    target["paper_route_target_account_audit_blockers"] = []

    assert _bounded_sim_collection_blockers(target, account_label="TORGHUT_SIM") == [
        "paper_route_target_account_audit_unavailable"
    ]
    assert target["promotion_allowed"] is False
    assert target["final_promotion_authorized"] is False
    assert target["final_promotion_allowed"] is False
    assert target["capital_promotion_allowed"] is False


def test_bounded_sim_collection_fails_closed_when_account_audit_unavailable() -> None:
    target = _bounded_hpairs_target(
        evidence_collection_ok=False,
        canary_collection_authorized=False,
        bounded_evidence_collection_authorized=False,
        bounded_live_paper_collection_authorized=False,
        bounded_evidence_collection_blockers=[
            "paper_route_target_account_audit_unavailable",
        ],
        paper_route_target_account_audit_state={
            "schema_version": "torghut.paper-route-target-account-audit.v1",
            "scope": "local_torghut_sim_paper_runtime_account_state",
            "state": "unavailable",
            "account_label": "TORGHUT_SIM",
            "required_account_label": "TORGHUT_SIM",
            "symbols": ["AAPL", "AMZN"],
            "audit_available": False,
            "blockers": ["paper_route_target_account_audit_unavailable"],
        },
        paper_route_target_account_audit_blockers=[
            "paper_route_target_account_audit_unavailable",
        ],
    )

    blockers = _bounded_sim_collection_blockers(target, account_label="TORGHUT_SIM")

    assert "bounded_sim_collection_authorization_missing" in blockers
    assert "bounded_sim_collection_evidence_collection_not_ready" in blockers
    assert "paper_route_target_account_audit_unavailable" in blockers
    assert target["promotion_allowed"] is False
    assert target["final_promotion_authorized"] is False
    assert target["final_promotion_allowed"] is False
    assert target["capital_promotion_allowed"] is False


def test_bounded_source_collection_authorizes_after_runtime_account_audit_readback(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 1, 18, 0, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            paper_route_probe_window_start="2026-06-01T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-01T20:00:00+00:00",
            paper_route_probe_next_session_max_notional="25",
            paper_route_probe_symbol_actions={"AAPL": "buy", "AMZN": "sell"},
            evidence_collection_ok=False,
            canary_collection_authorized=False,
            bounded_evidence_collection_authorized=False,
            bounded_live_paper_collection_authorized=False,
            bounded_evidence_collection_blockers=[
                "paper_route_target_account_audit_unavailable",
            ],
            paper_route_target_account_audit_state={
                "schema_version": "torghut.paper-route-target-account-audit.v1",
                "scope": "local_torghut_sim_paper_runtime_account_state",
                "state": "unavailable",
                "account_label": "TORGHUT_SIM",
                "required_account_label": "TORGHUT_SIM",
                "symbols": ["AAPL", "AMZN"],
                "audit_available": False,
                "blockers": ["paper_route_target_account_audit_unavailable"],
            },
            paper_route_target_account_audit_blockers=[
                "paper_route_target_account_audit_unavailable",
            ],
        )
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="metadata fixture",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "TORGHUT_SIM"
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda: (
            {"AAPL", "AMZN"},
            None,
            [target],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        decisions = pipeline._paper_route_target_source_decisions(
            strategies=[strategy],
            allowed_symbols={"AAPL", "AMZN"},
            positions=[],
            session=None,
        )

        assert {decision.symbol for decision in decisions} == {"AAPL", "AMZN"}
        for decision in decisions:
            metadata = decision.params["paper_route_target_plan_source_decision"]
            assert metadata["bounded_evidence_collection_authorized"] is True
            assert metadata["bounded_live_paper_collection_authorized"] is True
            assert metadata["canary_collection_authorized"] is True
            assert metadata["evidence_collection_ok"] is True
            assert metadata["promotion_allowed"] is False
            assert metadata["final_promotion_authorized"] is False
            assert metadata["final_promotion_allowed"] is False
            assert decision.params["final_authority_ok"] is False
            audit_state = metadata["paper_route_target_account_audit_state"]
            assert audit_state["state"] == "available"
            assert audit_state["audit_available"] is True
            assert metadata["paper_route_target_account_audit_blockers"] == []
            assert (
                "paper_route_target_account_audit_unavailable"
                not in metadata["bounded_evidence_collection_blockers"]
            )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_allow_shorts = allow_shorts_before


def test_bounded_sim_collection_accepts_declared_paper_account_alias() -> None:
    target = _bounded_hpairs_target(source_account_label="PA3SX7FYNUTF")

    assert _bounded_sim_collection_blockers(target, account_label="PA3SX7FYNUTF") == []
    assert "bounded_sim_collection_runtime_account_not_target" in (
        _bounded_sim_collection_blockers(target, account_label="UNRELATED_ACCOUNT")
    )


def test_simple_submit_disabled_bypass_requires_explicit_bounded_sim_collection() -> (
    None
):
    ordinary_probe = StrategyDecision(
        strategy_id="00000000-0000-0000-0000-000000000001",
        symbol="AAPL",
        event_ts=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
        timeframe="1Min",
        action="buy",
        qty=Decimal("1"),
        params={
            "paper_route_probe": {
                "source_decision_mode": "route_acquisition",
                "profit_proof_eligible": False,
            }
        },
    )
    bounded_probe = ordinary_probe.model_copy(
        update={"params": {"paper_route_probe": _bounded_hpairs_target()}}
    )

    assert (
        _bounded_sim_collection_metadata_from_decision(
            ordinary_probe,
            account_label="TORGHUT_SIM",
            trading_mode="paper",
        )
        is None
    )
    assert (
        _bounded_sim_collection_metadata_from_decision(
            bounded_probe,
            account_label="TORGHUT_SIM",
            trading_mode="paper",
        )
        is not None
    )
    assert (
        _bounded_sim_collection_metadata_from_decision(
            bounded_probe,
            account_label="TORGHUT_LIVE",
            trading_mode="paper",
        )
        is None
    )
    assert (
        _bounded_sim_collection_metadata_from_decision(
            bounded_probe,
            account_label="TORGHUT_SIM",
            trading_mode="live",
        )
        is None
    )


def test_bounded_paper_route_authorized_without_live_simple_submit_enabled() -> None:
    trading_enabled_before = settings.trading_enabled
    trading_mode_before = settings.trading_mode
    simple_submit_before = settings.trading_simple_submit_enabled
    emergency_stop_before = settings.trading_emergency_stop_enabled
    try:
        settings.trading_enabled = True
        settings.trading_mode = "paper"
        settings.trading_simple_submit_enabled = False
        settings.trading_emergency_stop_enabled = False
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline.order_firewall = SimpleNamespace(
            status=lambda: SimpleNamespace(kill_switch_enabled=False)
        )
        pipeline.state = SimpleNamespace(
            emergency_stop_active=False,
            emergency_stop_reason=None,
        )
        pipeline._profitability_proof_floor = lambda session: {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["simple_submit_disabled"],
        }
        pipeline._active_bounded_paper_route_target_window = lambda decision: None

        decision = StrategyDecision(
            strategy_id="00000000-0000-0000-0000-000000000001",
            symbol="AAPL",
            event_ts=datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc),
            timeframe="1Min",
            action="buy",
            qty=Decimal("1"),
            params={
                "paper_route_target_plan_source_decision": _bounded_hpairs_target(
                    source_account_label="PA3SX7FYNUTF"
                )
            },
        )

        assert pipeline._is_trading_submission_allowed(
            session=SimpleNamespace(),
            decision=decision,
            decision_row=SimpleNamespace(status="planned"),
        )
    finally:
        settings.trading_enabled = trading_enabled_before
        settings.trading_mode = trading_mode_before
        settings.trading_simple_submit_enabled = simple_submit_before
        settings.trading_emergency_stop_enabled = emergency_stop_before


def test_contaminated_bounded_window_still_reserves_paper_account(monkeypatch) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        now = datetime(2026, 6, 1, 18, 0, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            paper_route_probe_window_start="2026-06-01T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-01T20:00:00+00:00",
            evidence_collection_ok=False,
            canary_collection_authorized=False,
            bounded_evidence_collection_authorized=False,
            bounded_live_paper_collection_authorized=False,
            bounded_evidence_collection_blockers=[
                "paper_route_account_contamination_detected",
                "unlinked_order_events_present",
            ],
            paper_route_account_contamination_blockers=[
                "paper_route_account_contamination_detected",
                "unlinked_order_events_present",
            ],
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "TORGHUT_SIM"
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda: (
            {"AAPL", "AMZN"},
            None,
            [target],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        blockers = _bounded_sim_collection_blockers(
            target,
            account_label="TORGHUT_SIM",
        )

        assert "bounded_sim_collection_evidence_collection_not_ready" in blockers
        assert "paper_route_account_contamination_detected" in blockers
        assert pipeline._paper_route_target_plan_reserves_account(
            allowed_symbols={"AAPL", "AMZN"},
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before


def test_target_account_audit_unavailable_still_reserves_paper_account(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        now = datetime(2026, 6, 1, 18, 0, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            paper_route_probe_window_start="2026-06-01T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-01T20:00:00+00:00",
            evidence_collection_ok=False,
            canary_collection_authorized=False,
            bounded_evidence_collection_authorized=False,
            bounded_live_paper_collection_authorized=False,
            bounded_evidence_collection_blockers=[
                "paper_route_target_account_audit_unavailable",
            ],
            paper_route_target_account_audit_blockers=[
                "paper_route_target_account_audit_unavailable",
            ],
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "TORGHUT_SIM"
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda: (
            {"AAPL", "AMZN"},
            None,
            [target],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        blockers = _bounded_sim_collection_blockers(
            target,
            account_label="TORGHUT_SIM",
        )

        assert "bounded_sim_collection_evidence_collection_not_ready" in blockers
        assert "paper_route_target_account_audit_unavailable" in blockers
        assert pipeline._paper_route_target_plan_reserves_account(
            allowed_symbols={"AAPL", "AMZN"},
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before


def test_target_account_audit_unavailable_still_scopes_signal_ingest(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        now = datetime(2026, 6, 1, 18, 0, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            paper_route_probe_window_start="2026-06-01T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-01T20:00:00+00:00",
            evidence_collection_ok=False,
            canary_collection_authorized=False,
            bounded_evidence_collection_authorized=False,
            bounded_live_paper_collection_authorized=False,
            bounded_evidence_collection_blockers=[
                "paper_route_target_account_audit_unavailable",
            ],
            paper_route_target_account_audit_blockers=[
                "paper_route_target_account_audit_unavailable",
            ],
        )
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="metadata fixture",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "TORGHUT_SIM"
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda: (
            {"AAPL", "AMZN", "MSFT"},
            None,
            [target],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        scope = pipeline._bounded_paper_route_signal_scope([strategy])

        assert scope == ({"AAPL", "AMZN"}, {"1Sec"})
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before


def test_bounded_paper_route_execution_metadata_keeps_live_capital_closed() -> None:
    target = _bounded_hpairs_target(source_account_label="PA3SX7FYNUTF")
    strategy = Strategy(
        name="microbar-cross-sectional-pairs-v1",
        description="metadata fixture",
        enabled=True,
        base_timeframe="1Sec",
        universe_type="static",
        universe_symbols=["AAPL", "AMZN"],
    )

    metadata = SimpleTradingPipeline._bounded_paper_route_execution_metadata(
        target=target,
        strategy=strategy,
        symbol="AAPL",
        action="buy",
        account_label="PA3SX7FYNUTF",
        max_notional=Decimal("25"),
    )

    assert metadata["execution_lane"] == "simple"
    assert metadata["submit_path"] == "bounded_paper_route_collection"
    assert metadata["execution_account_label"] == "PA3SX7FYNUTF"
    policy = metadata["execution_policy"]
    assert isinstance(policy, dict)
    assert policy["authority"] == "bounded_paper_route_collection_only"
    assert policy["live_capital_routing_enabled"] is False
    assert policy["capital_promotion_allowed"] is False
    assert policy["target_account_label"] == "TORGHUT_SIM"
    assert policy["runtime_account_label"] == "PA3SX7FYNUTF"
    assert policy["idempotency_key_basis"] == "trade_decision_hash_client_order_id"
    assert policy["order_feed_linkage_keys"] == [
        "alpaca_account_label",
        "client_order_id",
    ]
