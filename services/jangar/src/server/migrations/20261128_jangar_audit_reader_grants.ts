import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  // CNPG owns the login. In a privileged bootstrap, create a disabled role for CNPG to adopt.
  await sql`DO $migration$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jangar_audit_ro') THEN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolcreaterole OR rolsuper)) THEN
          RAISE NOTICE 'jangar_audit_ro is not provisioned; skipping Jangar audit grants';
          RETURN;
        END IF;

        BEGIN
          CREATE ROLE jangar_audit_ro NOLOGIN NOINHERIT;
        EXCEPTION WHEN duplicate_object OR unique_violation THEN
          -- Roles are shared across databases, so CNPG or another migration can create it concurrently.
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jangar_audit_ro') THEN
            RAISE;
          END IF;
        END;
      END IF;

      CREATE SCHEMA IF NOT EXISTS jangar_audit;

      -- Only typed structure and known categories cross the boundary. Repository names, paths,
      -- identifiers from source text, and arbitrary JSON or error strings can contain private data.
      CREATE OR REPLACE VIEW jangar_audit.atlas_repositories AS
        SELECT id AS repository_id,
          CASE WHEN metadata->>'indexStatus' IN ('maintenance', 'building', 'ready', 'failed')
            THEN metadata->>'indexStatus' ELSE 'unknown' END AS index_status,
          CASE WHEN metadata->>'indexedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
            AND pg_input_is_valid(metadata->>'indexedAt', 'timestamptz')
            THEN (metadata->>'indexedAt')::timestamptz END AS indexed_at,
          updated_at
        FROM atlas.repositories;

      CREATE OR REPLACE VIEW jangar_audit.atlas_ingestions AS
        SELECT id AS ingestion_id, event_id,
          CASE WHEN status IN ('running', 'completed', 'failed', 'skipped') THEN status ELSE 'other' END AS status,
          started_at, finished_at
        FROM atlas.ingestions;

      CREATE OR REPLACE VIEW jangar_audit.atlas_file_versions AS
        SELECT versions.id AS file_version_id, versions.file_key_id, keys.repository_id,
          CASE
            WHEN versions.language IS NULL THEN 'unknown'
            WHEN versions.language IN (
              'bash', 'c', 'css', 'embedded-template', 'go', 'hcl', 'html', 'ini', 'javascript',
              'jinja2', 'json', 'jsx', 'kotlin', 'markdown', 'mdx', 'properties', 'proto', 'python',
              'ruby', 'rust', 'sql', 'terraform', 'text', 'toml', 'tsx', 'typescript', 'xml', 'yaml', 'zig'
            ) THEN versions.language
            ELSE 'other'
          END AS language,
          versions.byte_size, versions.line_count, versions.updated_at
        FROM atlas.file_versions AS versions
        JOIN atlas.file_keys AS keys ON keys.id = versions.file_key_id;

      CREATE OR REPLACE VIEW jangar_audit.atlas_chunk_coverage AS
        SELECT files.repository_id, files.file_version_id,
          COUNT(chunks.id) AS chunk_count, COUNT(embeddings.chunk_id) AS embedded_chunk_count,
          MAX(chunks.created_at) AS newest_chunk_at, MAX(embeddings.created_at) AS newest_embedding_at,
          MIN(chunks.created_at) FILTER (WHERE embeddings.chunk_id IS NULL) AS oldest_unembedded_at
        FROM jangar_audit.atlas_file_versions AS files
        LEFT JOIN atlas.file_chunks AS chunks ON chunks.file_version_id = files.file_version_id
        LEFT JOIN atlas.chunk_embeddings AS embeddings ON embeddings.chunk_id = chunks.id
        GROUP BY files.repository_id, files.file_version_id;

      CREATE OR REPLACE VIEW jangar_audit.atlas_github_events AS
        SELECT id AS event_id, repository_id,
          CASE WHEN event_type IN (
            'check_run', 'check_suite', 'create', 'delete', 'installation', 'installation_repositories', 'issue_comment',
            'issues', 'ping', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'push',
            'release', 'repository', 'workflow_run'
          ) THEN event_type ELSE 'other' END AS event_type,
          received_at, processed_at
        FROM atlas.github_events;

      CREATE OR REPLACE VIEW jangar_audit.atlas_symbols AS
        SELECT id AS symbol_id, repository_id, created_at
        FROM atlas.symbols;

      CREATE OR REPLACE VIEW jangar_audit.atlas_file_edges AS
        SELECT id AS file_edge_id, from_file_version_id, to_file_version_id, created_at
        FROM atlas.file_edges;

      REVOKE ALL PRIVILEGES ON SCHEMA public, atlas, jangar_github, terminals, torghut_control_plane, jangar_audit
        FROM jangar_audit_ro;
      REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, atlas, jangar_github, terminals, torghut_control_plane,
        jangar_audit FROM jangar_audit_ro;
      REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, atlas, jangar_github, terminals, torghut_control_plane,
        jangar_audit FROM jangar_audit_ro;
      -- PUBLIC grants still apply to NOINHERIT logins. The database owner retains its privileges.
      REVOKE CREATE ON SCHEMA public, atlas, jangar_github, terminals, torghut_control_plane, jangar_audit FROM PUBLIC;
      EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, jangar_audit_ro', current_database());

      GRANT USAGE ON SCHEMA jangar_audit TO jangar_audit_ro;
      GRANT SELECT ON TABLE
        jangar_audit.atlas_repositories,
        jangar_audit.atlas_ingestions,
        jangar_audit.atlas_file_versions,
        jangar_audit.atlas_chunk_coverage,
        jangar_audit.atlas_github_events,
        jangar_audit.atlas_symbols,
        jangar_audit.atlas_file_edges
        TO jangar_audit_ro;
    END;
  $migration$`.execute(db)
}
