from __future__ import annotations

import hashlib
import json
from datetime import time
from decimal import Decimal
from pathlib import Path
from typing import Any, Mapping, Sequence, cast
from zoneinfo import ZoneInfo

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle


_CANDIDATE_BOARD_RUNTIME_SESSION_TZ = ZoneInfo("America/New_York")


_CANDIDATE_BOARD_RUNTIME_SESSION_OPEN = time(hour=9, minute=30)


_CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE = time(hour=16, minute=0)


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


_SECOND_OOS_WINDOW_ID = "second_oos"


_RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS = frozenset(
    {
        "shadow_parity_status_failed",
        "executable_replay_passed_failed",
        "executable_replay_artifact_present_failed",
        "executable_replay_order_count_failed",
        "executable_replay_account_buying_power_failed",
        "executable_replay_max_notional_per_trade_failed",
        "executable_replay_notional_within_buying_power_failed",
        "market_impact_stress_passed_failed",
        "market_impact_stress_artifact_present_failed",
        "market_impact_liquidity_evidence_present_failed",
        "market_impact_stress_model_failed",
        "market_impact_stress_cost_bps_failed",
        "market_impact_stress_net_pnl_per_day_failed",
        "delay_adjusted_depth_stress_passed_failed",
        "delay_adjusted_depth_stress_artifact_present_failed",
        "delay_adjusted_depth_stress_model_failed",
        "delay_adjusted_depth_stress_ms_failed",
        "delay_adjusted_depth_fillable_notional_per_day_failed",
        "delay_adjusted_depth_stress_net_pnl_per_day_failed",
        "double_oos_passed_failed",
        "double_oos_artifact_present_failed",
        "double_oos_independent_window_count_failed",
        "double_oos_pass_rate_failed",
        "double_oos_net_pnl_per_day_failed",
        "double_oos_cost_shock_net_pnl_per_day_failed",
    }
)


def _resolve_existing_path(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    if path.is_absolute() or resolved.exists():
        return resolved
    for parent in Path(__file__).resolve().parents:
        candidate = (parent / path).resolve()
        if candidate.exists():
            return candidate
    return resolved


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _decimal(value: Any, *, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value if value is not None else default))
    except Exception:
        return Decimal(default)


def _decimal_payload(value: Decimal) -> str:
    text = format(value.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def _mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in value.items()}
        if isinstance(value, Mapping)
        else {}
    )


def _string(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _list_of_mappings(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, list):
        return []
    return [
        cast(Mapping[str, Any], item) for item in value if isinstance(item, Mapping)
    ]


def _sequence_of_mappings(value: Any) -> list[Mapping[str, Any]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return []
    return [
        cast(Mapping[str, Any], item)
        for item in cast(Sequence[Any], value)
        if isinstance(item, Mapping)
    ]


def _rank_sort_value(value: Any) -> int:
    try:
        return int(str(value))
    except Exception:
        return 10**9


def _proposal_sort_value(value: Any) -> float:
    try:
        return float(str(value))
    except Exception:
        return 0.0


def _string_list_from_value(value: Any) -> list[str]:
    if not isinstance(value, Sequence) or isinstance(value, str):
        return []
    rows = cast(Sequence[Any], value)
    return [text for item in rows if (text := _string(item))]


def _candidate_board_runtime_ledger_lineage_handoff(
    *,
    scorecard: Mapping[str, Any],
    evidence: CandidateEvidenceBundle | None,
) -> dict[str, Any]:
    scorecard_handoff = _mapping(
        scorecard.get("runtime_ledger_lineage_materialization_handoff")
    )
    if scorecard_handoff:
        return scorecard_handoff
    if evidence is None:
        return {}
    promotion_readiness = _mapping(evidence.promotion_readiness)
    return _mapping(
        promotion_readiness.get("runtime_ledger_lineage_materialization_handoff")
    )


def _candidate_board_runtime_ledger_required_materialized_artifacts(
    handoff: Mapping[str, Any],
) -> list[str]:
    raw_artifacts = handoff.get("required_materialized_artifacts") or handoff.get(
        "required_artifacts"
    )
    if isinstance(raw_artifacts, str):
        artifacts = [_string(raw_artifacts)]
    elif isinstance(raw_artifacts, Sequence):
        artifacts = []
        for item in cast(Sequence[Any], raw_artifacts):
            if isinstance(item, Mapping):
                artifact = _string(
                    item.get("artifact_ref")
                    or item.get("ref")
                    or item.get("path")
                    or item.get("name")
                    or item.get("artifact")
                )
            else:
                artifact = _string(item)
            if artifact:
                artifacts.append(artifact)
    else:
        artifacts = []
    return list(dict.fromkeys(artifacts))


def _candidate_spec_requires_rejected_signal_outcome_learning(
    spec: CandidateSpec,
) -> bool:
    overlays = spec.parameter_space.get("mechanism_overlay_ids", ())
    overlay_ids = set(_string_list_from_value(overlays))
    return (
        "rejected_signal_outcome_calibration" in overlay_ids
        or _boolish(
            spec.promotion_contract.get("requires_rejected_signal_outcome_learning")
        )
        or "required_min_rejected_signal_outcome_label_count" in spec.hard_vetoes
    )


def _boolish(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return _string(value).lower() in {"1", "true", "yes", "y", "passed"}


def _oracle_blockers(scorecard: Mapping[str, Any]) -> frozenset[str]:
    raw_blockers = _mapping(scorecard.get("profit_target_oracle")).get("blockers")
    if not isinstance(raw_blockers, Sequence) or isinstance(raw_blockers, str):
        return frozenset()
    return frozenset(
        blocker
        for blocker in (_string(item) for item in cast(Sequence[Any], raw_blockers))
        if blocker
    )


__all__ = [
    "_CANDIDATE_BOARD_RUNTIME_SESSION_TZ",
    "_CANDIDATE_BOARD_RUNTIME_SESSION_OPEN",
    "_CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE",
    "_PAPER_PROBATION_LIVE_PAPER_EVIDENCE_REQUIREMENTS",
    "_PAPER_PROBATION_SAFE_EVIDENCE_COLLECTION_PATH",
    "_SECOND_OOS_WINDOW_ID",
    "_RUNTIME_CLOSURE_PROOF_ORACLE_BLOCKERS",
    "_resolve_existing_path",
    "_stable_hash",
    "_decimal",
    "_decimal_payload",
    "_mapping",
    "_string",
    "_list_of_mappings",
    "_sequence_of_mappings",
    "_rank_sort_value",
    "_proposal_sort_value",
    "_string_list_from_value",
    "_candidate_board_runtime_ledger_lineage_handoff",
    "_candidate_board_runtime_ledger_required_materialized_artifacts",
    "_candidate_spec_requires_rejected_signal_outcome_learning",
    "_boolish",
    "_oracle_blockers",
]
