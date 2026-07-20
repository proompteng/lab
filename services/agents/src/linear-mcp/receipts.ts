import { createHash } from 'node:crypto'

import type { Selectable } from 'kysely'

import type { Db, LinearMcpMutationReceipts } from '../server/db'

export type LinearMutationTool = 'create_comment' | 'update_issue'
export type LinearMutationReceipt = Selectable<LinearMcpMutationReceipts>

export type LinearMutationReceiptStore = {
  reserve: (input: {
    agentRunUid: string
    agentRunName: string
    namespace: string
    issueUuid: string
    issueIdentifier: string
    tool: LinearMutationTool
    canonicalArgumentHash: string
  }) => Promise<{ created: boolean; receipt: LinearMutationReceipt }>
  claim: (id: string) => Promise<LinearMutationReceipt | null>
  get: (id: string) => Promise<LinearMutationReceipt | null>
  succeed: (id: string, resultId: string | null) => Promise<void>
  indeterminate: (id: string, errorCode: string) => Promise<void>
}

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export const canonicalArgumentHash = (value: unknown) => createHash('sha256').update(canonicalize(value)).digest('hex')

export const createLinearMutationReceiptStore = (db: Db): LinearMutationReceiptStore => ({
  reserve: async (input) => {
    const inserted = await db
      .insertInto('linear_mcp_mutation_receipts')
      .values({
        agent_run_uid: input.agentRunUid,
        agent_run_name: input.agentRunName,
        agent_run_namespace: input.namespace,
        issue_uuid: input.issueUuid,
        issue_identifier: input.issueIdentifier,
        tool: input.tool,
        canonical_argument_hash: input.canonicalArgumentHash,
        state: 'preparing',
        sanitized_result_id: null,
        last_error_code: null,
        started_at: null,
        completed_at: null,
      })
      .onConflict((conflict) => conflict.columns(['agent_run_uid', 'tool', 'canonical_argument_hash']).doNothing())
      .returningAll()
      .executeTakeFirst()
    if (inserted) return { created: true, receipt: inserted }

    const existing = await db
      .selectFrom('linear_mcp_mutation_receipts')
      .selectAll()
      .where('agent_run_uid', '=', input.agentRunUid)
      .where('tool', '=', input.tool)
      .where('canonical_argument_hash', '=', input.canonicalArgumentHash)
      .executeTakeFirst()
    if (!existing) throw new Error('Linear mutation receipt reservation disappeared')
    if (existing.issue_uuid !== input.issueUuid || existing.issue_identifier !== input.issueIdentifier) {
      throw new Error('Linear mutation receipt source identity does not match')
    }
    return { created: false, receipt: existing }
  },
  claim: async (id) =>
    (await db
      .updateTable('linear_mcp_mutation_receipts')
      .set((expression) => ({
        state: 'in_flight',
        attempt_count: expression('attempt_count', '+', 1),
        started_at: new Date(),
        updated_at: new Date(),
        last_error_code: null,
      }))
      .where('id', '=', id)
      .where('state', '=', 'preparing')
      .returningAll()
      .executeTakeFirst()) ?? null,
  get: async (id) =>
    (await db.selectFrom('linear_mcp_mutation_receipts').selectAll().where('id', '=', id).executeTakeFirst()) ?? null,
  succeed: async (id, resultId) => {
    await db
      .updateTable('linear_mcp_mutation_receipts')
      .set({
        state: 'succeeded',
        sanitized_result_id: resultId,
        last_error_code: null,
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  },
  indeterminate: async (id, errorCode) => {
    await db
      .updateTable('linear_mcp_mutation_receipts')
      .set({
        state: 'indeterminate',
        last_error_code: errorCode.slice(0, 100),
        completed_at: new Date(),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
  },
})
