"""Capital replay, repair, and freshness payload assembly."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from app.config import settings
from app.trading.capital_reentry_cohorts import build_capital_reentry_cohort_ledger
from app.trading.executable_alpha_receipts import build_capital_replay_projection
from app.trading.profit_carry_passports import build_profit_carry_passport_ledger
from app.trading.profit_freshness_frontier import build_profit_freshness_frontier
from app.trading.profit_repair_settlement import build_profit_repair_settlement_ledger
from app.trading.routeability_repair_acceptance import (
    build_routeability_repair_acceptance_ledger,
)

from .jangar_dependency_refs import (
    build_jangar_contract_graduation_ref,
    build_jangar_execution_trust_admission_ref,
    build_jangar_material_verdict_ref,
)
from .status_refs import (
    build_jangar_reliability_settlement_ref_payload,
    build_torghut_routeability_admission_ref,
)


def build_capital_replay_projection_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_capital_replay_projection(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        empirical_jobs_status=empirical_jobs_status,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        jangar_contract_graduation_ref=build_jangar_contract_graduation_ref(
            dependency_quorum
        ),
    )


def build_profit_carry_passport_ledger_payload(
    *,
    torghut_revision: str | None,
    capital_replay_board: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    repair_outcome_dividend_ledger: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_carry_passport_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        capital_replay_board=capital_replay_board,
        route_reacquisition_board=route_reacquisition_board,
        proof_floor=proof_floor,
        market_context_status=market_context_status,
        hypothesis_payload=hypothesis_payload,
        repair_outcome_dividend_ledger=repair_outcome_dividend_ledger,
    )


def build_capital_reentry_cohort_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
) -> dict[str, object]:
    return build_capital_reentry_cohort_ledger(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        route_reacquisition_board=route_reacquisition_board,
        jangar_material_verdict_ref=build_jangar_material_verdict_ref(
            dependency_quorum
        ),
    )


def build_profit_repair_settlement_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_repair_settlement_ledger(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        jangar_execution_trust_admission_ref=build_jangar_execution_trust_admission_ref(
            dependency_quorum
        ),
    )


def build_profit_freshness_frontier_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    routeability_repair_acceptance_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    empirical_jobs_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
) -> dict[str, object]:
    return build_profit_freshness_frontier(
        account_label=settings.trading_account_label,
        trading_mode=settings.trading_mode,
        proof_window=settings.trading_jangar_quant_window,
        torghut_revision=torghut_revision,
        proof_floor_receipt=proof_floor,
        routeability_repair_acceptance_ledger=routeability_repair_acceptance_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        empirical_jobs_status=empirical_jobs_status,
        hypothesis_payload=hypothesis_payload,
        jangar_reliability_settlement_ref=build_jangar_reliability_settlement_ref_payload(
            dependency_quorum
        ),
    )


def build_routeability_repair_acceptance_ledger_payload(
    *,
    torghut_revision: str | None,
    dependency_quorum: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    profit_repair_settlement_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
) -> dict[str, object]:
    return build_routeability_repair_acceptance_ledger(
        account_label=settings.trading_account_label,
        window=settings.trading_jangar_quant_window,
        trading_mode=settings.trading_mode,
        torghut_revision=torghut_revision,
        revenue_repair_digest_ref="/trading/revenue-repair",
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor,
        capital_reentry_cohort_ledger=capital_reentry_cohort_ledger,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
        profit_repair_settlement_ledger=profit_repair_settlement_ledger,
        route_reacquisition_board=route_reacquisition_board,
        live_submission_gate=live_submission_gate,
        quant_evidence=quant_evidence,
        market_context_status=market_context_status,
        torghut_routeability_admission_ref=build_torghut_routeability_admission_ref(
            dependency_quorum
        ),
    )


__all__ = (
    "build_capital_replay_projection_payload",
    "build_profit_carry_passport_ledger_payload",
    "build_capital_reentry_cohort_ledger_payload",
    "build_profit_repair_settlement_ledger_payload",
    "build_profit_freshness_frontier_payload",
    "build_routeability_repair_acceptance_ledger_payload",
)
