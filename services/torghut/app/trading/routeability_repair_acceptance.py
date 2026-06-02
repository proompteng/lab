"""Routeability repair acceptance ledger projection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast

ROUTEABILITY_REPAIR_ACCEPTANCE_LEDGER_SCHEMA_VERSION = (
    "torghut.routeability-repair-acceptance-ledger.v1"
)

_FRESHNESS_SECONDS = 60
_ACCEPTED_STATES = {"allow", "approved", "current", "healthy", "ok", "pass", "ready"}
_NONBLOCKING_QUANT_HEALTH_REASONS = {
    "quant_health_not_configured",
}
_FORECAST_READY = {
    "disabled",
    "healthy",
    "not_required",
    "ok",
    "pass",
    "ready",
    "shadow_ready",
}
_PROMOTION_FRAGMENTS = (
    "autoresearch",
    "forecast",
    "promotion",
    "research_candidates",
    "research_promotions",
    "vnext_promotion",
)


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


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
    parsed = _decimal(value)
    return default if parsed is None else int(parsed)


def _float(value: object) -> float | None:
    parsed = _decimal(value)
    return None if parsed is None else float(parsed)


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on", "ok", "healthy", "ready"}:
            return True
        if normalized in {"0", "false", "no", "off", "degraded", "missing"}:
            return False
    return default


def _first_present(*values: object) -> object:
    for value in values:
        if value is not None:
            return value
    return None


def _unique(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _strings(value: object) -> list[str]:
    return _unique([_text(item) for item in _sequence(value)])


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:16]}"


def _rows(board: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [_mapping(row) for row in _sequence(board.get("rows"))]


def _symbol(row: Mapping[str, Any]) -> str:
    return _text(row.get("symbol")).upper()


def _row_state(row: Mapping[str, Any]) -> str:
    return _text(row.get("state"), "unknown").lower()


def _symbols(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    return sorted({_symbol(row) for row in rows if _symbol(row)})


def _hypothesis_ids(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    ids: list[str] = []
    for row in rows:
        ids.extend(_strings(row.get("hypothesis_ids")))
        source_metadata = _source_metadata(row)
        ids.extend(
            _identity_strings(source_metadata, "hypothesis_ids", "hypothesisIds")
        )
        if hypothesis_id := _text(
            source_metadata.get("hypothesis_id") or source_metadata.get("hypothesisId")
        ):
            ids.append(hypothesis_id)
    return sorted(set(ids))


def _source_metadata(row: Mapping[str, Any]) -> Mapping[str, Any]:
    metadata = _mapping(row.get("source_metadata"))
    if metadata:
        return metadata
    return _mapping(_mapping(row.get("audit_receipt")).get("source_metadata"))


def _identity_strings(
    source: Mapping[str, Any], *keys: str, uppercase: bool = False
) -> list[str]:
    values: list[str] = []
    for key in keys:
        raw = source.get(key)
        if isinstance(raw, Sequence) and not isinstance(raw, (str, bytes, bytearray)):
            values.extend(_text(item) for item in cast(Sequence[object], raw))
        elif raw is not None:
            values.append(_text(raw))
    if uppercase:
        return _unique([value.upper() for value in values])
    return _unique(values)


def _nested_identity(ref: Mapping[str, Any]) -> Mapping[str, Any]:
    for key in ("source_identity", "route_identity", "identity", "source_ref"):
        nested = _mapping(ref.get(key))
        if nested:
            return nested
    return {}


def _identity_field_values(
    source: Mapping[str, Any], *keys: str, uppercase: bool = False
) -> list[str]:
    nested = _nested_identity(source)
    return _unique(
        [
            *_identity_strings(source, *keys, uppercase=uppercase),
            *_identity_strings(nested, *keys, uppercase=uppercase),
        ]
    )


def _candidate_ids(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    ids: list[str] = []
    for row in rows:
        ids.extend(_identity_strings(row, "candidate_ids", "candidateIds"))
        source_metadata = _source_metadata(row)
        ids.extend(_identity_strings(source_metadata, "candidate_ids", "candidateIds"))
        if candidate_id := _text(
            source_metadata.get("candidate_id") or source_metadata.get("candidateId")
        ):
            ids.append(candidate_id)
    return sorted(set(ids))


def _source_manifest_refs(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    refs: list[str] = []
    for row in rows:
        source_metadata = _source_metadata(row)
        if manifest_ref := _text(
            row.get("source_manifest_ref")
            or row.get("sourceManifestRef")
            or source_metadata.get("source_manifest_ref")
            or source_metadata.get("sourceManifestRef")
        ):
            refs.append(manifest_ref)
    return sorted(set(refs))


def _identity_mismatch_blockers(
    *,
    expected: Sequence[str],
    observed: Sequence[str],
    missing_reason: str,
    mismatch_reason: str,
) -> list[str]:
    expected_values = sorted({_text(item) for item in expected if _text(item)})
    observed_values = sorted({_text(item) for item in observed if _text(item)})
    if not expected_values:
        return []
    if not observed_values:
        return [missing_reason]
    if expected_values != observed_values:
        return [mismatch_reason]
    return []


def _source_identity_contract(
    *,
    account: str | None,
    window: str | None,
    trading_mode: str,
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
    torghut_routeability_admission_ref: Mapping[str, Any],
) -> dict[str, object]:
    nested_admission = _nested_identity(torghut_routeability_admission_ref)
    route_account = _text(route_reacquisition_board.get("account_label")) or account
    proof_account = _text(proof_floor_receipt.get("account_label")) or account
    admission_account = _text(
        torghut_routeability_admission_ref.get("account_label")
        or torghut_routeability_admission_ref.get("account")
        or torghut_routeability_admission_ref.get("account_id")
        or nested_admission.get("account_label")
        or nested_admission.get("account")
        or nested_admission.get("account_id")
    )
    route_symbols = _symbols(rows)
    route_hypothesis_ids = _hypothesis_ids(rows)
    route_candidate_ids = _candidate_ids(rows)
    route_manifest_refs = _source_manifest_refs(rows)
    admission_symbols = sorted(
        set(
            _identity_field_values(
                torghut_routeability_admission_ref,
                "symbols",
                "route_symbols",
                "routeSymbols",
                "accepted_symbols",
                "acceptedSymbols",
                "candidate_symbols",
                "candidateSymbols",
                "symbol",
                uppercase=True,
            )
        )
    )
    admission_hypothesis_ids = _identity_field_values(
        torghut_routeability_admission_ref,
        "hypothesis_ids",
        "hypothesisIds",
        "hypothesis_id",
        "hypothesisId",
    )
    admission_candidate_ids = _identity_field_values(
        torghut_routeability_admission_ref,
        "candidate_ids",
        "candidateIds",
        "candidate_id",
        "candidateId",
    )
    admission_manifest_refs = _identity_field_values(
        torghut_routeability_admission_ref,
        "source_manifest_refs",
        "sourceManifestRefs",
        "source_manifest_ref",
        "sourceManifestRef",
    )
    admission_window = _text(
        torghut_routeability_admission_ref.get("window")
        or torghut_routeability_admission_ref.get("session_id")
        or torghut_routeability_admission_ref.get("sessionId")
        or nested_admission.get("window")
        or nested_admission.get("session_id")
    )
    admission_mode = _text(
        torghut_routeability_admission_ref.get("trading_mode")
        or torghut_routeability_admission_ref.get("tradingMode")
        or nested_admission.get("trading_mode")
    )

    blockers: list[str] = []
    if route_account and account and route_account != account:
        blockers.append("route_identity_route_board_account_mismatch")
    if proof_account and account and proof_account != account:
        blockers.append("route_identity_proof_floor_account_mismatch")
    if torghut_routeability_admission_ref:
        if account and not admission_account:
            blockers.append("route_identity_admission_account_missing")
        elif account and admission_account != account:
            blockers.append("route_identity_admission_account_mismatch")
        if window and not admission_window:
            blockers.append("route_identity_admission_window_missing")
        elif window and admission_window != window:
            blockers.append("route_identity_admission_window_mismatch")
        if trading_mode and not admission_mode:
            blockers.append("route_identity_admission_trading_mode_missing")
        elif trading_mode and admission_mode != trading_mode:
            blockers.append("route_identity_admission_trading_mode_mismatch")
        blockers.extend(
            _identity_mismatch_blockers(
                expected=route_symbols,
                observed=admission_symbols,
                missing_reason="route_identity_admission_symbol_scope_missing",
                mismatch_reason="route_identity_admission_symbol_scope_mismatch",
            )
        )
        blockers.extend(
            _identity_mismatch_blockers(
                expected=route_hypothesis_ids,
                observed=admission_hypothesis_ids,
                missing_reason="route_identity_hypothesis_lineage_missing",
                mismatch_reason="route_identity_hypothesis_lineage_mismatch",
            )
        )
        blockers.extend(
            _identity_mismatch_blockers(
                expected=route_candidate_ids,
                observed=admission_candidate_ids,
                missing_reason="route_identity_candidate_lineage_missing",
                mismatch_reason="route_identity_candidate_lineage_mismatch",
            )
        )
        blockers.extend(
            _identity_mismatch_blockers(
                expected=route_manifest_refs,
                observed=admission_manifest_refs,
                missing_reason="route_identity_source_manifest_missing",
                mismatch_reason="route_identity_source_manifest_mismatch",
            )
        )
    return {
        "account": account,
        "route_board_account": route_account,
        "proof_floor_account": proof_account,
        "admission_account": admission_account or None,
        "window": window,
        "admission_window": admission_window or None,
        "trading_mode": trading_mode,
        "admission_trading_mode": admission_mode or None,
        "route_symbols": route_symbols,
        "admission_symbols": admission_symbols,
        "route_hypothesis_ids": route_hypothesis_ids,
        "admission_hypothesis_ids": admission_hypothesis_ids,
        "route_candidate_ids": route_candidate_ids,
        "admission_candidate_ids": admission_candidate_ids,
        "route_source_manifest_refs": route_manifest_refs,
        "admission_source_manifest_refs": admission_manifest_refs,
        "blocking_reason_codes": _unique(blockers),
    }


def _dimension(
    proof_floor_receipt: Mapping[str, Any],
    name: str,
) -> Mapping[str, Any]:
    for raw_dimension in _sequence(proof_floor_receipt.get("proof_dimensions")):
        dimension = _mapping(raw_dimension)
        if _text(dimension.get("dimension")) == name:
            return dimension
    return {}


def _proof_blockers(proof_floor_receipt: Mapping[str, Any]) -> list[str]:
    blockers = _strings(proof_floor_receipt.get("blocking_reasons"))
    if _text(proof_floor_receipt.get("route_state")) == "repair_only":
        blockers.append("proof_floor_repair_only")
    if _text(proof_floor_receipt.get("capital_state")) == "zero_notional":
        blockers.append("capital_state_zero_notional")
    return _unique(blockers)


def _profit_lease_blockers(live_submission_gate: Mapping[str, Any]) -> list[str]:
    projection = _mapping(live_submission_gate.get("profit_lease_projection"))
    blockers = _strings(projection.get("blocking_reason_codes"))
    for raw_lease in _sequence(projection.get("leases")):
        blockers.extend(_strings(_mapping(raw_lease).get("blocking_reason_codes")))
    return _unique(blockers)


def _quant_blockers(quant_evidence: Mapping[str, Any]) -> list[str]:
    status = _text(quant_evidence.get("status") or quant_evidence.get("state")).lower()
    blockers = [
        *_strings(quant_evidence.get("blocking_reasons")),
        *_strings(quant_evidence.get("non_promoting_receipts")),
    ]
    reason = _text(quant_evidence.get("reason"))
    latest_count = _int(
        _first_present(
            quant_evidence.get("latest_metrics_count"),
            quant_evidence.get("latestMetricsCount"),
            quant_evidence.get("latest_count"),
        ),
        default=-1,
    )
    stage_count = _int(
        _first_present(
            quant_evidence.get("stage_count"),
            quant_evidence.get("stageCount"),
        ),
        default=-1,
    )
    source_url = _text(
        quant_evidence.get("source_url") or quant_evidence.get("sourceUrl")
    )
    quant_counts_are_authoritative = (
        quant_evidence.get("required") is True
        or bool(source_url)
        or bool(blockers)
        or (bool(status) and status != "not_required")
    )

    if quant_counts_are_authoritative and latest_count == 0:
        blockers.append("quant_latest_metrics_empty")
    if quant_counts_are_authoritative and (
        stage_count == 0
        or _bool(
            quant_evidence.get("missingPipelineHealthStages")
            or quant_evidence.get("missing_pipeline_health_stages")
        )
    ):
        blockers.append("quant_pipeline_stages_missing")
    if (
        quant_counts_are_authoritative
        and status
        and status not in _ACCEPTED_STATES
        and status != "not_required"
    ):
        blockers.append(reason or f"quant_health_{status}")
    if (
        quant_counts_are_authoritative
        and quant_evidence.get("ok") is False
        and not blockers
    ):
        blockers.append(reason or "quant_health_degraded")
    return _unique(
        [
            blocker
            for blocker in blockers
            if blocker not in _NONBLOCKING_QUANT_HEALTH_REASONS
        ]
    )


def _alpha_blockers(
    *,
    proof_floor_receipt: Mapping[str, Any],
    consumer_evidence_receipt: Mapping[str, Any],
) -> list[str]:
    alpha = _dimension(proof_floor_receipt, "alpha_readiness")
    source_ref = _mapping(alpha.get("source_ref"))
    state = _text(alpha.get("state") or alpha.get("reason")).lower()
    blockers = [
        reason
        for reason in [
            *_proof_blockers(proof_floor_receipt),
            *_strings(consumer_evidence_receipt.get("reason_codes")),
        ]
        if "alpha" in reason
    ]
    if state and state not in _ACCEPTED_STATES:
        blockers.append(f"alpha_readiness_{state}")
    if _int(source_ref.get("promotion_eligible_total"), default=-1) == 0:
        blockers.append("alpha_readiness_not_promotion_eligible")
    return _unique(blockers)


def _route_tca_blockers(
    *,
    proof_floor_receipt: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    rows: Sequence[Mapping[str, Any]],
) -> list[str]:
    blockers = [
        *_strings(route_reacquisition_board.get("blocking_reasons")),
        *[
            reason
            for reason in _proof_blockers(proof_floor_receipt)
            if reason in {"proof_floor_repair_only", "capital_state_zero_notional"}
        ],
    ]
    if not rows and _text(route_reacquisition_board.get("state")) == "repair_only":
        blockers.append("route_universe_empty")
    for row in rows:
        state = _row_state(row)
        if state in {"blocked", "missing", "probing"}:
            blockers.append(
                _text(
                    row.get("current_blocker"),
                    "execution_tca_symbol_missing"
                    if state == "missing"
                    else (
                        "execution_tca_route_probing"
                        if state == "probing"
                        else "execution_tca_route_blocked"
                    ),
                )
            )
        observed = _float(row.get("avg_abs_slippage_bps"))
        guardrail = _float(row.get("slippage_guardrail_bps"))
        if observed is not None and guardrail is not None and observed > guardrail:
            blockers.append("execution_tca_slippage_above_guardrail")
    return _unique(blockers)


def _forecast_blockers(
    *,
    consumer_evidence_receipt: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
) -> list[str]:
    forecast_state = _text(
        consumer_evidence_receipt.get("forecast_registry_state"), "unknown"
    ).lower()
    blockers: list[str] = []
    if forecast_state not in _FORECAST_READY:
        blockers.append(f"forecast_registry_{forecast_state}")
    candidates = [
        *_strings(consumer_evidence_receipt.get("reason_codes")),
        *_profit_lease_blockers(live_submission_gate),
        *_strings(quality_adjusted_profit_frontier.get("blocked_capital_surfaces")),
    ]
    blockers.extend(
        reason
        for reason in candidates
        if any(fragment in reason for fragment in _PROMOTION_FRAGMENTS)
    )
    return _unique(blockers)


def _submit_blockers(
    *,
    live_submission_gate: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
) -> list[str]:
    blockers = [
        *_strings(live_submission_gate.get("blocked_reasons")),
        *_strings(live_submission_gate.get("blocking_reasons")),
        *_proof_blockers(proof_floor_receipt),
    ]
    reason = _text(live_submission_gate.get("reason"))
    if reason and live_submission_gate.get("allowed") is not True:
        blockers.append(reason)
    max_notional = _decimal(proof_floor_receipt.get("max_notional"))
    if (
        _text(proof_floor_receipt.get("route_state")) == "repair_only"
        and max_notional is not None
        and max_notional > 0
    ):
        blockers.append("capital_safety_invariant_repair_only_nonzero_notional")
    return _unique(blockers)


def _torghut_admission_blockers(ref: Mapping[str, Any]) -> list[str]:
    decision = _text(
        ref.get("decision") or ref.get("state") or ref.get("status"), "missing"
    ).lower()
    state = _text(ref.get("state") or ref.get("status") or decision, "missing").lower()
    blockers = _strings(
        ref.get("reason_codes") or ref.get("blocking_reasons") or ref.get("reasons")
    )
    if decision not in _ACCEPTED_STATES:
        blockers.append(f"torghut_routeability_admission_{decision}")
    if state in {"degraded", "missing", "stale"} and state != decision:
        blockers.append(f"torghut_routeability_admission_{state}")
    return _unique(blockers)


def _lot_state(blockers: Sequence[str]) -> str:
    if not blockers:
        return "accepted"
    if any(
        "capital_safety_invariant" in reason or "rejected" in reason
        for reason in blockers
    ):
        return "rejected"
    if any("missing" in reason or "empty" in reason for reason in blockers):
        return "missing"
    if any(
        "stale" in reason or "degraded" in reason or "lag" in reason
        for reason in blockers
    ):
        return "stale"
    if any(
        fragment in reason
        for reason in blockers
        for fragment in (
            "blocked",
            "disabled",
            "not_promotion",
            "repair_only",
            "zero_notional",
        )
    ):
        return "blocked"
    return "repairing"


def _lot(
    *,
    account: str | None,
    window: str | None,
    trading_mode: str,
    lot_type: str,
    value_gate: str,
    expected_gate_delta: str,
    required_receipts: Sequence[str],
    blockers: Sequence[str],
    acceptance_condition: str,
    next_repair_action: str,
    rollback_trigger: str,
    symbols: Sequence[str] = (),
    hypothesis_ids: Sequence[str] = (),
    source_identity: Mapping[str, object] | None = None,
) -> dict[str, object]:
    normalized_symbols = sorted(
        {_text(symbol).upper() for symbol in symbols if _text(symbol)}
    )
    normalized_hypotheses = sorted(
        {_text(item) for item in hypothesis_ids if _text(item)}
    )
    blocking_reason_codes = _unique(list(blockers))
    lot_id = _stable_ref(
        "routeability-repair-lot",
        {
            "account": account,
            "window": window,
            "trading_mode": trading_mode,
            "lot_type": lot_type,
            "symbols": normalized_symbols,
            "hypothesis_ids": normalized_hypotheses,
            "blockers": blocking_reason_codes,
        },
    )
    lot: dict[str, object] = {
        "lot_id": lot_id,
        "lot_type": lot_type,
        "symbols": normalized_symbols,
        "hypothesis_ids": normalized_hypotheses,
        "value_gate": value_gate,
        "current_state": _lot_state(blocking_reason_codes),
        "required_receipts": list(required_receipts),
        "blocking_reason_codes": blocking_reason_codes,
        "acceptance_condition": acceptance_condition,
        "expected_gate_delta": expected_gate_delta,
        "next_repair_action": next_repair_action,
        "paper_notional_limit": "0",
        "live_notional_limit": "0",
        "promotion_authority": False,
        "authority_semantics": "audit_only_until_source_backed_runtime_ledger_fill_proof",
        "rollback_trigger": rollback_trigger,
    }
    if source_identity is not None:
        lot["source_identity"] = dict(source_identity)
    return lot


def _aggregate_state(lots: Sequence[Mapping[str, Any]]) -> str:
    states = {_text(lot.get("current_state")) for lot in lots}
    for state in ("rejected", "blocked", "stale", "missing", "repairing"):
        if state in states:
            return state
    return "accepted"


def _fresh_until(
    consumer_evidence_receipt: Mapping[str, Any], generated_at: datetime
) -> str:
    return _text(
        consumer_evidence_receipt.get("fresh_until"),
        (generated_at + timedelta(seconds=_FRESHNESS_SECONDS)).isoformat(),
    )


def build_routeability_repair_acceptance_ledger(
    *,
    account_label: str | None,
    window: str | None,
    trading_mode: str,
    torghut_revision: str | None,
    revenue_repair_digest_ref: str,
    consumer_evidence_receipt: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    capital_reentry_cohort_ledger: Mapping[str, Any],
    quality_adjusted_profit_frontier: Mapping[str, Any],
    profit_repair_settlement_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    live_submission_gate: Mapping[str, Any],
    quant_evidence: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    torghut_routeability_admission_ref: Mapping[str, Any],
    now: datetime | None = None,
) -> dict[str, object]:
    """Build an observe-only acceptance ledger for routeability repair lots."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    _ = market_context_status
    generated_at = observed_at.isoformat()
    account = account_label or _text(proof_floor_receipt.get("account_label")) or None
    route_rows = _rows(route_reacquisition_board)
    route_repair_rows = [
        row
        for row in route_rows
        if _row_state(row) in {"blocked", "missing", "probing"}
    ]
    alpha_rows = [row for row in route_rows if _strings(row.get("hypothesis_ids"))]
    quant_blockers = _quant_blockers(quant_evidence)
    alpha_blockers = _alpha_blockers(
        proof_floor_receipt=proof_floor_receipt,
        consumer_evidence_receipt=consumer_evidence_receipt,
    )
    route_blockers = _route_tca_blockers(
        proof_floor_receipt=proof_floor_receipt,
        route_reacquisition_board=route_reacquisition_board,
        rows=route_rows,
    )
    forecast_blockers = _forecast_blockers(
        consumer_evidence_receipt=consumer_evidence_receipt,
        live_submission_gate=live_submission_gate,
        quality_adjusted_profit_frontier=quality_adjusted_profit_frontier,
    )
    submit_blockers = _submit_blockers(
        live_submission_gate=live_submission_gate,
        proof_floor_receipt=proof_floor_receipt,
    )
    torghut_blockers = _torghut_admission_blockers(torghut_routeability_admission_ref)
    source_identity = _source_identity_contract(
        account=account,
        window=window,
        trading_mode=trading_mode,
        proof_floor_receipt=proof_floor_receipt,
        route_reacquisition_board=route_reacquisition_board,
        rows=route_rows,
        torghut_routeability_admission_ref=torghut_routeability_admission_ref,
    )
    source_identity_blockers = _strings(source_identity.get("blocking_reason_codes"))

    lots = [
        _lot(
            account=account,
            window=window,
            trading_mode=trading_mode,
            lot_type="quant_scoped_stage_repair",
            value_gate="zero_notional_or_stale_evidence_rate",
            expected_gate_delta="retire_missing_scoped_quant_pipeline_stages",
            required_receipts=[
                "scoped_quant_health_receipt",
                "quant_pipeline_stage_receipt",
            ],
            blockers=quant_blockers,
            acceptance_condition="scoped quant latest metrics and pipeline stages are current",
            next_repair_action="refresh_scoped_quant_pipeline_stage_receipts",
            rollback_trigger="routeability acceptance counts a candidate while scoped quant stages are missing",
        ),
        _lot(
            account=account,
            window=window,
            trading_mode=trading_mode,
            lot_type="alpha_readiness_repair",
            value_gate="routeable_candidate_count",
            expected_gate_delta="restore_promotion_eligible_hypothesis_for_routeability",
            required_receipts=[
                "alpha_readiness_receipt",
                "hypothesis_promotion_receipt",
            ],
            blockers=alpha_blockers,
            acceptance_condition="at least one scoped hypothesis is promotion eligible",
            next_repair_action="clear_alpha_readiness_blockers_before_routeable_candidate_claim",
            rollback_trigger="routeability ledger accepts a candidate with no promotion-eligible hypothesis",
            symbols=_symbols(alpha_rows),
            hypothesis_ids=_hypothesis_ids(alpha_rows),
        ),
        _lot(
            account=account,
            window=window,
            trading_mode=trading_mode,
            lot_type="route_universe_tca_repair",
            value_gate="fill_tca_or_slippage_quality",
            expected_gate_delta=f"settle_{len(route_repair_rows)}_route_tca_repair_rows",
            required_receipts=[
                "route_universe_receipt",
                "execution_tca_receipt",
                "slippage_guardrail_receipt",
            ],
            blockers=route_blockers,
            acceptance_condition="route/TCA rows are present, inside guardrail, and proof floor is not repair-only",
            next_repair_action="repair_route_universe_and_tca_before_routeability_count",
            rollback_trigger="routeable count increases from activity without route/TCA acceptance",
            symbols=_symbols(route_repair_rows),
            hypothesis_ids=_hypothesis_ids(route_repair_rows),
        ),
        _lot(
            account=account,
            window=window,
            trading_mode=trading_mode,
            lot_type="forecast_and_promotion_repair",
            value_gate="routeable_candidate_count",
            expected_gate_delta="restore_forecast_and_promotion_evidence_for_active_candidate",
            required_receipts=["forecast_registry_receipt", "promotion_table_receipt"],
            blockers=forecast_blockers,
            acceptance_condition="forecast registry and promotion evidence are eligible for the active candidate",
            next_repair_action="restore_forecast_registry_and_promotion_evidence",
            rollback_trigger="forecast repair bypasses alpha readiness or route/TCA acceptance",
        ),
        _lot(
            account=account,
            window=window,
            trading_mode=trading_mode,
            lot_type="submit_gate_hold",
            value_gate="capital_gate_safety",
            expected_gate_delta="keep_paper_and_live_submission_closed_until_acceptance_settles",
            required_receipts=["live_submission_gate_receipt", "proof_floor_receipt"],
            blockers=submit_blockers,
            acceptance_condition="simple submit and shared live gate are allowed only after proof floor leaves repair-only",
            next_repair_action="keep_submit_disabled_until_acceptance_lots_clear",
            rollback_trigger="simple submit opens while routeability acceptance is unsettled",
        ),
        _lot(
            account=account,
            window=window,
            trading_mode=trading_mode,
            lot_type="torghut_admission_witness",
            value_gate="capital_gate_safety",
            expected_gate_delta="require_current_torghut_routeability_admission_before_paper_candidate_claim",
            required_receipts=["torghut_routeability_admission"],
            blockers=torghut_blockers,
            acceptance_condition="Torghut routeability admission is current and allows the paper action class",
            next_repair_action="refresh_torghut_routeability_admission_witness",
            rollback_trigger="routeability ledger accepts a candidate without current Torghut admission",
        ),
        _lot(
            account=account,
            window=window,
            trading_mode=trading_mode,
            lot_type="source_identity_match",
            value_gate="routeable_candidate_count",
            expected_gate_delta="bind_routeability_acceptance_to_account_symbol_candidate_source_identity",
            required_receipts=[
                "route_source_identity_receipt",
                "torghut_routeability_admission",
            ],
            blockers=source_identity_blockers,
            acceptance_condition=(
                "route board, proof floor, and Torghut admission agree on "
                "account/window/mode/symbol/hypothesis/candidate lineage"
            ),
            next_repair_action="repair_route_source_identity_before_routeable_candidate_claim",
            rollback_trigger="routeability acceptance consumed with mismatched source identity",
            symbols=cast(Sequence[str], source_identity.get("route_symbols") or []),
            hypothesis_ids=cast(
                Sequence[str], source_identity.get("route_hypothesis_ids") or []
            ),
            source_identity=source_identity,
        ),
    ]

    aggregate_state = _aggregate_state(lots)
    accepted_routeable_candidate_count = (
        _int(
            _mapping(route_reacquisition_board.get("summary")).get(
                "capital_eligible_symbol_count"
            )
        )
        if aggregate_state == "accepted"
        else 0
    )
    aggregate_blockers = _unique(
        [
            _text(reason)
            for lot in lots
            for reason in _sequence(lot.get("blocking_reason_codes"))
        ]
    )
    unsettled_lot_count = sum(
        1 for lot in lots if _text(lot.get("current_state")) != "accepted"
    )
    zero_notional_lot_count = sum(
        1
        for lot in lots
        if _text(lot.get("paper_notional_limit")) == "0"
        and _text(lot.get("live_notional_limit")) == "0"
    )
    denominator = max(1, len(lots))
    ledger_id = _stable_ref(
        "routeability-acceptance-ledger",
        {
            "account": account,
            "window": window,
            "trading_mode": trading_mode,
            "torghut_revision": torghut_revision,
            "consumer_evidence_receipt_id": consumer_evidence_receipt.get("receipt_id"),
            "profit_repair_settlement_ledger_id": profit_repair_settlement_ledger.get(
                "ledger_id"
            ),
            "lot_ids": [_text(lot.get("lot_id")) for lot in lots],
            "aggregate_state": aggregate_state,
        },
    )
    return {
        "schema_version": ROUTEABILITY_REPAIR_ACCEPTANCE_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated_at,
        "fresh_until": _fresh_until(consumer_evidence_receipt, observed_at),
        "account": account,
        "window": window,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "revenue_repair_digest_ref": revenue_repair_digest_ref,
        "proof_floor_ref": _text(proof_floor_receipt.get("schema_version")),
        "capital_reentry_ref": capital_reentry_cohort_ledger.get("ledger_id"),
        "quality_frontier_ref": quality_adjusted_profit_frontier.get("frontier_id"),
        "profit_repair_settlement_ref": profit_repair_settlement_ledger.get(
            "ledger_id"
        ),
        "torghut_routeability_admission_ref": dict(torghut_routeability_admission_ref),
        "source_identity": source_identity,
        "lots": lots,
        "aggregate_state": aggregate_state,
        "aggregate_blocking_reason_codes": aggregate_blockers,
        "accepted_routeable_candidate_count": accepted_routeable_candidate_count,
        "promotion_authority": False,
        "authority_semantics": "audit_only_until_source_backed_runtime_ledger_fill_proof",
        "zero_notional_or_stale_evidence_rate": round(
            max(unsettled_lot_count, zero_notional_lot_count) / denominator,
            4,
        ),
        "next_safe_repair_actions": [
            _text(lot.get("next_repair_action"))
            for lot in lots
            if _text(lot.get("current_state")) != "accepted"
        ]
        or ["observe_routeability"],
        "summary": {
            "lot_count": len(lots),
            "accepted_lot_count": sum(
                1 for lot in lots if _text(lot.get("current_state")) == "accepted"
            ),
            "unsettled_lot_count": unsettled_lot_count,
            "zero_notional_lot_count": zero_notional_lot_count,
            "route_repair_symbol_count": len(_symbols(route_repair_rows)),
            "source_routeable_candidate_count": _int(
                _mapping(route_reacquisition_board.get("summary")).get(
                    "capital_eligible_symbol_count"
                )
            ),
        },
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "routeability_acceptance_consumption_enabled": False,
            "promotion_authority": False,
        },
    }


__all__ = [
    "ROUTEABILITY_REPAIR_ACCEPTANCE_LEDGER_SCHEMA_VERSION",
    "build_routeability_repair_acceptance_ledger",
]
