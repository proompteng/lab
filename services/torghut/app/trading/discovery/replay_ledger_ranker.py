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
    buckets = build_runtime_ledger_buckets(
        rows,
        bucket_ranges=[(start, end)],
        require_order_lifecycle=True,
    )
    if len(buckets) != 1:
        raise ValueError("runtime_ledger_bucket_missing")
    return buckets[0]


def _promotion_blockers(
    *,
    payload: Mapping[str, Any],
    rows: Sequence[Mapping[str, object]],
    full_bucket: RuntimeLedgerBucket,
    total_net: Decimal,
    daily_net: Mapping[str, Decimal],
    window_weekday_count: int,
    avg_filled_notional_per_window_weekday: Decimal,
    max_single_fill_notional_pct_equity: Decimal | None,
    policy: ReplayLedgerRankingPolicy,
) -> list[str]:
    blockers = list(full_bucket.blockers)
    blockers.extend(_candidate_identity_blockers(payload))
    blockers.extend(_cost_lineage_blockers(payload=payload, rows=rows))
    stage = str(payload.get("stage") or "").lower()
    promotion_authority = str(payload.get("promotion_authority") or "").lower()
    if (
        stage not in {"paper", "live"}
        and promotion_authority not in _LIVE_PROMOTION_AUTHORITIES
    ):
        blockers.append("replay_artifact_only_not_live")
    if window_weekday_count < policy.min_window_weekday_count:
        blockers.append("window_weekday_count_below_min_observed_trading_days")
    if (
        _safe_divide(total_net, Decimal(window_weekday_count))
        < policy.target_net_pnl_per_day
    ):
        blockers.append("window_net_pnl_per_day_below_target")
    if avg_filled_notional_per_window_weekday < policy.min_avg_filled_notional_per_day:
        blockers.append("avg_filled_notional_per_day_below_min")
    if _best_day_share(daily_net, total_net) > policy.max_best_day_share:
        blockers.append("best_day_share_above_max")
    if max_single_fill_notional_pct_equity is None:
        blockers.append("start_equity_missing_for_exposure_check")
    elif max_single_fill_notional_pct_equity > policy.max_gross_exposure_pct_equity:
        blockers.append("max_single_fill_notional_pct_equity_above_max")
    return _dedupe(blockers)


def _candidate_id(*, payload: Mapping[str, Any], artifact_ref: str) -> str:
    return _text(payload.get("candidate_id")) or Path(artifact_ref).stem


def _candidate_identity_blockers(payload: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    candidate_id = _text(payload.get("candidate_id"))
    identity = _mapping(payload.get("candidate_identity"))
    identity_candidate_id = _text(identity.get("candidate_id"))
    identity_hash = _text(
        payload.get("candidate_identity_hash")
        or identity.get("candidate_identity_hash")
    )
    if not candidate_id:
        blockers.append("candidate_id_missing")
    if not identity:
        blockers.append("candidate_identity_missing")
    if not identity_hash:
        blockers.append("candidate_identity_hash_missing")
    if identity_candidate_id and candidate_id and identity_candidate_id != candidate_id:
        blockers.append("candidate_identity_candidate_id_mismatch")
    return blockers


def _cost_lineage_blockers(
    *,
    payload: Mapping[str, Any],
    rows: Sequence[Mapping[str, object]],
) -> list[str]:
    blockers: list[str] = []
    cost_lineage = _mapping(payload.get("cost_lineage"))
    cost_lineage_hash = _text(
        payload.get("cost_lineage_hash") or cost_lineage.get("cost_lineage_hash")
    )
    warning_contract = _string_list(cost_lineage.get("warning_contract"))
    capacity_summary = _capacity_lineage_summary(rows)
    fill_count = capacity_summary["fill_count"]
    if not cost_lineage:
        blockers.append("exact_replay_cost_lineage_missing")
    if not cost_lineage_hash:
        blockers.append("exact_replay_cost_lineage_hash_missing")
    if not _text(cost_lineage.get("adv_source")):
        blockers.append("adv_capacity_lineage_missing")
    if not warning_contract:
        blockers.append("adv_capacity_warning_contract_missing")
    if fill_count > 0:
        if capacity_summary["fills_with_adv_notional"] < fill_count:
            blockers.append("fill_adv_notional_missing")
        if capacity_summary["fills_with_participation_rate"] < fill_count:
            blockers.append("fill_capacity_participation_missing")
        if capacity_summary["fills_with_capacity_warning_contract"] < fill_count:
            blockers.append("fill_capacity_warning_contract_missing")
    if capacity_summary["capacity_warning_counts"].get("participation_exceeds_max", 0):
        blockers.append("adv_capacity_limit_breached")
    return blockers


def _capacity_lineage_summary(
    rows: Sequence[Mapping[str, object]],
) -> dict[str, Any]:
    fill_rows = [row for row in rows if _event_type(row) == "fill"]
    warning_counts: dict[str, int] = {}
    fills_with_capacity_warning_contract = 0
    for row in fill_rows:
        warnings = row.get("capacity_warning_codes")
        if isinstance(warnings, Sequence) and not isinstance(
            warnings, (str, bytes, bytearray)
        ):
            fills_with_capacity_warning_contract += 1
            for warning in cast(Sequence[object], warnings):
                text = _text(warning)
                if text:
                    warning_counts[text] = warning_counts.get(text, 0) + 1
    return {
        "fill_count": len(fill_rows),
        "fills_with_adv_notional": sum(
            1 for row in fill_rows if _positive_decimal(row.get("adv_notional"))
        ),
        "fills_with_participation_rate": sum(
            1 for row in fill_rows if _positive_decimal(row.get("participation_rate"))
        ),
        "fills_with_capacity_warning_contract": fills_with_capacity_warning_contract,
        "capacity_warning_counts": warning_counts,
    }


def _execution_quality_summary(
    *,
    rows: Sequence[Mapping[str, object]],
    total_filled_notional: Decimal,
    window_weekday_count: int,
) -> Mapping[str, object]:
    submitted_rows = [row for row in rows if _event_type(row) == "order_submitted"]
    fill_rows = [row for row in rows if _event_type(row) == "fill"]
    order_type_by_order_id: dict[str, str] = {}
    for row in rows:
        order_id = _text(row.get("order_id"))
        order_type = _normalized_order_type(_first_text(row, _ORDER_TYPE_FIELDS))
        if order_id and order_type:
            order_type_by_order_id[order_id] = order_type

    submitted_order_types = [
        _order_type_for_row(row, order_type_by_order_id) for row in submitted_rows
    ]
    fill_order_types = [
        _order_type_for_row(row, order_type_by_order_id) for row in fill_rows
    ]
    order_type_counts = _count_texts(
        order_type for order_type in submitted_order_types if order_type
    )
    order_type_fill_counts = _count_texts(
        order_type for order_type in fill_order_types if order_type
    )
    limit_order_count = sum(
        count
        for order_type, count in order_type_counts.items()
        if "limit" in order_type
    )
    limit_fill_count = sum(
        count
        for order_type, count in order_type_fill_counts.items()
        if "limit" in order_type
    )
    market_order_count = order_type_counts.get("market", 0)
    order_type_sample_count = sum(
        1 for order_type in submitted_order_types if order_type
    )
    fill_order_type_sample_count = sum(
        1 for order_type in fill_order_types if order_type
    )
    route_tca_samples = [
        value
        for row in fill_rows
        if (value := _first_decimal(row, _EXECUTION_SHORTFALL_FIELDS)) is not None
    ]
    price_improvement_samples = [
        value
        for row in fill_rows
        if (value := _first_decimal(row, _PRICE_IMPROVEMENT_FIELDS)) is not None
    ]
    opportunity_cost_samples = [
        value
        for row in rows
        if (value := _first_decimal(row, _OPPORTUNITY_COST_FIELDS)) is not None
    ]
    queue_position_sample_count = sum(
        1 for row in rows if _first_decimal(row, _QUEUE_POSITION_FIELDS) is not None
    )
    limit_fill_probability_samples = [
        value
        for row in rows
        if (value := _first_decimal(row, _LIMIT_FILL_PROBABILITY_FIELDS)) is not None
    ]
    closing_window_sample_count = sum(
        1 for row in rows if _first_evidence(row, _CLOSING_WINDOW_FIELDS)
    )
    closing_auction_sample_count = sum(
        1 for row in rows if _first_evidence(row, _CLOSING_AUCTION_FIELDS)
    )
    closing_auction_projection_sample_count = sum(
        1 for row in rows if _first_evidence(row, _CLOSING_AUCTION_PROJECTION_FIELDS)
    )
    closing_auction_clearing_price_sample_count = sum(
        1
        for row in rows
        if _first_evidence(row, _CLOSING_AUCTION_CLEARING_PRICE_FIELDS)
    )
    terminal_inventory_path_sample_count = sum(
        1 for row in rows if _first_evidence(row, _TERMINAL_INVENTORY_PATH_FIELDS)
    )
    filled_status_count = sum(1 for row in rows if _row_has_fill_status(row))
    blockers: list[str] = []
    penalty_bps = Decimal("0")
    if submitted_rows and order_type_sample_count < len(submitted_rows):
        blockers.append("order_type_mix_evidence_incomplete")
        penalty_bps += Decimal("4")
    if fill_rows and fill_order_type_sample_count < len(fill_rows):
        blockers.append("fill_order_type_evidence_incomplete")
        penalty_bps += Decimal("3")
    if fill_rows and len(route_tca_samples) < len(fill_rows):
        blockers.append("execution_shortfall_evidence_incomplete")
        penalty_bps += Decimal("6")
    if (
        limit_order_count > 0
        and len(limit_fill_probability_samples) < limit_order_count
    ):
        blockers.append("limit_fill_probability_evidence_incomplete")
        penalty_bps += Decimal("6")
    if limit_order_count > 0 and queue_position_sample_count < limit_order_count:
        blockers.append("queue_position_survival_evidence_incomplete")
        penalty_bps += Decimal("6")
    if limit_order_count > 0 and not price_improvement_samples:
        blockers.append("price_improvement_evidence_incomplete")
        penalty_bps += Decimal("2")
    if limit_order_count > 0 and not opportunity_cost_samples:
        blockers.append("nonfill_opportunity_cost_evidence_incomplete")
        penalty_bps += Decimal("2")
    if submitted_rows and closing_window_sample_count == 0:
        blockers.append("closing_window_evidence_incomplete")
        penalty_bps += Decimal("4")
    if submitted_rows and closing_auction_sample_count == 0:
        blockers.append("closing_auction_evidence_incomplete")
        penalty_bps += Decimal("4")
    if submitted_rows and closing_auction_projection_sample_count == 0:
        blockers.append("closing_auction_projection_evidence_incomplete")
        penalty_bps += Decimal("6")
    if submitted_rows and closing_auction_clearing_price_sample_count == 0:
        blockers.append("closing_auction_clearing_price_evidence_incomplete")
        penalty_bps += Decimal("6")
    if fill_rows and terminal_inventory_path_sample_count == 0:
        blockers.append("terminal_inventory_path_evidence_incomplete")
        penalty_bps += Decimal("6")
    limit_fill_rate = (
        _safe_divide(Decimal(limit_fill_count), Decimal(limit_order_count))
        if limit_order_count > 0
        else None
    )
    if limit_fill_rate is not None and limit_fill_rate < Decimal("0.50"):
        blockers.append("limit_fill_rate_below_execution_quality_floor")
        penalty_bps += (Decimal("0.50") - limit_fill_rate) * Decimal("20")
    avg_shortfall_bps = _average_decimal(route_tca_samples)
    if avg_shortfall_bps is not None and avg_shortfall_bps > Decimal("8"):
        blockers.append("execution_shortfall_bps_above_quality_floor")
        penalty_bps += avg_shortfall_bps - Decimal("8")
    avg_opportunity_cost_bps = _average_decimal(opportunity_cost_samples)
    if avg_opportunity_cost_bps is not None and avg_opportunity_cost_bps > Decimal("8"):
        blockers.append("nonfill_opportunity_cost_bps_above_quality_floor")
        penalty_bps += avg_opportunity_cost_bps - Decimal("8")
    penalty_amount = _safe_divide(total_filled_notional * penalty_bps, Decimal("10000"))
    return {
        "schema_version": EXECUTION_QUALITY_SCHEMA_VERSION,
        "source_papers": [dict(item) for item in _EXECUTION_QUALITY_SOURCE_PAPERS],
        "proof_neutrality": {
            "research_ranking_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_closing_auction_mechanism_evidence": True,
            "requires_terminal_inventory_path_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_model_fill_probability_as_fill_authority": True,
            "rejects_closing_auction_projection_as_price_authority": True,
            "rejects_terminal_inventory_path_as_position_authority": True,
            "rejects_adjusted_pnl_as_promotion_authority": True,
        },
        "submitted_order_count": len(submitted_rows),
        "fill_count": len(fill_rows),
        "order_type_sample_count": order_type_sample_count,
        "fill_order_type_sample_count": fill_order_type_sample_count,
        "order_type_counts": order_type_counts,
        "order_type_fill_counts": order_type_fill_counts,
        "market_order_count": market_order_count,
        "limit_order_count": limit_order_count,
        "limit_fill_count": limit_fill_count,
        "limit_fill_rate": limit_fill_rate,
        "filled_status_count": filled_status_count,
        "execution_shortfall_sample_count": len(route_tca_samples),
        "avg_execution_shortfall_bps": avg_shortfall_bps,
        "price_improvement_sample_count": len(price_improvement_samples),
        "avg_price_improvement_bps": _average_decimal(price_improvement_samples),
        "nonfill_opportunity_cost_sample_count": len(opportunity_cost_samples),
        "avg_nonfill_opportunity_cost_bps": avg_opportunity_cost_bps,
        "queue_position_sample_count": queue_position_sample_count,
        "limit_fill_probability_sample_count": len(limit_fill_probability_samples),
        "avg_limit_fill_probability": _average_decimal(limit_fill_probability_samples),
        "closing_window_sample_count": closing_window_sample_count,
        "closing_auction_sample_count": closing_auction_sample_count,
        "closing_auction_projection_sample_count": (
            closing_auction_projection_sample_count
        ),
        "closing_auction_clearing_price_sample_count": (
            closing_auction_clearing_price_sample_count
        ),
        "terminal_inventory_path_sample_count": terminal_inventory_path_sample_count,
        "execution_quality_blockers": tuple(_dedupe(blockers)),
        "execution_quality_penalty_bps": penalty_bps,
        "execution_quality_penalty_amount": penalty_amount,
        "execution_quality_penalty_per_window_weekday": _safe_divide(
            penalty_amount,
            Decimal(window_weekday_count),
        ),
    }


def _lob_reality_gap_stress_summary(
    rows: Sequence[Mapping[str, object]],
) -> Mapping[str, object]:
    signal_rows = _lob_signal_rows(rows)
    warnings: list[str] = []
    if not signal_rows:
        warnings.append("missing_lob_reality_gap_rows")
        stress_payload: dict[str, object] = {
            "schema_version": "torghut.lob-reality-gap-stress.v2",
            "status": "preview_only_lob_reality_gap_stress_ranking",
            "source_papers": [],
            "row_count": 0,
            "replay_rank_penalty_bps": 0.0,
            "warnings": list(warnings),
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_authority_ok": False,
        }
    else:
        stress_payload = extract_lob_reality_gap_stress(signal_rows).to_payload()
        warnings.extend(_string_list(stress_payload.get("warnings")))

    warning_penalty_bps = Decimal(len(warnings)) * Decimal("2")
    raw_penalty_bps = _decimal(stress_payload.get("replay_rank_penalty_bps"))
    effective_penalty_bps = (raw_penalty_bps or Decimal("0")) + warning_penalty_bps
    blockers = tuple(f"lob_reality_gap_{warning}" for warning in _dedupe(warnings))
    return {
        **stress_payload,
        "lob_reality_gap_blockers": blockers,
        "lob_reality_gap_warning_penalty_bps": warning_penalty_bps,
        "effective_replay_rank_penalty_bps": effective_penalty_bps,
    }


def _microstructure_stress_summary(
    rows: Sequence[Mapping[str, object]],
) -> Mapping[str, object]:
    signal_rows = _lob_signal_rows(rows)
    warnings: list[str] = []
    if not signal_rows:
        warnings.append("missing_microstructure_signal_rows")
        adaptive_payload: dict[str, object] = {}
        order_book_payload: dict[str, object] = {}
        cluster_lob_payload: dict[str, object] = {}
    else:
        adaptive_payload = extract_adaptive_market_limit_allocation_stress(
            signal_rows
        ).to_payload()
        order_book_payload = extract_order_book_observability_stress(
            signal_rows,
            max_notional=_max_single_fill_notional(rows),
        ).to_payload()
        cluster_lob_payload = extract_cluster_lob_features(signal_rows).to_payload()
        warnings.extend(
            f"adaptive_market_limit_{warning}"
            for warning in _string_list(adaptive_payload.get("warnings"))
        )
        warnings.extend(
            f"order_book_observability_{warning}"
            for warning in _string_list(order_book_payload.get("warnings"))
        )
        warnings.extend(
            f"cluster_lob_{warning}"
            for warning in _string_list(cluster_lob_payload.get("warnings"))
        )

    adaptive_penalty_bps = _stress_penalty_bps(adaptive_payload)
    order_book_penalty_bps = _stress_penalty_bps(order_book_payload)
    cluster_warning_penalty_bps = Decimal(
        len(_string_list(cluster_lob_payload.get("warnings")))
    )
    warning_penalty_bps = Decimal(len(_dedupe(warnings))) * Decimal("1.5")
    effective_penalty_bps = min(
        Decimal("250"),
        (adaptive_penalty_bps * Decimal("0.5"))
        + (order_book_penalty_bps * Decimal("0.5"))
        + cluster_warning_penalty_bps
        + warning_penalty_bps,
    )
    blockers = tuple(
        f"microstructure_stress_{warning}" for warning in _dedupe(warnings)
    )
    return {
        "schema_version": EXACT_REPLAY_MICROSTRUCTURE_STRESS_SCHEMA_VERSION,
        "status": "preview_only_exact_replay_microstructure_stress_ranking",
        "source_papers": _dedupe_source_papers(
            (
                adaptive_payload.get("source_papers"),
                order_book_payload.get("source_papers"),
                cluster_lob_payload.get("source_papers"),
            )
        ),
        "stress_components": {
            "adaptive_market_limit_allocation": _payload_object(adaptive_payload),
            "order_book_observability": _payload_object(order_book_payload),
            "cluster_lob": _payload_object(cluster_lob_payload),
        },
        "adaptive_market_limit_penalty_bps": adaptive_penalty_bps,
        "order_book_observability_penalty_bps": order_book_penalty_bps,
        "cluster_lob_warning_penalty_bps": cluster_warning_penalty_bps,
        "microstructure_warning_penalty_bps": warning_penalty_bps,
        "effective_replay_rank_penalty_bps": effective_penalty_bps,
        "warnings": _dedupe(warnings),
        "microstructure_stress_blockers": blockers,
        "proof_neutrality": {
            "research_ranking_only": True,
            "prefilter_only": True,
            "promotion_proof": False,
            "proof_authority": False,
            "promotion_authority": False,
            "requires_exact_replay": True,
            "requires_route_tca": True,
            "requires_order_lifecycle_fill_evidence": True,
            "requires_runtime_ledger": True,
            "rejects_preview_stress_as_promotion_authority": True,
        },
        "research_ranking_only": True,
        "prefilter_only": True,
        "promotion_proof": False,
        "proof_authority": False,
        "promotion_authority": False,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "final_authority_ok": False,
    }


def _stress_penalty_bps(payload: Mapping[str, object]) -> Decimal:
    for key in (
        "replay_rank_penalty_bps",
        "effective_replay_rank_penalty_bps",
    ):
        value = _decimal(payload.get(key))
        if value is not None:
            return max(Decimal("0"), value)
    ranking_features = _mapping(payload.get("ranking_features"))
    value = _decimal(ranking_features.get("replay_rank_penalty_bps"))
    return max(Decimal("0"), value or Decimal("0"))


def _dedupe_source_papers(
    groups: Sequence[object],
) -> list[Mapping[str, object]]:
    seen: set[str] = set()
    papers: list[Mapping[str, object]] = []
    for group in groups:
        if not isinstance(group, Sequence) or isinstance(group, (str, bytes)):
            continue
        for item in cast(Sequence[object], group):
            if not isinstance(item, Mapping):
                continue
            source_id = _text(cast(Mapping[str, object], item).get("source_id"))
            if not source_id or source_id in seen:
                continue
            seen.add(source_id)
            papers.append(cast(Mapping[str, object], item))
    return papers


def _lob_signal_rows(
    rows: Sequence[Mapping[str, object]],
) -> tuple[SignalEnvelope, ...]:
    signals: list[SignalEnvelope] = []
    for index, row in enumerate(rows):
        event_ts = _row_event_ts(row)
        symbol = _text(row.get("symbol"))
        if event_ts is None or not symbol:
            continue
        signals.append(
            SignalEnvelope(
                event_ts=event_ts,
                symbol=symbol,
                timeframe=_text(row.get("timeframe")) or None,
                ingest_ts=_row_ingest_ts(row),
                seq=index,
                source=_text(row.get("source")) or "exact_replay_ledger",
                payload={str(key): value for key, value in row.items()},
            )
        )
    return tuple(signals)


def _row_event_ts(row: Mapping[str, object]) -> datetime | None:
    for key in (
        "event_ts",
        "executed_at",
        "timestamp",
        "created_at",
        "submitted_at",
        "filled_at",
    ):
        if (parsed := _parse_window_datetime(row.get(key))) is not None:
            return parsed
    return None


def _row_ingest_ts(row: Mapping[str, object]) -> datetime | None:
    for key in ("ingest_ts", "ingested_at", "observed_at"):
        if (parsed := _parse_window_datetime(row.get(key))) is not None:
            return parsed
    return None


def _daily_bucket_ranges(
    start: datetime,
    end: datetime,
) -> list[tuple[datetime, datetime]]:
    ranges: list[tuple[datetime, datetime]] = []
    current_date = start.date()
    current = datetime.combine(current_date, time.min, tzinfo=timezone.utc)
    if current < start:
        current = start
    while current < end:
        next_day = datetime.combine(
            current.date() + timedelta(days=1),
            time.min,
            tzinfo=timezone.utc,
        )
        bucket_end = min(next_day, end)
        ranges.append((current, bucket_end))
        current = bucket_end
    return ranges


def _parse_window_datetime(value: object, *, date_end: bool = False) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if "T" not in text and len(text) == 10:
            parsed_date = date.fromisoformat(text)
            parsed = datetime.combine(parsed_date, time.min, tzinfo=timezone.utc)
            return parsed + timedelta(days=1) if date_end else parsed
        return _utc(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        return None


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _string_list(value: object) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    result: list[str] = []
    for item in cast(Sequence[object], value):
        text = _text(item)
        if text:
            result.append(text)
    return result


def _payload_object(value: object) -> object:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Mapping):
        return {
            str(key): _payload_object(item)
            for key, item in sorted(cast(Mapping[object, object], value).items())
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return [_payload_object(item) for item in cast(Sequence[object], value)]
    return value


def _first_text(row: Mapping[str, object], fields: Sequence[str]) -> str:
    for field in fields:
        text = _text(row.get(field))
        if text:
            return text
    return ""


def _first_decimal(
    row: Mapping[str, object],
    fields: Sequence[str],
) -> Decimal | None:
    for field in fields:
        value = _decimal(row.get(field))
        if value is not None:
            return value
    return None


def _first_evidence(row: Mapping[str, object], fields: Sequence[str]) -> bool:
    for field in fields:
        if _evidence_present(row.get(field)):
            return True
    return False


def _evidence_present(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, Decimal):
        return True
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, Mapping):
        return bool(cast(Mapping[object, object], value))
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return bool(cast(Sequence[object], value))
    return bool(str(value).strip())


def _decimal(value: object) -> Decimal | None:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _average_decimal(values: Sequence[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _normalized_order_type(value: str) -> str:
    normalized = value.lower().replace("-", "_").replace(" ", "_").strip()
    if not normalized:
        return ""
    if "market" in normalized and "limit" in normalized:
        return "marketable_limit"
    if "limit" in normalized or "passive" in normalized:
        return "limit"
    if "market" in normalized:
        return "market"
    return normalized


def _order_type_for_row(
    row: Mapping[str, object],
    order_type_by_order_id: Mapping[str, str],
) -> str:
    direct = _normalized_order_type(_first_text(row, _ORDER_TYPE_FIELDS))
    if direct:
        return direct
    return order_type_by_order_id.get(_text(row.get("order_id")), "")


def _count_texts(values: Iterable[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


def _row_has_fill_status(row: Mapping[str, object]) -> bool:
    status = _first_text(row, _FILL_STATUS_FIELDS).lower().replace("-", "_")
    if not status:
        return False
    return any(token in status for token in ("fill", "filled", "partial"))


def _text(value: object) -> str:
    return str(value or "").strip()


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _best_day_share(daily_net: Mapping[str, Decimal], total_net: Decimal) -> Decimal:
    if total_net <= 0:
        return Decimal("1")
    best = max(
        (value for value in daily_net.values() if value > 0), default=Decimal("0")
    )
    return best / total_net


def _max_drawdown(daily_net: Mapping[str, Decimal]) -> Decimal:
    cumulative = Decimal("0")
    peak = Decimal("0")
    max_drawdown = Decimal("0")
    for day in sorted(daily_net):
        cumulative += daily_net[day]
        peak = max(peak, cumulative)
        max_drawdown = max(max_drawdown, peak - cumulative)
    return max_drawdown


def _profit_factor(daily_net: Mapping[str, Decimal]) -> Decimal | None:
    positive = sum((value for value in daily_net.values() if value > 0), Decimal("0"))
    negative = sum((value for value in daily_net.values() if value < 0), Decimal("0"))
    if negative == 0:
        return None
    return positive / abs(negative)


def _max_single_fill_notional(rows: Sequence[Mapping[str, object]]) -> Decimal:
    values = [
        notional
        for row in rows
        if _event_type(row) == "fill"
        if (notional := _fill_notional(row)) is not None
    ]
    return max(values, default=Decimal("0"))


def _fill_notional(row: Mapping[str, object]) -> Decimal | None:
    explicit = _positive_decimal(
        row.get("filled_notional") or row.get("notional") or row.get("fill_notional")
    )
    if explicit is not None:
        return explicit
    qty = _positive_decimal(
        row.get("filled_qty") or row.get("qty") or row.get("quantity")
    )
    price = _positive_decimal(
        row.get("avg_fill_price") or row.get("filled_avg_price") or row.get("price")
    )
    if qty is None or price is None:
        return None
    return qty * price


def _symbols(rows: Sequence[Mapping[str, object]]) -> tuple[str, ...]:
    return tuple(
        sorted(
            {
                str(symbol)
                for row in rows
                if (symbol := row.get("symbol")) not in (None, "")
            }
        )
    )


def _event_type(row: Mapping[str, object]) -> str:
    raw = str(
        row.get("ledger_event_type")
        or row.get("runtime_ledger_event_type")
        or row.get("event_type")
        or ""
    ).strip()
    if raw:
        normalized = raw.lower().replace("-", "_").replace(" ", "_")
        if normalized in {"filled", "partial_fill", "partially_filled"}:
            return "fill"
        if normalized in {"trade_decision", "signal_decision"}:
            return "decision"
        if normalized in {"submitted", "accepted", "new", "new_order"}:
            return "order_submitted"
        return normalized
    if row.get("filled_qty") is not None or row.get("avg_fill_price") is not None:
        return "fill"
    return ""


def _positive_decimal(value: object) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    if parsed <= 0:
        return None
    return parsed


def _safe_divide(numerator: Decimal, denominator: Decimal) -> Decimal:
    if denominator <= 0:
        return Decimal("0")
    return numerator / denominator


def _dedupe(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _ranking_sort_key(candidate: ReplayLedgerCandidateRanking) -> tuple[object, ...]:
    return (
        -candidate.replay_quality_adjusted_window_net_pnl_per_day,
        -candidate.execution_quality_adjusted_window_net_pnl_per_day,
        -candidate.window_net_pnl_per_day,
        -candidate.total_net_pnl_after_costs,
        candidate.lob_reality_gap_penalty_bps,
        candidate.microstructure_stress_penalty_bps,
        candidate.execution_quality_penalty_bps,
        candidate.best_day_share,
        candidate.max_drawdown,
        candidate.candidate_id,
    )
