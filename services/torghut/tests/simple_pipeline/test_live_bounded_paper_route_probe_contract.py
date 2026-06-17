from __future__ import annotations

from app.trading.scheduler.submission_preparation_modules.shared import (
    TradingSubmissionRequest,
)

from tests.simple_pipeline.support import (
    Decimal,
    MarketSnapshot,
    SimpleNamespace,
    SimpleTradingPipeline,
    Strategy,
    _bounded_hpairs_target,
    _routeability_decision,
    datetime,
    settings,
    timezone,
)


def test_live_bounded_paper_route_target_generates_capped_source_decisions(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "2026-06-17T20:05:00Z"
        settings.trading_simple_paper_route_probe_max_notional = 100
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            account_label="TORGHUT_REPLAY",
            source_account_label="TORGHUT_REPLAY",
            paper_account_label="TORGHUT_REPLAY",
            execution_account_label="TORGHUT_REPLAY",
            target_notional="500",
            paper_route_probe_next_session_max_notional="500",
            paper_route_probe_window_start="2026-06-17T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-17T20:00:00+00:00",
            paper_route_probe_symbol_quantities={},
            source_kind="runtime_ledger_source_collection_candidate",
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
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline.price_fetcher = SimpleNamespace(
            fetch_market_snapshot=lambda signal: MarketSnapshot(
                symbol=signal.symbol,
                as_of=signal.event_ts,
                price=Decimal("25"),
                spread=Decimal("0"),
                source="fixture",
                bid=Decimal("25"),
                ask=Decimal("25"),
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
        assert {decision.symbol: decision.qty for decision in decisions} == {
            "AAPL": Decimal("2.0000"),
            "AMZN": Decimal("2.0000"),
        }
        for decision in decisions:
            params = decision.params
            metadata = params["paper_route_target_plan_source_decision"]
            assert params["source_decision_mode"] == "bounded_paper_route_collection"
            assert params["profit_proof_eligible"] is True
            assert params["final_authority_ok"] is False
            assert params["bounded_paper_route_submit_path"] == (
                "bounded_paper_route_collection"
            )
            assert metadata["account_label"] == "TORGHUT_REPLAY"
            assert metadata["source_account_label"] == "TORGHUT_REPLAY"
            assert metadata["paper_route_probe_total_max_notional"] == "100"
            assert metadata["paper_route_probe_next_session_max_notional"] == "100"
            assert metadata["bounded_live_paper_collection_authorized"] is True
            assert metadata["source_collection_authorized"] is True
            assert metadata["promotion_allowed"] is False
            policy = params["bounded_paper_route_execution_policy"]
            assert policy["live_capital_routing_enabled"] is False
            assert policy["runtime_account_label"] == "PA3SX7FYNUTF"
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )
        settings.trading_allow_shorts = allow_shorts_before


def test_live_bounded_paper_route_target_blocks_without_activation(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "2026-06-17T13:40:00Z"
        settings.trading_simple_paper_route_probe_max_notional = 100
        now = datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc)
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline.state = SimpleNamespace()
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            {"AAPL"},
            None,
            [_bounded_hpairs_target()],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        decisions = pipeline._paper_route_target_source_decisions(
            strategies=[],
            allowed_symbols={"AAPL"},
            positions=[],
            session=None,
        )

        assert decisions == []
        assert pipeline.state.last_bounded_evidence_collection_blocker["reason"] == (
            "live_submit_activation_expired"
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )


def test_live_bounded_paper_route_source_collection_contract_blockers() -> None:
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    try:
        now = datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc)
        pipeline = object.__new__(SimpleTradingPipeline)

        settings.trading_simple_submit_enabled = False
        assert (
            pipeline._live_bounded_paper_route_source_collection_blocker(now)
            == "simple_submit_disabled"
        )

        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "invalid"
        assert (
            pipeline._live_bounded_paper_route_source_collection_blocker(now)
            == "live_submit_activation_expiry_invalid"
        )

        settings.trading_live_submit_activation_expires_at = "2026-06-17T20:05:00Z"
        settings.trading_simple_paper_route_probe_max_notional = 0
        assert (
            pipeline._live_bounded_paper_route_source_collection_blocker(now)
            == "paper_route_probe_notional_not_configured"
        )
    finally:
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )


def test_live_bounded_paper_route_target_rejects_missing_cap_and_symbols(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "2026-06-17T20:05:00Z"
        settings.trading_simple_paper_route_probe_max_notional = 100
        now = datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc)
        missing_cap_target = _bounded_hpairs_target(
            paper_route_probe_window_start="2026-06-17T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-17T20:00:00+00:00",
            target_notional=None,
            paper_route_probe_next_session_max_notional=None,
            paper_route_probe_effective_max_notional=None,
            bounded_evidence_collection_max_notional=None,
            max_notional=None,
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
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline.price_fetcher = SimpleNamespace(
            fetch_market_snapshot=lambda signal: MarketSnapshot(
                symbol=signal.symbol,
                as_of=signal.event_ts,
                price=Decimal("25"),
                spread=Decimal("0"),
                source="fixture",
                bid=Decimal("25"),
                ask=Decimal("25"),
            )
        )
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            {"AAPL", "AMZN"},
            None,
            [missing_cap_target],
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
        assert (
            pipeline._live_bounded_paper_route_target(
                {
                    "paper_route_probe_next_session_max_notional": "100",
                    "bounded_evidence_collection_authorized": True,
                    "source_kind": "runtime_ledger_source_collection_candidate",
                }
            )
            is None
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )


def test_live_bounded_paper_route_symbol_floor_allows_bounded_probe() -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    submit_enabled_before = settings.trading_simple_submit_enabled
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_submit_enabled = True
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline._profitability_proof_floor = lambda session: {
            "capital_state": "shadow",
        }
        pipeline._proof_floor_symbol_block_reason = lambda proof_floor, symbol: (
            "runtime_ledger_source_collection_pending"
        )
        pipeline._block_decision_submission = lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("bounded live probe must not be blocked")
        )
        decision = _routeability_decision(
            params={
                "source_decision_mode": "bounded_paper_route_collection",
                "profit_proof_eligible": True,
                "paper_route_target_plan_source_decision": _bounded_hpairs_target(
                    source_decision_mode="bounded_paper_route_collection",
                    profit_proof_eligible=True,
                ),
            }
        )

        assert pipeline._profitability_floor_symbol_submission_allowed(
            TradingSubmissionRequest(
                session=SimpleNamespace(),
                decision=decision,
                decision_row=SimpleNamespace(status="planned"),
            )
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_submit_enabled = submit_enabled_before
