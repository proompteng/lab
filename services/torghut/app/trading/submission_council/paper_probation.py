"""Runtime ledger paper probation candidate helpers."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast

from app.trading.evidence_collection_policy import (
    paper_probation_policy,
    source_collection_policy,
)

from .common import (
    POST_COST_PNL_BASIS,
    RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
    RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
    RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
    bounded_paper_route_probe_collection_payload as _bounded_paper_route_probe_collection_payload,
    explicit_runtime_strategy_name_or_family_harness,
    normalize_reason_codes as _normalize_reason_codes,
    regular_session_close_utc_for,
    regular_session_open_utc_for,
    runtime_ledger_promotion_source_authority_blockers,
    safe_decimal as _safe_decimal,
    safe_int as _safe_int,
    safe_text as _safe_text,
)

RUNTIME_LEDGER_PAPER_PROBATION_REASON = "runtime_ledger_stage_not_live"
RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS = {RUNTIME_LEDGER_PAPER_PROBATION_REASON}
_RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION = (
    "torghut.runtime-ledger-paper-probation-import-plan.v1"
)
_RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND = "durable_runtime_ledger_bucket"
_RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV = (
    "TORGHUT_DURABLE_RUNTIME_LEDGER_SOURCE_DSN"
)
_RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS = (
    RUNTIME_LEDGER_PAPER_PROBATION_REASON,
    "paper_probation_evidence_collection_only",
    "live_runtime_ledger_required",
)
_RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND = (
    "runtime_ledger_source_collection_candidate"
)
RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_DSN_ENV = "SIM_DB_DSN"
_RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV = "SIM_DB_DSN"
RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE = "strategy_runtime_ledger_buckets"
RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE_DSN_ENVS = {
    "TORGHUT_REPLAY": "DB_DSN",
}
_RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV = "SIM_DB_DSN"
RUNTIME_LEDGER_SOURCE_COLLECTION_TRIGGER_REASONS = frozenset(
    {
        RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_WINDOW_IDS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_TRADE_DECISION_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_EXECUTION_ORDER_EVENT_REFS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_OFFSETS_MISSING_BLOCKER,
        RUNTIME_LEDGER_SOURCE_MATERIALIZATION_MISSING_BLOCKER,
        RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER,
        "execution_reconstruction_not_runtime_ledger_proof",
        "source_decision_mode_not_profit_proof_eligible",
        "runtime_ledger_pnl_basis_invalid",
        "runtime_ledger_pnl_basis_missing",
        "runtime_ledger_expectancy_missing",
    }
)
_RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS = (
    "runtime_ledger_source_collection_only",
    "runtime_ledger_source_window_evidence_pending",
    "live_runtime_ledger_required",
)
_RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS = (
    "runtime_ledger_source_window_refs",
    "runtime_ledger_source_window_ids",
    "runtime_ledger_trade_decision_refs",
    "runtime_ledger_execution_refs",
    "runtime_ledger_execution_order_event_refs",
    "runtime_ledger_source_offsets",
    "runtime_ledger_source_materialization",
    "post_cost_tca_cost_refs",
    "closed_flat_reconciliation",
)
_RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH = (
    "materialize_runtime_ledger_source_window_refs",
    "attach_trade_decision_execution_and_order_event_refs",
    "persist_runtime_ledger_source_offsets_and_materialization",
    "reconcile_post_cost_tca_and_closed_flat_state",
    "rerun_live_paper_runtime_ledger_proof_before_final_promotion",
)
_RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS = Decimal("500")
_RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON = (
    "profit_target_source_window_evidence_pending"
)
_HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID = "H-PAIRS-01"
_HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID = "c88421d619759b2cfaa6f4d0"
_BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND = "paper_route_probe_runtime_observed"
_BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE = "paper_route_probe_next_session_only"
_BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS = (
    "bounded_paper_route_evidence_collection_only",
    "paper_route_runtime_ledger_import_pending",
    "live_runtime_ledger_required",
)
RUNTIME_LEDGER_PAPER_PROBATION_MIN_CLOSED_ROUND_TRIPS = 1


def _runtime_ledger_paper_probation_payload(
    candidate: Mapping[str, object],
) -> dict[str, object]:
    payload: dict[str, object] = {}
    raw_bucket = candidate.get("runtime_ledger_bucket")
    if isinstance(raw_bucket, Mapping):
        payload.update(cast(Mapping[str, object], raw_bucket))
    payload.update(
        {
            str(key): value
            for key, value in candidate.items()
            if key != "runtime_ledger_bucket"
        }
    )
    return payload


def _runtime_ledger_paper_probation_blockers(
    candidate: Mapping[str, object],
) -> list[str]:
    payload = _runtime_ledger_paper_probation_payload(candidate)
    blockers: list[str] = []
    reasons = {
        str(reason).strip()
        for reason in cast(Sequence[object], payload.get("reason_codes") or [])
        if str(reason).strip()
    }
    unexpected_reasons = reasons - RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS
    blockers.extend(sorted(unexpected_reasons))
    blockers.extend(runtime_ledger_paper_probation_activity_blockers(payload))
    blockers.extend(runtime_ledger_paper_probation_hash_blockers(payload))
    blockers.extend(runtime_ledger_promotion_source_authority_blockers(payload))
    return _normalize_reason_codes(blockers)


def runtime_ledger_paper_probation_activity_blockers(
    payload: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []
    if _safe_text(payload.get("observed_stage")) != "paper":
        blockers.append("runtime_ledger_stage_not_paper")
    if _safe_text(payload.get("pnl_basis")) != POST_COST_PNL_BASIS:
        blockers.append("runtime_ledger_pnl_basis_missing")
    for field, blocker in (
        ("decision_count", "runtime_ledger_decisions_missing"),
        ("submitted_order_count", "runtime_order_lifecycle_missing"),
        ("fill_count", "runtime_ledger_fills_missing"),
    ):
        if _safe_int(payload.get(field)) <= 0:
            blockers.append(blocker)
    if (_safe_decimal(payload.get("filled_notional")) or Decimal("0")) <= 0:
        blockers.append("runtime_ledger_filled_notional_missing")
    if (
        _safe_int(payload.get("closed_trade_count"))
        < RUNTIME_LEDGER_PAPER_PROBATION_MIN_CLOSED_ROUND_TRIPS
    ):
        blockers.append("runtime_ledger_closed_round_trips_missing")
    if _safe_int(payload.get("open_position_count")) > 0:
        blockers.append("unclosed_position")
    blockers.extend(runtime_ledger_paper_probation_profit_blockers(payload))
    return blockers


def runtime_ledger_paper_probation_profit_blockers(
    payload: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []
    if (
        _safe_decimal(payload.get("net_strategy_pnl_after_costs")) or Decimal("0")
    ) <= 0:
        blockers.append("post_cost_pnl_non_positive")
    if (_safe_decimal(payload.get("post_cost_expectancy_bps")) or Decimal("0")) <= 0:
        blockers.append("post_cost_expectancy_non_positive")
    if _safe_decimal(payload.get("cost_amount")) is None:
        blockers.append("runtime_ledger_explicit_costs_missing")
    return blockers


def runtime_ledger_paper_probation_hash_blockers(
    payload: Mapping[str, object],
) -> list[str]:
    blockers: list[str] = []
    for payload_key, observed_key, blocker in (
        (
            "execution_policy_hash_counts",
            "runtime_ledger_execution_policy_hash_count",
            "runtime_ledger_execution_policy_hash_missing",
        ),
        (
            "cost_model_hash_counts",
            "runtime_ledger_cost_model_hash_count",
            "runtime_ledger_cost_model_hash_missing",
        ),
        (
            "lineage_hash_counts",
            "runtime_ledger_lineage_hash_count",
            "runtime_ledger_lineage_hash_missing",
        ),
    ):
        if (
            _runtime_ledger_hash_count(
                payload,
                payload_key=payload_key,
                observed={},
                observed_key=observed_key,
            )
            <= 0
        ):
            blockers.append(blocker)
    return blockers


def _runtime_ledger_hash_count(
    payload: Mapping[str, object],
    *,
    payload_key: str,
    observed: Mapping[str, object],
    observed_key: str,
) -> int:
    payload_counts = payload.get(payload_key)
    if isinstance(payload_counts, Mapping):
        total = 0
        for raw_value in cast(Mapping[str, object], payload_counts).values():
            count = _safe_int(raw_value)
            if count > 0:
                total += count
        return total
    payload_count = _safe_int(payload_counts)
    if payload_count > 0:
        return payload_count
    return _safe_int(observed.get(observed_key))


def runtime_ledger_paper_probation_eligible(
    candidate: Mapping[str, object],
) -> bool:
    reasons = {
        str(reason).strip()
        for reason in cast(Sequence[object], candidate.get("reason_codes") or [])
        if str(reason).strip()
    }
    return (
        reasons == RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS
        and not _runtime_ledger_paper_probation_blockers(candidate)
    )


def runtime_ledger_paper_probation_candidates(
    candidates: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    return [
        {
            **dict(candidate),
            "paper_probation_eligible": True,
            "paper_probation_scope": "evidence_collection_only",
            "proof_mode": "probation",
            "canary_collection_authorized": True,
            "paper_probation_satisfied_for_bounded_live_paper_collection": True,
            **paper_probation_policy(
                blockers=_RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS,
                bounded_live_paper_collection_authorized=True,
            ).as_target_fields(),
            "paper_probation_reason_codes": [RUNTIME_LEDGER_PAPER_PROBATION_REASON],
            "paper_probation_target_capital_stage": "shadow",
            **_bounded_paper_route_probe_collection_payload(authorized=True),
        }
        for candidate in candidates
        if runtime_ledger_paper_probation_eligible(candidate)
    ]


def runtime_ledger_source_collection_candidate(
    candidate: Mapping[str, object],
) -> bool:
    if runtime_ledger_paper_probation_eligible(candidate):
        return False
    reasons = {
        str(reason).strip()
        for reason in cast(Sequence[object], candidate.get("reason_codes") or [])
        if str(reason).strip()
    }
    filled_notional = _safe_decimal(candidate.get("filled_notional")) or Decimal("0")
    return (
        _safe_text(candidate.get("observed_stage")) == "paper"
        and bool(reasons & RUNTIME_LEDGER_SOURCE_COLLECTION_TRIGGER_REASONS)
        and filled_notional > 0
        and _safe_int(candidate.get("fill_count")) > 0
        and _safe_int(candidate.get("submitted_order_count")) > 0
    )


def runtime_ledger_source_collection_profit_target_candidate(
    candidate: Mapping[str, object],
) -> bool:
    payload = _runtime_ledger_paper_probation_payload(candidate)
    net_pnl = _safe_decimal(payload.get("net_strategy_pnl_after_costs")) or Decimal("0")
    expectancy_bps = _safe_decimal(payload.get("post_cost_expectancy_bps")) or Decimal(
        "0"
    )
    return (
        runtime_ledger_source_collection_candidate(candidate)
        and _safe_text(payload.get("pnl_basis")) == POST_COST_PNL_BASIS
        and net_pnl
        >= _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS
        and expectancy_bps > 0
        and _safe_int(payload.get("closed_trade_count"))
        >= RUNTIME_LEDGER_PAPER_PROBATION_MIN_CLOSED_ROUND_TRIPS
        and _safe_int(payload.get("open_position_count")) <= 0
        and _safe_decimal(payload.get("cost_amount")) is not None
    )


def runtime_ledger_source_collection_target_progress_payload(
    *,
    net_pnl_after_costs: Decimal,
    filled_notional: Decimal,
) -> dict[str, object]:
    target = _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS
    shortfall = max(target - net_pnl_after_costs, Decimal("0"))
    progress_ratio = net_pnl_after_costs / target if target > 0 else Decimal("0")
    if net_pnl_after_costs > 0:
        required_notional_scale = max(target / net_pnl_after_costs, Decimal("1"))
    else:
        required_notional_scale = Decimal("0")
    required_notional = filled_notional * required_notional_scale
    return {
        "probation_target_shortfall": str(shortfall),
        "probation_target_progress_ratio": str(progress_ratio),
        "required_notional_repair_scale_to_target": str(required_notional_scale),
        "required_notional_to_reach_target": str(required_notional),
        "required_notional_repair_scale_authority": (
            "linear_notional_sizing_estimate_for_repair_only_not_capital_authority"
        ),
    }


def runtime_ledger_source_collection_profit_target_metadata(
    candidate: Mapping[str, object],
) -> dict[str, object]:
    payload = _runtime_ledger_paper_probation_payload(candidate)
    profit_target_candidate = runtime_ledger_source_collection_profit_target_candidate(
        candidate
    )
    metadata: dict[str, object] = {
        "source_collection_profit_target_candidate": profit_target_candidate,
        "source_collection_profit_target_net_pnl_after_costs": str(
            _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS
        ),
        "source_collection_priority": "source_window_evidence_collection",
    }
    if profit_target_candidate:
        net_pnl_after_costs = _safe_decimal(
            payload.get("net_strategy_pnl_after_costs")
        ) or Decimal("0")
        filled_notional = _safe_decimal(payload.get("filled_notional")) or Decimal("0")
        metadata.update(
            {
                "source_collection_priority": "profit_target_source_materialization",
                "source_collection_net_strategy_pnl_after_costs": str(
                    net_pnl_after_costs
                ),
                "source_collection_post_cost_expectancy_bps": str(
                    _safe_decimal(payload.get("post_cost_expectancy_bps"))
                    or Decimal("0")
                ),
                "source_collection_filled_notional": str(filled_notional),
                "source_collection_next_action": (
                    "materialize_runtime_ledger_source_window_refs"
                ),
                **runtime_ledger_source_collection_target_progress_payload(
                    net_pnl_after_costs=net_pnl_after_costs,
                    filled_notional=filled_notional,
                ),
                "live_paper_evidence_requirements": list(
                    _RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS
                ),
                "safe_evidence_collection_path": list(
                    _RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH
                ),
                "live_capital_authorized": False,
                "final_promotion_requires_live_paper_runtime_proof": True,
            }
        )
    return metadata


def runtime_ledger_source_collection_candidates(
    candidates: Sequence[Mapping[str, object]],
) -> list[dict[str, object]]:
    return [
        {
            **dict(candidate),
            **runtime_ledger_source_collection_profit_target_metadata(candidate),
            "source_collection_candidate": True,
            "source_collection_authorized": True,
            "source_collection_scope": "source_window_evidence_collection_only",
            "proof_mode": "probation",
            "paper_probation_satisfied_for_bounded_live_paper_collection": False,
            "canary_collection_authorized": False,
            **source_collection_policy(
                blockers=_RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS,
                bounded_live_paper_collection_authorized=False,
            ).as_target_fields(),
            **_bounded_paper_route_probe_collection_payload(
                authorized=runtime_ledger_source_collection_profit_target_candidate(
                    candidate
                )
            ),
            "source_collection_reason_codes": [
                reason
                for reason in _normalize_reason_codes(
                    [
                        str(raw_reason).strip()
                        for raw_reason in cast(
                            Sequence[object], candidate.get("reason_codes") or []
                        )
                        if str(raw_reason).strip()
                    ]
                )
                if reason in RUNTIME_LEDGER_SOURCE_COLLECTION_TRIGGER_REASONS
            ],
        }
        for candidate in candidates
        if runtime_ledger_source_collection_candidate(candidate)
    ]


def _strategy_lookup_names(*values: object) -> list[str]:
    names: list[str] = []
    for value in values:
        raw_items: Sequence[object]
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            raw_items = cast(Sequence[object], value)
        else:
            raw_items = (value,)
        for raw_item in raw_items:
            text = _safe_text(raw_item)
            if text is not None and text not in names:
                names.append(text)
    return names


def _hypothesis_manifest_ref(hypothesis_id: object) -> str | None:
    text = _safe_text(hypothesis_id)
    if text is None:
        return None
    slug = text.lower().replace("_", "-")
    return f"config/trading/hypotheses/{slug}.json"


def _runtime_ledger_paper_probation_strategy_name(
    candidate: Mapping[str, object],
) -> str | None:
    return explicit_runtime_strategy_name_or_family_harness(
        runtime_strategy_name=candidate.get("runtime_strategy_name"),
        strategy_name=candidate.get("strategy_name"),
        strategy_id=candidate.get("strategy_id"),
    )


def _runtime_ledger_paper_probation_bucket_ref(
    candidate: Mapping[str, object],
) -> str | None:
    run_id = _safe_text(candidate.get("run_id"))
    started_at = _safe_text(candidate.get("bucket_started_at"))
    ended_at = _safe_text(candidate.get("bucket_ended_at"))
    if run_id is None or started_at is None or ended_at is None:
        return None
    return f"strategy_runtime_ledger_buckets:{run_id}:{started_at}:{ended_at}"


def _runtime_ledger_source_collection_source_dsn_env(
    candidate: Mapping[str, object],
) -> str:
    if (
        _safe_text(candidate.get("source"))
        != RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE
    ):
        return RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_DSN_ENV
    account_label = (
        _safe_text(candidate.get("account"))
        or _safe_text(candidate.get("account_label"))
        or _safe_text(candidate.get("source_account_label"))
    )
    if account_label is None:
        return RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_DSN_ENV
    return RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE_DSN_ENVS.get(
        account_label,
        RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_DSN_ENV,
    )


def _runtime_ledger_source_collection_import_candidate(
    candidate: Mapping[str, object],
) -> bool:
    if bool(candidate.get("source_collection_candidate")):
        return True
    if bool(candidate.get("source_collection_authorized")):
        return True
    if (
        _safe_text(candidate.get("source_kind"))
        == _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND
    ):
        return True
    identity = candidate.get("account_stage_runtime_identity")
    if isinstance(identity, Mapping):
        identity_mapping = cast(Mapping[str, object], identity)
        return (
            _safe_text(identity_mapping.get("source_kind"))
            == _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND
        )
    return False


def _bounded_source_collection_probe_window(
    candidate: Mapping[str, object],
) -> tuple[str | None, str | None, bool]:
    window_start = _safe_text(
        candidate.get("bucket_started_at")
        or candidate.get("window_start")
        or candidate.get("source_window_start")
        or candidate.get("paper_route_probe_window_start")
    )
    window_end = _safe_text(
        candidate.get("bucket_ended_at")
        or candidate.get("window_end")
        or candidate.get("source_window_end")
        or candidate.get("paper_route_probe_window_end")
    )
    if window_start is not None and window_end is not None:
        return window_start, window_end, False
    if not _runtime_ledger_source_collection_import_candidate(candidate):
        return window_start, window_end, False
    if not bool(candidate.get("source_collection_authorized")):
        return window_start, window_end, False

    now = datetime.now(timezone.utc)
    return (
        regular_session_open_utc_for(now).isoformat(),
        regular_session_close_utc_for(now).isoformat(),
        True,
    )


BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS = (
    _BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS
)
BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE = _BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE
BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND = _BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND
HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID = _HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID
HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID = _HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID
RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION = (
    _RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION
)
RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS = (
    _RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS
)
RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV = (
    _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV
)
RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND = _RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND
RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV = (
    _RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV
)
RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS = (
    _RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS
)
RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS = (
    _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS
)
RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON = (
    _RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON
)
RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS = (
    _RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS
)
RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH = (
    _RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH
)
RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND = (
    _RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND
)
RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV = (
    _RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV
)
bounded_source_collection_probe_window = _bounded_source_collection_probe_window
hypothesis_manifest_ref = _hypothesis_manifest_ref
runtime_ledger_paper_probation_blockers = _runtime_ledger_paper_probation_blockers
runtime_ledger_paper_probation_bucket_ref = _runtime_ledger_paper_probation_bucket_ref
runtime_ledger_paper_probation_payload = _runtime_ledger_paper_probation_payload
runtime_ledger_paper_probation_strategy_name = (
    _runtime_ledger_paper_probation_strategy_name
)
runtime_ledger_source_collection_import_candidate = (
    _runtime_ledger_source_collection_import_candidate
)
runtime_ledger_source_collection_source_dsn_env = (
    _runtime_ledger_source_collection_source_dsn_env
)
strategy_lookup_names = _strategy_lookup_names


__all__ = [
    "BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS",
    "BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE",
    "BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND",
    "HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID",
    "HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID",
    "RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION",
    "RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS",
    "RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV",
    "RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND",
    "RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV",
    "_BOUNDED_PAPER_ROUTE_COLLECTION_PROMOTION_BLOCKERS",
    "_BOUNDED_PAPER_ROUTE_COLLECTION_SCOPE",
    "_BOUNDED_PAPER_ROUTE_COLLECTION_SOURCE_KIND",
    "_HPAIRS_BOUNDED_COLLECTION_CANDIDATE_ID",
    "_HPAIRS_BOUNDED_COLLECTION_HYPOTHESIS_ID",
    "RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS",
    "_RUNTIME_LEDGER_PAPER_PROBATION_IMPORT_SCHEMA_VERSION",
    "RUNTIME_LEDGER_PAPER_PROBATION_MIN_CLOSED_ROUND_TRIPS",
    "_RUNTIME_LEDGER_PAPER_PROBATION_PROMOTION_BLOCKERS",
    "RUNTIME_LEDGER_PAPER_PROBATION_REASON",
    "_RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_DSN_ENV",
    "_RUNTIME_LEDGER_PAPER_PROBATION_SOURCE_KIND",
    "_RUNTIME_LEDGER_PAPER_PROBATION_TARGET_DSN_ENV",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_BUCKET_SOURCE_DSN_ENVS",
    "_RUNTIME_LEDGER_SOURCE_COLLECTION_LIVE_PAPER_EVIDENCE_REQUIREMENTS",
    "_RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_NET_PNL_AFTER_COSTS",
    "_RUNTIME_LEDGER_SOURCE_COLLECTION_PROFIT_TARGET_SELECTION_REASON",
    "_RUNTIME_LEDGER_SOURCE_COLLECTION_PROMOTION_BLOCKERS",
    "_RUNTIME_LEDGER_SOURCE_COLLECTION_SAFE_EVIDENCE_COLLECTION_PATH",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_DSN_ENV",
    "_RUNTIME_LEDGER_SOURCE_COLLECTION_SOURCE_KIND",
    "_RUNTIME_LEDGER_SOURCE_COLLECTION_TARGET_DSN_ENV",
    "RUNTIME_LEDGER_SOURCE_COLLECTION_TRIGGER_REASONS",
    "_bounded_source_collection_probe_window",
    "_hypothesis_manifest_ref",
    "runtime_ledger_paper_probation_activity_blockers",
    "_runtime_ledger_paper_probation_blockers",
    "_runtime_ledger_paper_probation_bucket_ref",
    "runtime_ledger_paper_probation_candidates",
    "runtime_ledger_paper_probation_eligible",
    "runtime_ledger_paper_probation_hash_blockers",
    "_runtime_ledger_paper_probation_payload",
    "runtime_ledger_paper_probation_profit_blockers",
    "_runtime_ledger_paper_probation_strategy_name",
    "_runtime_ledger_hash_count",
    "runtime_ledger_source_collection_candidate",
    "runtime_ledger_source_collection_candidates",
    "_runtime_ledger_source_collection_import_candidate",
    "runtime_ledger_source_collection_profit_target_candidate",
    "runtime_ledger_source_collection_profit_target_metadata",
    "_runtime_ledger_source_collection_source_dsn_env",
    "runtime_ledger_source_collection_target_progress_payload",
    "_strategy_lookup_names",
    "bounded_source_collection_probe_window",
    "hypothesis_manifest_ref",
    "runtime_ledger_paper_probation_blockers",
    "runtime_ledger_paper_probation_bucket_ref",
    "runtime_ledger_paper_probation_payload",
    "runtime_ledger_paper_probation_strategy_name",
    "runtime_ledger_source_collection_import_candidate",
    "runtime_ledger_source_collection_source_dsn_env",
    "strategy_lookup_names",
]
