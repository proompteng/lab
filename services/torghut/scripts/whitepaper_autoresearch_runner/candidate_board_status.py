from __future__ import annotations

from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle
from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_lower_bound_net_pnl_per_day,
    deployable_proof_failed_gate_count,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_int_field,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_runtime_windows import (
    _candidate_board_exact_replay_ledger_refs,
    _candidate_board_runtime_window_bounds,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _boolish,
    _decimal,
    _oracle_blockers,
    _rank_sort_value,
    _string,
)


def _candidate_board_blockers(
    *,
    selected_for_replay: bool,
    evidence: CandidateEvidenceBundle | None,
    scorecard: Mapping[str, Any],
) -> list[str]:
    blockers = list(_oracle_blockers(scorecard))
    if not selected_for_replay:
        blockers.append("not_selected_for_replay")
    elif evidence is None:
        blockers.append("replay_evidence_missing")
    if evidence is not None and not _boolish(scorecard.get("target_met")):
        blockers.append("target_net_pnl_per_day_not_met")
    if (
        evidence is not None
        and _boolish(scorecard.get("target_met"))
        and not _boolish(scorecard.get("oracle_passed"))
        and not blockers
    ):
        blockers.append("profit_target_oracle_failed")
    return list(dict.fromkeys(blockers))


def _candidate_board_status(
    *,
    selected_for_replay: bool,
    evidence: CandidateEvidenceBundle | None,
    scorecard: Mapping[str, Any],
    in_best_portfolio: bool,
    portfolio_oracle_passed: bool,
) -> str:
    if in_best_portfolio and portfolio_oracle_passed:
        return "portfolio_component_passed_oracle"
    if evidence is not None and _boolish(scorecard.get("oracle_passed")):
        return "candidate_oracle_passed"
    if evidence is not None and _boolish(scorecard.get("target_met")):
        return "blocked_by_oracle"
    if evidence is not None:
        return "replayed_below_target"
    if selected_for_replay:
        return "selected_pending_replay_evidence"
    return "research_ranked_not_replayed"


def _candidate_board_activity_count(row: Mapping[str, Any]) -> int:
    return max(
        _candidate_board_int_field(row, "decision_count"),
        _candidate_board_int_field(row, "submitted_order_count"),
        _candidate_board_int_field(row, "filled_order_count"),
        _candidate_board_int_field(row, "executable_replay_order_count"),
    )


def _candidate_board_oracle_blocker_count(row: Mapping[str, Any]) -> int:
    blockers = row.get("blockers")
    if not isinstance(blockers, Sequence) or isinstance(blockers, str):
        return 0
    return sum(
        1
        for blocker in cast(Sequence[Any], blockers)
        if _string(blocker).endswith("_failed")
    )


def _candidate_board_net_pnl(row: Mapping[str, Any]) -> Decimal:
    return _decimal(row.get("net_pnl_per_day"))


def _candidate_board_lower_bound_net_pnl(row: Mapping[str, Any]) -> Decimal:
    lower_bound = deployable_lower_bound_net_pnl_per_day(row)
    if lower_bound is None:
        return Decimal("0")
    if (
        deployable_lower_bound_missing_count(row) > 0
        or deployable_proof_failed_gate_count(row) > 0
    ):
        return Decimal("0")
    return lower_bound


def _candidate_board_target_progress_ratio(
    *,
    lower_bound: Decimal,
    target: Decimal,
) -> Decimal:
    if target <= 0:
        return Decimal("0")
    return (lower_bound / target).quantize(Decimal("0.0001"))


def _candidate_board_required_notional_repair_scale(
    *,
    lower_bound: Decimal,
    target: Decimal,
) -> Decimal:
    if target <= 0 or lower_bound <= 0:
        return Decimal("0")
    return max(Decimal("1"), target / lower_bound).quantize(Decimal("0.0001"))


def _candidate_board_best_executed_candidate(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any] | None:
    executed_rows = [
        dict(row) for row in rows if _candidate_board_activity_count(row) > 0
    ]
    if not executed_rows:
        return None
    executed_rows.sort(
        key=lambda row: (
            bool(row.get("oracle_passed")),
            bool(row.get("target_met")),
            _candidate_board_activity_count(row),
            _candidate_board_net_pnl(row),
            -_rank_sort_value(row.get("rank")),
            _string(row.get("candidate_spec_id")),
        ),
        reverse=True,
    )
    return executed_rows[0]


def _candidate_board_closest_promotion_candidate(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any] | None:
    replayed_rows = [dict(row) for row in rows if bool(row.get("has_replay_evidence"))]
    if not replayed_rows:
        return None
    replayed_rows.sort(
        key=lambda row: (
            bool(row.get("oracle_passed")),
            bool(row.get("target_met")),
            -_candidate_board_oracle_blocker_count(row),
            _candidate_board_activity_count(row),
            _candidate_board_net_pnl(row),
            -_rank_sort_value(row.get("rank")),
            _string(row.get("candidate_spec_id")),
        ),
        reverse=True,
    )
    return replayed_rows[0]


def _candidate_board_paper_probation_admission_blockers(
    row: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    exact_replay_ledger_refs = _candidate_board_exact_replay_ledger_refs(row)
    if not exact_replay_ledger_refs:
        blockers.append("paper_probation_exact_replay_ledger_artifact_missing")
    if _candidate_board_int_field(row, "exact_replay_ledger_artifact_row_count") <= 0:
        blockers.append("paper_probation_exact_replay_ledger_row_count_missing")
    if _candidate_board_int_field(row, "exact_replay_ledger_artifact_fill_count") <= 0:
        blockers.append("paper_probation_exact_replay_ledger_fill_count_missing")
    window_start, window_end = _candidate_board_runtime_window_bounds(row)
    if not window_start or not window_end:
        blockers.append("paper_probation_runtime_window_bounds_missing")
    return blockers


__all__ = [
    "_candidate_board_blockers",
    "_candidate_board_status",
    "_candidate_board_activity_count",
    "_candidate_board_oracle_blocker_count",
    "_candidate_board_net_pnl",
    "_candidate_board_lower_bound_net_pnl",
    "_candidate_board_target_progress_ratio",
    "_candidate_board_required_notional_repair_scale",
    "_candidate_board_best_executed_candidate",
    "_candidate_board_closest_promotion_candidate",
    "_candidate_board_paper_probation_admission_blockers",
]
