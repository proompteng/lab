from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from app.trading.risk_reduction import (
    BrokerPositionObservation,
    BrokerReductionSnapshot,
    ClosePositionPlan,
    PositionCloseLeg,
    RiskReductionPermitError,
    authorize_risk_reduction,
)


NOW = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)


def _snapshot(quantity: Decimal, mark: Decimal) -> BrokerReductionSnapshot:
    return BrokerReductionSnapshot(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint="b" * 64,
        observed_at=NOW,
        complete=True,
        positions=(BrokerPositionObservation("AAPL", quantity, mark),),
    )


@pytest.mark.property
@given(
    position=st.integers(min_value=-1_000_000, max_value=1_000_000).filter(
        lambda value: value != 0
    ),
    close=st.integers(min_value=1, max_value=1_000_000),
    mark=st.integers(min_value=1, max_value=1_000_000),
)
def test_authorized_single_position_close_never_flips_or_increases_exposure(
    position: int,
    close: int,
    mark: int,
) -> None:
    close_quantity = min(abs(position), close)
    authorization = authorize_risk_reduction(
        _snapshot(Decimal(position), Decimal(mark)),
        ClosePositionPlan(
            PositionCloseLeg(
                "AAPL",
                "sell" if position > 0 else "buy",
                Decimal(close_quantity),
            )
        ),
        now=NOW,
    )

    permit = authorization.permit
    assert permit.gross_after <= permit.gross_before
    assert abs(permit.net_after) <= abs(permit.net_before)


@pytest.mark.property
@given(
    position=st.integers(min_value=-1_000_000, max_value=1_000_000).filter(
        lambda value: value != 0
    ),
    excess=st.integers(min_value=1, max_value=1_000_000),
)
def test_any_cross_zero_close_is_rejected(position: int, excess: int) -> None:
    with pytest.raises(RiskReductionPermitError, match="flip_or_increase"):
        authorize_risk_reduction(
            _snapshot(Decimal(position), Decimal("1")),
            ClosePositionPlan(
                PositionCloseLeg(
                    "AAPL",
                    "sell" if position > 0 else "buy",
                    Decimal(abs(position) + excess),
                )
            ),
            now=NOW,
        )
