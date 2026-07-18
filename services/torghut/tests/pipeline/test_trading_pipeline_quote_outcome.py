from __future__ import annotations

from tests.pipeline.trading_pipeline_base import (
    Decimal,
    DecisionEngine,
    FakeAlpacaClient,
    FakeIngestor,
    FakePriceFetcher,
    Mapping,
    MarketSnapshot,
    OrderExecutor,
    OrderFirewall,
    Reconciler,
    RejectedSignalOutcomeEvent,
    RiskEngine,
    SQLAlchemyError,
    Session,
    SignalEnvelope,
    TimelinePriceFetcher,
    TradingPipeline,
    TradingPipelineTestCaseBase,
    TradingState,
    UniverseResolver,
    build_hypothesis_runtime_summary,
    cast,
    datetime,
    select,
    timedelta,
    timezone,
)


class TestTradingPipelineQuoteOutcome(TradingPipelineTestCaseBase):
    def test_ensure_signal_executable_price_backfills_missing_quote_from_snapshot(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("101.50"),
                spread=Decimal("0.02"),
                bid=Decimal("101.49"),
                ask=Decimal("101.51"),
            ),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "price": Decimal("101.50"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Min",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("price"), Decimal("101.50"))
        self.assertEqual(enriched.payload.get("imbalance_bid_px"), Decimal("101.49"))
        self.assertEqual(enriched.payload.get("imbalance_ask_px"), Decimal("101.51"))
        self.assertEqual(enriched.payload.get("spread"), Decimal("0.02"))
        self.assertTrue(pipeline._signal_quote_quality.assess(enriched).valid)

    def test_ensure_signal_executable_price_replaces_feature_price_when_quote_is_backfilled(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("117.36"),
                spread=Decimal("0.40"),
                bid=Decimal("117.10"),
                ask=Decimal("117.50"),
            ),
        )
        pipeline._signal_quote_quality.assess(
            SignalEnvelope(
                event_ts=datetime(2026, 1, 1, 14, 30, tzinfo=timezone.utc),
                symbol="INTC",
                payload={
                    "price": Decimal("117.20"),
                    "spread": Decimal("0.10"),
                    "imbalance_bid_px": Decimal("117.15"),
                    "imbalance_ask_px": Decimal("117.25"),
                },
                timeframe="1Sec",
            )
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="INTC",
            payload={
                "price": Decimal("83.00"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Sec",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("price"), Decimal("117.36"))
        self.assertEqual(enriched.payload.get("imbalance_bid_px"), Decimal("117.10"))
        self.assertEqual(enriched.payload.get("imbalance_ask_px"), Decimal("117.50"))
        self.assertTrue(pipeline._signal_quote_quality.assess(enriched).valid)

    def test_ensure_signal_executable_price_replaces_stale_spread_when_quote_is_backfilled(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("100.00"),
                spread=Decimal("0.02"),
                bid=Decimal("99.99"),
                ask=Decimal("100.01"),
            ),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="NVDA",
            payload={
                "price": Decimal("100.00"),
                "spread": Decimal("1.00"),
                "spread_bps": Decimal("100"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Sec",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("spread"), Decimal("0.02"))
        self.assertEqual(enriched.payload.get("spread_bps"), Decimal("2.00"))
        self.assertEqual(enriched.payload.get("imbalance_spread"), Decimal("0.02"))
        self.assertEqual(enriched.payload.get("imbalance_bid_px"), Decimal("99.99"))
        self.assertEqual(enriched.payload.get("imbalance_ask_px"), Decimal("100.01"))
        self.assertTrue(pipeline._signal_quote_quality.assess(enriched).valid)

    def test_ensure_signal_executable_price_replaces_wide_embedded_quote_with_snapshot(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(
                Decimal("308.20"),
                spread=Decimal("0.02"),
                bid=Decimal("308.19"),
                ask=Decimal("308.21"),
            ),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "price": Decimal("308.21"),
                "spread": Decimal("5.98"),
                "spread_bps": Decimal("194.02355537"),
                "imbalance_bid_px": Decimal("305.22"),
                "imbalance_ask_px": Decimal("311.20"),
                "imbalance_spread": Decimal("5.98"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Sec",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("price"), Decimal("308.20"))
        self.assertEqual(enriched.payload.get("spread"), Decimal("0.02"))
        self.assertEqual(
            enriched.payload.get("spread_bps"),
            Decimal("0.6489292667099286177806619079"),
        )
        self.assertEqual(enriched.payload.get("imbalance_spread"), Decimal("0.02"))
        self.assertEqual(enriched.payload.get("imbalance_bid_px"), Decimal("308.19"))
        self.assertEqual(enriched.payload.get("imbalance_ask_px"), Decimal("308.21"))
        self.assertTrue(pipeline._signal_quote_quality.assess(enriched).valid)

    def test_ensure_signal_executable_price_backfills_missing_price_from_snapshot(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("101.50")),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Min",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertEqual(enriched.payload.get("price"), Decimal("101.50"))

    def test_ensure_signal_executable_price_returns_original_when_snapshot_adds_nothing(
        self,
    ) -> None:
        alpaca_client = FakeAlpacaClient()
        pipeline = TradingPipeline(
            alpaca_client=alpaca_client,
            order_firewall=OrderFirewall(alpaca_client),
            ingestor=FakeIngestor([]),
            decision_engine=DecisionEngine(),
            risk_engine=RiskEngine(),
            executor=OrderExecutor(),
            execution_adapter=alpaca_client,
            reconciler=Reconciler(),
            universe_resolver=UniverseResolver(),
            state=TradingState(),
            account_label="paper",
            session_factory=self.session_local,
            price_fetcher=FakePriceFetcher(Decimal("101.50")),
        )
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "price": Decimal("101.50"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            timeframe="1Min",
        )

        enriched = pipeline._ensure_signal_executable_price(signal)

        self.assertIs(enriched, signal)

    def test_quote_quality_rejection_records_outcome_learning_event(self) -> None:
        state = TradingState()
        pipeline = self._build_rejected_outcome_pipeline(state=state)
        signal = SignalEnvelope(
            event_ts=datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc),
            symbol="AAPL",
            payload={
                "price": Decimal("101.50"),
                "macd": {"macd": Decimal("1.1"), "signal": Decimal("0.4")},
            },
            seq=42,
            timeframe="1Min",
        )

        decisions = pipeline._evaluate_signal_decisions(
            signal,
            [],
            equity=Decimal("100000"),
            positions=[],
        )

        self.assertEqual(decisions, [])
        self.assertEqual(state.metrics.rejected_signal_events_total, 1)
        self.assertEqual(state.metrics.rejected_signal_outcome_label_pending_total, 1)
        self.assertEqual(
            state.metrics.rejected_signal_reason_total,
            {"missing_executable_quote": 1},
        )
        assert state.last_rejected_signal_outcome_event is not None
        self.assertEqual(
            state.last_rejected_signal_outcome_event["schema_version"],
            "torghut.rejected-signal-outcome-event.v1",
        )
        self.assertEqual(
            state.last_rejected_signal_outcome_event["paper_claim_id"],
            "rejection-event-outcome-labels",
        )
        self.assertEqual(
            state.last_rejected_signal_outcome_event["reject_reason"],
            "missing_executable_quote",
        )
        self.assertEqual(
            state.last_rejected_signal_outcome_event["required_outcome_fields"],
            [
                "counterfactual_return",
                "route_tca",
                "post_cost_net_pnl",
                "executable_quote",
            ],
        )
        with self.session_local() as session:
            rows = list(session.execute(select(RejectedSignalOutcomeEvent)).scalars())

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].paper_claim_id, "rejection-event-outcome-labels")
        self.assertEqual(rows[0].reject_reason, "missing_executable_quote")
        self.assertEqual(rows[0].outcome_label_status, "pending")
        self.assertEqual(
            rows[0].required_outcome_fields_json,
            [
                "counterfactual_return",
                "route_tca",
                "post_cost_net_pnl",
                "executable_quote",
            ],
        )

    def test_rejected_signal_outcome_persistence_skips_unusable_payloads(self) -> None:
        pipeline = self._build_rejected_outcome_pipeline()

        pipeline._persist_rejected_signal_outcome_event(
            {
                "event_ts": "2026-01-01T14:31:00+00:00",
                "symbol": "AAPL",
            }
        )
        pipeline._persist_rejected_signal_outcome_event(
            {
                "event_id": "reject-event-invalid-ts",
                "event_ts": None,
                "symbol": "AAPL",
            }
        )

        with self.session_local() as session:
            rows = list(session.execute(select(RejectedSignalOutcomeEvent)).scalars())

        self.assertEqual(rows, [])

    def test_rejected_signal_outcome_persistence_updates_existing_event(self) -> None:
        pipeline = self._build_rejected_outcome_pipeline()
        event_ts = "2026-01-01T14:31:00+00:00"

        pipeline._persist_rejected_signal_outcome_event(
            {
                "event_id": "reject-event-1",
                "source": "quote_quality_gate",
                "paper_source": "paper-arxiv-2605.12151",
                "paper_claim_id": "rejection-event-outcome-labels",
                "account_label": "paper",
                "symbol": "aapl",
                "event_ts": event_ts,
                "timeframe": "1Min",
                "seq": 42,
                "reject_reason": "missing_executable_quote",
                "spread_bps": "55.5",
                "jump_bps": None,
                "outcome_label_status": "pending",
                "counterfactual_required": True,
                "required_outcome_fields": ["counterfactual_return"],
            }
        )
        pipeline._persist_rejected_signal_outcome_event(
            {
                "event_id": "reject-event-1",
                "source": "quote_quality_gate",
                "paper_source": "paper-arxiv-2605.12151",
                "paper_claim_id": "rejection-event-outcome-labels",
                "account_label": "paper",
                "symbol": "AAPL",
                "event_ts": event_ts,
                "timeframe": "1Min",
                "seq": 42,
                "reject_reason": "wide_spread",
                "spread_bps": "60.25",
                "jump_bps": "4.5",
                "outcome_label_status": "pending",
                "counterfactual_required": True,
                "required_outcome_fields": ["counterfactual_return"],
            }
        )

        with self.session_local() as session:
            rows = list(session.execute(select(RejectedSignalOutcomeEvent)).scalars())

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].reject_reason, "wide_spread")
        self.assertEqual(rows[0].spread_bps, Decimal("60.25"))
        self.assertEqual(rows[0].jump_bps, Decimal("4.5"))
        self.assertEqual(rows[0].event_payload_json["reject_reason"], "wide_spread")

    def test_rejected_signal_outcome_labeler_labels_mature_complete_event(
        self,
    ) -> None:
        event_ts = datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc)
        followup_ts = event_ts + timedelta(minutes=5)
        pipeline = self._build_rejected_outcome_pipeline(
            price_fetcher=TimelinePriceFetcher(
                {
                    event_ts: MarketSnapshot(
                        symbol="AAPL",
                        as_of=event_ts,
                        price=Decimal("100.00"),
                        spread=Decimal("0.02"),
                        source="test-entry",
                        bid=Decimal("99.99"),
                        ask=Decimal("100.01"),
                    ),
                    followup_ts: MarketSnapshot(
                        symbol="AAPL",
                        as_of=followup_ts,
                        price=Decimal("101.00"),
                        spread=Decimal("0.02"),
                        source="test-followup",
                        bid=Decimal("100.99"),
                        ask=Decimal("101.01"),
                    ),
                }
            )
        )
        with self.session_local() as session:
            session.add(
                RejectedSignalOutcomeEvent(
                    event_id="reject-event-mature",
                    source="quote_quality_gate",
                    paper_source="ssrn-6607301",
                    paper_claim_id="post-rejection-follow-up-sampling",
                    account_label="paper",
                    symbol="AAPL",
                    event_ts=event_ts,
                    timeframe="1Min",
                    seq="42",
                    reject_reason="missing_executable_quote",
                    outcome_label_status="pending",
                    counterfactual_required=True,
                    required_outcome_fields_json=[
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                        "executable_quote",
                    ],
                    event_payload_json={
                        "event_id": "reject-event-mature",
                        "candidate_spec_id": "spec-feedback",
                        "family_template_id": "breakout_continuation_v1",
                        "runtime_strategy_name": "breakout-continuation-long-v1",
                        "signal_payload": {"price": "100.00"},
                    },
                    outcome_payload_json=None,
                )
            )
            session.commit()

        pipeline.label_mature_rejected_signal_outcomes(
            now=followup_ts + timedelta(seconds=1)
        )

        with self.session_local() as session:
            row = session.execute(select(RejectedSignalOutcomeEvent)).scalar_one()

        self.assertEqual(row.outcome_label_status, "labeled")
        outcome = row.outcome_payload_json
        self.assertEqual(outcome["counterfactual_return"], "0.01")
        self.assertEqual(outcome["post_cost_net_pnl"], "0.99")
        self.assertEqual(outcome["executable_quote"]["bid"], "99.99")
        self.assertEqual(outcome["route_tca"]["horizon_seconds"], "300")
        self.assertNotIn("promotion_readiness", outcome)
        self.assertEqual(outcome["candidate_spec_id"], "spec-feedback")

    def test_rejected_signal_outcome_labeler_closes_read_transaction_before_quotes(
        self,
    ) -> None:
        event_ts = datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc)
        followup_ts = event_ts + timedelta(minutes=5)
        sessions: list[Session] = []

        def tracking_session_factory() -> Session:
            session = self.session_local()
            sessions.append(session)
            return session

        class TransactionCheckingPriceFetcher(TimelinePriceFetcher):
            active_transaction_seen = False

            def fetch_market_snapshot(
                self, signal: SignalEnvelope
            ) -> MarketSnapshot | None:
                self.active_transaction_seen = self.active_transaction_seen or any(
                    session.in_transaction() for session in sessions
                )
                return super().fetch_market_snapshot(signal)

        price_fetcher = TransactionCheckingPriceFetcher(
            {
                event_ts: MarketSnapshot(
                    symbol="AAPL",
                    as_of=event_ts,
                    price=Decimal("100.00"),
                    spread=Decimal("0.02"),
                    source="test-entry",
                    bid=Decimal("99.99"),
                    ask=Decimal("100.01"),
                ),
                followup_ts: MarketSnapshot(
                    symbol="AAPL",
                    as_of=followup_ts,
                    price=Decimal("101.00"),
                    spread=Decimal("0.02"),
                    source="test-followup",
                    bid=Decimal("100.99"),
                    ask=Decimal("101.01"),
                ),
            }
        )
        pipeline = self._build_rejected_outcome_pipeline(
            session_factory=tracking_session_factory,
            price_fetcher=price_fetcher,
        )
        with self.session_local() as session:
            session.add(
                RejectedSignalOutcomeEvent(
                    event_id="reject-event-transaction-boundary",
                    source="quote_quality_gate",
                    paper_source="ssrn-6607301",
                    paper_claim_id="post-rejection-follow-up-sampling",
                    account_label="paper",
                    symbol="AAPL",
                    event_ts=event_ts,
                    timeframe="1Min",
                    seq="42",
                    reject_reason="missing_executable_quote",
                    outcome_label_status="pending",
                    counterfactual_required=True,
                    required_outcome_fields_json=["counterfactual_return"],
                    event_payload_json={
                        "event_id": "reject-event-transaction-boundary"
                    },
                    outcome_payload_json=None,
                )
            )
            session.commit()

        pipeline.label_mature_rejected_signal_outcomes(
            now=followup_ts + timedelta(seconds=1)
        )

        self.assertFalse(price_fetcher.active_transaction_seen)
        with self.session_local() as session:
            row = session.execute(
                select(RejectedSignalOutcomeEvent).where(
                    RejectedSignalOutcomeEvent.event_id
                    == "reject-event-transaction-boundary"
                )
            ).scalar_one()
        self.assertEqual(row.outcome_label_status, "labeled")

    def test_rejected_signal_outcome_labeler_uses_captured_entry_quote(self) -> None:
        event_ts = datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc)
        followup_ts = event_ts + timedelta(minutes=5)
        pipeline = self._build_rejected_outcome_pipeline(
            price_fetcher=TimelinePriceFetcher(
                {
                    followup_ts: MarketSnapshot(
                        symbol="AAPL",
                        as_of=followup_ts,
                        price=Decimal("101.00"),
                        spread=None,
                        source="test-followup",
                    )
                }
            )
        )
        with self.session_local() as session:
            session.add(
                RejectedSignalOutcomeEvent(
                    event_id="reject-event-captured-entry-quote",
                    source="quote_quality_gate",
                    paper_source="ssrn-6607301",
                    paper_claim_id="post-rejection-follow-up-sampling",
                    account_label="paper",
                    symbol="AAPL",
                    event_ts=event_ts,
                    timeframe="1Min",
                    seq="42",
                    reject_reason="spread_too_wide",
                    outcome_label_status="pending",
                    counterfactual_required=True,
                    required_outcome_fields_json=[
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                        "executable_quote",
                    ],
                    event_payload_json={
                        "event_id": "reject-event-captured-entry-quote",
                        "signal_payload": {
                            "price": "100.00",
                            "imbalance_bid_px": "99.99",
                            "imbalance_ask_px": "100.01",
                        },
                    },
                    outcome_payload_json=None,
                )
            )
            session.commit()

        pipeline.label_mature_rejected_signal_outcomes(
            now=followup_ts + timedelta(seconds=1)
        )

        with self.session_local() as session:
            row = session.execute(select(RejectedSignalOutcomeEvent)).scalar_one()

        self.assertEqual(row.outcome_label_status, "labeled")
        self.assertEqual(row.outcome_payload_json["executable_quote"]["bid"], "99.99")
        self.assertEqual(
            row.outcome_payload_json["executable_quote"]["source"],
            "rejected_signal_event",
        )

    def test_rejected_signal_outcome_labeler_keeps_missing_quote_pending(
        self,
    ) -> None:
        event_ts = datetime(2026, 1, 1, 14, 31, tzinfo=timezone.utc)
        pipeline = self._build_rejected_outcome_pipeline(
            price_fetcher=FakePriceFetcher(Decimal("100.00"))
        )
        with self.session_local() as session:
            session.add(
                RejectedSignalOutcomeEvent(
                    event_id="reject-event-incomplete",
                    source="quote_quality_gate",
                    paper_source="ssrn-6607301",
                    paper_claim_id="post-rejection-follow-up-sampling",
                    account_label="paper",
                    symbol="AAPL",
                    event_ts=event_ts,
                    timeframe="1Min",
                    seq="42",
                    reject_reason="missing_executable_quote",
                    outcome_label_status="pending",
                    counterfactual_required=True,
                    required_outcome_fields_json=[
                        "counterfactual_return",
                        "route_tca",
                        "post_cost_net_pnl",
                        "executable_quote",
                    ],
                    event_payload_json={"event_id": "reject-event-incomplete"},
                    outcome_payload_json=None,
                )
            )
            session.commit()

        pipeline.label_mature_rejected_signal_outcomes(
            now=event_ts + timedelta(minutes=6)
        )

        with self.session_local() as session:
            row = session.execute(select(RejectedSignalOutcomeEvent)).scalar_one()

        self.assertEqual(row.outcome_label_status, "pending")
        self.assertIsNone(row.outcome_payload_json)

    def test_rejected_signal_outcome_labeler_retries_fairly_within_account(
        self,
    ) -> None:
        foreign_event_ts = datetime(2026, 1, 1, 14, 28, tzinfo=timezone.utc)
        incomplete_event_ts = datetime(2026, 1, 1, 14, 29, tzinfo=timezone.utc)
        complete_event_ts = datetime(2026, 1, 1, 14, 30, tzinfo=timezone.utc)
        followup_ts = complete_event_ts + timedelta(minutes=5)
        first_attempt_at = datetime(2026, 1, 1, 14, 36, tzinfo=timezone.utc)
        pipeline = self._build_rejected_outcome_pipeline(
            price_fetcher=TimelinePriceFetcher(
                {
                    followup_ts: MarketSnapshot(
                        symbol="MSFT",
                        as_of=followup_ts,
                        price=Decimal("201.00"),
                        spread=None,
                        source="test-followup",
                    )
                }
            )
        )
        initial_updated_at = {
            "foreign": datetime(2026, 1, 1, 13, 1, tzinfo=timezone.utc),
            "incomplete": datetime(2026, 1, 1, 13, 2, tzinfo=timezone.utc),
            "complete": datetime(2026, 1, 1, 13, 3, tzinfo=timezone.utc),
        }
        with self.session_local() as session:
            session.add_all(
                [
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-foreign-account",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="live",
                        symbol="NVDA",
                        event_ts=foreign_event_ts,
                        timeframe="1Min",
                        seq="40",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=["counterfactual_return"],
                        event_payload_json={"event_id": "reject-event-foreign-account"},
                        outcome_payload_json=None,
                        created_at=initial_updated_at["foreign"],
                        updated_at=initial_updated_at["foreign"],
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-incomplete-oldest",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="paper",
                        symbol="AAPL",
                        event_ts=incomplete_event_ts,
                        timeframe="1Min",
                        seq="41",
                        reject_reason="missing_executable_quote",
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=["counterfactual_return"],
                        event_payload_json={
                            "event_id": "reject-event-incomplete-oldest"
                        },
                        outcome_payload_json=None,
                        created_at=initial_updated_at["incomplete"],
                        updated_at=initial_updated_at["incomplete"],
                    ),
                    RejectedSignalOutcomeEvent(
                        event_id="reject-event-complete-next",
                        source="quote_quality_gate",
                        paper_source="ssrn-6607301",
                        paper_claim_id="post-rejection-follow-up-sampling",
                        account_label="paper",
                        symbol="MSFT",
                        event_ts=complete_event_ts,
                        timeframe="1Min",
                        seq="42",
                        reject_reason="spread_too_wide",
                        outcome_label_status="pending",
                        counterfactual_required=True,
                        required_outcome_fields_json=["counterfactual_return"],
                        event_payload_json={
                            "event_id": "reject-event-complete-next",
                            "signal_payload": {
                                "price": "200.00",
                                "imbalance_bid_px": "199.99",
                                "imbalance_ask_px": "200.01",
                            },
                        },
                        outcome_payload_json=None,
                        created_at=initial_updated_at["complete"],
                        updated_at=initial_updated_at["complete"],
                    ),
                ]
            )
            session.commit()
            foreign_initial_timestamp = session.execute(
                select(RejectedSignalOutcomeEvent.updated_at).where(
                    RejectedSignalOutcomeEvent.event_id
                    == "reject-event-foreign-account"
                )
            ).scalar_one()
            incomplete_initial_timestamp = session.execute(
                select(RejectedSignalOutcomeEvent.updated_at).where(
                    RejectedSignalOutcomeEvent.event_id
                    == "reject-event-incomplete-oldest"
                )
            ).scalar_one()

        pipeline.label_mature_rejected_signal_outcomes(
            now=first_attempt_at,
            limit=1,
        )
        pipeline.label_mature_rejected_signal_outcomes(
            now=first_attempt_at + timedelta(seconds=1),
            limit=1,
        )

        with self.session_local() as session:
            rows = {
                row.event_id: row
                for row in session.execute(select(RejectedSignalOutcomeEvent)).scalars()
            }

        foreign = rows["reject-event-foreign-account"]
        incomplete = rows["reject-event-incomplete-oldest"]
        complete = rows["reject-event-complete-next"]
        self.assertEqual(foreign.outcome_label_status, "pending")
        self.assertEqual(foreign.updated_at, foreign_initial_timestamp)
        self.assertEqual(incomplete.outcome_label_status, "pending")
        self.assertGreater(incomplete.updated_at, incomplete_initial_timestamp)
        self.assertEqual(complete.outcome_label_status, "labeled")
        self.assertEqual(
            complete.outcome_payload_json["counterfactual_return"], "0.005"
        )

    def test_rejected_signal_outcome_persistence_logs_and_continues_on_db_error(
        self,
    ) -> None:
        def failing_session_factory() -> Session:
            raise SQLAlchemyError("db unavailable")

        pipeline = self._build_rejected_outcome_pipeline(
            session_factory=failing_session_factory
        )

        with self.assertLogs(
            "app.trading.scheduler.pipeline.signal_processing", level="ERROR"
        ):
            pipeline._persist_rejected_signal_outcome_event(
                {
                    "event_id": "reject-event-1",
                    "event_ts": "2026-01-01T14:31:00+00:00",
                    "symbol": "AAPL",
                }
            )

    def test_hypothesis_runtime_summary_counts_valid_live_runtime_window_certificate(
        self,
    ) -> None:
        self._seed_promotion_certificate_evidence(
            strategy_family="intraday_continuation",
        )

        with self.session_local() as session:
            summary = build_hypothesis_runtime_summary(
                session,
                state=TradingState(),
                market_context_status={},
                tca_summary={"ready": True},
            )

        self.assertEqual(summary.get("promotion_eligible_total"), 1)
        self.assertEqual(
            summary.get("capital_stage_totals"), {"0.10x canary": 1, "shadow": 4}
        )
        items = [
            cast(Mapping[str, object], item)
            for item in cast(list[object], summary.get("items") or [])
            if isinstance(item, Mapping)
        ]
        continuation = next(
            item for item in items if item.get("hypothesis_id") == "H-CONT-01"
        )
        self.assertEqual(continuation.get("state"), "canary_live")
        self.assertEqual(continuation.get("capital_stage"), "0.10x canary")
        self.assertEqual(continuation.get("capital_multiplier"), "0.10")
        self.assertTrue(continuation.get("promotion_eligible"))
        self.assertEqual(continuation.get("reasons"), [])
        observed = continuation.get("observed")
        self.assertIsInstance(observed, Mapping)
        self.assertTrue(
            cast(Mapping[str, object], observed).get(
                "runtime_window_certificate_applied"
            )
        )

    def test_hypothesis_runtime_summary_rejects_mismatched_runtime_ledger_family(
        self,
    ) -> None:
        self._seed_promotion_certificate_evidence(strategy_family="unregistered_demo")

        with self.session_local() as session:
            summary = build_hypothesis_runtime_summary(
                session,
                state=TradingState(),
                market_context_status={},
                tca_summary={"ready": True},
            )

        self.assertEqual(summary.get("promotion_eligible_total"), 0)
        items = [
            cast(Mapping[str, object], item)
            for item in cast(list[object], summary.get("items") or [])
            if isinstance(item, Mapping)
        ]
        continuation = next(
            item for item in items if item.get("hypothesis_id") == "H-CONT-01"
        )
        self.assertFalse(continuation.get("promotion_eligible"))
        self.assertIn(
            "runtime_ledger_strategy_family_mismatch",
            continuation.get("reasons") or [],
        )
        observed = continuation.get("observed")
        self.assertIsInstance(observed, Mapping)
        observed_map = cast(Mapping[str, object], observed)
        self.assertTrue(observed_map.get("runtime_window_certificate_rejected"))
        self.assertEqual(
            observed_map.get("runtime_window_rejection_reasons"),
            ["runtime_ledger_strategy_family_mismatch"],
        )
