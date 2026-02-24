"""Add whitepaper workflow persistence tables for Inngest + AgentRun processing."""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = '0015_whitepaper_workflow_tables'
down_revision = '0014_trade_cursor_legacy_source_uniqueness_cleanup'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'whitepaper_documents',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('document_key', sa.String(length=64), nullable=False),
        sa.Column('source', sa.String(length=32), nullable=False, server_default=sa.text("'upload'")),
        sa.Column('source_identifier', sa.String(length=255), nullable=True),
        sa.Column('title', sa.String(length=512), nullable=True),
        sa.Column('abstract', sa.Text(), nullable=True),
        sa.Column('authors_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('published_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('language', sa.String(length=16), nullable=False, server_default=sa.text("'en'")),
        sa.Column('status', sa.String(length=32), nullable=False, server_default=sa.text("'uploaded'")),
        sa.Column('tags_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('metadata_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('ingested_by', sa.String(length=128), nullable=True),
        sa.Column('last_processed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_documents'),
        sa.UniqueConstraint('document_key', name='uq_whitepaper_documents_document_key'),
    )
    op.create_index('ix_whitepaper_documents_status', 'whitepaper_documents', ['status'])
    op.create_index('ix_whitepaper_documents_source', 'whitepaper_documents', ['source'])
    op.create_index(
        'uq_whitepaper_documents_source_identifier',
        'whitepaper_documents',
        ['source', 'source_identifier'],
        unique=True,
    )

    op.create_table(
        'whitepaper_document_versions',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('document_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('version_number', sa.BigInteger(), nullable=False),
        sa.Column('trigger_reason', sa.String(length=64), nullable=False, server_default=sa.text("'upload'")),
        sa.Column('file_name', sa.String(length=512), nullable=True),
        sa.Column(
            'mime_type',
            sa.String(length=128),
            nullable=False,
            server_default=sa.text("'application/pdf'"),
        ),
        sa.Column('file_size_bytes', sa.BigInteger(), nullable=True),
        sa.Column('checksum_sha256', sa.String(length=64), nullable=False),
        sa.Column('ceph_bucket', sa.String(length=128), nullable=False),
        sa.Column('ceph_object_key', sa.String(length=1024), nullable=False),
        sa.Column('ceph_etag', sa.String(length=128), nullable=True),
        sa.Column('parse_status', sa.String(length=32), nullable=False, server_default=sa.text("'pending'")),
        sa.Column('parse_error', sa.Text(), nullable=True),
        sa.Column('page_count', sa.BigInteger(), nullable=True),
        sa.Column('char_count', sa.BigInteger(), nullable=True),
        sa.Column('token_count', sa.BigInteger(), nullable=True),
        sa.Column('language', sa.String(length=16), nullable=True),
        sa.Column('upload_metadata_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('extraction_metadata_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('uploaded_by', sa.String(length=128), nullable=True),
        sa.Column('processed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['document_id'],
            ['whitepaper_documents.id'],
            name='fk_wp_doc_versions_doc_id_docs',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_document_versions'),
    )
    op.create_index('ix_whitepaper_document_versions_document_id', 'whitepaper_document_versions', ['document_id'])
    op.create_index('ix_whitepaper_document_versions_parse_status', 'whitepaper_document_versions', ['parse_status'])
    op.create_index('ix_whitepaper_document_versions_checksum', 'whitepaper_document_versions', ['checksum_sha256'])
    op.create_index(
        'uq_whitepaper_document_versions_document_version',
        'whitepaper_document_versions',
        ['document_id', 'version_number'],
        unique=True,
    )
    op.create_index(
        'uq_whitepaper_document_versions_ceph_object',
        'whitepaper_document_versions',
        ['ceph_bucket', 'ceph_object_key'],
        unique=True,
    )

    op.create_table(
        'whitepaper_contents',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('document_version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('text_source', sa.String(length=32), nullable=False, server_default=sa.text("'pdf_extract'")),
        sa.Column('full_text', sa.Text(), nullable=False),
        sa.Column('full_text_sha256', sa.String(length=64), nullable=False),
        sa.Column('section_index_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('references_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('tables_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('figures_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('chunk_manifest_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('extraction_warnings_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('quality_score', sa.Numeric(6, 4), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['document_version_id'],
            ['whitepaper_document_versions.id'],
            name='fk_wp_contents_doc_ver_id_doc_versions',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_contents'),
        sa.UniqueConstraint('document_version_id', name='uq_whitepaper_contents_document_version_id'),
    )
    op.create_index('ix_whitepaper_contents_full_text_sha256', 'whitepaper_contents', ['full_text_sha256'])

    op.create_table(
        'whitepaper_analysis_runs',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('run_id', sa.String(length=64), nullable=False),
        sa.Column('document_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('document_version_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('status', sa.String(length=32), nullable=False, server_default=sa.text("'queued'")),
        sa.Column('trigger_source', sa.String(length=32), nullable=False, server_default=sa.text("'upload'")),
        sa.Column('trigger_actor', sa.String(length=128), nullable=True),
        sa.Column('retry_of_run_id', sa.String(length=64), nullable=True),
        sa.Column('inngest_event_id', sa.String(length=128), nullable=True),
        sa.Column('inngest_function_id', sa.String(length=128), nullable=True),
        sa.Column('inngest_run_id', sa.String(length=128), nullable=True),
        sa.Column('orchestration_context_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('analysis_profile_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('request_payload_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('result_payload_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('failure_code', sa.String(length=128), nullable=True),
        sa.Column('failure_reason', sa.Text(), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['document_id'],
            ['whitepaper_documents.id'],
            name='fk_wp_analysis_runs_doc_id_docs',
            ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['document_version_id'],
            ['whitepaper_document_versions.id'],
            name='fk_wp_analysis_runs_doc_ver_id_doc_versions',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_analysis_runs'),
        sa.UniqueConstraint('run_id', name='uq_whitepaper_analysis_runs_run_id'),
        sa.UniqueConstraint('inngest_run_id', name='uq_whitepaper_analysis_runs_inngest_run_id'),
    )
    op.create_index('ix_whitepaper_analysis_runs_status', 'whitepaper_analysis_runs', ['status'])
    op.create_index('ix_whitepaper_analysis_runs_document_id', 'whitepaper_analysis_runs', ['document_id'])
    op.create_index(
        'ix_whitepaper_analysis_runs_document_version_id',
        'whitepaper_analysis_runs',
        ['document_version_id'],
    )
    op.create_index('ix_whitepaper_analysis_runs_inngest_event_id', 'whitepaper_analysis_runs', ['inngest_event_id'])
    op.create_index('ix_whitepaper_analysis_runs_created_at', 'whitepaper_analysis_runs', ['created_at'])

    op.create_table(
        'whitepaper_analysis_steps',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('analysis_run_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('step_name', sa.String(length=64), nullable=False),
        sa.Column('step_order', sa.BigInteger(), nullable=False, server_default=sa.text('0')),
        sa.Column('attempt', sa.BigInteger(), nullable=False, server_default=sa.text('1')),
        sa.Column('status', sa.String(length=32), nullable=False, server_default=sa.text("'queued'")),
        sa.Column('executor', sa.String(length=64), nullable=True),
        sa.Column('idempotency_key', sa.String(length=128), nullable=True),
        sa.Column('trace_id', sa.String(length=128), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('duration_ms', sa.BigInteger(), nullable=True),
        sa.Column('input_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('output_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('error_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['analysis_run_id'],
            ['whitepaper_analysis_runs.id'],
            name='fk_wp_analysis_steps_run_id_runs',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_analysis_steps'),
    )
    op.create_index('ix_whitepaper_analysis_steps_run_id', 'whitepaper_analysis_steps', ['analysis_run_id'])
    op.create_index('ix_whitepaper_analysis_steps_step_name', 'whitepaper_analysis_steps', ['step_name'])
    op.create_index('ix_whitepaper_analysis_steps_status', 'whitepaper_analysis_steps', ['status'])
    op.create_index(
        'uq_whitepaper_analysis_steps_run_step_attempt',
        'whitepaper_analysis_steps',
        ['analysis_run_id', 'step_name', 'attempt'],
        unique=True,
    )

    op.create_table(
        'whitepaper_codex_agentruns',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('analysis_run_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('analysis_step_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('agentrun_name', sa.String(length=128), nullable=False),
        sa.Column('agentrun_namespace', sa.String(length=64), nullable=True),
        sa.Column('agentrun_uid', sa.String(length=128), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False, server_default=sa.text("'queued'")),
        sa.Column('execution_mode', sa.String(length=32), nullable=False, server_default=sa.text("'default'")),
        sa.Column('requested_by', sa.String(length=128), nullable=True),
        sa.Column('codex_session_id', sa.String(length=128), nullable=True),
        sa.Column('vcs_provider', sa.String(length=32), nullable=True),
        sa.Column('vcs_repository', sa.String(length=255), nullable=True),
        sa.Column('vcs_base_branch', sa.String(length=128), nullable=True),
        sa.Column('vcs_head_branch', sa.String(length=128), nullable=True),
        sa.Column('vcs_base_commit_sha', sa.String(length=128), nullable=True),
        sa.Column('vcs_head_commit_sha', sa.String(length=128), nullable=True),
        sa.Column('workspace_context_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('prompt_text', sa.Text(), nullable=True),
        sa.Column('prompt_hash', sa.String(length=128), nullable=True),
        sa.Column('input_context_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('output_context_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('patch_artifact_ref', sa.String(length=512), nullable=True),
        sa.Column('log_artifact_ref', sa.String(length=512), nullable=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('failure_reason', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['analysis_run_id'],
            ['whitepaper_analysis_runs.id'],
            name='fk_wp_codex_runs_run_id_runs',
            ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['analysis_step_id'],
            ['whitepaper_analysis_steps.id'],
            name='fk_wp_codex_runs_step_id_steps',
            ondelete='SET NULL',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_codex_agentruns'),
        sa.UniqueConstraint('agentrun_name', name='uq_whitepaper_codex_agentruns_agentrun_name'),
    )
    op.create_index('ix_whitepaper_codex_agentruns_run_id', 'whitepaper_codex_agentruns', ['analysis_run_id'])
    op.create_index('ix_whitepaper_codex_agentruns_status', 'whitepaper_codex_agentruns', ['status'])
    op.create_index(
        'ix_whitepaper_codex_agentruns_codex_session_id',
        'whitepaper_codex_agentruns',
        ['codex_session_id'],
    )
    op.create_index(
        'ix_whitepaper_codex_agentruns_head_branch',
        'whitepaper_codex_agentruns',
        ['vcs_head_branch'],
    )

    op.create_table(
        'whitepaper_syntheses',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('analysis_run_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('synthesis_version', sa.String(length=32), nullable=False, server_default=sa.text("'v1'")),
        sa.Column('generated_by', sa.String(length=64), nullable=False, server_default=sa.text("'codex'")),
        sa.Column('model_name', sa.String(length=128), nullable=True),
        sa.Column('prompt_version', sa.String(length=64), nullable=True),
        sa.Column('executive_summary', sa.Text(), nullable=False),
        sa.Column('problem_statement', sa.Text(), nullable=True),
        sa.Column('methodology_summary', sa.Text(), nullable=True),
        sa.Column('key_findings_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('novelty_claims_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('risk_assessment_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('citations_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('implementation_plan_md', sa.Text(), nullable=True),
        sa.Column('confidence', sa.Numeric(6, 4), nullable=True),
        sa.Column('synthesis_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['analysis_run_id'],
            ['whitepaper_analysis_runs.id'],
            name='fk_wp_syntheses_run_id_runs',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_syntheses'),
        sa.UniqueConstraint('analysis_run_id', name='uq_whitepaper_syntheses_analysis_run_id'),
    )
    op.create_index('ix_whitepaper_syntheses_generated_by', 'whitepaper_syntheses', ['generated_by'])

    op.create_table(
        'whitepaper_viability_verdicts',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('analysis_run_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('verdict', sa.String(length=32), nullable=False),
        sa.Column('score', sa.Numeric(8, 4), nullable=True),
        sa.Column('confidence', sa.Numeric(6, 4), nullable=True),
        sa.Column('decision_policy', sa.String(length=64), nullable=True),
        sa.Column('gating_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('rationale', sa.Text(), nullable=True),
        sa.Column('rejection_reasons_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('recommendations_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('requires_followup', sa.Boolean(), nullable=False, server_default=sa.text('false')),
        sa.Column('approved_by', sa.String(length=128), nullable=True),
        sa.Column('approved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['analysis_run_id'],
            ['whitepaper_analysis_runs.id'],
            name='fk_wp_verdicts_run_id_runs',
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_viability_verdicts'),
        sa.UniqueConstraint('analysis_run_id', name='uq_whitepaper_viability_verdicts_analysis_run_id'),
    )
    op.create_index('ix_whitepaper_viability_verdicts_verdict', 'whitepaper_viability_verdicts', ['verdict'])
    op.create_index(
        'ix_whitepaper_viability_verdicts_requires_followup',
        'whitepaper_viability_verdicts',
        ['requires_followup'],
    )

    op.create_table(
        'whitepaper_design_pull_requests',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('analysis_run_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('codex_agentrun_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('attempt', sa.BigInteger(), nullable=False, server_default=sa.text('1')),
        sa.Column('status', sa.String(length=32), nullable=False, server_default=sa.text("'draft'")),
        sa.Column('repository', sa.String(length=255), nullable=False),
        sa.Column('base_branch', sa.String(length=128), nullable=False),
        sa.Column('head_branch', sa.String(length=128), nullable=False),
        sa.Column('pr_number', sa.BigInteger(), nullable=True),
        sa.Column('pr_url', sa.String(length=512), nullable=True),
        sa.Column('title', sa.String(length=512), nullable=True),
        sa.Column('body', sa.Text(), nullable=True),
        sa.Column('commit_sha', sa.String(length=128), nullable=True),
        sa.Column('merge_commit_sha', sa.String(length=128), nullable=True),
        sa.Column('checks_url', sa.String(length=512), nullable=True),
        sa.Column('ci_status', sa.String(length=32), nullable=True),
        sa.Column('is_merged', sa.Boolean(), nullable=False, server_default=sa.text('false')),
        sa.Column('merged_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('metadata_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['analysis_run_id'],
            ['whitepaper_analysis_runs.id'],
            name='fk_wp_design_prs_run_id_runs',
            ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['codex_agentrun_id'],
            ['whitepaper_codex_agentruns.id'],
            name='fk_wp_design_prs_codex_run_id_codex_runs',
            ondelete='SET NULL',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_design_pull_requests'),
    )
    op.create_index('ix_whitepaper_design_pull_requests_status', 'whitepaper_design_pull_requests', ['status'])
    op.create_index(
        'ix_whitepaper_design_pull_requests_pr_number',
        'whitepaper_design_pull_requests',
        ['pr_number'],
    )
    op.create_index(
        'ix_whitepaper_design_pull_requests_merged',
        'whitepaper_design_pull_requests',
        ['is_merged'],
    )
    op.create_index(
        'uq_whitepaper_design_pull_requests_run_attempt',
        'whitepaper_design_pull_requests',
        ['analysis_run_id', 'attempt'],
        unique=True,
    )

    op.create_table(
        'whitepaper_artifacts',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('document_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('document_version_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('analysis_run_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('synthesis_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('viability_verdict_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('design_pull_request_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('artifact_scope', sa.String(length=32), nullable=False, server_default=sa.text("'run'")),
        sa.Column('artifact_type', sa.String(length=64), nullable=False),
        sa.Column('artifact_role', sa.String(length=64), nullable=True),
        sa.Column('ceph_bucket', sa.String(length=128), nullable=True),
        sa.Column('ceph_object_key', sa.String(length=1024), nullable=True),
        sa.Column('artifact_uri', sa.String(length=1024), nullable=True),
        sa.Column('checksum_sha256', sa.String(length=64), nullable=True),
        sa.Column('size_bytes', sa.BigInteger(), nullable=True),
        sa.Column('content_type', sa.String(length=128), nullable=True),
        sa.Column('metadata_json', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.ForeignKeyConstraint(
            ['analysis_run_id'],
            ['whitepaper_analysis_runs.id'],
            name='fk_wp_artifacts_run_id_runs',
            ondelete='SET NULL',
        ),
        sa.ForeignKeyConstraint(
            ['design_pull_request_id'],
            ['whitepaper_design_pull_requests.id'],
            name='fk_wp_artifacts_design_pr_id_design_prs',
            ondelete='SET NULL',
        ),
        sa.ForeignKeyConstraint(
            ['document_id'],
            ['whitepaper_documents.id'],
            name='fk_wp_artifacts_doc_id_docs',
            ondelete='SET NULL',
        ),
        sa.ForeignKeyConstraint(
            ['document_version_id'],
            ['whitepaper_document_versions.id'],
            name='fk_wp_artifacts_doc_ver_id_doc_versions',
            ondelete='SET NULL',
        ),
        sa.ForeignKeyConstraint(
            ['synthesis_id'],
            ['whitepaper_syntheses.id'],
            name='fk_wp_artifacts_synth_id_syntheses',
            ondelete='SET NULL',
        ),
        sa.ForeignKeyConstraint(
            ['viability_verdict_id'],
            ['whitepaper_viability_verdicts.id'],
            name='fk_wp_artifacts_verdict_id_verdicts',
            ondelete='SET NULL',
        ),
        sa.PrimaryKeyConstraint('id', name='pk_whitepaper_artifacts'),
    )
    op.create_index('ix_whitepaper_artifacts_artifact_type', 'whitepaper_artifacts', ['artifact_type'])
    op.create_index('ix_whitepaper_artifacts_analysis_run_id', 'whitepaper_artifacts', ['analysis_run_id'])
    op.create_index(
        'ix_whitepaper_artifacts_document_version_id',
        'whitepaper_artifacts',
        ['document_version_id'],
    )
    op.create_index(
        'uq_whitepaper_artifacts_ceph_object',
        'whitepaper_artifacts',
        ['ceph_bucket', 'ceph_object_key'],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index('uq_whitepaper_artifacts_ceph_object', table_name='whitepaper_artifacts')
    op.drop_index('ix_whitepaper_artifacts_document_version_id', table_name='whitepaper_artifacts')
    op.drop_index('ix_whitepaper_artifacts_analysis_run_id', table_name='whitepaper_artifacts')
    op.drop_index('ix_whitepaper_artifacts_artifact_type', table_name='whitepaper_artifacts')
    op.drop_table('whitepaper_artifacts')

    op.drop_index('uq_whitepaper_design_pull_requests_run_attempt', table_name='whitepaper_design_pull_requests')
    op.drop_index('ix_whitepaper_design_pull_requests_merged', table_name='whitepaper_design_pull_requests')
    op.drop_index('ix_whitepaper_design_pull_requests_pr_number', table_name='whitepaper_design_pull_requests')
    op.drop_index('ix_whitepaper_design_pull_requests_status', table_name='whitepaper_design_pull_requests')
    op.drop_table('whitepaper_design_pull_requests')

    op.drop_index(
        'ix_whitepaper_viability_verdicts_requires_followup',
        table_name='whitepaper_viability_verdicts',
    )
    op.drop_index('ix_whitepaper_viability_verdicts_verdict', table_name='whitepaper_viability_verdicts')
    op.drop_table('whitepaper_viability_verdicts')

    op.drop_index('ix_whitepaper_syntheses_generated_by', table_name='whitepaper_syntheses')
    op.drop_table('whitepaper_syntheses')

    op.drop_index('ix_whitepaper_codex_agentruns_head_branch', table_name='whitepaper_codex_agentruns')
    op.drop_index('ix_whitepaper_codex_agentruns_codex_session_id', table_name='whitepaper_codex_agentruns')
    op.drop_index('ix_whitepaper_codex_agentruns_status', table_name='whitepaper_codex_agentruns')
    op.drop_index('ix_whitepaper_codex_agentruns_run_id', table_name='whitepaper_codex_agentruns')
    op.drop_table('whitepaper_codex_agentruns')

    op.drop_index('uq_whitepaper_analysis_steps_run_step_attempt', table_name='whitepaper_analysis_steps')
    op.drop_index('ix_whitepaper_analysis_steps_status', table_name='whitepaper_analysis_steps')
    op.drop_index('ix_whitepaper_analysis_steps_step_name', table_name='whitepaper_analysis_steps')
    op.drop_index('ix_whitepaper_analysis_steps_run_id', table_name='whitepaper_analysis_steps')
    op.drop_table('whitepaper_analysis_steps')

    op.drop_index('ix_whitepaper_analysis_runs_created_at', table_name='whitepaper_analysis_runs')
    op.drop_index('ix_whitepaper_analysis_runs_inngest_event_id', table_name='whitepaper_analysis_runs')
    op.drop_index('ix_whitepaper_analysis_runs_document_version_id', table_name='whitepaper_analysis_runs')
    op.drop_index('ix_whitepaper_analysis_runs_document_id', table_name='whitepaper_analysis_runs')
    op.drop_index('ix_whitepaper_analysis_runs_status', table_name='whitepaper_analysis_runs')
    op.drop_table('whitepaper_analysis_runs')

    op.drop_index('ix_whitepaper_contents_full_text_sha256', table_name='whitepaper_contents')
    op.drop_table('whitepaper_contents')

    op.drop_index('uq_whitepaper_document_versions_ceph_object', table_name='whitepaper_document_versions')
    op.drop_index('uq_whitepaper_document_versions_document_version', table_name='whitepaper_document_versions')
    op.drop_index('ix_whitepaper_document_versions_checksum', table_name='whitepaper_document_versions')
    op.drop_index('ix_whitepaper_document_versions_parse_status', table_name='whitepaper_document_versions')
    op.drop_index('ix_whitepaper_document_versions_document_id', table_name='whitepaper_document_versions')
    op.drop_table('whitepaper_document_versions')

    op.drop_index('uq_whitepaper_documents_source_identifier', table_name='whitepaper_documents')
    op.drop_index('ix_whitepaper_documents_source', table_name='whitepaper_documents')
    op.drop_index('ix_whitepaper_documents_status', table_name='whitepaper_documents')
    op.drop_table('whitepaper_documents')
