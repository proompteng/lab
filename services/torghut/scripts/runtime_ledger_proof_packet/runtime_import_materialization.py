"""Runtime-window import materialization checks for proof packet assembly."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from scripts.runtime_ledger_proof_packet.common import (
    RUNTIME_IMPORT_MATERIALIZATION_PROMOTION_ONLY_BLOCKERS,
    RUNTIME_IMPORT_MATERIALIZATION_STRUCTURAL_BLOCKERS,
    _bool,
    _decimal,
    _int,
    _mapping,
    _sequence,
    _text,
    _text_list,
)
from scripts.runtime_ledger_proof_packet.hpairs import (
    _extend_unique,
    _source_offsets,
)
from scripts.runtime_ledger_proof_packet.paper_route import (
    _runtime_window_import_items,
)


def _runtime_import_blockers(payload: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    for raw_blocker in _sequence(payload.get("proof_blockers")):
        blocker = _mapping(raw_blocker)
        if blocker:
            _extend_unique(
                blockers, [_text(blocker.get("blocker") or blocker.get("type"))]
            )
        else:
            text = _text(raw_blocker)
            if text:
                _extend_unique(blockers, [text])
    for item in _runtime_window_import_items(payload):
        if item is payload:
            continue
        _extend_unique(blockers, _runtime_import_blockers(item))
    return blockers


def _runtime_import_authoritative_observation_count(payload: Mapping[str, Any]) -> int:
    count = 0
    for item in _runtime_window_import_items(payload):
        summary = _mapping(item.get("summary"))
        observation = _mapping(summary.get("runtime_observation"))
        if observation and observation.get("authoritative") is True:
            count += 1
    return count


def _runtime_import_runtime_observations(
    payload: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    observations: list[Mapping[str, Any]] = []
    for item in _runtime_window_import_items(payload):
        summary = _mapping(item.get("summary"))
        observation = _mapping(summary.get("runtime_observation"))
        if observation:
            observations.append(observation)
    return observations


def _runtime_import_target_materialization_ref(
    *,
    item: Mapping[str, Any],
    observation: Mapping[str, Any],
    profit_proof_count: int,
    materialized: bool,
    blockers: Sequence[str],
) -> dict[str, Any]:
    summary = _mapping(item.get("summary"))
    materialization_target = _mapping(summary.get("runtime_materialization_target"))
    materialization_counts = {
        "metric_window_count": _int(materialization_target.get("metric_window_count")),
        "promotion_decision_count": _int(
            materialization_target.get("promotion_decision_count")
        ),
        "runtime_ledger_bucket_count": _int(
            materialization_target.get("runtime_ledger_bucket_count")
        ),
        "evidence_grade_runtime_ledger_bucket_count": _int(
            materialization_target.get("evidence_grade_runtime_ledger_bucket_count")
        ),
    }

    def first_text(*keys: str) -> str:
        for source in (item, summary, materialization_target, observation):
            for key in keys:
                value = _text(source.get(key))
                if value:
                    return value
        return ""

    tigerbeetle_refs = _runtime_import_tigerbeetle_refs(
        item,
        summary,
        materialization_target,
        observation,
    )
    readback = _runtime_import_readback_payload(
        summary=summary,
        target=materialization_target,
    )
    ref: dict[str, Any] = {
        "materialized": materialized,
        "candidate_id": first_text("candidate_id"),
        "hypothesis_id": first_text("hypothesis_id"),
        "observed_stage": first_text("observed_stage"),
        "strategy_family": first_text("strategy_family"),
        "strategy_name": first_text("strategy_name", "runtime_strategy_name"),
        "account_label": first_text("account_label"),
        "window_start": first_text("window_start", "window_started_at"),
        "window_end": first_text("window_end", "window_ended_at"),
        "authoritative": observation.get("authoritative") is True,
        "authority_reason": _text(observation.get("authority_reason")),
        "source_kind": _text(observation.get("source_kind")),
        "runtime_ledger_profit_proof_count": profit_proof_count,
        "runtime_ledger_tca_row_count": _int(
            observation.get("runtime_ledger_tca_row_count")
        ),
        "runtime_ledger_tca_authoritative_bucket_count": _int(
            observation.get("runtime_ledger_tca_authoritative_bucket_count")
        ),
        "runtime_ledger_source_execution_materialized_bucket_count": _int(
            observation.get("runtime_ledger_source_execution_materialized_bucket_count")
        ),
        "runtime_ledger_filled_notional": _text(
            observation.get("runtime_ledger_filled_notional")
        ),
        "runtime_ledger_net_strategy_pnl_after_costs": _text(
            observation.get("runtime_ledger_net_strategy_pnl_after_costs")
        ),
        **materialization_counts,
        "metric_window_ids": _text_list(
            materialization_target.get("metric_window_ids")
        ),
        "promotion_decision_id": _text(
            materialization_target.get("promotion_decision_id")
        ),
        "runtime_ledger_bucket_ids": _text_list(
            materialization_target.get("runtime_ledger_bucket_ids")
        ),
        "evidence_grade_runtime_ledger_bucket_ids": _text_list(
            materialization_target.get("evidence_grade_runtime_ledger_bucket_ids")
        ),
        "blockers": list(blockers),
    }
    if readback:
        ref["readback"] = {
            "schema_version": _text(readback.get("schema_version")),
            "metric_window_count": _int(readback.get("metric_window_count")),
            "promotion_decision_count": _int(readback.get("promotion_decision_count")),
            "runtime_ledger_bucket_count": _int(
                readback.get("runtime_ledger_bucket_count")
            ),
            "evidence_grade_runtime_ledger_bucket_count": _int(
                readback.get("evidence_grade_runtime_ledger_bucket_count")
            ),
            "metric_window_refs": _text_list(readback.get("metric_window_refs")),
            "promotion_decision_refs": _text_list(
                readback.get("promotion_decision_refs")
            ),
            "runtime_ledger_bucket_refs": _text_list(
                readback.get("runtime_ledger_bucket_refs")
            ),
            "evidence_grade_runtime_ledger_bucket_refs": _text_list(
                readback.get("evidence_grade_runtime_ledger_bucket_refs")
            ),
            "source_refs": _text_list(readback.get("source_refs")),
            "source_window_ids": _text_list(
                readback.get("runtime_ledger_source_window_ids")
            )
            or _text_list(readback.get("source_window_ids")),
            "execution_order_event_ids": _text_list(
                readback.get("runtime_ledger_execution_order_event_ids")
            )
            or _text_list(readback.get("execution_order_event_ids")),
            "execution_ids": _text_list(readback.get("execution_ids")),
            "execution_tca_metric_ids": _text_list(
                readback.get("runtime_ledger_execution_tca_metric_ids")
            )
            or _text_list(readback.get("execution_tca_metric_ids")),
            "trade_decision_ids": _text_list(readback.get("trade_decision_ids")),
            "source_offsets": _source_offsets(readback.get("source_offsets")),
            "authority_classes": _text_list(readback.get("authority_classes")),
            "source_materializations": _text_list(
                readback.get("source_materializations")
            ),
            "cost_basis_counts": dict(_mapping(readback.get("cost_basis_counts"))),
        }
        profit_distance_readback = _mapping(
            readback.get("runtime_ledger_profit_distance_readback")
        )
        if profit_distance_readback:
            ref["readback"]["runtime_ledger_profit_distance_readback"] = dict(
                profit_distance_readback
            )
            ref["runtime_ledger_profit_distance_readback"] = dict(
                profit_distance_readback
            )
    if tigerbeetle_refs:
        ref["tigerbeetle"] = tigerbeetle_refs
    return {key: value for key, value in ref.items() if value not in ("", [], None)}


def _runtime_import_tigerbeetle_refs(
    *sources: Mapping[str, Any],
) -> dict[str, Any]:
    account_ids: list[str] = []
    account_keys: list[str] = []
    transfer_ids: list[str] = []
    source_refs: list[str] = []
    missing_account_ids: list[str] = []
    cluster_ids: list[str] = []
    bucket_refs: list[Mapping[str, Any]] = []

    def extend_unique(target: list[str], values: Sequence[str]) -> None:
        for value in values:
            if value and value not in target:
                target.append(value)

    for source in sources:
        refs = _mapping(source.get("tigerbeetle"))
        extend_unique(account_ids, _text_list(source.get("tigerbeetle_account_ids")))
        extend_unique(account_keys, _text_list(source.get("tigerbeetle_account_keys")))
        extend_unique(transfer_ids, _text_list(source.get("tigerbeetle_transfer_ids")))
        if refs:
            extend_unique(cluster_ids, _text_list(refs.get("cluster_ids")))
            extend_unique(account_ids, _text_list(refs.get("account_ids")))
            extend_unique(account_keys, _text_list(refs.get("account_keys")))
            extend_unique(transfer_ids, _text_list(refs.get("transfer_ids")))
            extend_unique(source_refs, _text_list(refs.get("source_refs")))
            extend_unique(
                missing_account_ids, _text_list(refs.get("missing_account_ids"))
            )
            for bucket_ref in _sequence(refs.get("runtime_ledger_buckets")):
                bucket_mapping = _mapping(bucket_ref)
                if bucket_mapping:
                    bucket_refs.append(bucket_mapping)

    if not account_ids and not account_keys and not transfer_ids:
        return {}
    return {
        "schema_version": "torghut.tigerbeetle-runtime-ledger-proof-refs.v1",
        "cluster_ids": cluster_ids,
        "account_count": len(account_ids),
        "transfer_count": len(transfer_ids),
        "account_ids": account_ids,
        "account_keys": account_keys,
        "transfer_ids": transfer_ids,
        "missing_account_ids": missing_account_ids,
        "source_refs": source_refs,
        "runtime_ledger_buckets": bucket_refs,
    }


def _runtime_import_target_blocker_codes(value: object) -> list[str]:
    blockers: list[str] = []
    for item in _sequence(value):
        if isinstance(item, Mapping):
            blocker = _text(item.get("blocker"))
        else:
            blocker = _text(item)
        if blocker:
            blockers.append(blocker)
    return blockers


def _runtime_import_proof_blocker_codes(value: object) -> list[str]:
    return [
        blocker
        for blocker in _runtime_import_target_blocker_codes(value)
        if blocker not in RUNTIME_IMPORT_MATERIALIZATION_PROMOTION_ONLY_BLOCKERS
    ]


def _is_runtime_import_materialization_blocker(blocker: str) -> bool:
    if blocker in RUNTIME_IMPORT_MATERIALIZATION_PROMOTION_ONLY_BLOCKERS:
        return False
    return (
        blocker.startswith("runtime_window_import_")
        or blocker in RUNTIME_IMPORT_MATERIALIZATION_STRUCTURAL_BLOCKERS
    )


def _runtime_import_materialization_blocker_codes(value: object) -> list[str]:
    return [
        blocker
        for blocker in _runtime_import_proof_blocker_codes(value)
        if _is_runtime_import_materialization_blocker(blocker)
    ]


_RUNTIME_LEDGER_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS = frozenset(
    {
        "execution_order_events",
        "source_execution_lifecycle",
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
_RUNTIME_LEDGER_NON_AUTHORITY_MATERIALIZATION_MARKERS = frozenset(
    {
        "aggregate_only",
        "artifact_only",
        "exact_replay",
        "replay_artifact",
        "simulation_source_replay_only",
    }
)


def _runtime_ledger_non_authority_marker_present(value: object) -> bool:
    text = _text(value)
    if text is None:
        return False
    normalized = text.lower().replace("-", "_")
    return any(
        marker in normalized
        for marker in _RUNTIME_LEDGER_NON_AUTHORITY_MATERIALIZATION_MARKERS
    )


def _runtime_ledger_readback_authority_markers_present(
    *,
    authority_classes: Sequence[str],
    authority_reasons: Sequence[str],
) -> bool:
    return (
        any(
            authority_class in _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS
            for authority_class in authority_classes
        )
        and any(
            authority_reason in _RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS
            for authority_reason in authority_reasons
        )
        and not any(
            _runtime_ledger_non_authority_marker_present(marker)
            for marker in [*authority_classes, *authority_reasons]
        )
    )


def _runtime_import_materialization_metadata_blockers(
    observation: Mapping[str, Any],
) -> list[str]:
    blockers = _runtime_import_materialization_blocker_codes(
        observation.get("runtime_ledger_target_metadata_blockers")
    )
    proof_count = max(
        _int(observation.get("runtime_ledger_tca_profit_proof_count")),
        _int(observation.get("runtime_ledger_source_bucket_profit_proof_count")),
        _int(observation.get("runtime_ledger_durable_bucket_profit_proof_count")),
        1 if _bool(observation.get("runtime_ledger_profit_proof_present")) else 0,
    )
    if proof_count <= 0:
        return blockers

    source_materialized_count = _int(
        observation.get("runtime_ledger_source_execution_materialized_bucket_count")
    )
    if source_materialized_count < proof_count:
        blockers.append(
            "runtime_window_import_source_execution_materialization_missing"
        )
    source_materializations = _text_list(
        observation.get("runtime_ledger_source_materializations")
    )
    if not any(
        materialization in _RUNTIME_LEDGER_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS
        for materialization in source_materializations
    ) or any(
        _runtime_ledger_non_authority_marker_present(materialization)
        for materialization in source_materializations
    ):
        blockers.append("runtime_window_import_source_materialization_missing")

    derivations = _text_list(
        observation.get("runtime_ledger_materialization_pnl_derivations")
    )
    authority_reasons = _text_list(
        observation.get("runtime_ledger_materialization_authority_reasons")
    )
    authority_reason = _text(observation.get("authority_reason"))
    if authority_reason is not None:
        authority_reasons.append(authority_reason)
    if any(
        _runtime_ledger_non_authority_marker_present(value)
        for value in [*derivations, *authority_reasons]
    ):
        blockers.append(
            "runtime_window_import_replay_or_artifact_derivation_not_authority"
        )
    return list(dict.fromkeys(blockers))


def _runtime_import_metadata_proof_blockers(
    observation: Mapping[str, Any],
) -> list[str]:
    blockers = _runtime_import_proof_blocker_codes(
        observation.get("runtime_ledger_target_metadata_blockers")
    )
    target_notional_sizing_required_count = _int(
        observation.get("paper_route_target_notional_sizing_required_count")
    )
    if target_notional_sizing_required_count > 0:
        target_notional_sizing_authoritative_count = _int(
            observation.get("paper_route_target_notional_sizing_authoritative_count")
        )
        target_notional_sizing_missing_count = _int(
            observation.get("paper_route_target_notional_sizing_missing_count")
        )
        target_notional_sizing_non_authoritative_count = _int(
            observation.get(
                "paper_route_target_notional_sizing_non_authoritative_count"
            )
        )
        if (
            target_notional_sizing_missing_count > 0
            or target_notional_sizing_authoritative_count
            < target_notional_sizing_required_count
        ):
            blockers.append("paper_route_target_notional_sizing_missing")
        if target_notional_sizing_non_authoritative_count > 0:
            blockers.append("paper_route_target_notional_sizing_not_authoritative")
    return list(dict.fromkeys(blockers))


def _runtime_import_readback_payload(
    *,
    summary: Mapping[str, Any],
    target: Mapping[str, Any],
) -> Mapping[str, Any]:
    nested = _mapping(target.get("readback"))
    if nested:
        return nested
    return _mapping(summary.get("runtime_window_import_readback"))


def _runtime_import_readback_blockers(
    *,
    target: Mapping[str, Any],
    readback: Mapping[str, Any],
    profit_proof_count: int,
) -> list[str]:
    if not readback:
        return ["runtime_window_import_readback_missing"]

    blockers: list[str] = []
    count_pairs = (
        (
            "metric_window_count",
            "runtime_window_import_metric_window_readback_mismatch",
        ),
        (
            "promotion_decision_count",
            "runtime_window_import_promotion_decision_readback_mismatch",
        ),
        (
            "runtime_ledger_bucket_count",
            "runtime_window_import_runtime_ledger_bucket_readback_mismatch",
        ),
        (
            "evidence_grade_runtime_ledger_bucket_count",
            "runtime_window_import_evidence_grade_runtime_ledger_bucket_readback_mismatch",
        ),
    )
    for key, blocker in count_pairs:
        if _int(target.get(key)) != _int(readback.get(key)):
            blockers.append(blocker)

    ref_pairs = (
        (
            "metric_window_ids",
            "metric_window_refs",
            "runtime_window_import_metric_window_refs_readback_mismatch",
        ),
        (
            "runtime_ledger_bucket_ids",
            "runtime_ledger_bucket_refs",
            "runtime_window_import_runtime_ledger_bucket_refs_readback_mismatch",
        ),
        (
            "evidence_grade_runtime_ledger_bucket_ids",
            "evidence_grade_runtime_ledger_bucket_refs",
            "runtime_window_import_evidence_grade_runtime_ledger_bucket_refs_readback_mismatch",
        ),
    )
    for target_key, readback_key, blocker in ref_pairs:
        target_refs = _text_list(target.get(target_key))
        readback_refs = _text_list(readback.get(readback_key))
        if len(readback_refs) < len(target_refs):
            blockers.append(blocker)
    if _text(target.get("promotion_decision_id")) and not _text_list(
        readback.get("promotion_decision_refs")
    ):
        blockers.append("runtime_window_import_promotion_decision_ref_readback_missing")
    if profit_proof_count > 0:
        if not _text_list(readback.get("source_refs")):
            blockers.append("runtime_window_import_readback_source_refs_missing")
            blockers.append("runtime_ledger_source_refs_missing")
        if not (
            _text_list(readback.get("runtime_ledger_source_window_ids"))
            or _text_list(readback.get("source_window_ids"))
        ):
            blockers.append("runtime_ledger_source_window_missing")
        if not (
            _text_list(readback.get("runtime_ledger_execution_order_event_ids"))
            or _text_list(readback.get("execution_order_event_ids"))
        ):
            blockers.append("runtime_ledger_execution_order_event_refs_missing")
        if not _text_list(readback.get("execution_ids")):
            blockers.append("runtime_ledger_execution_refs_missing")
        if not (
            _text_list(readback.get("runtime_ledger_execution_tca_metric_ids"))
            or _text_list(readback.get("execution_tca_metric_ids"))
        ):
            blockers.append("runtime_ledger_execution_tca_refs_missing")
            blockers.append("execution_tca_missing")
        if not _text_list(readback.get("trade_decision_ids")):
            blockers.append("runtime_ledger_trade_decision_refs_missing")
        if not _source_offsets(readback.get("source_offsets")):
            blockers.append("runtime_ledger_source_offsets_missing")
        if not _text_list(readback.get("source_materializations")):
            blockers.append("runtime_ledger_source_materialization_missing")
        authority_classes = _text_list(readback.get("authority_classes"))
        authority_reasons = _text_list(readback.get("authority_reasons"))
        if not _runtime_ledger_readback_authority_markers_present(
            authority_classes=authority_classes,
            authority_reasons=authority_reasons,
        ):
            blockers.append("runtime_ledger_authority_class_missing")
        cost_amount = _decimal(readback.get("runtime_ledger_cost_amount"))
        if cost_amount is None or (
            not _mapping(readback.get("cost_basis_counts"))
            and not _mapping(readback.get("runtime_ledger_cost_basis_counts"))
        ):
            blockers.append("runtime_ledger_explicit_costs_missing")
    return list(dict.fromkeys(blockers))


def _runtime_import_target_surface_blockers(
    *,
    summary: Mapping[str, Any],
    profit_proof_count: int,
) -> list[str]:
    target = _mapping(summary.get("runtime_materialization_target"))
    if not target:
        return ["runtime_window_import_materialization_target_missing"]
    blockers = _text_list(target.get("materialization_blockers"))
    if _int(target.get("metric_window_count")) <= 0:
        blockers.append("runtime_window_import_metric_window_missing")
    elif not _text_list(target.get("metric_window_ids")):
        blockers.append("runtime_window_import_metric_window_refs_missing")
    if _int(target.get("promotion_decision_count")) <= 0:
        blockers.append("runtime_window_import_promotion_decision_missing")
    elif not _text(target.get("promotion_decision_id")):
        blockers.append("runtime_window_import_promotion_decision_ref_missing")
    if profit_proof_count > 0:
        runtime_ledger_bucket_count = _int(target.get("runtime_ledger_bucket_count"))
        evidence_grade_runtime_ledger_bucket_count = _int(
            target.get("evidence_grade_runtime_ledger_bucket_count")
        )
        if runtime_ledger_bucket_count <= 0:
            blockers.append("runtime_window_import_runtime_ledger_bucket_missing")
        elif (
            len(_text_list(target.get("runtime_ledger_bucket_ids")))
            < runtime_ledger_bucket_count
        ):
            blockers.append("runtime_window_import_runtime_ledger_bucket_refs_missing")
        if evidence_grade_runtime_ledger_bucket_count <= 0:
            blockers.append(
                "runtime_window_import_evidence_grade_runtime_ledger_bucket_missing"
            )
        elif (
            len(_text_list(target.get("evidence_grade_runtime_ledger_bucket_ids")))
            < evidence_grade_runtime_ledger_bucket_count
        ):
            blockers.append(
                "runtime_window_import_evidence_grade_runtime_ledger_bucket_refs_missing"
            )
    if target.get("materialized") is False:
        blockers.extend(
            _runtime_import_materialization_blocker_codes(target.get("proof_blockers"))
        )
    blockers.extend(
        _runtime_import_readback_blockers(
            target=target,
            readback=_runtime_import_readback_payload(summary=summary, target=target),
            profit_proof_count=profit_proof_count,
        )
    )
    return list(dict.fromkeys(blockers))


def _runtime_import_materialization_summary(
    payload: Mapping[str, Any],
) -> dict[str, Any]:
    items = _runtime_window_import_items(payload)
    observations = _runtime_import_runtime_observations(payload)
    source_kinds: list[str] = []
    authority_reasons: list[str] = []
    pnl_derivations: list[str] = []
    materialization_blockers: list[str] = []
    profit_proof_blockers: list[str] = []
    materialized_targets: list[dict[str, Any]] = []
    unmaterialized_targets: list[dict[str, Any]] = []
    counts = {
        "declared_target_count": _int(payload.get("target_count"), len(items)),
        "import_item_count": len(items),
        "runtime_observation_count": len(observations),
        "authoritative_observation_count": 0,
        "materialized_target_count": 0,
        "unmaterialized_target_count": 0,
        "missing_target_import_count": 0,
        "authoritative_runtime_ledger_profit_proof_count": 0,
        "non_authoritative_runtime_ledger_profit_proof_count": 0,
        "runtime_ledger_profit_proof_count": 0,
        "runtime_ledger_tca_row_count": 0,
        "runtime_ledger_tca_runtime_bucket_row_count": 0,
        "runtime_ledger_tca_authoritative_bucket_count": 0,
        "runtime_ledger_source_execution_materialized_bucket_count": 0,
        "runtime_ledger_execution_reconstruction_bucket_count": 0,
        "runtime_ledger_source_bucket_profit_proof_count": 0,
        "runtime_ledger_durable_bucket_profit_proof_count": 0,
        "runtime_ledger_artifact_tca_row_count": 0,
        "paper_route_target_notional_sizing_required_count": 0,
        "paper_route_target_notional_sizing_authoritative_count": 0,
        "paper_route_target_notional_sizing_missing_count": 0,
        "paper_route_target_notional_sizing_non_authoritative_count": 0,
    }
    for item in items:
        summary = _mapping(item.get("summary"))
        observation = _mapping(summary.get("runtime_observation"))
        target_blockers: list[str] = []
        if not observation:
            target_blockers.append("runtime_window_import_runtime_observation_missing")
            unmaterialized_targets.append(
                _runtime_import_target_materialization_ref(
                    item=item,
                    observation={},
                    profit_proof_count=0,
                    materialized=False,
                    blockers=target_blockers,
                )
            )
            _extend_unique(materialization_blockers, target_blockers)
            continue
        if observation.get("authoritative") is True:
            counts["authoritative_observation_count"] += 1
        authority_reason = _text(observation.get("authority_reason"))
        tca_profit_proof_count = _int(
            observation.get("runtime_ledger_tca_profit_proof_count")
        )
        source_profit_proof_count = _int(
            observation.get("runtime_ledger_source_bucket_profit_proof_count")
        )
        durable_profit_proof_count = _int(
            observation.get("runtime_ledger_durable_bucket_profit_proof_count")
        )
        profit_proof_count = max(
            1 if _bool(observation.get("runtime_ledger_profit_proof_present")) else 0,
            tca_profit_proof_count,
            source_profit_proof_count,
            durable_profit_proof_count,
        )
        counts["runtime_ledger_profit_proof_count"] += profit_proof_count
        if observation.get("authoritative") is True:
            counts["authoritative_runtime_ledger_profit_proof_count"] += (
                profit_proof_count
            )
        else:
            counts["non_authoritative_runtime_ledger_profit_proof_count"] += (
                profit_proof_count
            )
        for key in (
            "runtime_ledger_tca_row_count",
            "runtime_ledger_tca_runtime_bucket_row_count",
            "runtime_ledger_tca_authoritative_bucket_count",
            "runtime_ledger_source_execution_materialized_bucket_count",
            "runtime_ledger_execution_reconstruction_bucket_count",
            "runtime_ledger_source_bucket_profit_proof_count",
            "runtime_ledger_durable_bucket_profit_proof_count",
            "runtime_ledger_artifact_tca_row_count",
            "paper_route_target_notional_sizing_required_count",
            "paper_route_target_notional_sizing_authoritative_count",
            "paper_route_target_notional_sizing_missing_count",
            "paper_route_target_notional_sizing_non_authoritative_count",
        ):
            counts[key] += _int(observation.get(key))
        if observation.get("authoritative") is not True:
            target_blockers.append(
                "runtime_window_import_observation_not_authoritative"
            )
        if profit_proof_count <= 0:
            target_blockers.append("runtime_window_import_target_profit_proof_missing")
        observation_proof_blockers = _runtime_import_proof_blocker_codes(
            observation.get("runtime_ledger_profit_proof_blockers")
        )
        _extend_unique(profit_proof_blockers, observation_proof_blockers)
        _extend_unique(
            target_blockers,
            _runtime_import_materialization_blocker_codes(
                observation.get("runtime_ledger_profit_proof_blockers")
            ),
        )
        _extend_unique(
            target_blockers,
            _runtime_import_target_surface_blockers(
                summary=summary,
                profit_proof_count=profit_proof_count,
            ),
        )
        _extend_unique(source_kinds, [_text(observation.get("source_kind"))])
        _extend_unique(authority_reasons, [authority_reason])
        _extend_unique(
            pnl_derivations,
            _text_list(
                observation.get("runtime_ledger_materialization_pnl_derivations")
            ),
        )
        _extend_unique(
            materialization_blockers,
            _text_list(observation.get("runtime_ledger_materialization_blockers")),
        )
        _extend_unique(
            profit_proof_blockers,
            observation_proof_blockers,
        )
        target = _mapping(summary.get("runtime_materialization_target"))
        _extend_unique(
            profit_proof_blockers,
            _runtime_import_proof_blocker_codes(target.get("proof_blockers")),
        )
        _extend_unique(
            profit_proof_blockers,
            _runtime_import_metadata_proof_blockers(observation),
        )
        _extend_unique(
            materialization_blockers,
            _runtime_import_materialization_metadata_blockers(observation),
        )
        materialized = (
            observation.get("authoritative") is True
            and profit_proof_count > 0
            and not target_blockers
        )
        target_ref = _runtime_import_target_materialization_ref(
            item=item,
            observation=observation,
            profit_proof_count=profit_proof_count,
            materialized=materialized,
            blockers=target_blockers,
        )
        if materialized:
            counts["materialized_target_count"] += 1
            materialized_targets.append(target_ref)
        else:
            unmaterialized_targets.append(target_ref)
            _extend_unique(materialization_blockers, target_blockers)
    counts["unmaterialized_target_count"] = len(unmaterialized_targets)
    counts["missing_target_import_count"] = max(
        0,
        counts["declared_target_count"] - counts["import_item_count"],
    )
    if counts["missing_target_import_count"] > 0:
        _extend_unique(
            materialization_blockers,
            ["runtime_window_import_target_count_mismatch"],
        )
    if unmaterialized_targets:
        _extend_unique(
            materialization_blockers,
            ["runtime_window_import_target_materialization_missing"],
        )
    if (
        counts["authoritative_runtime_ledger_profit_proof_count"] <= 0
        or counts["unmaterialized_target_count"] > 0
        or counts["missing_target_import_count"] > 0
    ):
        _extend_unique(
            materialization_blockers,
            ["runtime_window_import_runtime_ledger_materialization_missing"],
        )
    return {
        "schema_version": "torghut.runtime-window-import-materialization-summary.v1",
        **counts,
        "materialized_targets": materialized_targets,
        "unmaterialized_targets": unmaterialized_targets,
        "source_kinds": source_kinds,
        "authority_reasons": authority_reasons,
        "pnl_derivations": pnl_derivations,
        "blockers": materialization_blockers,
        "profit_proof_blockers": profit_proof_blockers,
    }


__all__ = (
    "_runtime_import_blockers",
    "_runtime_import_authoritative_observation_count",
    "_runtime_import_runtime_observations",
    "_runtime_import_target_materialization_ref",
    "_runtime_import_tigerbeetle_refs",
    "_runtime_import_target_blocker_codes",
    "_runtime_import_proof_blocker_codes",
    "_is_runtime_import_materialization_blocker",
    "_runtime_import_materialization_blocker_codes",
    "_RUNTIME_LEDGER_PROMOTION_GRADE_SOURCE_MATERIALIZATIONS",
    "_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS",
    "_RUNTIME_LEDGER_NON_AUTHORITY_MATERIALIZATION_MARKERS",
    "_runtime_ledger_non_authority_marker_present",
    "_runtime_ledger_readback_authority_markers_present",
    "_runtime_import_materialization_metadata_blockers",
    "_runtime_import_metadata_proof_blockers",
    "_runtime_import_readback_payload",
    "_runtime_import_readback_blockers",
    "_runtime_import_target_surface_blockers",
    "_runtime_import_materialization_summary",
)
