"""Add durable fencing for one trade-decision submission identity.

Revision ID: 0058_decision_submission_claims
Revises: 0057_generic_multifactor_machine
Create Date: 2026-07-11 00:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0058_decision_submission_claims"
down_revision = "0057_generic_multifactor_machine"
branch_labels = None
depends_on = None


def _create_claim_table() -> None:
    op.create_table(
        "trade_decision_submission_claims",
        sa.Column(
            "trade_decision_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
        ),
        sa.Column("account_label", sa.String(length=64), nullable=False),
        sa.Column("client_order_id", sa.String(length=128), nullable=False),
        sa.Column("claim_token", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "fencing_epoch",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column(
            "state",
            sa.String(length=32),
            nullable=False,
            server_default=sa.text("'claimed'"),
        ),
        sa.Column("claim_owner", sa.String(length=128), nullable=False),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("broker_io_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recovery_after", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "recovery_token",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column(
            "recovery_fencing_epoch",
            sa.BigInteger(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("recovery_owner", sa.String(length=128), nullable=True),
        sa.Column(
            "recovery_lease_started_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column(
            "recovery_lease_expires_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("recovery_checked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("recovery_observation_epoch", sa.BigInteger(), nullable=True),
        sa.Column("recovery_outcome", sa.String(length=32), nullable=True),
        sa.Column("recovery_evidence", sa.Text(), nullable=True),
        sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("release_reason", sa.Text(), nullable=True),
        sa.Column("broker_order_id", sa.String(length=128), nullable=True),
        sa.Column("broker_client_order_id", sa.String(length=128), nullable=True),
        sa.Column(
            "execution_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "state IN ('claimed', 'broker_io', 'submitted')",
            name="ck_td_submission_claim_state",
        ),
        sa.CheckConstraint(
            "fencing_epoch > 0",
            name="ck_td_submission_claim_fencing_epoch",
        ),
        sa.CheckConstraint(
            "recovery_fencing_epoch >= 0",
            name="ck_td_submission_claim_recovery_epoch",
        ),
        sa.CheckConstraint(
            "state NOT IN ('broker_io', 'submitted') OR "
            "(broker_io_started_at IS NOT NULL AND recovery_after IS NOT NULL)",
            name="ck_td_submission_claim_broker_io_metadata",
        ),
        sa.CheckConstraint(
            "state <> 'claimed' OR "
            "(broker_io_started_at IS NULL AND recovery_after IS NULL "
            "AND recovery_fencing_epoch = 0 AND recovery_token IS NULL "
            "AND recovery_owner IS NULL AND recovery_lease_started_at IS NULL "
            "AND recovery_lease_expires_at IS NULL "
            "AND recovery_checked_at IS NULL "
            "AND recovery_observation_epoch IS NULL "
            "AND recovery_outcome IS NULL AND recovery_evidence IS NULL "
            "AND broker_order_id IS NULL "
            "AND broker_client_order_id IS NULL AND execution_id IS NULL "
            "AND completed_at IS NULL)",
            name="ck_td_submission_claim_claimed_metadata",
        ),
        sa.CheckConstraint(
            "state <> 'broker_io' OR "
            "(broker_order_id IS NULL AND broker_client_order_id IS NULL "
            "AND execution_id IS NULL AND completed_at IS NULL)",
            name="ck_td_submission_claim_broker_io_terminal",
        ),
        sa.CheckConstraint(
            "state <> 'submitted' OR "
            "(broker_order_id IS NOT NULL "
            "AND broker_client_order_id IS NOT NULL "
            "AND broker_client_order_id = client_order_id "
            "AND execution_id IS NOT NULL AND completed_at IS NOT NULL)",
            name="ck_td_submission_claim_submitted_metadata",
        ),
        sa.CheckConstraint(
            "(recovery_fencing_epoch = 0 AND recovery_token IS NULL "
            "AND recovery_owner IS NULL AND recovery_lease_started_at IS NULL "
            "AND recovery_lease_expires_at IS NULL) OR "
            "(recovery_fencing_epoch > 0 AND recovery_token IS NOT NULL "
            "AND recovery_owner IS NOT NULL AND recovery_lease_started_at IS NOT NULL "
            "AND recovery_lease_expires_at IS NOT NULL "
            "AND state IN ('broker_io', 'submitted'))",
            name="ck_td_submission_claim_recovery_lease",
        ),
        sa.CheckConstraint(
            "(recovery_checked_at IS NULL "
            "AND recovery_observation_epoch IS NULL "
            "AND recovery_outcome IS NULL AND recovery_evidence IS NULL) OR "
            "(recovery_checked_at IS NOT NULL AND recovery_outcome IS NOT NULL "
            "AND recovery_evidence IS NOT NULL "
            "AND recovery_observation_epoch IS NOT NULL "
            "AND recovery_observation_epoch > 0 "
            "AND recovery_observation_epoch <= recovery_fencing_epoch)",
            name="ck_td_submission_claim_recovery_observation",
        ),
        sa.CheckConstraint(
            "recovery_outcome IS NULL "
            "OR (recovery_outcome = 'found' AND state = 'submitted') "
            "OR (recovery_outcome IN ('not_found', 'indeterminate') "
            "AND state IN ('broker_io', 'submitted'))",
            name="ck_td_submission_claim_recovery_outcome",
        ),
        sa.CheckConstraint(
            "(released_at IS NULL AND release_reason IS NULL) OR "
            "(released_at IS NOT NULL AND release_reason IS NOT NULL "
            "AND state = 'claimed' AND lease_expires_at <= released_at)",
            name="ck_td_submission_claim_release_metadata",
        ),
        sa.ForeignKeyConstraint(
            ["trade_decision_id"],
            ["trade_decisions.id"],
            name="fk_td_submission_claim_trade_decision",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            [
                "execution_id",
                "trade_decision_id",
                "account_label",
                "broker_client_order_id",
                "broker_order_id",
            ],
            [
                "executions.id",
                "executions.trade_decision_id",
                "executions.alpaca_account_label",
                "executions.client_order_id",
                "executions.alpaca_order_id",
            ],
            name="fk_td_submission_claim_execution_identity",
            ondelete="RESTRICT",
            onupdate="RESTRICT",
        ),
        sa.PrimaryKeyConstraint(
            "trade_decision_id",
            name="pk_trade_decision_submission_claims",
        ),
    )


def _create_claim_indexes() -> None:
    op.create_index(
        "uq_trade_decision_submission_claim_token",
        "trade_decision_submission_claims",
        ["claim_token"],
        unique=True,
    )
    op.create_index(
        "uq_trade_decision_submission_claim_account_client_order",
        "trade_decision_submission_claims",
        ["account_label", "client_order_id"],
        unique=True,
    )
    op.create_index(
        "uq_trade_decision_submission_recovery_token",
        "trade_decision_submission_claims",
        ["recovery_token"],
        unique=True,
    )
    op.create_index(
        "ix_trade_decision_submission_claim_state_lease",
        "trade_decision_submission_claims",
        ["state", "lease_expires_at"],
    )
    op.create_index(
        "ix_trade_decision_submission_claim_recovery_due",
        "trade_decision_submission_claims",
        ["state", "recovery_after", "recovery_lease_expires_at"],
    )


def _create_execution_identity_index() -> None:
    op.create_index(
        "uq_executions_submission_claim_identity",
        "executions",
        [
            "id",
            "trade_decision_id",
            "alpaca_account_label",
            "client_order_id",
            "alpaca_order_id",
        ],
        unique=True,
    )


def _create_transition_guards() -> None:
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_lock_submission_identities(identity_keys text[])
            RETURNS void
            LANGUAGE plpgsql
            AS $$
            DECLARE
                identity_lock bigint;
            BEGIN
                FOR identity_lock IN
                    SELECT DISTINCT hashtextextended(identity_key, 0) AS lock_key
                      FROM unnest(identity_keys) AS keys(identity_key)
                     WHERE identity_key IS NOT NULL
                     ORDER BY lock_key
                LOOP
                    PERFORM pg_advisory_xact_lock(identity_lock);
                END LOOP;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_submission_claim()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            DECLARE
                expected_account text;
                expected_client_id text;
                decision_status text;
                execution_decision_id uuid;
                execution_account text;
                execution_client_id text;
                execution_order_id text;
            BEGIN
                IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
                    RAISE EXCEPTION 'submission claim audit row cannot be deleted'
                        USING ERRCODE = '23514';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    PERFORM torghut_lock_submission_identities(
                        ARRAY[
                            'torghut:submission:decision:'
                                || NEW.trade_decision_id::text,
                            'torghut:submission:client:'
                                || NEW.account_label || chr(31)
                                || NEW.client_order_id
                        ]
                    );
                    SELECT alpaca_account_label, decision_hash, status
                      INTO expected_account, expected_client_id, decision_status
                      FROM trade_decisions
                     WHERE id = NEW.trade_decision_id
                       FOR UPDATE;
                    IF NOT FOUND THEN
                        RAISE EXCEPTION 'submission claim trade decision does not exist'
                            USING ERRCODE = '23503';
                    END IF;
                    IF NEW.account_label IS DISTINCT FROM expected_account
                       OR NEW.client_order_id IS DISTINCT FROM expected_client_id THEN
                        RAISE EXCEPTION 'submission claim decision identity mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                    IF NEW.state <> 'claimed' OR decision_status <> 'planned'
                       OR NEW.fencing_epoch <> 1
                       OR NEW.recovery_fencing_epoch <> 0 THEN
                        RAISE EXCEPTION 'submission claim must start planned and claimed'
                            USING ERRCODE = '23514';
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM executions
                         WHERE trade_decision_id = NEW.trade_decision_id
                            OR (alpaca_account_label = NEW.account_label
                                AND client_order_id = NEW.client_order_id)
                    ) THEN
                        RAISE EXCEPTION 'execution conflicts with new submission claim'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                END IF;

                IF NEW.trade_decision_id IS DISTINCT FROM OLD.trade_decision_id
                   OR NEW.account_label IS DISTINCT FROM OLD.account_label
                   OR NEW.client_order_id IS DISTINCT FROM OLD.client_order_id THEN
                    RAISE EXCEPTION 'submission claim identity is immutable'
                        USING ERRCODE = '23514';
                END IF;

                IF NEW.fencing_epoch < OLD.fencing_epoch
                   OR NEW.fencing_epoch > OLD.fencing_epoch + 1 THEN
                    RAISE EXCEPTION 'primary fencing epoch must be monotonic'
                        USING ERRCODE = '23514';
                ELSIF NEW.fencing_epoch = OLD.fencing_epoch
                      AND (NEW.claim_token IS DISTINCT FROM OLD.claim_token
                           OR NEW.claim_owner IS DISTINCT FROM OLD.claim_owner
                           OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at) THEN
                    RAISE EXCEPTION 'primary identity cannot change within an epoch'
                        USING ERRCODE = '23514';
                ELSIF NEW.fencing_epoch = OLD.fencing_epoch + 1
                      AND (OLD.state <> 'claimed' OR NEW.state <> 'claimed'
                           OR OLD.lease_expires_at > clock_timestamp()
                           OR NEW.lease_expires_at <= clock_timestamp()
                           OR NEW.claim_token IS NOT DISTINCT FROM OLD.claim_token) THEN
                    RAISE EXCEPTION 'invalid primary fencing takeover'
                        USING ERRCODE = '23514';
                END IF;
                IF OLD.state = 'claimed'
                   AND NEW.fencing_epoch = OLD.fencing_epoch
                   AND OLD.lease_expires_at <= clock_timestamp()
                   AND NEW IS DISTINCT FROM OLD THEN
                    RAISE EXCEPTION 'expired primary fence cannot mutate'
                        USING ERRCODE = '23514';
                END IF;

                IF NEW.recovery_fencing_epoch < OLD.recovery_fencing_epoch
                   OR NEW.recovery_fencing_epoch > OLD.recovery_fencing_epoch + 1 THEN
                    RAISE EXCEPTION 'recovery fencing epoch must be monotonic'
                        USING ERRCODE = '23514';
                ELSIF NEW.recovery_fencing_epoch = OLD.recovery_fencing_epoch
                      AND (NEW.recovery_token IS DISTINCT FROM OLD.recovery_token
                           OR NEW.recovery_owner IS DISTINCT FROM OLD.recovery_owner
                           OR NEW.recovery_lease_started_at
                              IS DISTINCT FROM OLD.recovery_lease_started_at) THEN
                    RAISE EXCEPTION 'recovery identity cannot change within an epoch'
                        USING ERRCODE = '23514';
                ELSIF NEW.recovery_fencing_epoch = OLD.recovery_fencing_epoch + 1
                      AND (OLD.state <> 'broker_io' OR NEW.state <> 'broker_io'
                           OR OLD.recovery_after IS NULL
                           OR OLD.recovery_after > clock_timestamp()
                           OR (OLD.recovery_lease_expires_at IS NOT NULL
                               AND OLD.recovery_lease_expires_at > clock_timestamp())
                           OR NEW.recovery_token IS NULL
                           OR NEW.recovery_lease_expires_at <= clock_timestamp()
                           OR NEW.recovery_token IS NOT DISTINCT FROM OLD.recovery_token) THEN
                    RAISE EXCEPTION 'invalid recovery fencing takeover'
                        USING ERRCODE = '23514';
                END IF;
                IF OLD.state = 'broker_io'
                   AND NEW.recovery_fencing_epoch = OLD.recovery_fencing_epoch
                   AND (NEW.recovery_checked_at
                           IS DISTINCT FROM OLD.recovery_checked_at
                        OR NEW.recovery_observation_epoch
                           IS DISTINCT FROM OLD.recovery_observation_epoch
                        OR NEW.recovery_outcome IS DISTINCT FROM OLD.recovery_outcome
                        OR NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence)
                   AND NEW.recovery_observation_epoch
                       IS DISTINCT FROM NEW.recovery_fencing_epoch THEN
                    RAISE EXCEPTION 'recovery observation epoch must match its writer'
                        USING ERRCODE = '23514';
                END IF;
                IF OLD.state = 'broker_io'
                   AND NEW.recovery_fencing_epoch = OLD.recovery_fencing_epoch
                   AND (NEW.recovery_after IS DISTINCT FROM OLD.recovery_after
                        OR NEW.recovery_lease_expires_at
                           IS DISTINCT FROM OLD.recovery_lease_expires_at
                        OR NEW.recovery_checked_at
                           IS DISTINCT FROM OLD.recovery_checked_at
                        OR NEW.recovery_observation_epoch
                           IS DISTINCT FROM OLD.recovery_observation_epoch
                        OR NEW.recovery_outcome IS DISTINCT FROM OLD.recovery_outcome
                        OR NEW.recovery_evidence IS DISTINCT FROM OLD.recovery_evidence)
                   AND (OLD.recovery_lease_expires_at IS NULL
                        OR OLD.recovery_lease_expires_at <= clock_timestamp()) THEN
                    RAISE EXCEPTION 'inactive recovery fence cannot mutate'
                        USING ERRCODE = '23514';
                END IF;

                IF OLD.state = 'claimed' AND NEW.state NOT IN ('claimed', 'broker_io') THEN
                    RAISE EXCEPTION 'invalid claimed submission transition'
                        USING ERRCODE = '23514';
                ELSIF OLD.state = 'broker_io'
                      AND NEW.state NOT IN ('broker_io', 'submitted') THEN
                    RAISE EXCEPTION 'broker I/O quarantine is irreversible'
                        USING ERRCODE = '23514';
                ELSIF OLD.state = 'submitted' AND NEW.state <> 'submitted' THEN
                    RAISE EXCEPTION 'submitted claim is terminal'
                        USING ERRCODE = '23514';
                END IF;

                IF OLD.state = 'claimed' AND NEW.state = 'broker_io' THEN
                    PERFORM torghut_lock_submission_identities(
                        ARRAY[
                            'torghut:submission:decision:'
                                || NEW.trade_decision_id::text,
                            'torghut:submission:client:'
                                || NEW.account_label || chr(31)
                                || NEW.client_order_id
                        ]
                    );
                    SELECT alpaca_account_label, decision_hash, status
                      INTO expected_account, expected_client_id, decision_status
                      FROM trade_decisions
                     WHERE id = NEW.trade_decision_id
                       FOR UPDATE;
                    IF NEW.account_label IS DISTINCT FROM expected_account
                       OR NEW.client_order_id IS DISTINCT FROM expected_client_id THEN
                        RAISE EXCEPTION 'submission claim decision identity mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                    IF decision_status <> 'planned' THEN
                        RAISE EXCEPTION 'non-planned decision cannot start broker I/O'
                            USING ERRCODE = '23514';
                    END IF;
                    IF OLD.lease_expires_at <= clock_timestamp() THEN
                        RAISE EXCEPTION 'expired primary fence cannot start broker I/O'
                            USING ERRCODE = '23514';
                    END IF;
                    IF NEW.claim_token IS DISTINCT FROM OLD.claim_token
                        OR NEW.fencing_epoch IS DISTINCT FROM OLD.fencing_epoch
                        OR NEW.claim_owner IS DISTINCT FROM OLD.claim_owner
                        OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
                        OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
                        RAISE EXCEPTION 'broker I/O must use the held primary fence'
                            USING ERRCODE = '23514';
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM executions
                         WHERE trade_decision_id = NEW.trade_decision_id
                            OR (alpaca_account_label = NEW.account_label
                                AND client_order_id = NEW.client_order_id)
                    ) THEN
                        RAISE EXCEPTION 'matching execution already exists at broker boundary'
                            USING ERRCODE = '23514';
                    END IF;
                END IF;

                IF OLD.state IN ('broker_io', 'submitted')
                   AND (NEW.claim_token IS DISTINCT FROM OLD.claim_token
                        OR NEW.fencing_epoch IS DISTINCT FROM OLD.fencing_epoch
                        OR NEW.claim_owner IS DISTINCT FROM OLD.claim_owner
                        OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at
                        OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
                        OR NEW.broker_io_started_at IS DISTINCT FROM OLD.broker_io_started_at) THEN
                    RAISE EXCEPTION 'primary broker I/O fence is immutable'
                        USING ERRCODE = '23514';
                END IF;

                IF OLD.state = 'submitted' AND NEW IS DISTINCT FROM OLD THEN
                    RAISE EXCEPTION 'submitted claim tombstone is immutable'
                        USING ERRCODE = '23514';
                END IF;

                IF OLD.state <> 'submitted' AND NEW.state = 'submitted' THEN
                    IF NEW.broker_client_order_id IS DISTINCT FROM NEW.client_order_id THEN
                        RAISE EXCEPTION 'terminal broker client identity mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                    SELECT trade_decision_id, alpaca_account_label,
                           client_order_id, alpaca_order_id
                      INTO execution_decision_id, execution_account,
                           execution_client_id, execution_order_id
                      FROM executions
                     WHERE id = NEW.execution_id;
                    IF NOT FOUND
                       OR execution_decision_id IS DISTINCT FROM NEW.trade_decision_id
                       OR execution_account IS DISTINCT FROM NEW.account_label
                       OR execution_client_id IS DISTINCT FROM NEW.client_order_id
                       OR execution_order_id IS DISTINCT FROM NEW.broker_order_id THEN
                        RAISE EXCEPTION 'terminal execution identity mismatch'
                            USING ERRCODE = '23514';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_td_submission_claim_truncate
            BEFORE TRUNCATE ON trade_decision_submission_claims
            FOR EACH STATEMENT EXECUTE FUNCTION torghut_guard_submission_claim()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_td_submission_claim
            BEFORE INSERT OR UPDATE OR DELETE ON trade_decision_submission_claims
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_submission_claim()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_trade_decision_claim()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF (NEW.alpaca_account_label IS DISTINCT FROM OLD.alpaca_account_label
                    OR NEW.decision_hash IS DISTINCT FROM OLD.decision_hash)
                   AND EXISTS (
                       SELECT 1 FROM trade_decision_submission_claims
                        WHERE trade_decision_id = OLD.id
                   ) THEN
                    RAISE EXCEPTION 'claimed trade decision identity is immutable'
                        USING ERRCODE = '23514';
                END IF;
                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_trade_decision_claim
            BEFORE UPDATE OF alpaca_account_label, decision_hash ON trade_decisions
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_trade_decision_claim()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE FUNCTION torghut_guard_claim_execution()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    PERFORM torghut_lock_submission_identities(
                        ARRAY[
                            CASE WHEN NEW.trade_decision_id IS NOT NULL THEN
                                'torghut:submission:decision:'
                                    || NEW.trade_decision_id::text
                            END,
                            CASE WHEN NEW.client_order_id IS NOT NULL THEN
                                'torghut:submission:client:'
                                    || NEW.alpaca_account_label || chr(31)
                                    || NEW.client_order_id
                            END
                        ]
                    );
                    IF EXISTS (
                        SELECT 1 FROM trade_decision_submission_claims
                         WHERE (
                             trade_decision_id = NEW.trade_decision_id
                             OR (account_label = NEW.alpaca_account_label
                                 AND client_order_id = NEW.client_order_id)
                         )
                         AND NOT (
                             state = 'broker_io'
                             AND trade_decision_id
                                 IS NOT DISTINCT FROM NEW.trade_decision_id
                             AND account_label
                                 IS NOT DISTINCT FROM NEW.alpaca_account_label
                             AND client_order_id
                                 IS NOT DISTINCT FROM NEW.client_order_id
                         )
                    ) THEN
                        RAISE EXCEPTION 'execution insert conflicts with submission claim'
                            USING ERRCODE = '23514';
                    END IF;
                    RETURN NEW;
                END IF;

                PERFORM torghut_lock_submission_identities(
                    ARRAY[
                        CASE WHEN OLD.trade_decision_id IS NOT NULL THEN
                            'torghut:submission:decision:'
                                || OLD.trade_decision_id::text
                        END,
                        CASE WHEN OLD.client_order_id IS NOT NULL THEN
                            'torghut:submission:client:'
                                || OLD.alpaca_account_label || chr(31)
                                || OLD.client_order_id
                        END,
                        CASE WHEN NEW.trade_decision_id IS NOT NULL THEN
                            'torghut:submission:decision:'
                                || NEW.trade_decision_id::text
                        END,
                        CASE WHEN NEW.client_order_id IS NOT NULL THEN
                            'torghut:submission:client:'
                                || NEW.alpaca_account_label || chr(31)
                                || NEW.client_order_id
                        END
                    ]
                );
                IF (NEW.trade_decision_id IS DISTINCT FROM OLD.trade_decision_id
                    OR NEW.id IS DISTINCT FROM OLD.id
                    OR NEW.alpaca_account_label IS DISTINCT FROM OLD.alpaca_account_label
                    OR NEW.client_order_id IS DISTINCT FROM OLD.client_order_id
                    OR NEW.alpaca_order_id IS DISTINCT FROM OLD.alpaca_order_id)
                   AND EXISTS (
                        SELECT 1 FROM trade_decision_submission_claims
                        WHERE execution_id IN (OLD.id, NEW.id)
                           OR trade_decision_id IN (
                               OLD.trade_decision_id,
                               NEW.trade_decision_id
                           )
                           OR (account_label = OLD.alpaca_account_label
                               AND client_order_id = OLD.client_order_id)
                           OR (account_label = NEW.alpaca_account_label
                               AND client_order_id = NEW.client_order_id)
                   ) THEN
                    RAISE EXCEPTION 'claimed execution identity is immutable'
                        USING ERRCODE = '23514';
                END IF;
                RETURN NEW;
            END;
            $$
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_claim_execution_insert
            BEFORE INSERT ON executions
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_claim_execution()
            """
        )
    )
    op.execute(
        sa.text(
            """
            CREATE TRIGGER trg_guard_claim_execution
            BEFORE UPDATE OF id, trade_decision_id, alpaca_account_label,
                             client_order_id, alpaca_order_id ON executions
            FOR EACH ROW EXECUTE FUNCTION torghut_guard_claim_execution()
            """
        )
    )


def upgrade() -> None:
    _create_execution_identity_index()
    _create_claim_table()
    _create_claim_indexes()
    _create_transition_guards()


def _drop_transition_guards() -> None:
    op.execute(sa.text("DROP TRIGGER trg_guard_claim_execution ON executions"))
    op.execute(sa.text("DROP TRIGGER trg_guard_claim_execution_insert ON executions"))
    op.execute(sa.text("DROP FUNCTION torghut_guard_claim_execution()"))
    op.execute(
        sa.text("DROP TRIGGER trg_guard_trade_decision_claim ON trade_decisions")
    )
    op.execute(sa.text("DROP FUNCTION torghut_guard_trade_decision_claim()"))
    op.execute(
        sa.text(
            "DROP TRIGGER trg_guard_td_submission_claim_truncate "
            "ON trade_decision_submission_claims"
        )
    )
    op.execute(
        sa.text(
            "DROP TRIGGER trg_guard_td_submission_claim "
            "ON trade_decision_submission_claims"
        )
    )
    op.execute(sa.text("DROP FUNCTION torghut_guard_submission_claim()"))
    op.execute(sa.text("DROP FUNCTION torghut_lock_submission_identities(text[])"))


def downgrade() -> None:
    op.execute(
        sa.text(
            "LOCK TABLE executions, trade_decision_submission_claims "
            "IN ACCESS EXCLUSIVE MODE NOWAIT"
        )
    )
    op.execute(
        sa.text(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM trade_decision_submission_claims) THEN
                    RAISE EXCEPTION
                        'refusing to downgrade nonempty submission claim tombstones';
                END IF;
            END;
            $$
            """
        )
    )
    _drop_transition_guards()
    op.drop_index(
        "ix_trade_decision_submission_claim_recovery_due",
        table_name="trade_decision_submission_claims",
    )
    op.drop_index(
        "ix_trade_decision_submission_claim_state_lease",
        table_name="trade_decision_submission_claims",
    )
    op.drop_index(
        "uq_trade_decision_submission_recovery_token",
        table_name="trade_decision_submission_claims",
    )
    op.drop_index(
        "uq_trade_decision_submission_claim_account_client_order",
        table_name="trade_decision_submission_claims",
    )
    op.drop_index(
        "uq_trade_decision_submission_claim_token",
        table_name="trade_decision_submission_claims",
    )
    op.drop_table("trade_decision_submission_claims")
    op.drop_index(
        "uq_executions_submission_claim_identity",
        table_name="executions",
    )
