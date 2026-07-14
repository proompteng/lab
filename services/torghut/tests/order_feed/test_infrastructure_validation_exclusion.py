from __future__ import annotations

import uuid

from app.models import BrokerMutationReceipt
from app.trading.broker_mutation_receipts import (
    BrokerMutationIntentRequest,
    BrokerMutationTarget,
    build_broker_mutation_intent,
    fingerprint_broker_endpoint,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    infrastructure_validation_client_order_id,
    infrastructure_validation_order_plan_sha256,
    infrastructure_validation_request_payload,
    infrastructure_validation_terminal_state_sha256,
)
from app.trading.infrastructure_validation_records import (
    is_non_promotable_validation_event,
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
        intent = build_broker_mutation_intent(
            BrokerMutationIntentRequest(
                broker_route="alpaca",
                account_label="paper",
                endpoint_fingerprint=fingerprint_broker_endpoint(
                    "https://paper-api.alpaca.markets"
                ),
                operation="submit_order",
                risk_class="risk_neutral",
                purpose="control_plane_validation",
                workflow_id=client_order_id,
                client_request_id=client_order_id,
                target=BrokerMutationTarget(kind="order", key=client_order_id),
                request_payload=infrastructure_validation_request_payload(
                    permit,
                    plan,
                ),
            )
        )
        payload = (
            '{"channel":"trade_updates","payload":{"event":"fill",'
            '"timestamp":"2026-07-14T10:00:00Z","order":{'
            f'"id":"validation-order-1","client_order_id":"{client_order_id}",'
            '"symbol":"BTC/USD","status":"filled","qty":"1",'
            '"filled_qty":"1","filled_avg_price":"1"}},"seq":10}'
        ).encode()
        settings.tigerbeetle_enabled = True
        settings.tigerbeetle_journal_enabled = True

        with Session(self.engine) as session:
            session.add(
                BrokerMutationReceipt(
                    id=uuid.uuid4(),
                    broker_route=intent.broker_route,
                    account_label=intent.account_label,
                    endpoint_fingerprint=intent.endpoint_fingerprint,
                    operation=intent.operation,
                    risk_class=intent.risk_class,
                    purpose=intent.purpose,
                    submission_claim_id=None,
                    workflow_id=intent.workflow_id,
                    client_request_id=intent.client_request_id,
                    target_kind=intent.target.kind,
                    target_key=intent.target.key,
                    intent_schema_version=intent.intent_schema_version,
                    canonical_intent_json=intent.canonical_intent_json,
                    canonical_intent_sha256=intent.canonical_intent_sha256,
                    creator_owner="validation-test",
                    origin_writer_generation=1,
                )
            )
            execution = self._seed_execution(
                session,
                account_label="paper",
                order_id="validation-order-1",
                client_order_id=client_order_id,
            )
            session.flush()
            normalized = normalize_order_feed_record(
                FakeRecord(value=payload, offset=91),
                default_topic="torghut.trade-updates.v1",
                default_account_label="paper",
            )
            assert normalized.event is not None
            with patch(
                "app.trading.tigerbeetle_journal.ledger_journal.create_tigerbeetle_client",
                return_value=FakeTigerBeetleClient(),
            ):
                persisted, duplicate = persist_order_event(session, normalized.event)
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
