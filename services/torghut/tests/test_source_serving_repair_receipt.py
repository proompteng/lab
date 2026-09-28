from __future__ import annotations

from datetime import datetime, timezone

from app.trading.source_serving_repair_receipt import (
    SOURCE_SERVING_REPAIR_RECEIPT_LEDGER_SCHEMA_VERSION,
    build_source_serving_repair_receipt_ledger,
)


NOW = datetime(2026, 5, 13, 8, 20, tzinfo=timezone.utc)
DIGEST = "sha256:" + "a" * 64


def _observed_contracts() -> dict[str, object]:
    return {
        "consumer_evidence_status": {
            "schema_version": "torghut.consumer-evidence-status.v1",
        },
        "consumer_evidence_receipt": {
            "schema_version": "torghut.consumer-evidence-receipt.v1",
            "receipt_id": "torghut-consumer-evidence:test",
        },
        "route_evidence_clearinghouse_packet": {
            "schema_version": "torghut.route-evidence-clearinghouse-packet.v1",
            "packet_id": "route-evidence-clearinghouse:test",
        },
        "repair_bid_settlement_ledger": {
            "schema_version": "torghut.repair-bid-settlement-ledger.v1",
            "ledger_id": "repair-bid-settlement-ledger:test",
        },
        "route_warrant_exchange": {
            "schema_version": "torghut.route-warrant-exchange.v1",
            "warrant_id": "route-warrant-exchange:test",
            "warrant_state": "paper_candidate",
            "max_notional": "25",
        },
    }


def _build(
    *,
    source_commit: str = "abc123",
    serving_commit: str = "abc123",
    serving_image_digest: str | None = DIGEST,
    manifest_image_digest: str | None = DIGEST,
    observed_contracts: dict[str, object] | None = None,
    warrant_state: str = "paper_candidate",
) -> dict[str, object]:
    contracts = observed_contracts or _observed_contracts()
    route_warrant = dict(contracts["route_warrant_exchange"])
    route_warrant["warrant_state"] = warrant_state
    repair_bid_settlement = contracts.get("repair_bid_settlement_ledger")
    clearinghouse_packet = contracts.get("route_evidence_clearinghouse_packet")
    return build_source_serving_repair_receipt_ledger(
        account_label="PA3SX7FYNUTF",
        window="15m",
        source_commit=source_commit,
        manifest_image_digest=manifest_image_digest,
        build={
            "commit": serving_commit,
            "image_digest": serving_image_digest,
            "active_revision": "torghut-00333",
        },
        observed_contract_payloads=contracts,
        route_warrant_exchange=route_warrant,
        repair_bid_settlement_ledger=repair_bid_settlement
        if isinstance(repair_bid_settlement, dict)
        else {},
        route_evidence_clearinghouse_packet=clearinghouse_packet
        if isinstance(clearinghouse_packet, dict)
        else {},
        now=NOW,
    )


def test_converged_source_serving_proof_preserves_warrant_notional() -> None:
    ledger = _build()

    assert (
        ledger["schema_version"] == SOURCE_SERVING_REPAIR_RECEIPT_LEDGER_SCHEMA_VERSION
    )
    assert ledger["source_serving_state"] == "converged"
    assert ledger["capital_decision"] == "observe"
    assert ledger["max_notional"] == "25"
    assert ledger["reason_codes"] == []
    assert ledger["summary"]["missing_contract_count"] == 0


def test_serving_build_mismatch_keeps_capital_zero_notional() -> None:
    ledger = _build(serving_commit="def456")

    assert ledger["source_serving_state"] == "source_ahead"
    assert ledger["capital_decision"] == "repair_only"
    assert ledger["max_notional"] == "0"
    assert "serving_build_commit_mismatch" in ledger["reason_codes"]
    assert {
        "value_gate": "capital_gate_safety",
        "reason_code": "serving_build_commit_mismatch",
        "capital_effect": "max_notional_held_at_zero",
    } in ledger["value_gate_impacts"]


def test_missing_serving_image_digest_keeps_capital_zero_notional() -> None:
    ledger = _build(serving_image_digest=None, manifest_image_digest=DIGEST)

    assert ledger["source_serving_state"] == "digest_unknown"
    assert ledger["capital_decision"] == "repair_only"
    assert ledger["max_notional"] == "0"
    assert "serving_image_digest_missing" in ledger["reason_codes"]


def test_missing_manifest_image_digest_keeps_capital_zero_notional() -> None:
    ledger = _build(serving_image_digest=DIGEST, manifest_image_digest=None)

    assert ledger["source_serving_state"] == "digest_unknown"
    assert ledger["capital_decision"] == "repair_only"
    assert ledger["max_notional"] == "0"
    assert "manifest_image_digest_missing" in ledger["reason_codes"]


def test_missing_required_contract_keeps_capital_zero_notional() -> None:
    contracts = _observed_contracts()
    contracts.pop("repair_bid_settlement_ledger")
    ledger = _build(observed_contracts=contracts)

    assert ledger["source_serving_state"] == "contract_missing"
    assert ledger["capital_decision"] == "repair_only"
    assert "repair_bid_settlement_ledger" in ledger["missing_contracts"]
    assert "missing_contract:repair_bid_settlement_ledger" in ledger["reason_codes"]


def test_schema_mismatch_keeps_capital_zero_notional() -> None:
    contracts = _observed_contracts()
    contracts["route_warrant_exchange"] = {
        **dict(contracts["route_warrant_exchange"]),
        "schema_version": "torghut.route-warrant-exchange.v0",
    }
    ledger = _build(observed_contracts=contracts)

    assert ledger["source_serving_state"] == "contract_missing"
    assert ledger["capital_decision"] == "repair_only"
    assert ledger["contract_schema_mismatches"] == [
        {
            "contract": "route_warrant_exchange",
            "expected_schema": "torghut.route-warrant-exchange.v1",
            "observed_schema": "torghut.route-warrant-exchange.v0",
        }
    ]
    assert "contract_schema_mismatch:route_warrant_exchange" in ledger["reason_codes"]


def test_repair_only_warrant_keeps_source_serving_ledger_repair_only() -> None:
    ledger = _build(warrant_state="repair_only")

    assert ledger["source_serving_state"] == "converged"
    assert ledger["capital_decision"] == "repair_only"
    assert ledger["max_notional"] == "0"
    assert "route_warrant_repair_only" in ledger["reason_codes"]
