"""Keep whitepaper semantic embeddings at 4096 dimensions.

Revision ID: 0029_whitepaper_embedding_dimension_4096
Revises: 0028_autoresearch_epoch_ledgers
Create Date: 2026-04-26 13:50:00.000000
"""

from __future__ import annotations

from alembic import op


revision = "0029_whitepaper_embedding_dimension_4096"
down_revision = "0028_autoresearch_epoch_ledgers"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        DO $$
        DECLARE
          current_type text;
        BEGIN
          SELECT format_type(a.atttypid, a.atttypmod)
          INTO current_type
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'whitepaper_semantic_embeddings'
            AND a.attname = 'embedding';

          IF current_type IS DISTINCT FROM 'vector(4096)' THEN
            DELETE FROM whitepaper_semantic_embeddings;
            DROP INDEX IF EXISTS ix_whitepaper_semantic_embeddings_embedding_ivfflat;
            ALTER TABLE whitepaper_semantic_embeddings
              ALTER COLUMN embedding TYPE vector(4096)
              USING embedding::vector(4096);
          END IF;
        END $$;
        """
    )


def downgrade() -> None:
    op.execute(
        """
        DO $$
        DECLARE
          current_type text;
        BEGIN
          SELECT format_type(a.atttypid, a.atttypmod)
          INTO current_type
          FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'whitepaper_semantic_embeddings'
            AND a.attname = 'embedding';

          IF current_type IS DISTINCT FROM 'vector(1024)' THEN
            DELETE FROM whitepaper_semantic_embeddings;
            DROP INDEX IF EXISTS ix_whitepaper_semantic_embeddings_embedding_ivfflat;
            ALTER TABLE whitepaper_semantic_embeddings
              ALTER COLUMN embedding TYPE vector(1024)
              USING embedding::vector(1024);
            CREATE INDEX IF NOT EXISTS ix_whitepaper_semantic_embeddings_embedding_ivfflat
              ON whitepaper_semantic_embeddings
              USING ivfflat (embedding vector_cosine_ops)
              WITH (lists = 100);
          END IF;
        END $$;
        """
    )
