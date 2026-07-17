"""Deterministic order-level census across feed, broker, and execution evidence."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections import defaultdict
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Final, Sequence, TypeVar

from .order_lineage_receipts import (
    CLASSIFICATION_AMBIGUOUS,
    CLASSIFICATION_BROKER_ACTIVITY_ONLY,
    CLASSIFICATION_COMPLETE,
    CLASSIFICATION_EXTERNAL_OR_UNPROVED,
    CLASSIFICATION_LINKED_INCOMPLETE,
    CLASSIFICATION_ORDER_FEED_ONLY,
    CONFIDENCE_AMBIGUOUS,
    CONFIDENCE_EXACT,
    CONFIDENCE_UNPROVED,
    EXECUTION_SOURCE_CROSS_DSN,
    EXECUTION_SOURCE_LOCAL,
    EXECUTION_SOURCE_NONE,
    MATCH_BASIS_ALPACA_ORDER_ID,
    MATCH_BASIS_CLIENT_ORDER_ID,
    OrderLineageEvidence,
    OrderLineageReceiptDraft,
    build_order_lineage_receipt,
)


_FILL_ACTIVITY: Final = "FILL"
_FactT = TypeVar("_FactT")


@dataclass(frozen=True, slots=True)
class OrderEventFact:
    id: uuid.UUID
    event_fingerprint: str
    broker_order_id: str | None
    client_order_id: str | None
    event_at: datetime
    is_fill: bool
    execution_id: uuid.UUID | None
    trade_decision_id: uuid.UUID | None
    source_topic: str
    source_partition: int | None
    source_offset: int | None


@dataclass(frozen=True, slots=True)
class BrokerActivityFact:
    id: uuid.UUID
    external_activity_id: str
    activity_type: str
    broker_order_id: str | None
    client_order_id: str | None
    event_at: datetime


@dataclass(frozen=True, slots=True)
class ExecutionLineageFact:
    source: str
    execution_id: uuid.UUID
    broker_order_id: str
    client_order_id: str | None
    idempotency_key: str | None
    trade_decision_id: uuid.UUID | None
    strategy_id: uuid.UUID | None
    submission_claim_id: uuid.UUID | None
    tca_metric_id: uuid.UUID | None
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class OrderLineageCensusEvidence:
    provider: str
    environment: str
    account_label: str
    canonical_account_label_sha256: str
    order_events: Sequence[OrderEventFact]
    broker_activities: Sequence[BrokerActivityFact]
    local_executions: Sequence[ExecutionLineageFact]
    canonical_executions: Sequence[ExecutionLineageFact]


@dataclass(frozen=True, slots=True)
class OrderLineageCensusBuild:
    receipts: tuple[OrderLineageReceiptDraft, ...]
    broker_order_link_manifest: dict[str, object]
    order_feed_manifest: dict[str, object]
    execution_manifest: dict[str, object]


@dataclass(slots=True)
class _OrderGroup:
    broker_order_id: str | None
    client_order_ids: set[str] = field(default_factory=lambda: set[str]())
    identity_blockers: set[str] = field(default_factory=lambda: set[str]())
    order_events: list[OrderEventFact] = field(
        default_factory=lambda: list[OrderEventFact]()
    )
    broker_activities: list[BrokerActivityFact] = field(
        default_factory=lambda: list[BrokerActivityFact]()
    )


@dataclass(frozen=True, slots=True)
class _ExecutionResolution:
    candidate: ExecutionLineageFact | None
    ambiguous: bool
    match_basis: tuple[str, ...]
    blockers: tuple[str, ...]


class _ExecutionIndex:
    def __init__(self, rows: Sequence[ExecutionLineageFact]) -> None:
        self.by_id = {row.execution_id: row for row in rows}
        self.by_broker_order_id: dict[str, list[ExecutionLineageFact]] = defaultdict(
            list
        )
        self.by_client_identity: dict[str, list[ExecutionLineageFact]] = defaultdict(
            list
        )
        for row in rows:
            broker_order_id = _optional_text(row.broker_order_id)
            if broker_order_id is not None:
                self.by_broker_order_id[broker_order_id].append(row)
            for client_identity in {
                value
                for value in (
                    _optional_text(row.client_order_id),
                    _optional_text(row.idempotency_key),
                )
                if value is not None
            }:
                self.by_client_identity[client_identity].append(row)

    def stable_matches(self, group: _OrderGroup) -> list[ExecutionLineageFact]:
        matches: dict[uuid.UUID, ExecutionLineageFact] = {}
        if group.broker_order_id is not None:
            for row in self.by_broker_order_id.get(group.broker_order_id, ()):
                matches[row.execution_id] = row
        for client_order_id in group.client_order_ids:
            for row in self.by_client_identity.get(client_order_id, ()):
                matches[row.execution_id] = row
        return [matches[row_id] for row_id in sorted(matches, key=str)]


def build_order_lineage_census(
    evidence: OrderLineageCensusEvidence,
) -> OrderLineageCensusBuild:
    """Build one receipt for every retained feed or broker order identity."""

    normalized = _normalize_census_evidence(evidence)
    groups = _group_order_sources(
        normalized.order_events,
        normalized.broker_activities,
    )
    local_index = _ExecutionIndex(normalized.local_executions)
    canonical_index = _ExecutionIndex(normalized.canonical_executions)
    receipts = tuple(
        _build_group_receipt(
            group,
            evidence=normalized,
            local_index=local_index,
            canonical_index=canonical_index,
        )
        for _, group in sorted(groups.items())
    )
    return OrderLineageCensusBuild(
        receipts=receipts,
        broker_order_link_manifest=_broker_order_link_manifest(
            normalized.broker_activities
        ),
        order_feed_manifest=_order_feed_manifest(normalized.order_events),
        execution_manifest=_execution_manifest(normalized),
    )


def _normalize_census_evidence(
    evidence: OrderLineageCensusEvidence,
) -> OrderLineageCensusEvidence:
    canonical_scope_sha = evidence.canonical_account_label_sha256.strip().lower()
    if not _is_sha256(canonical_scope_sha):
        raise ValueError("order_lineage_canonical_scope_hash_invalid")
    events = _unique_facts(evidence.order_events, "order_event")
    activities = _unique_facts(evidence.broker_activities, "broker_activity")
    local_executions = _normalized_executions(
        evidence.local_executions,
        EXECUTION_SOURCE_LOCAL,
    )
    canonical_executions = _normalized_executions(
        evidence.canonical_executions,
        EXECUTION_SOURCE_CROSS_DSN,
    )
    return OrderLineageCensusEvidence(
        provider=_required_text(evidence.provider, "order_lineage_provider_missing"),
        environment=_required_text(
            evidence.environment,
            "order_lineage_environment_missing",
        ),
        account_label=_required_text(
            evidence.account_label,
            "order_lineage_account_label_missing",
        ),
        canonical_account_label_sha256=canonical_scope_sha,
        order_events=events,
        broker_activities=activities,
        local_executions=local_executions,
        canonical_executions=canonical_executions,
    )


def _unique_facts(
    rows: Sequence[_FactT],
    source: str,
) -> tuple[_FactT, ...]:
    by_id: dict[uuid.UUID, _FactT] = {}
    for row in rows:
        row_id = getattr(row, "id", None)
        if not isinstance(row_id, uuid.UUID):
            raise ValueError(f"order_lineage_{source}_id_invalid")
        if row_id in by_id:
            raise ValueError(f"order_lineage_{source}_duplicate")
        by_id[row_id] = row
    return tuple(by_id[row_id] for row_id in sorted(by_id, key=str))


def _normalized_executions(
    rows: Sequence[ExecutionLineageFact],
    expected_source: str,
) -> tuple[ExecutionLineageFact, ...]:
    by_id: dict[uuid.UUID, ExecutionLineageFact] = {}
    for row in rows:
        if row.source != expected_source:
            raise ValueError("order_lineage_execution_source_mismatch")
        if row.execution_id in by_id:
            raise ValueError("order_lineage_execution_duplicate")
        by_id[row.execution_id] = row
    return tuple(by_id[row_id] for row_id in sorted(by_id, key=str))


def _group_order_sources(
    events: Sequence[OrderEventFact],
    activities: Sequence[BrokerActivityFact],
) -> dict[str, _OrderGroup]:
    aliases = _client_broker_aliases(events, activities)
    groups: dict[str, _OrderGroup] = {}
    for event in events:
        group = _source_group(
            groups,
            aliases,
            event.broker_order_id,
            event.client_order_id,
        )
        group.order_events.append(event)
    for activity in activities:
        group = _source_group(
            groups,
            aliases,
            activity.broker_order_id,
            activity.client_order_id,
        )
        group.broker_activities.append(activity)
    return groups


def _client_broker_aliases(
    events: Sequence[OrderEventFact],
    activities: Sequence[BrokerActivityFact],
) -> dict[str, set[str]]:
    aliases: dict[str, set[str]] = defaultdict(set)
    for row in (*events, *activities):
        broker_order_id = _optional_text(row.broker_order_id)
        client_order_id = _optional_text(row.client_order_id)
        if broker_order_id is not None and client_order_id is not None:
            aliases[client_order_id].add(broker_order_id)
    return aliases


def _source_group(
    groups: dict[str, _OrderGroup],
    aliases: dict[str, set[str]],
    raw_broker_order_id: str | None,
    raw_client_order_id: str | None,
) -> _OrderGroup:
    broker_order_id = _optional_text(raw_broker_order_id)
    client_order_id = _optional_text(raw_client_order_id)
    if broker_order_id is None and client_order_id is not None:
        broker_aliases = aliases.get(client_order_id, set())
        if len(broker_aliases) == 1:
            broker_order_id = next(iter(broker_aliases))
    if broker_order_id is None and client_order_id is None:
        raise ValueError("order_lineage_source_order_identity_missing")
    key = (
        f"broker:{broker_order_id}"
        if broker_order_id is not None
        else f"client:{client_order_id}"
    )
    group = groups.setdefault(key, _OrderGroup(broker_order_id=broker_order_id))
    if client_order_id is not None:
        group.client_order_ids.add(client_order_id)
        if broker_order_id is None and len(aliases.get(client_order_id, set())) > 1:
            group.identity_blockers.add("client_order_alias_ambiguous")
    return group


def _build_group_receipt(
    group: _OrderGroup,
    *,
    evidence: OrderLineageCensusEvidence,
    local_index: _ExecutionIndex,
    canonical_index: _ExecutionIndex,
) -> OrderLineageReceiptDraft:
    resolution = _resolve_execution(group, local_index, canonical_index)
    blockers = set(resolution.blockers)
    if len(group.client_order_ids) > 1:
        blockers.add("client_order_identity_conflict")
    source_times = _source_times(group)
    fill_event_ids = tuple(event.id for event in group.order_events if event.is_fill)
    broker_fill_ids = tuple(
        activity.id
        for activity in group.broker_activities
        if activity.activity_type.upper() == _FILL_ACTIVITY
    )
    _add_source_blockers(
        blockers,
        group=group,
        fill_event_ids=fill_event_ids,
        broker_fill_ids=broker_fill_ids,
    )
    _add_link_blockers(blockers, resolution.candidate)
    classification = _classification(group, resolution, blockers)
    candidate = resolution.candidate if not resolution.ambiguous else None
    return build_order_lineage_receipt(
        OrderLineageEvidence(
            provider=evidence.provider,
            environment=evidence.environment,
            account_label=evidence.account_label,
            alpaca_order_id=group.broker_order_id,
            client_order_id=_single_client_order_id(group),
            classification=classification,
            confidence=_confidence(candidate, resolution),
            execution_source=(candidate.source if candidate else EXECUTION_SOURCE_NONE),
            canonical_execution_id=(candidate.execution_id if candidate else None),
            canonical_trade_decision_id=(
                candidate.trade_decision_id if candidate else None
            ),
            canonical_strategy_id=(candidate.strategy_id if candidate else None),
            canonical_submission_claim_id=(
                candidate.submission_claim_id if candidate else None
            ),
            canonical_tca_metric_id=(candidate.tca_metric_id if candidate else None),
            order_event_ids=tuple(event.id for event in group.order_events),
            fill_order_event_ids=fill_event_ids,
            broker_activity_ids=tuple(
                activity.id for activity in group.broker_activities
            ),
            broker_fill_activity_ids=broker_fill_ids,
            source_first_at=source_times[0],
            source_last_at=source_times[-1],
            match_basis=resolution.match_basis,
            blockers=tuple(sorted(blockers)),
        )
    )


def _resolve_execution(
    group: _OrderGroup,
    local_index: _ExecutionIndex,
    canonical_index: _ExecutionIndex,
) -> _ExecutionResolution:
    resolution = _resolve_execution_candidate(group, local_index, canonical_index)
    resolution = _project_consistent_links(resolution)
    return _validate_direct_decision_links(group, resolution)


def _resolve_execution_candidate(
    group: _OrderGroup,
    local_index: _ExecutionIndex,
    canonical_index: _ExecutionIndex,
) -> _ExecutionResolution:
    if group.identity_blockers:
        return _ambiguous_resolution(group, min(group.identity_blockers))
    direct_ids = {
        event.execution_id
        for event in group.order_events
        if event.execution_id is not None
    }
    if direct_ids:
        candidates = [
            candidate
            for row_id in direct_ids
            if (
                candidate := local_index.by_id.get(row_id)
                or canonical_index.by_id.get(row_id)
            )
            is not None
        ]
        if len(candidates) != 1 or len(candidates) != len(direct_ids):
            return _ambiguous_resolution(
                group,
                "direct_execution_identity_inconsistent",
            )
        return _exact_resolution(group, candidates[0])
    local_matches = local_index.stable_matches(group)
    if local_matches:
        return _matches_resolution(group, local_matches)
    canonical_matches = canonical_index.stable_matches(group)
    if canonical_matches:
        return _matches_resolution(group, canonical_matches)
    return _ExecutionResolution(
        candidate=None,
        ambiguous=False,
        match_basis=(),
        blockers=("canonical_execution_unproved",),
    )


def _project_consistent_links(
    resolution: _ExecutionResolution,
) -> _ExecutionResolution:
    candidate = resolution.candidate
    if candidate is None:
        return resolution
    blockers = set(resolution.blockers)
    if candidate.trade_decision_id is None:
        if candidate.strategy_id is not None:
            blockers.add("strategy_without_decision_unprojected")
        if candidate.submission_claim_id is not None:
            blockers.add("submission_claim_without_decision_unprojected")
        candidate = replace(
            candidate,
            strategy_id=None,
            submission_claim_id=None,
        )
    elif (
        candidate.submission_claim_id is not None
        and candidate.submission_claim_id != candidate.trade_decision_id
    ):
        blockers.add("submission_claim_identity_inconsistent")
        candidate = replace(candidate, submission_claim_id=None)
    return replace(
        resolution,
        candidate=candidate,
        blockers=tuple(sorted(blockers)),
    )


def _validate_direct_decision_links(
    group: _OrderGroup,
    resolution: _ExecutionResolution,
) -> _ExecutionResolution:
    direct_decision_ids = {
        event.trade_decision_id
        for event in group.order_events
        if event.trade_decision_id is not None
    }
    if not direct_decision_ids or resolution.ambiguous:
        return resolution
    if len(direct_decision_ids) != 1:
        return _ambiguous_resolution(
            group,
            "direct_decision_identity_inconsistent",
        )
    candidate = resolution.candidate
    if candidate is None:
        return _resolution_with_blocker(
            resolution,
            "direct_decision_without_execution",
        )
    direct_decision_id = next(iter(direct_decision_ids))
    if candidate.trade_decision_id is None:
        return _resolution_with_blocker(
            resolution,
            "direct_decision_link_unprojected",
        )
    if candidate.trade_decision_id != direct_decision_id:
        return _ambiguous_resolution(
            group,
            "direct_decision_identity_inconsistent",
        )
    return resolution


def _resolution_with_blocker(
    resolution: _ExecutionResolution,
    blocker: str,
) -> _ExecutionResolution:
    return replace(
        resolution,
        blockers=tuple(sorted({*resolution.blockers, blocker})),
    )


def _matches_resolution(
    group: _OrderGroup,
    matches: Sequence[ExecutionLineageFact],
) -> _ExecutionResolution:
    if len(matches) != 1:
        return _ambiguous_resolution(group, "ambiguous_execution_identity")
    return _exact_resolution(group, matches[0])


def _exact_resolution(
    group: _OrderGroup,
    candidate: ExecutionLineageFact,
) -> _ExecutionResolution:
    match_basis = _match_basis(group, candidate)
    if not match_basis:
        return _ExecutionResolution(
            candidate=None,
            ambiguous=False,
            match_basis=(),
            blockers=("direct_execution_order_identity_mismatch",),
        )
    return _ExecutionResolution(
        candidate=candidate,
        ambiguous=False,
        match_basis=match_basis,
        blockers=(),
    )


def _ambiguous_resolution(group: _OrderGroup, blocker: str) -> _ExecutionResolution:
    match_basis = tuple(
        basis
        for basis in (MATCH_BASIS_ALPACA_ORDER_ID, MATCH_BASIS_CLIENT_ORDER_ID)
        if (basis == MATCH_BASIS_ALPACA_ORDER_ID and group.broker_order_id is not None)
        or (basis == MATCH_BASIS_CLIENT_ORDER_ID and group.client_order_ids)
    )
    return _ExecutionResolution(
        candidate=None,
        ambiguous=True,
        match_basis=match_basis,
        blockers=(blocker,),
    )


def _match_basis(
    group: _OrderGroup,
    candidate: ExecutionLineageFact,
) -> tuple[str, ...]:
    bases: list[str] = []
    if group.broker_order_id is not None and group.broker_order_id == _optional_text(
        candidate.broker_order_id
    ):
        bases.append(MATCH_BASIS_ALPACA_ORDER_ID)
    candidate_clients = {
        value
        for value in (
            _optional_text(candidate.client_order_id),
            _optional_text(candidate.idempotency_key),
        )
        if value is not None
    }
    if group.client_order_ids.intersection(candidate_clients):
        bases.append(MATCH_BASIS_CLIENT_ORDER_ID)
    return tuple(bases)


def _add_source_blockers(
    blockers: set[str],
    *,
    group: _OrderGroup,
    fill_event_ids: Sequence[uuid.UUID],
    broker_fill_ids: Sequence[uuid.UUID],
) -> None:
    if not group.order_events:
        blockers.add("order_feed_missing")
    if not group.broker_activities:
        blockers.add("broker_activity_missing")
    if not fill_event_ids:
        blockers.add("fill_order_event_missing")
    if not broker_fill_ids:
        blockers.add("broker_fill_activity_missing")


def _add_link_blockers(
    blockers: set[str],
    candidate: ExecutionLineageFact | None,
) -> None:
    if candidate is None:
        return
    if candidate.trade_decision_id is None:
        blockers.add("trade_decision_missing")
    if candidate.strategy_id is None:
        blockers.add("strategy_missing")
    if candidate.submission_claim_id is None:
        blockers.add("submission_claim_missing")
    if candidate.tca_metric_id is None:
        blockers.add("tca_metric_missing")


def _classification(
    group: _OrderGroup,
    resolution: _ExecutionResolution,
    blockers: set[str],
) -> str:
    if resolution.ambiguous:
        return CLASSIFICATION_AMBIGUOUS
    if not group.order_events:
        return CLASSIFICATION_BROKER_ACTIVITY_ONLY
    if not group.broker_activities:
        return CLASSIFICATION_ORDER_FEED_ONLY
    if resolution.candidate is None:
        return CLASSIFICATION_EXTERNAL_OR_UNPROVED
    if not blockers:
        return CLASSIFICATION_COMPLETE
    return CLASSIFICATION_LINKED_INCOMPLETE


def _confidence(
    candidate: ExecutionLineageFact | None,
    resolution: _ExecutionResolution,
) -> str:
    if resolution.ambiguous:
        return CONFIDENCE_AMBIGUOUS
    return CONFIDENCE_EXACT if candidate is not None else CONFIDENCE_UNPROVED


def _single_client_order_id(group: _OrderGroup) -> str | None:
    if len(group.client_order_ids) != 1:
        return None
    return next(iter(group.client_order_ids))


def _source_times(group: _OrderGroup) -> tuple[datetime, ...]:
    values = [event.event_at for event in group.order_events]
    values.extend(activity.event_at for activity in group.broker_activities)
    return tuple(sorted(_required_utc(value) for value in values))


def _order_feed_manifest(events: Sequence[OrderEventFact]) -> dict[str, object]:
    payload = [
        {
            "broker_order_id": event.broker_order_id,
            "client_order_id": event.client_order_id,
            "event_at": _required_utc(event.event_at).isoformat(),
            "event_fingerprint": event.event_fingerprint,
            "execution_id": _uuid_text(event.execution_id),
            "id": str(event.id),
            "is_fill": event.is_fill,
            "source_offset": event.source_offset,
            "source_partition": event.source_partition,
            "source_topic": event.source_topic,
            "trade_decision_id": _uuid_text(event.trade_decision_id),
        }
        for event in events
    ]
    timestamps = tuple(_required_utc(event.event_at) for event in events)
    return {
        "event_count": len(events),
        "event_set_sha256": _canonical_sha256(payload),
        "first_event_at": min(timestamps).isoformat() if timestamps else None,
        "last_event_at": max(timestamps).isoformat() if timestamps else None,
        "partitions": _partition_manifest(events),
    }


def _partition_manifest(events: Sequence[OrderEventFact]) -> list[dict[str, object]]:
    offsets: dict[tuple[str, int], list[int]] = defaultdict(list)
    missing_offset_count = 0
    for event in events:
        if event.source_partition is None or event.source_offset is None:
            missing_offset_count += 1
            continue
        offsets[(event.source_topic, event.source_partition)].append(
            event.source_offset
        )
    rows: list[dict[str, object]] = []
    for (topic, partition), values in sorted(offsets.items()):
        rows.append(
            {
                "event_count": len(values),
                "max_offset": max(values),
                "min_offset": min(values),
                "partition": partition,
                "topic": topic,
            }
        )
    if missing_offset_count:
        rows.append({"missing_offset_count": missing_offset_count})
    return rows


def _broker_order_link_manifest(
    activities: Sequence[BrokerActivityFact],
) -> dict[str, object]:
    payload = [
        {
            "activity_type": activity.activity_type,
            "broker_order_id": activity.broker_order_id,
            "client_order_id": activity.client_order_id,
            "event_at": _required_utc(activity.event_at).isoformat(),
            "external_activity_id": activity.external_activity_id,
            "id": str(activity.id),
        }
        for activity in activities
    ]
    timestamps = tuple(_required_utc(activity.event_at) for activity in activities)
    return {
        "activity_count": len(activities),
        "activity_set_sha256": _canonical_sha256(payload),
        "fill_count": sum(
            activity.activity_type.upper() == _FILL_ACTIVITY for activity in activities
        ),
        "first_activity_at": min(timestamps).isoformat() if timestamps else None,
        "last_activity_at": max(timestamps).isoformat() if timestamps else None,
    }


def _execution_manifest(
    evidence: OrderLineageCensusEvidence,
) -> dict[str, object]:
    rows = (*evidence.local_executions, *evidence.canonical_executions)
    payload = [
        {
            "broker_order_id": row.broker_order_id,
            "client_order_id": row.client_order_id,
            "execution_id": str(row.execution_id),
            "idempotency_key": row.idempotency_key,
            "source": row.source,
            "strategy_id": _uuid_text(row.strategy_id),
            "submission_claim_id": _uuid_text(row.submission_claim_id),
            "tca_metric_id": _uuid_text(row.tca_metric_id),
            "trade_decision_id": _uuid_text(row.trade_decision_id),
            "updated_at": _required_utc(row.updated_at).isoformat(),
        }
        for row in sorted(
            rows, key=lambda value: (value.source, str(value.execution_id))
        )
    ]
    timestamps = tuple(_required_utc(row.updated_at) for row in rows)
    return {
        "canonical_account_label_sha256": (evidence.canonical_account_label_sha256),
        "canonical_execution_count": len(evidence.canonical_executions),
        "execution_set_sha256": _canonical_sha256(payload),
        "latest_updated_at": max(timestamps).isoformat() if timestamps else None,
        "local_execution_count": len(evidence.local_executions),
    }


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _canonical_sha256(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _required_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("order_lineage_timestamp_timezone_missing")
    return value.astimezone(timezone.utc)


def _required_text(value: object, error: str) -> str:
    normalized = str(value).strip() if value is not None else ""
    if not normalized:
        raise ValueError(error)
    return normalized


def _optional_text(value: object) -> str | None:
    normalized = str(value).strip() if value is not None else ""
    return normalized or None


def _is_sha256(value: str) -> bool:
    return len(value) == 64 and all(item in "0123456789abcdef" for item in value)


def _uuid_text(value: uuid.UUID | None) -> str | None:
    return str(value) if value is not None else None


__all__ = (
    "BrokerActivityFact",
    "ExecutionLineageFact",
    "OrderEventFact",
    "OrderLineageCensusBuild",
    "OrderLineageCensusEvidence",
    "build_order_lineage_census",
)
