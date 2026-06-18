"""Summary and diagnostic functions for runtime window imports."""

from __future__ import annotations

from typing import Any, Sequence

from .parsers import (
    as_mapping,
    metadata_text_list,
    nonnegative_int,
    parse_dt_or_none,
    text_or_none,
)
from .validation import (
    runtime_ledger_promotion_source_authority_present,
)

RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER = (
    "runtime_ledger_authority_class_missing"
)
EXECUTION_TCA_MISSING_BLOCKER = "execution_tca_missing"
RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER = (
    "runtime_ledger_execution_tca_refs_missing"
)
RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS = frozenset(
    {
        "runtime_ledger_source_window_missing",
        "runtime_ledger_source_window_ids_missing",
        "runtime_ledger_source_refs_missing",
        "runtime_ledger_trade_decision_refs_missing",
        "runtime_ledger_execution_refs_missing",
        "runtime_ledger_execution_order_event_refs_missing",
        "runtime_ledger_source_offsets_missing",
        "runtime_ledger_source_materialization_missing",
        "runtime_ledger_authority_class_missing",
        "order_feed_source_window_gap",
        "order_feed_lifecycle_missing",
        "execution_economics_missing",
    }
)
_SOURCE_DECISION_MODE_MISSING_PARTITION = "source_decision_mode_missing"
_SOURCE_LINEAGE_CANDIDATE_KEYS = (
    "candidate_id",
    "candidate_ids",
    "strategy_candidate_id",
    "strategy_candidate_ids",
    "source_candidate_id",
    "source_candidate_ids",
)
_SOURCE_LINEAGE_HYPOTHESIS_KEYS = (
    "hypothesis_id",
    "hypothesis_ids",
    "strategy_hypothesis_id",
    "strategy_hypothesis_ids",
    "source_hypothesis_id",
    "source_hypothesis_ids",
)
_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }
)
_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }
)


def runtime_ledger_target_metadata_blockers(
    *,
    target_metadata: dict,
    runtime_ledger_artifact_metadata: dict,
    window_start: Any,
    window_end: Any,
) -> list[str]:
    """Get blockers from target metadata."""
    metadata = as_mapping(target_metadata)
    if not metadata:
        return []

    blockers: list[str] = []
    planned_refs = runtime_ledger_target_metadata_artifact_refs(metadata)
    loaded_refs = metadata_text_list(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_refs")
    )
    if loaded_refs and not text_or_none(
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
            count = metadata_nonnegative_int_or_none(metadata.get(key))
            if count is not None:
                planned_count = count
                break
        if planned_count is None:
            continue
        loaded_count = nonnegative_int(runtime_ledger_artifact_metadata.get(keys[0]))
        if planned_count != loaded_count:
            blockers.append(blocker)

    for key, actual_bound in (
        ("window_start", window_start),
        ("window_end", window_end),
    ):
        expected_bound = parse_dt_or_none(metadata.get(key))
        if metadata.get(key) is not None and expected_bound != actual_bound:
            blockers.append("runtime_ledger_window_bounds_mismatch")
            break

    expected_candidate_id = text_or_none(metadata.get("candidate_id"))
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
    loaded_candidate_ids = metadata_text_list(
        runtime_ledger_artifact_metadata.get("runtime_ledger_artifact_candidate_ids")
    )
    loaded_candidate_id = text_or_none(
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

    planned_window_weekdays = metadata_nonnegative_int_or_none(
        metadata.get("replay_window_weekday_count")
    )
    loaded_window_weekdays = metadata_nonnegative_int_or_none(
        runtime_ledger_artifact_metadata.get(
            "runtime_ledger_artifact_window_weekday_count"
        )
    )
    if planned_window_weekdays is not None:
        if loaded_window_weekdays is None:
            blockers.append("runtime_ledger_artifact_window_weekday_count_missing")
        elif planned_window_weekdays != loaded_window_weekdays:
            blockers.append("runtime_ledger_artifact_window_weekday_count_mismatch")

    min_window_weekdays = metadata_nonnegative_int_or_none(
        metadata.get("replay_min_window_weekday_count")
    )
    if min_window_weekdays is not None:
        if loaded_window_weekdays is None:
            blockers.append("runtime_ledger_artifact_window_weekday_count_missing")
        elif loaded_window_weekdays < min_window_weekdays:
            blockers.append("runtime_ledger_artifact_window_weekday_count_below_min")

    return list(dict.fromkeys(blockers))


def runtime_ledger_target_metadata_artifact_refs(
    target_metadata: dict,
) -> list[str]:
    """Extract artifact refs from target metadata."""
    refs: list[str] = []
    for key in (
        "runtime_ledger_artifact_refs",
        "exact_replay_ledger_artifact_refs",
    ):
        refs.extend(metadata_text_list(target_metadata.get(key)))
    for key in (
        "runtime_ledger_artifact_ref",
        "exact_replay_ledger_artifact_ref",
    ):
        refs.extend(metadata_text_list(target_metadata.get(key)))
    return list(dict.fromkeys(refs))


def metadata_nonnegative_int_or_none(value: Any) -> int | None:
    """Convert value to non-negative int or None."""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return nonnegative_int(value)


def runtime_window_import_proof_hygiene_blockers(
    *,
    source_kind: str,
    target_metadata: dict,
    dependency_quorum_decision: str,
    continuity_ok: str,
    drift_ok: str,
) -> list[str]:
    """Get proof hygiene blockers."""
    blockers: list[str] = []
    normalized_source_kind = source_kind.strip().lower().replace("-", "_")
    if not target_metadata and not runtime_window_source_kind_is_informational(
        source_kind=source_kind,
        target_metadata=target_metadata,
    ):
        blockers.append("runtime_window_target_metadata_missing")
    source_collection_candidate = (
        normalized_source_kind == "runtime_ledger_source_collection_candidate"
    )
    if source_collection_candidate:
        blockers.extend(
            source_collection_target_authorization_blockers(target_metadata)
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
        blockers.extend(metadata_text_list(target_metadata.get(key)))
    return blockers


def source_collection_target_authorization_blockers(
    target_metadata: dict,
) -> list[str]:
    """Get source collection authorization blockers."""
    blockers: list[str] = []
    if target_metadata.get("source_collection_authorized") is not True:
        blockers.append("source_collection_authorization_missing")
    if (
        str(target_metadata.get("source_collection_authorization_scope") or "").strip()
        != "source_window_evidence_collection_only"
    ):
        blockers.append("source_collection_authorization_scope_invalid")
    return blockers


def runtime_window_source_kind_is_informational(
    *,
    source_kind: str,
    target_metadata: dict,
) -> bool:
    """Check if source kind is informational."""
    normalized = source_kind.strip().lower().replace("-", "_")
    if normalized.startswith("simulation_"):
        return True
    if any(
        marker in normalized
        for marker in (
            "informational",
            "non_authoritative",
            "offline_replay_triage",
            "selection_only",
        )
    ):
        return True
    return False


def source_kind_allows_runtime_ledger_materialization(
    *,
    source_kind: str,
    target_metadata: dict,
) -> bool:
    """Check if source kind allows runtime ledger materialization."""
    if runtime_window_source_kind_is_informational(
        source_kind=source_kind,
        target_metadata=target_metadata,
    ):
        return False
    normalized = source_kind.strip().lower().replace("-", "_")
    if normalized == "runtime_ledger_source_collection_candidate":
        return not source_collection_target_authorization_blockers(target_metadata)
    AUTHORITATIVE_SOURCE_KINDS = frozenset(
        {
            "paper_route_probe_runtime_observed",
            "paper_runtime_observed",
            "runtime_ledger_source_collection_candidate",
            "live_runtime_observed",
        }
    )
    return normalized in AUTHORITATIVE_SOURCE_KINDS


def runtime_ledger_profit_proof_present(
    tca_rows: Sequence[dict[str, object]],
) -> bool:
    """Check if runtime ledger profit proof is present."""
    for row in tca_rows:
        if (
            row.get("post_cost_expectancy_basis")
            != "runtime_ledger_post_cost_pnl_basis"
        ):
            continue
        bucket = row.get("runtime_ledger_bucket")
        if not isinstance(bucket, dict):
            continue
        if runtime_ledger_bucket_profit_proof_present(bucket):
            return True
    return False


def runtime_ledger_bucket_profit_proof_present(
    bucket: dict[str, object],
) -> bool:
    """Check if bucket has profit proof."""
    return not runtime_ledger_bucket_profit_proof_blockers(bucket)


def runtime_ledger_bucket_profit_proof_blockers(
    bucket: dict[str, object],
) -> list[str]:
    """Get profit proof blockers for bucket."""
    from .validation import runtime_ledger_bucket_profit_proof_blockers as base_blockers

    return base_blockers(bucket)


def source_activity_diagnostics_blockers(
    source_activity_diagnostics: dict[str, Any],
) -> list[str]:
    """Get source activity diagnostic blockers."""
    blockers: list[str] = []
    if source_activity_diagnostics.get("source_dsn_configured") is not True:
        blockers.append("source_dsn_not_configured")
    if source_activity_diagnostics.get("source_kind") == "paper_runtime_observed":
        blockers.append("paper_runtime_observed")
    return blockers


def source_activity_missing(
    *,
    run_id: str,
    candidate_id: str,
    hypothesis_id: str,
    observed_stage: str,
    strategy_name: str,
    strategy_names: Sequence[str],
    account_label: str,
    source_account_label: str,
    window_start: Any,
    window_end: Any,
    source_manifest_ref: str,
    source_kind: str,
    dataset_snapshot_ref: str | None,
    source_activity_symbols: list[str],
    target_metadata: dict,
    proof_hygiene_blockers: list[str],
    source_activity_diagnostics: dict[str, Any],
) -> dict[str, Any]:
    """Generate missing source activity summary."""
    summary = {
        "schema_version": "torghut.runtime-window-import-source-missing.v1",
        "run_id": run_id,
        "candidate_id": candidate_id.strip() or None,
        "hypothesis_id": hypothesis_id,
        "observed_stage": observed_stage,
        "strategy_name": strategy_name,
        "strategy_name_candidates": list(strategy_names),
        "account_label": account_label,
        "source_account_label": source_account_label,
        "window_start": window_start.isoformat()
        if hasattr(window_start, "isoformat")
        else str(window_start),
        "window_end": window_end.isoformat()
        if hasattr(window_end, "isoformat")
        else str(window_end),
        "source_kind": source_kind,
        "source_manifest_ref": source_manifest_ref.strip() or None,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "source_activity_symbols": source_activity_symbols,
        "target_metadata": target_metadata,
        "proof_hygiene_blockers": list(dict.fromkeys(proof_hygiene_blockers)),
        "source_activity_diagnostics": source_activity_diagnostics,
        "source_activity_diagnostic_blockers": source_activity_diagnostics_blockers(
            source_activity_diagnostics
        ),
        "source_activity_missing": True,
    }
    return summary


def build_runtime_observation_payload(
    *,
    source_kind: str,
    tca_rows: Sequence[dict[str, object]],
    observed_stage: str,
    evidence_provenance: str,
    source_manifest_ref: str | None,
    strategy_name: str,
    strategy_names: Sequence[str],
    account_label: str,
    source_account_label: str,
    source_activity_symbol_filter: list[str],
    source_activity_diagnostics: dict[str, Any],
    source_activity_diagnostic_blockers: list[str],
    window_start: str,
    window_end: str,
    artifact_refs: list[str],
    dataset_snapshot_ref: str | None,
    target_metadata: dict,
    runtime_ledger_target_metadata_blockers: list[str],
    **metadata: Any,
) -> dict[str, Any]:
    """Build runtime observation payload."""
    authority_payload = runtime_observation_authority_payload(
        source_kind=source_kind,
        tca_rows=tca_rows,
    )
    materialization_payload = runtime_ledger_tca_materialization_metadata(tca_rows)
    return {
        **authority_payload,
        **materialization_payload,
        "observed_stage": observed_stage,
        "evidence_provenance": evidence_provenance,
        "source_kind": source_kind,
        "source_manifest_ref": source_manifest_ref,
        "strategy_name": strategy_name,
        "strategy_name_candidates": list(strategy_names),
        "account_label": account_label,
        "source_account_label": source_account_label,
        "source_activity_symbol_filter": source_activity_symbol_filter,
        "source_activity_diagnostics": source_activity_diagnostics,
        "source_activity_diagnostic_blockers": source_activity_diagnostic_blockers,
        "window_start": window_start,
        "window_end": window_end,
        "artifact_refs": artifact_refs,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "target_metadata": target_metadata,
        "runtime_ledger_target_metadata_blockers": runtime_ledger_target_metadata_blockers,
        **metadata,
    }


def runtime_observation_authority_payload(
    *,
    source_kind: str,
    tca_rows: Sequence[dict[str, object]],
) -> dict[str, Any]:
    """Build runtime observation authority payload."""
    has_runtime_ledger_profit_proof = runtime_ledger_profit_proof_present(tca_rows)
    exact_replay_artifact_only = any(
        "exact_replay_artifact_not_runtime_proof"
        in metadata_text_list(row.get("runtime_ledger_blockers"))
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


def runtime_ledger_tca_materialization_metadata(
    tca_rows: Sequence[dict[str, object]],
) -> dict[str, Any]:
    """Build runtime ledger TCA materialization metadata."""
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
        if not isinstance(bucket, dict):
            continue
        bucket_payload = {str(key): value for key, value in bucket.items()}
        bucket_row_count += 1
        if runtime_ledger_bucket_profit_proof_present(bucket_payload):
            profit_proof_count += 1
        else:
            profit_proof_blockers.extend(
                runtime_ledger_bucket_profit_proof_blockers(bucket_payload)
            )
        if bool(row.get("authoritative")) or bool(bucket_payload.get("authoritative")):
            authoritative_bucket_count += 1
        authority_reason = text_or_none(
            row.get("authority_reason") or bucket_payload.get("authority_reason")
        )
        if authority_reason is not None:
            authority_reasons.append(authority_reason)
        pnl_derivation = text_or_none(
            row.get("pnl_derivation") or bucket_payload.get("pnl_derivation")
        )
        if pnl_derivation is not None:
            pnl_derivations.append(pnl_derivation)
        source_materialization = text_or_none(
            bucket_payload.get("source_materialization")
        )
        if source_materialization is not None:
            source_materializations.append(source_materialization)

        target_notional_sizing = as_mapping(
            row.get("paper_route_target_notional_sizing")
            or bucket_payload.get("paper_route_target_notional_sizing")
        )
        if target_notional_sizing.get("requires_target_notional_sizing"):
            target_notional_sizing_required_count += 1
            target_notional_sizing_authoritative_count += nonnegative_int(
                target_notional_sizing.get("authoritative_target_notional_sizing_count")
            )
            target_notional_sizing_missing_count += nonnegative_int(
                target_notional_sizing.get("missing_target_notional_sizing_count")
            )
            target_notional_sizing_non_authoritative_count += sum(
                nonnegative_int(value)
                for value in as_mapping(
                    target_notional_sizing.get("non_authoritative_sizing_source_counts")
                ).values()
            )
            blockers.extend(metadata_text_list(target_notional_sizing.get("blockers")))
        if runtime_ledger_promotion_source_authority_present(bucket_payload):
            source_execution_materialized_count += 1
        if authority_reason == "execution_reconstruction_not_runtime_ledger_proof":
            execution_reconstruction_count += 1
        for blocker_source in (
            row.get("runtime_ledger_blockers"),
            row.get("promotion_blocker"),
            bucket_payload.get("blockers"),
        ):
            blockers.extend(metadata_text_list(blocker_source))
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


def runtime_observation_payload_with_observed_runtime_ledger_materialization(
    *,
    source_kind: str,
    runtime_observation_payload: dict[str, Any],
    buckets: Sequence[Any],
) -> dict[str, Any]:
    """Add observed runtime ledger materialization to payload."""
    observed_rows = runtime_ledger_tca_rows_from_observed_buckets(buckets)
    if not observed_rows:
        return dict(runtime_observation_payload)

    observed_materialization = runtime_ledger_tca_materialization_metadata(
        observed_rows
    )
    observed_authority = runtime_observation_authority_payload(
        source_kind=source_kind,
        tca_rows=observed_rows,
    )
    observed_materialization_blockers = sorted(
        dict.fromkeys(
            [
                *metadata_text_list(
                    observed_materialization.get(
                        "runtime_ledger_materialization_blockers"
                    )
                ),
                *metadata_text_list(
                    observed_materialization.get("runtime_ledger_profit_proof_blockers")
                ),
            ]
        )
    )
    source_diagnostics = {
        **as_mapping(runtime_observation_payload.get("source_activity_diagnostics")),
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
            metadata_text_list(
                runtime_observation_payload.get("source_activity_diagnostic_blockers")
            )
        ),
    }


def runtime_ledger_tca_rows_from_observed_buckets(
    buckets: Sequence[Any],
) -> list[dict[str, Any]]:
    """Extract TCA rows from observed buckets."""
    rows: list[dict[str, Any]] = []
    for bucket in buckets:
        payload_json = as_mapping(getattr(bucket, "payload_json", {}))
        bucket_payloads: list[Any] = []
        raw_payloads = as_sequence(payload_json.get("runtime_ledger_buckets")) or []
        bucket_payloads.extend(raw_payloads)
        single_payload = as_mapping(payload_json.get("runtime_ledger_bucket"))
        if single_payload:
            bucket_payloads.append(single_payload)
        for raw_payload in bucket_payloads:
            ledger_payload = as_mapping(raw_payload)
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


def as_sequence(value: Any) -> list[Any] | None:
    """Convert value to list or None."""
    if value is None:
        return []
    if isinstance(value, str):
        try:
            parsed = __import__("json").loads(value)
        except Exception:
            return None
        return as_sequence(parsed)
    if isinstance(value, __import__("typing").Sequence) and not isinstance(
        value, (bytes, bytearray)
    ):
        return list(value)
    return None


def runtime_window_import_audit_summary(
    *,
    run_id: str,
    candidate_id: str | None,
    hypothesis_id: str,
    observed_stage: str,
    strategy_name: str,
    strategy_names: Sequence[str],
    account_label: str,
    source_account_label: str,
    window_start: Any,
    window_end: Any,
    source_kind: str,
    source_manifest_ref: str | None,
    dataset_snapshot_ref: str | None,
    decisions: Sequence[Any],
    executions: Sequence[Any],
    tca_rows: Sequence[dict[str, object]],
    buckets: Sequence[Any],
    runtime_observation_payload: dict[str, Any],
    runtime_ledger_target_metadata_blockers: list[str],
) -> dict[str, Any]:
    """Build runtime window import audit summary."""
    ledger_payloads = [
        payload
        for row in tca_rows
        if (payload := as_mapping(row.get("runtime_ledger_bucket")))
    ]
    ledger_profit_proof_blockers = sorted(
        {
            blocker
            for payload in ledger_payloads
            for blocker in runtime_ledger_bucket_profit_proof_blockers(payload)
        }
    )
    observed_bucket_payloads = [
        as_mapping(getattr(bucket, "payload_json", {})) for bucket in buckets
    ]
    observed_bucket_blockers = sorted(
        {
            blocker
            for payload in observed_bucket_payloads
            for blocker in metadata_text_list(
                payload.get("runtime_ledger_profit_proof_blockers")
                or payload.get("promotion_blocking_reasons")
                or payload.get("blockers")
            )
        }
    )
    source_activity_diagnostics = as_mapping(
        runtime_observation_payload.get("source_activity_diagnostics")
    )
    return {
        "schema_version": "torghut.runtime-window-import-source-audit.v1",
        "audit_only": True,
        "would_persist": False,
        "verdict": (
            "profit_proof_present"
            if runtime_ledger_profit_proof_present(tca_rows)
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
        "window_start": window_start.isoformat()
        if hasattr(window_start, "isoformat")
        else str(window_start),
        "window_end": window_end.isoformat()
        if hasattr(window_end, "isoformat")
        else str(window_end),
        "source_kind": source_kind,
        "source_manifest_ref": source_manifest_ref,
        "dataset_snapshot_ref": dataset_snapshot_ref,
        "decision_count": len(decisions),
        "execution_count": len(executions),
        "tca_row_count": len(tca_rows),
        "runtime_ledger_bucket_row_count": len(ledger_payloads),
        "observed_runtime_bucket_count": len(buckets),
        "observed_runtime_bucket_blockers": observed_bucket_blockers,
        "runtime_ledger_profit_proof_present": runtime_ledger_profit_proof_present(
            tca_rows
        ),
        "runtime_ledger_profit_proof_blockers": ledger_profit_proof_blockers,
        "runtime_ledger_target_metadata_blockers": list(
            dict.fromkeys(runtime_ledger_target_metadata_blockers)
        ),
        "source_activity_diagnostics": source_activity_diagnostics,
        "source_activity_diagnostic_blockers": metadata_text_list(
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
        "runtime_ledger_materialization": runtime_ledger_tca_materialization_metadata(
            tca_rows
        ),
    }
