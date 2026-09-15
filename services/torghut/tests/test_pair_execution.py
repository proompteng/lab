from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.config import settings
from app.trading.models import StrategyDecision
from app.trading.portfolio import (
    AllocationResult,
    PortfolioSizer,
    PortfolioSizingConfig,
)
from app.trading.scheduler.pair_execution import reserve_pair_allocations
from app.trading.scheduler.pipeline.support import allocator_rejection_reasons


def _allocation(
    *,
    symbol: str,
    action: str,
    pair_side: str,
    notional: Decimal,
    event_ts: datetime | None = None,
    pair_side_count: int = 1,
) -> AllocationResult:
    price = Decimal("100")
    decision = StrategyDecision(
        strategy_id="pairs-v1",
        symbol=symbol,
        event_ts=event_ts or datetime(2026, 7, 10, 14, 0, tzinfo=timezone.utc),
        timeframe="1Min",
        action=action,
        qty=notional / price,
        order_type="limit",
        limit_price=price,
        rationale=(
            "microbar_cross_sectional_pair_entry,"
            f"pair_side:{pair_side},pair_side_count:{pair_side_count},"
            f"max_pair_legs:{pair_side_count * 2},selection_mode:continuation"
        ),
        params={
            "price": str(price),
            "allocator": {"approved": True},
        },
    )
    return AllocationResult(
        decision=decision,
        approved=True,
        clipped=False,
        reason_codes=(),
        regime_label="normal",
        fragility_state="normal",
        fragility_score=Decimal("0"),
        stability_mode_active=False,
        budget_multiplier=Decimal("1"),
        capacity_multiplier=Decimal("1"),
        requested_notional=notional,
        approved_notional=notional,
    )


def test_pair_reservation_sets_equal_dollar_legs_and_reserves_buying_power() -> None:
    original = (
        settings.trading_simple_max_gross_exposure_pct_equity,
        settings.trading_simple_max_symbol_pct_equity,
        settings.trading_simple_buying_power_reserve_bps,
    )
    try:
        settings.trading_simple_max_gross_exposure_pct_equity = 4.0
        settings.trading_simple_max_symbol_pct_equity = 0.5
        settings.trading_simple_buying_power_reserve_bps = 1000.0
        groups = reserve_pair_allocations(
            [
                _allocation(
                    symbol="NVDA",
                    action="buy",
                    pair_side="high_rank",
                    notional=Decimal("25000"),
                ),
                _allocation(
                    symbol="AMD",
                    action="sell",
                    pair_side="low_rank",
                    notional=Decimal("30000"),
                ),
            ],
            account={"equity": "40000", "buying_power": "100000"},
            positions=[],
        )
    finally:
        (
            settings.trading_simple_max_gross_exposure_pct_equity,
            settings.trading_simple_max_symbol_pct_equity,
            settings.trading_simple_buying_power_reserve_bps,
        ) = original

    assert len(groups) == 1
    reserved = groups[0]
    assert all(item.approved for item in reserved)
    assert {item.approved_notional for item in reserved} == {Decimal("20000.0")}
    assert (
        len({item.decision.params["pair_execution"]["group_id"] for item in reserved})
        == 1
    )


def test_pair_reservation_rejects_a_single_unhedged_leg() -> None:
    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="NVDA",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("10000"),
            )
        ],
        account={"equity": "40000", "buying_power": "100000"},
        positions=[],
    )

    allocation = groups[0][0]
    assert not allocation.approved
    assert "pair_opposite_leg_missing" in allocation.reason_codes
    assert allocation.decision.params["allocator"]["approved"] is False
    assert allocation.decision.params["allocator"]["status"] == "rejected"
    assert allocator_rejection_reasons(allocation.decision) == [
        "pair_opposite_leg_missing"
    ]


def test_pair_reservation_scopes_groups_by_signal_timestamp() -> None:
    first_event = datetime(2026, 7, 10, 14, 0, tzinfo=timezone.utc)
    second_event = datetime(2026, 7, 10, 14, 1, tzinfo=timezone.utc)

    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="NVDA",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("10000"),
                event_ts=first_event,
            ),
            _allocation(
                symbol="AMD",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("10000"),
                event_ts=first_event,
            ),
            _allocation(
                symbol="NVDA",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("10000"),
                event_ts=second_event,
            ),
            _allocation(
                symbol="AMD",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("10000"),
                event_ts=second_event,
            ),
        ],
        account={"equity": "40000", "buying_power": "100000"},
        positions=[],
    )

    assert len(groups) == 2
    assert all(len(group) == 2 for group in groups)
    assert all(item.approved for group in groups for item in group)
    group_ids = {
        item.decision.params["pair_execution"]["group_id"]
        for group in groups
        for item in group
    }
    assert len(group_ids) == 2


def test_pair_reservation_matches_staggered_legs_within_poll_interval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "trading_poll_ms", 5000)
    first_event = datetime(2026, 7, 10, 14, 30, tzinfo=timezone.utc)

    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="AAPL",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("10000"),
                event_ts=first_event,
            ),
            _allocation(
                symbol="AMZN",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("10000"),
                event_ts=first_event + timedelta(seconds=1),
            ),
        ],
        account={"equity": "40000", "buying_power": "100000"},
        positions=[],
    )

    assert len(groups) == 1
    assert all(item.approved for item in groups[0])
    assert {item.decision.symbol for item in groups[0]} == {"AAPL", "AMZN"}


def test_pair_reservation_matches_nearest_legs_across_staggered_epochs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "trading_poll_ms", 5000)
    first_event = datetime(2026, 7, 10, 14, 30, tzinfo=timezone.utc)

    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="AAPL",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("10000"),
                event_ts=first_event,
            ),
            _allocation(
                symbol="NVDA",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("10000"),
                event_ts=first_event + timedelta(seconds=1),
            ),
            _allocation(
                symbol="AMD",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("10000"),
                event_ts=first_event + timedelta(seconds=1),
            ),
            _allocation(
                symbol="AMZN",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("10000"),
                event_ts=first_event + timedelta(seconds=2),
            ),
        ],
        account={"equity": "40000", "buying_power": "100000"},
        positions=[],
    )

    assert len(groups) == 2
    assert all(len(group) == 2 for group in groups)
    assert all(item.approved for group in groups for item in group)
    assert [{item.decision.symbol for item in group} for group in groups] == [
        {"AAPL", "AMZN"},
        {"NVDA", "AMD"},
    ]


def test_pair_reservation_rejects_legs_beyond_poll_interval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "trading_poll_ms", 5000)
    first_event = datetime(2026, 7, 10, 14, 30, tzinfo=timezone.utc)

    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="AAPL",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("10000"),
                event_ts=first_event,
            ),
            _allocation(
                symbol="AMZN",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("10000"),
                event_ts=first_event + timedelta(seconds=6),
            ),
        ],
        account={"equity": "40000", "buying_power": "100000"},
        positions=[],
    )

    assert len(groups) == 2
    assert not any(item.approved for group in groups for item in group)
    assert all(
        "pair_opposite_leg_missing" in item.reason_codes
        for group in groups
        for item in group
    )


def test_pair_reservation_rejects_incomplete_multi_pair_cohort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "trading_poll_ms", 5000)

    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="AAPL",
                action="buy",
                pair_side="high_rank",
                pair_side_count=2,
                notional=Decimal("10000"),
            ),
            _allocation(
                symbol="AMZN",
                action="sell",
                pair_side="low_rank",
                pair_side_count=2,
                notional=Decimal("10000"),
            ),
        ],
        account={"equity": "40000", "buying_power": "100000"},
        positions=[],
    )

    assert len(groups) == 1
    assert not any(item.approved for item in groups[0])
    assert all("pair_leg_count_incomplete" in item.reason_codes for item in groups[0])


@pytest.mark.parametrize(
    (
        "gross_limit",
        "symbol_limit",
        "reserve_bps",
        "buying_power",
        "symbols",
        "expected_first_notional",
    ),
    [
        (4.0, 0.5, 0.0, "200000", ("NVDA", "AMD"), Decimal("20000")),
        (1.0, 1.0, 0.0, "200000", ("MU", "AVGO"), Decimal("20000")),
        (4.0, 1.0, 1000.0, "40000", ("MU", "AVGO"), Decimal("18000")),
    ],
    ids=("symbol", "gross", "buying-power"),
)
def test_pair_reservations_carry_capacity_across_epochs(
    monkeypatch: pytest.MonkeyPatch,
    gross_limit: float,
    symbol_limit: float,
    reserve_bps: float,
    buying_power: str,
    symbols: tuple[str, str],
    expected_first_notional: Decimal,
) -> None:
    monkeypatch.setattr(
        settings, "trading_simple_max_gross_exposure_pct_equity", gross_limit
    )
    monkeypatch.setattr(settings, "trading_simple_max_symbol_pct_equity", symbol_limit)
    monkeypatch.setattr(
        settings, "trading_simple_buying_power_reserve_bps", reserve_bps
    )
    first_event = datetime(2026, 7, 10, 14, 0, tzinfo=timezone.utc)
    second_event = datetime(2026, 7, 10, 14, 1, tzinfo=timezone.utc)

    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="NVDA",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("20000"),
                event_ts=first_event,
            ),
            _allocation(
                symbol="AMD",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("20000"),
                event_ts=first_event,
            ),
            _allocation(
                symbol=symbols[0],
                action="buy",
                pair_side="high_rank",
                notional=Decimal("20000"),
                event_ts=second_event,
            ),
            _allocation(
                symbol=symbols[1],
                action="sell",
                pair_side="low_rank",
                notional=Decimal("20000"),
                event_ts=second_event,
            ),
        ],
        account={"equity": "40000", "buying_power": buying_power},
        positions=[],
    )

    assert all(item.approved for item in groups[0])
    assert {item.approved_notional for item in groups[0]} == {expected_first_notional}
    assert not any(item.approved for item in groups[1])
    assert all(
        "pair_capital_reservation_unavailable" in item.reason_codes
        for item in groups[1]
    )


def test_pair_reservation_submits_the_net_reducing_leg_first() -> None:
    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="NVDA",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("20000"),
            ),
            _allocation(
                symbol="AMD",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("20000"),
            ),
        ],
        account={"equity": "40000", "buying_power": "100000"},
        positions=[
            {
                "symbol": "MU",
                "qty": "100",
                "side": "long",
                "market_value": "10000",
            }
        ],
    )

    assert [item.decision.action for item in groups[0]] == ["sell", "buy"]


def test_pair_sizing_reserves_net_exposure_for_the_group_not_each_leg() -> None:
    sizer = PortfolioSizer(
        PortfolioSizingConfig(
            notional_per_position=None,
            volatility_target=None,
            volatility_floor=Decimal("0"),
            max_positions=None,
            max_notional_per_symbol=None,
            max_position_pct_equity=Decimal("0.5"),
            max_gross_exposure=Decimal("160000"),
            max_net_exposure=Decimal("20000"),
        )
    )
    buy_leg = _allocation(
        symbol="NVDA",
        action="buy",
        pair_side="high_rank",
        notional=Decimal("20000"),
    ).decision

    result = sizer.size(
        buy_leg,
        account={"equity": "40000"},
        positions=[
            {
                "symbol": "MU",
                "qty": "100",
                "side": "long",
                "market_value": "20000",
            }
        ],
    )

    assert result.approved
    assert "cap_net_exposure_zero" not in result.audit["output"]["methods"]


def test_pair_reservation_rejects_new_risk_when_existing_net_is_over_limit() -> None:
    groups = reserve_pair_allocations(
        [
            _allocation(
                symbol="NVDA",
                action="buy",
                pair_side="high_rank",
                notional=Decimal("20000"),
            ),
            _allocation(
                symbol="AMD",
                action="sell",
                pair_side="low_rank",
                notional=Decimal("20000"),
            ),
        ],
        account={"equity": "40000", "buying_power": "100000"},
        positions=[
            {
                "symbol": "MU",
                "qty": "100",
                "side": "long",
                "market_value": "25000",
            }
        ],
    )

    assert not any(item.approved for item in groups[0])
    assert all(
        "pair_capital_reservation_unavailable" in item.reason_codes
        for item in groups[0]
    )
