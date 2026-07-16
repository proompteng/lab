"""Exact differential comparison between independent economic projections."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal

from .journal_reducer import reduce_balanced_journal
from .state_reducer import reduce_independent_state
from .types import (
    ZERO,
    EconomicActivity,
    EconomicLedgerError,
    EconomicProjection,
    JournalReduction,
    PositionBalance,
    PreparedActivities,
    canonical_sha256,
    decimal_text,
    prepare_activities,
)


@dataclass(frozen=True, slots=True)
class ProjectionDelta:
    path: str
    canonical: str
    independent: str
    difference: str | None


@dataclass(frozen=True, slots=True)
class ProjectionComparison:
    canonical_reducer: str
    independent_reducer: str
    input_manifest_digest: str
    deltas: tuple[ProjectionDelta, ...]
    comparison_digest: str = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "comparison_digest",
            canonical_sha256(
                {
                    "canonical_reducer": self.canonical_reducer,
                    "deltas": [
                        {
                            "canonical": delta.canonical,
                            "difference": delta.difference,
                            "independent": delta.independent,
                            "path": delta.path,
                        }
                        for delta in self.deltas
                    ],
                    "independent_reducer": self.independent_reducer,
                    "input_manifest_digest": self.input_manifest_digest,
                }
            ),
        )

    @property
    def equivalent(self) -> bool:
        return not self.deltas


@dataclass(frozen=True, slots=True)
class DualReduction:
    journal: JournalReduction
    independent: EconomicProjection
    comparison: ProjectionComparison

    @property
    def admissible(self) -> bool:
        return (
            self.journal.projection.admissible
            and self.independent.admissible
            and self.comparison.equivalent
        )


def compare_projections(
    canonical: EconomicProjection,
    independent: EconomicProjection,
) -> ProjectionComparison:
    """Compare two projections of the exact same immutable input with no tolerance."""

    if (
        canonical.scope != independent.scope
        or canonical.input_manifest_digest != independent.input_manifest_digest
        or canonical.input_count != independent.input_count
        or canonical.duplicate_count != independent.duplicate_count
        or canonical.corrected_count != independent.corrected_count
    ):
        raise EconomicLedgerError("economic_projection_inputs_do_not_match")

    deltas: list[ProjectionDelta] = []
    canonical_cash = {item.commodity: item.amount for item in canonical.cash}
    independent_cash = {item.commodity: item.amount for item in independent.cash}
    for commodity in sorted(set(canonical_cash) | set(independent_cash)):
        _append_decimal_delta(
            deltas,
            path=f"cash.{commodity}",
            canonical=canonical_cash.get(commodity, ZERO),
            independent=independent_cash.get(commodity, ZERO),
        )

    canonical_positions = {item.symbol: item for item in canonical.positions}
    independent_positions = {item.symbol: item for item in independent.positions}
    for symbol in sorted(set(canonical_positions) | set(independent_positions)):
        canonical_position = canonical_positions.get(symbol) or _zero_position(symbol)
        independent_position = independent_positions.get(symbol) or _zero_position(
            symbol
        )
        _append_decimal_delta(
            deltas,
            path=f"positions.{symbol}.quantity",
            canonical=canonical_position.quantity,
            independent=independent_position.quantity,
        )
        _append_decimal_delta(
            deltas,
            path=f"positions.{symbol}.signed_cost",
            canonical=canonical_position.signed_cost,
            independent=independent_position.signed_cost,
        )

    for field_name in (
        "realized_pnl",
        "cash_rounding",
        "fees",
        "dividends",
        "interest",
        "external_flows",
    ):
        _append_decimal_delta(
            deltas,
            path=field_name,
            canonical=getattr(canonical, field_name),
            independent=getattr(independent, field_name),
        )
    if canonical.unsupported_activity_ids != independent.unsupported_activity_ids:
        deltas.append(
            ProjectionDelta(
                path="unsupported_activity_ids",
                canonical=",".join(canonical.unsupported_activity_ids),
                independent=",".join(independent.unsupported_activity_ids),
                difference=None,
            )
        )
    return ProjectionComparison(
        canonical_reducer=f"{canonical.reducer_name}:{canonical.reducer_version}",
        independent_reducer=f"{independent.reducer_name}:{independent.reducer_version}",
        input_manifest_digest=canonical.input_manifest_digest,
        deltas=tuple(deltas),
    )


def reduce_and_compare(
    activities: PreparedActivities
    | tuple[EconomicActivity, ...]
    | list[EconomicActivity],
) -> DualReduction:
    prepared = (
        activities
        if isinstance(activities, PreparedActivities)
        else prepare_activities(activities)
    )
    journal = reduce_balanced_journal(prepared)
    independent = reduce_independent_state(prepared)
    return DualReduction(
        journal=journal,
        independent=independent,
        comparison=compare_projections(journal.projection, independent),
    )


def _append_decimal_delta(
    deltas: list[ProjectionDelta],
    *,
    path: str,
    canonical: Decimal,
    independent: Decimal,
) -> None:
    difference = canonical - independent
    if difference == ZERO:
        return
    deltas.append(
        ProjectionDelta(
            path=path,
            canonical=decimal_text(canonical) or "0",
            independent=decimal_text(independent) or "0",
            difference=decimal_text(difference),
        )
    )


def _zero_position(symbol: str) -> PositionBalance:
    return PositionBalance(symbol=symbol, quantity=ZERO, signed_cost=ZERO)


__all__ = (
    "DualReduction",
    "ProjectionComparison",
    "ProjectionDelta",
    "compare_projections",
    "reduce_and_compare",
)
