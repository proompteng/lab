"""Revenue-repair digest assembly and CLI entrypoint."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from ..alpha_readiness_strike_ledger import build_alpha_readiness_strike_ledger
from ..alpha_evidence_foundry import build_alpha_evidence_foundry
from ..alpha_readiness_settlement_conveyor import (
    build_alpha_readiness_settlement_conveyor,
)
from ..alpha_repair_dividend_ledger import build_alpha_repair_dividend_ledger
from ..alpha_repair_closure_board import build_alpha_repair_closure_board
from ..executable_alpha_receipts import (
    build_executable_alpha_repair_receipts,
    build_executable_alpha_settlement_slots,
)
from ..jangar_controller_ingestion_carry import (
    build_jangar_controller_ingestion_carry,
)
from ..no_delta_repair_reentry_auction import (
    build_no_delta_repair_reentry_auction,
)

from .evidence_summaries import (
    ToplineContractInputs,
    build_topline_contract,
    business_state,
    summarize_repair_bid_settlement,
    summarize_repair_outcome_dividend,
    summarize_route_evidence_clearinghouse,
    summarize_route_reacquisition,
    summarize_routeability_acceptance,
    summarize_runtime_window_import_repair,
    summarize_tca,
)
from .repair_queue import (
    SCHEMA_VERSION,
    bool_value,
    build_repair_queue,
    choose_mapping,
    collect_blocking_reasons,
    collect_reason_counts,
    int_value,
    load_json_object,
    mapping_value,
    string_items,
    summarize_alpha,
    text_value,
)

_business_state = business_state
_build_topline_contract = build_topline_contract
_summarize_repair_bid_settlement = summarize_repair_bid_settlement
_summarize_repair_outcome_dividend = summarize_repair_outcome_dividend
_summarize_route_evidence_clearinghouse = summarize_route_evidence_clearinghouse
_summarize_route_reacquisition = summarize_route_reacquisition
_summarize_routeability_acceptance = summarize_routeability_acceptance
_summarize_runtime_window_import_repair = summarize_runtime_window_import_repair
_summarize_tca = summarize_tca
_bool = bool_value
_build_repair_queue = build_repair_queue
_choose_mapping = choose_mapping
_collect_blocking_reasons = collect_blocking_reasons
_collect_reason_counts = collect_reason_counts
_int = int_value
_load_json_object = load_json_object
_mapping = mapping_value
_string_items = string_items
_summarize_alpha = summarize_alpha
_text = text_value


@dataclass(frozen=True)
class RevenueRepairInputs:
    readyz_payload: Mapping[str, Any]
    status_payload: Mapping[str, Any]
    proof_floor: Mapping[str, Any]
    live_submission_gate: Mapping[str, Any]
    quant_evidence: Mapping[str, Any]
    routeability_ledger: Mapping[str, Any]
    route_evidence_clearinghouse: Mapping[str, Any]
    repair_bid_settlement: Mapping[str, Any]
    repair_outcome_dividend: Mapping[str, Any]
    db_check: Mapping[str, Any]
    dependencies: Mapping[str, Any]
    blocking_reasons: Sequence[str]
    repair_queue: Sequence[Mapping[str, Any]]
    build: Mapping[str, Any]


@dataclass(frozen=True)
class RevenueRepairState:
    readyz_status: str
    readiness_ok: bool
    revenue_ready: bool
    business_state: str
    alpha: Mapping[str, Any]
    capital: Mapping[str, Any]
    evidence: Mapping[str, Any]


@dataclass(frozen=True)
class RevenueRepairArtifacts:
    alpha_readiness_strike_ledger: Mapping[str, Any]
    executable_alpha_repair_receipts: Mapping[str, Any]
    executable_alpha_settlement_slots: Mapping[str, Any]
    alpha_repair_closure_board: Mapping[str, Any]
    alpha_evidence_foundry: Mapping[str, Any]
    alpha_readiness_settlement_conveyor: Mapping[str, Any]
    alpha_repair_dividend_ledger: Mapping[str, Any]
    jangar_controller_ingestion_carry: Mapping[str, Any]
    no_delta_repair_reentry_auction: Mapping[str, Any]


def _normalize_generated_at(generated_at: datetime | None) -> datetime:
    generated = generated_at or datetime.now(timezone.utc)
    if generated.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    return generated.astimezone(timezone.utc)


def _build_inputs(
    *, readyz_payload: Mapping[str, Any], status_payload: Mapping[str, Any]
) -> RevenueRepairInputs:
    proof_floor = _choose_mapping(
        status_payload.get("proof_floor"), readyz_payload.get("proof_floor")
    )
    live_submission_gate = _choose_mapping(
        status_payload.get("live_submission_gate"),
        readyz_payload.get("live_submission_gate"),
    )
    blocking_reasons = _collect_blocking_reasons(readyz_payload, status_payload)
    return RevenueRepairInputs(
        readyz_payload=readyz_payload,
        status_payload=status_payload,
        proof_floor=proof_floor,
        live_submission_gate=live_submission_gate,
        quant_evidence=_choose_mapping(
            status_payload.get("quant_evidence"), readyz_payload.get("quant_evidence")
        ),
        routeability_ledger=_choose_mapping(
            status_payload.get("routeability_repair_acceptance_ledger"),
            readyz_payload.get("routeability_repair_acceptance_ledger"),
        ),
        route_evidence_clearinghouse=_choose_mapping(
            status_payload.get("route_evidence_clearinghouse_packet"),
            readyz_payload.get("route_evidence_clearinghouse_packet"),
        ),
        repair_bid_settlement=_choose_mapping(
            status_payload.get("repair_bid_settlement_ledger"),
            readyz_payload.get("repair_bid_settlement_ledger"),
        ),
        repair_outcome_dividend=_choose_mapping(
            status_payload.get("repair_outcome_dividend_ledger"),
            readyz_payload.get("repair_outcome_dividend_ledger"),
        ),
        db_check=_choose_mapping(
            status_payload.get("db_check"),
            status_payload.get("database_contract"),
            _mapping(_mapping(readyz_payload.get("dependencies")).get("database")),
            _mapping(
                _mapping(readyz_payload.get("dependencies")).get("database_contract")
            ),
        ),
        dependencies=_mapping(readyz_payload.get("dependencies")),
        blocking_reasons=blocking_reasons,
        repair_queue=cast(
            Sequence[Mapping[str, Any]],
            _build_repair_queue(proof_floor, status_payload, blocking_reasons),
        ),
        build=_mapping(status_payload.get("build")),
    )


def _build_capital(inputs: RevenueRepairInputs) -> dict[str, object]:
    return {
        "live_submission_allowed": _bool(inputs.live_submission_gate.get("allowed")),
        "live_submission_reason": _text(
            inputs.live_submission_gate.get("reason"), "unknown"
        ),
        "configured_live_promotion": _bool(
            inputs.live_submission_gate.get("configured_live_promotion")
        ),
        "capital_stage": _text(
            inputs.live_submission_gate.get("capital_stage"), "unknown"
        ),
        "proof_floor_state": _text(inputs.proof_floor.get("floor_state"), "unknown"),
        "route_state": _text(inputs.proof_floor.get("route_state"), "unknown"),
        "capital_state": _text(inputs.proof_floor.get("capital_state"), "unknown"),
        "max_notional": _text(inputs.proof_floor.get("max_notional"), "0"),
    }


def _is_revenue_ready(
    *,
    inputs: RevenueRepairInputs,
    alpha: Mapping[str, Any],
    readiness_ok: bool,
    capital: Mapping[str, Any],
) -> bool:
    return (
        readiness_ok
        and _bool(capital.get("live_submission_allowed"))
        and _text(capital.get("route_state")) not in {"repair_only", "unknown"}
        and _text(capital.get("capital_state")) not in {"zero_notional", "unknown"}
        and _text(capital.get("max_notional"), "0") not in {"0", "0.0", "0.00"}
        and _int(alpha.get("promotion_eligible_total")) > 0
        and not inputs.blocking_reasons
    )


def _build_evidence(
    *,
    inputs: RevenueRepairInputs,
    alpha: Mapping[str, Any],
    runtime_window_import_repair: Mapping[str, Any],
) -> dict[str, object]:
    return {
        "alpha_readiness": alpha,
        "quant_evidence": {
            "ok": _bool(inputs.quant_evidence.get("ok"), default=True),
            "status": _text(inputs.quant_evidence.get("status"), "unknown"),
            "reason": _text(inputs.quant_evidence.get("reason"), "unknown"),
            "max_stage_lag_seconds": inputs.quant_evidence.get("max_stage_lag_seconds"),
            "blocking_reasons": _string_items(
                inputs.quant_evidence.get("blocking_reasons")
            ),
        },
        "execution_tca": _summarize_tca(inputs.proof_floor),
        "route_reacquisition": _summarize_route_reacquisition(
            inputs.status_payload, inputs.proof_floor
        ),
        "routeability_acceptance": _summarize_routeability_acceptance(
            inputs.routeability_ledger
        ),
        "route_evidence_clearinghouse": _summarize_route_evidence_clearinghouse(
            inputs.route_evidence_clearinghouse
        ),
        "repair_bid_settlement": _summarize_repair_bid_settlement(
            inputs.repair_bid_settlement
        ),
        "repair_outcome_dividend": _summarize_repair_outcome_dividend(
            inputs.repair_outcome_dividend
        ),
        "runtime_window_import_repair": runtime_window_import_repair,
        "simple_lane_reject_reason_totals": _collect_reason_counts(
            inputs.status_payload
        ),
    }


def _build_state(inputs: RevenueRepairInputs) -> RevenueRepairState:
    readyz_status = _text(inputs.readyz_payload.get("status"), "unknown")
    readiness_ok = readyz_status in {"ok", "healthy"}
    alpha = _summarize_alpha(inputs.status_payload, inputs.proof_floor)
    capital = _build_capital(inputs)
    runtime_window_import_repair = _summarize_runtime_window_import_repair(
        inputs.live_submission_gate
    )
    revenue_ready = _is_revenue_ready(
        inputs=inputs, alpha=alpha, readiness_ok=readiness_ok, capital=capital
    )
    return RevenueRepairState(
        readyz_status=readyz_status,
        readiness_ok=readiness_ok,
        revenue_ready=revenue_ready,
        business_state=_business_state(
            revenue_ready=revenue_ready,
            proof_floor=inputs.proof_floor,
            live_submission_gate=inputs.live_submission_gate,
        ),
        alpha=alpha,
        capital=capital,
        evidence=_build_evidence(
            inputs=inputs,
            alpha=alpha,
            runtime_window_import_repair=runtime_window_import_repair,
        ),
    )


def _source_serving_metadata(inputs: RevenueRepairInputs) -> dict[str, object]:
    return {
        "build": inputs.build,
        "source_serving_repair_receipt_ledger": inputs.status_payload.get(
            "source_serving_repair_receipt_ledger"
        ),
        "route_evidence_clearinghouse_packet": inputs.route_evidence_clearinghouse,
    }


def _build_artifacts(
    generated: datetime, inputs: RevenueRepairInputs, state: RevenueRepairState
) -> RevenueRepairArtifacts:
    source_serving_metadata = _source_serving_metadata(inputs)
    alpha_readiness_strike_ledger = build_alpha_readiness_strike_ledger(
        generated_at=generated,
        business_state=state.business_state,
        revenue_ready=state.revenue_ready,
        repair_queue=inputs.repair_queue,
        repair_bid_settlement_ledger=inputs.repair_bid_settlement,
        capital=state.capital,
        evidence=state.evidence,
    )
    executable_alpha_repair_receipts = build_executable_alpha_repair_receipts(
        generated_at=generated,
        business_state=state.business_state,
        revenue_ready=state.revenue_ready,
        repair_queue=inputs.repair_queue,
        alpha_readiness=state.alpha,
        capital=state.capital,
        repair_bid_settlement_ledger=inputs.repair_bid_settlement,
    )
    alpha_repair_closure_board = build_alpha_repair_closure_board(
        generated_at=generated,
        business_state=state.business_state,
        revenue_ready=state.revenue_ready,
        repair_queue=inputs.repair_queue,
        capital=state.capital,
        evidence=state.evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        source_serving_metadata=source_serving_metadata,
        db_check=inputs.db_check,
    )
    executable_alpha_settlement_slots = build_executable_alpha_settlement_slots(
        generated_at=generated,
        business_state=state.business_state,
        revenue_ready=state.revenue_ready,
        repair_queue=inputs.repair_queue,
        capital=state.capital,
        evidence=state.evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
    )
    alpha_evidence_foundry = build_alpha_evidence_foundry(
        generated_at=generated,
        business_state=state.business_state,
        revenue_ready=state.revenue_ready,
        repair_queue=inputs.repair_queue,
        capital=state.capital,
        evidence=state.evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        source_serving_metadata=source_serving_metadata,
    )
    alpha_readiness_settlement_conveyor = build_alpha_readiness_settlement_conveyor(
        generated_at=generated,
        business_state=state.business_state,
        revenue_ready=state.revenue_ready,
        repair_queue=inputs.repair_queue,
        capital=state.capital,
        evidence=state.evidence,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_repair_closure_board=alpha_repair_closure_board,
        source_serving_metadata=source_serving_metadata,
    )
    alpha_repair_dividend_ledger = build_alpha_repair_dividend_ledger(
        generated_at=generated,
        business_state=state.business_state,
        revenue_ready=state.revenue_ready,
        repair_queue=inputs.repair_queue,
        capital=state.capital,
        evidence=state.evidence,
        repair_bid_settlement_ledger=inputs.repair_bid_settlement,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        executable_alpha_settlement_slots=executable_alpha_settlement_slots,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_repair_closure_board=alpha_repair_closure_board,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
    )
    jangar_controller_ingestion_carry = build_jangar_controller_ingestion_carry(
        generated_at=generated,
        dependency_quorum=_mapping(inputs.status_payload.get("dependency_quorum")),
        controller_ingestion_settlement=cast(
            Mapping[str, Any] | None,
            inputs.status_payload.get("controller_ingestion_settlement"),
        ),
        verify_trust_foreclosure_board=cast(
            Mapping[str, Any] | None,
            inputs.status_payload.get("verify_trust_foreclosure_board")
            or inputs.status_payload.get("jangar_verification_carry"),
        ),
        repair_slot_escrow=cast(
            Mapping[str, Any] | None,
            inputs.status_payload.get("repair_slot_escrow")
            or inputs.status_payload.get("stage_debt_repair_admission"),
        ),
        foreclosure_carry_rollout_witness=cast(
            Mapping[str, Any] | None,
            inputs.status_payload.get("foreclosure_carry_rollout_witness"),
        ),
    )
    no_delta_repair_reentry_auction = build_no_delta_repair_reentry_auction(
        generated_at=generated,
        business_state=state.business_state,
        revenue_ready=state.revenue_ready,
        repair_queue=inputs.repair_queue,
        capital=state.capital,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
        alpha_repair_dividend_ledger=alpha_repair_dividend_ledger,
        repair_bid_settlement_ledger=inputs.repair_bid_settlement,
        jangar_verification_carry=cast(
            Mapping[str, Any] | None,
            inputs.status_payload.get("verify_trust_foreclosure_board")
            or inputs.status_payload.get("jangar_verification_carry"),
        ),
        jangar_controller_ingestion_carry=jangar_controller_ingestion_carry,
    )
    return RevenueRepairArtifacts(
        alpha_readiness_strike_ledger=alpha_readiness_strike_ledger,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        executable_alpha_settlement_slots=executable_alpha_settlement_slots,
        alpha_repair_closure_board=alpha_repair_closure_board,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
        alpha_repair_dividend_ledger=alpha_repair_dividend_ledger,
        jangar_controller_ingestion_carry=jangar_controller_ingestion_carry,
        no_delta_repair_reentry_auction=no_delta_repair_reentry_auction,
    )


def _dependency_failures(inputs: RevenueRepairInputs) -> list[dict[str, str]]:
    return [
        {"name": name, "detail": _text(_mapping(raw).get("detail"), "unknown")}
        for name, raw in inputs.dependencies.items()
        if _mapping(raw) and not _bool(_mapping(raw).get("ok"), default=True)
    ]


def _build_digest_payload(
    generated: datetime,
    inputs: RevenueRepairInputs,
    state: RevenueRepairState,
    artifacts: RevenueRepairArtifacts,
) -> dict[str, object]:
    topline_contract = build_topline_contract(
        ToplineContractInputs(
            status_payload=inputs.status_payload,
            repair_queue=inputs.repair_queue,
            capital=state.capital,
            evidence=state.evidence,
            repair_bid_settlement=inputs.repair_bid_settlement,
            alpha_evidence_foundry=artifacts.alpha_evidence_foundry,
            alpha_readiness_settlement_conveyor=(
                artifacts.alpha_readiness_settlement_conveyor
            ),
            alpha_repair_dividend_ledger=artifacts.alpha_repair_dividend_ledger,
            no_delta_repair_reentry_auction=(artifacts.no_delta_repair_reentry_auction),
        )
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated.isoformat(),
        "routeability_repair_acceptance_ledger_id": inputs.routeability_ledger.get(
            "ledger_id"
        ),
        "route_evidence_clearinghouse_packet": dict(
            inputs.route_evidence_clearinghouse
        ),
        "repair_bid_settlement_ledger": dict(inputs.repair_bid_settlement),
        "alpha_readiness_strike_ledger": artifacts.alpha_readiness_strike_ledger,
        "executable_alpha_repair_receipts": artifacts.executable_alpha_repair_receipts,
        "executable_alpha_settlement_slots": artifacts.executable_alpha_settlement_slots,
        "alpha_repair_closure_board": artifacts.alpha_repair_closure_board,
        "alpha_evidence_foundry": artifacts.alpha_evidence_foundry,
        "alpha_readiness_settlement_conveyor": (
            artifacts.alpha_readiness_settlement_conveyor
        ),
        "alpha_repair_dividend_ledger": artifacts.alpha_repair_dividend_ledger,
        "jangar_controller_ingestion_carry": (
            artifacts.jangar_controller_ingestion_carry
        ),
        "no_delta_repair_reentry_auction": artifacts.no_delta_repair_reentry_auction,
        "business_state": state.business_state,
        "revenue_ready": state.revenue_ready,
        **topline_contract,
        "health": {
            "readyz_status": state.readyz_status,
            "readyz_ok": state.readiness_ok,
            "mode": _text(inputs.status_payload.get("mode"), "unknown"),
            "pipeline_mode": _text(
                inputs.status_payload.get("pipeline_mode"), "unknown"
            ),
            "active_revision": _text(
                inputs.build.get("active_revision"),
                _text(inputs.build.get("commit"), "unknown"),
            ),
            "dependency_failures": _dependency_failures(inputs),
        },
        "capital": state.capital,
        "evidence": state.evidence,
        "blockers": [{"reason": reason} for reason in inputs.blocking_reasons],
        "repair_queue": inputs.repair_queue,
        "operating_rule": (
            "keep_live_submit_disabled_until_repair_queue_clears"
            if inputs.repair_queue and not state.revenue_ready
            else "eligible_for_guarded_revenue_verification"
        ),
    }


def build_revenue_repair_digest(
    *,
    readyz_payload: Mapping[str, Any],
    status_payload: Mapping[str, Any],
    generated_at: datetime | None = None,
) -> dict[str, object]:
    generated = _normalize_generated_at(generated_at)
    inputs = _build_inputs(readyz_payload=readyz_payload, status_payload=status_payload)
    state = _build_state(inputs)
    artifacts = _build_artifacts(generated, inputs, state)
    return _build_digest_payload(generated, inputs, state, artifacts)


def _parse_generated_at(raw: str | None) -> datetime | None:
    if raw is None:
        return None
    normalized = raw.strip()
    if not normalized:
        return None
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    return parsed.astimezone(timezone.utc)


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a Torghut revenue-repair digest from saved /readyz and /trading/status JSON payloads.",
    )
    parser.add_argument(
        "--readyz-json",
        required=True,
        type=Path,
        help="Path to a Torghut /readyz JSON payload.",
    )
    parser.add_argument(
        "--status-json",
        required=True,
        type=Path,
        help="Path to a Torghut /trading/status JSON payload.",
    )
    parser.add_argument(
        "--generated-at", help="Optional ISO-8601 timestamp for deterministic output."
    )
    parser.add_argument(
        "--output", type=Path, help="Optional output path. Defaults to stdout."
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        digest = build_revenue_repair_digest(
            readyz_payload=_load_json_object(args.readyz_json, field_name="readyz"),
            status_payload=_load_json_object(args.status_json, field_name="status"),
            generated_at=_parse_generated_at(args.generated_at),
        )
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    serialized = json.dumps(digest, indent=2, sort_keys=True)
    if args.output is not None:
        args.output.write_text(f"{serialized}\n", encoding="utf-8")
    else:
        print(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


parse_generated_at = _parse_generated_at
parse_args = _parse_args

__all__ = [
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
    "_parse_generated_at",
    "_parse_args",
    "main",
]
