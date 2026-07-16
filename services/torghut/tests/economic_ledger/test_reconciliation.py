from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.trading.economic_ledger import (
    BrokerEconomicLedgerReplay,
    BrokerEconomicLedgerSnapshot,
    BrokerEconomicReconciliationBuild,
    EconomicActivity,
    EconomicLedgerError,
    LedgerScope,
    PublishedBrokerEconomicLedgerRuns,
    normalize_broker_economic_snapshot,
    prepare_activities,
    reconcile_broker_economic_ledger,
    reduce_and_compare,
)


_AT = datetime(2026, 7, 16, 14, 0, tzinfo=timezone.utc)
_COMMIT = "a" * 40
_IMAGE = f"sha256:{'b' * 64}"
_BUILD = BrokerEconomicReconciliationBuild(
    source_commit=_COMMIT,
    image_digest=_IMAGE,
)
_SCOPE = LedgerScope(
    provider="alpaca",
    environment="paper",
    account_label="paper-account",
    endpoint_fingerprint="c" * 64,
)
_RUNS = PublishedBrokerEconomicLedgerRuns(
    input_id=uuid.uuid4(),
    journal_run_id=uuid.uuid4(),
    state_run_id=uuid.uuid4(),
    source_watermark=_AT,
    reused_existing=True,
)


def _activity(
    external_id: str,
    activity_type: str,
    *,
    offset: int,
    symbol: str | None = None,
    side: str | None = None,
    quantity: str | None = None,
    price: str | None = None,
    net_amount: str | None = None,
) -> EconomicActivity:
    return EconomicActivity(
        scope=_SCOPE,
        external_activity_id=external_id,
        raw_payload_sha256=f"{offset + 1:064x}",
        activity_type=activity_type,
        first_observed_at=_AT + timedelta(seconds=offset),
        event_at=_AT + timedelta(seconds=offset),
        symbol=symbol,
        side=side,
        quantity=Decimal(quantity) if quantity is not None else None,
        price=Decimal(price) if price is not None else None,
        net_amount=Decimal(net_amount) if net_amount is not None else None,
        currency="USD",
    )


def _replay(*activities: EconomicActivity) -> BrokerEconomicLedgerReplay:
    prepared = prepare_activities(activities)
    ordered_manifest = [
        activity.manifest_payload()
        for activity in sorted(activities, key=lambda item: item.sort_key)
    ]
    snapshot = BrokerEconomicLedgerSnapshot(
        cursor_id=uuid.uuid4(),
        source_watermark=_AT + timedelta(minutes=1),
        prepared=prepared,
        activities=activities,
        input_manifest_canonical_json=json.dumps(
            ordered_manifest, sort_keys=True, separators=(",", ":")
        ),
    )
    return BrokerEconomicLedgerReplay(
        snapshot=snapshot,
        reduction=reduce_and_compare(prepared),
        publication_token=f"publish:{'d' * 64}",
    )


def _flat_replay() -> BrokerEconomicLedgerReplay:
    return _replay(
        _activity("cash", "CSD", offset=0, net_amount="1000"),
        _activity(
            "buy",
            "FILL",
            offset=1,
            symbol="AAPL",
            side="buy",
            quantity="1",
            price="100",
        ),
        _activity(
            "sell",
            "FILL",
            offset=2,
            symbol="AAPL",
            side="sell",
            quantity="1",
            price="110",
        ),
        _activity("fee", "FEE", offset=3, net_amount="-1"),
    )


def _snapshot(
    *,
    cash: str,
    equity: str,
    positions: object = (),
    open_orders: object = (),
    observed_at: datetime | None = None,
):
    return normalize_broker_economic_snapshot(
        account={"status": "ACTIVE", "cash": cash, "equity": equity},
        positions=positions,
        open_orders=open_orders,
        observed_at=observed_at or _AT + timedelta(minutes=2),
    )


def _result(replay: BrokerEconomicLedgerReplay, snapshot, *, max_age: int = 300):
    return reconcile_broker_economic_ledger(
        replay,
        snapshot,
        runs=_RUNS,
        build=_BUILD,
        max_source_age_seconds=max_age,
    )


def test_flat_projection_reconciles_exactly_to_fresh_broker_snapshot() -> None:
    result = _result(_flat_replay(), _snapshot(cash="1009", equity="1009"))

    assert result.reconciled is True
    assert result.residual_count == 0
    assert result.open_order_count == 0
    assert result.payload["reason_codes"] == []
    assert result.payload["input_source_watermark"] == _AT.isoformat()
    assert (
        result.payload["source_watermark"] == (_AT + timedelta(minutes=1)).isoformat()
    )
    assert len(result.result_sha256) == 64


def test_ledger_dust_and_missing_fresh_mark_remain_explicit_blockers() -> None:
    replay = _replay(
        _activity("cash", "CSD", offset=0, net_amount="1000"),
        _activity(
            "buy",
            "FILL",
            offset=1,
            symbol="BTCUSD",
            side="buy",
            quantity="0.0000100",
            price="50000",
        ),
        _activity(
            "partial-sell",
            "FILL",
            offset=2,
            symbol="BTCUSD",
            side="sell",
            quantity="0.0000044",
            price="50000",
        ),
    )
    projection = replay.reduction.journal.projection
    ledger_cash = next(
        item.amount for item in projection.cash if item.commodity == "USD"
    )

    result = _result(
        replay,
        _snapshot(cash=str(ledger_cash), equity=str(ledger_cash)),
    )

    assert result.reconciled is False
    assert set(result.payload["reason_codes"]) == {
        "ledger_position_fresh_mark_missing",
        "ledger_position_missing_from_broker",
    }
    residuals = result.payload["residuals"]
    assert isinstance(residuals, list)
    assert {row["path"] for row in residuals} == {
        "positions.BTCUSD.current_price",
        "positions.BTCUSD.quantity",
    }


def test_open_orders_and_stale_source_are_classified_without_mutation() -> None:
    snapshot = _snapshot(
        cash="1009",
        equity="1009",
        open_orders=[
            {
                "id": "order-1",
                "client_order_id": "client-1",
                "symbol": "AAPL",
                "side": "buy",
                "qty": "1",
                "filled_qty": "0",
                "status": "accepted",
                "type": "limit",
            }
        ],
        observed_at=_AT + timedelta(minutes=11),
    )

    result = _result(_flat_replay(), snapshot, max_age=300)

    assert result.open_order_count == 1
    assert set(result.payload["reason_codes"]) == {
        "broker_open_orders_present",
        "economic_source_watermark_stale",
    }


def test_position_cost_and_unrealized_differences_are_not_tolerated() -> None:
    replay = _replay(
        _activity("cash", "CSD", offset=0, net_amount="1000"),
        _activity(
            "buy",
            "FILL",
            offset=1,
            symbol="AAPL",
            side="buy",
            quantity="1",
            price="100",
        ),
    )
    snapshot = _snapshot(
        cash="900",
        equity="1010",
        positions=[
            {
                "symbol": "AAPL",
                "side": "long",
                "qty": "1",
                "avg_entry_price": "101",
                "current_price": "110",
                "market_value": "110",
                "unrealized_pl": "9",
            }
        ],
    )

    result = _result(replay, snapshot)

    assert set(result.payload["reason_codes"]) == {
        "broker_position_cost_basis_mismatch",
        "broker_unrealized_pnl_mismatch",
    }


def test_option_position_reconciliation_uses_contract_notional() -> None:
    symbol = "AMZN260529P00270000"
    replay = _replay(
        _activity("cash", "CSD", offset=0, net_amount="1000"),
        _activity(
            "buy",
            "FILL",
            offset=1,
            symbol=symbol,
            side="buy",
            quantity="2",
            price="1.05",
        ),
    )
    snapshot = _snapshot(
        cash="790",
        equity="1030",
        positions=[
            {
                "symbol": symbol,
                "side": "long",
                "qty": "2",
                "avg_entry_price": "1.05",
                "current_price": "1.20",
                "market_value": "240",
                "unrealized_pl": "30",
            }
        ],
    )

    result = _result(replay, snapshot)

    assert result.reconciled is True
    assert result.residual_count == 0


def test_broker_snapshot_rejects_duplicate_positions_and_incomplete_orders() -> None:
    position = {
        "symbol": "AAPL",
        "side": "long",
        "qty": "1",
        "avg_entry_price": "100",
        "current_price": "110",
        "market_value": "110",
        "unrealized_pl": "10",
    }
    with pytest.raises(
        EconomicLedgerError,
        match="economic_broker_position_duplicate_symbol",
    ):
        _snapshot(cash="900", equity="1010", positions=[position, position])
    with pytest.raises(EconomicLedgerError, match="economic_broker_order_type_invalid"):
        _snapshot(
            cash="1009",
            equity="1009",
            open_orders=[
                {
                    "id": "order-1",
                    "symbol": "AAPL",
                    "side": "buy",
                    "qty": "1",
                    "status": "accepted",
                }
            ],
        )


def test_reconciliation_rejects_unverifiable_build_identity() -> None:
    with pytest.raises(
        EconomicLedgerError,
        match="economic_reconciliation_source_commit_invalid",
    ):
        reconcile_broker_economic_ledger(
            _flat_replay(),
            _snapshot(cash="1009", equity="1009"),
            runs=_RUNS,
            build=BrokerEconomicReconciliationBuild(
                source_commit="unknown",
                image_digest=_IMAGE,
            ),
        )
