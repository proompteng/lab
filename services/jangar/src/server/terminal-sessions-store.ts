import { sql } from 'kysely'

import { getDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

export type TerminalSessionStatus = 'creating' | 'ready' | 'error' | 'closed'

export type TerminalSessionRecord = {
  id: string
  status: TerminalSessionStatus
  worktreeName: string | null
  worktreePath: string | null
  tmuxSocket: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  readyAt: string | null
  closedAt: string | null
  metadata: Record<string, unknown>
}

export type TerminalSessionRecordInput = {
  id: string
  status: TerminalSessionStatus
  worktreeName?: string | null
  worktreePath?: string | null
  tmuxSocket?: string | null
  errorMessage?: string | null
  readyAt?: string | null
  closedAt?: string | null
  metadata?: Record<string, unknown>
}

const SCHEMA = 'terminals'
const TABLE = 'sessions'

let dbReady: Promise<Db | null> | null = null

const resolveDb = async () => {
  if (dbReady) return dbReady
  const db = getDb()
  if (!db) {
    dbReady = Promise.resolve(null)
    return dbReady
  }
  dbReady = ensureMigrations(db)
    .then(() => db)
    .catch((error) => {
      console.warn('[terminals] migrations unavailable', error)
      return null
    })
  return dbReady
}

const normalizeMetadata = (value?: Record<string, unknown>) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

const toIso = (value: string | Date | null | undefined) => {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : value
}

const mapRow = (row: {
  id: string
  status: string
  worktree_name: string | null
  worktree_path: string | null
  tmux_socket: string | null
  error_message: string | null
  created_at: string | Date
  updated_at: string | Date
  ready_at: string | Date | null
  closed_at: string | Date | null
  metadata: Record<string, unknown>
}): TerminalSessionRecord => ({
  id: row.id,
  status: row.status as TerminalSessionStatus,
  worktreeName: row.worktree_name,
  worktreePath: row.worktree_path,
  tmuxSocket: row.tmux_socket,
  errorMessage: row.error_message,
  createdAt: toIso(row.created_at) ?? '',
  updatedAt: toIso(row.updated_at) ?? '',
  readyAt: toIso(row.ready_at),
  closedAt: toIso(row.closed_at),
  metadata: normalizeMetadata(row.metadata),
})

export const listTerminalSessionRecords = async (): Promise<TerminalSessionRecord[]> => {
  const db = await resolveDb()
  if (!db) return []
  const rows = await db.selectFrom(`${SCHEMA}.${TABLE}`).selectAll().orderBy('created_at', 'desc').execute()
  return rows.map(mapRow)
}

export const getTerminalSessionRecord = async (id: string): Promise<TerminalSessionRecord | null> => {
  const db = await resolveDb()
  if (!db) return null
  const row = await db.selectFrom(`${SCHEMA}.${TABLE}`).selectAll().where('id', '=', id).executeTakeFirst()
  return row ? mapRow(row) : null
}

export const createTerminalSessionRecord = async (
  input: TerminalSessionRecordInput,
): Promise<TerminalSessionRecord | null> => {
  const db = await resolveDb()
  if (!db) return null
  const row = await db
    .insertInto(`${SCHEMA}.${TABLE}`)
    .values({
      id: input.id,
      status: input.status,
      worktree_name: input.worktreeName ?? null,
      worktree_path: input.worktreePath ?? null,
      tmux_socket: input.tmuxSocket ?? null,
      error_message: input.errorMessage ?? null,
      ready_at: input.readyAt ?? null,
      closed_at: input.closedAt ?? null,
      metadata: normalizeMetadata(input.metadata),
      created_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .returningAll()
    .executeTakeFirst()
  return row ? mapRow(row) : null
}

export const upsertTerminalSessionRecord = async (
  input: TerminalSessionRecordInput,
): Promise<TerminalSessionRecord | null> => {
  const db = await resolveDb()
  if (!db) return null
  const row = await db
    .insertInto(`${SCHEMA}.${TABLE}`)
    .values({
      id: input.id,
      status: input.status,
      worktree_name: input.worktreeName ?? null,
      worktree_path: input.worktreePath ?? null,
      tmux_socket: input.tmuxSocket ?? null,
      error_message: input.errorMessage ?? null,
      ready_at: input.readyAt ?? null,
      closed_at: input.closedAt ?? null,
      metadata: normalizeMetadata(input.metadata),
      created_at: sql`now()`,
      updated_at: sql`now()`,
    })
    .onConflict((conflict) =>
      conflict.column('id').doUpdateSet({
        status: input.status,
        worktree_name: input.worktreeName ?? null,
        worktree_path: input.worktreePath ?? null,
        tmux_socket: input.tmuxSocket ?? null,
        error_message: input.errorMessage ?? null,
        ready_at: input.readyAt ?? null,
        closed_at: input.closedAt ?? null,
        metadata: normalizeMetadata(input.metadata),
        updated_at: sql`now()`,
      }),
    )
    .returningAll()
    .executeTakeFirst()
  return row ? mapRow(row) : null
}

export const updateTerminalSessionRecord = async (
  id: string,
  updates: Omit<TerminalSessionRecordInput, 'id'>,
): Promise<TerminalSessionRecord | null> => {
  const db = await resolveDb()
  if (!db) return null
  const row = await db
    .updateTable(`${SCHEMA}.${TABLE}`)
    .set({
      status: updates.status,
      worktree_name: updates.worktreeName ?? null,
      worktree_path: updates.worktreePath ?? null,
      tmux_socket: updates.tmuxSocket ?? null,
      error_message: updates.errorMessage ?? null,
      ready_at: updates.readyAt ?? null,
      closed_at: updates.closedAt ?? null,
      metadata: normalizeMetadata(updates.metadata),
      updated_at: sql`now()`,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
  return row ? mapRow(row) : null
}
