import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS agents_control_plane;`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS agents_control_plane.component_heartbeats (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cluster TEXT NOT NULL DEFAULT 'default',
      namespace TEXT NOT NULL,
      component TEXT NOT NULL,
      workload_role TEXT NOT NULL,
      pod_name TEXT NOT NULL,
      deployment_name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('healthy', 'degraded', 'disabled', 'unknown')),
      message TEXT NOT NULL DEFAULT '',
      leadership_state TEXT NOT NULL DEFAULT 'not-applicable',
      observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '2 minutes'),
      source_namespace TEXT NOT NULL DEFAULT 'default',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(cluster, namespace, component, workload_role)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_cp_component_heartbeats_namespace_component_idx
    ON agents_control_plane.component_heartbeats(cluster, namespace, component, observed_at DESC NULLS LAST, expires_at DESC NULLS LAST);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_cp_component_heartbeats_freshness_idx
    ON agents_control_plane.component_heartbeats(cluster, namespace, component, expires_at)
    WHERE observed_at IS NOT NULL;
  `.execute(db)
}
