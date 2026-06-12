from __future__ import annotations

# ruff: noqa: F401,F403,F405
from tests.flatten_paper_account_positions.support import *


class TestFlattenPaperAccountFlattenOrders(_TestFlattenPaperAccountPositionsBase):
    def test_dry_run_reports_close_orders_without_mutating(self) -> None:
        client = FakeFlattenClient(
            [
                {
                    "symbol": "AMAT",
                    "qty": "0.8761",
                    "side": "long",
                    "market_value": "393.66",
                }
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=False,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            generated_at=datetime(2026, 5, 29, 19, 5, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["status"], "dry_run")
        self.assertEqual(payload["position_count"], 1)
        self.assertEqual(payload["positions"][0]["close_side"], "sell")
        self.assertFalse(client.cancelled)
        self.assertEqual(client.submitted, [])

    def test_apply_cancels_orders_and_submits_opposing_market_orders(self) -> None:
        client = FakeFlattenClient(
            [
                {"symbol": "AMAT", "qty": "0.8761", "side": "long"},
                {"symbol": "TSM", "qty": "0.3321", "side": "short"},
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            generated_at=datetime(2026, 5, 29, 19, 5, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["status"], "submitted")
        self.assertTrue(client.cancelled)
        self.assertEqual(payload["cancelled_order_count"], 1)
        self.assertEqual(
            [
                (order["symbol"], order["side"], order["type"])
                for order in client.submitted
            ],
            [("AMAT", "sell", "market"), ("TSM", "buy", "market")],
        )
        self.assertEqual(payload["submitted_order_count"], 2)

    def test_apply_persists_linked_close_decision_and_execution(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )
        with _memory_session() as session:
            generated_at = datetime(2026, 6, 1, 13, 35, tzinfo=timezone.utc)
            expected_client_order_id = flatten_script._flatten_client_order_id(
                generated_at=generated_at,
                symbol="AMAT",
            )
            strategy = _source_strategy(session)
            source_decision = _source_decision(session, strategy)
            source_execution = Execution(
                trade_decision_id=source_decision.id,
                alpaca_account_label="TORGHUT_SIM",
                alpaca_order_id="source-order-1",
                client_order_id="source-decision-hash",
                symbol="AMAT",
                side="buy",
                order_type="market",
                time_in_force="day",
                submitted_qty=Decimal("2"),
                filled_qty=Decimal("2"),
                status="filled",
                execution_expected_adapter="alpaca_paper",
                execution_actual_adapter="alpaca_paper",
                raw_order={},
            )
            session.add(source_execution)
            pending_order_event = ExecutionOrderEvent(
                event_fingerprint="pending-flatten-order-event",
                source_topic="alpaca.orders",
                alpaca_account_label="TORGHUT_SIM",
                client_order_id=expected_client_order_id,
                symbol="AMAT",
                event_type="new",
                status="accepted",
                raw_event={"client_order_id": expected_client_order_id},
            )
            session.add(pending_order_event)
            session.commit()

            payload = flatten_paper_account_positions(
                client=client,
                account_label="TORGHUT_SIM",
                expected_account_label="TORGHUT_SIM",
                trading_mode="paper",
                apply=True,
                max_gross_market_value=Decimal("2500"),
                max_position_count=10,
                generated_at=generated_at,
                persist_lineage=True,
                lineage_session=session,
            )

            self.assertEqual(payload["status"], "submitted")
            self.assertEqual(payload["lineage_result_count"], 1)
            lineage_result = payload["lineage_results"][0]
            self.assertEqual(
                lineage_result["flatten_lineage_status"], "linked_source_lineage"
            )
            self.assertEqual(
                lineage_result["source_candidate_ids"],
                ["c88421d619759b2cfaa6f4d0"],
            )
            self.assertEqual(lineage_result["source_hypothesis_ids"], ["H-PAIRS-01"])
            self.assertEqual(
                lineage_result["source_strategy_names"],
                ["microbar-cross-sectional-pairs-v1"],
            )
            self.assertEqual(
                lineage_result["source_decision_mode"], "strategy_signal_paper"
            )
            self.assertTrue(lineage_result["profit_proof_eligible"])
            self.assertFalse(lineage_result["final_promotion_authorized"])

            client_order_id = client.submitted[0]["client_order_id"]
            close_decision = session.execute(
                select(TradeDecision).where(
                    TradeDecision.decision_hash == client_order_id
                )
            ).scalar_one()
            decision_json = close_decision.decision_json
            self.assertEqual(
                decision_json["schema_version"],
                "torghut.paper-account-flatten-close-decision.v1",
            )
            StrategyDecision.model_validate(decision_json)
            self.assertEqual(decision_json["strategy_id"], str(strategy.id))
            self.assertEqual(
                decision_json["event_ts"],
                "2026-06-01T13:35:00+00:00",
            )
            self.assertEqual(decision_json["timeframe"], "event")
            self.assertEqual(
                decision_json["source_candidate_ids"],
                ["c88421d619759b2cfaa6f4d0"],
            )
            self.assertEqual(decision_json["source_hypothesis_ids"], ["H-PAIRS-01"])
            self.assertEqual(
                decision_json["source_strategy_names"],
                ["microbar-cross-sectional-pairs-v1"],
            )
            self.assertTrue(decision_json["profit_proof_eligible"])
            self.assertFalse(decision_json["final_promotion_authorized"])
            close_execution = session.execute(
                select(Execution).where(Execution.client_order_id == client_order_id)
            ).scalar_one()
            self.assertEqual(close_execution.trade_decision_id, close_decision.id)
            self.assertEqual(close_execution.alpaca_order_id, "order-1")
            session.refresh(pending_order_event)
            self.assertEqual(pending_order_event.trade_decision_id, close_decision.id)
            self.assertEqual(pending_order_event.execution_id, close_execution.id)

    def test_apply_persists_unlinked_no_source_lineage_fallback(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )
        with _memory_session() as session:
            payload = flatten_paper_account_positions(
                client=client,
                account_label="TORGHUT_SIM",
                expected_account_label="TORGHUT_SIM",
                trading_mode="paper",
                apply=True,
                max_gross_market_value=Decimal("2500"),
                max_position_count=10,
                generated_at=datetime(2026, 6, 1, 13, 40, tzinfo=timezone.utc),
                persist_lineage=True,
                lineage_session=session,
            )

            self.assertEqual(payload["status"], "submitted")
            self.assertEqual(payload["lineage_result_count"], 1)
            lineage_result = payload["lineage_results"][0]
            self.assertEqual(
                lineage_result["flatten_lineage_status"], "unlinked_no_source_lineage"
            )
            self.assertEqual(lineage_result["source_candidate_ids"], [])
            self.assertEqual(lineage_result["source_hypothesis_ids"], [])
            self.assertEqual(lineage_result["source_strategy_names"], [])
            self.assertIsNone(lineage_result["source_decision_mode"])
            self.assertFalse(lineage_result["profit_proof_eligible"])
            self.assertFalse(lineage_result["final_promotion_authorized"])

            client_order_id = client.submitted[0]["client_order_id"]
            close_decision = session.execute(
                select(TradeDecision).where(
                    TradeDecision.decision_hash == client_order_id
                )
            ).scalar_one()
            decision_json = close_decision.decision_json
            self.assertEqual(
                decision_json["flatten_lineage_status"], "unlinked_no_source_lineage"
            )
            StrategyDecision.model_validate(decision_json)
            self.assertEqual(
                decision_json["strategy_id"],
                str(close_decision.strategy_id),
            )
            self.assertEqual(
                decision_json["event_ts"],
                "2026-06-01T13:40:00+00:00",
            )
            self.assertEqual(decision_json["timeframe"], "event")
            self.assertEqual(decision_json["source_candidate_ids"], [])
            self.assertFalse(decision_json["profit_proof_eligible"])
            close_execution = session.execute(
                select(Execution).where(Execution.client_order_id == client_order_id)
            ).scalar_one()
            self.assertEqual(close_execution.trade_decision_id, close_decision.id)

    def test_lineage_helpers_cover_empty_string_and_params_sources(self) -> None:
        self.assertEqual(flatten_script._lineage_values(" H-PAIRS-01 "), ["H-PAIRS-01"])
        self.assertEqual(flatten_script._lineage_values(None), [])
        self.assertEqual(
            flatten_script._decision_mapping(
                cast(Any, SimpleNamespace(decision_json=[]))
            ),
            {},
        )
        payload = {"params": {"source_candidate_ids": ["candidate-from-params"]}}
        self.assertEqual(
            flatten_script._decision_params(payload),
            {"source_candidate_ids": ["candidate-from-params"]},
        )
        self.assertIsNone(
            flatten_script._first_lineage_bool(
                {"profit_proof_eligible": "unknown"}, {}, "profit_proof_eligible"
            )
        )
        self.assertEqual(
            flatten_script._lineage_payload(
                client_order_id="flatten-client-id",
                lineage_status="lineage_persist_failed",
                decision=None,
                execution=None,
                lineage=None,
                error=RuntimeError("lineage unavailable"),
            )["error_type"],
            "RuntimeError",
        )

    def test_no_lineage_reuses_cleanup_strategy_and_existing_close_decision(
        self,
    ) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )
        generated_at = datetime(2026, 6, 1, 13, 45, tzinfo=timezone.utc)
        with _memory_session() as session:
            first_payload = flatten_paper_account_positions(
                client=client,
                account_label="TORGHUT_SIM",
                expected_account_label="TORGHUT_SIM",
                trading_mode="paper",
                apply=True,
                max_gross_market_value=Decimal("2500"),
                max_position_count=10,
                generated_at=generated_at,
                persist_lineage=True,
                lineage_session=session,
            )
            second_client_order_id = flatten_script._flatten_client_order_id(
                generated_at=generated_at,
                symbol="AMAT",
            )
            position = flatten_script.FlattenPosition(
                symbol="AMAT",
                qty=Decimal("2"),
                side="long",
                market_value=Decimal("200"),
                reference_price=Decimal("100"),
            )
            existing_decision, _ = flatten_script._persist_close_decision(
                session,
                account_label="TORGHUT_SIM",
                position=position,
                client_order_id=second_client_order_id,
                order_type="market",
                limit_price=None,
                generated_at=generated_at,
            )
            reused_decision, _ = flatten_script._persist_close_decision(
                session,
                account_label="TORGHUT_SIM",
                position=position,
                client_order_id=second_client_order_id,
                order_type="market",
                limit_price=None,
                generated_at=generated_at,
            )

            self.assertEqual(first_payload["lineage_result_count"], 1)
            self.assertEqual(existing_decision.id, reused_decision.id)
            cleanup_strategies = (
                session.execute(
                    select(Strategy).where(
                        Strategy.name == flatten_script.FLATTEN_CLEANUP_STRATEGY_NAME
                    )
                )
                .scalars()
                .all()
            )
            self.assertEqual(len(cleanup_strategies), 1)

    def test_persist_lineage_rejection_marks_close_decision_rejected(self) -> None:
        client = RejectingFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )
        with _memory_session() as session:
            strategy = _source_strategy(session)
            _source_decision(session, strategy)
            payload = flatten_paper_account_positions(
                client=client,
                account_label="TORGHUT_SIM",
                expected_account_label="TORGHUT_SIM",
                trading_mode="paper",
                apply=True,
                max_gross_market_value=Decimal("2500"),
                max_position_count=10,
                generated_at=datetime(2026, 6, 1, 13, 50, tzinfo=timezone.utc),
                persist_lineage=True,
                lineage_session=session,
            )

            self.assertEqual(payload["status"], "failed_close_orders")
            self.assertEqual(payload["lineage_result_count"], 1)
            self.assertEqual(
                payload["lineage_results"][0]["flatten_lineage_status"],
                "linked_source_lineage",
            )
            decision_id = payload["lineage_results"][0]["trade_decision_id"]
            close_decision = session.get(TradeDecision, decision_id)
            self.assertIsNotNone(close_decision)
            self.assertEqual(close_decision.status, "rejected")

    def test_lineage_persist_failure_is_reported_without_blocking_flatten(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )
        with _memory_session() as session:
            with patch.object(
                flatten_script,
                "_persist_close_decision",
                side_effect=RuntimeError("db unavailable"),
            ):
                payload = flatten_paper_account_positions(
                    client=client,
                    account_label="TORGHUT_SIM",
                    expected_account_label="TORGHUT_SIM",
                    trading_mode="paper",
                    apply=True,
                    max_gross_market_value=Decimal("2500"),
                    max_position_count=10,
                    generated_at=datetime(2026, 6, 1, 13, 55, tzinfo=timezone.utc),
                    persist_lineage=True,
                    lineage_session=session,
                )

            self.assertEqual(payload["status"], "submitted")
            self.assertEqual(client.submitted[0]["symbol"], "AMAT")
            self.assertEqual(
                payload["lineage_results"][0]["flatten_lineage_status"],
                "lineage_persist_failed",
            )
            self.assertEqual(
                payload["lineage_results"][0]["error_type"], "RuntimeError"
            )

    def test_execution_sync_failure_is_reported_without_rejecting_submitted_order(
        self,
    ) -> None:
        client = MissingOrderIdFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )
        with _memory_session() as session:
            payload = flatten_paper_account_positions(
                client=client,
                account_label="TORGHUT_SIM",
                expected_account_label="TORGHUT_SIM",
                trading_mode="paper",
                apply=True,
                max_gross_market_value=Decimal("2500"),
                max_position_count=10,
                generated_at=datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc),
                persist_lineage=True,
                lineage_session=session,
            )

            self.assertEqual(payload["status"], "submitted")
            self.assertEqual(payload["submitted_order_count"], 1)
            self.assertEqual(payload["rejected_close_order_count"], 0)
            self.assertEqual(
                payload["lineage_results"][0]["flatten_lineage_status"],
                "lineage_persist_failed",
            )
            self.assertEqual(payload["lineage_results"][0]["error_type"], "ValueError")

    def test_extended_hours_limit_orders_use_guarded_reference_prices(self) -> None:
        client = FakeFlattenClient(
            [
                {
                    "symbol": "AMAT",
                    "qty": "2",
                    "side": "long",
                    "current_price": "100",
                },
                {
                    "symbol": "TSM",
                    "qty": "3",
                    "side": "short",
                    "current_price": "50",
                },
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            extended_hours_limit=True,
            limit_away_bps=Decimal("200"),
            generated_at=datetime(2026, 5, 29, 13, 5, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["status"], "submitted")
        self.assertTrue(payload["extended_hours_limit"])
        self.assertEqual(payload["limit_away_bps"], "200")
        self.assertEqual(payload["extended_hours_limit_missing_symbols"], [])
        self.assertEqual(
            [
                (
                    order["symbol"],
                    order["side"],
                    order["type"],
                    order["limit_price"],
                    order["extended_hours"],
                )
                for order in client.submitted
            ],
            [
                ("AMAT", "sell", "limit", 98.0, True),
                ("TSM", "buy", "limit", 51.0, True),
            ],
        )

    def test_extended_hours_limit_blocks_missing_reference_prices(self) -> None:
        client = FakeFlattenClient([{"symbol": "AMAT", "qty": "2", "side": "long"}])

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            extended_hours_limit=True,
            limit_away_bps=Decimal("200"),
        )

        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["extended_hours_limit_missing_symbols"], ["AMAT"])
        self.assertIn(
            "paper_account_flatten_extended_hours_limit_price_missing",
            payload["blockers"],
        )
        self.assertFalse(client.cancelled)
        self.assertEqual(client.submitted, [])

    def test_extended_hours_limit_clamps_non_positive_sell_limit(self) -> None:
        client = FakeFlattenClient(
            [
                {
                    "symbol": "PENNY",
                    "qty": "1",
                    "side": "long",
                    "current_price": "0.000001",
                }
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            extended_hours_limit=True,
            limit_away_bps=Decimal("20000"),
        )

        self.assertEqual(payload["status"], "submitted")
        self.assertEqual(client.submitted[0]["type"], "limit")
        self.assertEqual(client.submitted[0]["limit_price"], 0.0001)

    def test_wait_flat_marks_submitted_not_flat_when_positions_remain(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            wait_flat_seconds=0.01,
            poll_seconds=0.01,
        )

        self.assertEqual(payload["status"], "submitted_not_flat")
        self.assertEqual(payload["position_count"], 1)
        self.assertEqual(payload["final_position_count"], 1)

    def test_apply_reports_rejected_close_orders_as_stable_blocker(self) -> None:
        client = RejectingFlattenClient(
            [{"symbol": "AMAT", "qty": "2", "side": "long", "current_price": "100"}]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
        )

        self.assertEqual(payload["status"], "failed_close_orders")
        self.assertIn("paper_account_flatten_close_order_rejected", payload["blockers"])
        self.assertEqual(payload["rejected_close_order_count"], 1)
        self.assertEqual(
            payload["rejected_close_orders"][0]["reason"],
            "paper_account_flatten_close_order_rejected",
        )
        self.assertEqual(payload["submitted_order_count"], 0)
        self.assertTrue(client.cancelled)

    def test_wait_flat_marks_flattened_when_positions_clear(self) -> None:
        client = SequencedFlattenClient(
            [
                [
                    {
                        "symbol": "AMAT",
                        "qty": "2",
                        "side": "long",
                        "current_price": "100",
                    }
                ],
                [],
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
            wait_flat_seconds=0.01,
            poll_seconds=0.01,
        )

        self.assertEqual(payload["status"], "flattened")
        self.assertEqual(payload["position_count"], 1)
        self.assertEqual(payload["final_position_count"], 0)

    def test_refuses_live_mode_or_wrong_account(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AAPL", "qty": "1", "side": "long", "market_value": "100"}]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="PA3SX7FYNUTF",
            expected_account_label="TORGHUT_SIM",
            trading_mode="live",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
        )

        self.assertEqual(payload["status"], "blocked")
        self.assertIn("paper_account_flatten_requires_paper_mode", payload["blockers"])
        self.assertIn(
            "paper_account_flatten_account_label_mismatch", payload["blockers"]
        )
        self.assertFalse(client.cancelled)
        self.assertEqual(client.submitted, [])

    def test_refuses_position_value_above_limit(self) -> None:
        client = FakeFlattenClient(
            [{"symbol": "AMAT", "qty": "100", "side": "long", "market_value": "3000"}]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("2500"),
            max_position_count=10,
        )

        self.assertEqual(payload["status"], "blocked")
        self.assertIn(
            "paper_account_flatten_gross_market_value_above_limit",
            payload["blockers"],
        )
        self.assertFalse(client.cancelled)
        self.assertEqual(client.submitted, [])

    def test_default_guardrail_can_unwind_dirty_paper_proof_account_shape(
        self,
    ) -> None:
        client = FakeFlattenClient(
            [
                {
                    "symbol": "AAPL",
                    "qty": "-81",
                    "side": "short",
                    "market_value": "25264.710000",
                },
                {
                    "symbol": "AMZN",
                    "qty": "184",
                    "side": "long",
                    "market_value": "49961.520000",
                },
                {
                    "symbol": "AMZN250530C00190000",
                    "qty": "1",
                    "side": "long",
                    "market_value": "42.00",
                },
                {
                    "symbol": "AMAT",
                    "qty": "0.8761",
                    "side": "long",
                    "market_value": "396.65",
                },
                {
                    "symbol": "INTC",
                    "qty": "0.0477",
                    "side": "long",
                    "market_value": "5.90",
                },
                {
                    "symbol": "MU",
                    "qty": "0.0757",
                    "side": "long",
                    "market_value": "72.44",
                },
                {
                    "symbol": "SPY",
                    "qty": "0.00266",
                    "side": "long",
                    "market_value": "2.01",
                },
                {
                    "symbol": "TSM",
                    "qty": "0.3321",
                    "side": "long",
                    "market_value": "141.80",
                },
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=flatten_script.DEFAULT_MAX_GROSS_MARKET_VALUE,
            max_position_count=25,
            generated_at=datetime(2026, 5, 29, 19, 50, tzinfo=timezone.utc),
        )

        self.assertEqual(payload["status"], "submitted")
        self.assertEqual(payload["position_count"], 8)
        self.assertEqual(payload["max_gross_market_value"], "1000000")
        self.assertTrue(client.cancelled)
        self.assertEqual(payload["submitted_order_count"], 8)
        self.assertEqual(client.submitted[0]["symbol"], "AAPL")
        self.assertEqual(client.submitted[0]["side"], "buy")

    def test_normalizes_dirty_positions_and_refuses_position_count_above_limit(
        self,
    ) -> None:
        client = FakeFlattenClient(
            [
                {"symbol": "", "qty": "10", "side": "long", "market_value": "10"},
                {"symbol": "ZERO", "qty": "0", "side": "long", "market_value": "0"},
                {"symbol": "mu", "qty": "-2", "current_price": "50"},
                {"symbol": "tsm", "qty": "3", "current_price": "100"},
            ]
        )

        payload = flatten_paper_account_positions(
            client=client,
            account_label="TORGHUT_SIM",
            expected_account_label="TORGHUT_SIM",
            trading_mode="paper",
            apply=True,
            max_gross_market_value=Decimal("1000"),
            max_position_count=1,
        )

        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["position_count"], 2)
        self.assertEqual(payload["gross_market_value"], "400")
        self.assertIn(
            "paper_account_flatten_position_count_above_limit",
            payload["blockers"],
        )
        self.assertEqual(
            [
                (position["symbol"], position["side"], position["close_side"])
                for position in payload["positions"]
            ],
            [("MU", "short", "buy"), ("TSM", "long", "sell")],
        )
        self.assertFalse(client.cancelled)
