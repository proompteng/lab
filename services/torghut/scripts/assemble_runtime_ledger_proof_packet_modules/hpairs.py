"""H-PAIRS census and small collection helpers for proof packet assembly."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from scripts.assemble_runtime_ledger_proof_packet_modules.common import (
    HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
    _mapping,
    _sequence,
    _text,
    _text_list,
)


def _hpairs_source_proof_census_status(
    census: Mapping[str, Any] | None,
) -> dict[str, Any]:
    payload = _mapping(census)
    if not payload:
        return {
            "schema_version": HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
            "present": False,
            "non_authority_status_only": True,
            "authority_source": False,
            "promotion_allowed": False,
            "final_authority_ok": False,
            "runtime_authority_final_ok": False,
            "census_ready": False,
            "blockers": [],
            "attachment_blockers": ["hpairs_source_proof_census_missing"],
            "blocker_ladder": [],
            "next_blocker": {
                "step": "hpairs_source_proof_census",
                "status": "missing",
                "blocker_codes": ["hpairs_source_proof_census_missing"],
                "next_action": "attach a fresh read-only H-PAIRS source-proof census artifact",
            },
        }
    verdict = _mapping(payload.get("verdict"))
    runtime_authority = _mapping(payload.get("runtime_authority"))
    blockers = _text_list(payload.get("blockers"))
    _extend_unique(blockers, _text_list(runtime_authority.get("blockers")))
    attachment_blockers = _hpairs_source_proof_census_attachment_blockers(payload)
    _extend_unique(blockers, attachment_blockers)
    next_blocker = _mapping(verdict.get("next_blocker"))
    runtime_authority_final_ok = bool(runtime_authority.get("final_authority_ok"))
    census_ready = bool(verdict.get("authority_candidate_ready")) and not blockers
    return {
        "schema_version": HPAIRS_SOURCE_PROOF_CENSUS_STATUS_SCHEMA_VERSION,
        "present": True,
        "non_authority_status_only": True,
        "authority_source": False,
        "source_schema_version": payload.get("schema_version"),
        "identity": dict(_mapping(payload.get("identity"))),
        "window": dict(_mapping(payload.get("window"))),
        "classification": verdict.get("classification"),
        "authority_candidate_ready": bool(verdict.get("authority_candidate_ready")),
        "promotion_allowed": False,
        "final_authority_ok": False,
        "runtime_authority_final_ok": runtime_authority_final_ok,
        "census_ready": census_ready,
        "blockers": blockers,
        "attachment_blockers": attachment_blockers,
        "missing_requirement_categories": dict(
            _mapping(payload.get("missing_requirement_categories"))
        ),
        "missing_source_ref_categories": dict(
            _mapping(payload.get("missing_source_ref_categories"))
        ),
        "blocker_ladder": list(_sequence(payload.get("blocker_ladder"))),
        "next_blocker": dict(next_blocker) if next_blocker else None,
        "next_action": verdict.get("next_action"),
        "totals": dict(_mapping(payload.get("totals"))),
    }


def _hpairs_source_proof_census_attachment_blockers(
    payload: Mapping[str, Any],
) -> list[str]:
    blockers: list[str] = []
    if _text(payload.get("schema_version")) != "torghut.hpairs-source-proof-census.v1":
        blockers.append("hpairs_source_proof_census_schema_mismatch")
    source = _mapping(payload.get("source"))
    if source.get("read_only") is not True:
        blockers.append("hpairs_source_proof_census_not_read_only")
    if source.get("writes_proof") is not False:
        blockers.append("hpairs_source_proof_census_writes_proof")
    if source.get("modifies_rows") is not False:
        blockers.append("hpairs_source_proof_census_modifies_rows")
    if source.get("replay_outputs_count_as_runtime_proof") is not False:
        blockers.append("hpairs_source_proof_census_replay_outputs_claim_runtime_proof")
    if source.get("synthetic_proof_created") is not False:
        blockers.append("hpairs_source_proof_census_synthetic_proof_created")
    return blockers


def _source_offsets(value: object) -> list[dict[str, object]]:
    raw_items: Sequence[object]
    if isinstance(value, Mapping):
        raw_items = [value]
    else:
        raw_items = _sequence(value)
    offsets: list[dict[str, object]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in raw_items:
        offset = _mapping(item)
        topic = _text(offset.get("topic"))
        partition = offset.get("partition")
        source_offset = offset.get("offset")
        if topic is None or partition is None or source_offset is None:
            continue
        key = (topic, str(partition), str(source_offset))
        if key in seen:
            continue
        offsets.append(
            {
                "topic": topic,
                "partition": partition,
                "offset": source_offset,
            }
        )
        seen.add(key)
    return offsets


def _extend_unique(items: list[str], additions: Sequence[str]) -> None:
    for item in additions:
        text = _text(item)
        if text and text not in items:
            items.append(text)


__all__ = (
    "_hpairs_source_proof_census_status",
    "_hpairs_source_proof_census_attachment_blockers",
    "_source_offsets",
    "_extend_unique",
)
