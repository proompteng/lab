"""Response projection for the Torghut trading health surface."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import cast

from app.config import settings
from app.trading.alpha_closure_dividend_slo import build_alpha_closure_dividend_slo
from app.trading.alpha_evidence_foundry import compact_alpha_evidence_foundry
from app.trading.alpha_readiness_settlement_conveyor import (
    compact_alpha_readiness_settlement_conveyor,
)
from app.trading.alpha_repair_closure_board import compact_alpha_repair_closure_board
from app.trading.alpha_repair_dividend_ledger import (
    compact_alpha_repair_dividend_ledger,
)
from app.trading.executable_alpha_receipts import (
    compact_executable_alpha_settlement_slots,
)
from app.trading.jangar_controller_ingestion_carry import (
    compact_jangar_controller_ingestion_carry,
)
from app.trading.no_delta_repair_reentry_auction import (
    compact_no_delta_repair_reentry_auction,
)
from app.trading.revenue_repair import build_revenue_repair_digest

from .readiness_surface import (
    guard_live_submission_gate_for_readiness,
    readiness_dependency_degradation_reason_codes,
    strip_promotion_authority_claims_for_readiness,
)
from .trading_health_context import TradingHealthContext
from .trading_health_dependencies import (
    runtime_dependencies_for_health_surface,
    split_runtime_and_proof_lane_dependencies,
)
from .trading_health_proof_lane import TradingHealthProofLane


@dataclass(frozen=True)
class TradingHealthResponseProjection:
    health_sections: dict[str, object]
    live_submission_gate: dict[str, object]
    revenue_repair_digest: dict[str, object]
    status: str


def build_trading_health_response(
    context: TradingHealthContext,
    proof_lane: TradingHealthProofLane,
) -> tuple[dict[str, object], int]:
    health_sections = split_runtime_and_proof_lane_dependencies(
        proof_lane.dependencies,
        scheduler_ok=context.scheduler_ok,
    )
    readiness_reasons = readiness_dependency_degradation_reason_codes(
        runtime_dependencies_for_health_surface(proof_lane.dependencies),
        scheduler_ok=context.scheduler_ok,
    )
    live_submission_gate = _guarded_live_submission_gate(
        proof_lane,
        readiness_dependency_reasons=readiness_reasons,
    )
    revenue_repair_digest = _revenue_repair_digest(
        context,
        proof_lane,
        live_submission_gate=live_submission_gate,
    )
    runtime_status = cast(Mapping[str, object], health_sections["runtime"])
    overall_ok = bool(runtime_status.get("ok"))
    projection = TradingHealthResponseProjection(
        health_sections=health_sections,
        live_submission_gate=live_submission_gate,
        revenue_repair_digest=revenue_repair_digest,
        status="ok" if overall_ok else "degraded",
    )
    response_payload = _response_payload(context, proof_lane, projection)
    if readiness_reasons:
        response_payload = cast(
            dict[str, object],
            strip_promotion_authority_claims_for_readiness(response_payload),
        )
    return response_payload, 200 if overall_ok else 503


def _guarded_live_submission_gate(
    proof_lane: TradingHealthProofLane,
    *,
    readiness_dependency_reasons: list[str],
) -> dict[str, object]:
    live_submission_gate = guard_live_submission_gate_for_readiness(
        _payload(proof_lane, "live_submission_gate"),
        readiness_dependency_reasons=readiness_dependency_reasons,
    )
    if bool(live_submission_gate.get("readiness_dependency_guard_active")):
        proof_lane.dependencies["live_submission_gate"] = {
            "ok": False,
            "detail": str(
                live_submission_gate.get("reason") or "readiness_dependency_degraded"
            ),
            "capital_stage": live_submission_gate.get("capital_stage"),
            "readiness_dependency_guard_active": True,
            "readiness_dependency_guard_reasons": readiness_dependency_reasons,
        }
    return dict(live_submission_gate)


def _revenue_repair_digest(
    context: TradingHealthContext,
    proof_lane: TradingHealthProofLane,
    *,
    live_submission_gate: Mapping[str, object],
) -> dict[str, object]:
    return build_revenue_repair_digest(
        readyz_payload={
            "status": (
                "degraded" if live_submission_gate.get("allowed") is not True else "ok"
            ),
            "proof_floor": _payload(proof_lane, "proof_floor"),
            "live_submission_gate": live_submission_gate,
            "quant_evidence": _payload(proof_lane, "quant_evidence"),
            "dependencies": proof_lane.dependencies,
        },
        status_payload={
            "mode": settings.trading_mode,
            "pipeline_mode": settings.trading_pipeline_mode,
            "build": _payload(proof_lane, "build_payload"),
            "dependency_quorum": proof_lane.dependency_quorum.as_payload(),
            "live_submission_gate": live_submission_gate,
            "proof_floor": _payload(proof_lane, "proof_floor"),
            "quant_evidence": _payload(proof_lane, "quant_evidence"),
            "routeability_repair_acceptance_ledger": _payload(
                proof_lane, "routeability_repair_acceptance_ledger"
            ),
            "route_evidence_clearinghouse_packet": _payload(
                proof_lane, "route_evidence_clearinghouse_packet"
            ),
            "repair_bid_settlement_ledger": _payload(
                proof_lane, "repair_bid_settlement_ledger"
            ),
            "capital_replay_board": _payload(
                proof_lane, "capital_replay_projection"
            ).get("capital_replay_board"),
            "executable_alpha_receipts": _payload(
                proof_lane, "capital_replay_projection"
            ).get("executable_alpha_receipts"),
            "controller_ingestion_settlement": proof_lane.dependency_quorum.as_payload().get(
                "controller_ingestion_settlement"
            ),
            "verify_trust_foreclosure_board": proof_lane.dependency_quorum.as_payload().get(
                "verify_trust_foreclosure_board"
            ),
            "repair_slot_escrow": proof_lane.dependency_quorum.as_payload().get(
                "repair_slot_escrow"
            ),
            "stage_debt_repair_admission": proof_lane.dependency_quorum.as_payload().get(
                "stage_debt_repair_admission"
            ),
            "foreclosure_carry_rollout_witness": proof_lane.dependency_quorum.as_payload().get(
                "foreclosure_carry_rollout_witness"
            ),
            "source_serving_repair_receipt_ledger": _payload(
                proof_lane, "source_serving_repair_receipt_ledger"
            ),
        },
        generated_at=context.observed_at,
    )


def _response_payload(
    context: TradingHealthContext,
    proof_lane: TradingHealthProofLane,
    projection: TradingHealthResponseProjection,
) -> dict[str, object]:
    payload = {
        "status": projection.status,
        "runtime": projection.health_sections["runtime"],
        "proof_lane": projection.health_sections["proof_lane"],
        "scheduler": context.scheduler_payload,
        "dependencies": proof_lane.dependencies,
        "alpha_readiness": proof_lane.alpha_readiness,
        "live_submission_gate": projection.live_submission_gate,
        "proof_floor": _payload(proof_lane, "proof_floor"),
        "renewal_bond_profit_escrow": _payload(
            proof_lane, "renewal_bond_profit_escrow"
        ),
        "capital_replay_board": _payload(proof_lane, "capital_replay_projection")[
            "capital_replay_board"
        ],
        "executable_alpha_receipts": _payload(proof_lane, "capital_replay_projection")[
            "executable_alpha_receipts"
        ],
        "quality_adjusted_profit_frontier": _payload(
            proof_lane, "quality_adjusted_profit_frontier"
        ),
        "torghut_consumer_evidence_receipt": _payload(
            proof_lane, "consumer_evidence_receipt"
        ),
        "route_proven_profit_receipt": _payload(
            proof_lane, "route_proven_profit_receipt"
        ),
        "consumer_evidence_canary": _payload(
            proof_lane, "route_proven_profit_receipt"
        ).get("route_canary"),
        "capital_reentry_cohort_ledger": _payload(
            proof_lane, "capital_reentry_cohort_ledger"
        ),
        "profit_repair_settlement_ledger": _payload(
            proof_lane, "profit_repair_settlement_ledger"
        ),
        "routeability_repair_acceptance_ledger": _payload(
            proof_lane, "routeability_repair_acceptance_ledger"
        ),
        "profit_freshness_frontier": _payload(proof_lane, "profit_freshness_frontier"),
        "profit_signal_quorum": _payload(proof_lane, "profit_signal_quorum"),
        "evidence_clock_arbiter": _payload(proof_lane, "evidence_clock_arbiter"),
        "routeable_profit_candidate_exchange": _payload(
            proof_lane, "routeable_profit_candidate_exchange"
        ),
        "clock_settlement_receipt": _payload(proof_lane, "clock_settlement_receipt"),
        "route_evidence_clearinghouse_packet": _payload(
            proof_lane, "route_evidence_clearinghouse_packet"
        ),
        "repair_bid_settlement_ledger": _payload(
            proof_lane, "repair_bid_settlement_ledger"
        ),
    }
    payload.update(
        _tail_payload(
            proof_lane,
            projection.revenue_repair_digest,
            projection.live_submission_gate,
        )
    )
    return payload


def _tail_payload(
    proof_lane: TradingHealthProofLane,
    revenue_repair_digest: dict[str, object],
    live_submission_gate: dict[str, object],
) -> dict[str, object]:
    route_receipt = _payload(proof_lane, "route_proven_profit_receipt")
    payload = dict(proof_lane.deps.revenue_repair_topline_fields(revenue_repair_digest))
    payload.update(
        {
            "route_warrant_exchange": _payload(proof_lane, "route_warrant_exchange"),
            "source_serving_repair_receipt_ledger": _payload(
                proof_lane, "source_serving_repair_receipt_ledger"
            ),
            "freshness_carry_ledger": _payload(proof_lane, "freshness_carry_ledger"),
            "repair_receipt_frontier": _payload(proof_lane, "repair_receipt_frontier"),
            "repair_outcome_dividend_ledger": _payload(
                proof_lane, "repair_outcome_dividend_ledger"
            ),
            "executable_alpha_settlement_slots": compact_executable_alpha_settlement_slots(
                _optional_payload(
                    revenue_repair_digest, "executable_alpha_settlement_slots"
                )
            ),
            "alpha_repair_closure_board": compact_alpha_repair_closure_board(
                _optional_payload(revenue_repair_digest, "alpha_repair_closure_board")
            ),
            "alpha_evidence_foundry": compact_alpha_evidence_foundry(
                _optional_payload(revenue_repair_digest, "alpha_evidence_foundry")
            ),
            "alpha_readiness_settlement_conveyor": compact_alpha_readiness_settlement_conveyor(
                _optional_payload(
                    revenue_repair_digest, "alpha_readiness_settlement_conveyor"
                )
            ),
            "alpha_repair_dividend_ledger": compact_alpha_repair_dividend_ledger(
                _optional_payload(revenue_repair_digest, "alpha_repair_dividend_ledger")
            ),
            "alpha_closure_dividend_slo": build_alpha_closure_dividend_slo(
                generated_at=datetime.now(timezone.utc),
                alpha_repair_closure_board=_optional_payload(
                    revenue_repair_digest, "alpha_repair_closure_board"
                ),
                alpha_repair_dividend_ledger=_optional_payload(
                    revenue_repair_digest, "alpha_repair_dividend_ledger"
                ),
            ),
            "jangar_controller_ingestion_carry": compact_jangar_controller_ingestion_carry(
                _optional_payload(
                    revenue_repair_digest, "jangar_controller_ingestion_carry"
                )
            ),
            "no_delta_repair_reentry_auction": compact_no_delta_repair_reentry_auction(
                _optional_payload(
                    revenue_repair_digest, "no_delta_repair_reentry_auction"
                )
            ),
            "route_reacquisition_book": _payload(proof_lane, "proof_floor").get(
                "route_reacquisition_book"
            ),
            "route_reacquisition_board": _payload(
                proof_lane, "route_reacquisition_board"
            ),
            "quant_evidence": _payload(proof_lane, "quant_evidence"),
            "profit_lease_projection": live_submission_gate.get(
                "profit_lease_projection"
            ),
            "route_proven_profit_receipt": route_receipt,
        }
    )
    return payload


def _payload(proof_lane: TradingHealthProofLane, key: str) -> dict[str, object]:
    return cast(dict[str, object], proof_lane.payloads[key])


def _optional_payload(
    payload: Mapping[str, object],
    key: str,
) -> Mapping[str, object] | None:
    value = payload.get(key)
    return (
        cast(Mapping[str, object] | None, value) if isinstance(value, Mapping) else None
    )


__all__ = ["build_trading_health_response"]
