import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely'
import { describe, expect, it, vi } from 'vitest'

import { createAgentMessagesStore } from './agent-messages-store'
import type { AgentsDatabase } from './db'

vi.mock('~/server/kysely-migrations', () => ({
  ensureMigrations: vi.fn(async () => {}),
}))

type SqlCall = { sql: string; params: readonly unknown[] }

const baseMessage = {
  agent_run_uid: null,
  agent_run_name: null,
  agent_run_namespace: null,
  run_id: null,
  step_id: null,
  agent_id: 'agent',
  role: 'assistant',
  kind: 'status',
  timestamp: new Date('2026-05-06T12:00:00.000Z'),
  channel: 'general',
  stage: null,
  attrs: {},
  dedupe_key: null,
}

const row = (id: string, createdAt: string, content: string) => ({
  ...baseMessage,
  id,
  created_at: new Date(createdAt),
  content,
})

const makeFakeDb = (rows: unknown[]) => {
  const calls: SqlCall[] = []

  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const params = (compiledQuery.parameters ?? []) as readonly unknown[]
      calls.push({ sql: compiledQuery.sql, params })

      if (compiledQuery.sql.toLowerCase().includes('from "agents_comms"."agent_messages"')) {
        return { rows: rows as R[] }
      }

      return { rows: [] as R[] }
    }

    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield* []
    }
  }

  class TestDriver implements Driver {
    async init() {}

    async acquireConnection(): Promise<DatabaseConnection> {
      return new TestConnection()
    }

    async beginTransaction() {}

    async commitTransaction() {}

    async rollbackTransaction() {}

    async releaseConnection() {}

    async destroy() {}
  }

  const db = new Kysely<AgentsDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TestDriver(),
      createIntrospector: (dbInstance) => new PostgresIntrospector(dbInstance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })

  return { db, calls }
}

describe('agent messages store', () => {
  it('returns the newest bounded history in chronological replay order', async () => {
    const { db, calls } = makeFakeDb([
      row('newest', '2026-05-06T21:34:38.000Z', 'newest visible event'),
      row('middle', '2026-05-06T21:34:00.000Z', 'middle visible event'),
      row('oldest-kept', '2026-05-06T21:33:00.000Z', 'oldest kept event'),
    ])
    const store = createAgentMessagesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const messages = await store.listMessages({ channel: 'general', limit: 3 })

    expect(messages.map((message) => message.content)).toEqual([
      'oldest kept event',
      'middle visible event',
      'newest visible event',
    ])
    expect(calls.at(-1)?.sql.toLowerCase()).toContain('order by "created_at" desc')
  })

  it('keeps since queries ascending for incremental catch-up', async () => {
    const { db, calls } = makeFakeDb([
      row('first-new', '2026-05-06T21:34:00.000Z', 'first new event'),
      row('second-new', '2026-05-06T21:34:38.000Z', 'second new event'),
    ])
    const store = createAgentMessagesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    const messages = await store.listMessages({
      channel: 'general',
      since: '2026-05-06T21:33:00.000Z',
      limit: 3,
    })

    expect(messages.map((message) => message.content)).toEqual(['first new event', 'second new event'])
    expect(calls.at(-1)?.sql.toLowerCase()).toContain('order by "created_at" asc')
  })

  it('filters history by AgentRun name and namespace', async () => {
    const { db, calls } = makeFakeDb([row('msg-1', '2026-05-06T21:34:00.000Z', 'agent run named event')])
    const store = createAgentMessagesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await store.listMessages({
      agentRunName: 'agent-run-1',
      agentRunNamespace: 'agents',
      limit: 3,
    })

    const sql = calls.at(-1)?.sql.toLowerCase() ?? ''
    expect(sql).toContain('"agent_run_name" =')
    expect(sql).toContain('"agent_run_namespace" =')
  })

  it('checks existing messages by AgentRun name and namespace', async () => {
    const { db, calls } = makeFakeDb([{ count: '1' }])
    const store = createAgentMessagesStore({
      url: 'postgresql://user:pass@localhost:5432/db',
      createDb: () => db,
    })

    await expect(
      store.hasMessages({
        agentRunName: 'agent-run-1',
        agentRunNamespace: 'agents',
      }),
    ).resolves.toBe(true)

    const sql = calls.at(-1)?.sql.toLowerCase() ?? ''
    expect(sql).toContain('"agent_run_name" =')
    expect(sql).toContain('"agent_run_namespace" =')
  })
})
