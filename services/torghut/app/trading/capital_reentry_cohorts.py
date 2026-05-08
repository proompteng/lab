"""Receipt-settled capital reentry cohort projection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast


CAPITAL_REENTRY_COHORT_LEDGER_SCHEMA_VERSION = (
    "torghut.capital-reentry-cohort-ledger.v1"
)
_DEFAULT_FRESHNESS_SECONDS = 60
_FORECAST_READY_STATES = {"ready", "shadow_ready", "disabled", "not_required"}
_JANGAR_ALLOW_DECISIONS = {"allow", "allow_with_split", "current"}


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    return (
        cast(Sequence[object], value)
        if isinstance(value, Sequence)
        and not isinstance(value, (str, bytes, bytearray))
        else ()
    )


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _int(value: object, default: int = 0) -> int:
    value_decimal = _decimal(value)
    if value_decimal is None:
        return default
    return int(value_decimal)


def _unique(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
    return result


def _string_list(value: object) -> list[str]:
    return _unique([_text(item) for item in _sequence(value)])


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:16]}"


def _route_rows(
    route_reacquisition_board: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    return [_mapping(item) for item in _sequence(route_reacquisition_board.get("rows"))]


def _dimension(proof_floor_receipt: Mapping[str, Any], name: str) -> Mapping[str, Any]:
    for raw_dimension in _sequence(proof_floor_receipt.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) == name:
            return dimension
    return {}


def _row_symbol(row: Mapping[str, Any]) -> str:
    return _text(row.get("symbol")).upper()


def _row_state(row: Mapping[str, Any]) -> str:
    return _text(row.get("state"), "unknown")


def _find_row(rows: Sequence[Mapping[str, Any]], symbol: str) -> Mapping[str, Any]:
    wanted = symbol.upper()
    for row in rows:
        if _row_symbol(row) == wanted:
            return row
    return {}


def _first_row_with_state(
    rows: Sequence[Mapping[str, Any]], states: set[str]
) -> Mapping[str, Any]:
    for row in rows:
        if _row_state(row) in states:
            return row
    return rows[0] if rows else {}


def _candidate_symbols(
    rows: Sequence[Mapping[str, Any]], state: str, limit: int | None = None
) -> list[str]:
    symbols = [
        _row_symbol(row)
        for row in rows
        if _row_state(row) == state and _row_symbol(row)
    ]
    symbols = _unique(symbols)
    return symbols if limit is None else symbols[:limit]


def _expected_unblock_value(rows: Sequence[Mapping[str, Any]]) -> int:
    return sum(_int(row.get("expected_unblock_value")) for row in rows)


def _fresh_until(
    *, consumer_evidence_receipt: Mapping[str, Any], generated_at: datetime
) -> str:
    return _text(
        consumer_evidence_receipt.get("fresh_until"),
        (generated_at + timedelta(seconds=_DEFAULT_FRESHNESS_SECONDS)).isoformat(),
    )


def _forecast_state(consumer_evidence_receipt: Mapping[str, Any]) -> str:
    return _text(consumer_evidence_receipt.get("forecast_registry_state"), "unknown")


def _alpha_state(proof_floor_receipt: Mapping[str, Any]) -> str:
    alpha_dimension = _dimension(proof_floor_receipt, "alpha_readiness")
    return _text(alpha_dimension.get("state"), "unknown")


def _jangar_decision(jangar_material_verdict_ref: Mapping[str, Any]) -> str:
    return _text(
        jangar_material_verdict_ref.get("decision")
        or jangar_material_verdict_ref.get("state"),
        "unknown",
    ).lower()


def _base_blockers(
    *,
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    jangar_material_verdict_ref: Mapping[str, Any],
) -> list[str]:
    blockers = _string_list(consumer_evidence_receipt.get("reason_codes"))
    if _text(proof_floor_receipt.get("route_state")) == "repair_only":
        blockers.append("proof_floor_repair_only")
    if _text(proof_floor_receipt.get("capital_state")) == "zero_notional":
        blockers.append("capital_state_zero_notional")
    jangar_decision = _jangar_decision(jangar_material_verdict_ref)
    if jangar_decision not in _JANGAR_ALLOW_DECISIONS:
        blockers.append(f"jangar_material_verdict_{jangar_decision}")
    return _unique(blockers)


def _receipt_settlement_blockers(
    *,
    row: Mapping[str, Any],
    base_blockers: Sequence[str],
) -> list[str]:
    blockers = list(base_blockers)
    required_receipts = _mapping(row.get("required_receipts"))
    for key in (
        "market_context_receipt",
        "quant_pipeline_receipt",
        "alpha_readiness_receipt",
    ):
        receipt = _mapping(required_receipts.get(key))
        state = _text(receipt.get("state"), "missing")
        if state not in {"present", "pass", "informational", "ready", "healthy", "ok"}:
            blockers.append(f"{key}_{state}")
    return _unique(blockers)


def _paper_candidate_allowed(
    *,
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    jangar_material_verdict_ref: Mapping[str, Any],
    blockers: Sequence[str],
) -> bool:
    max_notional = _decimal(proof_floor_receipt.get("max_notional"))
    return (
        not blockers
        and _text(consumer_evidence_receipt.get("paper_readiness_state")) == "ready"
        and _text(proof_floor_receipt.get("route_state")) != "repair_only"
        and _text(proof_floor_receipt.get("capital_state"))
        in {"paper_allowed", "paper_candidate"}
        and max_notional is not None
        and max_notional > 0
        and _jangar_decision(jangar_material_verdict_ref) in _JANGAR_ALLOW_DECISIONS
    )


def _state_for_blockers(
    *,
    blockers: Sequence[str],
    paper_candidate_allowed: bool,
    empty_required_surface: bool = False,
) -> str:
    if paper_candidate_allowed:
        return "paper_candidate"
    if empty_required_surface:
        return "hold"
    if blockers:
        return "repair"
    return "observe"


def _cohort_id(
    *,
    account_label: str | None,
    trading_mode: str,
    cohort_class: str,
    symbols: Sequence[str],
) -> str:
    return _stable_ref(
        "capital-reentry-cohort",
        {
            "account_label": account_label,
            "trading_mode": trading_mode,
            "cohort_class": cohort_class,
            "symbols": sorted(symbols),
        },
    )


def _cohort(
    *,
    account_label: str | None,
    trading_mode: str,
    cohort_class: str,
    symbols: Sequence[str],
    current_state: str,
    expected_unblock_value: int,
    required_receipts: Sequence[str],
    blocking_reason_codes: Sequence[str],
    metric_bindings: Sequence[str],
    next_action: str,
) -> dict[str, object]:
    normalized_symbols = sorted(
        {_text(symbol).upper() for symbol in symbols if _text(symbol)}
    )
    return {
        "cohort_id": _cohort_id(
            account_label=account_label,
            trading_mode=trading_mode,
            cohort_class=cohort_class,
            symbols=normalized_symbols,
        ),
        "symbol_set": normalized_symbols,
        "cohort_class": cohort_class,
        "current_state": current_state,
        "max_notional": "0",
        "expected_unblock_value": expected_unblock_value,
        "required_receipts": list(required_receipts),
        "blocking_reason_codes": _unique(list(blocking_reason_codes)),
        "metric_bindings": _unique(list(metric_bindings)),
        "next_action": next_action,
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "cohort_class": cohort_class,
        },
    }


def _receipt_settlement_cohort(
    *,
    rows: Sequence[Mapping[str, Any]],
    account_label: str | None,
    trading_mode: str,
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    jangar_material_verdict_ref: Mapping[str, Any],
    base_blockers: Sequence[str],
) -> dict[str, object]:
    row = _find_row(rows, "AAPL") or _first_row_with_state(
        rows, {"probing", "routeable"}
    )
    symbols = [_row_symbol(row)] if row else ["AAPL"]
    blockers = (
        _receipt_settlement_blockers(row=row, base_blockers=base_blockers)
        if row
        else _unique([*base_blockers, "aapl_route_receipt_missing"])
    )
    paper_allowed = _paper_candidate_allowed(
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor_receipt,
        jangar_material_verdict_ref=jangar_material_verdict_ref,
        blockers=blockers,
    )
    return _cohort(
        account_label=account_label,
        trading_mode=trading_mode,
        cohort_class="receipt_settlement",
        symbols=symbols,
        current_state=_state_for_blockers(
            blockers=blockers,
            paper_candidate_allowed=paper_allowed,
            empty_required_surface=not bool(row),
        ),
        expected_unblock_value=_int(row.get("expected_unblock_value"), 3) if row else 0,
        required_receipts=[
            "current_consumer_evidence_receipt",
            "fresh_market_context_receipt",
            "scoped_quant_health_receipt",
            "alpha_readiness_receipt",
            "forecast_registry_eligibility_receipt",
            "jangar_material_verdict",
        ],
        blocking_reason_codes=blockers,
        metric_bindings=[
            "routeable_candidate_count",
            "zero_notional_or_stale_evidence_rate",
            "capital_gate_safety",
        ],
        next_action="settle_aapl_receipt_chain_before_paper_canary",
    )


def _tca_repair_cohort(
    *,
    rows: Sequence[Mapping[str, Any]],
    account_label: str | None,
    trading_mode: str,
) -> dict[str, object]:
    blocked_rows = [row for row in rows if _row_state(row) == "blocked"]
    symbols = _candidate_symbols(blocked_rows, "blocked", limit=4)
    blockers = _unique(
        [
            _text(row.get("current_blocker"), "execution_tca_repair_required")
            for row in blocked_rows
        ]
    )
    return _cohort(
        account_label=account_label,
        trading_mode=trading_mode,
        cohort_class="tca_repair",
        symbols=symbols,
        current_state="repair" if blocked_rows else "observe",
        expected_unblock_value=_expected_unblock_value(blocked_rows),
        required_receipts=[
            "fresh_execution_tca_receipt",
            "route_universe_recompute_receipt",
            "consumer_evidence_receipt",
        ],
        blocking_reason_codes=blockers,
        metric_bindings=[
            "fill_tca_or_slippage_quality",
            "routeable_candidate_count",
            "zero_notional_or_stale_evidence_rate",
        ],
        next_action="repair_high_activity_tca_before_candidate_state"
        if blocked_rows
        else "wait_for_blocked_tca_rows",
    )


def _missing_tca_cohort(
    *,
    rows: Sequence[Mapping[str, Any]],
    account_label: str | None,
    trading_mode: str,
) -> dict[str, object]:
    missing_rows = [row for row in rows if _row_state(row) == "missing"]
    symbols = _candidate_symbols(missing_rows, "missing")
    return _cohort(
        account_label=account_label,
        trading_mode=trading_mode,
        cohort_class="missing_tca_probe",
        symbols=symbols,
        current_state="repair" if missing_rows else "observe",
        expected_unblock_value=_expected_unblock_value(missing_rows),
        required_receipts=[
            "simulation_route_probe_receipt",
            "fresh_execution_tca_receipt",
            "consumer_evidence_receipt",
        ],
        blocking_reason_codes=["execution_tca_symbol_missing"] if missing_rows else [],
        metric_bindings=[
            "fill_tca_or_slippage_quality",
            "routeable_candidate_count",
            "capital_gate_safety",
        ],
        next_action="create_zero_notional_tca_probes_for_missing_symbols"
        if missing_rows
        else "wait_for_missing_tca_symbols",
    )


def _forecast_registry_cohort(
    *,
    account_label: str | None,
    trading_mode: str,
    consumer_evidence_receipt: Mapping[str, Any],
) -> dict[str, object]:
    forecast_state = _forecast_state(consumer_evidence_receipt)
    blockers = (
        []
        if forecast_state in _FORECAST_READY_STATES
        else [f"forecast_registry_{forecast_state}"]
    )
    return _cohort(
        account_label=account_label,
        trading_mode=trading_mode,
        cohort_class="forecast_registry",
        symbols=[],
        current_state="repair" if blockers else "observe",
        expected_unblock_value=2 if blockers else 0,
        required_receipts=[
            "forecast_registry_eligible_model_receipt",
            "consumer_evidence_receipt",
        ],
        blocking_reason_codes=blockers,
        metric_bindings=[
            "zero_notional_or_stale_evidence_rate",
            "routeable_candidate_count",
        ],
        next_action="restore_forecast_registry_eligible_model"
        if blockers
        else "maintain_forecast_registry_receipt",
    )


def _alpha_readiness_cohort(
    *,
    account_label: str | None,
    trading_mode: str,
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
) -> dict[str, object]:
    alpha_state = _alpha_state(proof_floor_receipt)
    reason_codes = _string_list(consumer_evidence_receipt.get("reason_codes"))
    blockers = [
        reason
        for reason in reason_codes
        if reason.startswith("alpha_readiness") or reason.startswith("hypothesis")
    ]
    if (
        alpha_state
        not in {"pass", "informational", "ready", "healthy", "ok", "unknown"}
        and not blockers
    ):
        blockers.append(f"alpha_readiness_{alpha_state}")
    return _cohort(
        account_label=account_label,
        trading_mode=trading_mode,
        cohort_class="alpha_readiness",
        symbols=[],
        current_state="repair" if blockers else "observe",
        expected_unblock_value=3 if blockers else 0,
        required_receipts=[
            "alpha_readiness_promotion_eligible_receipt",
            "consumer_evidence_receipt",
        ],
        blocking_reason_codes=blockers,
        metric_bindings=["routeable_candidate_count", "capital_gate_safety"],
        next_action="retire_shadow_blockers_into_promotion_eligible_alpha"
        if blockers
        else "maintain_alpha_readiness_receipt",
    )


def _aggregate_state(cohorts: Sequence[Mapping[str, Any]]) -> str:
    states = {_text(cohort.get("current_state")) for cohort in cohorts}
    if "paper_candidate" in states:
        return "paper_candidate"
    if "repair" in states:
        return "repair"
    if "hold" in states:
        return "hold"
    if "block" in states:
        return "block"
    return "observe"


def build_capital_reentry_cohort_ledger(
    *,
    account_label: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    jangar_material_verdict_ref: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build a compact observe-mode ledger for receipt-settled capital reentry.

    The ledger never grants notional. It groups the current proof-floor and
    route-repair evidence into cohorts Jangar can cite when holding paper/live
    capital or admitting zero-notional repair.
    """

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    generated_at = observed_at.isoformat()
    rows = _route_rows(route_reacquisition_board)
    account = account_label or _text(proof_floor_receipt.get("account_label")) or None
    base_blockers = _base_blockers(
        consumer_evidence_receipt=consumer_evidence_receipt,
        proof_floor_receipt=proof_floor_receipt,
        jangar_material_verdict_ref=jangar_material_verdict_ref,
    )
    cohorts = [
        _receipt_settlement_cohort(
            rows=rows,
            account_label=account,
            trading_mode=trading_mode,
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor_receipt=proof_floor_receipt,
            jangar_material_verdict_ref=jangar_material_verdict_ref,
            base_blockers=base_blockers,
        ),
        _tca_repair_cohort(rows=rows, account_label=account, trading_mode=trading_mode),
        _missing_tca_cohort(
            rows=rows, account_label=account, trading_mode=trading_mode
        ),
        _forecast_registry_cohort(
            account_label=account,
            trading_mode=trading_mode,
            consumer_evidence_receipt=consumer_evidence_receipt,
        ),
        _alpha_readiness_cohort(
            account_label=account,
            trading_mode=trading_mode,
            consumer_evidence_receipt=consumer_evidence_receipt,
            proof_floor_receipt=proof_floor_receipt,
        ),
    ]
    aggregate_blockers = _unique(
        [
            _text(reason)
            for cohort in cohorts
            for reason in _sequence(cohort.get("blocking_reason_codes"))
        ]
    )
    aggregate_state = _aggregate_state(cohorts)
    ledger_id = _stable_ref(
        "capital-reentry-ledger",
        {
            "account_label": account,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "consumer_evidence_receipt_id": consumer_evidence_receipt.get("receipt_id"),
            "cohort_ids": [_text(cohort.get("cohort_id")) for cohort in cohorts],
            "aggregate_state": aggregate_state,
        },
    )
    return {
        "schema_version": CAPITAL_REENTRY_COHORT_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated_at,
        "fresh_until": _fresh_until(
            consumer_evidence_receipt=consumer_evidence_receipt,
            generated_at=observed_at,
        ),
        "account_label": account,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "jangar_material_verdict_ref": dict(jangar_material_verdict_ref),
        "consumer_evidence_receipt_id": consumer_evidence_receipt.get("receipt_id"),
        "proof_floor_ref": _text(proof_floor_receipt.get("schema_version")),
        "cohorts": cohorts,
        "aggregate_state": aggregate_state,
        "aggregate_blocking_reason_codes": aggregate_blockers,
        "summary": {
            "cohort_count": len(cohorts),
            "zero_notional_cohort_count": sum(
                1 for cohort in cohorts if _text(cohort.get("max_notional")) == "0"
            ),
            "paper_candidate_count": sum(
                1
                for cohort in cohorts
                if _text(cohort.get("current_state")) == "paper_candidate"
            ),
            "repair_cohort_count": sum(
                1
                for cohort in cohorts
                if _text(cohort.get("current_state")) == "repair"
            ),
            "routeable_candidate_count": _int(
                _mapping(route_reacquisition_board.get("summary")).get(
                    "capital_eligible_symbol_count"
                )
            ),
            "expected_unblock_value": sum(
                _int(cohort.get("expected_unblock_value")) for cohort in cohorts
            ),
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "cohort_consumption_enabled": False,
        },
    }
