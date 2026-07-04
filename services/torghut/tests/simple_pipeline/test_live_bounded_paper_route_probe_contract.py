from __future__ import annotations

from app.trading.scheduler.submission_preparation.shared import (
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


def test_simple_live_submission_gate_drops_retired_source_collection_blockers(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    trading_enabled_before = settings.trading_enabled
    kill_switch_before = settings.trading_kill_switch_enabled
    simple_submit_before = settings.trading_simple_submit_enabled
    live_submit_before = settings.trading_live_submit_enabled
    emergency_stop_before = settings.trading_emergency_stop_enabled
    try:
        settings.trading_mode = "live"
        settings.trading_enabled = True
        settings.trading_kill_switch_enabled = False
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_enabled = True
        settings.trading_emergency_stop_enabled = False

        def _legacy_gate(
            self: object,
            *,
            inputs: object | None = None,
        ) -> dict[str, object]:
            _ = self, inputs
            return {
                "allowed": False,
                "reason": "alpha_readiness_not_promotion_eligible",
                "blocked_reasons": [
                    "alpha_readiness_not_promotion_eligible",
                    "runtime_ledger_profit_target_source_collection_pending",
                    "runtime_ledger_source_collection_pending",
                ],
                "execution_route": {
                    "route": "testnet",
                    "alpaca_regular_session_open": False,
                },
            }

        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.TradingPipeline._live_submission_gate",
            _legacy_gate,
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.state = SimpleNamespace(emergency_stop_active=False)

        gate = pipeline._live_submission_gate()

        assert gate["allowed"] is True
        assert gate["reason"] == "operational_submission_ready"
        assert gate["blocked_reasons"] == []
        assert gate["operational_submission_gate"] == {
            "allowed": True,
            "reason": "operational_submission_ready",
            "blocked_reasons": [],
            "execution_route": {
                "route": "testnet",
                "alpaca_regular_session_open": False,
            },
        }
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_enabled = trading_enabled_before
        settings.trading_kill_switch_enabled = kill_switch_before
        settings.trading_simple_submit_enabled = simple_submit_before
        settings.trading_live_submit_enabled = live_submit_before
        settings.trading_emergency_stop_enabled = emergency_stop_before


def test_bounded_live_paper_route_requires_explicit_collection_gate() -> None:
    assert not SimpleTradingPipeline._bounded_live_paper_route_collection_gate_allows(
        {
            "allowed": False,
            "reason": "runtime_ledger_source_collection_pending",
            "blocked_reasons": ["runtime_ledger_source_collection_pending"],
        }
    )
    assert SimpleTradingPipeline._bounded_live_paper_route_collection_gate_allows(
        {
            "bounded_live_paper_collection_gate": {
                "allowed": True,
                "reason": "explicit_collection_contract",
            }
        }
    )


def test_live_profitability_proof_floor_is_diagnostic_for_runtime_ledger_blockers() -> (
    None
):
    trading_mode_before = settings.trading_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    try:
        settings.trading_mode = "live"
        settings.trading_simple_submit_enabled = True
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline._profitability_proof_floor = lambda session: {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": [
                "alpha_readiness_not_promotion_eligible",
                "runtime_ledger_profit_target_source_collection_pending",
                "runtime_ledger_source_collection_pending",
            ],
        }
        blocks: list[object] = []
        pipeline._block_decision_submission = lambda request: blocks.append(request)

        assert pipeline._profitability_floor_submission_allowed(
            TradingSubmissionRequest(
                session=SimpleNamespace(),
                decision=_routeability_decision(),
                decision_row=SimpleNamespace(status="planned"),
            )
        )
        assert blocks == []
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_submit_enabled = submit_enabled_before


def test_live_bounded_paper_route_target_generates_capped_source_decisions(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
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
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )
        settings.trading_allow_shorts = allow_shorts_before


def test_live_bounded_source_collection_skips_unactionable_short_open_leg(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    allow_shorts_before = settings.trading_allow_shorts
    fractional_before = settings.trading_fractional_equities_enabled
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "2026-06-17T20:05:00Z"
        settings.trading_simple_paper_route_probe_max_notional = 100
        settings.trading_allow_shorts = True
        settings.trading_fractional_equities_enabled = True
        now = datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            account_label="TORGHUT_REPLAY",
            source_account_label="TORGHUT_REPLAY",
            paper_account_label="TORGHUT_REPLAY",
            execution_account_label="TORGHUT_REPLAY",
            paper_route_probe_symbols=["NVDA", "AMZN"],
            paper_route_probe_symbol_actions={"NVDA": "buy", "AMZN": "sell"},
            paper_route_probe_next_session_max_notional="100",
            target_notional="100",
            paper_route_probe_window_start="2026-06-17T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-17T20:00:00+00:00",
            source_kind="runtime_ledger_source_collection_candidate",
        )
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="metadata fixture",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["NVDA", "AMZN"],
        )
        prices = {"NVDA": Decimal("50"), "AMZN": Decimal("500")}
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline.price_fetcher = SimpleNamespace(
            fetch_market_snapshot=lambda signal: MarketSnapshot(
                symbol=signal.symbol,
                as_of=signal.event_ts,
                price=prices[signal.symbol],
                spread=Decimal("0"),
                source="fixture",
                bid=prices[signal.symbol],
                ask=prices[signal.symbol],
            )
        )
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            {"NVDA", "AMZN"},
            None,
            [target],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        decisions = pipeline._paper_route_target_source_decisions(
            strategies=[strategy],
            allowed_symbols={"NVDA", "AMZN"},
            positions=[],
            session=None,
        )

        assert [decision.symbol for decision in decisions] == ["NVDA"]
        decision = decisions[0]
        assert decision.action == "buy"
        assert decision.qty == Decimal("1.0000")
        sizing = decision.params["paper_route_target_notional_sizing"]
        assert sizing["broker_resolved_qty"] == "1.0000"
        assert sizing["broker_quantity_resolution"]["fractional_allowed"] is True
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )
        settings.trading_allow_shorts = allow_shorts_before
        settings.trading_fractional_equities_enabled = fractional_before


def test_live_bounded_paper_route_target_ignores_expired_activation(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
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
        blocker = pipeline.state.last_bounded_evidence_collection_blocker
        assert blocker["reason"] == "paper_route_target_plan_source_decisions_missing"
        assert blocker["reason"] != "live_submit_activation_expired"
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )


def test_bounded_paper_route_target_uses_static_universe_without_promotion() -> None:
    static_symbols_before = settings.trading_static_symbols_raw
    try:
        settings.trading_static_symbols_raw = "AAPL,nvda,AAPL"
        target = _bounded_hpairs_target(
            paper_route_probe_symbols=[],
            target_symbols=[],
            symbols=[],
            paper_route_target_account_audit_state={},
            source_decision_readiness=None,
            promotion_allowed=False,
            capital_promotion_allowed=False,
            final_promotion_allowed=False,
            final_promotion_authorized=False,
        )
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="metadata fixture",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=[],
        )
        pipeline = object.__new__(SimpleTradingPipeline)

        resolved = pipeline._paper_route_target_with_local_probe_contract(
            target,
            strategies=[strategy],
        )

        assert resolved["paper_route_probe_symbols"] == ["AAPL", "NVDA"]
        assert resolved["paper_route_probe_static_universe_fallback"] is True
        assert resolved["paper_route_probe_static_universe_symbols"] == ["AAPL", "NVDA"]
        assert (
            resolved["paper_route_probe_scope_authority"] == "static_trading_universe"
        )
        readiness = resolved["source_decision_readiness"]
        assert readiness["ready"] is True
        assert readiness["source"] == "local_static_universe_target_plan_fallback"
        assert readiness["blockers"] == []
        assert readiness["raw_probe_symbols"] == ["AAPL", "NVDA"]
        assert readiness["scoped_probe_symbols"] == ["AAPL", "NVDA"]
        assert readiness["matched_strategy"]["strategy_name"] == (
            "microbar-cross-sectional-pairs-v1"
        )
    finally:
        settings.trading_static_symbols_raw = static_symbols_before


def test_live_source_collection_target_defaults_static_universe_and_current_session(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    static_symbols_before = settings.trading_static_symbols_raw
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "2026-06-17T20:05:00Z"
        settings.trading_simple_paper_route_probe_max_notional = 100
        settings.trading_static_symbols_raw = "AAPL,AMZN,INTC,NVDA"
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 17, 17, 30, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            paper_route_probe_symbols=[],
            target_symbols=[],
            symbols=[],
            source_kind="runtime_ledger_source_collection_candidate",
            source_collection_authorized=True,
            source_collection_authorization_scope=(
                "source_window_evidence_collection_only"
            ),
            paper_route_probe_window_start="2026-05-13T17:00:00+00:00",
            paper_route_probe_window_end="2026-05-13T17:30:00+00:00",
            paper_route_probe_next_session_max_notional="100",
            bounded_evidence_collection_max_notional="100",
            target_notional="100",
            canary_collection_authorized=False,
            paper_route_target_account_audit_state={},
            source_decision_readiness=None,
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
                price=Decimal("50"),
                spread=Decimal("0"),
                source="fixture",
                bid=Decimal("50"),
                ask=Decimal("50"),
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
            set(normalized["paper_route_probe_symbols"]),
            None,
            [normalized],
        )

        decisions = pipeline._paper_route_target_source_decisions(
            strategies=[strategy],
            allowed_symbols={"AAPL", "AMZN", "INTC", "NVDA"},
            positions=[],
            session=None,
        )

        assert normalized["paper_route_probe_symbols"] == ["AAPL", "AMZN"]
        assert normalized["paper_route_probe_window_defaulted"] is True
        assert normalized["paper_route_probe_window_start"] == (
            "2026-06-17T13:30:00+00:00"
        )
        assert normalized["paper_route_probe_window_end"] == (
            "2026-06-17T20:00:00+00:00"
        )
        assert {decision.symbol for decision in decisions} == {"AAPL", "AMZN"}
        for decision in decisions:
            assert decision.params["source_decision_mode"] == (
                "bounded_paper_route_collection"
            )
            assert decision.params["bounded_paper_route_submit_path"] == (
                "bounded_paper_route_collection"
            )
            assert decision.params["profit_proof_eligible"] is True
            metadata = decision.params["paper_route_target_plan_source_decision"]
            assert metadata["bounded_live_paper_collection_authorized"] is True
            assert metadata["paper_route_probe_window_start"] == (
                "2026-06-17T13:30:00+00:00"
            )
            assert metadata["paper_route_probe_window_end"] == (
                "2026-06-17T20:00:00+00:00"
            )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )
        settings.trading_static_symbols_raw = static_symbols_before
        settings.trading_allow_shorts = allow_shorts_before


def test_live_source_collection_records_blocker_when_targets_emit_no_decisions(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    allow_shorts_before = settings.trading_allow_shorts
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "2026-06-17T20:05:00Z"
        settings.trading_simple_paper_route_probe_max_notional = 100
        settings.trading_allow_shorts = True
        now = datetime(2026, 6, 17, 17, 30, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            strategy_name="missing-live-source-strategy",
            runtime_strategy_name="missing-live-source-strategy",
            strategy_lookup_names=["missing-live-source-strategy"],
            source_kind="runtime_ledger_source_collection_candidate",
            source_collection_authorized=True,
            source_collection_authorization_scope=(
                "source_window_evidence_collection_only"
            ),
            paper_route_probe_window_start="2026-06-17T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-17T20:00:00+00:00",
            paper_route_probe_next_session_max_notional="100",
            bounded_evidence_collection_max_notional="100",
            target_notional="100",
            canary_collection_authorized=False,
            source_decision_readiness=None,
        )
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline.state = SimpleNamespace()
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
            strategies=[],
            allowed_symbols={"AAPL", "AMZN"},
            positions=[],
            session=None,
        )

        assert decisions == []
        blocker = pipeline.state.last_bounded_evidence_collection_blocker
        assert blocker["reason"] == "paper_route_target_plan_source_decisions_missing"
        assert blocker["target_symbols"] == ["AAPL", "AMZN"]
        assert blocker["target_count"] == 1
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )
        settings.trading_allow_shorts = allow_shorts_before


def test_bounded_paper_route_static_universe_does_not_override_promotion() -> None:
    static_symbols_before = settings.trading_static_symbols_raw
    try:
        settings.trading_static_symbols_raw = "AAPL,NVDA"
        target = _bounded_hpairs_target(
            paper_route_probe_symbols=[],
            target_symbols=[],
            symbols=[],
            paper_route_target_account_audit_state={},
            source_decision_readiness=None,
            promotion_allowed=True,
            capital_promotion_allowed=False,
            final_promotion_allowed=False,
            final_promotion_authorized=False,
        )
        strategy = Strategy(
            name="microbar-cross-sectional-pairs-v1",
            description="metadata fixture",
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=[],
        )
        pipeline = object.__new__(SimpleTradingPipeline)

        resolved = pipeline._paper_route_target_with_local_probe_contract(
            target,
            strategies=[strategy],
        )

        assert resolved["paper_route_probe_symbols"] == []
        assert "paper_route_probe_static_universe_fallback" not in resolved
        assert resolved["source_decision_readiness"]["ready"] is False
        assert resolved["source_decision_readiness"]["blockers"] == [
            "paper_route_probe_symbol_missing"
        ]
    finally:
        settings.trading_static_symbols_raw = static_symbols_before


def test_live_bounded_paper_route_source_collection_contract_blockers() -> None:
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    try:
        now = datetime(2026, 6, 17, 13, 45, tzinfo=timezone.utc)
        pipeline = object.__new__(SimpleTradingPipeline)

        settings.trading_simple_paper_route_probe_allow_live_mode = False
        assert (
            pipeline._live_bounded_paper_route_source_collection_blocker(now)
            == "live_paper_route_probe_collection_disabled"
        )

        settings.trading_simple_paper_route_probe_allow_live_mode = True
        settings.trading_simple_submit_enabled = False
        assert (
            pipeline._live_bounded_paper_route_source_collection_blocker(now)
            == "simple_submit_disabled"
        )

        settings.trading_simple_submit_enabled = True
        settings.trading_live_submit_activation_expires_at = "invalid"
        settings.trading_simple_paper_route_probe_max_notional = 100
        assert pipeline._live_bounded_paper_route_source_collection_blocker(now) is None

        settings.trading_live_submit_activation_expires_at = None
        settings.trading_simple_paper_route_probe_max_notional = 100
        assert pipeline._live_bounded_paper_route_source_collection_blocker(now) is None

        settings.trading_live_submit_activation_expires_at = "2026-06-17T20:05:00Z"
        settings.trading_simple_paper_route_probe_max_notional = 0
        assert (
            pipeline._live_bounded_paper_route_source_collection_blocker(now)
            == "paper_route_probe_notional_not_configured"
        )
    finally:
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )


def test_live_bounded_paper_route_probe_context_precondition_allows_live_mode() -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
        pipeline = object.__new__(SimpleTradingPipeline)
        proof_floor = {"market_window": {"session_open": True}}

        assert pipeline._paper_route_probe_context_preconditions(
            proof_floor=proof_floor,
            decision=_routeability_decision(symbol="AAPL"),
            strategy=None,
            cap=Decimal("100"),
        )

        settings.trading_simple_paper_route_probe_allow_live_mode = False
        assert not pipeline._paper_route_probe_context_preconditions(
            proof_floor=proof_floor,
            decision=_routeability_decision(symbol="AAPL"),
            strategy=None,
            cap=Decimal("100"),
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )


def test_live_bounded_paper_route_target_rejects_missing_cap_and_symbols(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    activation_expires_at_before = settings.trading_live_submit_activation_expires_at
    probe_max_notional_before = settings.trading_simple_paper_route_probe_max_notional
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
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
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )
        settings.trading_simple_submit_enabled = submit_enabled_before
        settings.trading_live_submit_activation_expires_at = (
            activation_expires_at_before
        )
        settings.trading_simple_paper_route_probe_max_notional = (
            probe_max_notional_before
        )


def test_live_profitability_symbol_floor_is_diagnostic_for_runtime_ledger_blocker() -> (
    None
):
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    probe_allow_live_before = settings.trading_simple_paper_route_probe_allow_live_mode
    submit_enabled_before = settings.trading_simple_submit_enabled
    try:
        settings.trading_mode = "live"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_simple_paper_route_probe_allow_live_mode = True
        settings.trading_simple_submit_enabled = True
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "PA3SX7FYNUTF"
        pipeline._profitability_proof_floor = lambda session: {
            "capital_state": "shadow",
        }
        pipeline._proof_floor_symbol_block_reason = lambda proof_floor, symbol: (
            "runtime_ledger_source_collection_pending"
        )
        blocks: list[object] = []
        pipeline._block_decision_submission = lambda request: blocks.append(request)
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
        assert blocks == []
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_simple_paper_route_probe_allow_live_mode = (
            probe_allow_live_before
        )
        settings.trading_simple_submit_enabled = submit_enabled_before
