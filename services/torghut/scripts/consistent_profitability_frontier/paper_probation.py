"""Paper-probation readiness helpers for consistent profitability frontier candidates."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_CEILING
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.objectives import ObjectiveVetoPolicy
from app.trading.runtime_ledger import POST_COST_PNL_BASIS

from scripts.consistent_profitability_frontier.common import (
    _candidate_replay_tape_metadata_blockers,
    _mapping,
    _nonnegative_int_metric,
)
from scripts.consistent_profitability_frontier.repair_math import (
    _capital_repair_exposure_scale,
    _decimal_payload,
)

_PAPER_PROBATION_CAPITAL_REPAIR_REASONS = frozenset(
    {
        "gross_exposure_pct_equity_above_max",
        "min_cash_below_min",
        "negative_cash_observation_count_above_max",
    }
)
_PAPER_PROBATION_LOSS_REPAIR_REASONS = frozenset(
    {
        "daily_net_below_min",
        "max_drawdown_above_max",
        "worst_day_loss_above_max",
    }
)
_PAPER_PROBATION_ACTIVITY_REPAIR_REASONS = frozenset(
    {
        "active_day_ratio_below_min",
        "avg_daily_notional_below_min",
        "best_day_share_above_max",
        "profit_factor_below_min",
        "second_oos_net_per_day_below_target",
    }
)
_PAPER_PROBATION_TAIL_RISK_REASONS = frozenset(
    {
        "conformal_tail_risk_below_target",
        "fill_survival_sample_count_below_min",
        "fill_survival_rate_below_min",
    }
)
_PAPER_PROBATION_QUEUE_SURVIVAL_REASONS = frozenset(
    {
        "fill_survival_sample_count_below_min",
        "fill_survival_rate_below_min",
        "required_min_queue_position_survival_sample_count",
        "queue_position_survival_fill_curve_evidence_present_failed",
        "queue_position_survival_sample_count_failed",
        "queue_position_survival_fill_rate_failed",
        "queue_position_survival_nonfill_opportunity_cost_present_failed",
        "queue_position_survival_nonfill_opportunity_cost_bps_failed",
        "queue_position_survival_fill_curve_evidence_missing",
        "queue_position_survival_sample_count_zero",
        "queue_position_survival_fill_rate_non_positive",
        "queue_position_survival_queue_ahead_depletion_evidence_missing",
        "queue_position_survival_queue_ahead_depletion_sample_count_zero",
        "queue_position_survival_adjusted_fillable_ratio_non_positive",
        "queue_position_survival_stress_net_pnl_non_positive",
    }
)
_PAPER_PROBATION_TARGET_SCALE_QUANTUM = Decimal("0.000001")
_PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS = (
    "real_runtime_trade_decisions",
    "broker_order_submissions_and_status_events",
    "broker_fill_events",
    "post_cost_costs_tca_and_execution_shortfall",
    "source_backed_runtime_ledger_lineage",
    "closed_flat_position_proof",
    "broker_runtime_ledger_reconciliation",
)
_PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH = (
    "preserve_final_promotion_gates_fail_closed",
    "import_exact_replay_runtime_window_metadata_without_live_submit",
    "run_bounded_live_paper_probe_with_configured_paper_account_only",
    "materialize_source_backed_runtime_ledger_lineage_for_decisions_orders_fills_costs",
    "verify_closed_flat_positions_and_broker_runtime_ledger_reconciliation",
    "reevaluate_post_cost_runtime_profitability_before_any_final_promotion",
)


def _safe_decimal(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _candidate_metric_value(
    item: Mapping[str, Any],
    *,
    scorecard_key: str,
    full_window_key: str,
    default: str = "0",
) -> Any:
    scorecard = _mapping(item.get("objective_scorecard"))
    raw_value = scorecard.get(scorecard_key)
    if raw_value not in (None, ""):
        return raw_value
    full_window = _mapping(item.get("full_window"))
    raw_value = full_window.get(full_window_key)
    if raw_value not in (None, ""):
        return raw_value
    return default


def _candidate_artifact_refs(item: Mapping[str, Any]) -> list[str]:
    refs: list[str] = []
    exact_replay_ref = str(item.get("exact_replay_ledger_artifact_ref") or "").strip()
    if exact_replay_ref:
        refs.append(exact_replay_ref)
    refs.extend(
        str(ref).strip()
        for ref in cast(Sequence[Any], item.get("replay_artifact_refs") or ())
        if str(ref).strip()
    )
    return list(dict.fromkeys(refs))


def _candidate_exact_replay_ledger_artifact_refs(item: Mapping[str, Any]) -> list[str]:
    refs: list[str] = []
    scorecard = _mapping(item.get("objective_scorecard"))
    for source in (item, scorecard):
        for key in ("exact_replay_ledger_artifact_ref",):
            ref = str(source.get(key) or "").strip()
            if ref:
                refs.append(ref)
        for key in ("exact_replay_ledger_artifact_refs",):
            raw_refs = source.get(key)
            if isinstance(raw_refs, str):
                ref = raw_refs.strip()
                if ref:
                    refs.append(ref)
                continue
            for raw_ref in cast(Sequence[Any], raw_refs or ()):
                ref = str(raw_ref).strip()
                if ref:
                    refs.append(ref)
    for raw_ref in cast(Sequence[Any], item.get("replay_artifact_refs") or ()):
        ref = str(raw_ref).strip()
        ref_lower = ref.lower()
        if ref and (
            "exact-replay-ledger" in ref_lower or "exact_replay_ledger" in ref_lower
        ):
            refs.append(ref)
    return list(dict.fromkeys(refs))


def _candidate_runtime_ledger_count(item: Mapping[str, Any], *keys: str) -> int:
    scorecard = _mapping(item.get("objective_scorecard"))
    values: list[int] = []
    for source in (item, scorecard):
        values.extend(_nonnegative_int_metric(source.get(key)) for key in keys)
    return max(values, default=0)


def _paper_probation_required_actions(hard_vetoes: Sequence[str]) -> list[str]:
    reasons = {str(reason) for reason in hard_vetoes}
    actions = ["collect_runtime_ledger_paper_evidence"]
    if reasons & _PAPER_PROBATION_CAPITAL_REPAIR_REASONS:
        actions.append("apply_capital_repair_sizing_before_paper_orders")
    if reasons & _PAPER_PROBATION_LOSS_REPAIR_REASONS:
        actions.append("tighten_loss_controls_before_paper_orders")
    if reasons & _PAPER_PROBATION_ACTIVITY_REPAIR_REASONS:
        actions.append("collect_consistency_and_activity_evidence")
    if reasons & _PAPER_PROBATION_TAIL_RISK_REASONS:
        actions.append("collect_tail_risk_and_fill_survival_evidence")
    if reasons & _PAPER_PROBATION_QUEUE_SURVIVAL_REASONS:
        actions.append("collect_queue_position_survival_fill_curve_evidence")
    if "stale_dataset_snapshot" in reasons:
        actions.append("refresh_dataset_snapshot_before_paper_orders")
    return actions


def _paper_probation_notional_scale_decimal(
    *,
    item: Mapping[str, Any],
    objective_veto_policy: ObjectiveVetoPolicy,
    hard_vetoes: Sequence[str],
) -> Decimal:
    if not (
        {str(reason) for reason in hard_vetoes}
        & _PAPER_PROBATION_CAPITAL_REPAIR_REASONS
    ):
        return Decimal("1")
    return _capital_repair_exposure_scale(
        {
            "max_gross_exposure_pct_equity": _candidate_metric_value(
                item,
                scorecard_key="max_gross_exposure_pct_equity",
                full_window_key="max_gross_exposure_pct_equity",
            ),
            "max_gross_exposure_pct_equity_required": str(
                objective_veto_policy.required_max_gross_exposure_pct_equity
            ),
            "min_cash": _candidate_metric_value(
                item,
                scorecard_key="min_cash",
                full_window_key="min_cash",
            ),
            "min_cash_required": str(objective_veto_policy.required_min_cash),
        },
        policy_required_max_gross_exposure_pct_equity=(
            objective_veto_policy.required_max_gross_exposure_pct_equity
        ),
        policy_required_min_cash=objective_veto_policy.required_min_cash,
    )


def _paper_probation_notional_scale(
    *,
    item: Mapping[str, Any],
    objective_veto_policy: ObjectiveVetoPolicy,
    hard_vetoes: Sequence[str],
) -> str:
    scale = _paper_probation_notional_scale_decimal(
        item=item,
        objective_veto_policy=objective_veto_policy,
        hard_vetoes=hard_vetoes,
    )
    return _decimal_payload(scale)


def _paper_probation_target_notional_scale(
    *,
    capital_repaired_net_pnl_per_day: Decimal,
    target_net_pnl_per_day: Decimal,
) -> Decimal:
    if target_net_pnl_per_day <= 0:
        return Decimal("1")
    if capital_repaired_net_pnl_per_day <= 0:
        return Decimal("0")
    if capital_repaired_net_pnl_per_day >= target_net_pnl_per_day:
        return Decimal("1")
    return (target_net_pnl_per_day / capital_repaired_net_pnl_per_day).quantize(
        _PAPER_PROBATION_TARGET_SCALE_QUANTUM,
        rounding=ROUND_CEILING,
    )


def _candidate_metric_decimal(
    item: Mapping[str, Any],
    *,
    scorecard_key: str,
    full_window_key: str,
) -> Decimal:
    return _safe_decimal(
        _candidate_metric_value(
            item,
            scorecard_key=scorecard_key,
            full_window_key=full_window_key,
        )
    )


def _candidate_source_lineage_ok(item: Mapping[str, Any]) -> bool:
    replay_lineage = _mapping(item.get("replay_lineage"))
    candidate_key = _mapping(item.get("candidate_evaluation_key_payload"))
    return bool(
        str(item.get("dataset_snapshot_id") or "").strip()
        and str(replay_lineage.get("lineage_hash") or "").strip()
        and str(
            item.get("candidate_evaluation_key")
            or candidate_key.get("candidate_evaluation_key")
            or ""
        ).strip()
    )


def _candidate_post_cost_proof_blockers(item: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    pnl_basis = str(item.get("runtime_ledger_pnl_basis") or "").strip()
    if pnl_basis != POST_COST_PNL_BASIS:
        blockers.append("missing_post_cost_pnl_basis")

    cost_basis_counts = item.get("runtime_ledger_cost_basis_counts")
    cost_basis_count = _candidate_runtime_ledger_count(
        item,
        "runtime_ledger_cost_basis_count",
        "exact_replay_ledger_cost_basis_count",
    )
    if isinstance(cost_basis_counts, Mapping):
        parsed_cost_basis_count = 0
        for value in cost_basis_counts.values():
            try:
                parsed_cost_basis_count += int(value or 0)
            except (TypeError, ValueError):
                continue
        cost_basis_count = max(
            cost_basis_count,
            parsed_cost_basis_count,
        )
    if cost_basis_count <= 0 and not str(item.get("cost_basis") or "").strip():
        blockers.append("missing_cost_basis")

    expectancy_value = item.get("runtime_ledger_post_cost_expectancy_bps")
    if expectancy_value in (None, ""):
        blockers.append("missing_post_cost_expectancy_bps")
    else:
        expectancy = _safe_decimal(expectancy_value)
        if expectancy <= Decimal("0"):
            blockers.append("non_positive_post_cost_expectancy_bps")
    return blockers


def _candidate_exact_replay_parity_ok(
    item: Mapping[str, Any],
    *,
    artifact_refs: Sequence[str],
    exact_replay_ledger_row_count: int,
    exact_replay_ledger_fill_count: int,
) -> bool:
    scorecard = _mapping(item.get("objective_scorecard"))
    has_exact_ref = any(
        "exact" in ref.lower() and "ledger" in ref.lower() for ref in artifact_refs
    )
    has_exact_ref = has_exact_ref or bool(
        str(
            item.get("exact_replay_ledger_artifact_ref")
            or scorecard.get("exact_replay_ledger_artifact_ref")
            or ""
        ).strip()
    )
    return bool(
        has_exact_ref
        and exact_replay_ledger_row_count > 0
        and exact_replay_ledger_fill_count > 0
    )


def _candidate_handoff_diagnostics(
    item: Mapping[str, Any],
    *,
    hard_vetoes: Sequence[str],
    artifact_refs: Sequence[str],
    exact_replay_ledger_row_count: int,
    exact_replay_ledger_fill_count: int,
    source_lineage_ok: bool,
    exact_replay_parity_ok: bool,
) -> list[dict[str, Any]]:
    reasons = {str(reason) for reason in hard_vetoes}
    diagnostics: list[dict[str, Any]] = []

    if reasons & {
        "active_day_ratio_below_min",
        "min_active_days_below_min",
        "positive_day_ratio_below_min",
        "second_oos_net_per_day_below_target",
    } or _candidate_metric_decimal(
        item,
        scorecard_key="active_day_ratio",
        full_window_key="active_ratio",
    ) <= Decimal("0"):
        diagnostics.append(
            {
                "category": "insufficient_days",
                "reasons": sorted(
                    reasons
                    & {
                        "active_day_ratio_below_min",
                        "min_active_days_below_min",
                        "positive_day_ratio_below_min",
                        "second_oos_net_per_day_below_target",
                    }
                ),
            }
        )

    cost_capacity_reasons = reasons & {
        "avg_daily_notional_below_min",
        "avg_filled_notional_per_active_day_below_min",
        "gross_exposure_pct_equity_above_max",
        "min_cash_below_min",
        "negative_cash_observation_count_above_max",
        "adv_capacity_below_min",
        "capacity_below_target",
        "fill_survival_rate_below_min",
        "fill_survival_sample_count_below_min",
        "profit_factor_below_min",
    }
    if cost_capacity_reasons:
        diagnostics.append(
            {
                "category": "cost_adv_capacity_blockers",
                "reasons": sorted(cost_capacity_reasons),
            }
        )

    open_position_count = _candidate_runtime_ledger_count(
        item,
        "runtime_ledger_open_position_count",
        "exact_replay_ledger_open_position_count",
    )
    if open_position_count > 0:
        diagnostics.append(
            {
                "category": "open_replay_positions",
                "open_position_count": open_position_count,
            }
        )

    if "best_day_share_above_max" in reasons:
        diagnostics.append(
            {
                "category": "best_day_concentration",
                "reasons": ["best_day_share_above_max"],
                "best_day_share_of_total_pnl": str(
                    _candidate_metric_value(
                        item,
                        scorecard_key="best_day_share_of_total_pnl",
                        full_window_key="best_day_share_of_total_pnl",
                    )
                ),
            }
        )

    if not source_lineage_ok:
        diagnostics.append(
            {
                "category": "missing_source_lineage",
                "missing": [
                    name
                    for name, present in (
                        (
                            "dataset_snapshot_id",
                            bool(str(item.get("dataset_snapshot_id") or "").strip()),
                        ),
                        (
                            "replay_lineage.lineage_hash",
                            bool(
                                str(
                                    _mapping(item.get("replay_lineage")).get(
                                        "lineage_hash"
                                    )
                                    or ""
                                ).strip()
                            ),
                        ),
                        (
                            "candidate_evaluation_key",
                            bool(
                                str(
                                    item.get("candidate_evaluation_key")
                                    or _mapping(
                                        item.get("candidate_evaluation_key_payload")
                                    ).get("candidate_evaluation_key")
                                    or ""
                                ).strip()
                            ),
                        ),
                    )
                    if not present
                ],
            }
        )

    if not exact_replay_parity_ok:
        diagnostics.append(
            {
                "category": "failed_exact_replay_parity",
                "artifact_refs": list(artifact_refs),
                "exact_replay_ledger_artifact_row_count": (
                    exact_replay_ledger_row_count
                ),
                "exact_replay_ledger_artifact_fill_count": (
                    exact_replay_ledger_fill_count
                ),
            }
        )

    if (
        artifact_refs
        and exact_replay_ledger_row_count > 0
        and exact_replay_ledger_fill_count > 0
    ):
        replay_tape_blockers = _candidate_replay_tape_metadata_blockers(item)
        if replay_tape_blockers:
            diagnostics.append(
                {
                    "category": "missing_replay_tape_metadata",
                    "blockers": replay_tape_blockers,
                }
            )

        post_cost_blockers = _candidate_post_cost_proof_blockers(item)
        if post_cost_blockers:
            diagnostics.append(
                {
                    "category": "missing_post_cost_basis",
                    "blockers": post_cost_blockers,
                }
            )

    return diagnostics


def _bounded_sim_handoff_metadata(
    *,
    item: Mapping[str, Any],
    paper_probation_allowed: bool,
    source_lineage_ok: bool,
    exact_replay_parity_ok: bool,
    diagnostics: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    evidence_collection_ok = bool(
        paper_probation_allowed and source_lineage_ok and exact_replay_parity_ok
    )
    blockers = [
        str(diagnostic.get("category") or "")
        for diagnostic in diagnostics
        if str(diagnostic.get("category") or "")
    ]
    if not blockers and not evidence_collection_ok:
        blockers.append("source_or_replay_preconditions_not_met")
    return {
        "schema_version": "torghut.frontier-bounded-sim-handoff.v1",
        "status": (
            "evidence_collection_ready_promotion_blocked"
            if evidence_collection_ok
            else "handoff_blocked_until_preconditions_pass"
        ),
        "authority": "bounded_sim_evidence_collection_only",
        "candidate_id": str(item.get("candidate_id") or ""),
        "evidence_collection_ok": evidence_collection_ok,
        "promotion_allowed": False,
        "final_promotion_allowed": False,
        "promotion_blockers": [
            "source_backed_runtime_ledger_authority_required",
            "live_paper_probation_runtime_evidence_required",
            "unchanged_final_promotion_gates_required",
        ],
        "handoff_blockers": blockers,
        "source_lineage_ok": source_lineage_ok,
        "exact_replay_parity_ok": exact_replay_parity_ok,
        "diagnostics": [dict(diagnostic) for diagnostic in diagnostics],
    }


def _paper_probation_repair_actions(
    *,
    blockers: Sequence[str],
    hard_vetoes: Sequence[str],
) -> list[str]:
    actions = list(_paper_probation_required_actions(hard_vetoes))
    blocker_set = {str(blocker) for blocker in blockers}
    if blocker_set & {
        "missing_exact_replay_ledger_artifact",
        "missing_exact_replay_ledger_row_count",
        "missing_exact_replay_ledger_fill_count",
        "failed_exact_replay_parity",
    }:
        actions.append("produce_authoritative_exact_replay_ledger")
    if "missing_source_lineage" in blocker_set:
        actions.append("materialize_source_lineage_receipt")
    if any(blocker.startswith("missing_replay_tape_") for blocker in blocker_set):
        actions.append("refresh_replay_tape_metadata")
    if blocker_set & {
        "missing_post_cost_pnl_basis",
        "missing_cost_basis",
        "missing_post_cost_expectancy_bps",
        "non_positive_post_cost_expectancy_bps",
    }:
        actions.append("rematerialize_post_cost_runtime_ledger")
    if "open_replay_positions" in blocker_set:
        actions.append("close_or_exclude_open_replay_position_windows")
    if "proof_only_full_window_replay_not_probation_authority" in blocker_set:
        actions.append("rerun_exact_replay_with_authoritative_runtime_events")
    if blocker_set & _PAPER_PROBATION_QUEUE_SURVIVAL_REASONS:
        actions.append("collect_queue_position_survival_fill_curve_evidence")
    actions.append("keep_final_promotion_gates_fail_closed")
    return list(dict.fromkeys(actions))


def _paper_probation_target_progress(
    *,
    net_pnl_per_day: Decimal,
    target_net_pnl_per_day: Decimal,
) -> Decimal:
    if target_net_pnl_per_day <= 0:
        return Decimal("0")
    return (net_pnl_per_day / target_net_pnl_per_day).quantize(Decimal("0.0001"))


def _paper_probation_repair_plan(
    *,
    item: Mapping[str, Any],
    blockers: Sequence[str],
    hard_vetoes: Sequence[str],
    handoff_diagnostics: Sequence[Mapping[str, Any]],
    net_pnl_per_day: Decimal,
    target_net_pnl_per_day: Decimal,
    capital_repair_notional_scale: Decimal,
    capital_repaired_net_pnl_per_day: Decimal,
    target_notional_scale_after_capital_repair: Decimal,
) -> dict[str, Any]:
    repair_actions = _paper_probation_repair_actions(
        blockers=blockers,
        hard_vetoes=hard_vetoes,
    )
    target_shortfall = max(target_net_pnl_per_day - net_pnl_per_day, Decimal("0"))
    capital_repaired_target_shortfall = max(
        target_net_pnl_per_day - capital_repaired_net_pnl_per_day,
        Decimal("0"),
    )
    target_scale_required = target_notional_scale_after_capital_repair > Decimal("1")
    if target_scale_required:
        repair_actions.append(
            "validate_target_notional_scale_capacity_before_paper_orders"
        )
    repair_required = bool(blockers)
    return {
        "schema_version": "torghut.paper-probation-repair-plan.v1",
        "status": "repair_required_before_paper_evidence_collection"
        if repair_required
        else "ready_for_bounded_paper_evidence_collection",
        "candidate_id": str(item.get("candidate_id") or ""),
        "target_net_pnl_per_day": _decimal_payload(target_net_pnl_per_day),
        "observed_net_pnl_per_day": _decimal_payload(net_pnl_per_day),
        "target_shortfall": _decimal_payload(target_shortfall),
        "capital_repair_notional_scale": _decimal_payload(
            capital_repair_notional_scale
        ),
        "capital_repaired_net_pnl_per_day": _decimal_payload(
            capital_repaired_net_pnl_per_day
        ),
        "capital_repaired_target_shortfall": _decimal_payload(
            capital_repaired_target_shortfall
        ),
        "target_notional_scale_after_capital_repair": _decimal_payload(
            target_notional_scale_after_capital_repair
        ),
        "target_scale_required": target_scale_required,
        "target_scale_authority": "planning_only_requires_bounded_paper_validation",
        "live_paper_evidence_requirements": list(
            _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS
        ),
        "safe_evidence_collection_path": list(
            _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH
        ),
        "target_progress_ratio": _decimal_payload(
            _paper_probation_target_progress(
                net_pnl_per_day=net_pnl_per_day,
                target_net_pnl_per_day=target_net_pnl_per_day,
            )
        ),
        "repair_required": repair_required,
        "repairable_for_evidence_collection": net_pnl_per_day > 0,
        "repair_actions": repair_actions,
        "repair_blockers": list(dict.fromkeys(str(blocker) for blocker in blockers)),
        "diagnostics": [dict(diagnostic) for diagnostic in handoff_diagnostics],
        "live_capital_authorized": False,
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "final_promotion_allowed": False,
        "authorization_scope": "evidence_collection_repair_only",
    }


def _build_paper_probation_shortlist(
    ranked_items: Sequence[Mapping[str, Any]],
    *,
    top_n: int,
    objective_veto_policy: ObjectiveVetoPolicy,
    target_net_pnl_per_day: Decimal = Decimal("500"),
) -> list[dict[str, Any]]:
    visible_items = [
        item
        for item in ranked_items
        if _safe_decimal(
            _candidate_metric_value(
                item,
                scorecard_key="net_pnl_per_day",
                full_window_key="net_per_day",
            )
        )
        > Decimal("0")
    ]

    shortlist_candidates: list[
        tuple[bool, bool, Decimal, Decimal, Decimal, Decimal, str, dict[str, Any]]
    ] = []
    for item in visible_items:
        hard_vetoes = [
            str(reason) for reason in cast(Sequence[Any], item.get("hard_vetoes") or ())
        ]
        artifact_refs = _candidate_exact_replay_ledger_artifact_refs(item)
        exact_replay_ledger_row_count = _candidate_runtime_ledger_count(
            item,
            "exact_replay_ledger_artifact_row_count",
        )
        exact_replay_ledger_fill_count = _candidate_runtime_ledger_count(
            item,
            "exact_replay_ledger_artifact_fill_count",
        )
        blockers: list[str] = []
        if not artifact_refs:
            blockers.append("missing_exact_replay_ledger_artifact")
        if exact_replay_ledger_row_count <= 0:
            blockers.append("missing_exact_replay_ledger_row_count")
        if exact_replay_ledger_fill_count <= 0:
            blockers.append("missing_exact_replay_ledger_fill_count")
        screening = _mapping(item.get("screening"))
        staged_search = _mapping(item.get("staged_search"))
        if (
            bool(item.get("exact_replay_ledger_artifact_proof_only"))
            or bool(item.get("runtime_ledger_artifact_proof_only"))
            or bool(screening.get("proof_only_full_window_replay_captured"))
            or str(staged_search.get("stage") or "").endswith("_full_window_proof")
        ):
            blockers.append("proof_only_full_window_replay_not_probation_authority")
        source_lineage_ok = _candidate_source_lineage_ok(item)
        exact_replay_parity_ok = _candidate_exact_replay_parity_ok(
            item,
            artifact_refs=artifact_refs,
            exact_replay_ledger_row_count=exact_replay_ledger_row_count,
            exact_replay_ledger_fill_count=exact_replay_ledger_fill_count,
        )
        if not source_lineage_ok:
            blockers.append("missing_source_lineage")
        if not exact_replay_parity_ok:
            blockers.append("failed_exact_replay_parity")
        if (
            artifact_refs
            and exact_replay_ledger_row_count > 0
            and exact_replay_ledger_fill_count > 0
        ):
            blockers.extend(_candidate_replay_tape_metadata_blockers(item))
            blockers.extend(_candidate_post_cost_proof_blockers(item))
        open_position_count = _candidate_runtime_ledger_count(
            item,
            "runtime_ledger_open_position_count",
            "exact_replay_ledger_open_position_count",
        )
        if open_position_count > 0:
            blockers.append("open_replay_positions")
        blockers = list(dict.fromkeys(blockers))
        handoff_diagnostics = _candidate_handoff_diagnostics(
            item,
            hard_vetoes=hard_vetoes,
            artifact_refs=artifact_refs,
            exact_replay_ledger_row_count=exact_replay_ledger_row_count,
            exact_replay_ledger_fill_count=exact_replay_ledger_fill_count,
            source_lineage_ok=source_lineage_ok,
            exact_replay_parity_ok=exact_replay_parity_ok,
        )
        paper_probation_allowed = not blockers
        bounded_sim_handoff = _bounded_sim_handoff_metadata(
            item=item,
            paper_probation_allowed=paper_probation_allowed,
            source_lineage_ok=source_lineage_ok,
            exact_replay_parity_ok=exact_replay_parity_ok,
            diagnostics=handoff_diagnostics,
        )
        net_pnl_per_day = _candidate_metric_decimal(
            item,
            scorecard_key="net_pnl_per_day",
            full_window_key="net_per_day",
        )
        net_pnl = _candidate_metric_decimal(
            item,
            scorecard_key="net_pnl",
            full_window_key="net_pnl",
        )
        capital_repair_notional_scale = _paper_probation_notional_scale_decimal(
            item=item,
            objective_veto_policy=objective_veto_policy,
            hard_vetoes=hard_vetoes,
        )
        capital_repaired_net_pnl_per_day = (
            net_pnl_per_day * capital_repair_notional_scale
        )
        capital_repaired_target_shortfall = max(
            target_net_pnl_per_day - capital_repaired_net_pnl_per_day,
            Decimal("0"),
        )
        target_notional_scale_after_capital_repair = (
            _paper_probation_target_notional_scale(
                capital_repaired_net_pnl_per_day=capital_repaired_net_pnl_per_day,
                target_net_pnl_per_day=target_net_pnl_per_day,
            )
        )
        target_shortfall = max(target_net_pnl_per_day - net_pnl_per_day, Decimal("0"))
        repair_plan = _paper_probation_repair_plan(
            item=item,
            blockers=blockers,
            hard_vetoes=hard_vetoes,
            handoff_diagnostics=handoff_diagnostics,
            net_pnl_per_day=net_pnl_per_day,
            target_net_pnl_per_day=target_net_pnl_per_day,
            capital_repair_notional_scale=capital_repair_notional_scale,
            capital_repaired_net_pnl_per_day=capital_repaired_net_pnl_per_day,
            target_notional_scale_after_capital_repair=(
                target_notional_scale_after_capital_repair
            ),
        )
        required_actions = _paper_probation_required_actions(hard_vetoes)
        if target_notional_scale_after_capital_repair > Decimal("1"):
            required_actions.append(
                "validate_target_notional_scale_capacity_before_paper_orders"
            )
        entry = {
            "candidate_id": str(item.get("candidate_id") or ""),
            "strategy_name": str(item.get("strategy_name") or ""),
            "family": str(item.get("family") or ""),
            "stage": "paper_evidence_collection_only",
            "paper_probation_allowed": paper_probation_allowed,
            "evidence_collection_ok": bounded_sim_handoff["evidence_collection_ok"],
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
            "probation_blockers": blockers,
            "handoff_diagnostics": handoff_diagnostics,
            "bounded_sim_handoff": bounded_sim_handoff,
            "paper_probation_repair_plan": repair_plan,
            "required_actions_before_or_during_probation": list(
                dict.fromkeys(required_actions)
            ),
            "live_paper_evidence_requirements": repair_plan[
                "live_paper_evidence_requirements"
            ],
            "safe_evidence_collection_path": repair_plan[
                "safe_evidence_collection_path"
            ],
            "live_capital_authorized": False,
            "recommended_notional_scale": _decimal_payload(
                capital_repair_notional_scale
            ),
            "capital_repaired_net_pnl_per_day": _decimal_payload(
                capital_repaired_net_pnl_per_day
            ),
            "capital_repaired_target_shortfall": _decimal_payload(
                capital_repaired_target_shortfall
            ),
            "target_notional_scale_after_capital_repair": _decimal_payload(
                target_notional_scale_after_capital_repair
            ),
            "target_scale_required": (
                target_notional_scale_after_capital_repair > Decimal("1")
            ),
            "target_scale_authority": "planning_only_requires_bounded_paper_validation",
            "exact_replay_ledger_artifact_refs": artifact_refs,
            "exact_replay_ledger_artifact_row_count": (exact_replay_ledger_row_count),
            "exact_replay_ledger_artifact_fill_count": (exact_replay_ledger_fill_count),
            "target_net_pnl_per_day": _decimal_payload(target_net_pnl_per_day),
            "target_shortfall": _decimal_payload(target_shortfall),
            "target_progress_ratio": _decimal_payload(
                _paper_probation_target_progress(
                    net_pnl_per_day=net_pnl_per_day,
                    target_net_pnl_per_day=target_net_pnl_per_day,
                )
            ),
            "net_pnl_per_day": str(net_pnl_per_day),
            "net_pnl": str(net_pnl),
            "active_day_ratio": str(
                _candidate_metric_value(
                    item,
                    scorecard_key="active_day_ratio",
                    full_window_key="active_ratio",
                )
            ),
            "positive_day_ratio": str(
                _candidate_metric_value(
                    item,
                    scorecard_key="positive_day_ratio",
                    full_window_key="positive_day_ratio",
                )
            ),
            "max_drawdown": str(
                _candidate_metric_value(
                    item,
                    scorecard_key="max_drawdown",
                    full_window_key="max_drawdown",
                )
            ),
            "worst_day_loss": str(
                _candidate_metric_value(
                    item,
                    scorecard_key="worst_day_loss",
                    full_window_key="worst_day_loss",
                )
            ),
            "max_gross_exposure_pct_equity": str(
                _candidate_metric_value(
                    item,
                    scorecard_key="max_gross_exposure_pct_equity",
                    full_window_key="max_gross_exposure_pct_equity",
                )
            ),
            "min_cash": str(
                _candidate_metric_value(
                    item,
                    scorecard_key="min_cash",
                    full_window_key="min_cash",
                )
            ),
            "exact_replay_ledger_artifact_ref": str(
                item.get("exact_replay_ledger_artifact_ref") or ""
            ),
            "replay_artifact_refs": artifact_refs,
            "hard_vetoes": hard_vetoes,
        }
        shortlist_candidates.append(
            (
                paper_probation_allowed,
                bool(bounded_sim_handoff["evidence_collection_ok"]),
                capital_repaired_target_shortfall,
                target_notional_scale_after_capital_repair,
                net_pnl_per_day,
                net_pnl,
                entry["candidate_id"],
                entry,
            )
        )

    shortlist_candidates.sort(
        key=lambda candidate: (
            0 if candidate[0] else 1,
            0 if candidate[1] else 1,
            candidate[2],
            candidate[3],
            -candidate[4],
            -candidate[5],
            candidate[6],
        )
    )
    return [candidate[7] for candidate in shortlist_candidates[: max(1, int(top_n))]]


__all__ = [
    "_PAPER_PROBATION_CAPITAL_REPAIR_REASONS",
    "_PAPER_PROBATION_LOSS_REPAIR_REASONS",
    "_PAPER_PROBATION_ACTIVITY_REPAIR_REASONS",
    "_PAPER_PROBATION_TAIL_RISK_REASONS",
    "_PAPER_PROBATION_QUEUE_SURVIVAL_REASONS",
    "_PAPER_PROBATION_TARGET_SCALE_QUANTUM",
    "_PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS",
    "_PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH",
    "_safe_decimal",
    "_candidate_metric_value",
    "_candidate_artifact_refs",
    "_candidate_exact_replay_ledger_artifact_refs",
    "_candidate_runtime_ledger_count",
    "_paper_probation_required_actions",
    "_paper_probation_notional_scale_decimal",
    "_paper_probation_notional_scale",
    "_paper_probation_target_notional_scale",
    "_candidate_metric_decimal",
    "_candidate_source_lineage_ok",
    "_candidate_replay_tape_metadata_blockers",
    "_candidate_post_cost_proof_blockers",
    "_candidate_exact_replay_parity_ok",
    "_candidate_handoff_diagnostics",
    "_bounded_sim_handoff_metadata",
    "_paper_probation_repair_actions",
    "_paper_probation_target_progress",
    "_paper_probation_repair_plan",
    "_build_paper_probation_shortlist",
]
