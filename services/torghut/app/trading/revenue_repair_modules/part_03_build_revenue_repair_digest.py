# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
#!/usr/bin/env python
"""Build a business-prioritized repair digest from Torghut readiness evidence."""

from __future__ import annotations

import argparse
import json
import sys
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

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_32 import *
from .part_02_summarize_tca import *


def build_revenue_repair_digest(
    *,
    readyz_payload: Mapping[str, Any],
    status_payload: Mapping[str, Any],
    generated_at: datetime | None = None,
) -> dict[str, object]:
    generated = generated_at or datetime.now(timezone.utc)
    if generated.tzinfo is None:
        raise ValueError("generated_at_missing_timezone")
    generated = generated.astimezone(timezone.utc)

    proof_floor = _choose_mapping(
        status_payload.get("proof_floor"), readyz_payload.get("proof_floor")
    )
    live_submission_gate = _choose_mapping(
        status_payload.get("live_submission_gate"),
        readyz_payload.get("live_submission_gate"),
    )
    quant_evidence = _choose_mapping(
        status_payload.get("quant_evidence"), readyz_payload.get("quant_evidence")
    )
    routeability_ledger = _choose_mapping(
        status_payload.get("routeability_repair_acceptance_ledger"),
        readyz_payload.get("routeability_repair_acceptance_ledger"),
    )
    route_evidence_clearinghouse = _choose_mapping(
        status_payload.get("route_evidence_clearinghouse_packet"),
        readyz_payload.get("route_evidence_clearinghouse_packet"),
    )
    repair_bid_settlement = _choose_mapping(
        status_payload.get("repair_bid_settlement_ledger"),
        readyz_payload.get("repair_bid_settlement_ledger"),
    )
    repair_outcome_dividend = _choose_mapping(
        status_payload.get("repair_outcome_dividend_ledger"),
        readyz_payload.get("repair_outcome_dividend_ledger"),
    )
    db_check = _choose_mapping(
        status_payload.get("db_check"),
        status_payload.get("database_contract"),
        _mapping(_mapping(readyz_payload.get("dependencies")).get("database")),
        _mapping(_mapping(readyz_payload.get("dependencies")).get("database_contract")),
    )
    dependencies = _mapping(readyz_payload.get("dependencies"))
    blocking_reasons = _collect_blocking_reasons(readyz_payload, status_payload)
    repair_queue = _build_repair_queue(proof_floor, status_payload, blocking_reasons)

    readyz_status = _text(readyz_payload.get("status"), "unknown")
    readiness_ok = readyz_status in {"ok", "healthy"}
    proof_floor_route_state = _text(proof_floor.get("route_state"), "unknown")
    capital_state = _text(proof_floor.get("capital_state"), "unknown")
    max_notional = _text(proof_floor.get("max_notional"), "0")
    live_gate_allowed = _bool(live_submission_gate.get("allowed"))
    alpha = _summarize_alpha(status_payload, proof_floor)
    revenue_ready = (
        readiness_ok
        and live_gate_allowed
        and proof_floor_route_state not in {"repair_only", "unknown"}
        and capital_state not in {"zero_notional", "unknown"}
        and max_notional not in {"0", "0.0", "0.00"}
        and _int(alpha.get("promotion_eligible_total")) > 0
        and not blocking_reasons
    )

    build = _mapping(status_payload.get("build"))
    capital = {
        "live_submission_allowed": live_gate_allowed,
        "live_submission_reason": _text(live_submission_gate.get("reason"), "unknown"),
        "configured_live_promotion": _bool(
            live_submission_gate.get("configured_live_promotion")
        ),
        "capital_stage": _text(live_submission_gate.get("capital_stage"), "unknown"),
        "proof_floor_state": _text(proof_floor.get("floor_state"), "unknown"),
        "route_state": proof_floor_route_state,
        "capital_state": capital_state,
        "max_notional": max_notional,
    }
    runtime_window_import_repair = _summarize_runtime_window_import_repair(
        live_submission_gate
    )
    evidence = {
        "alpha_readiness": alpha,
        "quant_evidence": {
            "ok": _bool(quant_evidence.get("ok"), default=True),
            "status": _text(quant_evidence.get("status"), "unknown"),
            "reason": _text(quant_evidence.get("reason"), "unknown"),
            "max_stage_lag_seconds": quant_evidence.get("max_stage_lag_seconds"),
            "blocking_reasons": _string_items(quant_evidence.get("blocking_reasons")),
        },
        "execution_tca": _summarize_tca(proof_floor),
        "route_reacquisition": _summarize_route_reacquisition(
            status_payload, proof_floor
        ),
        "routeability_acceptance": _summarize_routeability_acceptance(
            routeability_ledger
        ),
        "route_evidence_clearinghouse": _summarize_route_evidence_clearinghouse(
            route_evidence_clearinghouse
        ),
        "repair_bid_settlement": _summarize_repair_bid_settlement(
            repair_bid_settlement
        ),
        "repair_outcome_dividend": _summarize_repair_outcome_dividend(
            repair_outcome_dividend
        ),
        "runtime_window_import_repair": runtime_window_import_repair,
        "simple_lane_reject_reason_totals": _collect_reason_counts(status_payload),
    }
    business_state = _business_state(
        revenue_ready=revenue_ready,
        proof_floor=proof_floor,
        live_submission_gate=live_submission_gate,
    )
    alpha_readiness_strike_ledger = build_alpha_readiness_strike_ledger(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        repair_bid_settlement_ledger=repair_bid_settlement,
        capital=capital,
        evidence=evidence,
    )
    executable_alpha_repair_receipts = build_executable_alpha_repair_receipts(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        alpha_readiness=alpha,
        capital=capital,
        repair_bid_settlement_ledger=repair_bid_settlement,
    )
    alpha_repair_closure_board = build_alpha_repair_closure_board(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        source_serving_metadata={
            "build": build,
            "source_serving_repair_receipt_ledger": status_payload.get(
                "source_serving_repair_receipt_ledger"
            ),
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse,
        },
        db_check=db_check,
    )
    executable_alpha_settlement_slots = build_executable_alpha_settlement_slots(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
    )
    alpha_evidence_foundry = build_alpha_evidence_foundry(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        source_serving_metadata={
            "build": build,
            "source_serving_repair_receipt_ledger": status_payload.get(
                "source_serving_repair_receipt_ledger"
            ),
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse,
        },
    )
    alpha_readiness_settlement_conveyor = build_alpha_readiness_settlement_conveyor(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_repair_closure_board=alpha_repair_closure_board,
        source_serving_metadata={
            "build": build,
            "source_serving_repair_receipt_ledger": status_payload.get(
                "source_serving_repair_receipt_ledger"
            ),
            "route_evidence_clearinghouse_packet": route_evidence_clearinghouse,
        },
    )
    alpha_repair_dividend_ledger = build_alpha_repair_dividend_ledger(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        repair_bid_settlement_ledger=repair_bid_settlement,
        executable_alpha_repair_receipts=executable_alpha_repair_receipts,
        executable_alpha_settlement_slots=executable_alpha_settlement_slots,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_repair_closure_board=alpha_repair_closure_board,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
    )
    dependency_quorum = _mapping(status_payload.get("dependency_quorum"))
    jangar_controller_ingestion_carry = build_jangar_controller_ingestion_carry(
        generated_at=generated,
        dependency_quorum=dependency_quorum,
        controller_ingestion_settlement=cast(
            Mapping[str, Any] | None,
            status_payload.get("controller_ingestion_settlement"),
        ),
        verify_trust_foreclosure_board=cast(
            Mapping[str, Any] | None,
            status_payload.get("verify_trust_foreclosure_board")
            or status_payload.get("jangar_verification_carry"),
        ),
        repair_slot_escrow=cast(
            Mapping[str, Any] | None,
            status_payload.get("repair_slot_escrow")
            or status_payload.get("stage_debt_repair_admission"),
        ),
        foreclosure_carry_rollout_witness=cast(
            Mapping[str, Any] | None,
            status_payload.get("foreclosure_carry_rollout_witness"),
        ),
    )
    no_delta_repair_reentry_auction = build_no_delta_repair_reentry_auction(
        generated_at=generated,
        business_state=business_state,
        revenue_ready=revenue_ready,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
        alpha_repair_dividend_ledger=alpha_repair_dividend_ledger,
        repair_bid_settlement_ledger=repair_bid_settlement,
        jangar_verification_carry=cast(
            Mapping[str, Any] | None,
            status_payload.get("verify_trust_foreclosure_board")
            or status_payload.get("jangar_verification_carry"),
        ),
        jangar_controller_ingestion_carry=jangar_controller_ingestion_carry,
    )
    topline_contract = _build_topline_contract(
        status_payload=status_payload,
        repair_queue=cast(Sequence[Mapping[str, Any]], repair_queue),
        capital=capital,
        evidence=evidence,
        repair_bid_settlement=repair_bid_settlement,
        alpha_evidence_foundry=alpha_evidence_foundry,
        alpha_readiness_settlement_conveyor=alpha_readiness_settlement_conveyor,
        alpha_repair_dividend_ledger=alpha_repair_dividend_ledger,
        no_delta_repair_reentry_auction=no_delta_repair_reentry_auction,
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated.isoformat(),
        "routeability_repair_acceptance_ledger_id": routeability_ledger.get(
            "ledger_id"
        ),
        "route_evidence_clearinghouse_packet": dict(route_evidence_clearinghouse),
        "repair_bid_settlement_ledger": dict(repair_bid_settlement),
        "alpha_readiness_strike_ledger": alpha_readiness_strike_ledger,
        "executable_alpha_repair_receipts": executable_alpha_repair_receipts,
        "executable_alpha_settlement_slots": executable_alpha_settlement_slots,
        "alpha_repair_closure_board": alpha_repair_closure_board,
        "alpha_evidence_foundry": alpha_evidence_foundry,
        "alpha_readiness_settlement_conveyor": alpha_readiness_settlement_conveyor,
        "alpha_repair_dividend_ledger": alpha_repair_dividend_ledger,
        "jangar_controller_ingestion_carry": jangar_controller_ingestion_carry,
        "no_delta_repair_reentry_auction": no_delta_repair_reentry_auction,
        "business_state": business_state,
        "revenue_ready": revenue_ready,
        **topline_contract,
        "health": {
            "readyz_status": readyz_status,
            "readyz_ok": readiness_ok,
            "mode": _text(status_payload.get("mode"), "unknown"),
            "pipeline_mode": _text(status_payload.get("pipeline_mode"), "unknown"),
            "active_revision": _text(
                build.get("active_revision"), _text(build.get("commit"), "unknown")
            ),
            "dependency_failures": [
                {
                    "name": name,
                    "detail": _text(_mapping(raw_dependency).get("detail"), "unknown"),
                }
                for name, raw_dependency in dependencies.items()
                if _mapping(raw_dependency)
                and not _bool(_mapping(raw_dependency).get("ok"), default=True)
            ],
        },
        "capital": capital,
        "evidence": evidence,
        "blockers": [{"reason": reason} for reason in blocking_reasons],
        "repair_queue": repair_queue,
        "operating_rule": (
            "keep_live_submit_disabled_until_repair_queue_clears"
            if repair_queue and not revenue_ready
            else "eligible_for_guarded_revenue_verification"
        ),
    }


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


__all__ = [name for name in globals() if not name.startswith("__")]
