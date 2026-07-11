from __future__ import annotations

from sqlalchemy import CheckConstraint, UniqueConstraint

from app.models import BrokerMutationReceipt, BrokerMutationReceiptEvent


def _checks(
    model: type[BrokerMutationReceipt] | type[BrokerMutationReceiptEvent],
) -> str:
    table = model.__table__
    return "\n".join(
        str(constraint.sqltext)
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
    )


def test_receipt_header_encodes_the_exact_broker_mutation_contract() -> None:
    table = BrokerMutationReceipt.__table__
    checks = _checks(BrokerMutationReceipt)

    assert "'alpaca', 'hyperliquid'" in checks
    assert "'submit_order', 'replace_order', 'cancel_order'" in checks
    assert "'inventory_conflict', 'opposite_side_cleanup'" in checks
    assert "'order', 'position', 'account'" in checks
    assert "submission_claim_id IS NOT NULL" in checks
    assert "target_key = account_label" in checks

    client_identity = next(
        constraint
        for constraint in table.constraints
        if isinstance(constraint, UniqueConstraint)
        and constraint.name == "uq_broker_mutation_receipt_client"
    )
    assert tuple(column.name for column in client_identity.columns) == (
        "broker_route",
        "account_label",
        "endpoint_fingerprint",
        "operation",
        "client_request_id",
    )


def test_event_model_keeps_recovery_and_settlement_evidence_separate() -> None:
    table = BrokerMutationReceiptEvent.__table__
    checks = _checks(BrokerMutationReceiptEvent)

    assert {
        "released_at",
        "recovery_checked_at",
        "recovery_observation_epoch",
        "recovery_evidence_json",
        "recovery_evidence_sha256",
        "settlement_evidence_json",
        "settlement_evidence_sha256",
    }.issubset(table.c.keys())
    assert "settlement_outcome = 'already_satisfied'" in checks
    assert "settlement_source = 'preflight'" in checks
    assert "state <> 'broker_io'" in checks
    assert "state <> 'settled'" in checks


def test_receipt_foreign_keys_are_restrictive_audit_edges() -> None:
    foreign_keys = {
        foreign_key
        for model in (BrokerMutationReceipt, BrokerMutationReceiptEvent)
        for foreign_key in model.__table__.foreign_keys
    }

    assert len(foreign_keys) == 3
    assert {foreign_key.ondelete for foreign_key in foreign_keys} == {"RESTRICT"}
    assert {foreign_key.onupdate for foreign_key in foreign_keys} == {"RESTRICT"}
