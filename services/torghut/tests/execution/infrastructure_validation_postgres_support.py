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
    InfrastructureValidationLifecyclePlan,
    InfrastructureValidationOrderPlan,
    InfrastructureValidationPermit,
    infrastructure_validation_lifecycle_plan_sha256,
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


def upgrade_reduction_schema(
    alembic: AlembicConfig,
    schema_engine: Engine,
    *,
    target: str = "0071_validation_lineage",
) -> None:
    """Apply the accelerated reduction lineage and its catalog prerequisites."""

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
        if target in {
            "0072_validation_lifecycle",
            "0073_live_paper_bounds",
            "0074_crypto_qty_precision",
            "0075_validation_observed_at",
            "0076_broker_account_activities",
            "0077_validation_quarantine",
        }:
            connection.execute(
                text(
                    """
                    CREATE TABLE execution_order_events (
                        id UUID PRIMARY KEY,
                        event_fingerprint VARCHAR(64) NOT NULL UNIQUE,
                        source_topic VARCHAR(128) NOT NULL,
                        source_partition INTEGER,
                        source_offset BIGINT,
                        alpaca_account_label VARCHAR(64) NOT NULL,
                        feed_seq BIGINT,
                        event_ts TIMESTAMPTZ,
                        symbol VARCHAR(64),
                        alpaca_order_id VARCHAR(128),
                        client_order_id VARCHAR(128),
                        event_type VARCHAR(64),
                        status VARCHAR(32),
                        qty NUMERIC(20, 8),
                        filled_qty NUMERIC(20, 8),
                        filled_qty_delta NUMERIC(20, 8),
                        avg_fill_price NUMERIC(20, 8),
                        filled_notional_delta NUMERIC(20, 8),
                        fill_quantity_basis VARCHAR(32),
                        raw_event JSONB NOT NULL,
                        execution_id UUID,
                        trade_decision_id UUID,
                        source_window_id UUID,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
    command.upgrade(alembic, target)


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


def validation_lifecycle_fixture(
    now: datetime,
    *,
    permit_id: str = "ivp-postgres-lifecycle",
    partial_close_qty: str = "0.0002",
) -> tuple[InfrastructureValidationPermit, InfrastructureValidationLifecyclePlan]:
    plan = InfrastructureValidationLifecyclePlan.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-lifecycle-plan.v2",
            "venue": "alpaca",
            "asset_class": "crypto",
            "symbol": "BTC/USD",
            "side": "buy",
            "qty": "0.0004",
            "order_type": "limit",
            "time_in_force": "ioc",
            "limit_price": "70000",
            "stop_price": None,
            "resting_close_limit_price": "130000",
            "replacement_close_limit_price": "140000",
            "partial_close_qty": partial_close_qty,
        }
    )
    permit = InfrastructureValidationPermit.model_validate(
        {
            "schema_version": "torghut.infrastructure-validation-permit.v2",
            "permit_id": permit_id,
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
            "max_notional_usd": "30",
            "max_loss_usd": "30",
            "issued_by": "infrastructure-owner",
            "approved_by": "independent-infrastructure-owner",
            "issued_at": now - timedelta(seconds=1),
            "expires_at": now + timedelta(minutes=5),
            "test_plan_digest": infrastructure_validation_lifecycle_plan_sha256(plan),
            "expected_terminal_state": (
                "no_open_orders_no_positions_no_unsettled_claims"
            ),
            "expected_terminal_state_digest": (
                infrastructure_validation_terminal_state_sha256()
            ),
            "evidence_tag": "non_promotable_validation",
            "promotable": False,
        }
    )
    return permit, plan


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
