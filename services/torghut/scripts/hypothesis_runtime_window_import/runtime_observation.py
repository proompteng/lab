from __future__ import annotations

from datetime import datetime
from typing import Any, Mapping, Sequence

from scripts.hypothesis_runtime_window_import.common import (
    _as_mapping,
    _as_sequence,
    _metadata_nonnegative_int_or_none,
    _metadata_text_list,
    _nonnegative_int,
    _parse_dt_or_none,
    _runtime_ledger_target_metadata_artifact_refs,
    _runtime_window_source_kind_is_informational,
    _source_collection_target_authorization_blockers,
    _text_or_none,
)
from scripts.hypothesis_runtime_window_import.constants import (
    EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS,
    EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS,
    POST_COST_BASIS_RUNTIME_LEDGER,
)
from scripts.hypothesis_runtime_window_import.runtime_ledger_authority import (
    _runtime_ledger_bucket_profit_proof_blockers,
    _runtime_ledger_bucket_profit_proof_present,
    runtime_ledger_promotion_source_authority_present,
)


def _mark_runtime_ledger_tca_rows_as_exact_replay_artifacts(
    tca_rows: list[dict[str, object]],
) -> None:
    for row in tca_rows:
        row["authoritative"] = False
        row["authority_reason"] = "exact_replay_artifact_not_runtime_proof"
        row["promotion_blocker"] = "exact_replay_artifact_not_runtime_proof"
        row["pnl_derivation"] = EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS
        row["post_cost_promotion_eligible"] = False
        blockers = _metadata_text_list(row.get("runtime_ledger_blockers"))
        for blocker in EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS:
            if blocker not in blockers:
                blockers.append(blocker)
        row["runtime_ledger_blockers"] = blockers
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, Mapping):
            continue
        bucket_payload = {str(key): item for key, item in bucket.items()}
        bucket_blockers = _metadata_text_list(bucket_payload.get("blockers"))
        for blocker in EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS:
            if blocker not in bucket_blockers:
                bucket_blockers.append(blocker)
        bucket_payload["blockers"] = bucket_blockers
        bucket_payload["authoritative"] = False
        bucket_payload["authority_reason"] = "exact_replay_artifact_not_runtime_proof"
        bucket_payload["pnl_derivation"] = EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS
        bucket_payload["source_materialization"] = "exact_replay_artifact"
        row["runtime_ledger_bucket"] = bucket_payload


def _runtime_ledger_target_metadata_blockers(
    *,
    target_metadata: Mapping[str, Any],
    runtime_ledger_artifact_metadata: Mapping[str, Any],
    window_start: datetime,
    window_end: datetime,
) -> list[str]:
    metadata = _as_mapping(target_metadata)
    if not metadata:
        return []

    blockers: list[str] = []
    planned_refs = _runtime_ledger_target_metadata_artifact_refs(metadata)
    loaded_refs = _metadata_text_list(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_refs")
    )
    if loaded_refs and not _text_or_none(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_authority_class")
    ):
        blockers.append("runtime_ledger_artifact_authority_class_missing")
    if planned_refs:
        if set(planned_refs) != set(loaded_refs):
            blockers.append("runtime_ledger_artifact_refs_mismatch")

    for keys, blocker in (
        (
            (
                "runtime_ledger_artifact_row_count",
                "exact_replay_ledger_artifact_row_count",
            ),
            "runtime_ledger_artifact_row_count_mismatch",
        ),
        (
            (
                "runtime_ledger_artifact_fill_count",
                "exact_replay_ledger_artifact_fill_count",
            ),
            "runtime_ledger_artifact_fill_count_mismatch",
        ),
    ):
        planned_count: int | None = None
        for key in keys:
            count = _metadata_nonnegative_int_or_none(metadata.get(key))
            if count is not None:
                planned_count = count
                break
        if planned_count is None:
            continue
        loaded_count = _nonnegative_int(runtime_ledger_artifact_metadata.get(keys[0]))
        if planned_count != loaded_count:
            blockers.append(blocker)

    for key, actual_bound in (
        ("window_start", window_start),
        ("window_end", window_end),
    ):
        expected_bound = _parse_dt_or_none(metadata.get(key))
        if metadata.get(key) is not None and expected_bound != actual_bound:
            blockers.append("runtime_ledger_window_bounds_mismatch")
            break

    expected_candidate_id = _text_or_none(metadata.get("candidate_id"))
    artifact_metadata_expected = bool(
        planned_refs
        or loaded_refs
        or any(
            metadata.get(key) is not None
            for key in (
                "runtime_ledger_artifact_row_count",
                "exact_replay_ledger_artifact_row_count",
                "runtime_ledger_artifact_fill_count",
                "exact_replay_ledger_artifact_fill_count",
                "replay_window_weekday_count",
                "replay_min_window_weekday_count",
            )
        )
    )
    loaded_candidate_ids = _metadata_text_list(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_candidate_ids")
    )
    loaded_candidate_id = _text_or_none(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_candidate_id")
    )
    if expected_candidate_id is not None and artifact_metadata_expected:
        if loaded_candidate_ids:
            if expected_candidate_id not in loaded_candidate_ids:
                blockers.append("runtime_ledger_artifact_candidate_id_mismatch")
            elif len(loaded_candidate_ids) > 1:
                blockers.append("runtime_ledger_artifact_candidate_id_ambiguous")
        elif loaded_candidate_id is None:
            blockers.append("runtime_ledger_artifact_candidate_id_missing")
        elif expected_candidate_id != loaded_candidate_id:
            blockers.append("runtime_ledger_artifact_candidate_id_mismatch")

    planned_window_weekdays = _metadata_nonnegative_int_or_none(
        metadata.get("replay_window_weekday_count")
    )
    loaded_window_weekdays = _metadata_nonnegative_int_or_none(
        runtime_ledger_artifact_metadata.get(
            "runtime_ledger_artifact_window_weekday_count"
        )
    )
    if planned_window_weekdays is not None:
        if loaded_window_weekdays is None:
            blockers.append("runtime_ledger_artifact_window_weekday_count_missing")
        elif planned_window_weekdays != loaded_window_weekdays:
            blockers.append("runtime_ledger_artifact_window_weekday_count_mismatch")

    min_window_weekdays = _metadata_nonnegative_int_or_none(
        metadata.get("replay_min_window_weekday_count")
    )
    if min_window_weekdays is not None:
        if loaded_window_weekdays is None:
            blockers.append("runtime_ledger_artifact_window_weekday_count_missing")
        elif loaded_window_weekdays < min_window_weekdays:
            blockers.append("runtime_ledger_artifact_window_weekday_count_below_min")

    return list(dict.fromkeys(blockers))


def _runtime_window_import_proof_hygiene_blockers(
    *,
    source_kind: str,
    target_metadata: Mapping[str, Any],
    dependency_quorum_decision: str,
    continuity_ok: str,
    drift_ok: str,
) -> list[str]:
    blockers: list[str] = []
    normalized_source_kind = source_kind.strip().lower().replace("-", "_")
    if not target_metadata and not _runtime_window_source_kind_is_informational(
        source_kind=source_kind,
        target_metadata=target_metadata,
    ):
        blockers.append("runtime_window_target_metadata_missing")
    source_collection_candidate = (
        normalized_source_kind == "runtime_ledger_source_collection_candidate"
    )
    if source_collection_candidate:
        blockers.extend(
            _source_collection_target_authorization_blockers(target_metadata)
        )
    if not source_collection_candidate and not dependency_quorum_decision.strip():
        blockers.append("dependency_quorum_decision_missing")
    if not source_collection_candidate and not continuity_ok.strip():
        blockers.append("continuity_gate_missing")
    if not source_collection_candidate and not drift_ok.strip():
        blockers.append("drift_gate_missing")
    for key in (
        "runtime_ledger_target_metadata_blockers",
        "runtime_window_import_health_gate_blockers",
        "runtime_window_import_promotion_blockers",
        "paper_route_session_import_blockers",
        "candidate_blockers",
        "runtime_window_import_audit_blockers",
        "runtime_window_import_audit_target_blockers",
    ):
        blockers.extend(_metadata_text_list(target_metadata.get(key)))
    return blockers


def _runtime_ledger_profit_proof_present(
    tca_rows: list[dict[str, object]],
) -> bool:
    for row in tca_rows:
        if row.get("post_cost_expectancy_basis") != POST_COST_BASIS_RUNTIME_LEDGER:
            continue
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, Mapping):
            continue
        if _runtime_ledger_bucket_profit_proof_present(bucket):
            return True
    return False


def _runtime_observation_authority_payload(
    *,
    source_kind: str,
    tca_rows: list[dict[str, object]],
) -> dict[str, object]:
    has_runtime_ledger_profit_proof = _runtime_ledger_profit_proof_present(tca_rows)
    exact_replay_artifact_only = any(
        "exact_replay_artifact_not_runtime_proof"
        in _metadata_text_list(row.get("runtime_ledger_blockers"))
        or row.get("authority_reason") == "exact_replay_artifact_not_runtime_proof"
        for row in tca_rows
    )
    if has_runtime_ledger_profit_proof:
        return {
            "authoritative": True,
            "authority_reason": "runtime_ledger_profit_proof",
            "promotion_authority": "runtime_ledger",
            "runtime_ledger_profit_proof_present": True,
        }
    if source_kind.startswith("simulation_"):
        return {
            "authoritative": False,
            "authority_reason": "simulation_source_replay_only",
            "promotion_authority": "blocked",
            "runtime_ledger_profit_proof_present": has_runtime_ledger_profit_proof,
        }
    if exact_replay_artifact_only:
        return {
            "authoritative": False,
            "authority_reason": "exact_replay_artifact_not_runtime_proof",
            "promotion_authority": "blocked",
            "runtime_ledger_profit_proof_present": False,
        }
    return {
        "authoritative": False,
        "authority_reason": "runtime_without_runtime_ledger_profit_proof",
        "promotion_authority": "blocked",
        "runtime_ledger_profit_proof_present": False,
    }


def _runtime_ledger_tca_materialization_metadata(
    tca_rows: Sequence[Mapping[str, object]],
) -> dict[str, object]:
    bucket_row_count = 0
    profit_proof_count = 0
    authoritative_bucket_count = 0
    source_execution_materialized_count = 0
    execution_reconstruction_count = 0
    target_notional_sizing_required_count = 0
    target_notional_sizing_authoritative_count = 0
    target_notional_sizing_missing_count = 0
    target_notional_sizing_non_authoritative_count = 0
    authority_reasons: list[str] = []
    pnl_derivations: list[str] = []
    source_materializations: list[str] = []
    blockers: list[str] = []
    profit_proof_blockers: list[str] = []
    for row in tca_rows:
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, Mapping):
            continue
        bucket_payload = {str(key): value for key, value in bucket.items()}
        bucket_row_count += 1
        if _runtime_ledger_bucket_profit_proof_present(bucket_payload):
            profit_proof_count += 1
        else:
            profit_proof_blockers.extend(
                _runtime_ledger_bucket_profit_proof_blockers(bucket_payload)
            )
        if bool(row.get("authoritative")) or bool(bucket_payload.get("authoritative")):
            authoritative_bucket_count += 1
        authority_reason = _text_or_none(
            row.get("authority_reason") or bucket_payload.get("authority_reason")
        )
        if authority_reason is not None:
            authority_reasons.append(authority_reason)
        pnl_derivation = _text_or_none(
            row.get("pnl_derivation") or bucket_payload.get("pnl_derivation")
        )
        if pnl_derivation is not None:
            pnl_derivations.append(pnl_derivation)
        source_materialization = _text_or_none(
            bucket_payload.get("source_materialization")
        )
        if source_materialization is not None:
            source_materializations.append(source_materialization)
        target_notional_sizing = _as_mapping(
            row.get("paper_route_target_notional_sizing")
            or bucket_payload.get("paper_route_target_notional_sizing")
        )
        if target_notional_sizing.get("requires_target_notional_sizing"):
            target_notional_sizing_required_count += 1
            target_notional_sizing_authoritative_count += _nonnegative_int(
                target_notional_sizing.get("authoritative_target_notional_sizing_count")
            )
            target_notional_sizing_missing_count += _nonnegative_int(
                target_notional_sizing.get("missing_target_notional_sizing_count")
            )
            target_notional_sizing_non_authoritative_count += sum(
                _nonnegative_int(value)
                for value in _as_mapping(
                    target_notional_sizing.get("non_authoritative_sizing_source_counts")
                ).values()
            )
            blockers.extend(_metadata_text_list(target_notional_sizing.get("blockers")))
        if runtime_ledger_promotion_source_authority_present(bucket_payload):
            source_execution_materialized_count += 1
        if authority_reason == "execution_reconstruction_not_runtime_ledger_proof":
            execution_reconstruction_count += 1
        for blocker_source in (
            row.get("runtime_ledger_blockers"),
            row.get("promotion_blocker"),
            bucket_payload.get("blockers"),
        ):
            blockers.extend(_metadata_text_list(blocker_source))
    blockers.extend(profit_proof_blockers)
    return {
        "runtime_ledger_tca_row_count": len(tca_rows),
        "runtime_ledger_tca_runtime_bucket_row_count": bucket_row_count,
        "runtime_ledger_tca_profit_proof_count": profit_proof_count,
        "runtime_ledger_tca_authoritative_bucket_count": authoritative_bucket_count,
        "runtime_ledger_source_execution_materialized_bucket_count": (
            source_execution_materialized_count
        ),
        "runtime_ledger_execution_reconstruction_bucket_count": (
            execution_reconstruction_count
        ),
        "paper_route_target_notional_sizing_required_count": (
            target_notional_sizing_required_count
        ),
        "paper_route_target_notional_sizing_authoritative_count": (
            target_notional_sizing_authoritative_count
        ),
        "paper_route_target_notional_sizing_missing_count": (
            target_notional_sizing_missing_count
        ),
        "paper_route_target_notional_sizing_non_authoritative_count": (
            target_notional_sizing_non_authoritative_count
        ),
        "runtime_ledger_materialization_authority_reasons": sorted(
            dict.fromkeys(authority_reasons)
        ),
        "runtime_ledger_materialization_pnl_derivations": sorted(
            dict.fromkeys(pnl_derivations)
        ),
        "runtime_ledger_source_materializations": sorted(
            dict.fromkeys(source_materializations)
        ),
        "runtime_ledger_materialization_blockers": sorted(dict.fromkeys(blockers)),
        "runtime_ledger_profit_proof_blockers": sorted(
            dict.fromkeys(profit_proof_blockers)
        ),
    }


def _runtime_ledger_tca_rows_from_observed_buckets(
    buckets: Sequence[object],
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for bucket in buckets:
        payload_json = _as_mapping(getattr(bucket, "payload_json", {}))
        bucket_payloads: list[Any] = []
        raw_payloads = _as_sequence(payload_json.get("runtime_ledger_buckets")) or []
        bucket_payloads.extend(raw_payloads)
        single_payload = _as_mapping(payload_json.get("runtime_ledger_bucket"))
        if single_payload:
            bucket_payloads.append(single_payload)
        for raw_payload in bucket_payloads:
            ledger_payload = _as_mapping(raw_payload)
            if not ledger_payload:
                continue
            rows.append(
                {
                    "runtime_ledger_bucket": ledger_payload,
                    "authoritative": ledger_payload.get("authoritative"),
                    "authority_reason": ledger_payload.get("authority_reason"),
                    "pnl_derivation": ledger_payload.get("pnl_derivation"),
                    "runtime_ledger_blockers": ledger_payload.get("blockers"),
                    "post_cost_expectancy_basis": ledger_payload.get("pnl_basis"),
                    "paper_route_target_notional_sizing": ledger_payload.get(
                        "paper_route_target_notional_sizing"
                    ),
                }
            )
    return rows


def _runtime_observation_payload_with_observed_runtime_ledger_materialization(
    *,
    source_kind: str,
    runtime_observation_payload: Mapping[str, Any],
    buckets: Sequence[object],
) -> dict[str, Any]:
    observed_rows = _runtime_ledger_tca_rows_from_observed_buckets(buckets)
    if not observed_rows:
        return dict(runtime_observation_payload)

    observed_materialization = _runtime_ledger_tca_materialization_metadata(
        observed_rows
    )
    observed_authority = _runtime_observation_authority_payload(
        source_kind=source_kind,
        tca_rows=observed_rows,
    )
    observed_materialization_blockers = sorted(
        dict.fromkeys(
            [
                *_metadata_text_list(
                    observed_materialization.get(
                        "runtime_ledger_materialization_blockers"
                    )
                ),
                *_metadata_text_list(
                    observed_materialization.get("runtime_ledger_profit_proof_blockers")
                ),
            ]
        )
    )
    source_diagnostics = {
        **_as_mapping(runtime_observation_payload.get("source_activity_diagnostics")),
        "observed_runtime_ledger_materialization_authority": True,
        "observed_runtime_ledger_tca_row_count": observed_materialization[
            "runtime_ledger_tca_row_count"
        ],
        "observed_runtime_ledger_runtime_bucket_row_count": (
            observed_materialization["runtime_ledger_tca_runtime_bucket_row_count"]
        ),
        "observed_runtime_ledger_profit_proof_count": observed_materialization[
            "runtime_ledger_tca_profit_proof_count"
        ],
        "observed_runtime_ledger_materialization_blockers": (
            observed_materialization["runtime_ledger_materialization_blockers"]
        ),
        "observed_runtime_ledger_profit_proof_blockers": (
            observed_materialization["runtime_ledger_profit_proof_blockers"]
        ),
    }
    return {
        **dict(runtime_observation_payload),
        **observed_authority,
        **observed_materialization,
        "runtime_ledger_materialization_authority_source": ("observed_runtime_buckets"),
        "source_activity_diagnostics": source_diagnostics,
        "source_activity_diagnostic_blockers": observed_materialization_blockers,
        "source_activity_diagnostic_blockers_from_source_query": (
            _metadata_text_list(
                runtime_observation_payload.get("source_activity_diagnostic_blockers")
            )
        ),
    }


def _runtime_window_import_audit_summary(
    *,
    run_id: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_name: str,
    strategy_names: Sequence[str],
    account_label: str,
    source_account_label: str,
    window_start: datetime,
    window_end: datetime,
    source_kind: str,
    source_manifest_ref: str | None,
    dataset_snapshot_ref: str | None,
    decisions: Sequence[datetime],
    executions: Sequence[datetime],
    tca_rows: Sequence[Mapping[str, object]],
    buckets: Sequence[object],
    runtime_observation_payload: Mapping[str, Any],
    runtime_ledger_target_metadata_blockers: Sequence[str],
) -> dict[str, Any]:
    ledger_payloads = [
        payload
        for row in tca_rows
        if (payload := _as_mapping(row.get("runtime_ledger_bucket")))
    ]
    ledger_profit_proof_blockers = sorted(
        {
            blocker
            for payload in ledger_payloads
            for blocker in _runtime_ledger_bucket_profit_proof_blockers(payload)
        }
    )
    observed_bucket_payloads = [
        _as_mapping(getattr(bucket, "payload_json", {})) for bucket in buckets
    ]
    observed_bucket_blockers = sorted(
        {
            blocker
            for payload in observed_bucket_payloads
            for blocker in _metadata_text_list(
                payload.get("runtime_ledger_profit_proof_blockers")
                or payload.get("promotion_blocking_reasons")
                or payload.get("blockers")
            )
        }
    )
    source_activity_diagnostics = _as_mapping(
        runtime_observation_payload.get("source_activity_diagnostics")
    )
    return {
        "schema_version": "torghut.runtime-window-import-source-audit.v1",
        "audit_only": True,
        "would_persist": False,
        "verdict": (
            "profit_proof_present"
            if _runtime_ledger_profit_proof_present(tca_rows)
            else "blocked"
        ),
        "run_id": run_id,
        "candidate_id": candidate_id,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "strategy_name": strategy_name,
        "strategy_name_candidates": list(strategy_names),
        "account_label": account_label,
        "source_account_label": source_account_label,
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "source_kind": source_kind,
        "source_manifest_ref": source_manifest_ref,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "decision_count": len(decisions),
        "execution_count": len(executions),
        "tca_row_count": len(tca_rows),
        "runtime_ledger_bucket_row_count": len(ledger_payloads),
        "observed_runtime_bucket_count": len(buckets),
        "observed_runtime_bucket_blockers": observed_bucket_blockers,
        "runtime_ledger_profit_proof_present": _runtime_ledger_profit_proof_present(
            tca_rows
        ),
        "runtime_ledger_profit_proof_blockers": ledger_profit_proof_blockers,
        "runtime_ledger_target_metadata_blockers": list(
            dict.fromkeys(runtime_ledger_target_metadata_blockers)
        ),
        "source_activity_diagnostics": source_activity_diagnostics,
        "source_activity_diagnostic_blockers": _metadata_text_list(
            runtime_observation_payload.get("source_activity_diagnostic_blockers")
        ),
        "promotion_authority": runtime_observation_payload.get("promotion_authority"),
        "authority_reason": runtime_observation_payload.get("authority_reason"),
        "runtime_observation": {
            "runtime_ledger_profit_proof_present": runtime_observation_payload.get(
                "runtime_ledger_profit_proof_present"
            ),
            "evidence_provenance": runtime_observation_payload.get(
                "evidence_provenance"
            ),
            "source_kind": runtime_observation_payload.get("source_kind"),
            "source_activity_symbol_filter": runtime_observation_payload.get(
                "source_activity_symbol_filter"
            ),
        },
        "runtime_ledger_materialization": _runtime_ledger_tca_materialization_metadata(
            tca_rows
        ),
    }


__all__ = [
    "_mark_runtime_ledger_tca_rows_as_exact_replay_artifacts",
    "_runtime_ledger_target_metadata_blockers",
    "_runtime_window_import_proof_hygiene_blockers",
    "_runtime_ledger_profit_proof_present",
    "_runtime_observation_authority_payload",
    "_runtime_ledger_tca_materialization_metadata",
    "_runtime_ledger_tca_rows_from_observed_buckets",
    "_runtime_observation_payload_with_observed_runtime_ledger_materialization",
    "_runtime_window_import_audit_summary",
]
