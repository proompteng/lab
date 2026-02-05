import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

// Postgres cache for the Agents control-plane UI.
//
// Source of truth remains Kubernetes; this is a denormalized index optimized for fast list/filter
// operations (ImplementationSpecs + AgentRuns are the hot paths in the agents namespace).
export const up = async (db: Kysely<Database>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS agents_control_plane;`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS agents_control_plane.resources_current (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cluster TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL,
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      uid TEXT,
      api_version TEXT,
      resource_version TEXT,
      generation BIGINT,
      labels JSONB NOT NULL DEFAULT '{}'::jsonb,
      annotations JSONB NOT NULL DEFAULT '{}'::jsonb,
      resource JSONB NOT NULL,
      fingerprint TEXT NOT NULL,
      resource_created_at TIMESTAMPTZ,
      resource_updated_at TIMESTAMPTZ,
      status_phase TEXT,
      spec_runtime_type TEXT,
      spec_agent_ref_name TEXT,
      spec_implementation_spec_ref_name TEXT,
      spec_source_provider TEXT,
      spec_source_external_id TEXT,
      spec_summary TEXT,
      spec_labels TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_cp_resources_current_uniq
    ON agents_control_plane.resources_current(cluster, kind, namespace, name);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_cp_resources_current_list_idx
    ON agents_control_plane.resources_current(cluster, kind, namespace, resource_updated_at DESC NULLS LAST);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_cp_resources_current_not_deleted_idx
    ON agents_control_plane.resources_current(cluster, kind, namespace, name)
    WHERE deleted_at IS NULL;
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_cp_resources_current_labels_gin
    ON agents_control_plane.resources_current
    USING GIN (labels jsonb_path_ops);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_cp_resources_current_impl_source_idx
    ON agents_control_plane.resources_current(cluster, namespace, spec_source_provider)
    WHERE kind = 'ImplementationSpec' AND deleted_at IS NULL;
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_cp_resources_current_agentrun_phase_idx
    ON agents_control_plane.resources_current(cluster, namespace, status_phase, resource_updated_at DESC NULLS LAST)
    WHERE kind = 'AgentRun' AND deleted_at IS NULL;
  `.execute(db)
}
