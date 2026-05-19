import type { Db } from '~/server/db'

export const selectCodexJudgeRunById = (db: Db, runId?: string | null) =>
  runId ? db.selectFrom('codex_judge.runs').selectAll().where('id', '=', runId).executeTakeFirst() : null

export const selectCodexJudgeRunByWorkflow = (db: Db, workflowName?: string | null, namespace?: string | null) =>
  workflowName
    ? db
        .selectFrom('codex_judge.runs')
        .selectAll()
        .where('workflow_name', '=', workflowName)
        .where('workflow_namespace', '=', namespace ?? null)
        .executeTakeFirst()
    : null

export const selectCodexJudgeRunByWorkflowUid = (db: Db, workflowUid?: string | null) =>
  workflowUid
    ? db.selectFrom('codex_judge.runs').selectAll().where('workflow_uid', '=', workflowUid).executeTakeFirst()
    : null
