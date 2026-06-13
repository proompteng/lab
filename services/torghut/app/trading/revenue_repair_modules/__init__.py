"""Revenue-repair digest helpers."""

from __future__ import annotations

from ..alpha_evidence_foundry import build_alpha_evidence_foundry
from ..alpha_readiness_settlement_conveyor import (
    build_alpha_readiness_settlement_conveyor,
)
from ..alpha_readiness_strike_ledger import build_alpha_readiness_strike_ledger
from ..alpha_repair_closure_board import build_alpha_repair_closure_board
from ..alpha_repair_dividend_ledger import build_alpha_repair_dividend_ledger
from ..executable_alpha_receipts import (
    build_executable_alpha_repair_receipts,
    build_executable_alpha_settlement_slots,
)
from ..jangar_controller_ingestion_carry import build_jangar_controller_ingestion_carry
from ..no_delta_repair_reentry_auction import build_no_delta_repair_reentry_auction
from .digest import (
    build_revenue_repair_digest,
    main,
    parse_args,
    parse_generated_at,
)
from .evidence_summaries import (
    business_state,
    build_topline_contract,
    field_unavailable_reason_codes,
    first_mapping_item,
    first_text,
    is_source_collection_target,
    jangar_material_evidence_settlement_ref,
    mapping_items,
    repair_bid_settlement_held_lot_ids,
    routeable_candidate_count_from_evidence,
    state_from_mapping,
    summarize_repair_bid_settlement,
    summarize_repair_outcome_dividend,
    summarize_route_evidence_clearinghouse,
    summarize_route_reacquisition,
    summarize_routeability_acceptance,
    summarize_runtime_window_import_repair,
    summarize_runtime_window_import_target,
    summarize_tca,
    top_repair_queue_item,
    validation_commands,
)
from .repair_queue import (
    NON_ACTIONABLE_DEPENDENCY_DETAILS,
    REPAIR_CATALOG,
    REPAIR_METADATA,
    SCHEMA_VERSION,
    bool_value,
    build_repair_queue,
    catalog,
    choose_mapping,
    collect_blocking_reasons,
    collect_reason_counts,
    dedupe_items,
    int_value,
    load_json_object,
    mapping_value,
    repair_from_ladder_item,
    repair_from_reason,
    repair_metadata,
    sequence_value,
    string_items,
    summarize_alpha,
    summarize_alpha_repair_targets,
    summarize_alpha_replay_items,
    summarize_executable_alpha_receipts,
    text_value,
)

_REPAIR_CATALOG = REPAIR_CATALOG
_REPAIR_METADATA = REPAIR_METADATA
_NON_ACTIONABLE_DEPENDENCY_DETAILS = NON_ACTIONABLE_DEPENDENCY_DETAILS
_catalog = catalog
_repair_metadata = repair_metadata
_text = text_value
_bool = bool_value
_int = int_value
_mapping = mapping_value
_sequence = sequence_value
_string_items = string_items
_dedupe = dedupe_items
_load_json_object = load_json_object
_choose_mapping = choose_mapping
_collect_reason_counts = collect_reason_counts
_collect_blocking_reasons = collect_blocking_reasons
_repair_from_ladder_item = repair_from_ladder_item
_repair_from_reason = repair_from_reason
_build_repair_queue = build_repair_queue
_summarize_alpha_replay_items = summarize_alpha_replay_items
_summarize_executable_alpha_receipts = summarize_executable_alpha_receipts
_summarize_alpha_repair_targets = summarize_alpha_repair_targets
_summarize_alpha = summarize_alpha
_summarize_tca = summarize_tca
_summarize_route_reacquisition = summarize_route_reacquisition
_mapping_items = mapping_items
_is_source_collection_target = is_source_collection_target
_summarize_runtime_window_import_target = summarize_runtime_window_import_target
_summarize_runtime_window_import_repair = summarize_runtime_window_import_repair
_summarize_routeability_acceptance = summarize_routeability_acceptance
_summarize_route_evidence_clearinghouse = summarize_route_evidence_clearinghouse
_summarize_repair_bid_settlement = summarize_repair_bid_settlement
_summarize_repair_outcome_dividend = summarize_repair_outcome_dividend
_first_mapping_item = first_mapping_item
_first_text = first_text
_top_repair_queue_item = top_repair_queue_item
_routeable_candidate_count_from_evidence = routeable_candidate_count_from_evidence
_repair_bid_settlement_held_lot_ids = repair_bid_settlement_held_lot_ids
_state_from_mapping = state_from_mapping
_jangar_material_evidence_settlement_ref = jangar_material_evidence_settlement_ref
_validation_commands = validation_commands
_field_unavailable_reason_codes = field_unavailable_reason_codes
_build_topline_contract = build_topline_contract
_business_state = business_state
_parse_generated_at = parse_generated_at
_parse_args = parse_args

__all__ = [
    "SCHEMA_VERSION",
    "REPAIR_CATALOG",
    "REPAIR_METADATA",
    "NON_ACTIONABLE_DEPENDENCY_DETAILS",
    "catalog",
    "repair_metadata",
    "text_value",
    "bool_value",
    "int_value",
    "mapping_value",
    "sequence_value",
    "string_items",
    "dedupe_items",
    "load_json_object",
    "choose_mapping",
    "collect_reason_counts",
    "collect_blocking_reasons",
    "repair_from_ladder_item",
    "repair_from_reason",
    "build_repair_queue",
    "summarize_alpha_replay_items",
    "summarize_executable_alpha_receipts",
    "summarize_alpha_repair_targets",
    "summarize_alpha",
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
    "build_alpha_readiness_strike_ledger",
    "build_alpha_evidence_foundry",
    "build_alpha_readiness_settlement_conveyor",
    "build_alpha_repair_dividend_ledger",
    "build_alpha_repair_closure_board",
    "build_executable_alpha_repair_receipts",
    "build_executable_alpha_settlement_slots",
    "build_jangar_controller_ingestion_carry",
    "build_no_delta_repair_reentry_auction",
    "build_revenue_repair_digest",
    "parse_generated_at",
    "parse_args",
    "main",
    "_REPAIR_CATALOG",
    "_REPAIR_METADATA",
    "_NON_ACTIONABLE_DEPENDENCY_DETAILS",
    "_catalog",
    "_repair_metadata",
    "_text",
    "_bool",
    "_int",
    "_mapping",
    "_sequence",
    "_string_items",
    "_dedupe",
    "_load_json_object",
    "_choose_mapping",
    "_collect_reason_counts",
    "_collect_blocking_reasons",
    "_repair_from_ladder_item",
    "_repair_from_reason",
    "_build_repair_queue",
    "_summarize_alpha_replay_items",
    "_summarize_executable_alpha_receipts",
    "_summarize_alpha_repair_targets",
    "_summarize_alpha",
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
    "_parse_generated_at",
    "_parse_args",
]
