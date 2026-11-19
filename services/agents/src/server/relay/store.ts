import { sql, type Selectable } from 'kysely'
import type { Db, RelayRunSubmission } from '../db'
import { ensureMigrations } from '../kysely-migrations'

export type Submission = Selectable<RelayRunSubmission>
export type NewSubmission = Omit<Submission, 'created_at' | 'projection_id' | 'rejection'>
export type SubmissionStore = {
  reserve: (input: NewSubmission) => Promise<{ created: boolean; submission: Submission }>
  get: (id: string, workspace: string, target: string) => Promise<Submission | null>
  list: (workspace: string, target: string, limit: number) => Promise<Array<Submission & { phase: string | null }>>
  accepted: (id: string, projectionId: string) => Promise<void>
  rejected: (id: string, status: number, message: string) => Promise<void>
}
export const createSubmissionStore = (db: Db): SubmissionStore => ({
  reserve: async (input) => {
    await ensureMigrations(db)
    const inserted = await db
      .insertInto('agent_run_relay_submissions')
      .values({ ...input, projection_id: null, rejection: null })
      .onConflict((oc) => oc.column('operation_id').doNothing())
      .returningAll()
      .executeTakeFirst()
    if (inserted) return { created: true, submission: inserted }
    const submission = await db
      .selectFrom('agent_run_relay_submissions')
      .selectAll()
      .where('operation_id', '=', input.operation_id)
      .executeTakeFirstOrThrow()
    if (
      submission.workspace_id !== input.workspace_id ||
      submission.target_id !== input.target_id ||
      submission.client_service !== input.client_service ||
      submission.actor !== input.actor ||
      submission.request_hash !== input.request_hash
    )
      throw new Error('submission identity conflicts with its original request')
    return { created: false, submission }
  },
  get: async (id, workspace, target) => {
    await ensureMigrations(db)
    return (
      (await db
        .selectFrom('agent_run_relay_submissions')
        .selectAll()
        .where('operation_id', '=', id)
        .where('workspace_id', '=', workspace)
        .where('target_id', '=', target)
        .executeTakeFirst()) ?? null
    )
  },
  list: async (workspace, target, limit) => {
    await ensureMigrations(db)
    return db
      .selectFrom('agent_run_relay_submissions')
      .leftJoin('agent_runs', 'agent_runs.id', 'agent_run_relay_submissions.projection_id')
      .selectAll('agent_run_relay_submissions')
      .select('agent_runs.status as phase')
      .where('workspace_id', '=', workspace)
      .where('target_id', '=', target)
      .orderBy('agent_run_relay_submissions.created_at', 'desc')
      .limit(limit)
      .execute()
  },
  accepted: async (id, projectionId) => {
    await db.transaction().execute(async (trx) => {
      const submission = await trx
        .selectFrom('agent_run_relay_submissions')
        .selectAll()
        .where('operation_id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow()
      if (submission.projection_id && submission.projection_id !== projectionId)
        throw new Error('submission projection identity changed')
      const request = JSON.stringify(submission.request_payload)
      // The reconciler may create this row first. Attach only the original request, preserving current run state.
      await trx
        .updateTable('agent_runs')
        .set({ payload: sql`payload || jsonb_build_object('request', ${request}::jsonb)` })
        .where('id', '=', projectionId)
        .where('delivery_id', '=', id)
        .where('external_run_id', '=', submission.run_name)
        .where(sql<boolean>`payload #>> '{resource,metadata,name}' = ${submission.run_name}
          and payload #>> '{resource,metadata,namespace}' = ${request}::jsonb->>'namespace'
          and coalesce(payload #>> '{resource,metadata,uid}', '') <> ''
          and payload #>> '{resource,metadata,annotations,relay.proompteng.ai/request-hash}' = ${submission.request_hash}
          and payload #>> '{resource,metadata,annotations,relay.proompteng.ai/target}' = ${submission.target_id}
          and payload #>> '{resource,metadata,annotations,relay.proompteng.ai/namespace-uid}' =
            ${request}::jsonb #>> '{metadata,annotations,relay.proompteng.ai/namespace-uid}'
          and (not (payload ? 'request') or payload->'request' = ${request}::jsonb)`)
        .returning('id')
        .executeTakeFirstOrThrow()
      await trx
        .updateTable('agent_run_relay_submissions')
        .set({ projection_id: projectionId })
        .where('operation_id', '=', id)
        .execute()
    })
  },
  rejected: async (id, status, message) => {
    await db
      .updateTable('agent_run_relay_submissions')
      .set({ rejection: { status, message } })
      .where('operation_id', '=', id)
      .where('projection_id', 'is', null)
      .execute()
  },
})
