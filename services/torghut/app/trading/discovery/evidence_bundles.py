"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Mapping, Sequence, cast


EVIDENCE_BUNDLE_SCHEMA_VERSION = "torghut.candidate-evidence-bundle.v1"
VALID_COST_CALIBRATION_STATUSES = frozenset({"calibrated", "provisional"})
MARKET_IMPACT_STRESS_COST_BPS = Decimal("1")
DELAY_ADJUSTED_DEPTH_STRESS_MS = Decimal("50")
DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS = Decimal("1")
REPLAY_ACTIVITY_SCORECARD_KEYS = (
    "decision_count",
    "trade_decision_count",
    "paper_decision_count",
    "runtime_decision_count",
    "orders_submitted_count",
    "submitted_order_count",
    "filled_count",
    "fill_count",
    "filled_order_count",
    "avg_filled_notional_per_day",
    "daily_filled_notional",
)


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _string(value: Any) -> str:
    return str(value or "").strip()


def _int(value: Any) -> int:
    try:
        return int(float(str(value or 0)))
    except (TypeError, ValueError):
        return 0


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value or "0"))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _decimal_mapping_total(mapping: Mapping[str, Any]) -> Decimal:
    total = Decimal("0")
    for value in mapping.values():
        total += _decimal(value)
    return total


def _sum_mapping_int_values(mapping: Mapping[str, Any], key: str) -> int:
    total = 0
    for payload in mapping.values():
        total += _int(_mapping(payload).get(key))
    return total


def _is_synthetic_dataset_snapshot(dataset_snapshot_id: str) -> bool:
    normalized = dataset_snapshot_id.strip().lower()
    return any(
        token in normalized
        for token in (
            "synthetic",
            "simulated",
            "pre-replay",
            "proposal-prior",
            "placeholder",
        )
    )


def _decomposition_symbol_contribution_shares(
    candidate: Mapping[str, Any],
) -> dict[str, str]:
    decomposition = _mapping(candidate.get("decomposition"))
    raw_symbols = _mapping(decomposition.get("symbols"))
    shares: dict[str, str] = {}
    for raw_symbol, raw_payload in raw_symbols.items():
        symbol = _string(raw_symbol).upper()
        payload = _mapping(raw_payload)
        share = _string(payload.get("positive_pnl_share"))
        if symbol and share:
            shares[symbol] = share
    return shares


def _decomposition_activity_counts(candidate: Mapping[str, Any]) -> dict[str, int]:
    decomposition = _mapping(candidate.get("decomposition"))
    families = _mapping(decomposition.get("families"))
    symbols = _mapping(decomposition.get("symbols"))
    decision_count = _sum_mapping_int_values(families, "evaluations")
    filled_count = max(
        _sum_mapping_int_values(families, "fills"),
        _sum_mapping_int_values(symbols, "filled_count"),
    )
    counts: dict[str, int] = {}
    if decision_count > 0:
        counts["decision_count"] = decision_count
    if filled_count > 0:
        counts["filled_count"] = filled_count
        counts["filled_order_count"] = filled_count
    return counts


def _enrich_scorecard_with_replay_stress_metrics(
    *,
    scorecard: Mapping[str, Any],
    full_window: Mapping[str, Any],
    result_path: str,
) -> dict[str, Any]:
    enriched = dict(scorecard)
    net_pnl_per_day = _decimal(
        enriched.get("net_pnl_per_day") or full_window.get("net_per_day")
    )
    avg_filled_notional_per_day = _decimal(
        enriched.get("avg_filled_notional_per_day")
        or full_window.get("avg_filled_notional_per_day")
    )
    daily_liquidity_notional = _mapping(full_window.get("daily_liquidity_notional"))
    if daily_liquidity_notional and "daily_liquidity_notional" not in enriched:
        enriched["daily_liquidity_notional"] = daily_liquidity_notional
    if (
        daily_liquidity_notional
        and "market_impact_liquidity_evidence_present" not in enriched
    ):
        enriched["market_impact_liquidity_evidence_present"] = True
    if daily_liquidity_notional and "market_impact_liquidity_day_count" not in enriched:
        enriched["market_impact_liquidity_day_count"] = len(daily_liquidity_notional)
    avg_liquidity_notional_per_day = _decimal(
        enriched.get("avg_liquidity_notional_per_day")
        or full_window.get("avg_liquidity_notional_per_day")
    )
    if (
        avg_liquidity_notional_per_day <= 0
        and daily_liquidity_notional
        and _decimal(
            enriched.get("trading_day_count") or full_window.get("trading_day_count")
        )
        > 0
    ):
        avg_liquidity_notional_per_day = _decimal_mapping_total(
            daily_liquidity_notional
        ) / _decimal(
            enriched.get("trading_day_count") or full_window.get("trading_day_count")
        )
    if (
        avg_liquidity_notional_per_day > 0
        and "avg_liquidity_notional_per_day" not in enriched
    ):
        enriched["avg_liquidity_notional_per_day"] = str(avg_liquidity_notional_per_day)

    market_impact_cost_per_day = (
        avg_filled_notional_per_day * MARKET_IMPACT_STRESS_COST_BPS / Decimal("10000")
    )
    market_impact_net_pnl_per_day = net_pnl_per_day - market_impact_cost_per_day
    if "market_impact_stress_model" not in enriched:
        enriched["market_impact_stress_model"] = "square_root"
    if "market_impact_stress_cost_bps" not in enriched:
        enriched["market_impact_stress_cost_bps"] = str(MARKET_IMPACT_STRESS_COST_BPS)
    if "market_impact_stress_net_pnl_per_day" not in enriched:
        enriched["market_impact_stress_net_pnl_per_day"] = str(
            market_impact_net_pnl_per_day
        )
    if "market_impact_stress_artifact_ref" not in enriched:
        enriched["market_impact_stress_artifact_ref"] = result_path
    if "market_impact_stress_passed" not in enriched:
        enriched["market_impact_stress_passed"] = (
            bool(enriched.get("market_impact_liquidity_evidence_present"))
            and avg_filled_notional_per_day > 0
            and market_impact_net_pnl_per_day > 0
        )

    delay_depth_fillable_notional_per_day = avg_filled_notional_per_day
    delay_depth_cost_per_day = (
        delay_depth_fillable_notional_per_day
        * DELAY_ADJUSTED_DEPTH_STRESS_COST_BPS
        / Decimal("10000")
    )
    delay_depth_net_pnl_per_day = net_pnl_per_day - delay_depth_cost_per_day
    if "delay_adjusted_depth_stress_model" not in enriched:
        enriched["delay_adjusted_depth_stress_model"] = "latency_depth_haircut"
    if "delay_adjusted_depth_stress_ms" not in enriched:
        enriched["delay_adjusted_depth_stress_ms"] = str(DELAY_ADJUSTED_DEPTH_STRESS_MS)
    if "delay_adjusted_depth_fillable_notional_per_day" not in enriched:
        enriched["delay_adjusted_depth_fillable_notional_per_day"] = str(
            delay_depth_fillable_notional_per_day
        )
    if "delay_adjusted_depth_stress_net_pnl_per_day" not in enriched:
        enriched["delay_adjusted_depth_stress_net_pnl_per_day"] = str(
            delay_depth_net_pnl_per_day
        )
    if "delay_adjusted_depth_stress_artifact_ref" not in enriched:
        enriched["delay_adjusted_depth_stress_artifact_ref"] = result_path
    if "delay_adjusted_depth_stress_passed" not in enriched:
        enriched["delay_adjusted_depth_stress_passed"] = (
            avg_liquidity_notional_per_day >= delay_depth_fillable_notional_per_day
            and delay_depth_fillable_notional_per_day > 0
            and delay_depth_net_pnl_per_day > 0
        )
    return enriched


@dataclass(frozen=True)
class CandidateEvidenceBundle:
    schema_version: Literal["torghut.candidate-evidence-bundle.v1"]
    evidence_bundle_id: str
    candidate_id: str
    candidate_spec_id: str
    dataset_snapshot_id: str
    feature_spec_hash: str
    code_commit: str
    replay_artifact_refs: tuple[str, ...]
    objective_scorecard: Mapping[str, Any]
    fold_metrics: tuple[Mapping[str, Any], ...]
    stress_metrics: tuple[Mapping[str, Any], ...]
    cost_calibration: Mapping[str, Any]
    null_comparator: Mapping[str, Any]
    promotion_readiness: Mapping[str, Any]

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "evidence_bundle_id": self.evidence_bundle_id,
            "candidate_id": self.candidate_id,
            "candidate_spec_id": self.candidate_spec_id,
            "dataset_snapshot_id": self.dataset_snapshot_id,
            "feature_spec_hash": self.feature_spec_hash,
            "code_commit": self.code_commit,
            "replay_artifact_refs": list(self.replay_artifact_refs),
            "objective_scorecard": dict(self.objective_scorecard),
            "fold_metrics": [dict(item) for item in self.fold_metrics],
            "stress_metrics": [dict(item) for item in self.stress_metrics],
            "cost_calibration": dict(self.cost_calibration),
            "null_comparator": dict(self.null_comparator),
            "promotion_readiness": dict(self.promotion_readiness),
        }


def evidence_bundle_id_for_payload(payload: Mapping[str, Any]) -> str:
    return f"ev-{_stable_hash(payload)[:24]}"


def evidence_bundle_from_frontier_candidate(
    *,
    candidate_spec_id: str,
    candidate: Mapping[str, Any],
    dataset_snapshot_id: str,
    result_path: str,
    code_commit: str = "unknown",
) -> CandidateEvidenceBundle:
    candidate_id = _string(candidate.get("candidate_id")) or candidate_spec_id
    scorecard = _mapping(candidate.get("objective_scorecard"))
    full_window = _mapping(candidate.get("full_window"))
    summary = _mapping(candidate.get("summary"))
    if not scorecard:
        scorecard = {
            "net_pnl_per_day": _string(full_window.get("net_per_day")),
            "active_day_ratio": _string(full_window.get("active_day_ratio")),
            "positive_day_ratio": _string(full_window.get("positive_day_ratio")),
            "best_day_share": _string(full_window.get("best_day_share")),
            "max_drawdown": _string(full_window.get("max_drawdown")),
        }
    for key in REPLAY_ACTIVITY_SCORECARD_KEYS:
        if key in scorecard:
            continue
        for source in (candidate, summary, full_window):
            if key in source:
                scorecard = {**scorecard, key: source[key]}
                break
    for key, value in _decomposition_activity_counts(candidate).items():
        if key not in scorecard:
            scorecard = {**scorecard, key: value}
    daily_net = _mapping(full_window.get("daily_net"))
    if daily_net and "daily_net" not in scorecard:
        scorecard = {**scorecard, "daily_net": daily_net}
    daily_filled_notional = _mapping(full_window.get("daily_filled_notional"))
    if daily_filled_notional and "daily_filled_notional" not in scorecard:
        scorecard = {**scorecard, "daily_filled_notional": daily_filled_notional}
    if "trading_day_count" in full_window and "trading_day_count" not in scorecard:
        scorecard = {**scorecard, "trading_day_count": full_window["trading_day_count"]}
    raw_candidate_hard_vetoes = candidate.get("hard_vetoes")
    if isinstance(raw_candidate_hard_vetoes, str):
        raw_hard_vetoes: Sequence[Any] = (raw_candidate_hard_vetoes,)
    else:
        raw_hard_vetoes = cast(Sequence[Any], raw_candidate_hard_vetoes or ())
    hard_vetoes = tuple(
        item for item in (_string(value) for value in raw_hard_vetoes) if item
    )
    if hard_vetoes and "hard_vetoes" not in scorecard:
        scorecard = {**scorecard, "hard_vetoes": list(hard_vetoes)}
    if "symbol_contribution_shares" not in scorecard and "symbol" not in scorecard:
        symbol_shares = _decomposition_symbol_contribution_shares(candidate)
        if symbol_shares:
            scorecard = {**scorecard, "symbol_contribution_shares": symbol_shares}
    for key in (
        "family_template_id",
        "runtime_family",
        "runtime_strategy_name",
        "execution_signature",
        "execution_profile_id",
        "execution_profile_index",
        "feedback_risk_profile_key",
        "feedback_shape_key",
        "universe_key",
        "signal_key",
    ):
        value = _string(candidate.get(key))
        if value and key not in scorecard:
            scorecard = {**scorecard, key: value}
    scorecard = _enrich_scorecard_with_replay_stress_metrics(
        scorecard=scorecard,
        full_window=full_window,
        result_path=result_path,
    )
    stress_metrics = tuple(
        cast(Sequence[Mapping[str, Any]], candidate.get("stress_metrics") or ())
    )
    if not stress_metrics:
        stress_metrics = (
            {
                "source": "frontier_replay",
                "stress_type": "market_impact",
                "model": scorecard.get("market_impact_stress_model"),
                "cost_bps": scorecard.get("market_impact_stress_cost_bps"),
                "net_pnl_per_day": scorecard.get(
                    "market_impact_stress_net_pnl_per_day"
                ),
                "passed": scorecard.get("market_impact_stress_passed"),
                "artifact_ref": scorecard.get("market_impact_stress_artifact_ref"),
            },
            {
                "source": "frontier_replay",
                "stress_type": "delay_adjusted_depth",
                "model": scorecard.get("delay_adjusted_depth_stress_model"),
                "stress_ms": scorecard.get("delay_adjusted_depth_stress_ms"),
                "fillable_notional_per_day": scorecard.get(
                    "delay_adjusted_depth_fillable_notional_per_day"
                ),
                "net_pnl_per_day": scorecard.get(
                    "delay_adjusted_depth_stress_net_pnl_per_day"
                ),
                "passed": scorecard.get("delay_adjusted_depth_stress_passed"),
                "artifact_ref": scorecard.get(
                    "delay_adjusted_depth_stress_artifact_ref"
                ),
            },
        )
    payload_seed = {
        "candidate_id": candidate_id,
        "candidate_spec_id": candidate_spec_id,
        "dataset_snapshot_id": dataset_snapshot_id,
        "objective_scorecard": scorecard,
    }
    promotion_readiness = _mapping(candidate.get("promotion_readiness")) or {
        "stage": "research_candidate",
        "status": "blocked_pending_runtime_parity",
        "promotable": False,
        "blockers": ["scheduler_v3_parity_missing", "shadow_validation_missing"],
    }
    return CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id=evidence_bundle_id_for_payload(payload_seed),
        candidate_id=candidate_id,
        candidate_spec_id=candidate_spec_id,
        dataset_snapshot_id=dataset_snapshot_id,
        feature_spec_hash=_stable_hash(
            {"candidate_spec_id": candidate_spec_id, "scorecard": scorecard}
        ),
        code_commit=code_commit,
        replay_artifact_refs=(result_path,),
        objective_scorecard=scorecard,
        fold_metrics=tuple(
            cast(Sequence[Mapping[str, Any]], candidate.get("fold_metrics") or ())
        ),
        stress_metrics=stress_metrics,
        cost_calibration=_mapping(candidate.get("cost_calibration"))
        or {"status": "provisional", "source": "frontier_replay"},
        null_comparator=_mapping(candidate.get("null_comparator"))
        or {
            "baseline_outperformed": bool(
                float(str(scorecard.get("net_pnl_per_day") or 0)) > 0
            )
        },
        promotion_readiness=promotion_readiness,
    )


def evidence_bundle_from_payload(payload: Mapping[str, Any]) -> CandidateEvidenceBundle:
    schema_version = _string(payload.get("schema_version"))
    if schema_version != EVIDENCE_BUNDLE_SCHEMA_VERSION:
        raise ValueError(f"evidence_bundle_schema_invalid:{schema_version}")
    return CandidateEvidenceBundle(
        schema_version=EVIDENCE_BUNDLE_SCHEMA_VERSION,
        evidence_bundle_id=_string(payload.get("evidence_bundle_id")),
        candidate_id=_string(payload.get("candidate_id")),
        candidate_spec_id=_string(payload.get("candidate_spec_id")),
        dataset_snapshot_id=_string(payload.get("dataset_snapshot_id")),
        feature_spec_hash=_string(payload.get("feature_spec_hash")),
        code_commit=_string(payload.get("code_commit")),
        replay_artifact_refs=tuple(
            str(item)
            for item in cast(Sequence[Any], payload.get("replay_artifact_refs") or [])
        ),
        objective_scorecard=_mapping(payload.get("objective_scorecard")),
        fold_metrics=tuple(
            cast(Mapping[str, Any], item)
            for item in cast(Sequence[Any], payload.get("fold_metrics") or [])
            if isinstance(item, Mapping)
        ),
        stress_metrics=tuple(
            cast(Mapping[str, Any], item)
            for item in cast(Sequence[Any], payload.get("stress_metrics") or [])
            if isinstance(item, Mapping)
        ),
        cost_calibration=_mapping(payload.get("cost_calibration")),
        null_comparator=_mapping(payload.get("null_comparator")),
        promotion_readiness=_mapping(payload.get("promotion_readiness")),
    )


def evidence_bundle_blockers(bundle: CandidateEvidenceBundle) -> tuple[str, ...]:
    blockers: list[str] = []
    if not _string(bundle.dataset_snapshot_id):
        blockers.append("dataset_snapshot_missing")
    if not bundle.replay_artifact_refs or not any(
        _string(item) for item in bundle.replay_artifact_refs
    ):
        blockers.append("replay_artifact_missing")

    cost_status = _string(bundle.cost_calibration.get("status")).lower()
    cost_source = _string(bundle.cost_calibration.get("source"))
    if not bundle.cost_calibration:
        blockers.append("cost_calibration_missing")
    elif cost_status not in VALID_COST_CALIBRATION_STATUSES:
        blockers.append("cost_calibration_status_invalid")
    elif not cost_source:
        blockers.append("cost_calibration_source_missing")

    scorecard = bundle.objective_scorecard
    if bool(scorecard.get("stale_tape")) or bool(scorecard.get("stale_override_used")):
        blockers.append("stale_tape")
    freshness = _string(
        scorecard.get("dataset_freshness_status")
        or scorecard.get("tape_freshness_status")
        or scorecard.get("freshness_status")
    ).lower()
    if freshness in {"stale", "expired", "not_fresh"}:
        blockers.append("stale_tape")
    validation_contract = _mapping(
        scorecard.get("validation_contract")
        or bundle.promotion_readiness.get("validation_contract")
    )
    if _string(
        validation_contract.get("synthetic_evidence_policy")
    ) == "validation_only_not_promotion_proof" and _is_synthetic_dataset_snapshot(
        bundle.dataset_snapshot_id
    ):
        blockers.append("synthetic_evidence_not_promotion_proof")
    return tuple(dict.fromkeys(blockers))


def evidence_bundle_is_valid(bundle: CandidateEvidenceBundle) -> bool:
    return not evidence_bundle_blockers(bundle)
