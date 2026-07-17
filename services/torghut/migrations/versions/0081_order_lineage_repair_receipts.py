"""Add append-only order-lineage repair receipts.

Revision ID: 0081_order_lineage_receipts
Revises: 0080_broker_econ_recon_freshness
Create Date: 2026-07-16 17:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import conv


revision = "0081_order_lineage_receipts"
down_revision = "0080_broker_econ_recon_freshness"
branch_labels = None
depends_on = None


_TABLE = "order_lineage_repair_receipts"
_GUARD = "torghut_guard_order_lineage_receipt_0081"
_ROW_TRIGGER = "trg_guard_order_lineage_receipt"
_TRUNCATE_TRIGGER = "trg_guard_order_lineage_receipt_truncate"


def _create_table() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("repair_version", sa.String(length=64), nullable=False),
        sa.Column("provider", sa.String(length=32), nullable=False),
        sa.Column("environment", sa.String(length=16), nullable=False),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("order_identity_sha256", sa.String(length=64), nullable=False),
        sa.Column("alpaca_order_id", sa.String(length=128), nullable=True),
        sa.Column("client_order_id", sa.String(length=128), nullable=True),
        sa.Column("classification", sa.String(length=32), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=False),
        sa.Column("execution_source", sa.String(length=32), nullable=False),
        sa.Column("source_first_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_last_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "evidence",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
        ),
        sa.Column("evidence_canonical_json", sa.Text(), nullable=False),
        sa.Column("evidence_sha256", sa.String(length=64), nullable=False),
        sa.Column(
            "promotion_authority_eligible",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("clock_timestamp()"),
        ),
        sa.CheckConstraint(
            "length(repair_version) BETWEEN 1 AND 64 "
            "AND length(provider) BETWEEN 1 AND 32 "
            "AND length(environment) BETWEEN 1 AND 16 "
            "AND length(account_label) BETWEEN 1 AND 64",
            name=conv("ck_order_lineage_receipt_scope"),
        ),
        sa.CheckConstraint(
            "order_identity_sha256 ~ '^[0-9a-f]{64}$' "
            "AND evidence_sha256 ~ '^[0-9a-f]{64}$'",
            name=conv("ck_order_lineage_receipt_hashes"),
        ),
        sa.CheckConstraint(
            "alpaca_order_id IS NOT NULL OR client_order_id IS NOT NULL",
            name=conv("ck_order_lineage_receipt_order_identity"),
        ),
        sa.CheckConstraint(
            "classification IN ('complete', 'linked_incomplete', "
            "'external_or_unproved', 'ambiguous', 'broker_activity_only', "
            "'order_feed_only')",
            name=conv("ck_order_lineage_receipt_classification"),
        ),
        sa.CheckConstraint(
            "confidence IN ('exact', 'unproved', 'ambiguous')",
            name=conv("ck_order_lineage_receipt_confidence"),
        ),
        sa.CheckConstraint(
            "execution_source IN ('local', 'canonical_cross_dsn', 'none')",
            name=conv("ck_order_lineage_receipt_execution_source"),
        ),
        sa.CheckConstraint(
            "source_first_at <= source_last_at",
            name=conv("ck_order_lineage_receipt_source_window"),
        ),
        sa.CheckConstraint(
            "promotion_authority_eligible IS FALSE",
            name=conv("ck_order_lineage_receipt_non_promotional"),
        ),
        sa.CheckConstraint(
            "(classification IN ('complete', 'linked_incomplete') "
            "AND confidence = 'exact' AND execution_source <> 'none') OR "
            "(classification = 'ambiguous' AND confidence = 'ambiguous' "
            "AND execution_source = 'none') OR "
            "(classification IN ('external_or_unproved', 'broker_activity_only', "
            "'order_feed_only') AND confidence = 'unproved' "
            "AND execution_source = 'none')",
            name=conv("ck_order_lineage_receipt_classification_confidence"),
        ),
        sa.PrimaryKeyConstraint("id", name=conv("pk_order_lineage_repair_receipts")),
    )
    op.create_index(
        "uq_order_lineage_receipt_evidence",
        _TABLE,
        ["order_identity_sha256", "repair_version", "evidence_sha256"],
        unique=True,
    )
    op.create_index(
        "ix_order_lineage_receipt_current",
        _TABLE,
        [
            "repair_version",
            "order_identity_sha256",
            "source_last_at",
            "created_at",
        ],
    )
    op.create_index(
        "ix_order_lineage_receipt_classification",
        _TABLE,
        ["repair_version", "classification", "confidence"],
    )


def _create_guard() -> None:
    op.execute(
        sa.text(
            f"""
            CREATE FUNCTION {_GUARD}()
            RETURNS trigger LANGUAGE plpgsql AS $$
            DECLARE
                evidence_document jsonb;
                blockers jsonb;
                match_basis jsonb;
                order_event_ids jsonb;
                fill_order_event_ids jsonb;
                broker_activity_ids jsonb;
                broker_fill_activity_ids jsonb;
                order_event_count bigint;
                fill_order_event_count bigint;
                broker_activity_count bigint;
                broker_fill_count bigint;
                execution_id text;
                trade_decision_id text;
                strategy_id text;
                submission_claim_id text;
                tca_metric_id text;
                expected_primary_order_id_kind text;
                expected_primary_order_id text;
            BEGIN
                IF TG_OP IN ('UPDATE', 'DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'order lineage repair receipt is append-only'
                        USING ERRCODE = '23514';
                END IF;
                BEGIN
                    evidence_document := NEW.evidence_canonical_json::jsonb;
                EXCEPTION WHEN invalid_text_representation THEN
                    RAISE EXCEPTION 'order lineage repair evidence JSON is invalid'
                        USING ERRCODE = '23514';
                END;
                IF evidence_document IS DISTINCT FROM NEW.evidence THEN
                    RAISE EXCEPTION 'order lineage repair evidence identity mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF NEW.evidence_sha256 IS DISTINCT FROM encode(
                    sha256(convert_to(NEW.evidence_canonical_json, 'UTF8')),
                    'hex'
                ) THEN
                    RAISE EXCEPTION 'order lineage repair evidence hash mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF evidence_document->>'schema_version'
                       IS DISTINCT FROM 'torghut.order-lineage-repair-evidence.v1'
                   OR evidence_document->>'repair_version'
                       IS DISTINCT FROM NEW.repair_version
                   OR evidence_document->>'classification'
                       IS DISTINCT FROM NEW.classification
                   OR evidence_document->>'confidence'
                       IS DISTINCT FROM NEW.confidence
                   OR evidence_document->>'execution_source'
                       IS DISTINCT FROM NEW.execution_source
                   OR (evidence_document->>'promotion_authority_eligible')::boolean
                       IS DISTINCT FROM NEW.promotion_authority_eligible THEN
                    RAISE EXCEPTION 'order lineage repair evidence contract mismatch'
                        USING ERRCODE = '23514';
                END IF;
                IF evidence_document#>>'{{order_identity,provider}}'
                       IS DISTINCT FROM NEW.provider
                   OR evidence_document#>>'{{order_identity,environment}}'
                       IS DISTINCT FROM NEW.environment
                   OR evidence_document#>>'{{order_identity,account_label}}'
                       IS DISTINCT FROM NEW.account_label
                   OR NULLIF(evidence_document#>>'{{order_identity,alpaca_order_id}}', '')
                       IS DISTINCT FROM NEW.alpaca_order_id
                   OR NULLIF(evidence_document#>>'{{order_identity,client_order_id}}', '')
                       IS DISTINCT FROM NEW.client_order_id
                   OR evidence_document#>>'{{order_identity,sha256}}'
                       IS DISTINCT FROM NEW.order_identity_sha256 THEN
                    RAISE EXCEPTION 'order lineage repair order identity mismatch'
                        USING ERRCODE = '23514';
                END IF;

                expected_primary_order_id_kind := CASE
                    WHEN NEW.alpaca_order_id IS NOT NULL THEN 'alpaca_order_id'
                    ELSE 'client_order_id'
                END;
                expected_primary_order_id := COALESCE(
                    NEW.alpaca_order_id,
                    NEW.client_order_id
                );
                IF evidence_document#>>'{{order_identity,primary_order_id_kind}}'
                       IS DISTINCT FROM expected_primary_order_id_kind
                   OR evidence_document#>>'{{order_identity,primary_order_id}}'
                       IS DISTINCT FROM expected_primary_order_id THEN
                    RAISE EXCEPTION 'order lineage repair primary identity mismatch'
                        USING ERRCODE = '23514';
                END IF;

                IF NULLIF(evidence_document#>>'{{sources,first_at}}', '')::timestamptz
                       IS DISTINCT FROM NEW.source_first_at
                   OR NULLIF(evidence_document#>>'{{sources,last_at}}', '')::timestamptz
                       IS DISTINCT FROM NEW.source_last_at THEN
                    RAISE EXCEPTION 'order lineage repair source evidence mismatch'
                        USING ERRCODE = '23514';
                END IF;

                blockers := evidence_document->'blockers';
                match_basis := evidence_document->'match_basis';
                order_event_ids := evidence_document#>'{{sources,order_event_ids}}';
                fill_order_event_ids :=
                    evidence_document#>'{{sources,fill_order_event_ids}}';
                broker_activity_ids :=
                    evidence_document#>'{{sources,broker_activity_ids}}';
                broker_fill_activity_ids :=
                    evidence_document#>'{{sources,broker_fill_activity_ids}}';
                IF jsonb_typeof(blockers) IS DISTINCT FROM 'array'
                   OR jsonb_typeof(match_basis) IS DISTINCT FROM 'array'
                   OR jsonb_typeof(order_event_ids) IS DISTINCT FROM 'array'
                   OR jsonb_typeof(fill_order_event_ids) IS DISTINCT FROM 'array'
                   OR jsonb_typeof(broker_activity_ids) IS DISTINCT FROM 'array'
                   OR jsonb_typeof(broker_fill_activity_ids) IS DISTINCT FROM 'array'
                THEN
                    RAISE EXCEPTION 'order lineage repair evidence arrays missing'
                        USING ERRCODE = '23514';
                END IF;

                order_event_count := jsonb_array_length(order_event_ids);
                fill_order_event_count := jsonb_array_length(fill_order_event_ids);
                broker_activity_count := jsonb_array_length(broker_activity_ids);
                broker_fill_count := jsonb_array_length(broker_fill_activity_ids);
                IF (evidence_document#>>'{{sources,counts,order_events}}')::bigint
                       IS DISTINCT FROM order_event_count
                   OR (evidence_document#>>'{{sources,counts,fill_order_events}}')::bigint
                       IS DISTINCT FROM fill_order_event_count
                   OR (evidence_document#>>'{{sources,counts,broker_activities}}')::bigint
                       IS DISTINCT FROM broker_activity_count
                   OR (evidence_document#>>'{{sources,counts,broker_fills}}')::bigint
                       IS DISTINCT FROM broker_fill_count
                   OR NOT order_event_ids @> fill_order_event_ids
                   OR NOT broker_activity_ids @> broker_fill_activity_ids THEN
                    RAISE EXCEPTION 'order lineage repair source arrays mismatch'
                        USING ERRCODE = '23514';
                END IF;

                execution_id := NULLIF(
                    evidence_document#>>'{{links,execution_id}}', ''
                );
                trade_decision_id := NULLIF(
                    evidence_document#>>'{{links,trade_decision_id}}', ''
                );
                strategy_id := NULLIF(
                    evidence_document#>>'{{links,strategy_id}}', ''
                );
                submission_claim_id := NULLIF(
                    evidence_document#>>'{{links,submission_claim_id}}', ''
                );
                tca_metric_id := NULLIF(
                    evidence_document#>>'{{links,tca_metric_id}}', ''
                );
                PERFORM execution_id::uuid;
                PERFORM trade_decision_id::uuid;
                PERFORM strategy_id::uuid;
                PERFORM submission_claim_id::uuid;
                PERFORM tca_metric_id::uuid;

                IF (NEW.execution_source = 'none' AND (
                        execution_id IS NOT NULL
                        OR trade_decision_id IS NOT NULL
                        OR strategy_id IS NOT NULL
                        OR submission_claim_id IS NOT NULL
                        OR tca_metric_id IS NOT NULL
                    ))
                   OR (NEW.execution_source <> 'none' AND execution_id IS NULL)
                   OR (trade_decision_id IS NULL AND (
                        strategy_id IS NOT NULL OR submission_claim_id IS NOT NULL
                    )) THEN
                    RAISE EXCEPTION 'order lineage repair causal links invalid'
                        USING ERRCODE = '23514';
                END IF;

                IF NEW.classification = 'complete' THEN
                    IF trade_decision_id IS NULL
                       OR strategy_id IS NULL
                       OR submission_claim_id IS NULL
                       OR tca_metric_id IS NULL
                       OR order_event_count = 0
                       OR fill_order_event_count = 0
                       OR broker_fill_count = 0
                       OR jsonb_array_length(blockers) <> 0
                       OR jsonb_array_length(match_basis) = 0 THEN
                        RAISE EXCEPTION 'complete order lineage evidence is incomplete'
                            USING ERRCODE = '23514';
                    END IF;
                ELSIF jsonb_array_length(blockers) = 0 THEN
                    RAISE EXCEPTION 'incomplete order lineage blockers missing'
                        USING ERRCODE = '23514';
                END IF;

                IF NEW.classification IN ('linked_incomplete', 'ambiguous')
                   AND jsonb_array_length(match_basis) = 0 THEN
                    RAISE EXCEPTION 'order lineage match basis missing'
                        USING ERRCODE = '23514';
                END IF;
                IF (NEW.classification = 'broker_activity_only'
                        AND (order_event_count <> 0 OR broker_activity_count = 0))
                   OR (NEW.classification = 'order_feed_only'
                        AND (order_event_count = 0 OR broker_activity_count <> 0))
                   OR (NEW.classification = 'external_or_unproved'
                        AND (order_event_count = 0 OR broker_activity_count = 0))
                THEN
                    RAISE EXCEPTION 'order lineage source classification invalid'
                        USING ERRCODE = '23514';
                END IF;

                NEW.created_at := clock_timestamp();
                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER {_ROW_TRIGGER}
            BEFORE INSERT OR UPDATE OR DELETE ON {_TABLE}
            FOR EACH ROW EXECUTE FUNCTION {_GUARD}()
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            CREATE TRIGGER {_TRUNCATE_TRIGGER}
            BEFORE TRUNCATE ON {_TABLE}
            FOR EACH STATEMENT EXECUTE FUNCTION {_GUARD}()
            """
        )
    )


def upgrade() -> None:
    _create_table()
    _create_guard()


def downgrade() -> None:
    op.execute(sa.text(f"DROP TRIGGER {_TRUNCATE_TRIGGER} ON {_TABLE}"))
    op.execute(sa.text(f"DROP TRIGGER {_ROW_TRIGGER} ON {_TABLE}"))
    op.execute(sa.text(f"DROP FUNCTION {_GUARD}()"))
    op.drop_table(_TABLE)
