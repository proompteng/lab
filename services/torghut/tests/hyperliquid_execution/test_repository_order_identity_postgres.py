from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.hyperliquid_execution.models import OrderIntent, OrderResult
from app.hyperliquid_execution.repository import HyperliquidExecutionRepository
from tests.execution.decision_submission_claims_postgres_support import POSTGRES_DSN


@pytest.mark.skipif(
    POSTGRES_DSN is None,
    reason="set TORGHUT_TEST_POSTGRES_DSN for the Hyperliquid order identity test",
)
def test_postgres_cloid_upsert_is_identity_safe_and_status_monotonic() -> None:
    assert POSTGRES_DSN is not None
    schema = f"hyperliquid_order_identity_{uuid.uuid4().hex}"
    admin_engine = create_engine(POSTGRES_DSN, future=True)
    schema_url = make_url(POSTGRES_DSN).update_query_dict(
        {"options": f"-csearch_path={schema}"}
    )
    engine = create_engine(schema_url, future=True)
    sessions = sessionmaker(
        bind=engine,
        class_=Session,
        expire_on_commit=False,
        future=True,
    )
    try:
        with admin_engine.begin() as connection:
            connection.execute(text(f'CREATE SCHEMA "{schema}"'))
        with engine.begin() as connection:
            connection.execute(
                text(
                    """
                    CREATE TABLE hyperliquid_execution_orders (
                      id UUID PRIMARY KEY,
                      signal_id UUID NOT NULL,
                      execution_network VARCHAR(16) NOT NULL,
                      market_id VARCHAR(128) NOT NULL,
                      coin VARCHAR(64) NOT NULL,
                      cloid VARCHAR(66) NOT NULL,
                      exchange_order_id VARCHAR(128),
                      side VARCHAR(8) NOT NULL,
                      size NUMERIC(28, 12) NOT NULL,
                      limit_price NUMERIC(28, 10) NOT NULL,
                      notional_usd NUMERIC(28, 8) NOT NULL,
                      reduce_only BOOLEAN NOT NULL,
                      tif VARCHAR(16) NOT NULL,
                      status VARCHAR(32) NOT NULL,
                      rejection_reason TEXT,
                      submitted_at TIMESTAMPTZ NOT NULL,
                      expires_at TIMESTAMPTZ NOT NULL,
                      raw_response JSONB NOT NULL,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                      UNIQUE (execution_network, cloid)
                    )
                    """
                )
            )

        now = datetime.now(timezone.utc)
        intent = OrderIntent(
            market_id="hl:perp:xyz:NVDA",
            coin="NVDA",
            dex="xyz",
            side="buy",
            size=Decimal("0.2"),
            limit_price=Decimal("101"),
            notional_usd=Decimal("20.2"),
            cloid="0x" + "a" * 32,
            tif="Ioc",
            reduce_only=False,
            signal_id=str(uuid.uuid4()),
            expires_at=now + timedelta(seconds=45),
        )
        with sessions.begin() as session:
            repository = HyperliquidExecutionRepository(session)
            first_id = repository.insert_order(
                intent,
                OrderResult("accepted", "123", {"status": "accepted"}),
            )
            filled_id = repository.insert_order(
                intent,
                OrderResult("filled", "123", {"status": "filled"}),
            )
            stale_id = repository.insert_order(
                intent,
                OrderResult("accepted", "123", {"status": "accepted-again"}),
            )
            assert first_id == filled_id == stale_id

            with pytest.raises(
                ValueError,
                match="hyperliquid_order_cloid_identity_conflict",
            ):
                repository.insert_order(
                    replace(intent, coin="AMD"),
                    OrderResult("accepted", "123", {"status": "wrong-coin"}),
                )
            with pytest.raises(
                ValueError,
                match="hyperliquid_order_cloid_identity_conflict",
            ):
                repository.insert_order(
                    intent,
                    OrderResult("accepted", "456", {"status": "wrong-oid"}),
                )

        with engine.connect() as connection:
            row = (
                connection.execute(
                    text(
                        "SELECT id::text, coin, exchange_order_id, status, raw_response "
                        "FROM hyperliquid_execution_orders"
                    )
                )
                .mappings()
                .one()
            )
        assert row["id"] == first_id
        assert row["coin"] == "NVDA"
        assert row["exchange_order_id"] == "123"
        assert row["status"] == "filled"
        assert row["raw_response"] == {"status": "accepted-again"}
    finally:
        engine.dispose()
        with admin_engine.begin() as connection:
            connection.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        admin_engine.dispose()
