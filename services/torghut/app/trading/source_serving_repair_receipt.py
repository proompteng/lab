"""Source-serving proof ledger for Torghut repair receipt promotion."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Any, cast


SOURCE_SERVING_REPAIR_RECEIPT_LEDGER_SCHEMA_VERSION = (
    "torghut.source-serving-repair-receipt-ledger.v1"
)

_FRESHNESS_SECONDS = 60
_ZERO_NOTIONAL = "0"
_DEFAULT_REQUIRED_CONTRACTS = {
    "consumer_evidence_status": "torghut.consumer-evidence-status.v1",
    "consumer_evidence_receipt": "torghut.consumer-evidence-receipt.v1",
    "route_evidence_clearinghouse_packet": "torghut.route-evidence-clearinghouse-packet.v1",
    "repair_bid_settlement_ledger": "torghut.repair-bid-settlement-ledger.v1",
    "route_warrant_exchange": "torghut.route-warrant-exchange.v1",
    "source_serving_repair_receipt_ledger": SOURCE_SERVING_REPAIR_RECEIPT_LEDGER_SCHEMA_VERSION,
}
_VALUE_GATE_BY_REASON = {
    "serving_build_commit_mismatch": "capital_gate_safety",
    "serving_build_commit_missing": "capital_gate_safety",
    "source_commit_missing": "capital_gate_safety",
    "manifest_image_digest_missing": "capital_gate_safety",
    "serving_image_digest_missing": "capital_gate_safety",
    "manifest_serving_image_digest_mismatch": "capital_gate_safety",
    "required_contract_missing": "zero_notional_or_stale_evidence_rate",
    "contract_schema_mismatch": "zero_notional_or_stale_evidence_rate",
    "route_warrant_repair_only": "routeable_candidate_count",
}


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
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _required_contracts(
    required_contracts: Mapping[str, object] | None,
) -> dict[str, str]:
    contracts = dict(_DEFAULT_REQUIRED_CONTRACTS)
    for contract_name, schema in _mapping(required_contracts).items():
        normalized_name = _text(contract_name)
        normalized_schema = _text(schema)
        if normalized_name and normalized_schema:
            contracts[normalized_name] = normalized_schema
    return contracts


def _observed_contracts(
    *,
    observed_contract_payloads: Mapping[str, object],
    include_self: bool,
) -> dict[str, str]:
    observed: dict[str, str] = {}
    for contract_name, payload in observed_contract_payloads.items():
        normalized_name = _text(contract_name)
        schema = _text(_mapping(payload).get("schema_version"))
        if normalized_name and schema:
            observed[normalized_name] = schema
    if include_self:
        observed["source_serving_repair_receipt_ledger"] = (
            SOURCE_SERVING_REPAIR_RECEIPT_LEDGER_SCHEMA_VERSION
        )
    return observed


def _source_serving_state(
    *,
    source_commit: str,
    serving_build_commit: str,
    manifest_image_digest: str,
    serving_image_digest: str,
    missing_contracts: Sequence[str],
    contract_schema_mismatches: Sequence[Mapping[str, object]],
) -> tuple[str, list[str]]:
    reasons: list[str] = []
    if not source_commit or source_commit == "unknown":
        reasons.append("source_commit_missing")
    if not serving_build_commit or serving_build_commit == "unknown":
        reasons.append("serving_build_commit_missing")
    if source_commit and serving_build_commit and source_commit != serving_build_commit:
        reasons.append("serving_build_commit_mismatch")
    if not manifest_image_digest:
        reasons.append("manifest_image_digest_missing")
    if not serving_image_digest:
        reasons.append("serving_image_digest_missing")
    if (
        manifest_image_digest
        and serving_image_digest
        and manifest_image_digest != serving_image_digest
    ):
        reasons.append("manifest_serving_image_digest_mismatch")
    if missing_contracts:
        reasons.append("required_contract_missing")
    if contract_schema_mismatches:
        reasons.append("contract_schema_mismatch")

    reason_set = set(reasons)
    if (
        "required_contract_missing" in reason_set
        or "contract_schema_mismatch" in reason_set
    ):
        return "contract_missing", _unique(reasons)
    if (
        "manifest_image_digest_missing" in reason_set
        or "serving_image_digest_missing" in reason_set
        or "manifest_serving_image_digest_mismatch" in reason_set
    ):
        return "digest_unknown", _unique(reasons)
    if "serving_build_commit_mismatch" in reason_set:
        return "source_ahead", _unique(reasons)
    if reason_set:
        return "unknown", _unique(reasons)
    return "converged", []


def _route_warrant_reasons(route_warrant_exchange: Mapping[str, Any]) -> list[str]:
    warrant_state = _text(route_warrant_exchange.get("warrant_state"), "missing")
    if warrant_state in {
        "paper_candidate",
        "live_candidate",
        "live_micro_candidate",
        "live_scale_candidate",
    }:
        return []
    return [f"route_warrant_{warrant_state}"]


def _value_gate_impacts(reason_codes: Sequence[str]) -> list[dict[str, object]]:
    impacts: list[dict[str, object]] = []
    for reason in reason_codes:
        normalized = reason.split(":", 1)[0]
        gate = _VALUE_GATE_BY_REASON.get(
            normalized, "zero_notional_or_stale_evidence_rate"
        )
        impacts.append(
            {
                "value_gate": gate,
                "reason_code": reason,
                "capital_effect": "max_notional_held_at_zero",
            }
        )
    return impacts


def _repair_receipt_bindings(
    *,
    repair_receipts: Sequence[Mapping[str, object]],
    ledger_ref: str,
    serving_build_commit: str,
    serving_image_digest: str,
    source_serving_state: str,
) -> list[dict[str, object]]:
    bindings: list[dict[str, object]] = []
    for receipt in repair_receipts:
        receipt_id = _text(receipt.get("receipt_id"))
        if not receipt_id:
            continue
        bindings.append(
            {
                "receipt_id": receipt_id,
                "receipt_schema": _text(receipt.get("schema_version"), "unknown"),
                "generated_at": receipt.get("generated_at"),
                "target_value_gate": receipt.get("value_gate"),
                "target_dependency": receipt.get("zero_notional_action")
                or receipt.get("target_dependency"),
                "source_serving_ledger_ref": ledger_ref,
                "serving_build_commit": serving_build_commit or None,
                "serving_image_digest": serving_image_digest or None,
                "required_input_contracts": _strings(
                    receipt.get("required_input_contracts")
                ),
                "produced_output_contracts": _strings(
                    receipt.get("produced_output_contracts")
                ),
                "stale_reasons_retired": _strings(receipt.get("stale_reasons_retired")),
                "stale_reasons_remaining": _strings(receipt.get("blocked_reasons")),
                "source_serving_state": source_serving_state,
                "max_notional": _ZERO_NOTIONAL,
                "routeable_candidate_delta": 0,
                "rollback_target": receipt.get("rollback_path")
                or "leave stale reason active and keep repair packet queued at max_notional=0",
            }
        )
    return bindings


def build_source_serving_repair_receipt_ledger(
    *,
    account_label: str,
    window: str,
    source_commit: str | None,
    source_ci_ref: str | None = None,
    manifest_commit: str | None = None,
    manifest_image_digest: str | None = None,
    argo_sync_revision: str | None = None,
    argo_health: str | None = None,
    build: Mapping[str, Any] | None = None,
    route_ref: str = "/trading/consumer-evidence",
    required_contracts: Mapping[str, object] | None = None,
    observed_contract_payloads: Mapping[str, object] | None = None,
    route_warrant_exchange: Mapping[str, Any] | None = None,
    repair_bid_settlement_ledger: Mapping[str, Any] | None = None,
    route_evidence_clearinghouse_packet: Mapping[str, Any] | None = None,
    repair_receipts: Sequence[Mapping[str, object]] | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Build a source-serving proof ledger without widening notional authority."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    build_payload = _mapping(build)
    warrant = _mapping(route_warrant_exchange)
    repair_bid_settlement = _mapping(repair_bid_settlement_ledger)
    clearinghouse_packet = _mapping(route_evidence_clearinghouse_packet)
    required = _required_contracts(required_contracts)
    observed = _observed_contracts(
        observed_contract_payloads=_mapping(observed_contract_payloads),
        include_self=True,
    )
    missing_contracts = [name for name in required if name not in observed]
    schema_mismatches = [
        {
            "contract": contract,
            "expected_schema": expected_schema,
            "observed_schema": observed[contract],
        }
        for contract, expected_schema in required.items()
        if contract in observed and observed[contract] != expected_schema
    ]
    source_ref = _text(source_commit)
    serving_build_commit = _text(build_payload.get("commit"))
    serving_image_digest = _text(build_payload.get("image_digest"))
    manifest_digest = _text(
        manifest_image_digest or build_payload.get("manifest_image_digest")
    )
    state, proof_reasons = _source_serving_state(
        source_commit=source_ref,
        serving_build_commit=serving_build_commit,
        manifest_image_digest=manifest_digest,
        serving_image_digest=serving_image_digest,
        missing_contracts=missing_contracts,
        contract_schema_mismatches=schema_mismatches,
    )
    reason_codes = _unique(
        [
            *proof_reasons,
            *[f"missing_contract:{contract}" for contract in missing_contracts],
            *[
                f"contract_schema_mismatch:{mismatch['contract']}"
                for mismatch in schema_mismatches
            ],
            *_route_warrant_reasons(warrant),
        ]
    )
    ledger_payload = {
        "account_label": account_label,
        "window": window,
        "source_commit": source_ref,
        "serving_build_commit": serving_build_commit,
        "serving_image_digest": serving_image_digest,
        "route_ref": route_ref,
        "source_serving_state": state,
        "missing_contracts": missing_contracts,
        "contract_schema_mismatches": schema_mismatches,
        "route_warrant_ref": warrant.get("warrant_id"),
    }
    ledger_id = _stable_ref("source-serving-repair-receipt-ledger", ledger_payload)
    bindings = _repair_receipt_bindings(
        repair_receipts=list(repair_receipts or ()),
        ledger_ref=ledger_id,
        serving_build_commit=serving_build_commit,
        serving_image_digest=serving_image_digest,
        source_serving_state=state,
    )
    route_warrant_state = _text(warrant.get("warrant_state"), "missing")
    max_notional = _text(warrant.get("max_notional"), _ZERO_NOTIONAL)
    capital_decision = "observe"
    if state != "converged" or route_warrant_state not in {
        "paper_candidate",
        "live_candidate",
        "live_micro_candidate",
        "live_scale_candidate",
    }:
        capital_decision = "repair_only"
        max_notional = _ZERO_NOTIONAL

    return {
        "schema_version": SOURCE_SERVING_REPAIR_RECEIPT_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": (
            generated_at + timedelta(seconds=_FRESHNESS_SECONDS)
        ).isoformat(),
        "account": account_label,
        "window": window,
        "source_commit": source_ref or None,
        "source_ci_ref": source_ci_ref,
        "manifest_commit": _text(manifest_commit) or None,
        "manifest_image_digest": manifest_digest or None,
        "argo_sync_revision": _text(argo_sync_revision) or None,
        "argo_health": _text(argo_health) or None,
        "serving_revision": build_payload.get("active_revision"),
        "serving_build_commit": serving_build_commit or None,
        "serving_image_digest": serving_image_digest or None,
        "route_ref": route_ref,
        "required_contracts": [
            {"contract": contract, "schema_version": schema_version}
            for contract, schema_version in required.items()
        ],
        "observed_contracts": [
            {"contract": contract, "schema_version": schema_version}
            for contract, schema_version in observed.items()
        ],
        "missing_contracts": missing_contracts,
        "contract_schema_mismatches": schema_mismatches,
        "route_warrant_ref": warrant.get("warrant_id"),
        "route_warrant_state": route_warrant_state,
        "repair_bid_settlement_ref": repair_bid_settlement.get("ledger_id"),
        "route_evidence_clearinghouse_ref": clearinghouse_packet.get("packet_id"),
        "repair_receipt_refs": [binding["receipt_id"] for binding in bindings],
        "repair_receipt_source_bindings": bindings,
        "source_serving_state": state,
        "capital_decision": capital_decision,
        "max_notional": max_notional
        if capital_decision != "repair_only"
        else _ZERO_NOTIONAL,
        "reason_codes": reason_codes,
        "value_gate_impacts": _value_gate_impacts(reason_codes),
        "summary": {
            "required_contract_count": len(required),
            "observed_contract_count": len(observed),
            "missing_contract_count": len(missing_contracts),
            "schema_mismatch_count": len(schema_mismatches),
            "repair_receipt_binding_count": len(bindings),
            "source_serving_state": state,
            "capital_decision": capital_decision,
        },
        "rollback_target": {
            "source_serving_ledger_consumption_enabled": False,
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "fallback_payload": "torghut.route-warrant-exchange.v1",
        },
    }


__all__ = [
    "SOURCE_SERVING_REPAIR_RECEIPT_LEDGER_SCHEMA_VERSION",
    "build_source_serving_repair_receipt_ledger",
]
