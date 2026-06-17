from __future__ import annotations

from tests.simple_pipeline.support import (
    Base,
    Decimal,
    Execution,
    MarketSnapshot,
    Session,
    SimpleNamespace,
    SimpleTradingPipeline,
    StaticPool,
    Strategy,
    StrategyDecision,
    TradeDecision,
    _bounded_hpairs_target,
    _bounded_sim_collection_blockers,
    _bounded_sim_collection_metadata_from_decision,
    create_engine,
    datetime,
    settings,
    timedelta,
    timezone,
)


def test_local_target_plan_enriches_probe_contract_before_bounded_gate(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 3, 16, 0, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            paper_route_probe_window_start="2026-06-03T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-03T20:00:00+00:00",
            paper_route_probe_next_session_max_notional="25",
            paper_route_probe_symbol_actions={"AAPL": "buy", "AMZN": "sell"},
            paper_route_probe_symbol_quantities={"AAPL": "2", "AMZN": "1"},
        )
        target.pop("paper_route_probe_symbols")
        target.pop("source_decision_readiness")
        live_gate = {
            "runtime_ledger_paper_probation_import_plan": {
                "schema_version": "torghut.runtime-ledger-paper-probation-import-plan.v1",
                "target_count": 1,
                "targets": [target],
            }
        }
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
                price=Decimal("8.3333333333333333333"),
                spread=Decimal("0"),
                source="fixture",
                bid=Decimal("8.3333333333333333333"),
                ask=Decimal("8.3333333333333333333"),
            )
        )
        pipeline._is_market_session_open = lambda _now: True
        pipeline._live_submission_gate = lambda **_kwargs: live_gate
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        symbols, error, targets = pipeline._local_paper_route_target_probe_symbols(
            session=None,
            strategies=[strategy],
        )

        assert error is None
        assert symbols == {"AAPL", "AMZN"}
        assert targets[0]["paper_route_probe_symbols"] == ["AAPL", "AMZN"]
        assert targets[0]["source_decision_readiness"]["ready"] is True
        assert targets[0]["source_decision_readiness"]["blockers"] == []

        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            symbols,
            error,
            targets,
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
            assert metadata["source_decision_readiness"]["ready"] is True
            assert metadata["paper_route_probe_symbols"] == ["AAPL", "AMZN"]
            assert (
                "bounded_sim_collection_probe_symbols_missing"
                not in metadata["bounded_evidence_collection_blockers"]
            )
            assert (
                "bounded_sim_collection_source_decision_readiness_missing"
                not in metadata["bounded_evidence_collection_blockers"]
            )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_allow_shorts = allow_shorts_before


def test_source_collection_authorization_emits_bounded_lineage_decisions_without_candidate_hardcode(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 2, 18, 0, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            hypothesis_id="H-SOURCE-AUTH-01",
            candidate_id="source-authorized-candidate",
            paper_route_probe_window_start="2026-06-02T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-02T20:00:00+00:00",
            paper_route_probe_next_session_max_notional="25",
            paper_route_probe_symbol_actions={"AAPL": "buy", "AMZN": "sell"},
            paper_route_probe_symbol_quantities={"AAPL": "2", "AMZN": "1"},
            source_collection_authorized=True,
            source_collection_authorization_scope=(
                "bounded_paper_route_source_decision_collection_only"
            ),
            source_collection_reason_codes=[
                "runtime_ledger_source_decisions_missing",
                "bounded_paper_route_manifest_seed",
            ],
            paper_probation_authorized=False,
            paper_probation_satisfied_for_bounded_live_paper_collection=False,
            evidence_collection_ok=False,
            canary_collection_authorized=False,
            bounded_evidence_collection_authorized=False,
            bounded_live_paper_collection_authorized=False,
            bounded_evidence_collection_blockers=[
                "paper_probation_prerequisites_not_satisfied_for_bounded_collection"
            ],
            candidate_blockers=[
                "runtime_ledger_source_decisions_missing",
                "source_backed_paper_probation_required",
                "paper_probation_prerequisites_not_satisfied_for_bounded_collection",
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
        pipeline.price_fetcher = SimpleNamespace(
            fetch_market_snapshot=lambda signal: MarketSnapshot(
                symbol=signal.symbol,
                as_of=signal.event_ts,
                price=Decimal("8.3333333333333333333"),
                spread=Decimal("0"),
                source="fixture",
                bid=Decimal("8.3333333333333333333"),
                ask=Decimal("8.3333333333333333333"),
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

        assert {decision.symbol for decision in decisions} == {"AAPL", "AMZN"}
        for decision in decisions:
            params = decision.params
            metadata = params["paper_route_target_plan_source_decision"]
            assert params["hypothesis_id"] == "H-SOURCE-AUTH-01"
            assert params["candidate_id"] == "source-authorized-candidate"
            assert params["strategy_name"] == "microbar-cross-sectional-pairs-v1"
            assert (
                params["runtime_strategy_name"] == "microbar-cross-sectional-pairs-v1"
            )
            assert params["account_label"] == "TORGHUT_SIM"
            assert params["source_account_label"] == "TORGHUT_SIM"
            assert params["source_decision_mode"] == "bounded_paper_route_collection"
            assert params["profit_proof_eligible"] is True
            assert params["promotion_allowed"] is False
            assert params["final_promotion_authorized"] is False
            assert params["final_promotion_allowed"] is False
            assert params["live_capital_routing_enabled"] is False
            assert metadata["source_collection_authorized"] is True
            assert metadata["bounded_evidence_collection_authorized"] is True
            assert metadata["bounded_live_paper_collection_authorized"] is True
            assert metadata["canary_collection_authorized"] is True
            assert metadata["evidence_collection_ok"] is True
            assert (
                "paper_probation_prerequisites_not_satisfied_for_bounded_collection"
                not in metadata["bounded_evidence_collection_blockers"]
            )
            assert metadata["promotion_allowed"] is False
            assert metadata["final_promotion_allowed"] is False
            assert metadata["paper_route_probe_symbols"] == ["AAPL", "AMZN"]
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_allow_shorts = allow_shorts_before


def test_hpairs_owner_skips_other_source_collection_targets_for_same_paper_account(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 2, 18, 0, tzinfo=timezone.utc)
        hpairs_target = _bounded_hpairs_target(
            paper_route_probe_window_start="2026-06-02T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-02T20:00:00+00:00",
            paper_route_probe_next_session_max_notional="75000",
            paper_route_probe_symbol_actions={"AAPL": "buy", "AMZN": "sell"},
            paper_route_probe_symbol_quantities={"AAPL": "120.1614", "AMZN": "1"},
        )
        tsmom_target = _bounded_hpairs_target(
            hypothesis_id="H-TSMOM-LIQ-01",
            candidate_id="ca4e6e3c7d639e3363dc5860",
            strategy_family="intraday_tsmom_consistent",
            strategy_name="intraday-tsmom-profit-v3",
            runtime_strategy_name="intraday-tsmom-profit-v3",
            source_manifest_ref="config/trading/hypotheses/h-tsmom-liq-01.json",
            paper_route_probe_symbols=["NVDA", "INTC"],
            paper_route_probe_pair_balance_state="not_required",
            paper_route_probe_window_start="2026-06-02T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-02T20:00:00+00:00",
            paper_route_probe_next_session_max_notional="75000",
            paper_route_probe_symbol_actions={"NVDA": "buy", "INTC": "buy"},
            paper_route_probe_symbol_quantities={"NVDA": "1", "INTC": "34.6997"},
        )
        hpairs_strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="H-PAIRS proof owner",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "AMZN"],
        )
        tsmom_strategy = Strategy(
            name="intraday-tsmom-profit-v3",
            description="non-owner source collection target",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["NVDA", "INTC"],
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
            {"AAPL", "AMZN", "NVDA", "INTC"},
            None,
            [hpairs_target, tsmom_target],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        decisions = pipeline._paper_route_target_source_decisions(
            strategies=[hpairs_strategy, tsmom_strategy],
            allowed_symbols={"AAPL", "AMZN", "NVDA", "INTC"},
            positions=[],
            session=None,
        )

        assert {decision.symbol for decision in decisions} == {"AAPL", "AMZN"}
        assert {
            decision.params["paper_route_target_plan_source_decision"]["hypothesis_id"]
            for decision in decisions
        } == {"H-PAIRS-01"}
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_allow_shorts = allow_shorts_before


def test_stale_unfilled_hpairs_closeout_does_not_block_retry_with_source_lineage(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        engine = create_engine(
            "sqlite+pysqlite:///:memory:",
            future=True,
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(engine)
        session_open = datetime(2026, 6, 2, 13, 30, tzinfo=timezone.utc)
        entry_at = session_open + timedelta(minutes=5)
        exit_due_at = session_open + timedelta(minutes=60)
        now = exit_due_at + timedelta(minutes=10)
        with Session(engine) as session:
            strategy = Strategy(
                name="microbar-cross-sectional-pairs-v1",
                description="H-PAIRS stale closeout retry fixture",
                enabled=True,
                base_timeframe="1Sec",
                universe_type="static",
                universe_symbols=["AAPL", "AMZN"],
            )
            session.add(strategy)
            session.flush()
            entry_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=entry_at,
                timeframe="1Sec",
                action="buy",
                qty=Decimal("1"),
                params={
                    "source_decision_mode": "bounded_paper_route_collection",
                    "profit_proof_eligible": True,
                    "candidate_id": "c88421d619759b2cfaa6f4d0",
                    "hypothesis_id": "H-PAIRS-01",
                    "paper_route_target_plan_source_decision": _bounded_hpairs_target(
                        exit_minute_after_open=60,
                        effective_exit_minute_after_open=60,
                        exit_due_at=exit_due_at.isoformat(),
                        paper_route_probe_window_start=session_open.isoformat(),
                        paper_route_probe_window_end=(
                            session_open + timedelta(minutes=390)
                        ).isoformat(),
                        source_decision_mode="bounded_paper_route_collection",
                        profit_proof_eligible=True,
                        source_candidate_ids=["c88421d619759b2cfaa6f4d0"],
                        source_hypothesis_ids=["H-PAIRS-01"],
                    ),
                    "paper_route_probe_lineage_targets": [
                        {
                            "candidate_id": "c88421d619759b2cfaa6f4d0",
                            "hypothesis_id": "H-PAIRS-01",
                            "strategy_name": "microbar-cross-sectional-pairs-v1",
                        }
                    ],
                    "source_candidate_ids": ["c88421d619759b2cfaa6f4d0"],
                    "source_hypothesis_ids": ["H-PAIRS-01"],
                    "source_strategy_names": ["microbar-cross-sectional-pairs-v1"],
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_promotion_allowed": False,
                },
            )
            entry_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json=entry_decision.model_dump(mode="json"),
                rationale="H-PAIRS bounded entry fixture",
                status="executed",
                created_at=entry_at,
                executed_at=entry_at,
            )
            session.add(entry_row)
            session.flush()
            session.add(
                Execution(
                    trade_decision_id=entry_row.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="hpairs-entry-filled",
                    client_order_id="hpairs-entry-filled",
                    symbol="AAPL",
                    side="buy",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("1"),
                    avg_fill_price=Decimal("100"),
                    status="filled",
                    raw_order={},
                    created_at=entry_at,
                    updated_at=entry_at,
                    last_update_at=entry_at,
                )
            )
            stale_exit_decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=exit_due_at,
                timeframe="1Sec",
                action="sell",
                qty=Decimal("1"),
                params={
                    "paper_route_probe_exit": {
                        "mode": "paper_route_exit",
                        "exit_due_at": exit_due_at.isoformat(),
                    },
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_promotion_allowed": False,
                },
            )
            stale_exit_row = TradeDecision(
                strategy_id=strategy.id,
                alpaca_account_label="TORGHUT_SIM",
                symbol="AAPL",
                timeframe="1Sec",
                decision_json=stale_exit_decision.model_dump(mode="json"),
                rationale="stale unfilled closeout",
                status="submitted",
                created_at=exit_due_at,
            )
            session.add(stale_exit_row)
            session.flush()
            session.add(
                Execution(
                    trade_decision_id=stale_exit_row.id,
                    alpaca_account_label="TORGHUT_SIM",
                    alpaca_order_id="hpairs-exit-unfilled",
                    client_order_id="hpairs-exit-unfilled",
                    symbol="AAPL",
                    side="sell",
                    order_type="market",
                    time_in_force="day",
                    submitted_qty=Decimal("1"),
                    filled_qty=Decimal("0"),
                    avg_fill_price=Decimal("0"),
                    status="submitted",
                    raw_order={},
                    created_at=exit_due_at,
                    updated_at=exit_due_at,
                    last_update_at=exit_due_at,
                )
            )
            session.commit()

            pipeline = object.__new__(SimpleTradingPipeline)
            pipeline.account_label = "TORGHUT_SIM"
            pipeline._is_market_session_open = lambda _now: True
            monkeypatch.setattr(
                "app.trading.scheduler.simple_pipeline.trading_now",
                lambda account_label=None: now,
            )

            decisions = pipeline._paper_route_probe_exit_decisions(session=session)

        assert len(decisions) == 1
        decision = decisions[0]
        assert decision.action == "sell"
        assert decision.event_ts == now
        exit_metadata = decision.params["paper_route_probe_exit"]
        assert exit_metadata["exit_due_at"] == exit_due_at.isoformat()
        assert exit_metadata["retry_event_ts"] == now.isoformat()
        assert exit_metadata["source_candidate_ids"] == ["c88421d619759b2cfaa6f4d0"]
        assert exit_metadata["source_hypothesis_ids"] == ["H-PAIRS-01"]
        assert decision.params["source_decision_mode"] == (
            "bounded_paper_route_collection"
        )
        assert decision.params["profit_proof_eligible"] is True
        assert decision.params.get("promotion_allowed") is not True
        assert decision.params.get("final_promotion_allowed") is not True
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before


def test_bounded_source_collection_blocks_closed_session_with_explicit_reason(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "TORGHUT_SIM"
        pipeline.state = SimpleNamespace()
        pipeline._is_market_session_open = lambda _now: False
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            {"AAPL", "AMZN"},
            None,
            [_bounded_hpairs_target()],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        decisions = pipeline._paper_route_target_source_decisions(
            strategies=[],
            allowed_symbols={"AAPL", "AMZN"},
            positions=[],
            session=None,
        )

        assert decisions == []
        blocker = pipeline.state.last_bounded_evidence_collection_blocker
        assert blocker["reason"] == "paper_route_session_window_not_open"
        assert blocker["blockers"] == ["paper_route_session_window_not_open"]
        assert blocker["account_label"] == "TORGHUT_SIM"
        assert blocker["target_count"] == 0
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before


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
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
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
        assert pipeline._paper_route_target_plan_reserves_account(
            allowed_symbols={"NVDA", "INTC"},
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
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
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
