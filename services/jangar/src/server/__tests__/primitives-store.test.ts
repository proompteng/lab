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
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database } from '../db'
import { createPrimitivesStore } from '../primitives-store'

type SqlCall = { sql: string; params: readonly unknown[] }

const auditSinkMocks = vi.hoisted(() => ({
  emitAuditEventToOptionalSink: vi.fn(async () => {}),
}))

vi.mock('~/server/audit-sink', () => auditSinkMocks)

vi.mock('~/server/kysely-migrations', () => ({
  ensureMigrations: vi.fn(async () => {}),
}))

const createdAt = new Date('2026-05-14T09:15:00.000Z')

const makeFakeDb = () => {
  const calls: SqlCall[] = []

  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      const params = (compiledQuery.parameters ?? []) as readonly unknown[]
      calls.push({ sql: compiledQuery.sql, params })

      if (compiledQuery.sql.toLowerCase().includes('insert into "audit_events"')) {
        const [entityType, entityId, eventType, payloadJson] = params
        return {
          rows: [
            {
              id: '00000000-0000-4000-8000-000000000001',
              entity_type: entityType,
              entity_id: entityId,
              event_type: eventType,
              payload: JSON.parse(String(payloadJson)) as Record<string, unknown>,
              created_at: createdAt,
            },
          ] as R[],
        }
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

  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TestDriver(),
      createIntrospector: (dbInstance) => new PostgresIntrospector(dbInstance),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })

  return { db, calls }
}

describe('primitives store audit events', () => {
  beforeEach(() => {
    auditSinkMocks.emitAuditEventToOptionalSink.mockClear()
  })

  it('persists audit events through the audit_events table', async () => {
    const { db, calls } = makeFakeDb()
    const store = createPrimitivesStore({
      url: 'postgresql://user:pass@localhost:5432/jangar',
      createDb: () => db,
    })
    const entityId = '00000000-0000-4000-8000-000000000002'

    const event = await store.createAuditEvent({
      entityType: 'agent_run',
      entityId,
      eventType: 'agent_run.submitted',
      context: {
        source: 'unit-test',
        actor: 'alice',
        correlationId: 'corr-1',
        requestId: 'req-1',
        deliveryId: 'delivery-1',
        namespace: 'agents',
        repository: 'proompteng/lab',
      },
      details: {
        action: 'submit',
        attempt: 1,
      },
    })

    expect(event).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      entityType: 'agent_run',
      entityId,
      eventType: 'agent_run.submitted',
      payload: {
        source: 'unit-test',
        actor: 'alice',
        correlationId: 'corr-1',
        requestId: 'req-1',
        deliveryId: 'delivery-1',
        namespace: 'agents',
        repository: 'proompteng/lab',
        repoOwner: 'proompteng',
        repoName: 'lab',
        details: {
          action: 'submit',
          attempt: 1,
        },
      },
      createdAt,
    })

    const insertCall = calls.find((call) => call.sql.toLowerCase().includes('insert into "audit_events"'))
    expect(insertCall).toBeDefined()
    expect(insertCall?.sql.toLowerCase()).toContain('"payload"')
    expect(insertCall?.sql.toLowerCase()).toContain('::jsonb')
    expect(insertCall?.params.slice(0, 3)).toEqual(['agent_run', entityId, 'agent_run.submitted'])
    expect(JSON.parse(String(insertCall?.params[3]))).toEqual(event.payload)
    expect(auditSinkMocks.emitAuditEventToOptionalSink).toHaveBeenCalledWith(event)

    await store.close()
  })
})
