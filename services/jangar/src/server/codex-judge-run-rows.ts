import type { Db } from '~/server/db'

export const selectCodexJudgeRunById = (db: Db, runId?: string | null) =>
  runId ? db.selectFrom('codex_judge.runs').selectAll().where('id', '=', runId).executeTakeFirst() : null

export const selectCodexJudgeRunByAgentRun = (db: Db, agentRunName?: string | null, namespace?: string | null) =>
  agentRunName
    ? db
        .selectFrom('codex_judge.runs')
        .selectAll()
        .where('workflow_name', '=', agentRunName)
        .where('workflow_namespace', '=', namespace ?? null)
        .executeTakeFirst()
    : null

export const selectCodexJudgeRunByAgentRunUid = (db: Db, agentRunUid?: string | null) =>
  agentRunUid
    ? db.selectFrom('codex_judge.runs').selectAll().where('workflow_uid', '=', agentRunUid).executeTakeFirst()
    : null
