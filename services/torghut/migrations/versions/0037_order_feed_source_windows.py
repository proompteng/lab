"""Add append-only order-feed source windows."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0037_order_feed_source_windows"
down_revision = "0036_order_feed_consumer_cursors"
branch_labels = None
depends_on = None


SOURCE_WINDOW_INDEXES = (
    (
        "ix_order_feed_source_windows_partition_offsets",
        ["source_topic", "source_partition", "start_offset", "end_offset"],
    ),
    (
        "ix_order_feed_source_windows_account_window",
        ["alpaca_account_label", "window_started_at", "window_ended_at"],
    ),
    ("ix_order_feed_source_windows_status", ["status"]),
    ("ix_order_feed_source_windows_created_at", ["created_at"]),
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if not inspector.has_table("order_feed_source_windows"):
        op.create_table(
            "order_feed_source_windows",
            sa.Column(
                "id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False
            ),
            sa.Column("consumer_group", sa.String(length=128), nullable=False),
            sa.Column("source_topic", sa.String(length=128), nullable=False),
            sa.Column("source_partition", sa.Integer(), nullable=False),
            sa.Column("alpaca_account_label", sa.String(length=64), nullable=False),
            sa.Column("assignment_mode", sa.String(length=32), nullable=False),
            sa.Column("collector_identity", sa.String(length=128), nullable=True),
            sa.Column("source_revision", sa.String(length=128), nullable=True),
            sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("window_ended_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("start_offset", sa.BigInteger(), nullable=False),
            sa.Column("end_offset", sa.BigInteger(), nullable=False),
            sa.Column("broker_high_watermark", sa.BigInteger(), nullable=True),
            sa.Column(
                "consumed_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "inserted_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "duplicate_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "malformed_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "missing_payload_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "missing_identity_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "out_of_scope_account_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "unlinked_execution_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "unlinked_decision_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "failed_unhandled_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "dropped_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "gap_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column("gap_ranges", postgresql.JSONB(), nullable=True),
            sa.Column("first_event_ts", sa.DateTime(timezone=True), nullable=True),
            sa.Column("last_event_ts", sa.DateTime(timezone=True), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False),
            sa.Column("status_reason", sa.String(length=128), nullable=True),
            sa.Column("payload_json", postgresql.JSONB(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
        )
        for index_name, columns in SOURCE_WINDOW_INDEXES:
            op.create_index(index_name, "order_feed_source_windows", columns)

    if inspector.has_table("execution_order_events"):
        event_columns = {
            column["name"] for column in inspector.get_columns("execution_order_events")
        }
        if "source_window_id" not in event_columns:
            op.add_column(
                "execution_order_events",
                sa.Column(
                    "source_window_id",
                    postgresql.UUID(as_uuid=True),
                    nullable=True,
                ),
            )
        event_indexes = {
            index["name"] for index in inspector.get_indexes("execution_order_events")
        }
        if "ix_execution_order_events_source_window_id" not in event_indexes:
            op.create_index(
                "ix_execution_order_events_source_window_id",
                "execution_order_events",
                ["source_window_id"],
            )
        event_foreign_keys = {
            foreign_key["name"]
            for foreign_key in inspector.get_foreign_keys("execution_order_events")
        }
        if "fk_execution_order_events_source_window_id" not in event_foreign_keys:
            op.create_foreign_key(
                "fk_execution_order_events_source_window_id",
                "execution_order_events",
                "order_feed_source_windows",
                ["source_window_id"],
                ["id"],
                ondelete="SET NULL",
            )

    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_feed_source_windows TO torghut_app;"
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.execution_order_events TO torghut_app;"
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if inspector.has_table("execution_order_events"):
        event_foreign_keys = {
            foreign_key["name"]
            for foreign_key in inspector.get_foreign_keys("execution_order_events")
        }
        if "fk_execution_order_events_source_window_id" in event_foreign_keys:
            op.drop_constraint(
                "fk_execution_order_events_source_window_id",
                "execution_order_events",
                type_="foreignkey",
            )
        event_indexes = {
            index["name"] for index in inspector.get_indexes("execution_order_events")
        }
        if "ix_execution_order_events_source_window_id" in event_indexes:
            op.drop_index(
                "ix_execution_order_events_source_window_id",
                table_name="execution_order_events",
            )
        event_columns = {
            column["name"] for column in inspector.get_columns("execution_order_events")
        }
        if "source_window_id" in event_columns:
            op.drop_column("execution_order_events", "source_window_id")

    if inspector.has_table("order_feed_source_windows"):
        op.execute(
            "REVOKE ALL PRIVILEGES ON TABLE public.order_feed_source_windows FROM torghut_app;"
        )
        existing_indexes = {
            index["name"]
            for index in inspector.get_indexes("order_feed_source_windows")
        }
        for index_name, _ in reversed(SOURCE_WINDOW_INDEXES):
            if index_name in existing_indexes:
                op.drop_index(index_name, table_name="order_feed_source_windows")
        op.drop_table("order_feed_source_windows")
