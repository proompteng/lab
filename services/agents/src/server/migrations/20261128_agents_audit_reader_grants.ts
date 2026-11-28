import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

export const up = async (db: Kysely<AgentsDatabase>) => {
  // CNPG owns the login. Auto Ontology discovers relations via table-level SELECT,
  // so expose approved projections instead of granting access to raw stores.
  await sql`DO $migration$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agents_audit_ro') THEN
        CREATE SCHEMA IF NOT EXISTS agents_audit;

        CREATE OR REPLACE VIEW agents_audit.agent_runs AS
          SELECT agent_name, provider, status, created_at, updated_at FROM public.agent_runs;

        CREATE OR REPLACE VIEW agents_audit.agent_messages AS
          SELECT agent_run_namespace, role, kind, timestamp, channel, stage FROM agents_comms.agent_messages;

        CREATE OR REPLACE VIEW agents_audit.memory_notes AS
          SELECT task_name, created_at, last_accessed_at, retired_at FROM memories.entries;

        CREATE OR REPLACE VIEW agents_audit.codex_run_projection AS
          SELECT agent_run_namespace, stage, status, phase, ci_status, review_status, started_at, finished_at, created_at
          FROM agents_codex.runs;

        CREATE OR REPLACE VIEW agents_audit.relay_submissions AS
          SELECT client_service, rejection IS NOT NULL AS rejected, created_at
          FROM public.agent_run_relay_submissions;

        CREATE OR REPLACE VIEW agents_audit.agent_run_rerun_submissions AS
          SELECT parent_agent_run_namespace, parent_ref, attempt, status, submission_attempt, created_at
          FROM public.agent_run_rerun_submissions;

        CREATE OR REPLACE VIEW agents_audit.agent_run_activity AS
          SELECT namespace, spec_agent_ref_name, spec_runtime_type, status_phase, resource_updated_at,
            resource #>> '{status,reason}' AS failure_reason,
            resource #>> '{status,runner,provider}' AS runner_provider,
            COALESCE(NULLIF(resource #>> '{status,runner,model}', ''),
              resource #>> '{status,runner,telemetry,model}') AS runner_model,
            resource #>> '{status,startedAt}' AS started_at,
            resource #>> '{status,finishedAt}' AS finished_at,
            resource #>> '{status,runner,telemetry,usage,inputTokens}' AS input_tokens,
            resource #>> '{status,runner,telemetry,usage,cachedInputTokens}' AS cached_input_tokens,
            resource #>> '{status,runner,telemetry,usage,cacheWriteInputTokens}' AS cache_write_input_tokens,
            resource #>> '{status,runner,telemetry,usage,outputTokens}' AS output_tokens
          FROM agents_control_plane.resources_current WHERE kind = 'AgentRun';

        REVOKE ALL PRIVILEGES ON SCHEMA public, agents_audit, agents_comms, agents_codex, agents_control_plane, memories
          FROM agents_audit_ro;
        REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public, agents_audit, agents_comms, agents_codex,
          agents_control_plane, memories FROM agents_audit_ro;
        REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public, agents_audit, agents_comms, agents_codex,
          agents_control_plane, memories FROM agents_audit_ro;
        -- PUBLIC's implicit TEMP grant also applies to NOINHERIT logins. The database owner retains its privileges.
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        EXECUTE format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, agents_audit_ro', current_database());

        GRANT USAGE ON SCHEMA public, agents_audit TO agents_audit_ro;
        GRANT SELECT ON TABLE
          agents_audit.agent_runs,
          agents_audit.agent_messages,
          agents_audit.memory_notes,
          agents_audit.codex_run_projection,
          agents_audit.relay_submissions,
          agents_audit.agent_run_rerun_submissions,
          agents_audit.agent_run_activity
          TO agents_audit_ro;
      END IF;
    END;
  $migration$`.execute(db)
}
