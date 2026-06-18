"""Paper-route target-plan parsing and materialization helpers."""

from __future__ import annotations

from .materialization import (
    blocked_target_readiness,
    materialize_bounded_paper_route_target_plan,
    paper_route_target_execution_capacity_blockers,
    paper_route_source_decision_needs_refresh,
    paper_route_source_materialization_blockers,
)
from .target_plan import (
    PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL,
    PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS,
    PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID,
    PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION,
    PAPER_ROUTE_MATERIALIZATION_SOURCE,
    PAPER_ROUTE_MATERIALIZATION_STAGE,
    PAPER_ROUTE_TARGET_NOTIONAL_SOURCE_DECISION_SEED_QTY,
    PaperRouteTargetPlanFetchClient,
    fetch_paper_route_target_plan_url,
    mapping_items,
    paper_route_target_plan_from_payload,
    paper_route_target_plan_probe_symbols,
    paper_route_target_plan_targets,
    target_identity_keys,
    target_plan_selection_score,
    target_source_decision_quantities,
    target_source_decision_ready,
    truthy,
)

__all__ = [
    "PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL",
    "PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS",
    "PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID",
    "PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION",
    "PAPER_ROUTE_MATERIALIZATION_SOURCE",
    "PAPER_ROUTE_MATERIALIZATION_STAGE",
    "PAPER_ROUTE_TARGET_NOTIONAL_SOURCE_DECISION_SEED_QTY",
    "PaperRouteTargetPlanFetchClient",
    "blocked_target_readiness",
    "fetch_paper_route_target_plan_url",
    "mapping_items",
    "materialize_bounded_paper_route_target_plan",
    "paper_route_target_execution_capacity_blockers",
    "paper_route_source_decision_needs_refresh",
    "paper_route_source_materialization_blockers",
    "paper_route_target_plan_from_payload",
    "paper_route_target_plan_probe_symbols",
    "paper_route_target_plan_targets",
    "target_identity_keys",
    "target_plan_selection_score",
    "target_source_decision_quantities",
    "target_source_decision_ready",
    "truthy",
]
