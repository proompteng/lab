"""Shared data structures for scheduler source collection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, NamedTuple, Protocol

from sqlalchemy.orm import Session

from ....models import Strategy


SourceCollectionAction = Literal["buy", "sell"]


class SourceCollectionState(NamedTuple):
    now: datetime
    target_symbols: set[str]
    target_plan_targets: list[dict[str, Any]]
    normalized_allowed: set[str]
    bounded_sim_owner_active: bool


class SourceCollectionTargetContext(NamedTuple):
    target: dict[str, Any]
    strategy: Strategy
    symbols: list[str]
    symbol_actions: Mapping[str, SourceCollectionAction]
    symbol_quantities: dict[str, Decimal]
    pair_balance_state: str
    window_start: datetime
    window_end: datetime
    target_cap: Decimal


class SourceCollectionMode(NamedTuple):
    source_decision_mode: str
    profit_proof_eligible: bool
    execution_metadata: dict[str, Any]


class SourceCollectionDecisionPayload(NamedTuple):
    params: dict[str, Any]
    qty: Decimal
    timeframe: str


class SourceCollectionResolvedQuantity(NamedTuple):
    qty: Decimal
    audit: Mapping[str, Any]
    price_params: Mapping[str, Any]


class SourceCollectionDecisionRun(NamedTuple):
    session: Session | None
    positions: Sequence[Mapping[str, Any]] | None
    blocked_symbols: set[str]
    seen: set[tuple[str, str, str, str]]
    now: datetime


class SourceCollectionExposure(NamedTuple):
    signed_qty: Decimal
    latest_fill_at: datetime | None


class SourceCollectionActiveWindowSummary(NamedTuple):
    active_targets: list[dict[str, Any]]
    active_windows: list[dict[str, str]]
    window_starts: list[datetime]
    window_ends: list[datetime]


class SourceCollectionQuantityResolution(Protocol):
    @property
    def qty(self) -> Decimal: ...

    @property
    def audit(self) -> Mapping[str, Any]: ...

    @property
    def price_params(self) -> Mapping[str, Any]: ...


class SourceCollectionRuntime(Protocol):
    account_label: str
    _paper_route_target_plan_cache: (
        tuple[set[str], str | None, list[dict[str, Any]], datetime] | None
    )
    _paper_route_target_plan_success_cache: (
        tuple[set[str], list[dict[str, Any]], datetime] | None
    )

    def _trading_now(self) -> datetime: ...

    def _is_market_session_open(self, now: datetime) -> bool: ...

    def _live_submission_gate(
        self,
        *,
        session: Session | None = None,
    ) -> Mapping[str, Any]: ...

    def _fetch_paper_route_target_plan_url(
        self,
        url: str,
        *,
        timeout_seconds: float,
        attempts: int,
        retry_backoff_seconds: float,
    ) -> Mapping[str, Any]: ...

    def _record_bounded_target_plan_blocker(
        self,
        *,
        reason: str,
        symbols: set[str] | None = None,
        targets: Sequence[Mapping[str, Any]] | None = None,
    ) -> None: ...

    def _external_paper_route_target_probe_symbols_cached(
        self,
        *,
        session: Session | None = None,
        strategies: Sequence[Strategy] | None = None,
    ) -> tuple[set[str], str | None, list[dict[str, Any]]]: ...

    @staticmethod
    def _paper_route_target_strategy(
        target: Mapping[str, Any],
        strategies: Sequence[Strategy],
    ) -> Strategy | None: ...

    @staticmethod
    def _paper_route_target_strategy_symbols(strategy: Strategy) -> set[str]: ...

    @staticmethod
    def _paper_route_target_source_decision_metadata(
        **metadata_args: Any,
    ) -> dict[str, Any]: ...

    @staticmethod
    def _bounded_paper_route_execution_metadata(
        **metadata_args: Any,
    ) -> dict[str, Any]: ...

    @staticmethod
    def _paper_route_target_source_cap(
        params: Mapping[str, Any],
    ) -> Decimal | None: ...

    def _paper_route_target_quantity_resolution(
        self,
        **resolution_args: Any,
    ) -> SourceCollectionQuantityResolution | None: ...


__all__ = [
    "SourceCollectionActiveWindowSummary",
    "SourceCollectionAction",
    "SourceCollectionDecisionPayload",
    "SourceCollectionDecisionRun",
    "SourceCollectionExposure",
    "SourceCollectionMode",
    "SourceCollectionQuantityResolution",
    "SourceCollectionResolvedQuantity",
    "SourceCollectionRuntime",
    "SourceCollectionState",
    "SourceCollectionTargetContext",
]
