from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select

from app.models import BrokerMutationReceipt, TradeDecisionSubmissionClaim
from app.trading.execution import OrderExecutor
from app.trading.firewall import OrderFirewall
from app.trading.models import StrategyDecision
from tests.order_idempotency.support import FakeAlpacaClient, _TestOrderIdempotencyBase
from tests.trading_fixtures import make_strategy


class TestFirewallAccountIdentity(_TestOrderIdempotencyBase):
    def test_account_mismatch_fails_before_claim_receipt_or_broker_io(self) -> None:
        with self.session_local() as session:
            strategy = make_strategy(
                name="identity-preflight",
                description="account identity preflight",
            )
            session.add(strategy)
            session.commit()
            session.refresh(strategy)

            decision = StrategyDecision(
                strategy_id=str(strategy.id),
                symbol="AAPL",
                event_ts=datetime.now(timezone.utc),
                timeframe="1Min",
                action="buy",
                qty=Decimal("1"),
                params={"price": Decimal("100")},
            )
            executor = OrderExecutor()
            decision_row = executor.ensure_decision(
                session,
                decision,
                strategy,
                "live",
            )
            broker = FakeAlpacaClient()
            firewall = OrderFirewall(broker, account_label="paper")

            with self.assertRaisesRegex(
                RuntimeError,
                "order_firewall_account_label_mismatch",
            ):
                executor.submit_order(
                    session,
                    firewall,
                    decision,
                    decision_row,
                    "live",
                )

            self.assertEqual(broker.submitted, [])
            self.assertEqual(
                session.execute(select(TradeDecisionSubmissionClaim)).scalars().all(),
                [],
            )
            self.assertEqual(
                session.execute(select(BrokerMutationReceipt)).scalars().all(),
                [],
            )
