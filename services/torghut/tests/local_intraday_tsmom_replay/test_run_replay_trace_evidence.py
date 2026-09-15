from __future__ import annotations

from dataclasses import replace

from app.trading.economic_policy import load_economic_policy
from scripts.intraday_tsmom_replay.ledger import _build_replay_ledger_context

from tests.local_intraday_tsmom_replay.support import (
    datetime,
    timezone,
    Decimal,
    Path,
    patch,
    TransactionCostModel,
    GateTrace,
    StrategyTrace,
    ThresholdTrace,
    Strategy,
    SignalEnvelope,
    StrategyDecision,
    build_runtime_ledger_buckets,
    ReplayConfig,
    run_replay,
    _TestLocalIntradayTsmomReplayBase,
)


class TestRunReplayTraceEvidence(_TestLocalIntradayTsmomReplayBase):
    def test_replay_cost_hash_changes_with_fee_rounding(self) -> None:
        policy = load_economic_policy()
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
        )
        default_context = _build_replay_ledger_context(
            config=config,
            cost_model=TransactionCostModel(policy.cost_model_config()),
            economic_policy=policy,
        )
        finer_rounding_context = _build_replay_ledger_context(
            config=config,
            cost_model=TransactionCostModel(
                replace(
                    policy.cost_model_config(),
                    regulatory_fee_rounding_increment=Decimal("0.001"),
                )
            ),
            economic_policy=policy,
        )

        self.assertNotEqual(
            default_context.cost_model_hash,
            finer_rounding_context.cost_model_hash,
        )
        self.assertNotEqual(
            default_context.cost_lineage_hash,
            finer_rounding_context.cost_lineage_hash,
        )

    def test_run_replay_emits_trace_funnel_and_near_misses(self) -> None:
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

        signal_open = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("99.95"),
                "imbalance_bid_px": Decimal("99.90"),
                "imbalance_ask_px": Decimal("100.00"),
                "imbalance_bid_sz": Decimal("60"),
                "imbalance_ask_sz": Decimal("40"),
                "spread": Decimal("0.10"),
            },
        )
        signal_fill = SignalEnvelope(
            event_ts=datetime(2026, 3, 26, 17, 31, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": Decimal("99.45"),
                "imbalance_bid_px": Decimal("99.40"),
                "imbalance_ask_px": Decimal("99.50"),
                "imbalance_bid_sz": Decimal("70"),
                "imbalance_ask_sz": Decimal("50"),
                "spread": Decimal("0.10"),
            },
        )
        signal_follow = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 17, 30, 0, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=3,
            payload={
                "price": Decimal("101.50"),
                "imbalance_bid_px": Decimal("101.40"),
                "imbalance_ask_px": Decimal("101.50"),
                "imbalance_bid_sz": Decimal("80"),
                "imbalance_ask_sz": Decimal("60"),
                "spread": Decimal("0.10"),
            },
        )

        decision_one = StrategyDecision(
            strategy_id=decision_strategy_id,
            symbol="AAPL",
            event_ts=signal_open.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("2"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("99.00"),
            rationale="candidate_one",
            params={},
        )
        decision_two = StrategyDecision(
            strategy_id="replacement-strategy",
            symbol="AAPL",
            event_ts=signal_open.event_ts,
            timeframe="1Sec",
            action="buy",
            qty=Decimal("2"),
            order_type="limit",
            time_in_force="day",
            limit_price=Decimal("99.50"),
            rationale="candidate_two",
            params={},
        )

        passed_trace = StrategyTrace(
            strategy_id="replacement-strategy",
            strategy_type="breakout_continuation_long",
            symbol="AAPL",
            event_ts=signal_open.event_ts.isoformat(),
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
        failed_trace = StrategyTrace(
            strategy_id="late-day-blocked",
            strategy_type="late_day_continuation_long",
            symbol="AAPL",
            event_ts=signal_fill.event_ts.isoformat(),
            timeframe="1Sec",
            passed=False,
            action=None,
            first_failed_gate="feed_quality",
            gates=(
                GateTrace(
                    gate="feed_quality",
                    category="feed_quality",
                    passed=False,
                    thresholds=(
                        ThresholdTrace(
                            metric="recent_quote_invalid_ratio",
                            comparator="max_lte",
                            value=Decimal("0.22"),
                            threshold=Decimal("0.10"),
                            passed=False,
                            missing_policy="fail_closed",
                            distance_to_pass=Decimal("0.12"),
                        ),
                    ),
                ),
            ),
        )

        class _Engine:
            def __init__(self, *args: object, **kwargs: object) -> None:
                _ = args
                _ = kwargs
                self._call_index = 0

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
                self._call_index += 1
                if self._call_index == 1:
                    return [decision_one, decision_two]
                return []

            def consume_runtime_telemetry(self) -> object:
                if self._call_index == 1:
                    traces = [passed_trace]
                elif self._call_index == 2:
                    traces = [failed_trace]
                else:
                    traces = []
                return type("Telemetry", (), {"traces": traces})()

        class _Allocator:
            def allocate(
                self, raw_decisions: list[StrategyDecision], **kwargs: object
            ) -> list[object]:
                _ = kwargs
                return [
                    type(
                        "AllocationResult", (), {"approved": True, "decision": decision}
                    )()
                    for decision in raw_decisions
                ]

        class _Sizer:
            def size(self, decision: StrategyDecision, **kwargs: object) -> object:
                _ = kwargs
                return type(
                    "SizingResult", (), {"approved": True, "decision": decision}
                )()

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
            capture_traces=True,
            capture_exact_replay_ledger=True,
        )

        with (
            patch(
                "scripts.intraday_tsmom_replay.replay_state._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_loop._iter_signal_rows",
                return_value=iter([signal_open, signal_fill, signal_follow]),
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_state.DecisionEngine",
                _Engine,
            ),
            patch(
                "scripts.intraday_tsmom_replay.runtime_evaluation.allocator_from_settings",
                return_value=_Allocator(),
            ),
            patch(
                "scripts.intraday_tsmom_replay.runtime_evaluation.sizer_from_settings",
                return_value=_Sizer(),
            ),
        ):
            payload = run_replay(config)

        self.assertEqual(payload["start_date"], "2026-03-26")
        self.assertEqual(payload["end_date"], "2026-03-27")
        self.assertEqual(len(payload["trace"]), 2)
        self.assertEqual(payload["trace"][0]["fill_status"], "pending")
        self.assertEqual(payload["trace"][1]["block_reason"], "feed_quality")
        self.assertEqual(payload["near_misses"][0]["first_failed_gate"], "feed_quality")
        self.assertEqual(
            payload["funnel"]["schema_version"], "torghut.replay-funnel.v1"
        )
        self.assertEqual(payload["funnel"]["buckets"][0]["trading_day"], "2026-03-26")
        self.assertGreaterEqual(payload["filled_count"], 2)
        lifecycle = payload["order_lifecycle"]
        self.assertEqual(lifecycle["submitted_order_count"], 2)
        self.assertEqual(lifecycle["filled_order_count"], 1)
        self.assertEqual(lifecycle["pending_censored_count"], 1)
        self.assertEqual(lifecycle["replaced_pending_count"], 1)
        self.assertTrue(lifecycle["fill_survival_evidence_present"])
        self.assertEqual(lifecycle["fill_survival_sample_count"], 2)
        self.assertEqual(lifecycle["fill_rate"], "0.5")
        self.assertEqual(lifecycle["fill_time_ms_p50"], 60000)
        self.assertEqual(
            lifecycle["fill_probability_by_latency_bucket"][">1000ms"]["fill_rate"], "1"
        )
        self.assertEqual(
            lifecycle["fill_probability_by_latency_threshold_ms"]["250"]["fill_rate"],
            "0",
        )
        self.assertEqual(
            lifecycle["censor_reason_counts"],
            {"pending_replaced": 1},
        )
        self.assertEqual(
            Decimal(str(lifecycle["depth_notional_min_at_order"])),
            Decimal("9994.00"),
        )
        self.assertEqual(
            Decimal(str(lifecycle["order_qty_to_touch_qty_ratio_p95"])),
            Decimal("0.05"),
        )
        self.assertEqual(
            Decimal(str(lifecycle["queue_touch_qty_avg"])),
            Decimal("40"),
        )
        self.assertEqual(
            Decimal(str(lifecycle["queue_touch_notional_avg"])),
            Decimal("4000.00"),
        )
        self.assertEqual(
            payload["order_lifecycle_by_day"]["2026-03-26"]["submitted_order_count"],
            2,
        )
        self.assertEqual(
            payload["order_lifecycle_by_symbol"]["AAPL"]["filled_order_count"],
            1,
        )
        self.assertEqual(
            lifecycle["post_cost_survivorship"]["closed_trade_count"],
            1,
        )
        exact_ledger = payload["exact_replay_ledger"]
        self.assertEqual(
            exact_ledger["schema_version"], "torghut.exact_replay_ledger.rows.v1"
        )
        self.assertEqual(exact_ledger["stage"], "replay")
        self.assertEqual(
            exact_ledger["promotion_authority"], "replay_artifact_only_not_live"
        )
        self.assertTrue(str(exact_ledger["candidate_id"]).startswith("exact-replay-"))
        self.assertEqual(
            exact_ledger["candidate_identity"]["candidate_id"],
            exact_ledger["candidate_id"],
        )
        self.assertEqual(
            exact_ledger["candidate_identity"]["candidate_identity_hash"],
            exact_ledger["candidate_identity_hash"],
        )
        self.assertEqual(
            exact_ledger["cost_lineage"]["cost_lineage_hash"],
            exact_ledger["cost_lineage_hash"],
        )
        self.assertEqual(
            exact_ledger["cost_lineage"]["warning_contract"],
            ["missing_adv", "participation_exceeds_max"],
        )
        self.assertEqual(
            exact_ledger["cost_lineage"]["config"]["regulatory_fee_rounding_increment"],
            "0.01",
        )
        self.assertEqual(exact_ledger["decision_row_count"], 3)
        self.assertEqual(exact_ledger["submitted_order_row_count"], 3)
        self.assertEqual(exact_ledger["fill_row_count"], 2)
        rows = exact_ledger["runtime_ledger_rows"]
        self.assertEqual(
            [row["event_type"] for row in rows],
            [
                "decision",
                "order_submitted",
                "order_cancelled",
                "decision",
                "order_submitted",
                "fill",
                "decision",
                "order_submitted",
                "fill",
            ],
        )
        fill_rows = [row for row in rows if row["event_type"] == "fill"]
        self.assertEqual(
            [row["candidate_identity_hash"] for row in fill_rows],
            [exact_ledger["candidate_identity_hash"]] * 2,
        )
        self.assertEqual(
            [row["cost_lineage_hash"] for row in fill_rows],
            [exact_ledger["cost_lineage_hash"]] * 2,
        )
        self.assertEqual(
            exact_ledger["cost_lineage"]["capacity_warning_counts"],
            {"missing_adv": 2},
        )
        self.assertEqual(
            [row["capacity_warning_codes"] for row in fill_rows],
            [["missing_adv"], ["missing_adv"]],
        )
        ledger_bucket = build_runtime_ledger_buckets(
            rows,
            bucket_ranges=[
                (
                    datetime(2026, 3, 26, 17, 0, tzinfo=timezone.utc),
                    datetime(2026, 3, 26, 21, 0, tzinfo=timezone.utc),
                )
            ],
            require_order_lifecycle=True,
        )[0]
        self.assertEqual(ledger_bucket.fill_count, 2)
        self.assertEqual(ledger_bucket.closed_trade_count, 1)
        self.assertNotIn("unclosed_position", ledger_bucket.blockers)
        self.assertNotIn("cost_model_hash_missing", ledger_bucket.blockers)
        self.assertNotIn("unfilled_order_present", ledger_bucket.blockers)

    def test_run_replay_enriches_day_two_open_with_prev_day_open45_ranks(self) -> None:
        strategy = Strategy(
            name="observer",
            description=None,
            enabled=True,
            base_timeframe="1Sec",
            universe_type="static",
            universe_symbols=["AAPL", "META"],
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
        observed_signals: list[SignalEnvelope] = []

        day_one_aapl_open = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 13, 30, 1, tzinfo=timezone.utc),
            symbol="AAPL",
            timeframe="1Sec",
            seq=1,
            payload={
                "price": Decimal("100"),
                "imbalance_bid_px": Decimal("99.95"),
                "imbalance_ask_px": Decimal("100.05"),
                "imbalance_bid_sz": Decimal("100"),
                "imbalance_ask_sz": Decimal("100"),
                "spread": Decimal("0.10"),
            },
        )
        day_one_meta_open = SignalEnvelope(
            event_ts=datetime(2026, 3, 27, 13, 30, 1, tzinfo=timezone.utc),
            symbol="META",
            timeframe="1Sec",
            seq=2,
            payload={
                "price": Decimal("100"),
                "imbalance_bid_px": Decimal("99.95"),
                "imbalance_ask_px": Decimal("100.05"),
                "imbalance_bid_sz": Decimal("100"),
                "imbalance_ask_sz": Decimal("100"),
                "spread": Decimal("0.10"),
            },
        )
        day_one_aapl_45 = day_one_aapl_open.model_copy(
            update={
                "event_ts": datetime(2026, 3, 27, 14, 15, 0, tzinfo=timezone.utc),
                "seq": 3,
                "payload": {
                    **day_one_aapl_open.payload,
                    "price": Decimal("105"),
                    "imbalance_bid_px": Decimal("104.95"),
                    "imbalance_ask_px": Decimal("105.05"),
                },
            }
        )
        day_one_meta_45 = day_one_meta_open.model_copy(
            update={
                "event_ts": datetime(2026, 3, 27, 14, 15, 0, tzinfo=timezone.utc),
                "seq": 4,
                "payload": {
                    **day_one_meta_open.payload,
                    "price": Decimal("95"),
                    "imbalance_bid_px": Decimal("94.95"),
                    "imbalance_ask_px": Decimal("95.05"),
                },
            }
        )
        day_two_aapl_open = day_one_aapl_open.model_copy(
            update={
                "event_ts": datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc),
                "seq": 5,
            }
        )
        day_two_meta_open = day_one_meta_open.model_copy(
            update={
                "event_ts": datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc),
                "seq": 6,
            }
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
                _ = strategies
                _ = equity
                _ = positions
                observed_signals.append(signal)
                return []

            def consume_runtime_telemetry(self) -> object:
                return type("Telemetry", (), {"traces": []})()

        class _Allocator:
            def allocate(
                self, raw_decisions: list[StrategyDecision], **kwargs: object
            ) -> list[object]:
                _ = raw_decisions
                _ = kwargs
                return []

        config = ReplayConfig(
            strategy_configmap_path=Path("/tmp/strategies.yaml"),
            clickhouse_http_url="http://example.invalid:8123",
            clickhouse_username=None,
            clickhouse_password=None,
            start_date=datetime(2026, 3, 27, tzinfo=timezone.utc).date(),
            end_date=datetime(2026, 3, 30, tzinfo=timezone.utc).date(),
            chunk_minutes=10,
            flatten_eod=True,
            start_equity=Decimal("10000"),
            capture_traces=False,
        )

        with (
            patch(
                "scripts.intraday_tsmom_replay.replay_state._load_strategies",
                return_value=[strategy],
            ),
            patch(
                "scripts.intraday_tsmom_replay.replay_loop._iter_signal_rows",
                return_value=iter(
                    [
                        day_one_aapl_open,
                        day_one_meta_open,
                        day_one_aapl_45,
                        day_one_meta_45,
                        day_two_aapl_open,
                        day_two_meta_open,
                    ]
                ),
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
            run_replay(config)

        aapl_day_two = next(
            signal
            for signal in observed_signals
            if signal.symbol == "AAPL"
            and signal.event_ts == datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc)
        )
        meta_day_two = next(
            signal
            for signal in observed_signals
            if signal.symbol == "META"
            and signal.event_ts == datetime(2026, 3, 30, 13, 30, 1, tzinfo=timezone.utc)
        )

        self.assertEqual(
            aapl_day_two.payload["cross_section_prev_day_open45_return_rank"],
            Decimal("1"),
        )
        self.assertEqual(
            meta_day_two.payload["cross_section_prev_day_open45_return_rank"],
            Decimal("0"),
        )

    def test_run_replay_marks_passed_trace_with_sizer_reject_reason(self) -> None:
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
                        "AllocationResult", (), {"approved": True, "decision": decision}
                    )()
                ]

        class _Sizer:
            def size(self, decision: StrategyDecision, **kwargs: object) -> object:
                _ = decision
                _ = kwargs
                return type(
                    "SizingResult",
                    (),
                    {"approved": False, "decision": decision, "reasons": []},
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
            patch(
                "scripts.intraday_tsmom_replay.runtime_evaluation.allocator_from_settings",
                return_value=_Allocator(),
            ),
            patch(
                "scripts.intraday_tsmom_replay.runtime_evaluation.sizer_from_settings",
                return_value=_Sizer(),
            ),
        ):
            payload = run_replay(config)

        self.assertEqual(len(payload["trace"]), 1)
        self.assertTrue(payload["trace"][0]["strategy_trace"]["passed"])
        self.assertFalse(payload["trace"][0]["decision_emitted"])
        self.assertEqual(payload["trace"][0]["fill_status"], "none")
        self.assertEqual(payload["trace"][0]["block_reason"], "sizer_rejected")
