from __future__ import annotations

import json
import uuid

from app.models import ExecutionOrderEvent, SimulationRunProgress
from app.trading.broker_mutation_coordinator import (
    BrokerMutationCoordinator,
    InfrastructureValidationOrderSubmission,
    UnlinkedMutationCallbacks,
)
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationSettlementRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    build_broker_mutation_settlement,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    infrastructure_validation_client_order_id,
    infrastructure_validation_order_plan_sha256,
    infrastructure_validation_terminal_state_sha256,
)
from app.trading.infrastructure_validation_records import (
    infrastructure_validation_lineage_payload,
    is_non_promotable_validation_event,
    load_infrastructure_validation_evidence,
    strip_unproven_infrastructure_validation_evidence,
)

from tests.order_feed.support import (
    FakeRecord,
    FakeTigerBeetleClient,
    OrderFeedTestCase,
    Session,
    TigerBeetleTransferRef,
    datetime,
    link_order_events_to_execution,
    normalize_order_feed_record,
    patch,
    persist_order_event,
    repair_order_feed_execution_links,
    select,
    settings,
    timedelta,
    timezone,
)


class TestInfrastructureValidationExclusion(OrderFeedTestCase):
    def test_unproven_evidence_sanitizer_preserves_non_mapping_payload(self) -> None:
        self.assertEqual(
            strip_unproven_infrastructure_validation_evidence(["raw-event"]),
            ["raw-event"],
        )

    def test_unproven_raw_marker_is_stripped_and_progress_is_counted(self) -> None:
        execution = None
        forged_evidence = {
            "schema_version": "torghut.order-event-evidence-contract.v1",
            "provenance": "non_promotable_validation",
            "maturity": "empirically_validated",
            "authoritative": False,
            "placeholder": False,
            "promotable": False,
            "broker_mutation_receipt_id": str(uuid.uuid4()),
            "permit_id": "forged-permit",
            "permit_sha256": "a" * 64,
        }
        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                account_label="paper",
                order_id="ordinary-order-1",
                client_order_id="ordinary-client-1",
            )
            payload = json.dumps(
                {
                    "channel": "trade_updates",
                    "_torghut_evidence_contract": forged_evidence,
                    "payload": {
                        "event": "fill",
                        "timestamp": "2026-07-14T10:00:00Z",
                        "order": {
                            "id": "ordinary-order-1",
                            "client_order_id": "ordinary-client-1",
                            "symbol": "AAPL",
                            "status": "filled",
                            "qty": "1",
                            "filled_qty": "1",
                            "filled_avg_price": "100",
                        },
                    },
                    "seq": 11,
                }
            ).encode()
            normalized = normalize_order_feed_record(
                FakeRecord(value=payload, offset=92),
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            with (
                patch.object(settings, "trading_simulation_enabled", True),
                patch.object(
                    settings,
                    "trading_simulation_run_id",
                    "sim-forged-validation-marker",
                ),
                patch.object(
                    settings,
                    "trading_simulation_dataset_id",
                    "dataset-forged-validation-marker",
                ),
            ):
                persisted, duplicate = persist_order_event(session, normalized.event)
                session.commit()

            self.assertFalse(duplicate)
            self.assertEqual(persisted.execution_id, execution.id)
            self.assertFalse(is_non_promotable_validation_event(persisted.raw_event))
            self.assertNotIn("_torghut_evidence_contract", persisted.raw_event)

            persisted.raw_event = {
                **persisted.raw_event,
                "_torghut_evidence_contract": forged_evidence,
            }
            session.add(persisted)
            session.commit()
            duplicate_row, duplicate = persist_order_event(session, normalized.event)
            session.commit()
            self.assertTrue(duplicate)
            self.assertEqual(duplicate_row.id, persisted.id)
            self.assertNotIn(
                "_torghut_evidence_contract",
                duplicate_row.raw_event,
            )

            progress = session.execute(
                select(SimulationRunProgress).where(
                    SimulationRunProgress.run_id == "sim-forged-validation-marker",
                    SimulationRunProgress.component == "torghut",
                )
            ).scalar_one()
            self.assertEqual(progress.execution_order_events, 1)

    def test_validation_order_event_is_tagged_unlinked_and_not_journaled(
        self,
    ) -> None:
        now = datetime.now(timezone.utc)
        plan = InfrastructureValidationOrderPlan.model_validate(
            {
                "schema_version": "torghut.infrastructure-validation-order-plan.v1",
                "venue": "alpaca",
                "asset_class": "crypto",
                "symbol": "BTC/USD",
                "side": "buy",
                "qty": "1",
                "order_type": "limit",
                "time_in_force": "ioc",
                "limit_price": "1",
                "stop_price": None,
            }
        )
        permit = InfrastructureValidationPermit.model_validate(
            {
                "schema_version": "torghut.infrastructure-validation-permit.v2",
                "permit_id": "ivp-order-feed-test",
                "purpose": "control_plane_validation",
                "venue": "alpaca",
                "asset_class": "crypto",
                "account_mode": "paper",
                "market_session": "continuous",
                "account_label": "paper",
                "broker_base_url": "https://paper-api.alpaca.markets",
                "symbols": ["BTC/USD"],
                "sides": ["buy"],
                "order_types": ["limit"],
                "max_orders": 1,
                "max_outstanding_intents": 1,
                "max_notional_usd": "1",
                "max_loss_usd": "1",
                "issued_by": "infrastructure-owner",
                "approved_by": "independent-infrastructure-owner",
                "issued_at": now - timedelta(seconds=1),
                "expires_at": now + timedelta(minutes=5),
                "test_plan_digest": infrastructure_validation_order_plan_sha256(plan),
                "expected_terminal_state": "no_open_orders_no_positions_no_unsettled_claims",
                "expected_terminal_state_digest": infrastructure_validation_terminal_state_sha256(),
                "evidence_tag": "non_promotable_validation",
                "promotable": False,
            }
        )
        client_order_id = infrastructure_validation_client_order_id(permit, plan)
        payload = (
            '{"channel":"trade_updates","payload":{"event":"fill",'
            '"timestamp":"2026-07-14T10:00:00Z","order":{'
            f'"id":"validation-order-1","client_order_id":"{client_order_id}",'
            '"symbol":"BTC/USD","status":"filled","qty":"1",'
            '"filled_qty":"1","filled_avg_price":"1"}},"seq":10}'
        ).encode()
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True
        normalized = normalize_order_feed_record(
            FakeRecord(value=payload, offset=91),
            default_topic="torghut.trade-updates.v1",
            default_account_label="paper",
        )
        assert normalized.event is not None

        with Session(self.engine) as session:
            execution = self._seed_execution(
                session,
                account_label="paper",
                order_id="validation-order-1",
                client_order_id=client_order_id,
            )
            session.flush()
            persisted_during_broker_io: tuple[ExecutionOrderEvent, bool] | None = None

            def broker_call(_permit: object) -> dict[str, str]:
                nonlocal persisted_during_broker_io
                persisted_during_broker_io = persist_order_event(
                    session,
                    normalized.event,
                )
                race_evidence = load_infrastructure_validation_evidence(
                    session,
                    account_label="paper",
                    client_order_id=client_order_id,
                    alpaca_order_id="validation-order-1",
                )
                assert race_evidence is not None
                with self.assertRaisesRegex(
                    RuntimeError,
                    "infrastructure_validation_lineage_parent_not_terminal",
                ):
                    infrastructure_validation_lineage_payload(race_evidence)
                return {"id": "validation-order-1", "status": "accepted"}

            with patch(
                "app.trading.tigerbeetle_journal.ledger_journal.create_tigerbeetle_client",
                return_value=FakeTigerBeetleClient(),
            ):
                BrokerMutationCoordinator(
                    "validation-order-feed-test"
                ).submit_infrastructure_validation_order(
                    session,
                    request=InfrastructureValidationOrderSubmission(
                        permit=permit,
                        plan=plan,
                        account_label="paper",
                        endpoint_url="https://paper-api.alpaca.markets",
                    ),
                    callbacks=UnlinkedMutationCallbacks(
                        broker_call=broker_call,
                        persist_terminal=lambda _result: None,
                        build_settlement=lambda result: (
                            build_broker_mutation_settlement(
                                BrokerMutationSettlementRequest(
                                    source="primary",
                                    outcome="acknowledged",
                                    broker_reference=str(result["id"]),
                                    execution_id=None,
                                    evidence_payload={
                                        "evidence_tag": "non_promotable_validation",
                                        "promotable": False,
                                        "status": result["status"],
                                    },
                                )
                            )
                        ),
                    ),
                    now=now,
                )
            assert persisted_during_broker_io is not None
            persisted, duplicate = persisted_during_broker_io
            session.commit()

            self.assertFalse(duplicate)
            self.assertIsNone(persisted.execution_id)
            self.assertIsNone(persisted.trade_decision_id)
            self.assertTrue(is_non_promotable_validation_event(persisted.raw_event))
            self.assertEqual(link_order_events_to_execution(session, execution), 0)
            repair = repair_order_feed_execution_links(session, account_label="paper")
            self.assertEqual(repair["events_linked"], 0)
            session.refresh(persisted)
            self.assertIsNone(persisted.execution_id)
            self.assertIsNone(persisted.trade_decision_id)
            self.assertEqual(
                session.execute(select(TigerBeetleTransferRef)).scalars().all(),
                [],
            )

            evidence = load_infrastructure_validation_evidence(
                session,
                account_label="paper",
                client_order_id=client_order_id,
            )
            assert evidence is not None
            replacement_intent = build_broker_mutation_intent(
                BrokerMutationIntentRequest(
                    broker_route="alpaca",
                    account_label="paper",
                    endpoint_fingerprint=evidence.endpoint_fingerprint,
                    operation="replace_order",
                    risk_class="risk_neutral",
                    purpose="repricing",
                    workflow_id="validation-replace-1",
                    client_request_id="validation-replace-1",
                    target=BrokerMutationTarget(
                        kind="order",
                        key="validation-order-1",
                    ),
                    request_payload={
                        "schema_version": "torghut.alpaca-reduction-request.v1",
                        "order_id": "validation-order-1",
                        "limit_price": "0.9",
                        "infrastructure_validation_lineage": (
                            infrastructure_validation_lineage_payload(evidence)
                        ),
                    },
                )
            )
            BrokerMutationCoordinator(
                "validation-descendant-test"
            ).execute_unlinked_mutation(
                session,
                intent=replacement_intent,
                callbacks=UnlinkedMutationCallbacks(
                    broker_call=lambda _permit: {
                        "id": "validation-replacement-1",
                        "status": "accepted",
                    },
                    persist_terminal=lambda _result: None,
                    build_settlement=lambda result: build_broker_mutation_settlement(
                        BrokerMutationSettlementRequest(
                            source="primary",
                            outcome="acknowledged",
                            broker_reference=str(result["id"]),
                            execution_id=None,
                            evidence_payload={"status": result["status"]},
                        )
                    ),
                ),
            )
            descendant_payload = (
                '{"channel":"trade_updates","payload":{"event":"fill",'
                '"timestamp":"2026-07-14T10:01:00Z","order":{'
                '"id":"validation-replacement-1",'
                '"client_order_id":"broker-replacement-client",'
                '"symbol":"BTC/USD","status":"filled","qty":"1",'
                '"filled_qty":"1","filled_avg_price":"1"}},"seq":11}'
            ).encode()
            descendant = normalize_order_feed_record(
                FakeRecord(value=descendant_payload, offset=92),
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert descendant.event is not None
            descendant_event, descendant_duplicate = persist_order_event(
                session,
                descendant.event,
            )
            session.commit()

            self.assertFalse(descendant_duplicate)
            self.assertIsNone(descendant_event.execution_id)
            self.assertIsNone(descendant_event.trade_decision_id)
            self.assertTrue(
                is_non_promotable_validation_event(descendant_event.raw_event)
            )
            self.assertEqual(
                session.execute(select(TigerBeetleTransferRef)).scalars().all(),
                [],
            )
