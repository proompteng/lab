"""Add durable order-feed consumer cursors."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "0036_order_feed_consumer_cursors"
down_revision = "0035_widen_market_symbol_columns"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if not inspector.has_table("order_feed_consumer_cursors"):
        op.create_table(
            "order_feed_consumer_cursors",
            sa.Column(
                "id", postgresql.UUID(as_uuid=True), primary_key=True, nullable=False
            ),
            sa.Column("consumer_group", sa.String(length=128), nullable=False),
            sa.Column("source_topic", sa.String(length=128), nullable=False),
            sa.Column("source_partition", sa.Integer(), nullable=False),
            sa.Column("high_watermark_offset", sa.BigInteger(), nullable=False),
            sa.Column("last_event_fingerprint", sa.String(length=64), nullable=True),
            sa.Column("last_event_ts", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "processed_event_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "duplicate_event_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
            sa.Column(
                "offset_gap_count",
                sa.BigInteger(),
                server_default=sa.text("0"),
                nullable=False,
            ),
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
        op.create_index(
            "uq_order_feed_consumer_cursors_partition",
            "order_feed_consumer_cursors",
            ["consumer_group", "source_topic", "source_partition"],
            unique=True,
        )
        op.create_index(
            "ix_order_feed_consumer_cursors_updated_at",
            "order_feed_consumer_cursors",
            ["updated_at"],
        )

    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_feed_consumer_cursors TO torghut_app;"
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = inspect(bind)

    if inspector.has_table("order_feed_consumer_cursors"):
        op.execute(
            "REVOKE ALL PRIVILEGES ON TABLE public.order_feed_consumer_cursors FROM torghut_app;"
        )
        op.drop_index(
            "ix_order_feed_consumer_cursors_updated_at",
            table_name="order_feed_consumer_cursors",
        )
        op.drop_index(
            "uq_order_feed_consumer_cursors_partition",
            table_name="order_feed_consumer_cursors",
        )
        op.drop_table("order_feed_consumer_cursors")
