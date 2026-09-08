from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.objectives import (
    deployable_lower_bound_missing_count,
    deployable_proof_failed_gate_count,
)
from app.trading.discovery.portfolio_optimizer import PortfolioCandidateSpec
from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_decimal_field,
    _candidate_board_int_field,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_summaries import (
    _candidate_board_market_impact_proof_summary,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_status import (
    _candidate_board_activity_count,
    _candidate_board_lower_bound_net_pnl,
    _candidate_board_oracle_blocker_count,
    _candidate_board_paper_probation_admission_blockers,
    _candidate_board_required_notional_repair_scale,
    _candidate_board_target_progress_ratio,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS,
    _PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH,
    _boolish,
    _decimal,
    _decimal_payload,
    _list_of_mappings,
    _mapping,
    _oracle_blockers,
    _rank_sort_value,
    _string,
)


def _paper_probation_candidate_payload(
    *,
    candidate: Mapping[str, Any],
    target: Decimal,
    rank: int,
) -> dict[str, Any]:
    payload = dict(candidate)
    lower_bound = _candidate_board_lower_bound_net_pnl(payload)
    target_shortfall = max(target - lower_bound, Decimal("0"))
    target_progress_ratio = _candidate_board_target_progress_ratio(
        lower_bound=lower_bound,
        target=target,
    )
    required_notional_repair_scale = _candidate_board_required_notional_repair_scale(
        lower_bound=lower_bound,
        target=target,
    )
    deployable_missing_count = deployable_lower_bound_missing_count(payload)
    deployable_failed_gate_count = deployable_proof_failed_gate_count(payload)
    final_promotion_blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], payload.get("blockers") or ())
        if _string(blocker)
    ]
    if not final_promotion_blockers:
        final_promotion_blockers.append("final_promotion_requires_runtime_governance")
    live_paper_evidence_requirements = list(
        _PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS
    )
    safe_evidence_collection_path = list(_PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH)
    if bool(payload.get("required_seed_model_family_robustness")):
        live_paper_evidence_requirements.extend(
            (
                "seed_robustness_replay_grid",
                "model_family_robustness_replay_grid",
            )
        )
        safe_evidence_collection_path.extend(
            (
                "run_offline_seed_model_family_robustness_grid_before_paper_probation",
                "attach_seed_model_family_robustness_artifact_to_evidence_bundle",
            )
        )
    payload.update(
        {
            "candidate_selection": "oracle_recommended_paper_probation",
            "paper_probation_tier": "paper_probation",
            "paper_probation_rank": rank,
            "paper_probation_authorized": True,
            "probation_allowed": True,
            "paper_probation_authorization_scope": "evidence_collection_only",
            "evidence_collection_stage": "paper",
            "probation_reason": "runtime_evidence_collection_only",
            "selection_reason": "target_met_but_oracle_blocked"
            if bool(payload.get("target_met"))
            else "closest_lower_bound_economics_below_target",
            "selected_by": "candidate_board_paper_probation_candidate",
            "probation_lower_bound_net_pnl_per_day": _decimal_payload(lower_bound),
            "probation_target_shortfall": _decimal_payload(target_shortfall),
            "probation_target_progress_ratio": _decimal_payload(target_progress_ratio),
            "required_notional_repair_scale_to_target": _decimal_payload(
                required_notional_repair_scale
            ),
            "required_notional_repair_scale_authority": (
                "linear_notional_sizing_estimate_for_repair_only_not_capital_authority"
            ),
            "live_paper_evidence_requirements": list(
                dict.fromkeys(live_paper_evidence_requirements)
            ),
            "safe_evidence_collection_path": list(
                dict.fromkeys(safe_evidence_collection_path)
            ),
            "live_capital_authorized": False,
            "final_promotion_requires_live_paper_runtime_proof": True,
            "deployable_lower_bound_missing_count": deployable_missing_count,
            "deployable_lower_bound_failed_gate_count": deployable_failed_gate_count,
            "promotion_allowed": False,
            "promotion_gate": "existing_runtime_governance_fail_closed",
            "final_promotion_authorized": False,
            "final_promotion_allowed": False,
            "promotion_blockers": list(dict.fromkeys(final_promotion_blockers)),
            "final_promotion_blockers": list(dict.fromkeys(final_promotion_blockers)),
        }
    )
    return payload


def _candidate_board_paper_probation_candidates(
    rows: Sequence[Mapping[str, Any]],
    *,
    target: Decimal,
    limit: int = 1,
) -> tuple[dict[str, Any], ...]:
    candidates = [
        dict(row)
        for row in rows
        if bool(row.get("has_replay_evidence"))
        and not bool(row.get("oracle_passed"))
        and _candidate_board_activity_count(row) > 0
        and _string(row.get("candidate_id"))
        and _string(row.get("hypothesis_id"))
        and _string(row.get("runtime_family"))
        and _string(row.get("runtime_strategy_name"))
    ]
    if not candidates:
        return ()

    admitted_candidates = [
        candidate
        for candidate in candidates
        if not _candidate_board_paper_probation_admission_blockers(candidate)
        and _candidate_board_lower_bound_net_pnl(candidate) > 0
    ]
    if not admitted_candidates:
        return ()

    def rank(row: Mapping[str, Any]) -> tuple[Any, ...]:
        lower_bound = _candidate_board_lower_bound_net_pnl(row)
        target_shortfall = max(target - lower_bound, Decimal("0"))
        return (
            lower_bound > 0,
            _candidate_board_int_field(row, "filled_order_count") > 0,
            _candidate_board_int_field(row, "submitted_order_count") > 0,
            -target_shortfall,
            lower_bound,
            _decimal(row.get("active_day_ratio")),
            _decimal(row.get("positive_day_ratio")),
            -_decimal(row.get("best_day_share"), default="1"),
            -_decimal(row.get("worst_day_loss")),
            -_candidate_board_oracle_blocker_count(row),
            _candidate_board_activity_count(row),
            -_rank_sort_value(row.get("rank")),
            _string(row.get("candidate_spec_id")),
        )

    admitted_candidates.sort(key=rank, reverse=True)
    selected = admitted_candidates[: max(1, int(limit))]
    return tuple(
        _paper_probation_candidate_payload(
            candidate=candidate,
            target=target,
            rank=index,
        )
        for index, candidate in enumerate(selected, start=1)
    )


def _candidate_board_paper_probation_candidate(
    rows: Sequence[Mapping[str, Any]],
    *,
    target: Decimal,
) -> dict[str, Any] | None:
    candidates = _candidate_board_paper_probation_candidates(
        rows,
        target=target,
        limit=1,
    )
    return candidates[0] if candidates else None


def _candidate_board_status_digest(rows: Sequence[Mapping[str, Any]]) -> str:
    digest_rows = [
        {
            "candidate_spec_id": _string(row.get("candidate_spec_id")),
            "candidate_id": _string(row.get("candidate_id")),
            "rank": _rank_sort_value(row.get("rank")),
            "status": _string(row.get("status")),
            "target_met": bool(row.get("target_met")),
            "oracle_passed": bool(row.get("oracle_passed")),
            "activity_count": _candidate_board_activity_count(row),
            "market_impact_proof_state": _string(
                _mapping(row.get("market_impact_proof")).get("state")
            ),
            "regime_specialist_state": _string(
                _mapping(row.get("regime_specialist_validation")).get("state")
            ),
            "blockers": [
                _string(blocker)
                for blocker in cast(Sequence[Any], row.get("blockers") or ())
            ],
        }
        for row in rows
    ]
    encoded = json.dumps(digest_rows, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _candidate_board_double_oos_summary(
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    replayed_rows = [row for row in rows if bool(row.get("has_replay_evidence"))]
    artifact_rows = [
        row
        for row in replayed_rows
        if bool(_string(row.get("double_oos_artifact_ref")))
    ]
    passed_rows = [row for row in replayed_rows if bool(row.get("double_oos_passed"))]
    missing_artifact_rows = [
        row
        for row in replayed_rows
        if not bool(_string(row.get("double_oos_artifact_ref")))
    ]
    independent_window_counts = [
        _candidate_board_int_field(row, "double_oos_independent_window_count")
        for row in replayed_rows
    ]
    blockers: list[str] = []
    if replayed_rows and missing_artifact_rows:
        blockers.append("double_oos_artifact_missing_for_replayed_candidates")
    if replayed_rows and not passed_rows:
        blockers.append("no_candidate_passed_double_oos")
    return {
        "replayed_candidate_count": len(replayed_rows),
        "artifact_candidate_count": len(artifact_rows),
        "passed_candidate_count": len(passed_rows),
        "missing_artifact_candidate_count": len(missing_artifact_rows),
        "max_independent_window_count": max(independent_window_counts, default=0),
        "blockers": blockers,
    }


def _candidate_board_portfolio_promotion_subject(
    *,
    portfolio: PortfolioCandidateSpec | None,
    portfolio_payload: Mapping[str, Any],
    portfolio_scorecard: Mapping[str, Any],
    promotion_readiness: Mapping[str, Any],
    runtime_closure: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> dict[str, Any] | None:
    if portfolio is None:
        return None
    source_candidate_ids = [
        _string(candidate_id)
        for candidate_id in cast(Sequence[Any], portfolio.source_candidate_ids)
        if _string(candidate_id)
    ]
    sleeve_candidate_spec_ids = [
        _string(sleeve.get("candidate_spec_id"))
        for sleeve in _list_of_mappings(portfolio_payload.get("sleeves"))
        if _string(sleeve.get("candidate_spec_id"))
    ]
    readiness_blockers = [
        _string(blocker)
        for blocker in cast(Sequence[Any], promotion_readiness.get("blockers") or ())
        if _string(blocker)
    ]
    blockers = list(
        dict.fromkeys([*_oracle_blockers(portfolio_scorecard), *readiness_blockers])
    )
    return {
        "type": "portfolio",
        "portfolio_candidate_id": _string(
            portfolio_payload.get("portfolio_candidate_id")
        ),
        "source_candidate_ids": source_candidate_ids,
        "sleeve_candidate_spec_ids": sleeve_candidate_spec_ids,
        "oracle_passed": _boolish(portfolio_scorecard.get("oracle_passed")),
        "target_met": _boolish(portfolio_scorecard.get("target_met")),
        "net_pnl_per_day": _candidate_board_decimal_field(
            portfolio_scorecard, "net_pnl_per_day"
        )
        or _candidate_board_decimal_field(
            portfolio_scorecard, "portfolio_post_cost_net_pnl_per_day"
        ),
        "market_impact_proof": _candidate_board_market_impact_proof_summary(
            portfolio_scorecard
        ),
        "runtime_closure_status": _string(runtime_closure.get("status")),
        "promotion_readiness_status": _string(promotion_readiness.get("status")),
        "promotable": _boolish(promotion_readiness.get("promotable")),
        "component_rows": [
            {
                "candidate_spec_id": _string(row.get("candidate_spec_id")),
                "candidate_id": _string(row.get("candidate_id")),
                "status": _string(row.get("status")),
                "oracle_passed": _boolish(row.get("oracle_passed")),
                "target_met": _boolish(row.get("target_met")),
                "market_impact_proof_state": _string(
                    _mapping(row.get("market_impact_proof")).get("state")
                ),
                "regime_specialist_state": _string(
                    _mapping(row.get("regime_specialist_validation")).get("state")
                ),
            }
            for row in rows
            if _string(row.get("candidate_spec_id")) in set(sleeve_candidate_spec_ids)
        ],
        "blockers": blockers,
    }


__all__ = [
    "_paper_probation_candidate_payload",
    "_candidate_board_paper_probation_candidates",
    "_candidate_board_paper_probation_candidate",
    "_candidate_board_status_digest",
    "_candidate_board_double_oos_summary",
    "_candidate_board_portfolio_promotion_subject",
]
