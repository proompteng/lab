"""Public exports for app.trading.executable_alpha_receipts_modules."""

from __future__ import annotations

from importlib import import_module

_impl = import_module(f"{__name__}.part_04_candidate_replays")

CAPITAL_REPLAY_BOARD_SCHEMA_VERSION = getattr(
    _impl, "CAPITAL_REPLAY_BOARD_SCHEMA_VERSION"
)
EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION = getattr(
    _impl, "EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION"
)
EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION = getattr(
    _impl, "EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION"
)
EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION = getattr(
    _impl, "EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION"
)
EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION = getattr(
    _impl, "EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION"
)
EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION = getattr(
    _impl, "EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION"
)
EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION = getattr(
    _impl, "EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION"
)
_EXECUTABLE_ALPHA_REPAIR_DESIGN_REF = getattr(
    _impl, "_EXECUTABLE_ALPHA_REPAIR_DESIGN_REF"
)
_EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF = getattr(
    _impl, "_EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF"
)
_EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET = getattr(
    _impl, "_EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET"
)
_EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET = getattr(
    _impl, "_EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET"
)
_NO_DELTA_RELEASE_CONDITIONS = getattr(_impl, "_NO_DELTA_RELEASE_CONDITIONS")
GraduationState = getattr(_impl, "GraduationState")
_DEFAULT_FRESHNESS_SECONDS = getattr(_impl, "_DEFAULT_FRESHNESS_SECONDS")
_LIVE_AAPL_HYPOTHESIS = getattr(_impl, "_LIVE_AAPL_HYPOTHESIS")
_SIM_NVDA_HYPOTHESIS = getattr(_impl, "_SIM_NVDA_HYPOTHESIS")
_BREADTH_HYPOTHESIS = getattr(_impl, "_BREADTH_HYPOTHESIS")
_REPAIR_REASON_CLASSES = getattr(_impl, "_REPAIR_REASON_CLASSES")
_REPAIR_CLASS_RANK = getattr(_impl, "_REPAIR_CLASS_RANK")
_VALIDATION_COMMANDS_BY_CLASS = getattr(_impl, "_VALIDATION_COMMANDS_BY_CLASS")
_FEATURE_OR_DRIFT_REPAIR_REASONS = getattr(_impl, "_FEATURE_OR_DRIFT_REPAIR_REASONS")
_POST_COST_REPAIR_REASONS = getattr(_impl, "_POST_COST_REPAIR_REASONS")
_CLOSED_SESSION_REPAIR_REASONS = getattr(_impl, "_CLOSED_SESSION_REPAIR_REASONS")
_ALPHA_RUNTIME_REPLAY_CLASS = getattr(_impl, "_ALPHA_RUNTIME_REPLAY_CLASS")
_RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS = getattr(
    _impl, "_RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS"
)
_RUNTIME_LEDGER_PAPER_PROBATION_REASON = getattr(
    _impl, "_RUNTIME_LEDGER_PAPER_PROBATION_REASON"
)
_RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS = getattr(
    _impl, "_RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS"
)
_ZERO_RUNTIME_EVIDENCE_REASONS = getattr(_impl, "_ZERO_RUNTIME_EVIDENCE_REASONS")
_HARD_ALPHA_ECONOMIC_REASONS = getattr(_impl, "_HARD_ALPHA_ECONOMIC_REASONS")
_ALPHA_RUNTIME_REPAIR_REASONS = getattr(_impl, "_ALPHA_RUNTIME_REPAIR_REASONS")
_text = getattr(_impl, "_text")
_int = getattr(_impl, "_int")
_float = getattr(_impl, "_float")
_mapping = getattr(_impl, "_mapping")
_sequence = getattr(_impl, "_sequence")
_string_list = getattr(_impl, "_string_list")
_stable_hash = getattr(_impl, "_stable_hash")
_route_records = getattr(_impl, "_route_records")
_route_board_rows = getattr(_impl, "_route_board_rows")
_find_by_symbol = getattr(_impl, "_find_by_symbol")
_first_with_state = getattr(_impl, "_first_with_state")
_proof_window = getattr(_impl, "_proof_window")
_reason_list_from_target = getattr(_impl, "_reason_list_from_target")
_repair_class_for_target = getattr(_impl, "_repair_class_for_target")
_top_alpha_repair = getattr(_impl, "_top_alpha_repair")
_receipt_by_hypothesis = getattr(_impl, "_receipt_by_hypothesis")
_targets_from_alpha_readiness = getattr(_impl, "_targets_from_alpha_readiness")
_expected_gate_delta = getattr(_impl, "_expected_gate_delta")
_required_input_refs = getattr(_impl, "_required_input_refs")
_receipt_revenue_lane_rank = getattr(_impl, "_receipt_revenue_lane_rank")
_receipt_target_key = getattr(_impl, "_receipt_target_key")
_executable_alpha_repair_receipt = getattr(_impl, "_executable_alpha_repair_receipt")
build_executable_alpha_repair_receipts = getattr(
    _impl, "build_executable_alpha_repair_receipts"
)
_zero_notional = getattr(_impl, "_zero_notional")
_top_queue_item = getattr(_impl, "_top_queue_item")
_repair_receipt_reason_codes = getattr(_impl, "_repair_receipt_reason_codes")
_selected_repair_receipt = getattr(_impl, "_selected_repair_receipt")
_parse_datetime = getattr(_impl, "_parse_datetime")
_routeable_candidate_count_from_evidence = getattr(
    _impl, "_routeable_candidate_count_from_evidence"
)
_alpha_target_reason_codes = getattr(_impl, "_alpha_target_reason_codes")
_required_after_receipts = getattr(_impl, "_required_after_receipts")
_before_routeable_candidate_count = getattr(_impl, "_before_routeable_candidate_count")
_settlement_state = getattr(_impl, "_settlement_state")
_build_executable_alpha_settlement_slot = getattr(
    _impl, "_build_executable_alpha_settlement_slot"
)
_no_delta_debt_from_settlement_slot = getattr(
    _impl, "_no_delta_debt_from_settlement_slot"
)
_primary_remaining_blocker = getattr(_impl, "_primary_remaining_blocker")
build_executable_alpha_settlement_slots = getattr(
    _impl, "build_executable_alpha_settlement_slots"
)
compact_executable_alpha_settlement_slots = getattr(
    _impl, "compact_executable_alpha_settlement_slots"
)
_graduation_state = getattr(_impl, "_graduation_state")
_market_context_blockers = getattr(_impl, "_market_context_blockers")
_quant_blockers = getattr(_impl, "_quant_blockers")
_empirical_blockers = getattr(_impl, "_empirical_blockers")
_tca_guardrail_blockers = getattr(_impl, "_tca_guardrail_blockers")
_capital_blockers = getattr(_impl, "_capital_blockers")
_before_refs = getattr(_impl, "_before_refs")
_required_after_refs = getattr(_impl, "_required_after_refs")
_guardrails = getattr(_impl, "_guardrails")
_live_gate_evaluated_hypotheses = getattr(_impl, "_live_gate_evaluated_hypotheses")
_alpha_runtime_repair_reason_codes = getattr(
    _impl, "_alpha_runtime_repair_reason_codes"
)
_alpha_runtime_replay_key = getattr(_impl, "_alpha_runtime_replay_key")
_top_alpha_runtime_replay_target = getattr(_impl, "_top_alpha_runtime_replay_target")
_runtime_ledger_repair_candidates = getattr(_impl, "_runtime_ledger_repair_candidates")
_runtime_ledger_repair_key = getattr(_impl, "_runtime_ledger_repair_key")
_top_runtime_ledger_economic_repair_candidate = getattr(
    _impl, "_top_runtime_ledger_economic_repair_candidate"
)
_alpha_runtime_confidence = getattr(_impl, "_alpha_runtime_confidence")
_runtime_ledger_paper_probation_eligible = getattr(
    _impl, "_runtime_ledger_paper_probation_eligible"
)
_runtime_ledger_economic_repair_item = getattr(
    _impl, "_runtime_ledger_economic_repair_item"
)
_alpha_runtime_blockers = getattr(_impl, "_alpha_runtime_blockers")
_alpha_runtime_replay_item = getattr(_impl, "_alpha_runtime_replay_item")
_replay_item = getattr(_impl, "_replay_item")
_candidate_replays = getattr(_impl, "_candidate_replays")
_receipt_for_replay = getattr(_impl, "_receipt_for_replay")
build_capital_replay_projection = getattr(_impl, "build_capital_replay_projection")

__all__ = [
    "CAPITAL_REPLAY_BOARD_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_RECEIPTS_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOT_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_SCHEMA_VERSION",
    "EXECUTABLE_ALPHA_SETTLEMENT_SLOTS_REF_SCHEMA_VERSION",
    "_EXECUTABLE_ALPHA_REPAIR_DESIGN_REF",
    "_EXECUTABLE_ALPHA_SETTLEMENT_DESIGN_REF",
    "_EXECUTABLE_ALPHA_REPAIR_ROLLBACK_TARGET",
    "_EXECUTABLE_ALPHA_SETTLEMENT_ROLLBACK_TARGET",
    "_NO_DELTA_RELEASE_CONDITIONS",
    "GraduationState",
    "_DEFAULT_FRESHNESS_SECONDS",
    "_LIVE_AAPL_HYPOTHESIS",
    "_SIM_NVDA_HYPOTHESIS",
    "_BREADTH_HYPOTHESIS",
    "_REPAIR_REASON_CLASSES",
    "_REPAIR_CLASS_RANK",
    "_VALIDATION_COMMANDS_BY_CLASS",
    "_FEATURE_OR_DRIFT_REPAIR_REASONS",
    "_POST_COST_REPAIR_REASONS",
    "_CLOSED_SESSION_REPAIR_REASONS",
    "_ALPHA_RUNTIME_REPLAY_CLASS",
    "_RUNTIME_LEDGER_ECONOMIC_REPAIR_CLASS",
    "_RUNTIME_LEDGER_PAPER_PROBATION_REASON",
    "_RUNTIME_LEDGER_PAPER_PROBATION_ALLOWED_REASONS",
    "_ZERO_RUNTIME_EVIDENCE_REASONS",
    "_HARD_ALPHA_ECONOMIC_REASONS",
    "_ALPHA_RUNTIME_REPAIR_REASONS",
    "_text",
    "_int",
    "_float",
    "_mapping",
    "_sequence",
    "_string_list",
    "_stable_hash",
    "_route_records",
    "_route_board_rows",
    "_find_by_symbol",
    "_first_with_state",
    "_proof_window",
    "_reason_list_from_target",
    "_repair_class_for_target",
    "_top_alpha_repair",
    "_receipt_by_hypothesis",
    "_targets_from_alpha_readiness",
    "_expected_gate_delta",
    "_required_input_refs",
    "_receipt_revenue_lane_rank",
    "_receipt_target_key",
    "_executable_alpha_repair_receipt",
    "build_executable_alpha_repair_receipts",
    "_zero_notional",
    "_top_queue_item",
    "_repair_receipt_reason_codes",
    "_selected_repair_receipt",
    "_parse_datetime",
    "_routeable_candidate_count_from_evidence",
    "_alpha_target_reason_codes",
    "_required_after_receipts",
    "_before_routeable_candidate_count",
    "_settlement_state",
    "_build_executable_alpha_settlement_slot",
    "_no_delta_debt_from_settlement_slot",
    "_primary_remaining_blocker",
    "build_executable_alpha_settlement_slots",
    "compact_executable_alpha_settlement_slots",
    "_graduation_state",
    "_market_context_blockers",
    "_quant_blockers",
    "_empirical_blockers",
    "_tca_guardrail_blockers",
    "_capital_blockers",
    "_before_refs",
    "_required_after_refs",
    "_guardrails",
    "_live_gate_evaluated_hypotheses",
    "_alpha_runtime_repair_reason_codes",
    "_alpha_runtime_replay_key",
    "_top_alpha_runtime_replay_target",
    "_runtime_ledger_repair_candidates",
    "_runtime_ledger_repair_key",
    "_top_runtime_ledger_economic_repair_candidate",
    "_alpha_runtime_confidence",
    "_runtime_ledger_paper_probation_eligible",
    "_runtime_ledger_economic_repair_item",
    "_alpha_runtime_blockers",
    "_alpha_runtime_replay_item",
    "_replay_item",
    "_candidate_replays",
    "_receipt_for_replay",
    "build_capital_replay_projection",
]

del _impl
