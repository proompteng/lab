import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

const SCHEMA = 'agents_codex'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`CREATE SCHEMA IF NOT EXISTS ${sql.raw(SCHEMA)};`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref(`${SCHEMA}.runs`)} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      repository TEXT NOT NULL,
      issue_number BIGINT NOT NULL,
      branch TEXT NOT NULL,
      attempt INT NOT NULL,
      agent_run_name TEXT NOT NULL,
      agent_run_uid TEXT,
      agent_run_namespace TEXT,
      turn_id TEXT,
      thread_id TEXT,
      stage TEXT,
      status TEXT NOT NULL,
      phase TEXT,
      iteration INT,
      iteration_cycle INT,
      prompt TEXT,
      next_prompt TEXT,
      commit_sha TEXT,
      pr_number INT,
      pr_url TEXT,
      pr_state TEXT,
      pr_merged BOOLEAN,
      ci_status TEXT,
      ci_url TEXT,
      ci_status_updated_at TIMESTAMPTZ,
      review_status TEXT,
      review_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
      review_status_updated_at TIMESTAMPTZ,
      notify_payload JSONB,
      run_complete_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref(`${SCHEMA}.artifacts`)} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES agents_codex.runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key TEXT NOT NULL,
      bucket TEXT,
      url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref(`${SCHEMA}.evaluations`)} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES agents_codex.runs(id) ON DELETE CASCADE,
      decision TEXT NOT NULL,
      confidence DOUBLE PRECISION,
      reasons JSONB NOT NULL DEFAULT '{}'::JSONB,
      missing_items JSONB NOT NULL DEFAULT '{}'::JSONB,
      suggested_fixes JSONB NOT NULL DEFAULT '{}'::JSONB,
      next_prompt TEXT,
      system_suggestions JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_codex_runs_agent_run_uid_idx
    ON ${sql.ref(`${SCHEMA}.runs`)} (agent_run_uid)
    WHERE agent_run_uid IS NOT NULL;
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_codex_runs_agent_run_name_idx
    ON ${sql.ref(`${SCHEMA}.runs`)} (agent_run_name, agent_run_namespace);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_codex_runs_repo_issue_idx
    ON ${sql.ref(`${SCHEMA}.runs`)} (repository, issue_number, created_at DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_codex_runs_repo_commit_idx
    ON ${sql.ref(`${SCHEMA}.runs`)} (repository, commit_sha);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_codex_runs_repo_pr_idx
    ON ${sql.ref(`${SCHEMA}.runs`)} (repository, pr_number);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS agents_codex_runs_repo_branch_idx
    ON ${sql.ref(`${SCHEMA}.runs`)} (repository, branch);
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS agents_codex_artifacts_run_name_idx
    ON ${sql.ref(`${SCHEMA}.artifacts`)} (run_id, name);
  `.execute(db)
}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
