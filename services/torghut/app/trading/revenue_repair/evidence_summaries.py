"""Evidence summary helpers for revenue-repair digests."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence, cast

from ..promotion_authority import (
    capital_blocked_authority,
    target_capital_promotion_allowed,
    target_promotion_stage,
)
from .repair_queue import (
    bool_value,
    choose_mapping,
    dedupe_items,
    int_value,
    mapping_value,
    sequence_value,
    string_items,
    text_value,
)

_bool = bool_value
_choose_mapping = choose_mapping
_dedupe = dedupe_items
_int = int_value
_mapping = mapping_value
_sequence = sequence_value
_string_items = string_items
_text = text_value


@dataclass(frozen=True)
class ToplineContractInputs:
    status_payload: Mapping[str, Any]
    repair_queue: Sequence[Mapping[str, Any]]
    capital: Mapping[str, Any]
    evidence: Mapping[str, Any]
    repair_bid_settlement: Mapping[str, Any]
    alpha_evidence_foundry: Mapping[str, Any]
    alpha_readiness_settlement_conveyor: Mapping[str, Any]
    alpha_repair_dividend_ledger: Mapping[str, Any]
    no_delta_repair_reentry_auction: Mapping[str, Any]


def _summarize_tca(proof_floor: Mapping[str, Any]) -> dict[str, object]:
    for raw_dimension in _sequence(proof_floor.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) != "execution_tca":
            continue
        source_ref = _mapping(dimension.get("source_ref"))
        summary: dict[str, object] = {
            "state": _text(dimension.get("state"), "unknown"),
            "reason": _text(dimension.get("reason"), "unknown"),
            "order_count": _int(source_ref.get("order_count")),
            "last_computed_at": source_ref.get("last_computed_at"),
            "filled_execution_count": _int(source_ref.get("filled_execution_count")),
            "latest_execution_created_at": source_ref.get(
                "latest_execution_created_at"
            ),
            "unsettled_execution_count": _int(
                source_ref.get("unsettled_execution_count")
            ),
            "freshness_seconds": dimension.get("freshness_seconds"),
            "threshold_seconds": dimension.get("threshold_seconds"),
            "avg_abs_slippage_bps": source_ref.get("avg_abs_slippage_bps"),
            "slippage_guardrail_bps": source_ref.get("slippage_guardrail_bps"),
        }
        symbol_routes = _mapping(source_ref.get("symbol_routes"))
        if symbol_routes:
            summary["symbol_routes"] = symbol_routes
        aggregate_reason = _text(source_ref.get("aggregate_reason"))
        if aggregate_reason:
            summary["aggregate_reason"] = aggregate_reason
        return summary
    return {
        "state": "unknown",
        "reason": "missing",
        "order_count": 0,
        "last_computed_at": None,
        "freshness_seconds": None,
        "threshold_seconds": None,
        "avg_abs_slippage_bps": None,
    }


def _summarize_route_reacquisition(
    status_payload: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
) -> dict[str, object]:
    route_book = _choose_mapping(
        status_payload.get("route_reacquisition_book"),
        proof_floor.get("route_reacquisition_book"),
    )
    summary = _mapping(route_book.get("summary"))
    paper_route_probe = _mapping(route_book.get("paper_route_probe"))
    return {
        "schema_version": _text(route_book.get("schema_version"), "missing"),
        "state": _text(route_book.get("state"), "unknown"),
        "capital_rule": _text(route_book.get("capital_rule"), "unknown"),
        "routeable_symbol_count": _int(summary.get("routeable_symbol_count")),
        "probing_symbol_count": _int(summary.get("probing_symbol_count")),
        "blocked_symbol_count": _int(summary.get("blocked_symbol_count")),
        "missing_symbol_count": _int(summary.get("missing_symbol_count")),
        "candidate_symbols": _string_items(summary.get("candidate_symbols")),
        "repair_candidate_count": _int(summary.get("repair_candidate_count")),
        "repair_candidate_symbols": _string_items(
            summary.get("repair_candidate_symbols")
        ),
        "repair_candidates": [
            _mapping(item) for item in _sequence(summary.get("repair_candidates"))
        ],
        "paper_route_probe": {
            "configured_enabled": _bool(paper_route_probe.get("configured_enabled")),
            "configured_max_notional": _text(
                paper_route_probe.get("configured_max_notional"), "0"
            ),
            "active": _bool(paper_route_probe.get("active")),
            "effective_max_notional": _text(
                paper_route_probe.get("effective_max_notional"), "0"
            ),
            "next_session_max_notional": _text(
                paper_route_probe.get("next_session_max_notional"), "0"
            ),
            "eligible_symbol_count": _int(
                paper_route_probe.get("eligible_symbol_count")
            ),
            "eligible_symbols": _string_items(
                paper_route_probe.get("eligible_symbols")
            ),
            "active_symbols": _string_items(paper_route_probe.get("active_symbols")),
            "blocking_reasons": _string_items(
                paper_route_probe.get("blocking_reasons")
            ),
            "capital_authority": _text(
                paper_route_probe.get("capital_authority"), "none"
            ),
        },
        "paper_route_probe_eligible_symbols": _string_items(
            summary.get("paper_route_probe_eligible_symbols")
        ),
        "paper_route_probe_active_symbols": _string_items(
            summary.get("paper_route_probe_active_symbols")
        ),
        "expected_unblock_value": _int(summary.get("expected_unblock_value")),
    }


def _mapping_items(value: object) -> list[dict[str, Any]]:
    return [
        item for item in (_mapping(raw_item) for raw_item in _sequence(value)) if item
    ]


def _is_source_collection_target(target: Mapping[str, Any]) -> bool:
    return _bool(target.get("source_collection_authorized")) or (
        _text(target.get("source_kind")) == "runtime_ledger_source_collection_candidate"
    )


def _summarize_runtime_window_import_target(
    target: Mapping[str, Any],
) -> dict[str, object]:
    promotion_blockers = _string_items(
        target.get("promotion_blockers")
    ) or _string_items(target.get("final_promotion_blockers"))
    payload: dict[str, object] = {
        "hypothesis_id": _text(target.get("hypothesis_id")),
        "candidate_id": _text(target.get("candidate_id")),
        "strategy_family": _text(target.get("strategy_family")),
        "strategy_name": _text(
            target.get("strategy_name"), _text(target.get("runtime_strategy_name"))
        ),
        "account_label": _text(target.get("account_label")),
        "source_account_label": _text(target.get("source_account_label")),
        "source_kind": _text(target.get("source_kind")),
        "source_dsn_env": _text(target.get("source_dsn_env")),
        "target_dsn_env": _text(target.get("target_dsn_env")),
        "window_start": _text(target.get("window_start")),
        "window_end": _text(target.get("window_end")),
        "observed_stage": _text(target.get("observed_stage")),
        "source_collection_authorized": _is_source_collection_target(target),
        "source_collection_authorization_scope": _text(
            target.get("source_collection_authorization_scope")
        ),
        "paper_probation_authorized": _bool(target.get("paper_probation_authorized")),
        "evidence_collection_ok": _bool(target.get("evidence_collection_ok")),
        "handoff": _text(target.get("handoff")),
        "probation_reason": _text(target.get("probation_reason")),
        "max_notional": _text(target.get("max_notional"), "0"),
        "promotion_stage": target_promotion_stage(target).value,
        "capital_promotion_allowed": target_capital_promotion_allowed(target),
        "promotion_blockers": promotion_blockers,
        "promotion_allowed": _bool(target.get("promotion_allowed")),
        "final_promotion_allowed": _bool(target.get("final_promotion_allowed")),
        "final_promotion_authorized": _bool(target.get("final_promotion_authorized")),
        "legacy_promotion_allowed": _bool(target.get("promotion_allowed")),
        "legacy_final_promotion_allowed": _bool(target.get("final_promotion_allowed")),
        "legacy_final_promotion_authorized": _bool(
            target.get("final_promotion_authorized")
        ),
        "final_authority_ok": _bool(target.get("final_authority_ok")),
        "final_promotion_blockers": promotion_blockers,
        "candidate_blockers": _string_items(target.get("candidate_blockers")),
        "source_collection_reason_codes": _string_items(
            target.get("source_collection_reason_codes")
        ),
    }
    for key in (
        "dataset_snapshot_ref",
        "source_manifest_ref",
        "runtime_ledger_bucket_ref",
    ):
        value = _text(target.get(key))
        if value:
            payload[key] = value
    return payload


def _summarize_runtime_window_import_repair(
    live_submission_gate: Mapping[str, Any],
) -> dict[str, object]:
    plan = _mapping(
        live_submission_gate.get("runtime_ledger_paper_probation_import_plan")
    )
    blocked_reasons = _string_items(live_submission_gate.get("blocked_reasons"))
    if not plan:
        return {
            "schema_version": None,
            "status": "missing",
            "next_action": "wait_for_runtime_ledger_source_collection_plan",
            "target_count": 0,
            "paper_probation_target_count": 0,
            "source_collection_target_count": 0,
            "skipped_target_count": 0,
            "blocked_reasons": blocked_reasons,
            "top_targets": [],
            **capital_blocked_authority(
                blockers=["runtime_ledger_source_collection_plan_missing"],
            ).as_target_fields(),
        }

    raw_targets = _mapping_items(plan.get("targets"))
    source_targets = [
        target for target in raw_targets if _is_source_collection_target(target)
    ]
    paper_targets = [
        target
        for target in raw_targets
        if _bool(target.get("paper_probation_authorized"))
        and not _is_source_collection_target(target)
    ]
    skipped_targets = _mapping_items(plan.get("skipped_targets"))
    if source_targets:
        status = "source_collection_pending"
        next_action = "run_runtime_window_import_for_source_collection_targets"
    elif paper_targets:
        status = "paper_probation_import_pending"
        next_action = "run_runtime_window_import_for_paper_probation_targets"
    elif skipped_targets:
        status = "target_plan_repair_required"
        next_action = "repair_runtime_window_import_target_fields"
    else:
        status = "empty"
        next_action = "wait_for_runtime_window_import_candidates"

    prioritized_targets = [*source_targets, *paper_targets]
    if not prioritized_targets:
        prioritized_targets = raw_targets
    return {
        "schema_version": _text(plan.get("schema_version")) or None,
        "status": status,
        "next_action": next_action,
        "source": _text(plan.get("source")),
        "purpose": _text(plan.get("purpose")),
        "target_count": _int(plan.get("target_count"), len(raw_targets)),
        "paper_probation_target_count": _int(
            plan.get("paper_probation_target_count"), len(paper_targets)
        ),
        "source_collection_target_count": _int(
            plan.get("source_collection_target_count"), len(source_targets)
        ),
        "skipped_target_count": _int(
            plan.get("skipped_target_count"), len(skipped_targets)
        ),
        "blocked_reasons": blocked_reasons,
        "top_targets": [
            _summarize_runtime_window_import_target(target)
            for target in prioritized_targets[:5]
        ],
        "skipped_targets": [
            {
                "hypothesis_id": _text(target.get("hypothesis_id")),
                "candidate_id": _text(target.get("candidate_id")),
                "reason": _text(target.get("reason")),
                "missing_fields": _string_items(target.get("missing_fields")),
                "blockers": _string_items(target.get("blockers")),
            }
            for target in skipped_targets[:5]
        ],
        "diagnostic_reasons": ["runtime_window_import_required"],
        **capital_blocked_authority(
            blockers=[],
        ).as_target_fields(),
    }


def _summarize_routeability_acceptance(
    routeability_ledger: Mapping[str, Any],
) -> dict[str, object]:
    if not routeability_ledger:
        return {
            "ledger_id": None,
            "aggregate_state": "missing",
            "accepted_routeable_candidate_count": 0,
            "zero_notional_or_stale_evidence_rate": 1,
            "blocking_reason_codes": ["routeability_acceptance_ledger_missing"],
        }
    return {
        "ledger_id": routeability_ledger.get("ledger_id"),
        "aggregate_state": _text(routeability_ledger.get("aggregate_state"), "unknown"),
        "accepted_routeable_candidate_count": _int(
            routeability_ledger.get("accepted_routeable_candidate_count")
        ),
        "zero_notional_or_stale_evidence_rate": routeability_ledger.get(
            "zero_notional_or_stale_evidence_rate"
        ),
        "blocking_reason_codes": _string_items(
            routeability_ledger.get("aggregate_blocking_reason_codes")
        ),
    }


def _summarize_route_evidence_clearinghouse(
    clearinghouse_packet: Mapping[str, Any],
) -> dict[str, object]:
    selected_repair_bids = _sequence(clearinghouse_packet.get("selected_repair_bids"))
    return {
        "packet_id": clearinghouse_packet.get("packet_id"),
        "schema_version": clearinghouse_packet.get("schema_version"),
        "capital_decision": _text(
            clearinghouse_packet.get("capital_decision"), "missing"
        ),
        "accepted_routeable_candidate_count": _int(
            clearinghouse_packet.get("accepted_routeable_candidate_count")
        ),
        "zero_notional_or_stale_evidence_rate": clearinghouse_packet.get(
            "zero_notional_or_stale_evidence_rate", 1
        ),
        "selected_repair_bid_count": len(selected_repair_bids),
        "held_action_classes": _string_items(
            clearinghouse_packet.get("held_action_classes")
        )
        or ["paper_canary", "live_micro_canary", "live_scale"],
        "summary": _mapping(clearinghouse_packet.get("summary")),
    }


def _summarize_repair_bid_settlement(
    settlement_ledger: Mapping[str, Any],
) -> dict[str, object]:
    if not settlement_ledger:
        return {
            "ledger_id": None,
            "schema_version": None,
            "capital_decision": "missing",
            "raw_repair_bid_count": 0,
            "compacted_lot_count": 0,
            "selected_lot_count": 0,
            "dispatchable_lot_count": 0,
            "routeable_candidate_count": 0,
        }
    summary = _mapping(settlement_ledger.get("summary"))
    return {
        "ledger_id": settlement_ledger.get("ledger_id"),
        "schema_version": settlement_ledger.get("schema_version"),
        "capital_decision": _text(settlement_ledger.get("capital_decision"), "missing"),
        "raw_repair_bid_count": _int(settlement_ledger.get("raw_repair_bid_count")),
        "compacted_lot_count": _int(summary.get("compacted_lot_count")),
        "selected_lot_count": _int(summary.get("selected_lot_count")),
        "dispatchable_lot_count": _int(summary.get("dispatchable_lot_count")),
        "routeable_candidate_count": _int(
            settlement_ledger.get("routeable_candidate_count")
        ),
        "selected_lot_ids": _string_items(settlement_ledger.get("selected_lot_ids")),
        "dispatchable_lot_ids": _string_items(
            settlement_ledger.get("dispatchable_lot_ids")
        ),
    }


def _summarize_repair_outcome_dividend(
    repair_outcome_dividend_ledger: Mapping[str, Any],
) -> dict[str, object]:
    if not repair_outcome_dividend_ledger:
        return {
            "ledger_id": None,
            "schema_version": None,
            "open_escrow_count": 0,
            "no_delta_lot_count": 0,
            "routeable_candidate_count": 0,
            "max_notional": "0",
        }
    summary = _mapping(repair_outcome_dividend_ledger.get("summary"))
    return {
        "ledger_id": repair_outcome_dividend_ledger.get("ledger_id"),
        "schema_version": repair_outcome_dividend_ledger.get("schema_version"),
        "open_escrow_count": _int(summary.get("open_escrow_count")),
        "no_delta_lot_count": _int(summary.get("no_delta_lot_count")),
        "positive_dividend_count": _int(summary.get("positive_dividend_count")),
        "negative_dividend_count": _int(summary.get("negative_dividend_count")),
        "routeable_candidate_count": _int(summary.get("routeable_candidate_count")),
        "max_notional": _text(summary.get("max_notional"), "0"),
    }


def _first_mapping_item(value: object) -> dict[str, Any]:
    for raw_item in _sequence(value):
        item = _mapping(raw_item)
        if item:
            return item
    return {}


def _first_text(*values: object) -> str | None:
    for value in values:
        text = _text(value)
        if text:
            return text
    return None


def _top_repair_queue_item(repair_queue: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    for raw_item in repair_queue:
        item = _mapping(raw_item)
        if item:
            return dict(item)
    return {}


def _routeable_candidate_count_from_evidence(evidence: Mapping[str, Any]) -> int:
    routeability_acceptance = _mapping(evidence.get("routeability_acceptance"))
    route_evidence_clearinghouse = _mapping(
        evidence.get("route_evidence_clearinghouse")
    )
    repair_bid_settlement = _mapping(evidence.get("repair_bid_settlement"))
    return max(
        _int(routeability_acceptance.get("accepted_routeable_candidate_count")),
        _int(route_evidence_clearinghouse.get("accepted_routeable_candidate_count")),
        _int(repair_bid_settlement.get("routeable_candidate_count")),
    )


def _repair_bid_settlement_held_lot_ids(
    repair_bid_settlement: Mapping[str, Any],
) -> list[str]:
    held_lot_ids: list[str] = []
    for raw_lot in _sequence(repair_bid_settlement.get("compacted_lots")):
        lot = _mapping(raw_lot)
        lot_id = _text(lot.get("lot_id"))
        if not lot_id:
            continue
        lot_state = _text(lot.get("state")).lower()
        if lot_state == "held" or lot.get("dispatchable") is False:
            held_lot_ids.append(lot_id)
    if held_lot_ids:
        return _dedupe(held_lot_ids)

    selected = set(_string_items(repair_bid_settlement.get("selected_lot_ids")))
    dispatchable = set(_string_items(repair_bid_settlement.get("dispatchable_lot_ids")))
    return sorted(selected - dispatchable)


def _state_from_mapping(payload: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        text = _text(payload.get(key))
        if text:
            return text
    return None


def _jangar_material_evidence_settlement_ref(
    status_payload: Mapping[str, Any],
) -> object | None:
    dependency_quorum = _mapping(status_payload.get("dependency_quorum"))
    for source in (
        status_payload,
        dependency_quorum,
        _mapping(dependency_quorum.get("control_plane_status")),
    ):
        settlement = _mapping(source.get("material_evidence_settlement_spine"))
        if settlement:
            return (
                settlement.get("settlement_id")
                or settlement.get("spine_id")
                or settlement.get("id")
                or dict(settlement)
            )
    return None


def _validation_commands(
    *,
    top_item: Mapping[str, Any],
    no_delta_repair_reentry_auction: Mapping[str, Any],
) -> list[str]:
    selected_ticket = _mapping(no_delta_repair_reentry_auction.get("selected_ticket"))
    ticket_commands = _string_items(selected_ticket.get("validation_commands"))
    if ticket_commands:
        return ticket_commands
    if _text(top_item.get("code")) == "repair_alpha_readiness":
        return [
            "uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k revenue_repair",
            "uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py",
            "uv run --frozen pytest tests/test_consumer_evidence.py -k revenue",
        ]
    return [
        "uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k revenue_repair"
    ]


def _field_unavailable_reason_codes(fields: Mapping[str, object]) -> list[str]:
    reasons: list[str] = []
    for field_name, value in fields.items():
        if value is None:
            reasons.append(f"{field_name}_unavailable")
        elif isinstance(value, list) and not value:
            reasons.append(f"{field_name}_empty")
    return reasons


def _selected_topline_refs(
    inputs: ToplineContractInputs, top_item: Mapping[str, Any]
) -> dict[str, object]:
    first_foundry_receipt = _first_mapping_item(
        inputs.alpha_evidence_foundry.get("receipts")
    )
    selected_lane = _mapping(
        inputs.alpha_readiness_settlement_conveyor.get("selected_lane")
    )
    selected_target = _first_mapping_item(
        _mapping(inputs.evidence.get("alpha_readiness")).get("repair_targets")
    )
    return {
        "selected_hypothesis_id": _first_text(
            inputs.no_delta_repair_reentry_auction.get("selected_hypothesis_id"),
            inputs.alpha_repair_dividend_ledger.get("selected_hypothesis_id"),
            selected_lane.get("hypothesis_id"),
            first_foundry_receipt.get("hypothesis_id"),
            selected_target.get("hypothesis_id"),
        ),
        "selected_candidate_id": _first_text(
            first_foundry_receipt.get("candidate_id"),
            selected_lane.get("candidate_id"),
            selected_target.get("candidate_id"),
        ),
        "selected_strategy_id": _first_text(
            first_foundry_receipt.get("strategy_id"),
            selected_lane.get("strategy_id"),
            selected_target.get("strategy_id"),
        ),
        "selected_dataset_snapshot_ref": _first_text(
            first_foundry_receipt.get("dataset_snapshot_ref"),
            first_foundry_receipt.get("dataset_snapshot_id"),
            selected_lane.get("dataset_snapshot_ref"),
            selected_lane.get("dataset_snapshot_id"),
            inputs.alpha_repair_dividend_ledger.get("dataset_snapshot_ref"),
        ),
        "selected_value_gate": _first_text(
            inputs.no_delta_repair_reentry_auction.get("selected_value_gate"),
            inputs.alpha_evidence_foundry.get("selected_value_gate"),
            top_item.get("value_gate"),
        ),
        "required_output_receipt": _first_text(
            top_item.get("required_output_receipt"),
            inputs.no_delta_repair_reentry_auction.get("required_output_receipt"),
        ),
    }


def _routeable_counts(inputs: ToplineContractInputs) -> dict[str, int]:
    before = _int(
        inputs.no_delta_repair_reentry_auction.get("routeable_candidate_count_before"),
        _int(
            inputs.alpha_evidence_foundry.get("routeable_candidate_count_before"),
            _routeable_candidate_count_from_evidence(inputs.evidence),
        ),
    )
    after = _int(
        inputs.no_delta_repair_reentry_auction.get("routeable_candidate_count_after"),
        _int(
            inputs.alpha_readiness_settlement_conveyor.get(
                "routeable_candidate_count_after"
            ),
            _int(
                inputs.alpha_repair_dividend_ledger.get(
                    "routeable_candidate_count_after"
                ),
                before,
            ),
        ),
    )
    return {
        "routeable_candidate_count_before": before,
        "routeable_candidate_count_after": after,
        "accepted_routeable_candidate_count": _routeable_candidate_count_from_evidence(
            inputs.evidence
        ),
        "routeable_candidate_delta": after - before,
    }


def _market_state_refs(inputs: ToplineContractInputs) -> dict[str, object]:
    evidence_clock = _choose_mapping(
        inputs.status_payload.get("evidence_clock_arbiter"),
        inputs.status_payload.get("evidence_clock"),
    )
    required_custody = _mapping(evidence_clock.get("required_torghut_custody_ref"))
    route_warrant = _choose_mapping(
        inputs.status_payload.get("route_warrant_exchange"),
        inputs.status_payload.get("route_warrant"),
    )
    return {
        "evidence_clock_state": _state_from_mapping(
            evidence_clock, "capital_decision", "state", "status"
        ),
        "evidence_clock_custody_status": _state_from_mapping(
            required_custody, "decision", "state", "status"
        ),
        "route_warrant_state": _state_from_mapping(
            route_warrant, "warrant_state", "state", "status"
        ),
        "jangar_material_evidence_settlement_ref": (
            _jangar_material_evidence_settlement_ref(inputs.status_payload)
        ),
        "evidence_clock_arbiter": evidence_clock.get("arbiter_id"),
        "route_warrant_exchange": route_warrant.get("warrant_id"),
    }


def build_topline_contract(inputs: ToplineContractInputs) -> dict[str, object]:
    top_item = _top_repair_queue_item(inputs.repair_queue)
    selected_refs = _selected_topline_refs(inputs, top_item)
    route_counts = _routeable_counts(inputs)
    market_refs = _market_state_refs(inputs)
    runtime_window_import_repair = _mapping(
        inputs.evidence.get("runtime_window_import_repair")
    )
    top_line: dict[str, object] = {
        "capital_state": _text(inputs.capital.get("capital_state"), "unknown"),
        "capital_stage": _text(inputs.capital.get("capital_stage"), "unknown"),
        "live_submission_allowed": _bool(inputs.capital.get("live_submission_allowed")),
        "max_notional": _text(inputs.capital.get("max_notional"), "0"),
        "top_repair_queue_item": top_item or None,
        "required_receipts": _string_items(top_item.get("required_receipts")),
        **selected_refs,
        **route_counts,
        "alpha_no_delta_release_key": inputs.no_delta_repair_reentry_auction.get(
            "active_no_delta_release_key"
        ),
        "no_delta_reentry_decision": inputs.no_delta_repair_reentry_auction.get(
            "reentry_decision"
        ),
        "no_delta_reentry_reason_codes": _string_items(
            inputs.no_delta_repair_reentry_auction.get("reason_codes")
        ),
        "repair_bid_settlement_status": _first_text(
            inputs.repair_bid_settlement.get("status"),
            inputs.repair_bid_settlement.get("capital_decision"),
        ),
        "repair_bid_settlement_selected_lot_ids": _string_items(
            inputs.repair_bid_settlement.get("selected_lot_ids")
        ),
        "repair_bid_settlement_dispatchable_lot_ids": _string_items(
            inputs.repair_bid_settlement.get("dispatchable_lot_ids")
        ),
        "repair_bid_settlement_held_lot_ids": _repair_bid_settlement_held_lot_ids(
            inputs.repair_bid_settlement
        ),
        "runtime_window_import_repair_status": _text(
            runtime_window_import_repair.get("status"), "missing"
        ),
        "runtime_window_import_next_action": _text(
            runtime_window_import_repair.get("next_action"),
            "wait_for_runtime_ledger_source_collection_plan",
        ),
        "runtime_window_import_target_count": _int(
            runtime_window_import_repair.get("target_count")
        ),
        "runtime_window_import_source_collection_target_count": _int(
            runtime_window_import_repair.get("source_collection_target_count")
        ),
        "runtime_window_import_paper_probation_target_count": _int(
            runtime_window_import_repair.get("paper_probation_target_count")
        ),
        **market_refs,
        "validation_commands": _validation_commands(
            top_item=top_item,
            no_delta_repair_reentry_auction=inputs.no_delta_repair_reentry_auction,
        ),
        "rollback_target": _first_text(
            inputs.no_delta_repair_reentry_auction.get("rollback_target"),
            inputs.alpha_evidence_foundry.get("rollback_target"),
            "ignore revenue-repair top-line fields and keep Torghut max_notional=0",
        ),
    }
    top_line["field_unavailable_reason_codes"] = _field_unavailable_reason_codes(
        {
            "top_repair_queue_item": top_line["top_repair_queue_item"],
            "selected_value_gate": top_line["selected_value_gate"],
            "required_output_receipt": top_line["required_output_receipt"],
            "selected_hypothesis_id": top_line["selected_hypothesis_id"],
            "selected_candidate_id": top_line["selected_candidate_id"],
            "selected_strategy_id": top_line["selected_strategy_id"],
            "selected_dataset_snapshot_ref": top_line["selected_dataset_snapshot_ref"],
            "evidence_clock_state": top_line["evidence_clock_state"],
            "evidence_clock_custody_status": top_line["evidence_clock_custody_status"],
            "route_warrant_state": top_line["route_warrant_state"],
            "jangar_material_evidence_settlement_ref": top_line[
                "jangar_material_evidence_settlement_ref"
            ],
        }
    )
    top_line["transport_evidence_refs"] = {
        "route_evidence_clearinghouse_packet": _mapping(
            inputs.evidence.get("route_evidence_clearinghouse")
        ).get("packet_id"),
        "repair_bid_settlement_ledger": inputs.repair_bid_settlement.get("ledger_id"),
        "alpha_evidence_foundry": inputs.alpha_evidence_foundry.get("foundry_id"),
        "no_delta_repair_reentry_auction": inputs.no_delta_repair_reentry_auction.get(
            "auction_id"
        ),
        "evidence_clock_arbiter": market_refs["evidence_clock_arbiter"],
        "route_warrant_exchange": market_refs["route_warrant_exchange"],
    }
    top_line["producer_component"] = "services/torghut/app/trading/revenue_repair.py"
    top_line["expected_repair_action"] = _text(
        top_item.get("action"), "no_repair_queue_item_selected"
    )
    return top_line


def _build_topline_contract(**kwargs: object) -> dict[str, object]:
    return build_topline_contract(
        ToplineContractInputs(
            status_payload=cast(Mapping[str, Any], kwargs["status_payload"]),
            repair_queue=cast(Sequence[Mapping[str, Any]], kwargs["repair_queue"]),
            capital=cast(Mapping[str, Any], kwargs["capital"]),
            evidence=cast(Mapping[str, Any], kwargs["evidence"]),
            repair_bid_settlement=cast(
                Mapping[str, Any], kwargs["repair_bid_settlement"]
            ),
            alpha_evidence_foundry=cast(
                Mapping[str, Any], kwargs["alpha_evidence_foundry"]
            ),
            alpha_readiness_settlement_conveyor=cast(
                Mapping[str, Any], kwargs["alpha_readiness_settlement_conveyor"]
            ),
            alpha_repair_dividend_ledger=cast(
                Mapping[str, Any], kwargs["alpha_repair_dividend_ledger"]
            ),
            no_delta_repair_reentry_auction=cast(
                Mapping[str, Any], kwargs["no_delta_repair_reentry_auction"]
            ),
        )
    )


def _business_state(
    *,
    revenue_ready: bool,
    proof_floor: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
) -> str:
    if revenue_ready:
        return "revenue_candidate"
    route_state = _text(proof_floor.get("route_state"))
    capital_state = _text(proof_floor.get("capital_state"))
    gate_allowed = _bool(live_submission_gate.get("allowed"))
    if route_state == "repair_only" or capital_state == "zero_notional":
        return "repair_only"
    if not gate_allowed:
        return "capital_blocked"
    return "not_revenue_ready"


summarize_tca = _summarize_tca
summarize_route_reacquisition = _summarize_route_reacquisition
mapping_items = _mapping_items
is_source_collection_target = _is_source_collection_target
summarize_runtime_window_import_target = _summarize_runtime_window_import_target
summarize_runtime_window_import_repair = _summarize_runtime_window_import_repair
summarize_routeability_acceptance = _summarize_routeability_acceptance
summarize_route_evidence_clearinghouse = _summarize_route_evidence_clearinghouse
summarize_repair_bid_settlement = _summarize_repair_bid_settlement
summarize_repair_outcome_dividend = _summarize_repair_outcome_dividend
first_mapping_item = _first_mapping_item
first_text = _first_text
top_repair_queue_item = _top_repair_queue_item
routeable_candidate_count_from_evidence = _routeable_candidate_count_from_evidence
repair_bid_settlement_held_lot_ids = _repair_bid_settlement_held_lot_ids
state_from_mapping = _state_from_mapping
jangar_material_evidence_settlement_ref = _jangar_material_evidence_settlement_ref
validation_commands = _validation_commands
field_unavailable_reason_codes = _field_unavailable_reason_codes
business_state = _business_state

__all__ = [
    "summarize_tca",
    "summarize_route_reacquisition",
    "mapping_items",
    "is_source_collection_target",
    "summarize_runtime_window_import_target",
    "summarize_runtime_window_import_repair",
    "summarize_routeability_acceptance",
    "summarize_route_evidence_clearinghouse",
    "summarize_repair_bid_settlement",
    "summarize_repair_outcome_dividend",
    "first_mapping_item",
    "first_text",
    "top_repair_queue_item",
    "routeable_candidate_count_from_evidence",
    "repair_bid_settlement_held_lot_ids",
    "state_from_mapping",
    "jangar_material_evidence_settlement_ref",
    "validation_commands",
    "field_unavailable_reason_codes",
    "build_topline_contract",
    "business_state",
    "_summarize_tca",
    "_summarize_route_reacquisition",
    "_mapping_items",
    "_is_source_collection_target",
    "_summarize_runtime_window_import_target",
    "_summarize_runtime_window_import_repair",
    "_summarize_routeability_acceptance",
    "_summarize_route_evidence_clearinghouse",
    "_summarize_repair_bid_settlement",
    "_summarize_repair_outcome_dividend",
    "_first_mapping_item",
    "_first_text",
    "_top_repair_queue_item",
    "_routeable_candidate_count_from_evidence",
    "_repair_bid_settlement_held_lot_ids",
    "_state_from_mapping",
    "_jangar_material_evidence_settlement_ref",
    "_validation_commands",
    "_field_unavailable_reason_codes",
    "_build_topline_contract",
    "_business_state",
]
