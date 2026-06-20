"""Typed payload contract for the Torghut proof API."""

from __future__ import annotations

from typing import Literal, TypedDict

PROOFS_SCHEMA_VERSION = "torghut.proofs.v1"
DEFAULT_PROOFS_LIMIT = 20
MAX_PROOFS_LIMIT = 20
DEFAULT_PROOFS_LOOKBACK_HOURS = 72
MAX_PROOFS_LOOKBACK_HOURS = 168
PROOFS_RUNTIME_ACCOUNT_LABEL = "TORGHUT_SIM"
PROOFS_ACCOUNT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS = 300
PROOFS_ACCOUNT_PRE_SESSION_READINESS_SECONDS = 900
PROOFS_ACCOUNT_CLOSE_SNAPSHOT_STALE_SECONDS = 3600

ProofKind = Literal["runtime_window"]
ProofWindowSelector = Literal["next", "latest_closed", "auto"]
ProofState = Literal[
    "no_target",
    "waiting_for_session",
    "collecting",
    "import_due",
    "proof_ready",
    "blocked",
]


class ProofWindowPayload(TypedDict):
    selector: ProofWindowSelector
    start: str
    end: str
    closed: bool


class PromotionAuthorityPayload(TypedDict):
    allowed: bool
    final_promotion_allowed: bool
    reason: str
    blockers: list[str]


class ProofIdentityPayload(TypedDict, total=False):
    hypothesis_id: str | None
    candidate_id: str | None
    strategy_family: str | None
    strategy_name: str | None
    runtime_strategy_name: str | None
    account_label: str
    source_account_label: str | None
    source_kind: str | None
    source_plan_ref: str | None
    target_notional: str | None
    target_symbol_actions: dict[str, str]
    target_symbol_quantities: dict[str, str]
    source_decision_mode: str | None


class SourceCountsPayload(TypedDict):
    decisions: int
    executions: int
    order_events: int
    execution_tca_metrics: int
    rejected_signal_events: int


class RuntimeLedgerPayload(TypedDict):
    materialized: bool
    bucket_count: int
    refs: list[dict[str, object]]
    decision_count: int
    submitted_order_count: int
    fill_count: int
    closed_trade_count: int
    open_position_count: int
    filled_notional: str | None
    cost_amount: str | None
    net_strategy_pnl_after_costs: str | None
    pnl_basis: str | None
    blockers: list[str]


class AccountStatePayload(TypedDict):
    clean_baseline: bool | None
    clean_baseline_snapshot_at: str | None
    closed_flat: bool | None
    close_snapshot_at: str | None
    contamination_count: int
    close_position_count: int | None
    blockers: list[str]


class HealthPayload(TypedDict):
    dependency_quorum_ok: bool
    continuity_ok: bool
    drift_ok: bool
    blockers: list[str]


class ProofPayload(TypedDict):
    proof_id: str
    identity: ProofIdentityPayload
    window: ProofWindowPayload
    symbols: list[str]
    source_counts: SourceCountsPayload
    runtime_ledger: RuntimeLedgerPayload
    account_state: AccountStatePayload
    health: HealthPayload
    post_cost_pnl_basis: str | None
    post_cost_pnl_value: str | None
    state: ProofState
    blockers: list[str]
    next_action: str


class ProofSummaryPayload(TypedDict):
    target_count: int
    proof_count: int
    state_counts: dict[str, int]
    blocker_counts: dict[str, int]
    ready_count: int
    import_due_count: int
    blocked_count: int


class ProofsPayload(TypedDict):
    schema_version: str
    generated_at: str
    kind: ProofKind
    window: dict[str, object]
    proofs: list[ProofPayload]
    summary: ProofSummaryPayload
    promotion_authority: PromotionAuthorityPayload
