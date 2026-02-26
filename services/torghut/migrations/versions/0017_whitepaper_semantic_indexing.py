"""Add whitepaper semantic indexing tables for chunk and embedding search."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0017_whitepaper_semantic_indexing"
down_revision = "0016_whitepaper_engineering_triggers_and_rollout"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "whitepaper_semantic_chunks",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("analysis_run_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("document_version_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_scope", sa.String(length=32), nullable=False),
        sa.Column("section_key", sa.String(length=255), nullable=True),
        sa.Column("chunk_index", sa.BigInteger(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("token_count", sa.BigInteger(), nullable=True),
        sa.Column("metadata_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("text_tsvector", postgresql.TSVECTOR(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("source_scope IN ('full_text', 'synthesis')", name="ck_wp_semantic_chunks_source_scope"),
        sa.ForeignKeyConstraint(
            ["analysis_run_id"],
            ["whitepaper_analysis_runs.id"],
            name="fk_wp_semantic_chunks_analysis_run_id_wp_analysis_runs",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["document_version_id"],
            ["whitepaper_document_versions.id"],
            name="fk_wp_semantic_chunks_doc_ver_id_wp_doc_versions",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_whitepaper_semantic_chunks"),
    )
    op.create_index(
        "uq_whitepaper_semantic_chunks_run_scope_chunk",
        "whitepaper_semantic_chunks",
        ["analysis_run_id", "source_scope", "chunk_index"],
        unique=True,
    )
    op.create_index(
        "ix_whitepaper_semantic_chunks_analysis_run_scope",
        "whitepaper_semantic_chunks",
        ["analysis_run_id", "source_scope"],
    )
    op.create_index(
        "ix_whitepaper_semantic_chunks_content_sha256",
        "whitepaper_semantic_chunks",
        ["content_sha256"],
    )
    op.create_index(
        "ix_whitepaper_semantic_chunks_text_tsvector_gin",
        "whitepaper_semantic_chunks",
        ["text_tsvector"],
        postgresql_using="gin",
    )

    op.execute(
        """
        CREATE TABLE whitepaper_semantic_embeddings (
          id UUID PRIMARY KEY,
          semantic_chunk_id UUID NOT NULL
            REFERENCES whitepaper_semantic_chunks(id) ON DELETE CASCADE,
          model VARCHAR(255) NOT NULL,
          dimension BIGINT NOT NULL,
          embedding vector(1024) NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.create_index(
        "uq_whitepaper_semantic_embeddings_chunk_model_dimension",
        "whitepaper_semantic_embeddings",
        ["semantic_chunk_id", "model", "dimension"],
        unique=True,
    )
    op.create_index(
        "ix_whitepaper_semantic_embeddings_model_dimension",
        "whitepaper_semantic_embeddings",
        ["model", "dimension"],
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_whitepaper_semantic_embeddings_embedding_ivfflat
        ON whitepaper_semantic_embeddings
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_whitepaper_semantic_embeddings_embedding_ivfflat")
    op.drop_index(
        "ix_whitepaper_semantic_embeddings_model_dimension",
        table_name="whitepaper_semantic_embeddings",
    )
    op.drop_index(
        "uq_whitepaper_semantic_embeddings_chunk_model_dimension",
        table_name="whitepaper_semantic_embeddings",
    )
    op.drop_table("whitepaper_semantic_embeddings")

    op.drop_index(
        "ix_whitepaper_semantic_chunks_text_tsvector_gin",
        table_name="whitepaper_semantic_chunks",
    )
    op.drop_index(
        "ix_whitepaper_semantic_chunks_content_sha256",
        table_name="whitepaper_semantic_chunks",
    )
    op.drop_index(
        "ix_whitepaper_semantic_chunks_analysis_run_scope",
        table_name="whitepaper_semantic_chunks",
    )
    op.drop_index(
        "uq_whitepaper_semantic_chunks_run_scope_chunk",
        table_name="whitepaper_semantic_chunks",
    )
    op.drop_table("whitepaper_semantic_chunks")
