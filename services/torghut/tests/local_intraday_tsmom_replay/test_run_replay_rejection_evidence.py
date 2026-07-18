from __future__ import annotations

from app.trading.economic_policy import EconomicPolicyError

from tests.local_intraday_tsmom_replay.support import (
    datetime,
    timezone,
    Decimal,
    Path,
    patch,
    GateTrace,
    StrategyTrace,
    Strategy,
    SignalEnvelope,
    StrategyDecision,
    ReplayConfig,
    run_replay,
    _TestLocalIntradayTsmomReplayBase,
)


class TestRunReplayRejectionEvidence(_TestLocalIntradayTsmomReplayBase):
    def test_run_replay_rejects_an_economic_policy_digest_mismatch(self) -> None:
        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            economic_policy_expected_digest="sha256:" + "0" * 64,
        )

        with self.assertRaisesRegex(
            EconomicPolicyError, "economic_policy_digest_mismatch"
        ):
            run_replay(config)

    def test_run_replay_marks_passed_trace_with_allocator_reject_reason(self) -> None:
        strategy = Strategy(
            name="breakout-continuation-long-v1",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        decision_strategy_id = str(strategy.id)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("99.95"),
                "imbalance_bid_px": Decimal("99.90"),
                "imbalance_ask_px": Decimal("100.00"),
                "spread": Decimal("0.10"),
            },
        )
        decision = StrategyDecision(
            strategy_id=decision_strategy_id,
            symbol="AAPL",
            event_ts=signal.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("2"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("99.00"),
            rationale="candidate_one",
            params={},
        )
        passed_trace = StrategyTrace(
            strategy_id=decision_strategy_id,
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts=signal.event_ts.isoformat(),
            timeframe="1Sec",
            passed=True,
            action="buy",
            gates=(
                GateTrace(
                    gate="eligibility",
                    category="eligibility",
                    passed=True,
                    thresholds=(),
                ),
            ),
        )

        class _Engine:
            def __init__(self, *args: object, **kwargs: object) -> None:
                _ = args
                _ = kwargs

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self,
                signal: SignalEnvelope,
                strategies: object,
                *,
                equity: object,
                positions: object,
            ) -> list[StrategyDecision]:
                _ = signal
                _ = strategies
                _ = equity
                _ = positions
                return [decision]

            def consume_runtime_telemetry(self) -> object:
                return type("Telemetry", (), {"traces": [passed_trace]})()

        class _Allocator:
            def allocate(
                self, raw_decisions: list[StrategyDecision], **kwargs: object
            ) -> list[object]:
                _ = raw_decisions
                _ = kwargs
                return [
                    type(
                        "AllocationResult",
                        (),
                        {
                            "approved": False,
                            "decision": decision,
                            "reason_codes": ("allocator_reject_symbol_capacity",),
                        },
                    )()
                ]

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=True,
        )

        with (
            patch(
                "scripts.intraday_tsmom_replay.replay_state._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_loop._iter_signal_rows",
                return_value=iter([signal]),
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_state.DecisionEngine",
                _Engine,
            ),
            patch(
                "scripts.intraday_tsmom_replay.runtime_evaluation.allocator_from_settings",
                return_value=_Allocator(),
            ),
        ):
            payload = run_replay(config)

        self.assertEqual(len(payload["trace"]), 1)
        self.assertEqual(
            payload["trace"][0]["block_reason"], "allocator_reject_symbol_capacity"
        )

    def test_run_replay_marks_passed_trace_with_runtime_suppression_reason(
        self,
    ) -> None:
        strategy = Strategy(
            name="breakout-continuation-long-v1",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        decision_strategy_id = str(strategy.id)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("99.95"),
                "imbalance_bid_px": Decimal("99.90"),
                "imbalance_ask_px": Decimal("100.00"),
                "spread": Decimal("0.10"),
            },
        )
        passed_trace = StrategyTrace(
            strategy_id=decision_strategy_id,
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts=signal.event_ts.isoformat(),
            timeframe="1Sec",
            passed=True,
            action="buy",
            gates=(
                GateTrace(
                    gate="eligibility",
                    category="eligibility",
                    passed=True,
                    thresholds=(),
                ),
            ),
        )

        class _Engine:
            def __init__(self, *args: object, **kwargs: object) -> None:
                _ = args
                _ = kwargs

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self,
                signal: SignalEnvelope,
                strategies: object,
                *,
                equity: object,
                positions: object,
            ) -> list[StrategyDecision]:
                _ = signal
                _ = strategies
                _ = equity
                _ = positions
                return []

            def consume_runtime_telemetry(self) -> object:
                observation = type(
                    "Observation",
                    (),
                    {
                        "strategy_intents_total": {decision_strategy_id},
                        "strategy_intent_suppression_total": {
                            f"{decision_strategy_id}|runtime_trade_policy_blocked": 1
                        },
                    },
                )()
                return type(
                    "Telemetry",
                    (),
                    {"traces": [passed_trace], "observation": observation},
                )()

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=True,
        )

        with (
            patch(
                "scripts.intraday_tsmom_replay.replay_state._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_loop._iter_signal_rows",
                return_value=iter([signal]),
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_state.DecisionEngine",
                _Engine,
            ),
        ):
            payload = run_replay(config)

        self.assertEqual(len(payload["trace"]), 1)
        self.assertEqual(
            payload["trace"][0]["block_reason"], "runtime_trade_policy_blocked"
        )

    def test_run_replay_serializes_real_daily_liquidity_evidence(self) -> None:
        strategy = Strategy(
            name="observer",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        signal_one = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("10.00"),
                "imbalance_bid_px": Decimal("9.995"),
                "imbalance_ask_px": Decimal("10.005"),
                "imbalance_bid_sz": Decimal("50"),
                "imbalance_ask_sz": Decimal("40"),
                "microbar_volume": Decimal("100"),
                "spread": Decimal("0.01"),
            },
        )
        signal_two = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": Decimal("11.00"),
                "imbalance_bid_px": Decimal("10.995"),
                "imbalance_ask_px": Decimal("11.005"),
                "imbalance_bid_sz": Decimal("20"),
                "imbalance_ask_sz": Decimal("10"),
                "microbar_volume": Decimal("200"),
                "spread": Decimal("0.01"),
            },
        )

        class _Engine:
            def __init__(self, *args: object, **kwargs: object) -> None:
                _ = args
                _ = kwargs

            def observe_signal(self, signal: SignalEnvelope) -> None:
                _ = signal

            def evaluate(
                self,
                signal: SignalEnvelope,
                strategies: object,
                *,
                equity: object,
                positions: object,
            ) -> list[StrategyDecision]:
                _ = signal
                _ = strategies
                _ = equity
                _ = positions
                return []

            def consume_runtime_telemetry(self) -> object:
                return type("Telemetry", (), {"traces": []})()

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 26, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=True,
        )

        with (
            patch(
                "scripts.intraday_tsmom_replay.replay_state._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_loop._iter_signal_rows",
                return_value=iter([signal_one, signal_two]),
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_state.DecisionEngine",
                _Engine,
            ),
        ):
            payload = run_replay(config)

        daily = payload["daily"]["2026-03-26"]
        self.assertEqual(Decimal(daily["daily_adv_notional"]), Decimal("3200.00"))
        self.assertEqual(Decimal(daily["depth_notional"]), Decimal("329.950"))
        self.assertEqual(daily["liquidity_observation_count"], 2)
