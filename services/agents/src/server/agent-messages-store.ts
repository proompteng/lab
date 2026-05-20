import { sql } from 'kysely'

import { resolveStoreDb, type Db } from './db'
import { ensureMigrations } from './kysely-migrations'

export type AgentMessageRecord = {
  id: string
  agentRunUid: string | null
  agentRunName: string | null
  agentRunNamespace: string | null
  runId: string | null
  stepId: string | null
  agentId: string | null
  role: string
  kind: string
  timestamp: string | Date
  channel: string | null
  stage: string | null
  content: string
  attrs: Record<string, unknown>
  dedupeKey: string | null
  createdAt: string
}

export type AgentMessageInput = {
  agentRunUid: string | null
  agentRunName: string | null
  agentRunNamespace: string | null
  runId: string | null
  stepId: string | null
  agentId: string | null
  role: string
  kind: string
  timestamp: string | Date
  channel: string | null
  stage: string | null
  content: string
  attrs?: Record<string, unknown>
  dedupeKey?: string | null
}

export type AgentMessagesStore = {
  hasMessages: (input: { runId?: string | null; agentRunUid?: string | null }) => Promise<boolean>
  insertMessages: (messages: AgentMessageInput[]) => Promise<AgentMessageRecord[]>
  listMessages: (input: ListAgentMessagesInput) => Promise<AgentMessageRecord[]>
  close: () => Promise<void>
}

type AgentMessagesStoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

const SCHEMA = 'agents_comms'
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

const countRows = async (db: Db, where: { runId?: string | null; agentRunUid?: string | null }) => {
  const { runId, agentRunUid } = where
  let query = db.selectFrom(`${SCHEMA}.${TABLE}`).select(sql<number>`count(*)`.as('count'))
  if (runId) {
    query = query.where('run_id', '=', runId)
  } else if (agentRunUid) {
    query = query.where('agent_run_uid', '=', agentRunUid)
  } else {
    return 0
  }
  const row = await query.executeTakeFirst()
  const count = row?.count ?? 0
  return Number(count)
}

const mapRow = (row: {
  id: string
  agent_run_uid: string | null
  agent_run_name: string | null
  agent_run_namespace: string | null
  run_id: string | null
  step_id: string | null
  agent_id: string | null
  role: string
  kind: string
  timestamp: string | Date
  channel: string | null
  stage: string | null
  content: string
  attrs: Record<string, unknown>
  dedupe_key: string | null
  created_at: string | Date
}): AgentMessageRecord => ({
  id: row.id,
  agentRunUid: row.agent_run_uid,
  agentRunName: row.agent_run_name,
  agentRunNamespace: row.agent_run_namespace,
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
  agentRunUid?: string | null
  channel?: string | null
  since?: string | null
  limit?: number
}

export const createAgentMessagesStore = (options: AgentMessagesStoreOptions = {}): AgentMessagesStore => {
  const resolved = resolveStoreDb(options)
  if (!resolved.db) {
    throw new Error('DATABASE_URL is required for agent messages storage')
  }
  const db = resolved.db
  let schemaReady: Promise<void> | null = null

  const ensureReady = async () => {
    if (!schemaReady) {
      schemaReady = ensureSchema(db)
    }
    await schemaReady
  }

  const hasMessages = async ({ runId, agentRunUid }: { runId?: string | null; agentRunUid?: string | null }) => {
    await ensureReady()
    if (runId) {
      const count = await countRows(db, { runId })
      if (count > 0) return true
    }
    if (agentRunUid) {
      const count = await countRows(db, { agentRunUid })
      if (count > 0) return true
    }
    return false
  }

  const insertMessages = async (messages: AgentMessageInput[]) => {
    await ensureReady()
    const normalized = messages
      .map((message) => ({
        agent_run_uid: message.agentRunUid,
        agent_run_name: message.agentRunName,
        agent_run_namespace: message.agentRunNamespace,
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

    if (normalized.length === 0) return []

    const inserted: AgentMessageRecord[] = []
    for (const batch of chunk(normalized, INSERT_BATCH_SIZE)) {
      const rows = await db
        .insertInto(`${SCHEMA}.${TABLE}`)
        .values(batch)
        .onConflict((oc) => oc.column('dedupe_key').doNothing())
        .returningAll()
        .execute()
      inserted.push(
        ...rows.map((row) =>
          mapRow({
            ...(row as typeof row & { attrs?: Record<string, unknown> }),
            attrs: normalizeAttrs((row as { attrs?: Record<string, unknown> }).attrs),
          }),
        ),
      )
    }

    return inserted
  }

  const listMessages = async (input: ListAgentMessagesInput): Promise<AgentMessageRecord[]> => {
    await ensureReady()
    const { identifiers, runId, agentRunUid, channel, since } = input
    const limit = normalizeLimit(input.limit)
    let query = db.selectFrom(`${SCHEMA}.${TABLE}`).selectAll()

    if (identifiers && identifiers.length > 0) {
      query = query.where((eb) =>
        eb.or(
          identifiers.map((identifier) => eb.or([eb('run_id', '=', identifier), eb('agent_run_uid', '=', identifier)])),
        ),
      )
    } else if (runId) {
      query = query.where('run_id', '=', runId)
    } else if (agentRunUid) {
      query = query.where('agent_run_uid', '=', agentRunUid)
    }

    if (channel) {
      query = query.where('channel', '=', channel)
    }

    if (since) {
      query = query.where('created_at', '>', since)
    }

    const rows = since
      ? await query.orderBy('created_at', 'asc').limit(limit).execute()
      : (await query.orderBy('created_at', 'desc').limit(limit).execute()).reverse()
    return rows.map((row) =>
      mapRow({
        ...(row as typeof row & { attrs?: Record<string, unknown> }),
        attrs: normalizeAttrs((row as { attrs?: Record<string, unknown> }).attrs),
      }),
    )
  }

  const close = async () => {
    if (resolved.shared) return
    await db.destroy()
  }

  return { hasMessages, insertMessages, listMessages, close }
}
