from __future__ import annotations

from typing import cast

from sqlalchemy import CheckConstraint, Table, UniqueConstraint

from app.models import BrokerMutationReceipt, BrokerMutationReceiptEvent


def _table(
    model: type[BrokerMutationReceipt] | type[BrokerMutationReceiptEvent],
) -> Table:
    return cast(Table, model.__table__)


def _checks(
    model: type[BrokerMutationReceipt] | type[BrokerMutationReceiptEvent],
) -> str:
    table = _table(model)
    return "\n".join(
        str(constraint.sqltext)
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
    )


def test_receipt_header_encodes_the_exact_broker_mutation_contract() -> None:
    table = _table(BrokerMutationReceipt)
    checks = _checks(BrokerMutationReceipt)

    assert "'alpaca', 'hyperliquid'" in checks
    assert "'submit_order', 'replace_order', 'cancel_order'" in checks
    assert "'inventory_conflict', 'opposite_side_cleanup'" in checks
    assert "'order', 'position', 'account'" in checks
    assert "purpose IN ('closeout', 'flatten')" in checks
    assert "risk_class = 'risk_reducing'" in checks
    assert "broker_route = 'hyperliquid' AND submission_claim_id IS NULL" in checks
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
    submit_claim = next(
        index for index in table.indexes if index.name == "uq_bm_receipt_submit_claim"
    )
    assert submit_claim.unique
    assert tuple(column.name for column in submit_claim.columns) == (
        "submission_claim_id",
    )
    assert "operation = 'submit_order'" in str(
        submit_claim.dialect_options["postgresql"]["where"]
    )


def test_event_model_keeps_recovery_and_settlement_evidence_separate() -> None:
    table = _table(BrokerMutationReceiptEvent)
    checks = _checks(BrokerMutationReceiptEvent)
    index_names = {index.name for index in table.indexes}

    assert {
        "released_at",
        "submission_claim_token",
        "submission_claim_fencing_epoch",
        "submission_claim_owner",
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
    assert "submission_claim_fencing_epoch > 0" in checks
    assert {
        "ix_broker_mutation_receipt_latest",
        "ix_broker_mutation_receipt_recovery_due",
    }.issubset(index_names)


def test_event_model_enforces_the_exact_settlement_contract() -> None:
    checks = _checks(BrokerMutationReceiptEvent)

    assert (
        "settlement_outcome = 'acknowledged' AND settlement_source = 'primary'"
        in checks
    )
    assert (
        "settlement_outcome IN ('reconciled', 'rejected') AND settlement_source IN "
        "('primary', 'recovery')" in checks
    )
    assert "settlement_outcome <> 'already_satisfied'" not in checks
    assert (
        "settlement_outcome NOT IN ('acknowledged', 'reconciled') OR "
        "broker_reference IS NOT NULL" in checks
    )


def test_receipt_foreign_keys_are_restrictive_audit_edges() -> None:
    foreign_keys = {
        foreign_key
        for model in (BrokerMutationReceipt, BrokerMutationReceiptEvent)
        for foreign_key in _table(model).foreign_keys
    }

    assert len(foreign_keys) == 3
    assert {foreign_key.ondelete for foreign_key in foreign_keys} == {"RESTRICT"}
    assert {foreign_key.onupdate for foreign_key in foreign_keys} == {"RESTRICT"}
