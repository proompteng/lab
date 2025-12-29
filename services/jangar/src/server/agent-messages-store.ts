import { sql } from 'kysely'

import { createKyselyDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

export type AgentMessageRecord = {
  id: string
  workflowUid: string | null
  workflowName: string | null
  workflowNamespace: string | null
  runId: string | null
  stepId: string | null
  agentId: string | null
  role: string
  kind: string
  timestamp: string
  channel: string | null
  stage: string | null
  content: string
  attrs: Record<string, unknown>
  dedupeKey: string | null
  createdAt: string
}

export type AgentMessageInput = {
  workflowUid: string | null
  workflowName: string | null
  workflowNamespace: string | null
  runId: string | null
  stepId: string | null
  agentId: string | null
  role: string
  kind: string
  timestamp: string
  channel: string | null
  stage: string | null
  content: string
  attrs?: Record<string, unknown>
  dedupeKey?: string | null
}

export type AgentMessagesStore = {
  hasMessages: (input: { runId?: string | null; workflowUid?: string | null }) => Promise<boolean>
  insertMessages: (messages: AgentMessageInput[]) => Promise<number>
  listMessages: (input: ListAgentMessagesInput) => Promise<AgentMessageRecord[]>
  close: () => Promise<void>
}

type AgentMessagesStoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

const SCHEMA = 'workflow_comms'
const TABLE = 'agent_messages'
const INSERT_BATCH_SIZE = 500
const DEFAULT_LIST_LIMIT = 500

const chunk = <T>(items: T[], size: number) => {
  if (items.length <= size) return [items]
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }
  return batches
}

const normalizeAttrs = (value?: Record<string, unknown>) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

const normalizeDedupeKey = (value?: string | null) => {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const normalizeTimestamp = (value: string | Date) => (value instanceof Date ? value.toISOString() : value)

const normalizeLimit = (value?: number | null) => {
  if (!value || !Number.isFinite(value)) return DEFAULT_LIST_LIMIT
  if (value <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(Math.floor(value), 2000)
}

const ensureSchema = async (db: Db) => {
  await ensureMigrations(db)
}

const countRows = async (db: Db, where: { runId?: string | null; workflowUid?: string | null }) => {
  const { runId, workflowUid } = where
  let query = db.selectFrom(`${SCHEMA}.${TABLE}`).select(sql<number>`count(*)`.as('count'))
  if (runId) {
    query = query.where('run_id', '=', runId)
  } else if (workflowUid) {
    query = query.where('workflow_uid', '=', workflowUid)
  } else {
    return 0
  }
  const row = await query.executeTakeFirst()
  const count = row?.count ?? 0
  return Number(count)
}

const mapRow = (row: {
  id: string
  workflow_uid: string | null
  workflow_name: string | null
  workflow_namespace: string | null
  run_id: string | null
  step_id: string | null
  agent_id: string | null
  role: string
  kind: string
  timestamp: string
  channel: string | null
  stage: string | null
  content: string
  attrs: Record<string, unknown>
  dedupe_key: string | null
  created_at: string | Date
}): AgentMessageRecord => ({
  id: row.id,
  workflowUid: row.workflow_uid,
  workflowName: row.workflow_name,
  workflowNamespace: row.workflow_namespace,
  runId: row.run_id,
  stepId: row.step_id,
  agentId: row.agent_id,
  role: row.role,
  kind: row.kind,
  timestamp: normalizeTimestamp(row.timestamp),
  channel: row.channel,
  stage: row.stage,
  content: row.content,
  attrs: row.attrs ?? {},
  dedupeKey: row.dedupe_key,
  createdAt: normalizeTimestamp(row.created_at),
})

export type ListAgentMessagesInput = {
  identifiers?: string[]
  runId?: string | null
  workflowUid?: string | null
  channel?: string | null
  since?: string | null
  limit?: number
}

export const createAgentMessagesStore = (options: AgentMessagesStoreOptions = {}): AgentMessagesStore => {
  const url = options.url ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required for agent messages storage')
  }

  const db = (options.createDb ?? createKyselyDb)(url)
  let schemaReady: Promise<void> | null = null

  const ensureReady = async () => {
    if (!schemaReady) {
      schemaReady = ensureSchema(db)
    }
    await schemaReady
  }

  const hasMessages = async ({ runId, workflowUid }: { runId?: string | null; workflowUid?: string | null }) => {
    await ensureReady()
    if (runId) {
      const count = await countRows(db, { runId })
      if (count > 0) return true
    }
    if (workflowUid) {
      const count = await countRows(db, { workflowUid })
      if (count > 0) return true
    }
    return false
  }

  const insertMessages = async (messages: AgentMessageInput[]) => {
    await ensureReady()
    const normalized = messages
      .map((message) => ({
        workflow_uid: message.workflowUid,
        workflow_name: message.workflowName,
        workflow_namespace: message.workflowNamespace,
        run_id: message.runId,
        step_id: message.stepId,
        agent_id: message.agentId,
        role: message.role,
        kind: message.kind,
        timestamp: message.timestamp,
        channel: message.channel,
        stage: message.stage,
        content: message.content,
        attrs: normalizeAttrs(message.attrs),
        dedupe_key: normalizeDedupeKey(message.dedupeKey),
      }))
      .filter((message) => message.content.trim().length > 0)

    if (normalized.length === 0) return 0

    let inserted = 0
    for (const batch of chunk(normalized, INSERT_BATCH_SIZE)) {
      await db
        .insertInto(`${SCHEMA}.${TABLE}`)
        .values(batch)
        .onConflict((oc) => oc.column('dedupe_key').doNothing())
        .execute()
      inserted += batch.length
    }

    return inserted
  }

  const listMessages = async (input: ListAgentMessagesInput): Promise<AgentMessageRecord[]> => {
    await ensureReady()
    const { identifiers, runId, workflowUid, channel, since } = input
    const limit = normalizeLimit(input.limit)
    let query = db.selectFrom(`${SCHEMA}.${TABLE}`).selectAll()

    if (identifiers && identifiers.length > 0) {
      query = query.where((eb) =>
        eb.or(
          identifiers.map((identifier) => eb.or([eb('run_id', '=', identifier), eb('workflow_uid', '=', identifier)])),
        ),
      )
    } else if (runId) {
      query = query.where('run_id', '=', runId)
    } else if (workflowUid) {
      query = query.where('workflow_uid', '=', workflowUid)
    }

    if (channel) {
      query = query.where('channel', '=', channel)
    }

    if (since) {
      query = query.where('created_at', '>', since)
    }

    const rows = await query.orderBy('created_at', 'asc').limit(limit).execute()
    return rows.map((row) =>
      mapRow({
        ...(row as typeof row & { attrs?: Record<string, unknown> }),
        attrs: normalizeAttrs((row as { attrs?: Record<string, unknown> }).attrs),
      }),
    )
  }

  const close = async () => {
    await db.destroy()
  }

  return { hasMessages, insertMessages, listMessages, close }
}
