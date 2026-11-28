import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS ci_audit`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ci_audit.workflow_runs (
      run_id bigint PRIMARY KEY,
      workflow_name varchar(255) NOT NULL,
      head_branch varchar(255),
      head_sha varchar(64) NOT NULL,
      event varchar(64) NOT NULL,
      status varchar(32) NOT NULL,
      conclusion varchar(32),
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL,
      duration_seconds double precision CHECK (duration_seconds >= 0),
      repository varchar(255) NOT NULL,
      synced_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS workflow_runs_updated ON ci_audit.workflow_runs (updated_at DESC, run_id)
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS workflow_runs_branch_updated ON ci_audit.workflow_runs (head_branch, updated_at DESC)
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ci_audit.job_runs (
      job_id bigint PRIMARY KEY,
      run_id bigint NOT NULL REFERENCES ci_audit.workflow_runs (run_id),
      workflow_name varchar(255) NOT NULL,
      job_name varchar(512) NOT NULL,
      runner_name varchar(255),
      status varchar(32) NOT NULL,
      conclusion varchar(32),
      started_at timestamptz,
      completed_at timestamptz,
      duration_seconds double precision CHECK (duration_seconds >= 0),
      failure_category varchar(32),
      synced_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS job_runs_run ON ci_audit.job_runs (run_id, job_id)`.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS job_runs_failures ON ci_audit.job_runs (completed_at DESC)
      WHERE failure_category IS NOT NULL
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ci_audit.failure_clusters (
      cluster_key varchar(64) PRIMARY KEY,
      workflow_name varchar(255) NOT NULL,
      job_name varchar(512) NOT NULL,
      failure_category varchar(32) NOT NULL,
      sample_run_id bigint NOT NULL,
      occurrences_24h integer NOT NULL CHECK (occurrences_24h > 0),
      last_seen_at timestamptz NOT NULL,
      synced_at timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)

  await sql`REVOKE ALL PRIVILEGES ON SCHEMA ci_audit FROM PUBLIC`.execute(db)
  await sql`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ci_audit FROM PUBLIC`.execute(db)

  await sql`
    DO $grants$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agents_audit_ro') THEN
        GRANT USAGE ON SCHEMA ci_audit TO agents_audit_ro;
        GRANT SELECT ON ALL TABLES IN SCHEMA ci_audit TO agents_audit_ro;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ci_audit GRANT SELECT ON TABLES TO agents_audit_ro;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ci_audit_writer') THEN
        GRANT USAGE ON SCHEMA ci_audit TO ci_audit_writer;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ci_audit TO ci_audit_writer;
      END IF;
    END;
    $grants$
  `.execute(db)
}
