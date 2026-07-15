from __future__ import annotations

from typing import cast

from sqlalchemy import (
    CheckConstraint,
    Table,
    UniqueConstraint,
    create_mock_engine,
)

from app.models import BrokerMutationReceipt, BrokerMutationReceiptEvent
from app.models.entities.broker_mutation_validation_contract import (
    BROKER_MUTATION_VALIDATION_AUTHORITY_SQL,
    BROKER_MUTATION_VALIDATION_LINEAGE_SQL,
)
from tests.migration_testing import load_migration_module


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


def _normalized_sql(sql: str) -> str:
    return " ".join(sql.split())


def _assert_lifecycle_validation_invariants(sql: str) -> None:
    normalized = _normalized_sql(sql)

    assert "torghut.infrastructure-validation-order-plan.v1" in normalized
    assert "torghut.infrastructure-validation-lifecycle-plan.v1" in normalized
    assert "https://paper-api.alpaca.markets" in normalized
    assert "non_promotable_validation" in normalized
    assert "'{request,infrastructure_validation,permit,max_orders}' = '1'" in normalized
    assert (
        "'{request,infrastructure_validation,permit,max_outstanding_intents}' = '1'"
        in normalized
    )
    assert all(
        key in normalized
        for key in (
            "resting_close_limit_price",
            "replacement_close_limit_price",
            "partial_close_qty",
        )
    )
    assert "test_plan,partial_close_qty}')::numeric > 0" in normalized
    assert "test_plan,partial_close_qty}')::numeric <" in normalized
    assert "test_plan,replacement_close_limit_price}')::numeric >" in normalized
    assert "test_plan,resting_close_limit_price}')::numeric >" in normalized
    assert normalized.count("THEN 5 ELSE 1") == 2 or (
        normalized.count("permit,max_notional_usd}')::numeric <= 5") == 1
        and normalized.count("permit,max_loss_usd}')::numeric <= 5") == 1
        and normalized.count("permit,max_notional_usd}')::numeric <= 1") == 1
        and normalized.count("permit,max_loss_usd}')::numeric <= 1") == 1
    )


def _assert_lifecycle_lineage_invariants(sql: str) -> None:
    normalized = _normalized_sql(sql)

    assert (
        "operation IN ('submit_order', 'replace_order', 'cancel_order', "
        "'close_position', 'close_all_positions')" in normalized
    )
    assert "operation <> 'submit_order' OR (risk_class = 'risk_reducing'" in normalized
    assert "purpose = 'closeout' AND target_kind = 'order'" in normalized
    assert "torghut.infrastructure-validation-lineage.v1" in normalized
    assert "non_promotable_validation" in normalized
    assert all(
        key in normalized
        for key in (
            "root_receipt_id",
            "root_client_order_id",
            "parent_receipt_id",
            "parent_broker_order_id",
            "permit_id",
            "permit_sha256",
            "promotable",
        )
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


def test_receipt_header_mirrors_validation_authority_and_permit_guards() -> None:
    table = _table(BrokerMutationReceipt)
    validation_check = next(
        constraint
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
        and constraint.name == "ck_bm_receipt_validation_authority"
    )
    assert str(validation_check.sqltext).strip() == (
        BROKER_MUTATION_VALIDATION_AUTHORITY_SQL.strip()
    )
    lineage_check = next(
        constraint
        for constraint in table.constraints
        if isinstance(constraint, CheckConstraint)
        and constraint.name == "ck_bm_receipt_validation_lineage"
    )
    assert str(lineage_check.sqltext).strip() == (
        BROKER_MUTATION_VALIDATION_LINEAGE_SQL.strip()
    )

    validation_permit = next(
        index
        for index in table.indexes
        if index.name == "uq_bm_receipt_validation_permit"
    )
    assert validation_permit.unique
    assert "permit,permit_id" in str(validation_permit.expressions[0])
    assert "control_plane_validation" in str(
        validation_permit.dialect_options["postgresql"]["where"]
    )

    statements: list[str] = []
    engine = create_mock_engine(
        "postgresql+psycopg://",
        lambda statement, *_args, **_kwargs: statements.append(
            str(statement.compile(dialect=engine.dialect))
        ),
    )
    table.create(engine)
    ddl = "\n".join(statements)
    assert "CONSTRAINT ck_bm_receipt_validation_authority" in ddl
    assert "CONSTRAINT ck_bm_receipt_validation_lineage" in ddl
    assert "CREATE UNIQUE INDEX uq_bm_receipt_validation_permit" in ddl
    assert "non_promotable_validation" in ddl

    migration = load_migration_module("0072_infrastructure_validation_lifecycle.py")
    migration_validation_sql = str(getattr(migration, "_VALIDATION_AUTHORITY_0072"))
    migration_lineage_sql = str(getattr(migration, "_LINEAGE_CONTRACT_0072"))
    _assert_lifecycle_validation_invariants(BROKER_MUTATION_VALIDATION_AUTHORITY_SQL)
    _assert_lifecycle_validation_invariants(migration_validation_sql)
    _assert_lifecycle_lineage_invariants(BROKER_MUTATION_VALIDATION_LINEAGE_SQL)
    _assert_lifecycle_lineage_invariants(migration_lineage_sql)
    assert "torghut.infrastructure-validation-lifecycle-plan.v1" in ddl
    assert "operation IN ('submit_order', 'replace_order'" in ddl


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
        "ix_bm_receipt_event_broker_reference",
    }.issubset(index_names)
    broker_reference_index = next(
        index
        for index in table.indexes
        if index.name == "ix_bm_receipt_event_broker_reference"
    )
    assert tuple(column.name for column in broker_reference_index.columns) == (
        "broker_reference",
        "receipt_id",
    )
    assert (
        str(broker_reference_index.dialect_options["postgresql"]["where"])
        == "state = 'settled' AND broker_reference IS NOT NULL"
    )


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
