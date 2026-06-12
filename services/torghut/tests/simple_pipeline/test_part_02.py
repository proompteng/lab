from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.simple_pipeline.support import *


def test_target_source_decisions_fail_closed_without_target_notional_price(
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
                price=None,
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


def test_target_symbols_accept_action_and_execution_source_fields() -> None:
    assert _target_symbols(
        {
            "paper_route_probe_symbol_actions": {"aapl": "buy"},
            "paper_route_execution_source_key": {
                "paper_route_probe_symbols": [" amzn "],
            },
        }
    ) == {"AAPL", "AMZN"}


def test_target_symbols_accept_clean_window_baseline_symbol_evidence() -> None:
    assert _target_symbols(
        {
            "paper_route_clean_window_baseline_state": {
                "symbols": [" aapl "],
                "source_audit": {
                    "symbols": ["AMZN"],
                },
            },
        }
    ) == {"AAPL", "AMZN"}


def test_paper_route_probe_cap_promotes_single_target_lineage_to_top_level() -> None:
    pipeline = object.__new__(SimpleTradingPipeline)
    decision = _routeability_decision(
        params={
            "price": Decimal("100"),
            "paper_route_target_plan_source_decision": _bounded_hpairs_target(
                candidate_id="cand-runtime-lineage",
                hypothesis_id="H-RUNTIME-LINEAGE",
                runtime_strategy_name="intraday-tsmom-profit-v3",
                source_decision_mode="bounded_paper_route_collection",
                profit_proof_eligible=True,
                source_manifest_ref="runtime-ledger-source-window",
            ),
        }
    )

    capped = pipeline._paper_route_probe_capped_decision(
        decision=decision,
        proof_floor={"capital_state": "shadow"},
        context={
            "max_notional": "250",
            "source_decision_mode": "bounded_paper_route_collection",
            "profit_proof_eligible": True,
            "target_source_authorized": True,
        },
    )

    assert capped is not None
    assert capped.qty == Decimal("2.5000")
    params = capped.params
    assert params["candidate_id"] == "cand-runtime-lineage"
    assert params["hypothesis_id"] == "H-RUNTIME-LINEAGE"
    assert params["runtime_strategy_name"] == "intraday-tsmom-profit-v3"
    assert params["source_candidate_ids"] == ["cand-runtime-lineage"]
    assert params["source_hypothesis_ids"] == ["H-RUNTIME-LINEAGE"]
    assert "intraday-tsmom-profit-v3" in params["source_strategy_names"]
    assert params["source_decision_mode"] == "bounded_paper_route_collection"
    assert params["profit_proof_eligible"] is True
    assert params["source_manifest_ref"] == "runtime-ledger-source-window"


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
            paper_route_probe_symbol_quantities={"AAPL": "2", "AMZN": "1"},
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
        assert {decision.symbol: decision.qty for decision in decisions} == {
            "AAPL": Decimal("2"),
            "AMZN": Decimal("1"),
        }
        for decision in decisions:
            metadata = decision.params["paper_route_target_plan_source_decision"]
            assert metadata["paper_route_probe_symbol_quantities"] == {
                "AAPL": "2",
                "AMZN": "1",
            }
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
