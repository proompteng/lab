import type { Db } from './db'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const selectCodexRunProjectionById = (db: Db, runId?: string | null) =>
  runId && UUID_PATTERN.test(runId)
    ? db.selectFrom('agents_codex.runs').selectAll().where('id', '=', runId).executeTakeFirst()
    : null

export const selectCodexRunProjectionByAgentRun = (db: Db, agentRunName?: string | null, namespace?: string | null) =>
  agentRunName
    ? db
        .selectFrom('agents_codex.runs')
        .selectAll()
        .where('agent_run_name', '=', agentRunName)
        .where('agent_run_namespace', '=', namespace ?? null)
        .executeTakeFirst()
    : null

export const selectCodexRunProjectionByAgentRunUid = (db: Db, agentRunUid?: string | null) =>
  agentRunUid
    ? db.selectFrom('agents_codex.runs').selectAll().where('agent_run_uid', '=', agentRunUid).executeTakeFirst()
    : null
