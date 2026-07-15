from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta

from alembic import command
from alembic.config import Config as AlembicConfig
from sqlalchemy import text
from sqlalchemy.engine import Engine

from app.trading.broker_mutation_receipts import (
    BrokerMutationSettlement,
    BrokerMutationSettlementRequest,
    build_broker_mutation_settlement,
)
from app.trading.infrastructure_validation import (
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    infrastructure_validation_order_plan_sha256,
    infrastructure_validation_terminal_state_sha256,
)


def upgrade_validation_submit_schema(
    alembic: AlembicConfig,
    schema_engine: Engine,
) -> None:
    """Apply the accelerated receipt lineage with its historical catalog prerequisite."""

    command.stamp(alembic, "0057_generic_multifactor_machine")
    command.upgrade(alembic, "0061_linked_submission_terminal")
    command.stamp(alembic, "0065_strategy_capital_compat")
    with schema_engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE torghut_options_contract_catalog (
                    contract_symbol TEXT PRIMARY KEY,
                    status TEXT NOT NULL
                )
                """
            )
        )
    command.upgrade(alembic, "0068_validation_submit")


def validation_fixture(
    now: datetime,
    *,
    permit_id: str = "ivp-postgres-one",
    symbol: str = "BTC/USD",
) -> tuple[InfrastructureValidationPermit, InfrastructureValidationOrderPlan]:
    plan = InfrastructureValidationOrderPlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-order-plan.v1",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": symbol,
            "side": "buy",
            "qty": "1",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "1",
            "stop_price": None,
        }
    )
    return (
        InfrastructureValidationPermit.model_validate(
            {
                "schema_version": "torghut.infrastructure-validation-permit.v2",
                "permit_id": permit_id,
                "purpose": "control_plane_validation",
                "venue": "alpaca",
                "asset_class": "crypto",
                "account_mode": "paper",
                "market_session": "continuous",
                "account_label": "dedicated-validation-paper",
                "broker_base_url": "https://paper-api.alpaca.markets",
                "symbols": [symbol],
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
        ),
        plan,
    )


def validation_settlement(
    result: Mapping[str, object],
) -> BrokerMutationSettlement:
    return build_broker_mutation_settlement(
        BrokerMutationSettlementRequest(
            source="primary",
            outcome="acknowledged",
            broker_reference=str(result.get("id") or "validation-rejected"),
            execution_id=None,
            evidence_payload={
                "schema_version": "torghut.infrastructure-validation-submit-terminal.v1",
                "evidence_tag": "non_promotable_validation",
                "promotable": False,
                "broker_status": str(result.get("status") or "unknown"),
            },
        )
    )
