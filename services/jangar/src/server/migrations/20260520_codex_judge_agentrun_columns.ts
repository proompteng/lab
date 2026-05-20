import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'codex_judge'
          AND table_name = 'runs'
          AND column_name = 'workflow_name'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'codex_judge'
          AND table_name = 'runs'
          AND column_name = 'agent_run_name'
      ) THEN
        ALTER TABLE codex_judge.runs RENAME COLUMN workflow_name TO agent_run_name;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'codex_judge'
          AND table_name = 'runs'
          AND column_name = 'workflow_uid'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'codex_judge'
          AND table_name = 'runs'
          AND column_name = 'agent_run_uid'
      ) THEN
        ALTER TABLE codex_judge.runs RENAME COLUMN workflow_uid TO agent_run_uid;
      END IF;

      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'codex_judge'
          AND table_name = 'runs'
          AND column_name = 'workflow_namespace'
      ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'codex_judge'
          AND table_name = 'runs'
          AND column_name = 'agent_run_namespace'
      ) THEN
        ALTER TABLE codex_judge.runs RENAME COLUMN workflow_namespace TO agent_run_namespace;
      END IF;
    END
    $$;
  `.execute(db)

  await sql`
    DO $$
    BEGIN
      IF to_regclass('codex_judge.codex_judge_runs_workflow_uid_idx') IS NOT NULL
        AND to_regclass('codex_judge.codex_judge_runs_agent_run_uid_idx') IS NULL THEN
        ALTER INDEX codex_judge.codex_judge_runs_workflow_uid_idx RENAME TO codex_judge_runs_agent_run_uid_idx;
      END IF;

      IF to_regclass('codex_judge.codex_judge_runs_workflow_name_idx') IS NOT NULL
        AND to_regclass('codex_judge.codex_judge_runs_agent_run_name_idx') IS NULL THEN
        ALTER INDEX codex_judge.codex_judge_runs_workflow_name_idx RENAME TO codex_judge_runs_agent_run_name_idx;
      END IF;
    END
    $$;
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS codex_judge_runs_agent_run_uid_idx
    ON ${sql.ref('codex_judge.runs')} (agent_run_uid)
    WHERE agent_run_uid IS NOT NULL
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS codex_judge_runs_agent_run_name_idx
    ON ${sql.ref('codex_judge.runs')} (agent_run_name, agent_run_namespace)
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
