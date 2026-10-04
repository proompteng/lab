"""Route-evidence clearinghouse packet projection."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
import json
from typing import Any, cast

from .route_metadata import route_repair_recommendation


ROUTE_EVIDENCE_CLEARINGHOUSE_SCHEMA_VERSION = (
    "torghut.route-evidence-clearinghouse-packet.v1"
)
ROUTE_EVIDENCE_REPAIR_AUDIT_RECEIPT_SCHEMA_VERSION = (
    "torghut.route-evidence-repair-audit-receipt.v1"
)

_FRESHNESS_SECONDS = 60
_DEFAULT_TCA_MAX_AGE_SECONDS = 6 * 60 * 60
# fmt: off
_ZERO_NOTIONAL = {"", "0", "0.0", "0.00", "0.0000"}
_GOOD_STATES = {"accepted", "allow", "allowed", "current", "fresh", "funded", "ok", "pass", "ready"}
_BAD_STATES = {"block", "blocked", "degraded", "down", "expired", "fail", "failed", "hold", "missing", "stale"}
_TRUE_TEXT = {"1", "true", "yes", "on", "allow", "allowed", "ok", "ready"}
_FALSE_TEXT = {"0", "false", "no", "off", "block", "blocked", "degraded", "hold"}
_VALUE_GATES = ["post_cost_daily_net_pnl", "routeable_candidate_count", "zero_notional_or_stale_evidence_rate", "fill_tca_or_slippage_quality", "capital_gate_safety"]
# fmt: on


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


def _int(value: object, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(Decimal(str(value)))
    except (InvalidOperation, ValueError):
        return default


def _bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in _TRUE_TEXT:
            return True
        if normalized in _FALSE_TEXT:
            return False
    return default


def _strings(value: object) -> list[str]:
    return _unique([_text(item) for item in _sequence(value)])


def _unique(values: Sequence[str]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _utc(value: datetime) -> datetime:
    # fmt: off
    return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    # fmt: on


def _timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return _utc(value)
    text = _text(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _utc(parsed)


def _iso(value: datetime | None) -> str | None:
    return value.astimezone(timezone.utc).isoformat() if value else None


def _age_seconds(value: datetime | None, now: datetime) -> int | None:
    return None if value is None else max(0, int((now - value).total_seconds()))


def _ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _has_any(reason_codes: Sequence[str], tokens: Sequence[str]) -> bool:
    return any(any(token in reason for token in tokens) for reason in reason_codes)


def _book(
    name: str, reasons: Sequence[str], value_gate: str, details: Mapping[str, object]
) -> dict[str, object]:
    reason_codes = _unique(list(reasons))
    return {
        "book_id": _ref(name, {"reason_codes": reason_codes, "details": details}),
        "state": "current" if not reason_codes else "hold",
        "reason_codes": reason_codes,
        "value_gate": value_gate,
        "details": dict(details),
    }


def _claim_inputs(profit_signal_quorum: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    quorums = [
        _mapping(item)
        for item in _sequence(profit_signal_quorum.get("quorums"))
        if _mapping(item)
    ]
    if quorums:
        return quorums
    # fmt: off
    return [{"quorum_id": profit_signal_quorum.get("quorum_set_id"), "hypothesis_id": "aggregate", "decision": profit_signal_quorum.get("aggregate_decision"), "reason_codes": profit_signal_quorum.get("aggregate_reason_codes")}]
    # fmt: on


def _asset_class(claim: Mapping[str, Any]) -> str:
    raw = (
        claim.get("asset_class")
        or claim.get("assetClass")
        or _mapping(claim.get("window")).get("asset_class")
    )
    # fmt: off
    return "options" if _text(raw, "equity").lower() in {"option", "options"} else "equity"
    # fmt: on


def _claim_symbols(claim: Mapping[str, Any]) -> list[str]:
    route_tca_details = _mapping(_mapping(claim.get("route_tca_signal")).get("details"))
    nested_route_tca_details = _mapping(route_tca_details.get("details"))
    return _unique(
        [
            *[_text(symbol).upper() for symbol in _sequence(claim.get("symbols"))],
            *[
                _text(symbol).upper()
                for symbol in _sequence(route_tca_details.get("symbols"))
            ],
            *[
                _text(symbol).upper()
                for symbol in _sequence(nested_route_tca_details.get("symbols"))
            ],
        ]
    )


def _claim_route_tca_detail(route_tca_details: Mapping[str, Any], key: str) -> object:
    value = route_tca_details.get(key)
    if value is not None and value != "":
        return value
    nested_route_tca_details = _mapping(route_tca_details.get("details"))
    return nested_route_tca_details.get(key)


def _route_symbol_freshness(options: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    raw = options.get("route_symbol_freshness") or options.get("symbol_freshness")
    if isinstance(raw, Mapping):
        result: dict[str, Mapping[str, Any]] = {}
        for symbol, payload in cast(Mapping[object, object], raw).items():
            symbol_key = _text(symbol).upper()
            if symbol_key:
                result[symbol_key] = _mapping(payload)
        return result
    return {}


def _provider_updated_ts_missing(row: Mapping[str, Any]) -> bool:
    if _int(row.get("active_contracts"), -1) <= 0:
        return False
    return (
        _int(row.get("missing_provider_updated_ts_count")) > 0
        or row.get("provider_updated_ts_present") is False
    )


def _source_reasons_for_claim(
    options: Mapping[str, Any], claim: Mapping[str, Any]
) -> list[str]:
    if _asset_class(claim) != "options":
        return []
    route_symbols = _claim_symbols(claim)
    symbol_freshness = _route_symbol_freshness(options)
    scoped_symbols = {
        _text(symbol).upper() for symbol in _sequence(options.get("route_symbols"))
    }
    reasons: list[str] = []
    if route_symbols and (symbol_freshness or scoped_symbols):
        for symbol in route_symbols:
            symbol_row = symbol_freshness.get(symbol)
            if not symbol_row:
                reasons.append("options_route_symbol_catalog_missing")
                continue
            if _int(symbol_row.get("active_contracts"), -1) <= 0:
                reasons.append("options_catalog_active_contracts_missing")
            if _provider_updated_ts_missing(symbol_row):
                reasons.append("options_provider_updated_ts_missing")
            if _timestamp(symbol_row.get("newest_provider_updated_ts")) is None:
                reasons.append("options_provider_clock_missing")
            if _int(symbol_row.get("missing_close_price_count")) > 0:
                reasons.append("options_close_price_coverage_incomplete")
            if _int(symbol_row.get("zero_open_interest_count")) > 0:
                reasons.append("options_open_interest_coverage_incomplete")
        return _unique(reasons)

    provider_updated_at = _timestamp(options.get("newest_provider_updated_ts"))
    if _int(options.get("active_contracts"), -1) <= 0:
        reasons.append("options_catalog_active_contracts_missing")
    if (
        _int(options.get("missing_provider_updated_ts_count")) > 0
        or options.get("provider_updated_ts_present") is False
    ):
        reasons.append("options_provider_updated_ts_missing")
    if provider_updated_at is None:
        reasons.append("options_provider_clock_missing")
    if not route_symbols:
        if _int(options.get("missing_close_price_count")) > 0:
            reasons.append("options_close_price_coverage_incomplete")
        if _int(options.get("zero_open_interest_count")) > 0:
            reasons.append("options_open_interest_coverage_incomplete")
    return _unique(reasons)


def _source_book(
    options: Mapping[str, Any],
    claims: Sequence[Mapping[str, Any]],
    now: datetime,
    source_reasons_by_claim: Sequence[Sequence[str]],
) -> dict[str, object]:
    option_claim_count = sum(1 for claim in claims if _asset_class(claim) == "options")
    provider_updated_at = _timestamp(options.get("newest_provider_updated_ts"))
    last_seen_at = _timestamp(options.get("newest_last_seen_ts"))
    reasons = _unique(
        [
            reason
            for claim_reasons in source_reasons_by_claim
            for reason in claim_reasons
        ]
    )
    return _book(
        "source-freshness-book",
        reasons,
        "zero_notional_or_stale_evidence_rate",
        {
            "options_route_claim_count": option_claim_count,
            "options_catalog": dict(options),
            "route_symbol_freshness": dict(_route_symbol_freshness(options)),
            "options_last_seen_age_seconds": _age_seconds(last_seen_at, now),
            "options_provider_age_seconds": _age_seconds(provider_updated_at, now),
        },
    )


def _execution_book(
    tca: Mapping[str, Any], now: datetime, max_age_seconds: int
) -> dict[str, object]:
    computed_at = _timestamp(tca.get("last_computed_at") or tca.get("computed_at"))
    execution_at = _timestamp(tca.get("latest_execution_created_at"))
    computed_age = _age_seconds(computed_at, now)
    execution_age = _age_seconds(execution_at, now)
    missing_symbols = _strings(tca.get("missing_symbols"))
    reasons: list[str] = []
    if _int(tca.get("order_count")) <= 0:
        reasons.append("execution_tca_missing")
    if _int(tca.get("filled_execution_count")) <= 0 or execution_at is None:
        reasons.append("active_session_execution_samples_missing")
    elif execution_age is not None and execution_age > max_age_seconds:
        reasons.append("active_session_execution_samples_stale")
    if computed_at is None:
        reasons.append("execution_tca_computed_at_missing")
    elif computed_age is not None and computed_age > max_age_seconds:
        reasons.append("execution_tca_stale")
    if missing_symbols:
        reasons.append("execution_tca_symbol_coverage_missing")
    if (
        _int(
            tca.get("expected_shortfall_sample_count")
            or tca.get("expected_shortfall_count")
        )
        <= 0
    ):
        reasons.append("execution_tca_expected_shortfall_samples_missing_non_promoting")
    return _book(
        "execution-freshness-book",
        reasons,
        "fill_tca_or_slippage_quality",
        {
            "order_count": _int(tca.get("order_count")),
            "filled_execution_count": _int(tca.get("filled_execution_count")),
            "last_computed_at": _iso(computed_at),
            "latest_execution_created_at": _iso(execution_at),
            "computed_age_seconds": computed_age,
            "execution_age_seconds": execution_age,
            "max_age_seconds": max_age_seconds,
            "avg_abs_slippage_bps": tca.get("avg_abs_slippage_bps"),
            "missing_symbols": missing_symbols,
        },
    )


def _rollout_book(
    image_proof: Mapping[str, Any], build: Mapping[str, Any]
) -> dict[str, object]:
    digest = (
        image_proof.get("image_digest")
        or image_proof.get("imageDigest")
        or build.get("image_digest")
    )
    status = _text(image_proof.get("state") or image_proof.get("status")).lower()
    reasons = [
        *_strings(image_proof.get("reason_codes")),
        *_strings(image_proof.get("blocking_reasons")),
        *_strings(image_proof.get("image_pull_failures")),
    ]
    if status in _BAD_STATES:
        reasons.append(f"rollout_image_{status}")
    if not _text(digest):
        reasons.append("image_digest_missing")
    if image_proof.get("route_workloads_ok") is False:
        reasons.append("route_adjacent_workloads_degraded")
    elif "route_workloads_ok" not in image_proof:
        reasons.append("route_adjacent_workload_proof_missing")
    return _book(
        "rollout-image-book",
        reasons,
        "capital_gate_safety",
        {
            "image_digest": _text(digest) or None,
            "active_revision": image_proof.get("active_revision")
            or build.get("active_revision"),
            "route_workloads_ok": image_proof.get("route_workloads_ok"),
            "rollback_digest": image_proof.get("rollback_digest"),
        },
    )


def _profit_window_book(custody: Mapping[str, Any]) -> dict[str, object]:
    contract = _mapping(
        custody.get("profit_window_contract") or custody.get("contract") or custody
    )
    projection = _mapping(custody.get("profit_lease_projection") or custody)
    reasons = [
        *_strings(contract.get("blocking_reason_codes")),
        *_strings(projection.get("blocking_reason_codes")),
    ]
    for window in _sequence(contract.get("windows")):
        mapped = _mapping(window)
        decision = _text(mapped.get("decision")).lower()
        if decision and decision not in _GOOD_STATES:
            reasons.append(f"profit_window_{decision}")
        reasons.extend(_strings(mapped.get("reason_codes")))
    for lease in _sequence(projection.get("leases")):
        mapped = _mapping(lease)
        state = _text(
            mapped.get("state") or mapped.get("status") or mapped.get("decision")
        ).lower()
        if state and state not in _GOOD_STATES:
            reasons.append(f"profit_lease_{state}")
        reasons.extend(_strings(mapped.get("blocking_reason_codes")))
    return _book(
        "profit-window-custody-book",
        reasons,
        "capital_gate_safety",
        {
            "contract_schema_version": contract.get("schema_version"),
            "projection_schema_version": projection.get("schema_version"),
        },
    )


def _capital_book(
    proof_floor: Mapping[str, Any], gate: Mapping[str, Any]
) -> dict[str, object]:
    route_state = _text(proof_floor.get("route_state"), "unknown").lower()
    capital_state = _text(proof_floor.get("capital_state"), "unknown").lower()
    max_notional = _text(proof_floor.get("max_notional"), "0")
    reasons = [
        *_strings(proof_floor.get("blocking_reasons")),
        *_strings(gate.get("blocked_reasons")),
    ]
    if route_state in {"repair_only", "unknown"}:
        reasons.append(f"profitability_proof_floor_{route_state}")
    if capital_state in {"zero_notional", "unknown"}:
        reasons.append(f"capital_state_{capital_state}")
    if max_notional in _ZERO_NOTIONAL:
        reasons.append("max_notional_zero")
    if not _bool(gate.get("allowed")):
        reasons.append(_text(gate.get("reason"), "live_submission_gate_closed"))
    return _book(
        "capital-hold-book",
        reasons,
        "capital_gate_safety",
        {
            "route_state": route_state,
            "capital_state": capital_state,
            "max_notional": max_notional,
            "live_submission_allowed": _bool(gate.get("allowed")),
        },
    )


def _lineage_values(
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


def _source_identity(ledger: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(ledger.get("source_identity"))


def _lineage_mismatch_reason(
    *,
    expected: Sequence[str],
    observed: Sequence[str],
    missing_reason: str,
    mismatch_reason: str,
) -> str | None:
    expected_values = sorted({_text(item) for item in expected if _text(item)})
    observed_values = sorted({_text(item) for item in observed if _text(item)})
    if not expected_values:
        return None
    if not observed_values:
        return missing_reason
    return None if expected_values == observed_values else mismatch_reason


def _routeability_reasons(
    ledger: Mapping[str, Any],
    *,
    account_label: str,
    session_id: str,
    trading_mode: str,
) -> list[str]:
    if not ledger:
        return ["routeability_acceptance_ledger_missing"]
    state = _text(ledger.get("aggregate_state"), "unknown").lower()
    identity = _source_identity(ledger)
    reasons = [
        *_strings(ledger.get("aggregate_blocking_reason_codes")),
        *_strings(identity.get("blocking_reason_codes")),
    ]
    if state != "accepted":
        reasons.append(f"routeability_acceptance_{state}")

    ledger_account = _text(ledger.get("account") or identity.get("account"))
    ledger_window = _text(ledger.get("window") or identity.get("window"))
    ledger_mode = _text(ledger.get("trading_mode") or identity.get("trading_mode"))
    if not ledger_account:
        reasons.append("routeability_acceptance_account_missing")
    elif ledger_account != account_label:
        reasons.append("routeability_acceptance_account_mismatch")
    if not ledger_window:
        reasons.append("routeability_acceptance_window_missing")
    elif ledger_window != session_id:
        reasons.append("routeability_acceptance_window_mismatch")
    if not ledger_mode:
        reasons.append("routeability_acceptance_trading_mode_missing")
    elif ledger_mode != trading_mode:
        reasons.append("routeability_acceptance_trading_mode_mismatch")
    if ledger.get("promotion_authority") is True:
        reasons.append("routeability_acceptance_promotion_authority_must_be_false")

    return _unique(reasons)


def _routeability_claim_lineage_reasons(
    ledger: Mapping[str, Any], claim: Mapping[str, Any]
) -> list[str]:
    if not ledger:
        return []
    identity = _source_identity(ledger)
    reasons: list[str] = []
    claim_candidate_ids = _unique(
        [_text(claim.get("candidate_id"))] if _text(claim.get("candidate_id")) else []
    )
    ledger_candidate_ids = _lineage_values(
        identity, "route_candidate_ids", "candidate_ids", "candidateIds"
    )
    if reason := _lineage_mismatch_reason(
        expected=claim_candidate_ids,
        observed=ledger_candidate_ids,
        missing_reason="routeability_acceptance_candidate_lineage_missing",
        mismatch_reason="routeability_acceptance_candidate_lineage_mismatch",
    ):
        reasons.append(reason)

    claim_symbols = _claim_symbols(claim)
    ledger_symbols = _lineage_values(
        identity, "route_symbols", "symbols", uppercase=True
    )
    if reason := _lineage_mismatch_reason(
        expected=claim_symbols,
        observed=ledger_symbols,
        missing_reason="routeability_acceptance_symbol_scope_missing",
        mismatch_reason="routeability_acceptance_symbol_scope_mismatch",
    ):
        reasons.append(reason)
    return _unique(reasons)


def _profit_signal_reasons(quorum: Mapping[str, Any]) -> list[str]:
    decision = _text(quorum.get("aggregate_decision"), "unknown").lower()
    reasons = _strings(quorum.get("aggregate_reason_codes"))
    if decision not in {"paper_candidate", "paper_canary"}:
        reasons.append(f"profit_signal_quorum_{decision}")
    return _unique(reasons)


def _repair_class(reason: str) -> tuple[str, str]:
    if "provider" in reason or "options_" in reason or "source" in reason:
        return "source_freshness_repair", "zero_notional_or_stale_evidence_rate"
    if "tca" in reason or "execution" in reason or "slippage" in reason:
        return "execution_freshness_repair", "fill_tca_or_slippage_quality"
    if "image" in reason or "rollout" in reason or "workload" in reason:
        return "image_promotion_repair", "capital_gate_safety"
    if (
        "capital" in reason
        or "submit" in reason
        or "notional" in reason
        or "proof_floor" in reason
    ):
        return "capital_hold_repair", "capital_gate_safety"
    if "routeability" in reason or "quorum" in reason:
        return "routeability_acceptance_repair", "routeable_candidate_count"
    return "evidence_freshness_repair", "zero_notional_or_stale_evidence_rate"


def _repair_audit_receipt(
    *,
    reason: str,
    repair_class: str,
    value_gate: str,
    repair_recommendation: str,
) -> dict[str, object]:
    payload = {
        "reason": reason,
        "repair_class": repair_class,
        "value_gate": value_gate,
        "repair_recommendation": repair_recommendation,
    }
    return {
        "schema_version": ROUTE_EVIDENCE_REPAIR_AUDIT_RECEIPT_SCHEMA_VERSION,
        "receipt_id": _ref("route-evidence-repair-audit-receipt", payload),
        "state": "audit_only",
        "reason_codes": [reason],
        "repair_class": repair_class,
        "value_gate": value_gate,
        "repair_recommendation": repair_recommendation,
        "promotion_authority": False,
        "capital_authority": "none",
        "max_notional": "0",
        "requires_runtime_ledger_source_proof": True,
    }


def _repair_bid_book(reason_codes: Sequence[str]) -> dict[str, object]:
    bids: list[dict[str, object]] = []
    for reason in _unique(list(reason_codes)):
        repair_class, value_gate = _repair_class(reason)
        repair_recommendation = route_repair_recommendation(reason)
        payload = {
            "reason": reason,
            "repair_class": repair_class,
            "value_gate": value_gate,
            "repair_recommendation": repair_recommendation,
        }
        audit_receipt = _repair_audit_receipt(
            reason=reason,
            repair_class=repair_class,
            value_gate=value_gate,
            repair_recommendation=repair_recommendation,
        )
        bids.append(
            {
                "bid_id": _ref("route-evidence-repair-bid", payload),
                "lot_id": _ref("route-evidence-repair-lot", payload),
                "repair_class": repair_class,
                "value_gate": value_gate,
                "expected_gate_delta": f"retire_{reason}",
                "reason_codes": [reason],
                "max_notional": "0",
                "required_output_receipt": f"{repair_class}_receipt",
                "repair_recommendation": repair_recommendation,
                "audit_receipt": audit_receipt,
                "audit_receipt_ref": audit_receipt["receipt_id"],
                "promotion_authority": False,
                "capital_authority": "none",
            }
        )
    return {
        "book_id": _ref("repair-bid-book", {"reason_codes": list(reason_codes)}),
        "state": "current" if bids else "empty",
        "repair_bids": bids,
        "summary": {
            "bid_count": len(bids),
            "audit_receipt_count": len(bids),
            "value_gates": _unique([str(bid["value_gate"]) for bid in bids]),
        },
    }


def _route_claims(
    claims: Sequence[Mapping[str, Any]],
    *,
    common_reasons: Sequence[str],
    source_reasons_by_claim: Sequence[Sequence[str]],
    routeability_acceptance_ledger: Mapping[str, Any],
) -> list[dict[str, object]]:
    route_claims: list[dict[str, object]] = []
    for index, claim in enumerate(claims):
        route_tca_details = _mapping(
            _mapping(claim.get("route_tca_signal")).get("details")
        )
        route_symbols = _claim_symbols(claim)
        asset_class = _asset_class(claim)
        claim_source_reasons = (
            list(source_reasons_by_claim[index])
            if index < len(source_reasons_by_claim)
            else []
        )
        reasons = [
            *_strings(claim.get("reason_codes")),
            *common_reasons,
            *_routeability_claim_lineage_reasons(routeability_acceptance_ledger, claim),
        ]
        if asset_class == "options":
            reasons.extend(claim_source_reasons)
        reason_codes = _unique(reasons)
        has_execution_hold = _has_any(reason_codes, ("tca", "execution"))
        has_rollout_hold = _has_any(reason_codes, ("image", "workload"))
        has_profit_hold = _has_any(reason_codes, ("profit_window", "profit_lease"))
        has_capital_hold = _has_any(reason_codes, ("capital", "submit", "notional"))
        decision = (
            "accepted"
            if not reason_codes
            else "hold"
            if has_rollout_hold
            else "repair_only"
        )
        route_claims.append(
            {
                "route_id": claim.get("route_id")
                or _ref(
                    "route-claim",
                    {
                        "index": index,
                        "quorum_id": claim.get("quorum_id"),
                        "hypothesis_id": claim.get("hypothesis_id"),
                        "candidate_id": claim.get("candidate_id"),
                        "reason_codes": reason_codes,
                    },
                ),
                "hypothesis_id": claim.get("hypothesis_id"),
                "candidate_id": claim.get("candidate_id"),
                "strategy_id": claim.get("strategy_id"),
                "symbols": route_symbols,
                "asset_class": asset_class,
                "source_freshness_decision": "hold"
                if asset_class == "options" and claim_source_reasons
                else "current",
                "execution_freshness_decision": "hold"
                if has_execution_hold
                else "current",
                "rollout_image_decision": "hold" if has_rollout_hold else "current",
                "profit_window_decision": "hold" if has_profit_hold else "current",
                "capital_decision": "hold" if has_capital_hold else "observe_only",
                "post_cost_edge_estimate": _claim_route_tca_detail(
                    route_tca_details, "post_cost_expectancy_bps_proxy"
                ),
                "expected_repair_value": 0 if decision == "accepted" else 1,
                "repair_recommendations": [
                    route_repair_recommendation(reason) for reason in reason_codes
                ],
                "promotion_authority": False,
                "routeability_decision": decision,
                "max_notional": "0",
                "reason_codes": reason_codes,
            }
        )
    return route_claims


def build_route_evidence_clearinghouse_packet(
    *,
    account_label: str,
    session_id: str,
    trading_mode: str,
    torghut_revision: str | None,
    source_commit: str | None,
    build: Mapping[str, Any],
    proof_floor_receipt: Mapping[str, Any],
    profit_signal_quorum: Mapping[str, Any],
    profit_repair_settlement_ledger: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    profit_window_custody: Mapping[str, Any],
    tca_summary: Mapping[str, Any],
    options_catalog_freshness: Mapping[str, Any] | None = None,
    image_proof_summary: Mapping[str, Any] | None = None,
    routeability_acceptance_ledger: Mapping[str, Any] | None = None,
    live_submission_gate: Mapping[str, Any] | None = None,
    now: datetime | None = None,
    tca_max_age_seconds: int = _DEFAULT_TCA_MAX_AGE_SECONDS,
) -> dict[str, object]:
    """Build the observe-mode clearinghouse packet without widening capital."""

    observed_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    claim_inputs = _claim_inputs(profit_signal_quorum)
    options_freshness = _mapping(options_catalog_freshness)
    source_reasons_by_claim = [
        _source_reasons_for_claim(options_freshness, claim) for claim in claim_inputs
    ]
    source_book = _source_book(
        options_freshness,
        claim_inputs,
        observed_at,
        source_reasons_by_claim,
    )
    execution_book = _execution_book(tca_summary, observed_at, tca_max_age_seconds)
    rollout_book = _rollout_book(_mapping(image_proof_summary), build)
    profit_window_book = _profit_window_book(profit_window_custody)
    capital_book = _capital_book(proof_floor_receipt, _mapping(live_submission_gate))
    common_reasons = _unique(
        [
            *_strings(
                profit_repair_settlement_ledger.get("aggregate_blocking_reason_codes")
            ),
            *_strings(route_reacquisition_board.get("aggregate_blocking_reason_codes")),
            *cast(Sequence[str], execution_book["reason_codes"]),
            *cast(Sequence[str], rollout_book["reason_codes"]),
            *cast(Sequence[str], profit_window_book["reason_codes"]),
            *cast(Sequence[str], capital_book["reason_codes"]),
            *_routeability_reasons(
                _mapping(routeability_acceptance_ledger),
                account_label=account_label,
                session_id=session_id,
                trading_mode=trading_mode,
            ),
            *_profit_signal_reasons(profit_signal_quorum),
        ]
    )
    claims = _route_claims(
        claim_inputs,
        common_reasons=common_reasons,
        source_reasons_by_claim=source_reasons_by_claim,
        routeability_acceptance_ledger=_mapping(routeability_acceptance_ledger),
    )
    all_reasons = _unique(
        [
            *cast(Sequence[str], source_book["reason_codes"]),
            *common_reasons,
            *[
                reason
                for claim in claims
                for reason in cast(Sequence[str], claim.get("reason_codes") or [])
            ],
        ]
    )
    repair_book = _repair_bid_book(all_reasons)
    accepted_count = sum(
        1 for claim in claims if claim.get("routeability_decision") == "accepted"
    )
    stale_rate = round(min(1.0, len(all_reasons) / max(1, len(claims) + 4)), 4)
    packet_id = _ref(
        "route-evidence-clearinghouse",
        {
            "account_label": account_label,
            "session_id": session_id,
            "torghut_revision": torghut_revision,
            "accepted_count": accepted_count,
            "reason_codes": all_reasons,
        },
    )
    return {
        "schema_version": ROUTE_EVIDENCE_CLEARINGHOUSE_SCHEMA_VERSION,
        "packet_id": packet_id,
        "generated_at": observed_at.isoformat(),
        "fresh_until": (
            observed_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "account_id": account_label,
        "session_id": session_id,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "source_commit": source_commit,
        "torghut_image_proof_ref": rollout_book["book_id"],
        "routeability_acceptance_ledger_ref": _mapping(
            routeability_acceptance_ledger
        ).get("ledger_id"),
        "profit_window_custody_ref": profit_window_book["book_id"],
        "proof_floor_ref": proof_floor_receipt.get("schema_version"),
        "source_freshness_book_ref": source_book["book_id"],
        "execution_freshness_book_ref": execution_book["book_id"],
        "rollout_image_book_ref": rollout_book["book_id"],
        "capital_hold_book_ref": capital_book["book_id"],
        "repair_bid_book_ref": repair_book["book_id"],
        "source_freshness_book": source_book,
        "execution_freshness_book": execution_book,
        "rollout_image_book": rollout_book,
        "profit_window_custody_book": profit_window_book,
        "capital_hold_book": capital_book,
        "repair_bid_book": repair_book,
        "repair_audit_receipts": [
            bid["audit_receipt"]
            for bid in cast(Sequence[Mapping[str, object]], repair_book["repair_bids"])
        ],
        "route_claims": claims,
        "selected_repair_bids": repair_book["repair_bids"],
        "held_action_classes": []
        if accepted_count > 0 and not all_reasons
        else ["paper_canary", "live_micro_canary", "live_scale"],
        "accepted_routeable_candidate_count": accepted_count,
        "routeable_candidate_count": accepted_count,
        "zero_notional_or_stale_evidence_rate": stale_rate,
        "fill_tca_or_slippage_quality": {
            "state": execution_book["state"],
            "reason_codes": execution_book["reason_codes"],
            "details": execution_book["details"],
        },
        "capital_decision": "observe_only"
        if accepted_count > 0 and not capital_book["reason_codes"]
        else "repair_only",
        "promotion_authority": False,
        "authority_semantics": "audit_only_until_source_backed_runtime_ledger_fill_proof",
        "max_notional": "0",
        "summary": {
            "route_claim_count": len(claims),
            "accepted_routeable_candidate_count": accepted_count,
            "held_route_claim_count": len(claims) - accepted_count,
            "repair_bid_count": len(cast(Sequence[object], repair_book["repair_bids"])),
            "value_gates": _VALUE_GATES,
        },
        "rollback_target": {
            "route_evidence_clearinghouse_enforcement_enabled": False,
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "do_not_loosen_slippage_or_freshness_thresholds": True,
        },
    }


# fmt: off
__all__ = ["ROUTE_EVIDENCE_CLEARINGHOUSE_SCHEMA_VERSION", "build_route_evidence_clearinghouse_packet"]
# fmt: on
