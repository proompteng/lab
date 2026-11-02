from __future__ import annotations

import json
from datetime import UTC, date, datetime
from typing import Any, Mapping, Sequence, cast

from app.trading.discovery.candidate_specs import CandidateSpec
from app.trading.discovery.evidence_bundles import CandidateEvidenceBundle
from app.trading.discovery.factor_acceptance import (
    build_factor_acceptance_artifact_from_scorecard,
)
from scripts.whitepaper_autoresearch_runner.candidate_board_fields import (
    _candidate_board_int_field,
)
from scripts.whitepaper_autoresearch_runner.common import (
    _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE,
    _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN,
    _CANDIDATE_BOARD_RUNTIME_SESSION_TZ,
    _boolish,
    _candidate_board_runtime_ledger_required_materialized_artifacts,
    _decimal,
    _mapping,
    _string,
    _string_list_from_value,
)


def _candidate_board_hypothesis_manifest_ref(hypothesis_id: str | None) -> str:
    normalized = _string(hypothesis_id).lower().replace("_", "-")
    if not normalized:
        return ""
    return f"config/trading/hypotheses/{normalized}.json"


def _candidate_board_runtime_window_bounds(
    scorecard: Mapping[str, Any],
) -> tuple[str, str]:
    for source in (
        scorecard,
        _mapping(scorecard.get("replay_window_spec")),
        _mapping(scorecard.get("candidate_evaluation_key_payload")).get(
            "replay_window_spec"
        ),
    ):
        mapping = _mapping(source)
        start = _string(
            mapping.get("runtime_window_start")
            or mapping.get("window_start")
            or mapping.get("full_window_start")
            or mapping.get("full_window_start_date")
        )
        end = _string(
            mapping.get("runtime_window_end")
            or mapping.get("window_end")
            or mapping.get("full_window_end")
            or mapping.get("full_window_end_date")
        )
        if start and end:
            return start, end

    replay_lineage = _mapping(scorecard.get("replay_lineage"))
    windows = _mapping(replay_lineage.get("windows"))
    for window_id in ("full_window", "holdout", "train"):
        window = _mapping(windows.get(window_id))
        start = _string(window.get("start_date") or window.get("window_start"))
        end = _string(window.get("end_date") or window.get("window_end"))
        if start and end:
            return start, end
    return "", ""


def _candidate_board_date_only(value: str) -> date | None:
    text = _string(value)
    if not text or "T" in text or " " in text:
        return None
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


def _candidate_board_regular_session_bound(value: str, *, end: bool) -> str:
    text = _string(value)
    trading_day = _candidate_board_date_only(text)
    if trading_day is None:
        return text
    session_time = (
        _CANDIDATE_BOARD_RUNTIME_SESSION_CLOSE
        if end
        else _CANDIDATE_BOARD_RUNTIME_SESSION_OPEN
    )
    return (
        datetime.combine(
            trading_day,
            session_time,
            tzinfo=_CANDIDATE_BOARD_RUNTIME_SESSION_TZ,
        )
        .astimezone(UTC)
        .isoformat()
    )


def _candidate_board_runtime_window_import_bounds(
    row: Mapping[str, Any],
) -> tuple[str, str]:
    window_start = _string(row.get("runtime_window_start") or row.get("window_start"))
    window_end = _string(row.get("runtime_window_end") or row.get("window_end"))
    if not window_start or not window_end:
        window_start, window_end = _candidate_board_runtime_window_bounds(row)
    return (
        _candidate_board_regular_session_bound(window_start, end=False),
        _candidate_board_regular_session_bound(window_end, end=True),
    )


def _candidate_board_exact_replay_ledger_refs(
    row: Mapping[str, Any],
) -> tuple[str, ...]:
    refs: list[str] = []
    for key in ("exact_replay_ledger_artifact_ref",):
        ref = _string(row.get(key))
        if ref:
            refs.append(ref)
    for key in ("exact_replay_ledger_artifact_refs",):
        raw_refs = row.get(key)
        if isinstance(raw_refs, str):
            ref = _string(raw_refs)
            if ref:
                refs.append(ref)
            continue
        for raw_ref in cast(Sequence[Any], raw_refs or ()):
            ref = _string(raw_ref)
            if ref:
                refs.append(ref)
    for raw_ref in cast(Sequence[Any], row.get("replay_artifact_refs") or ()):
        ref = _string(raw_ref)
        ref_lower = ref.lower()
        if ref and (
            "exact-replay-ledger" in ref_lower or "exact_replay_ledger" in ref_lower
        ):
            refs.append(ref)
    return tuple(dict.fromkeys(refs))


def _candidate_board_runtime_import_args(target: Mapping[str, Any]) -> list[str]:
    args = [
        "uv",
        "run",
        "--frozen",
        "python",
        "scripts/import_hypothesis_runtime_windows.py",
        "--run-id",
        _string(target.get("run_id")) or "candidate-board-runtime-window-import",
        "--candidate-id",
        _string(target.get("candidate_id")),
        "--hypothesis-id",
        _string(target.get("hypothesis_id")),
        "--observed-stage",
        _string(target.get("observed_stage")) or "paper",
        "--strategy-family",
        _string(target.get("strategy_family")),
        "--strategy-name",
        _string(target.get("strategy_name")),
        "--account-label",
        _string(target.get("account_label")),
        "--window-start",
        _string(target.get("window_start")),
        "--window-end",
        _string(target.get("window_end")),
        "--source-kind",
        _string(target.get("source_kind")),
        "--source-manifest-ref",
        _string(target.get("source_manifest_ref")),
        "--dataset-snapshot-ref",
        _string(target.get("dataset_snapshot_ref")),
    ]
    artifact_refs = (
        target.get("exact_replay_ledger_artifact_refs")
        or target.get("runtime_ledger_artifact_refs")
        or ()
    )
    for artifact_ref in cast(Sequence[Any], artifact_refs):
        ref = _string(artifact_ref)
        if ref:
            args.extend(["--artifact-ref", ref])
    target_metadata = _mapping(target.get("target_metadata"))
    if target_metadata:
        args.extend(
            [
                "--target-metadata-json",
                json.dumps(
                    target_metadata,
                    sort_keys=True,
                    separators=(",", ":"),
                    default=str,
                ),
            ]
        )
    args.append("--json")
    return args


def _candidate_board_runtime_window_import_plan(
    *,
    rows: Sequence[Mapping[str, Any]],
    paper_probation_candidate: Mapping[str, Any] | None,
    paper_probation_candidates: Sequence[Mapping[str, Any]] = (),
    promotion_subject: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    source_rows: list[Mapping[str, Any]] = []
    if paper_probation_candidate is not None:
        source_rows.append(paper_probation_candidate)
    source_rows.extend(paper_probation_candidates)

    if promotion_subject is not None and _boolish(promotion_subject.get("target_met")):
        portfolio_spec_ids = {
            _string(candidate_spec_id)
            for candidate_spec_id in cast(
                Sequence[Any],
                promotion_subject.get("sleeve_candidate_spec_ids") or (),
            )
            if _string(candidate_spec_id)
        }
        for row in rows:
            if _string(row.get("candidate_spec_id")) in portfolio_spec_ids:
                source_rows.append(row)

    targets: list[dict[str, Any]] = []
    blockers: list[dict[str, Any]] = []
    seen_keys: set[tuple[str, str, str]] = set()
    for row in source_rows:
        candidate_id = _string(row.get("candidate_id"))
        hypothesis_id = _string(row.get("hypothesis_id"))
        strategy_family = _string(row.get("runtime_family"))
        strategy_name = _string(row.get("runtime_strategy_name"))
        candidate_spec_id = _string(row.get("candidate_spec_id"))
        exact_replay_ledger_artifact_refs = _candidate_board_exact_replay_ledger_refs(
            row
        )
        exact_replay_ledger_artifact_ref = _string(
            row.get("exact_replay_ledger_artifact_ref")
        )
        if not exact_replay_ledger_artifact_ref:
            exact_replay_ledger_artifact_ref = next(
                (
                    ref
                    for ref in exact_replay_ledger_artifact_refs
                    if "exact" in ref.lower()
                ),
                "",
            )
        window_start, window_end = _candidate_board_runtime_window_import_bounds(row)
        account_label = _string(row.get("account_label"))
        if not account_label and exact_replay_ledger_artifact_refs:
            account_label = "TORGHUT_REPLAY"
        missing_fields = [
            field
            for field, value in (
                ("candidate_id", candidate_id),
                ("hypothesis_id", hypothesis_id),
                ("runtime_family", strategy_family),
                ("runtime_strategy_name", strategy_name),
                ("window_start", window_start),
                ("window_end", window_end),
                ("account_label", account_label),
            )
            if not value
        ]
        if missing_fields:
            blockers.append(
                {
                    "blocker": "runtime_window_import_target_incomplete",
                    "candidate_spec_id": candidate_spec_id,
                    "candidate_id": candidate_id,
                    "missing_fields": missing_fields,
                }
            )
            continue
        dedupe_key = (hypothesis_id, candidate_id, strategy_name)
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)
        runtime_ledger_lineage_handoff = _mapping(
            row.get("runtime_ledger_lineage_materialization_handoff")
        )
        runtime_ledger_required_materialized_artifacts = (
            _candidate_board_runtime_ledger_required_materialized_artifacts(
                runtime_ledger_lineage_handoff
            )
        )
        target = {
            "run_id": _string(row.get("epoch_id"))
            or "candidate-board-runtime-window-import",
            "candidate_spec_id": candidate_spec_id,
            "candidate_id": candidate_id,
            "hypothesis_id": hypothesis_id,
            "observed_stage": "paper",
            "strategy_family": strategy_family,
            "strategy_name": strategy_name,
            "account_label": account_label,
            "window_start": window_start,
            "window_end": window_end,
            "source_kind": "simulation_exact_replay_runtime_ledger"
            if exact_replay_ledger_artifact_refs
            else "paper_runtime_observed",
            "source_manifest_ref": _candidate_board_hypothesis_manifest_ref(
                hypothesis_id
            ),
            "dataset_snapshot_ref": _string(row.get("dataset_snapshot_id")),
            "artifact_refs": [
                _string(ref)
                for ref in cast(Sequence[Any], row.get("replay_artifact_refs") or ())
                if _string(ref)
            ],
            "exact_replay_ledger_artifact_refs": list(
                exact_replay_ledger_artifact_refs
            ),
            "exact_replay_ledger_artifact_ref": exact_replay_ledger_artifact_ref,
            "exact_replay_ledger_artifact_row_count": int(
                _decimal(row.get("exact_replay_ledger_artifact_row_count"))
            ),
            "exact_replay_ledger_artifact_fill_count": int(
                _decimal(row.get("exact_replay_ledger_artifact_fill_count"))
            ),
            "candidate_blockers": [
                _string(blocker)
                for blocker in cast(Sequence[Any], row.get("blockers") or ())
                if _string(blocker)
            ],
            "handoff": "runtime_window_import_only",
            "promotion_gate": "existing_runtime_governance_fail_closed",
        }
        if runtime_ledger_lineage_handoff:
            target["runtime_ledger_lineage_materialization_handoff"] = dict(
                runtime_ledger_lineage_handoff
            )
            target["runtime_ledger_required_materialized_artifacts"] = (
                runtime_ledger_required_materialized_artifacts
            )
            materialization_status = _string(
                row.get("runtime_ledger_materialization_status")
                or runtime_ledger_lineage_handoff.get("materialization_status")
                or runtime_ledger_lineage_handoff.get("status")
            )
            if materialization_status:
                target["runtime_ledger_materialization_status"] = materialization_status
            if _boolish(
                row.get("zero_authoritative_daily_pnl_until_materialized")
                or runtime_ledger_lineage_handoff.get(
                    "zero_authoritative_daily_pnl_until_materialized"
                )
            ):
                target["zero_authoritative_daily_pnl_until_materialized"] = True
        if bool(row.get("paper_probation_authorized")):
            target.update(
                {
                    "candidate_selection": _string(row.get("candidate_selection")),
                    "paper_probation_authorized": True,
                    "paper_probation_authorization_scope": _string(
                        row.get("paper_probation_authorization_scope")
                    ),
                    "evidence_collection_stage": _string(
                        row.get("evidence_collection_stage")
                    ),
                    "probation_allowed": bool(row.get("probation_allowed")),
                    "probation_reason": _string(row.get("probation_reason")),
                    "selection_reason": _string(row.get("selection_reason")),
                    "selected_by": _string(row.get("selected_by")),
                    "probation_lower_bound_net_pnl_per_day": _string(
                        row.get("probation_lower_bound_net_pnl_per_day")
                    ),
                    "probation_target_shortfall": _string(
                        row.get("probation_target_shortfall")
                    ),
                    "probation_target_progress_ratio": _string(
                        row.get("probation_target_progress_ratio")
                    ),
                    "required_notional_repair_scale_to_target": _string(
                        row.get("required_notional_repair_scale_to_target")
                    ),
                    "required_notional_repair_scale_authority": _string(
                        row.get("required_notional_repair_scale_authority")
                    ),
                    "live_paper_evidence_requirements": _string_list_from_value(
                        row.get("live_paper_evidence_requirements")
                    ),
                    "safe_evidence_collection_path": _string_list_from_value(
                        row.get("safe_evidence_collection_path")
                    ),
                    "live_capital_authorized": False,
                    "final_promotion_requires_live_paper_runtime_proof": _boolish(
                        row.get("final_promotion_requires_live_paper_runtime_proof")
                    ),
                    "promotion_allowed": False,
                    "final_promotion_authorized": False,
                    "final_promotion_allowed": False,
                    "final_promotion_blockers": [
                        _string(blocker)
                        for blocker in cast(
                            Sequence[Any], row.get("final_promotion_blockers") or ()
                        )
                        if _string(blocker)
                    ],
                }
            )
        paper_required_evidence_tokens = _string_list_from_value(
            row.get("paper_required_evidence_tokens")
        )
        paper_mechanism_overlay_ids = _string_list_from_value(
            row.get("paper_mechanism_overlay_ids")
        )
        paper_contract_prior_score = _string(row.get("paper_contract_prior_score"))
        if (
            _boolish(row.get("paper_contract_candidate"))
            or paper_contract_prior_score
            or paper_required_evidence_tokens
            or paper_mechanism_overlay_ids
        ):
            target.update(
                {
                    "replay_selection_reason": _string(
                        row.get("replay_selection_reason")
                    ),
                    "paper_contract_candidate": bool(
                        row.get("paper_contract_candidate")
                    ),
                    "paper_contract_selected_for_replay": bool(
                        row.get("paper_contract_selected_for_replay")
                    ),
                    "paper_contract_prior_score": paper_contract_prior_score,
                    "paper_mechanism_overlay_ids": paper_mechanism_overlay_ids,
                    "paper_required_evidence_tokens": paper_required_evidence_tokens,
                    "paper_required_evidence_count": _candidate_board_int_field(
                        row, "paper_required_evidence_count"
                    ),
                }
            )
        target["target_metadata"] = {
            key: value
            for key, value in target.items()
            if key
            not in {
                "import_command_args",
                "target_metadata",
            }
        }
        target["import_command_args"] = _candidate_board_runtime_import_args(target)
        targets.append(target)

    return {
        "schema_version": "torghut.runtime-window-import-plan.v1",
        "status": "ready" if targets else "blocked",
        "observed_stage": "paper",
        "target_count": len(targets),
        "targets": targets,
        "blockers": blockers,
    }


def _candidate_factor_acceptance_replay_metadata(
    *,
    spec: CandidateSpec,
    evidence: CandidateEvidenceBundle | None,
    candidate_count: int,
) -> dict[str, Any]:
    static_artifact = _mapping(spec.feature_contract.get("factor_acceptance_artifact"))
    if not static_artifact:
        return {}

    if evidence is None:
        artifact = {
            **static_artifact,
            "status": "rejected",
            "rejection_reasons": list(
                dict.fromkeys(
                    [
                        *_string_list_from_value(
                            static_artifact.get("rejection_reasons")
                        ),
                        "replay_evidence_missing",
                    ]
                )
            ),
            "promotion_scope": "research_paper_probation_only",
            "does_not_authorize_live_promotion": True,
        }
        evidence_status = "missing"
        candidate_id = ""
        evidence_bundle_id = ""
    else:
        artifact = build_factor_acceptance_artifact_from_scorecard(
            factor_expression=_string(static_artifact.get("factor_expression"))
            or "candidate_family_score",
            source_idea=_string(static_artifact.get("source_idea"))
            or "2025_2026_signal_discovery_rankic_acceptance_harness",
            allowed_feature_dependencies=_string_list_from_value(
                static_artifact.get("allowed_feature_dependencies")
            )
            or _string_list_from_value(spec.feature_contract.get("required_features")),
            scorecard=evidence.objective_scorecard,
            fold_metrics=evidence.fold_metrics,
            candidate_count=max(1, candidate_count),
            candidate_spec_id=spec.candidate_spec_id,
            candidate_id=evidence.candidate_id,
            evidence_bundle_id=evidence.evidence_bundle_id,
        )
        evidence_status = "replayed"
        candidate_id = evidence.candidate_id
        evidence_bundle_id = evidence.evidence_bundle_id

    return {
        "schema_version": "torghut.factor-acceptance-replay-metadata.v1",
        "candidate_spec_id": spec.candidate_spec_id,
        "candidate_id": candidate_id,
        "evidence_bundle_id": evidence_bundle_id,
        "evidence_status": evidence_status,
        "status": _string(artifact.get("status")) or "rejected",
        "rejection_reasons": _string_list_from_value(artifact.get("rejection_reasons")),
        "lineage_hash": _string(artifact.get("lineage_hash")),
        "replay_artifact": artifact,
        "static_compile_artifact_lineage_hash": _string(
            static_artifact.get("lineage_hash")
        ),
        "promotion_scope": "research_paper_probation_only",
        "promotion_allowed": False,
        "final_promotion_authorized": False,
        "does_not_authorize_live_promotion": True,
    }


__all__ = [
    "_candidate_board_hypothesis_manifest_ref",
    "_candidate_board_runtime_window_bounds",
    "_candidate_board_date_only",
    "_candidate_board_regular_session_bound",
    "_candidate_board_runtime_window_import_bounds",
    "_candidate_board_exact_replay_ledger_refs",
    "_candidate_board_runtime_import_args",
    "_candidate_board_runtime_window_import_plan",
    "_candidate_factor_acceptance_replay_metadata",
]
