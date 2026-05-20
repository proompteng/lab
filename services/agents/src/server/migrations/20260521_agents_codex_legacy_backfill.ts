import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'

export const up = async (db: Kysely<AgentsDatabase>) => {
  await sql`
    DO $$
    BEGIN
      IF to_regclass('codex_judge.runs') IS NOT NULL THEN
        INSERT INTO agents_codex.runs (
          id,
          repository,
          issue_number,
          branch,
          attempt,
          agent_run_name,
          agent_run_uid,
          agent_run_namespace,
          turn_id,
          thread_id,
          stage,
          status,
          phase,
          iteration,
          iteration_cycle,
          prompt,
          next_prompt,
          commit_sha,
          pr_number,
          pr_url,
          pr_state,
          pr_merged,
          ci_status,
          ci_url,
          ci_status_updated_at,
          review_status,
          review_summary,
          review_status_updated_at,
          notify_payload,
          run_complete_payload,
          created_at,
          updated_at,
          started_at,
          finished_at
        )
        SELECT
          legacy.id,
          legacy.repository,
          legacy.issue_number,
          legacy.branch,
          legacy.attempt,
          legacy.agent_run_name,
          legacy.agent_run_uid,
          COALESCE(NULLIF(legacy.agent_run_namespace, ''), 'agents'),
          NULL,
          NULL,
          legacy.stage,
          legacy.status,
          legacy.phase,
          NULL,
          NULL,
          legacy.prompt,
          legacy.next_prompt,
          legacy.commit_sha,
          legacy.pr_number,
          legacy.pr_url,
          NULL,
          NULL,
          legacy.ci_status,
          legacy.ci_url,
          CASE WHEN legacy.ci_status IS NULL THEN NULL ELSE legacy.updated_at END,
          legacy.review_status,
          legacy.review_summary,
          CASE WHEN legacy.review_status IS NULL THEN NULL ELSE legacy.updated_at END,
          legacy.notify_payload,
          legacy.run_complete_payload,
          legacy.created_at,
          legacy.updated_at,
          legacy.started_at,
          legacy.finished_at
        FROM codex_judge.runs legacy
        WHERE NOT EXISTS (
          SELECT 1
          FROM agents_codex.runs current
          WHERE current.id = legacy.id
            OR (
              legacy.agent_run_uid IS NOT NULL
              AND current.agent_run_uid = legacy.agent_run_uid
            )
            OR (
              current.agent_run_name = legacy.agent_run_name
              AND current.agent_run_namespace = COALESCE(NULLIF(legacy.agent_run_namespace, ''), 'agents')
            )
        );
      END IF;

      IF to_regclass('codex_judge.artifacts') IS NOT NULL THEN
        INSERT INTO agents_codex.artifacts (
          id,
          run_id,
          name,
          key,
          bucket,
          url,
          metadata,
          created_at
        )
        SELECT
          legacy.id,
          legacy.run_id,
          legacy.name,
          legacy.key,
          legacy.bucket,
          legacy.url,
          legacy.metadata,
          legacy.created_at
        FROM codex_judge.artifacts legacy
        JOIN agents_codex.runs run ON run.id = legacy.run_id
        ON CONFLICT (run_id, name) DO UPDATE SET
          key = EXCLUDED.key,
          bucket = EXCLUDED.bucket,
          url = EXCLUDED.url,
          metadata = EXCLUDED.metadata;
      END IF;

      IF to_regclass('codex_judge.evaluations') IS NOT NULL THEN
        INSERT INTO agents_codex.evaluations (
          id,
          run_id,
          decision,
          confidence,
          reasons,
          missing_items,
          suggested_fixes,
          next_prompt,
          system_suggestions,
          created_at
        )
        SELECT
          legacy.id,
          legacy.run_id,
          legacy.decision,
          legacy.confidence,
          legacy.reasons,
          legacy.missing_items,
          legacy.suggested_fixes,
          legacy.next_prompt,
          legacy.system_suggestions,
          legacy.created_at
        FROM codex_judge.evaluations legacy
        JOIN agents_codex.runs run ON run.id = legacy.run_id
        ON CONFLICT (id) DO NOTHING;
      END IF;
    END
    $$;
  `.execute(db)
}

export const down = async (_db: Kysely<AgentsDatabase>) => {}
