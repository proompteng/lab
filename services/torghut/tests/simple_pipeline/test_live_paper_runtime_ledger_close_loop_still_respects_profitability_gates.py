from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.simple_pipeline.support import (
    Decimal,
    MarketSnapshot,
    POST_COST_BASIS_RUNTIME_LEDGER,
    SimpleNamespace,
    SimpleTradingPipeline,
    Strategy,
    _bounded_hpairs_target,
    _bounded_sim_collection_blockers,
    _build_realized_strategy_pnl_rows,
    _quote_snapshot_reference_price,
    _runtime_ledger_bucket_profit_proof_present,
    _runtime_promotion_blocking_reasons,
    _target_probe_symbol_notional_budget,
    _target_probe_symbol_quantities,
    _target_probe_window,
    _target_symbols,
    datetime,
    resolve_hypothesis_manifest,
    settings,
    timezone,
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
    assert metadata["exit_minute_after_open"] == 375
    assert metadata["effective_exit_minute_after_open"] == 375
    assert metadata["exit_due_at"] == "2026-06-01T19:45:00+00:00"
    assert metadata["paper_route_probe_exit_defaulted"] is True
    assert metadata["account_stage_runtime_identity"] == {
        "account_label": "TORGHUT_SIM",
        "source_account_label": None,
        "observed_stage": "paper",
        "runtime_strategy_name": "microbar-cross-sectional-pairs-v1",
        "source_kind": "paper_route_probe_runtime_observed",
    }


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


def test_target_probe_symbol_quantities_apply_target_quantity_fallback() -> None:
    quantities = _target_probe_symbol_quantities(
        {"target_quantity": "3"},
        ["AAPL", "AMZN"],
    )

    assert quantities == {"AAPL": Decimal("3"), "AMZN": Decimal("3")}


def test_target_notional_budget_and_quote_reference_defensive_paths() -> None:
    assert (
        _target_probe_symbol_notional_budget(
            target={"target_notional": "0"},
            symbol="AAPL",
            symbols=["AAPL"],
            symbol_quantities={},
            max_notional=Decimal("0"),
        )
        is None
    )
    assert (
        _target_probe_symbol_notional_budget(
            target={"target_notional": "100"},
            symbol="MSFT",
            symbols=["AAPL"],
            symbol_quantities={},
            max_notional=Decimal("100"),
        )
        is None
    )
    assert _quote_snapshot_reference_price(
        {"bid": "99", "ask": "101"},
        action="hold",  # type: ignore[arg-type]
    ) == Decimal("100")
    assert _quote_snapshot_reference_price({}, action="buy") is None


def test_target_quantity_resolution_records_fallback_blockers() -> None:
    now = datetime(2026, 6, 4, 14, 30, tzinfo=timezone.utc)
    pipeline = object.__new__(SimpleTradingPipeline)
    pipeline.price_fetcher = SimpleNamespace(
        fetch_market_snapshot=lambda signal: MarketSnapshot(
            symbol=signal.symbol,
            as_of=signal.event_ts,
            price=Decimal("100"),
            spread=None,
            source="fixture",
        )
    )

    assert (
        pipeline._paper_route_target_quantity_resolution(
            target={"target_notional": "100"},
            symbol="AAPL",
            symbols=["AAPL"],
            action="buy",
            requested_qty=Decimal("0"),
            symbol_quantities={},
            max_notional=Decimal("100"),
            event_ts=now,
            timeframe="1Min",
        )
        is None
    )

    missing_budget = pipeline._paper_route_target_quantity_resolution(
        target={"target_notional": "100"},
        symbol="MSFT",
        symbols=["AAPL"],
        action="buy",
        requested_qty=Decimal("1"),
        symbol_quantities={},
        max_notional=Decimal("100"),
        event_ts=now,
        timeframe="1Min",
    )
    assert missing_budget is not None
    assert missing_budget.qty == Decimal("1")
    assert missing_budget.audit["blockers"] == [
        "paper_route_target_symbol_notional_budget_missing"
    ]

    no_price_pipeline = object.__new__(SimpleTradingPipeline)
    no_price = no_price_pipeline._paper_route_target_quantity_resolution(
        target={"target_notional": "100"},
        symbol="AAPL",
        symbols=["AAPL"],
        action="buy",
        requested_qty=Decimal("1"),
        symbol_quantities={},
        max_notional=Decimal("100"),
        event_ts=now,
        timeframe="1Min",
    )
    assert no_price is not None
    assert no_price.audit["blockers"] == ["paper_route_target_notional_price_missing"]

    too_small = pipeline._paper_route_target_quantity_resolution(
        target={"target_notional": "0.000001"},
        symbol="AAPL",
        symbols=["AAPL"],
        action="buy",
        requested_qty=Decimal("1"),
        symbol_quantities={},
        max_notional=Decimal("0.000001"),
        event_ts=now,
        timeframe="1Min",
    )
    assert too_small is None


def test_target_sizing_price_uses_target_snapshot_and_handles_fetcher_failures() -> (
    None
):
    now = datetime(2026, 6, 4, 14, 30, tzinfo=timezone.utc)
    pipeline = object.__new__(SimpleTradingPipeline)
    reference_price, price_params, price_source = (
        pipeline._paper_route_target_sizing_price(
            target={"price_snapshot": {"symbol": "AAPL", "bid": "99", "ask": "101"}},
            symbol="AAPL",
            action="buy",
            event_ts=now,
            timeframe="1Min",
        )
    )
    assert reference_price == Decimal("101")
    assert price_params["reference_price"] == Decimal("101")
    assert price_source == "target_plan_quote_snapshot"

    no_fetcher = object.__new__(SimpleTradingPipeline)
    assert no_fetcher._paper_route_target_sizing_price(
        target={},
        symbol="AAPL",
        action="buy",
        event_ts=now,
        timeframe="1Min",
    ) == (None, {}, None)

    class RaisingFetcher:
        def fetch_market_snapshot(self, signal: object) -> MarketSnapshot | None:
            raise RuntimeError("boom")

    failing = object.__new__(SimpleTradingPipeline)
    failing.price_fetcher = RaisingFetcher()
    assert failing._paper_route_target_sizing_price(
        target={},
        symbol="AAPL",
        action="buy",
        event_ts=now,
        timeframe="1Min",
    ) == (None, {}, None)

    invalid = object.__new__(SimpleTradingPipeline)
    invalid.price_fetcher = SimpleNamespace(
        fetch_market_snapshot=lambda signal: MarketSnapshot(
            symbol="AAPL",
            as_of=now,
            price=None,
            spread=None,
            source="fixture",
        )
    )
    reference_price, price_params, price_source = (
        invalid._paper_route_target_sizing_price(
            target={},
            symbol="AAPL",
            action="buy",
            event_ts=now,
            timeframe="1Min",
        )
    )
    assert reference_price is None
    assert "price_snapshot" in price_params
    assert price_source == "price_fetcher_snapshot"


def test_target_source_decisions_size_default_quantities_from_target_notional(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 4, 14, 30, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            target_notional="20000",
            paper_route_probe_next_session_max_notional="20000",
            paper_route_probe_window_start="2026-06-04T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-04T20:00:00+00:00",
            paper_route_probe_symbol_actions={"AAPL": "buy", "AMZN": "sell"},
            paper_route_probe_symbol_quantities={"AAPL": "1", "AMZN": "1"},
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
        pipeline.price_fetcher = SimpleNamespace(
            fetch_market_snapshot=lambda signal: MarketSnapshot(
                symbol=signal.symbol,
                as_of=signal.event_ts,
                price=Decimal("100"),
                spread=Decimal("0"),
                source="fixture",
                bid=Decimal("100"),
                ask=Decimal("100"),
            )
        )
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
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

        assert {decision.symbol: decision.qty for decision in decisions} == {
            "AAPL": Decimal("100.0000"),
            "AMZN": Decimal("100.0000"),
        }
        for decision in decisions:
            sizing = decision.params["paper_route_target_notional_sizing"]
            assert sizing["sizing_source"] == "target_notional"
            assert sizing["requested_qty"] == "1"
            assert Decimal(str(sizing["symbol_notional_budget"])) == Decimal("10000")
            assert sizing["reference_price"] == "100"
            assert sizing["overrode_requested_qty"] is True
            assert decision.params["reference_price"] == Decimal("100")
            assert (
                decision.params["simple_lane"]["paper_route_target_notional_sizing"]
                == sizing
            )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_allow_shorts = allow_shorts_before


def test_source_collection_target_defaults_current_session_probe_contract(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 5, 14, 45, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            source_kind="runtime_ledger_source_collection_candidate",
            strategy_id="microbar_cross_sectional_pairs_v1@research",
            strategy_name="69cf50e3-4815-47c2-b802-1efbaac09ecb",
            runtime_strategy_name="69cf50e3-4815-47c2-b802-1efbaac09ecb",
            strategy_lookup_names=[
                "69cf50e3-4815-47c2-b802-1efbaac09ecb",
                "microbar-cross-sectional-pairs-v1",
            ],
            source_collection_authorized=True,
            source_collection_authorization_scope=(
                "source_window_evidence_collection_only"
            ),
            target_notional="75000",
            paper_route_probe_next_session_max_notional="75000",
            bounded_evidence_collection_max_notional="75000",
        )
        target.pop("paper_route_probe_symbols")
        target.pop("source_decision_readiness")
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
        pipeline.price_fetcher = SimpleNamespace(
            fetch_market_snapshot=lambda signal: MarketSnapshot(
                symbol=signal.symbol,
                as_of=signal.event_ts,
                price=Decimal("100"),
                spread=Decimal("0"),
                source="fixture",
                bid=Decimal("100"),
                ask=Decimal("100"),
            )
        )
        pipeline._is_market_session_open = lambda _now: True
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        normalized = pipeline._paper_route_target_with_local_probe_contract(
            target,
            strategies=[strategy],
        )
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            _target_symbols(normalized),
            None,
            [normalized],
        )

        assert normalized["paper_route_probe_symbols"] == ["AAPL", "AMZN"]
        assert normalized["paper_route_probe_window_defaulted"] is True
        assert normalized["paper_route_probe_window_source"] == (
            "current_regular_session_source_collection_default"
        )
        assert _target_probe_window(normalized) == (
            datetime(2026, 6, 5, 13, 30, tzinfo=timezone.utc),
            datetime(2026, 6, 5, 20, 0, tzinfo=timezone.utc),
        )

        decisions = pipeline._paper_route_target_source_decisions(
            strategies=[strategy],
            allowed_symbols={"AAPL", "AMZN"},
            positions=[],
            session=None,
        )

        assert {decision.symbol: decision.qty for decision in decisions} == {
            "AAPL": Decimal("375.0000"),
            "AMZN": Decimal("375.0000"),
        }
        actions = {
            decision.symbol: decision.params["simple_lane"][
                "paper_route_probe_leg_action"
            ]
            for decision in decisions
        }
        assert actions == {"AAPL": "buy", "AMZN": "sell"}
        for decision in decisions:
            metadata = decision.params["paper_route_target_plan_source_decision"]
            assert metadata["source_collection_authorized"] is True
            assert metadata["profit_proof_eligible"] is True
            assert metadata["paper_route_probe_window_start"] == (
                "2026-06-05T13:30:00+00:00"
            )
            assert metadata["paper_route_probe_window_end"] == (
                "2026-06-05T20:00:00+00:00"
            )
            assert decision.params["source_decision_mode"] == (
                "bounded_paper_route_collection"
            )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_allow_shorts = allow_shorts_before


def test_target_source_decisions_skip_target_notional_below_min_step(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 4, 14, 30, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            target_notional="0.000001",
            paper_route_probe_next_session_max_notional="0.000001",
            paper_route_probe_window_start="2026-06-04T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-04T20:00:00+00:00",
            paper_route_probe_symbol_actions={"AAPL": "buy", "AMZN": "sell"},
            paper_route_probe_symbol_quantities={"AAPL": "1", "AMZN": "1"},
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
        pipeline.price_fetcher = SimpleNamespace(
            fetch_market_snapshot=lambda signal: MarketSnapshot(
                symbol=signal.symbol,
                as_of=signal.event_ts,
                price=Decimal("100"),
                spread=None,
                source="fixture",
            )
        )
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
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

        assert decisions == []
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_allow_shorts = allow_shorts_before
