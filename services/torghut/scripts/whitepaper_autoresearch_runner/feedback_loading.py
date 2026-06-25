#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


from app.models import (
    AutoresearchEpoch,
)
from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.candidate_specs import candidate_spec_from_payload
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
    evidence_bundle_from_frontier_candidate,
    evidence_bundle_from_payload,
)


from scripts.whitepaper_autoresearch_runner.common import (
    _resolve_existing_path,
    _stable_hash,
    _mapping,
    _string,
    _list_of_mappings,
)

from scripts.whitepaper_autoresearch_runner.candidate_identity import (
    _candidate_spec_execution_signature,
)

_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES = 512

_REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS = (
    "counterfactual_return",
    "route_tca",
    "post_cost_net_pnl",
    "executable_quote",
)


def _load_feedback_evidence_bundles(
    paths: Sequence[Path],
) -> tuple[CandidateEvidenceBundle, ...]:
    bundles: list[CandidateEvidenceBundle] = []
    for raw_path in paths:
        path = _resolve_existing_path(raw_path)
        if not path.exists():
            raise ValueError(f"feedback_evidence_jsonl_missing:{raw_path}")
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            text = line.strip()
            if not text:
                continue
            try:
                payload = json.loads(text)
                if not isinstance(payload, Mapping):
                    raise ValueError("payload_not_object")
                bundles.append(evidence_bundle_from_payload(payload))
            except Exception as exc:
                raise ValueError(
                    f"feedback_evidence_jsonl_invalid:{raw_path}:{line_number}:{exc}"
                ) from exc
    return tuple(bundles)


def _dedupe_feedback_evidence_bundles(
    bundles: Sequence[CandidateEvidenceBundle],
) -> tuple[CandidateEvidenceBundle, ...]:
    seen: set[str] = set()
    deduped: list[CandidateEvidenceBundle] = []
    for bundle in bundles:
        key = bundle.evidence_bundle_id or _stable_hash(bundle.to_payload())
        if key in seen:
            continue
        seen.add(key)
        deduped.append(bundle)
    return tuple(deduped)


def _evidence_bundle_payloads_for_epoch_summary(
    evidence_bundles: Sequence[CandidateEvidenceBundle],
) -> list[dict[str, Any]]:
    return [
        bundle.to_payload()
        for bundle in evidence_bundles[:_MAX_PERSISTED_FEEDBACK_EVIDENCE_BUNDLES]
    ]


def _candidate_spec_from_payload(payload: Mapping[str, Any]) -> CandidateSpec:
    return candidate_spec_from_payload(payload)


def _load_candidate_specs_jsonl(paths: Sequence[Path]) -> tuple[CandidateSpec, ...]:
    specs: list[CandidateSpec] = []
    seen: set[str] = set()
    for path in paths:
        if not path.exists():
            raise ValueError(f"candidate_specs_jsonl_missing:{path}")
        for line_number, line in enumerate(
            path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
                spec = _candidate_spec_from_payload(_mapping(payload))
            except Exception as exc:
                raise ValueError(
                    f"candidate_specs_jsonl_invalid:{path}:{line_number}:{exc}"
                ) from exc
            if spec.candidate_spec_id in seen:
                raise ValueError(
                    f"candidate_specs_jsonl_duplicate_candidate_spec_id:{path}:{line_number}:{spec.candidate_spec_id}"
                )
            seen.add(spec.candidate_spec_id)
            specs.append(spec)
    if not specs:
        raise ValueError("candidate_specs_jsonl_empty")
    return tuple(specs)


def _summary_scorecard_feedback_bundles_for_epoch(
    epoch: AutoresearchEpoch,
    candidate_specs: Sequence[CandidateSpec],
) -> tuple[tuple[CandidateEvidenceBundle, ...], dict[str, int]]:
    stats = {
        "scorecard_count": 0,
        "matched_scorecard_count": 0,
        "unmatched_scorecard_count": 0,
        "bundle_count": 0,
    }
    summary = _mapping(epoch.summary_json)
    remediation = _mapping(summary.get("candidate_search_remediation"))
    scorecards = _list_of_mappings(remediation.get("partial_scorecards"))
    stats["scorecard_count"] = len(scorecards)
    if not scorecards or not candidate_specs:
        return (), stats

    spec_by_id = {spec.candidate_spec_id: spec for spec in candidate_specs}
    spec_by_signature = {
        _candidate_spec_execution_signature(spec): spec for spec in candidate_specs
    }
    build = _mapping(summary.get("build"))
    code_commit = _string(build.get("commit")) or "unknown"
    bundles: list[CandidateEvidenceBundle] = []
    for index, scorecard in enumerate(scorecards, start=1):
        candidate_spec_id = _string(scorecard.get("candidate_spec_id"))
        execution_signature = _string(scorecard.get("execution_signature"))
        spec = spec_by_id.get(candidate_spec_id) or spec_by_signature.get(
            execution_signature
        )
        if spec is None:
            stats["unmatched_scorecard_count"] += 1
            continue
        stats["matched_scorecard_count"] += 1
        candidate_id = _string(scorecard.get("candidate_id")) or spec.candidate_spec_id
        candidate = {
            "candidate_id": candidate_id,
            "family_template_id": _string(scorecard.get("family_template_id"))
            or spec.family_template_id,
            "runtime_family": _string(scorecard.get("runtime_family"))
            or spec.runtime_family,
            "runtime_strategy_name": _string(scorecard.get("runtime_strategy_name"))
            or spec.runtime_strategy_name,
            "execution_signature": execution_signature
            or _candidate_spec_execution_signature(spec),
            "objective_scorecard": scorecard,
            "hard_vetoes": scorecard.get("hard_vetoes")
            or scorecard.get("veto_reasons")
            or (),
            "promotion_readiness": {
                "stage": "research_candidate",
                "status": "blocked_by_prior_replay_scorecard",
                "promotable": False,
                "blockers": list(
                    str(item)
                    for item in cast(
                        Sequence[Any],
                        scorecard.get("hard_vetoes")
                        or scorecard.get("veto_reasons")
                        or (),
                    )
                    if str(item).strip()
                ),
            },
        }
        bundles.append(
            evidence_bundle_from_frontier_candidate(
                candidate_spec_id=spec.candidate_spec_id,
                candidate=candidate,
                dataset_snapshot_id=f"autoresearch-epoch:{epoch.epoch_id}:summary-scorecards",
                result_path=(
                    f"db://autoresearch_epochs/{epoch.epoch_id}/"
                    f"candidate_search_remediation/partial_scorecards/{index}"
                ),
                code_commit=code_commit,
            )
        )
    stats["bundle_count"] = len(bundles)
    return tuple(bundles), stats


def _outcome_payload_has_complete_rejected_signal_fields(
    payload: Mapping[str, Any],
    required_fields: Sequence[Any],
) -> bool:
    required = tuple(_string(field) for field in required_fields if _string(field))
    if not required:
        required = _REJECTED_SIGNAL_OUTCOME_REQUIRED_FIELDS
    for field in required:
        if field not in payload:
            return False
        value = payload.get(field)
        if value is None:
            return False
        if isinstance(value, str) and not value.strip():
            return False
        if isinstance(value, Mapping) and not value:
            return False
    return True


__all__ = [
    "_load_feedback_evidence_bundles",
    "_dedupe_feedback_evidence_bundles",
    "_evidence_bundle_payloads_for_epoch_summary",
    "_candidate_spec_from_payload",
    "_load_candidate_specs_jsonl",
    "_summary_scorecard_feedback_bundles_for_epoch",
    "_outcome_payload_has_complete_rejected_signal_fields",
]
