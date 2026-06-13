from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from typing import Any

from sqlalchemy.orm import Session

PAPER_ROUTE_MATERIALIZATION_SCHEMA_VERSION: str
PAPER_ROUTE_MATERIALIZATION_ACCOUNT_LABEL: str
PAPER_ROUTE_MATERIALIZATION_STAGE: str
PAPER_ROUTE_MATERIALIZATION_SOURCE: str
PAPER_ROUTE_MATERIALIZATION_FINAL_PROMOTION_BLOCKERS: tuple[str, ...]
PAPER_ROUTE_MATERIALIZATION_HPAIRS_HYPOTHESIS_ID: str
PAPER_ROUTE_TARGET_NOTIONAL_SOURCE_DECISION_SEED_QTY: Decimal

class PaperRouteTargetPlanFetchClient:
    http_connection: type[HTTPConnection]
    https_connection: type[HTTPSConnection]

def mapping_items(value: object) -> list[dict[str, Any]]: ...
def paper_route_target_plan_targets(
    plan: Mapping[str, Any],
) -> list[dict[str, Any]]: ...
def paper_route_target_plan_from_payload(
    payload: Mapping[str, Any],
) -> dict[str, Any]: ...
def fetch_paper_route_target_plan_url(
    url: str,
    *,
    timeout_seconds: float,
    attempts: int = 1,
    retry_backoff_seconds: float = 0.25,
) -> dict[str, Any]: ...
def paper_route_target_plan_probe_symbols(plan: Mapping[str, Any]) -> set[str]: ...
def truthy(value: object) -> bool: ...
def target_identity_keys(target: Mapping[str, Any]) -> set[tuple[str, str]]: ...
def target_plan_selection_score(
    plan: Mapping[str, Any],
    *,
    source_rank: int,
    selected_identity_keys: set[tuple[str, str]],
) -> tuple[int, int, int, int, int, int, int]: ...
def target_source_decision_ready(target: Mapping[str, Any]) -> bool: ...
def target_source_decision_quantities(
    target: Mapping[str, Any],
) -> dict[str, Decimal]: ...
def paper_route_target_execution_capacity_blockers(
    target: Mapping[str, Any],
) -> list[str]: ...
def blocked_target_readiness(blockers: Sequence[str]) -> dict[str, Any]: ...
def paper_route_source_materialization_blockers(
    payload: object,
    *,
    identity: Mapping[str, Any],
) -> list[str]: ...
def paper_route_source_decision_needs_refresh(
    existing: Any,
    *,
    identity: Mapping[str, Any],
) -> bool: ...
def materialize_bounded_paper_route_target_plan(
    session: Session,
    plan: Mapping[str, Any],
    *,
    generated_at: datetime | None = None,
    bounded_notional_limit: Decimal | int | float | str | None = None,
) -> dict[str, Any]: ...

__all__: list[str]
