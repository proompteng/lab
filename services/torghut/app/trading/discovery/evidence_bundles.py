"""Canonical evidence bundles for autoresearch candidates."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Sequence, cast


EVIDENCE_BUNDLE_SCHEMA_VERSION = "torghut.candidate-evidence-bundle.v1"
VALID_COST_CALIBRATION_STATUSES = frozenset({"calibrated", "provisional"})


def _stable_hash(payload: Mapping[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _mapping(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    return {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}


def _string(value: Any) -> str:
    return str(value or "").strip()


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
    if not scorecard:
        scorecard = {
            "net_pnl_per_day": _string(full_window.get("net_per_day")),
            "active_day_ratio": _string(full_window.get("active_day_ratio")),
            "positive_day_ratio": _string(full_window.get("positive_day_ratio")),
            "best_day_share": _string(full_window.get("best_day_share")),
            "max_drawdown": _string(full_window.get("max_drawdown")),
        }
    daily_net = _mapping(full_window.get("daily_net"))
    if daily_net and "daily_net" not in scorecard:
        scorecard = {**scorecard, "daily_net": daily_net}
    daily_filled_notional = _mapping(full_window.get("daily_filled_notional"))
    if daily_filled_notional and "daily_filled_notional" not in scorecard:
        scorecard = {**scorecard, "daily_filled_notional": daily_filled_notional}
    if "trading_day_count" in full_window and "trading_day_count" not in scorecard:
        scorecard = {**scorecard, "trading_day_count": full_window["trading_day_count"]}
    for key in ("family_template_id", "runtime_family", "runtime_strategy_name"):
        value = _string(candidate.get(key))
        if value and key not in scorecard:
            scorecard = {**scorecard, key: value}
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
        stress_metrics=tuple(
            cast(Sequence[Mapping[str, Any]], candidate.get("stress_metrics") or ())
        ),
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
    return tuple(dict.fromkeys(blockers))


def evidence_bundle_is_valid(bundle: CandidateEvidenceBundle) -> bool:
    return not evidence_bundle_blockers(bundle)
