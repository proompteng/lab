from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.simple_pipeline.support import *


def test_pending_clean_window_baseline_still_reserves_paper_account(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        now = datetime(2026, 6, 5, 13, 45, tzinfo=timezone.utc)
        target = _bounded_hpairs_target(
            paper_route_probe_window_start="2026-06-05T13:30:00+00:00",
            paper_route_probe_window_end="2026-06-05T20:00:00+00:00",
            evidence_collection_ok=False,
            canary_collection_authorized=False,
            bounded_evidence_collection_authorized=False,
            bounded_live_paper_collection_authorized=False,
            bounded_evidence_collection_blockers=[
                "paper_route_clean_window_baseline_snapshot_pending",
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
        assert "paper_route_clean_window_baseline_snapshot_pending" in blockers
        assert pipeline._paper_route_target_plan_reserves_account(
            allowed_symbols={"NVDA", "INTC"},
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before


def test_target_runtime_account_and_window_helpers_cover_identity_edges() -> None:
    target = {
        "account_label": "OTHER",
        "account_stage_runtime_identity": {
            "account_label": "PA3SX7FYNUTF",
            "runtime_account_label": "TORGHUT_SIM",
        },
    }

    assert not _target_runtime_account_matches(target, account_label="")
    assert _target_runtime_account_matches(target, account_label="TORGHUT_SIM")
    assert not _target_active_in_window(
        target,
        datetime(2026, 6, 1, 18, 0, tzinfo=timezone.utc),
    )


def test_target_plan_fetch_error_reserves_configured_paper_account(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    target_plan_url_before = settings.trading_paper_route_target_plan_url
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_paper_route_target_plan_url = (
            "http://torghut.torghut.svc.cluster.local/trading/paper-route-target-plan"
        )
        now = datetime(2026, 6, 1, 18, 0, tzinfo=timezone.utc)
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "TORGHUT_SIM"
        pipeline.state = SimpleNamespace()
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            set(),
            "paper_route_target_plan_fetch_failed:timeout",
            [],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        assert pipeline._paper_route_target_plan_reserves_account(
            allowed_symbols={"AAPL", "AMZN"},
        )
        assert (
            pipeline.state.last_bounded_evidence_collection_blocker["reason"]
            == "paper_route_target_plan_fetch_failed:timeout"
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_paper_route_target_plan_url = target_plan_url_before


def test_target_plan_fetch_error_without_config_does_not_reserve_paper_account(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    target_plan_url_before = settings.trading_paper_route_target_plan_url
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        settings.trading_paper_route_target_plan_url = ""
        now = datetime(2026, 6, 1, 18, 0, tzinfo=timezone.utc)
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "TORGHUT_SIM"
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            set(),
            "paper_route_target_plan_fetch_failed:timeout",
            [],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        assert not pipeline._paper_route_target_plan_reserves_account(
            allowed_symbols={"AAPL", "AMZN"},
        )
    finally:
        settings.trading_mode = trading_mode_before
        settings.trading_simple_paper_route_probe_enabled = probe_enabled_before
        settings.trading_paper_route_target_plan_url = target_plan_url_before


def test_empty_target_plan_symbols_do_not_reserve_account(
    monkeypatch,
) -> None:
    trading_mode_before = settings.trading_mode
    probe_enabled_before = settings.trading_simple_paper_route_probe_enabled
    try:
        settings.trading_mode = "paper"
        settings.trading_simple_paper_route_probe_enabled = True
        now = datetime(2026, 6, 1, 18, 0, tzinfo=timezone.utc)
        pipeline = object.__new__(SimpleTradingPipeline)
        pipeline.account_label = "TORGHUT_SIM"
        pipeline._is_market_session_open = lambda _now: True
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
            set(),
            None,
            [],
        )
        monkeypatch.setattr(
            "app.trading.scheduler.simple_pipeline.trading_now",
            lambda account_label=None: now,
        )

        assert not pipeline._paper_route_target_plan_reserves_account(
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
        pipeline._external_paper_route_target_probe_symbols_cached = lambda **_kwargs: (
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
