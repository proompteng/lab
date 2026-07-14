from app.options_lane.subscription_reconciliation import (
    plan_provisional_subscription_reconciliation,
)


def _ranked_row(symbol: str) -> dict[str, object]:
    return {"contract_symbol": symbol, "tier": "hot"}


def test_provisional_plan_never_displaces_protected_seed() -> None:
    plan = plan_provisional_subscription_reconciliation(
        [_ranked_row("NEW-BEST"), _ranked_row("SEED-HOT"), _ranked_row("SEED-WARM")],
        protected_hot_symbols={"SEED-HOT"},
        protected_warm_symbols={"SEED-WARM"},
        previously_owned_symbols={"OLD-CYCLE"},
        hot_limit=1,
        warm_limit=2,
    )

    assert plan.ranked_rows == [{"contract_symbol": "NEW-BEST", "tier": "warm"}]
    assert plan.deactivate_symbols == {"OLD-CYCLE"}
    assert plan.owned_symbols == {"NEW-BEST"}


def test_provisional_plan_uses_full_capacity_during_bootstrap() -> None:
    plan = plan_provisional_subscription_reconciliation(
        [_ranked_row("A"), _ranked_row("B"), _ranked_row("C"), _ranked_row("D")],
        protected_hot_symbols=set(),
        protected_warm_symbols=set(),
        previously_owned_symbols={"D"},
        hot_limit=2,
        warm_limit=1,
    )

    assert [(row["contract_symbol"], row["tier"]) for row in plan.ranked_rows] == [
        ("A", "hot"),
        ("B", "hot"),
        ("C", "warm"),
    ]
    assert plan.deactivate_symbols == {"D"}
