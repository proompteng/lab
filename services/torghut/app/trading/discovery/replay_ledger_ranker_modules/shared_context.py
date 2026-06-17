# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Rank exact replay ledger artifacts with runtime-ledger PnL semantics."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast

from app.trading.discovery.adaptive_market_limit_allocation_stress import (
    extract_adaptive_market_limit_allocation_stress,
)
from app.trading.discovery.cluster_lob_features import extract_cluster_lob_features
from app.trading.discovery.lob_reality_gap_stress import (
    extract_lob_reality_gap_stress,
)
from app.trading.discovery.order_book_observability_stress import (
    extract_order_book_observability_stress,
)
from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.models import SignalEnvelope
from app.trading.runtime_ledger import RuntimeLedgerBucket, build_runtime_ledger_buckets

# ruff: noqa: F401


EXACT_REPLAY_LEDGER_RANKING_SCHEMA_VERSION = "torghut.exact-replay-ledger-ranking.v1"

EXECUTION_QUALITY_SCHEMA_VERSION = "torghut.exact-replay-execution-quality.v1"

EXACT_REPLAY_MICROSTRUCTURE_STRESS_SCHEMA_VERSION = (
    "torghut.exact-replay-microstructure-stress.v1"
)

_LIVE_PROMOTION_AUTHORITIES = frozenset(
    {
        "live",
        "live_runtime_ledger",
        "runtime_live",
        "runtime_execution_ledger",
        "live_paper_runtime_ledger",
    }
)

_EXECUTION_QUALITY_SOURCE_PAPERS = (
    {
        "source_id": "arxiv-2601.17247",
        "url": "https://arxiv.org/abs/2601.17247",
        "title": "Learning Market Making with Closing Auctions",
        "mechanism": "closing_auction_projection_clearing_price_terminal_inventory_path",
    },
    {
        "source_id": "rof-rfaf049",
        "url": "https://doi.org/10.1093/rof/rfaf049",
        "title": "Retail Limit Orders",
        "mechanism": "market_limit_order_type_fill_probability_price_improvement_opportunity_cost",
    },
    {
        "source_id": "arxiv-2507.06345",
        "url": "https://arxiv.org/abs/2507.06345",
        "title": "Reinforcement Learning for Trade Execution with Market and Limit Orders",
        "mechanism": "dynamic_market_limit_order_allocation_with_fill_uncertainty",
    },
    {
        "source_id": "arxiv-2512.05734",
        "url": "https://arxiv.org/abs/2512.05734",
        "title": "KANFormer for Predicting Fill Probabilities via Survival Analysis in Limit Order Books",
        "mechanism": "queue_position_time_to_fill_survival_fill_probability",
    },
)


def _payload_object(value: object) -> object:
    from .promotion_blockers import (
        payload_object,
    )

    return payload_object(value)


_ORDER_TYPE_FIELDS = (
    "order_type",
    "order_kind",
    "execution_order_type",
    "execution_type",
    "order_instruction",
    "route_order_type",
    "adjusted_order_type",
    "selected_order_type",
)

_FILL_STATUS_FIELDS = (
    "fill_status",
    "order_fill_status",
    "execution_status",
    "route_fill_status",
    "order_status",
    "status",
)

_EXECUTION_SHORTFALL_FIELDS = (
    "execution_shortfall_bps",
    "realized_shortfall_bps",
    "shortfall_bps",
    "route_tca_bps",
    "arrival_shortfall_bps",
)

_PRICE_IMPROVEMENT_FIELDS = (
    "price_improvement_bps",
    "realized_price_improvement_bps",
    "price_improvement_against_arrival_bps",
)

_OPPORTUNITY_COST_FIELDS = (
    "nonfill_opportunity_cost_bps",
    "opportunity_cost_bps",
    "missed_fill_opportunity_cost_bps",
)

_QUEUE_POSITION_FIELDS = (
    "queue_position",
    "queue_ahead",
    "queue_ahead_qty",
    "queue_ahead_size",
    "queue_rank",
    "limit_queue_position",
    "queue_ratio",
    "queue_ahead_ratio",
    "queue_position_ratio",
)

_LIMIT_FILL_PROBABILITY_FIELDS = (
    "limit_fill_probability",
    "fill_probability",
    "estimated_limit_fill_probability",
    "survival_fill_probability",
)

_CLOSING_WINDOW_FIELDS = (
    "closing_window",
    "is_closing_window",
    "close_window",
    "late_session_window",
)

_CLOSING_AUCTION_FIELDS = (
    "closing_auction",
    "is_closing_auction",
    "closing_auction_participation",
    "close_auction",
)

_CLOSING_AUCTION_PROJECTION_FIELDS = (
    "closing_auction_projection",
    "closing_auction_projected_price",
    "closing_auction_projected_imbalance",
    "projected_closing_auction_price",
)

_CLOSING_AUCTION_CLEARING_PRICE_FIELDS = (
    "closing_auction_clearing_price",
    "closing_auction_reference_price",
    "closing_auction_match_price",
    "closing_price",
)

_TERMINAL_INVENTORY_PATH_FIELDS = (
    "terminal_inventory_path",
    "terminal_inventory_qty",
    "terminal_position_qty",
    "terminal_inventory_gap_share",
)


@dataclass(frozen=True)
class ReplayLedgerRankingPolicy:
    target_net_pnl_per_day: Decimal
    min_window_weekday_count: int
    min_avg_filled_notional_per_day: Decimal
    max_best_day_share: Decimal
    max_gross_exposure_pct_equity: Decimal
    start_equity: Decimal | None

    def to_payload(self) -> dict[str, object]:
        return {
            "target_net_pnl_per_day": str(self.target_net_pnl_per_day),
            "min_window_weekday_count": self.min_window_weekday_count,
            "min_avg_filled_notional_per_day": str(
                self.min_avg_filled_notional_per_day
            ),
            "max_best_day_share": str(self.max_best_day_share),
            "max_gross_exposure_pct_equity": str(self.max_gross_exposure_pct_equity),
            "start_equity": str(self.start_equity)
            if self.start_equity is not None
            else None,
        }


@dataclass(frozen=True)
class ReplayLedgerCandidateRanking:
    artifact_ref: str
    candidate_id: str
    candidate_identity_hash: str
    cost_lineage_hash: str
    promotion_status: str
    promotion_blockers: tuple[str, ...]
    runtime_ledger_blockers: tuple[str, ...]
    window_start: datetime
    window_end: datetime
    window_weekday_count: int
    active_day_count: int
    positive_day_count: int
    negative_day_count: int
    fill_count: int
    decision_count: int
    submitted_order_count: int
    closed_trade_count: int
    open_position_count: int
    total_filled_notional: Decimal
    avg_filled_notional_per_window_weekday: Decimal
    avg_filled_notional_per_active_day: Decimal
    total_net_pnl_after_costs: Decimal
    window_net_pnl_per_day: Decimal
    active_net_pnl_per_day: Decimal
    gross_strategy_pnl: Decimal
    cost_amount: Decimal
    best_day_share: Decimal
    worst_day_net_pnl: Decimal
    max_drawdown: Decimal
    profit_factor: Decimal | None
    max_single_fill_notional: Decimal
    max_single_fill_notional_pct_equity: Decimal | None
    daily_net_pnl_after_costs: Mapping[str, Decimal]
    symbols: tuple[str, ...]
    stage: str
    source: str
    promotion_authority: str
    cost_basis_counts: Mapping[str, int]
    candidate_identity: Mapping[str, object]
    cost_lineage: Mapping[str, object]
    fills_with_adv_notional: int
    fills_with_participation_rate: int
    fills_with_capacity_warning_contract: int
    capacity_warning_counts: Mapping[str, int]
    execution_quality: Mapping[str, object]
    execution_quality_blockers: tuple[str, ...]
    execution_quality_penalty_bps: Decimal
    execution_quality_penalty_amount: Decimal
    execution_quality_adjusted_window_net_pnl_per_day: Decimal
    lob_reality_gap_stress: Mapping[str, object]
    lob_reality_gap_blockers: tuple[str, ...]
    lob_reality_gap_penalty_bps: Decimal
    lob_reality_gap_penalty_amount: Decimal
    microstructure_stress: Mapping[str, object]
    microstructure_stress_blockers: tuple[str, ...]
    microstructure_stress_penalty_bps: Decimal
    microstructure_stress_penalty_amount: Decimal
    replay_quality_adjusted_window_net_pnl_per_day: Decimal

    def to_payload(self) -> dict[str, object]:
        return {
            "artifact_ref": self.artifact_ref,
            "candidate_id": self.candidate_id,
            "candidate_identity_hash": self.candidate_identity_hash,
            "cost_lineage_hash": self.cost_lineage_hash,
            "promotion_status": self.promotion_status,
            "promotion_blockers": list(self.promotion_blockers),
            "runtime_ledger_blockers": list(self.runtime_ledger_blockers),
            "window_start": self.window_start.isoformat(),
            "window_end": self.window_end.isoformat(),
            "window_weekday_count": self.window_weekday_count,
            "active_day_count": self.active_day_count,
            "positive_day_count": self.positive_day_count,
            "negative_day_count": self.negative_day_count,
            "fill_count": self.fill_count,
            "decision_count": self.decision_count,
            "submitted_order_count": self.submitted_order_count,
            "closed_trade_count": self.closed_trade_count,
            "open_position_count": self.open_position_count,
            "total_filled_notional": str(self.total_filled_notional),
            "avg_filled_notional_per_window_weekday": str(
                self.avg_filled_notional_per_window_weekday
            ),
            "avg_filled_notional_per_active_day": str(
                self.avg_filled_notional_per_active_day
            ),
            "total_net_pnl_after_costs": str(self.total_net_pnl_after_costs),
            "window_net_pnl_per_day": str(self.window_net_pnl_per_day),
            "active_net_pnl_per_day": str(self.active_net_pnl_per_day),
            "gross_strategy_pnl": str(self.gross_strategy_pnl),
            "cost_amount": str(self.cost_amount),
            "best_day_share": str(self.best_day_share),
            "worst_day_net_pnl": str(self.worst_day_net_pnl),
            "max_drawdown": str(self.max_drawdown),
            "profit_factor": str(self.profit_factor)
            if self.profit_factor is not None
            else None,
            "max_single_fill_notional": str(self.max_single_fill_notional),
            "max_single_fill_notional_pct_equity": str(
                self.max_single_fill_notional_pct_equity
            )
            if self.max_single_fill_notional_pct_equity is not None
            else None,
            "daily_net_pnl_after_costs": {
                day: str(value)
                for day, value in sorted(self.daily_net_pnl_after_costs.items())
            },
            "symbols": list(self.symbols),
            "stage": self.stage,
            "source": self.source,
            "promotion_authority": self.promotion_authority,
            "cost_basis_counts": dict(sorted(self.cost_basis_counts.items())),
            "candidate_identity": dict(sorted(self.candidate_identity.items())),
            "cost_lineage": dict(sorted(self.cost_lineage.items())),
            "fills_with_adv_notional": self.fills_with_adv_notional,
            "fills_with_participation_rate": self.fills_with_participation_rate,
            "fills_with_capacity_warning_contract": (
                self.fills_with_capacity_warning_contract
            ),
            "capacity_warning_counts": dict(
                sorted(self.capacity_warning_counts.items())
            ),
            "execution_quality": _payload_object(self.execution_quality),
            "execution_quality_blockers": list(self.execution_quality_blockers),
            "execution_quality_penalty_bps": str(self.execution_quality_penalty_bps),
            "execution_quality_penalty_amount": str(
                self.execution_quality_penalty_amount
            ),
            "execution_quality_adjusted_window_net_pnl_per_day": str(
                self.execution_quality_adjusted_window_net_pnl_per_day
            ),
            "lob_reality_gap_stress": _payload_object(self.lob_reality_gap_stress),
            "lob_reality_gap_blockers": list(self.lob_reality_gap_blockers),
            "lob_reality_gap_penalty_bps": str(self.lob_reality_gap_penalty_bps),
            "lob_reality_gap_penalty_amount": str(self.lob_reality_gap_penalty_amount),
            "microstructure_stress": _payload_object(self.microstructure_stress),
            "microstructure_stress_blockers": list(self.microstructure_stress_blockers),
            "microstructure_stress_penalty_bps": str(
                self.microstructure_stress_penalty_bps
            ),
            "microstructure_stress_penalty_amount": str(
                self.microstructure_stress_penalty_amount
            ),
            "replay_quality_adjusted_window_net_pnl_per_day": str(
                self.replay_quality_adjusted_window_net_pnl_per_day
            ),
        }


@dataclass(frozen=True)
class ReplayLedgerRankingFailure:
    artifact_ref: str
    reason: str

    def to_payload(self) -> dict[str, str]:
        return {"artifact_ref": self.artifact_ref, "reason": self.reason}


def default_replay_ledger_ranking_policy(
    *,
    target_net_pnl_per_day: Decimal = Decimal("500"),
    start_equity: Decimal | None = None,
) -> ReplayLedgerRankingPolicy:
    oracle_policy = ProfitTargetOraclePolicy()
    return ReplayLedgerRankingPolicy(
        target_net_pnl_per_day=target_net_pnl_per_day,
        min_window_weekday_count=oracle_policy.min_observed_trading_days,
        min_avg_filled_notional_per_day=oracle_policy.min_avg_filled_notional_per_day,
        max_best_day_share=oracle_policy.max_best_day_share,
        max_gross_exposure_pct_equity=oracle_policy.max_gross_exposure_pct_equity,
        start_equity=start_equity
        if start_equity is not None
        else oracle_policy.default_start_equity,
    )


def rank_replay_ledger_payload(
    payload: Mapping[str, Any],
    *,
    artifact_ref: str,
    policy: ReplayLedgerRankingPolicy,
) -> ReplayLedgerCandidateRanking:
    from .promotion_blockers import (
        candidate_id as _candidate_id,
        capacity_lineage_summary as _capacity_lineage_summary,
        daily_bucket_ranges as _daily_bucket_ranges,
        execution_quality_summary as _execution_quality_summary,
        lob_reality_gap_stress_summary as _lob_reality_gap_stress_summary,
        mapping as _mapping,
        microstructure_stress_summary as _microstructure_stress_summary,
        promotion_blockers as _promotion_blockers,
    )
    from .row_has_fill_status import (
        best_day_share as _best_day_share,
        max_drawdown as _max_drawdown,
        max_single_fill_notional as _max_single_fill_notional,
        profit_factor as _profit_factor,
        safe_divide as _safe_divide,
        symbols as _symbols,
        text as _text,
    )

    start, end = _ledger_window(payload)
    raw_rows = payload.get("runtime_ledger_rows")
    if not isinstance(raw_rows, Sequence) or isinstance(raw_rows, (str, bytes)):
        raise ValueError("runtime_ledger_rows_missing")
    rows = _runtime_rows_with_defaults(payload, cast(Sequence[object], raw_rows))
    if not rows:
        raise ValueError("runtime_ledger_rows_invalid")

    full_bucket = _full_window_bucket(rows=rows, start=start, end=end)
    daily_buckets = build_runtime_ledger_buckets(
        rows,
        bucket_ranges=_daily_bucket_ranges(start, end),
        require_order_lifecycle=True,
    )
    weekday_buckets = [
        bucket for bucket in daily_buckets if bucket.bucket_started_at.weekday() < 5
    ]
    if not weekday_buckets:
        raise ValueError("window_weekdays_missing")

    daily_net = {
        bucket.bucket_started_at.date().isoformat(): bucket.net_strategy_pnl_after_costs
        for bucket in weekday_buckets
    }
    total_net = full_bucket.net_strategy_pnl_after_costs
    active_buckets = [
        bucket
        for bucket in weekday_buckets
        if bucket.fill_count > 0 or bucket.net_strategy_pnl_after_costs != 0
    ]
    active_day_count = len(active_buckets)
    positive_days = [value for value in daily_net.values() if value > 0]
    negative_days = [value for value in daily_net.values() if value < 0]
    window_weekday_count = len(weekday_buckets)
    total_filled_notional = full_bucket.filled_notional
    max_single_fill_notional = _max_single_fill_notional(rows)
    max_single_fill_notional_pct_equity = (
        max_single_fill_notional / policy.start_equity
        if policy.start_equity is not None and policy.start_equity > 0
        else None
    )
    candidate_id = _candidate_id(payload=payload, artifact_ref=artifact_ref)
    candidate_identity = _mapping(payload.get("candidate_identity"))
    cost_lineage = _mapping(payload.get("cost_lineage"))
    capacity_summary = _capacity_lineage_summary(rows)
    execution_quality = _execution_quality_summary(
        rows=rows,
        total_filled_notional=total_filled_notional,
        window_weekday_count=window_weekday_count,
    )
    execution_quality_penalty_bps = cast(
        Decimal, execution_quality["execution_quality_penalty_bps"]
    )
    execution_quality_penalty_amount = _safe_divide(
        total_filled_notional * execution_quality_penalty_bps,
        Decimal("10000"),
    )
    execution_quality_adjusted_window_net_pnl_per_day = _safe_divide(
        total_net - execution_quality_penalty_amount,
        Decimal(window_weekday_count),
    )
    lob_reality_gap_stress = _lob_reality_gap_stress_summary(rows)
    lob_reality_gap_penalty_bps = cast(
        Decimal, lob_reality_gap_stress["effective_replay_rank_penalty_bps"]
    )
    lob_reality_gap_penalty_amount = _safe_divide(
        total_filled_notional * lob_reality_gap_penalty_bps,
        Decimal("10000"),
    )
    microstructure_stress = _microstructure_stress_summary(rows)
    microstructure_stress_penalty_bps = cast(
        Decimal, microstructure_stress["effective_replay_rank_penalty_bps"]
    )
    microstructure_stress_penalty_amount = _safe_divide(
        total_filled_notional * microstructure_stress_penalty_bps,
        Decimal("10000"),
    )
    replay_quality_adjusted_window_net_pnl_per_day = _safe_divide(
        total_net
        - execution_quality_penalty_amount
        - lob_reality_gap_penalty_amount
        - microstructure_stress_penalty_amount,
        Decimal(window_weekday_count),
    )
    blockers = _promotion_blockers(
        payload=payload,
        rows=rows,
        full_bucket=full_bucket,
        total_net=total_net,
        daily_net=daily_net,
        window_weekday_count=window_weekday_count,
        avg_filled_notional_per_window_weekday=_safe_divide(
            total_filled_notional,
            Decimal(window_weekday_count),
        ),
        max_single_fill_notional_pct_equity=max_single_fill_notional_pct_equity,
        policy=policy,
    )

    return ReplayLedgerCandidateRanking(
        artifact_ref=artifact_ref,
        candidate_id=candidate_id,
        candidate_identity_hash=_text(
            payload.get("candidate_identity_hash")
            or candidate_identity.get("candidate_identity_hash")
        ),
        cost_lineage_hash=_text(
            payload.get("cost_lineage_hash") or cost_lineage.get("cost_lineage_hash")
        ),
        promotion_status="blocked_pending_runtime_promotion_proof"
        if blockers
        else "candidate_replay_evidence_only",
        promotion_blockers=tuple(blockers),
        runtime_ledger_blockers=tuple(full_bucket.blockers),
        window_start=start,
        window_end=end,
        window_weekday_count=window_weekday_count,
        active_day_count=active_day_count,
        positive_day_count=len(positive_days),
        negative_day_count=len(negative_days),
        fill_count=full_bucket.fill_count,
        decision_count=full_bucket.decision_count,
        submitted_order_count=full_bucket.submitted_order_count,
        closed_trade_count=full_bucket.closed_trade_count,
        open_position_count=full_bucket.open_position_count,
        total_filled_notional=total_filled_notional,
        avg_filled_notional_per_window_weekday=_safe_divide(
            total_filled_notional,
            Decimal(window_weekday_count),
        ),
        avg_filled_notional_per_active_day=_safe_divide(
            total_filled_notional,
            Decimal(active_day_count),
        ),
        total_net_pnl_after_costs=total_net,
        window_net_pnl_per_day=_safe_divide(
            total_net,
            Decimal(window_weekday_count),
        ),
        active_net_pnl_per_day=_safe_divide(
            total_net,
            Decimal(active_day_count),
        ),
        gross_strategy_pnl=full_bucket.gross_strategy_pnl,
        cost_amount=full_bucket.cost_amount,
        best_day_share=_best_day_share(daily_net, total_net),
        worst_day_net_pnl=min(daily_net.values(), default=Decimal("0")),
        max_drawdown=_max_drawdown(daily_net),
        profit_factor=_profit_factor(daily_net),
        max_single_fill_notional=max_single_fill_notional,
        max_single_fill_notional_pct_equity=max_single_fill_notional_pct_equity,
        daily_net_pnl_after_costs=daily_net,
        symbols=_symbols(rows),
        stage=str(payload.get("stage") or ""),
        source=str(payload.get("source") or ""),
        promotion_authority=str(payload.get("promotion_authority") or ""),
        cost_basis_counts=full_bucket.cost_basis_counts,
        candidate_identity=candidate_identity,
        cost_lineage=cost_lineage,
        fills_with_adv_notional=capacity_summary["fills_with_adv_notional"],
        fills_with_participation_rate=capacity_summary["fills_with_participation_rate"],
        fills_with_capacity_warning_contract=capacity_summary[
            "fills_with_capacity_warning_contract"
        ],
        capacity_warning_counts=capacity_summary["capacity_warning_counts"],
        execution_quality=execution_quality,
        execution_quality_blockers=tuple(
            cast(tuple[str, ...], execution_quality["execution_quality_blockers"])
        ),
        execution_quality_penalty_bps=execution_quality_penalty_bps,
        execution_quality_penalty_amount=execution_quality_penalty_amount,
        execution_quality_adjusted_window_net_pnl_per_day=(
            execution_quality_adjusted_window_net_pnl_per_day
        ),
        lob_reality_gap_stress=lob_reality_gap_stress,
        lob_reality_gap_blockers=tuple(
            cast(tuple[str, ...], lob_reality_gap_stress["lob_reality_gap_blockers"])
        ),
        lob_reality_gap_penalty_bps=lob_reality_gap_penalty_bps,
        lob_reality_gap_penalty_amount=lob_reality_gap_penalty_amount,
        microstructure_stress=microstructure_stress,
        microstructure_stress_blockers=tuple(
            cast(
                tuple[str, ...],
                microstructure_stress["microstructure_stress_blockers"],
            )
        ),
        microstructure_stress_penalty_bps=microstructure_stress_penalty_bps,
        microstructure_stress_penalty_amount=microstructure_stress_penalty_amount,
        replay_quality_adjusted_window_net_pnl_per_day=(
            replay_quality_adjusted_window_net_pnl_per_day
        ),
    )


def rank_replay_ledger_files(
    paths: Sequence[Path],
    *,
    policy: ReplayLedgerRankingPolicy,
) -> tuple[list[ReplayLedgerCandidateRanking], list[ReplayLedgerRankingFailure]]:
    from .row_has_fill_status import (
        ranking_sort_key as _ranking_sort_key,
    )

    rankings: list[ReplayLedgerCandidateRanking] = []
    failures: list[ReplayLedgerRankingFailure] = []
    seen: set[Path] = set()
    for path in paths:
        resolved = path.expanduser().resolve()
        if resolved in seen:
            continue
        seen.add(resolved)
        try:
            payload = json.loads(resolved.read_text())
            if not isinstance(payload, Mapping):
                raise ValueError("ledger_payload_not_object")
            rankings.append(
                rank_replay_ledger_payload(
                    cast(Mapping[str, Any], payload),
                    artifact_ref=str(resolved),
                    policy=policy,
                )
            )
        except Exception as exc:
            failures.append(
                ReplayLedgerRankingFailure(
                    artifact_ref=str(resolved),
                    reason=str(exc) or exc.__class__.__name__,
                )
            )
    rankings.sort(key=_ranking_sort_key)
    return rankings, failures


def build_replay_ledger_ranking_report(
    paths: Sequence[Path],
    *,
    policy: ReplayLedgerRankingPolicy,
    limit: int | None = None,
) -> dict[str, object]:
    rankings, failures = rank_replay_ledger_files(paths, policy=policy)
    limited_rankings = (
        rankings[:limit] if limit is not None and limit >= 0 else rankings
    )
    return {
        "schema_version": EXACT_REPLAY_LEDGER_RANKING_SCHEMA_VERSION,
        "policy": policy.to_payload(),
        "candidate_count": len(rankings),
        "failure_count": len(failures),
        "candidates": [ranking.to_payload() for ranking in limited_rankings],
        "failures": [failure.to_payload() for failure in failures],
    }


def _ledger_window(payload: Mapping[str, Any]) -> tuple[datetime, datetime]:
    from .promotion_blockers import (
        mapping as _mapping,
        parse_window_datetime as _parse_window_datetime,
    )

    full_window = _mapping(payload.get("full_window"))
    start = _parse_window_datetime(
        payload.get("window_start")
        or payload.get("bucket_started_at")
        or payload.get("started_at")
        or payload.get("start")
        or full_window.get("start_date")
    )
    end = _parse_window_datetime(
        payload.get("window_end")
        or payload.get("bucket_ended_at")
        or payload.get("ended_at")
        or payload.get("end")
        or full_window.get("end_date"),
        date_end=True,
    )
    if start is None or end is None:
        raise ValueError("window_bounds_missing")
    if end <= start:
        raise ValueError("window_end_before_start")
    return start, end


def _runtime_rows_with_defaults(
    payload: Mapping[str, Any],
    raw_rows: Sequence[object],
) -> list[Mapping[str, object]]:
    defaults = {
        key: payload.get(key)
        for key in (
            "account_label",
            "source",
            "execution_policy_hash",
            "cost_model_hash",
            "cost_lineage_hash",
            "candidate_id",
            "candidate_identity_hash",
            "lineage_hash",
            "replay_data_hash",
            "cost_basis",
        )
        if payload.get(key) not in (None, "")
    }
    rows: list[Mapping[str, object]] = []
    for raw_row in raw_rows:
        if not isinstance(raw_row, Mapping):
            return []
        row = dict(cast(Mapping[str, object], raw_row))
        for key, value in defaults.items():
            row.setdefault(key, value)
        rows.append(row)
    return rows


def _full_window_bucket(
    *,
    rows: Sequence[Mapping[str, object]],
    start: datetime,
    end: datetime,
) -> RuntimeLedgerBucket:
    import importlib

    public_ranker = importlib.import_module(
        "app.trading.discovery.replay_ledger_ranker"
    )
    buckets = public_ranker.build_runtime_ledger_buckets(
        rows,
        bucket_ranges=[(start, end)],
        require_order_lifecycle=True,
    )
    if len(buckets) != 1:
        raise ValueError("runtime_ledger_bucket_missing")
    return buckets[0]


# Public aliases used by split-module consumers.
CLOSING_AUCTION_CLEARING_PRICE_FIELDS = _CLOSING_AUCTION_CLEARING_PRICE_FIELDS
CLOSING_AUCTION_FIELDS = _CLOSING_AUCTION_FIELDS
CLOSING_AUCTION_PROJECTION_FIELDS = _CLOSING_AUCTION_PROJECTION_FIELDS
CLOSING_WINDOW_FIELDS = _CLOSING_WINDOW_FIELDS
EXECUTION_QUALITY_SOURCE_PAPERS = _EXECUTION_QUALITY_SOURCE_PAPERS
EXECUTION_SHORTFALL_FIELDS = _EXECUTION_SHORTFALL_FIELDS
FILL_STATUS_FIELDS = _FILL_STATUS_FIELDS
LIMIT_FILL_PROBABILITY_FIELDS = _LIMIT_FILL_PROBABILITY_FIELDS
LIVE_PROMOTION_AUTHORITIES = _LIVE_PROMOTION_AUTHORITIES
OPPORTUNITY_COST_FIELDS = _OPPORTUNITY_COST_FIELDS
ORDER_TYPE_FIELDS = _ORDER_TYPE_FIELDS
PRICE_IMPROVEMENT_FIELDS = _PRICE_IMPROVEMENT_FIELDS
QUEUE_POSITION_FIELDS = _QUEUE_POSITION_FIELDS
TERMINAL_INVENTORY_PATH_FIELDS = _TERMINAL_INVENTORY_PATH_FIELDS
full_window_bucket = _full_window_bucket
ledger_window = _ledger_window
runtime_rows_with_defaults = _runtime_rows_with_defaults

__all__ = (
    "EXACT_REPLAY_LEDGER_RANKING_SCHEMA_VERSION",
    "EXECUTION_QUALITY_SCHEMA_VERSION",
    "EXACT_REPLAY_MICROSTRUCTURE_STRESS_SCHEMA_VERSION",
    "ReplayLedgerRankingPolicy",
    "ReplayLedgerCandidateRanking",
    "ReplayLedgerRankingFailure",
    "default_replay_ledger_ranking_policy",
    "rank_replay_ledger_payload",
    "rank_replay_ledger_files",
    "build_replay_ledger_ranking_report",
    "CLOSING_AUCTION_CLEARING_PRICE_FIELDS",
    "CLOSING_AUCTION_FIELDS",
    "CLOSING_AUCTION_PROJECTION_FIELDS",
    "CLOSING_WINDOW_FIELDS",
    "EXECUTION_QUALITY_SOURCE_PAPERS",
    "EXECUTION_SHORTFALL_FIELDS",
    "FILL_STATUS_FIELDS",
    "LIMIT_FILL_PROBABILITY_FIELDS",
    "LIVE_PROMOTION_AUTHORITIES",
    "OPPORTUNITY_COST_FIELDS",
    "ORDER_TYPE_FIELDS",
    "PRICE_IMPROVEMENT_FIELDS",
    "QUEUE_POSITION_FIELDS",
    "TERMINAL_INVENTORY_PATH_FIELDS",
    "full_window_bucket",
    "ledger_window",
    "runtime_rows_with_defaults",
)
