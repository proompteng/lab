"""Paper-route target-plan parsing and materialization helpers."""

from __future__ import annotations

from http.client import HTTPConnection, HTTPSConnection
from typing import Any

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
    fetch_paper_route_target_plan_url as fetch_paper_route_target_plan_url_with_client,
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


def fetch_paper_route_target_plan_url(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]:
    return fetch_paper_route_target_plan_url_with_client(
        url,
        timeout_seconds=timeout_seconds,
        attempts=attempts,
        retry_backoff_seconds=retry_backoff_seconds,
        fetch_client=PaperRouteTargetPlanFetchClient(
            http_connection=HTTPConnection,
            https_connection=HTTPSConnection,
        ),
    )


__all__ = [
    "HTTPConnection",
    "HTTPSConnection",
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
