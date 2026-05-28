"""Rank exact replay ledger artifacts with runtime-ledger PnL semantics."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, cast

from app.trading.discovery.profit_target_oracle import ProfitTargetOraclePolicy
from app.trading.runtime_ledger import RuntimeLedgerBucket, build_runtime_ledger_buckets

EXACT_REPLAY_LEDGER_RANKING_SCHEMA_VERSION = "torghut.exact-replay-ledger-ranking.v1"
_LIVE_PROMOTION_AUTHORITIES = frozenset(
    {
        "live",
        "live_runtime_ledger",
        "runtime_live",
        "runtime_execution_ledger",
        "live_paper_runtime_ledger",
    }
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
        fills_with_participation_rate=capacity_summary[
            "fills_with_participation_rate"
        ],
        fills_with_capacity_warning_contract=capacity_summary[
            "fills_with_capacity_warning_contract"
        ],
        capacity_warning_counts=capacity_summary["capacity_warning_counts"],
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
        payload.get("candidate_identity_hash") or identity.get("candidate_identity_hash")
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
        -candidate.window_net_pnl_per_day,
        -candidate.total_net_pnl_after_costs,
        candidate.best_day_share,
        candidate.max_drawdown,
        candidate.candidate_id,
    )
