from app.options_lane.subscription_reconciliation import (
    ProtectedSubscriptionSeed,
    plan_provisional_subscription_reconciliation,
)


def _ranked_row(symbol: str) -> dict[str, object]:
    return {"contract_symbol": symbol, "tier": "hot"}


def test_provisional_plan_never_displaces_protected_seed() -> None:
    plan = plan_provisional_subscription_reconciliation(
        [_ranked_row("NEW-BEST"), _ranked_row("SEED-HOT"), _ranked_row("SEED-WARM")],
        protected_seed=ProtectedSubscriptionSeed(
            hot_symbols=frozenset({"SEED-HOT"}),
            warm_symbols=frozenset({"SEED-WARM"}),
            hot_limit=1,
            warm_limit=2,
        ),
        previously_owned_symbols={"OLD-CYCLE"},
    )

    assert plan.ranked_rows == [{"contract_symbol": "NEW-BEST", "tier": "warm"}]
    assert plan.deactivate_symbols == {"OLD-CYCLE"}
    assert plan.owned_symbols == {"NEW-BEST"}


def test_provisional_plan_uses_full_capacity_during_bootstrap() -> None:
    plan = plan_provisional_subscription_reconciliation(
        [_ranked_row("A"), _ranked_row("B"), _ranked_row("C"), _ranked_row("D")],
        protected_seed=ProtectedSubscriptionSeed(
            hot_symbols=frozenset(),
            warm_symbols=frozenset(),
            hot_limit=2,
            warm_limit=1,
        ),
        previously_owned_symbols={"D"},
    )

    assert [(row["contract_symbol"], row["tier"]) for row in plan.ranked_rows] == [
        ("A", "hot"),
        ("B", "hot"),
        ("C", "warm"),
    ]
    assert plan.deactivate_symbols == {"D"}


def test_provisional_plan_never_owns_or_deactivates_preexisting_cold_rows() -> None:
    seed = ProtectedSubscriptionSeed(
        hot_symbols=frozenset(),
        warm_symbols=frozenset(),
        hot_limit=1,
        warm_limit=0,
        cold_symbols=frozenset({"COLD"}),
    )

    first_plan = plan_provisional_subscription_reconciliation(
        [_ranked_row("COLD"), _ranked_row("FIRST")],
        protected_seed=seed,
        previously_owned_symbols=set(),
    )
    second_plan = plan_provisional_subscription_reconciliation(
        [_ranked_row("COLD"), _ranked_row("SECOND")],
        protected_seed=seed,
        previously_owned_symbols=first_plan.owned_symbols,
    )

    assert first_plan.owned_symbols == {"FIRST"}
    assert second_plan.owned_symbols == {"SECOND"}
    assert second_plan.deactivate_symbols == {"FIRST"}
    assert "COLD" not in second_plan.deactivate_symbols
