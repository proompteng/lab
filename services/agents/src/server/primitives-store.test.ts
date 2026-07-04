import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Db } from './db'
import { createPrimitivesStore } from './primitives-store'

type IdempotencyDbRow = {
  id: string
  namespace: string
  agent_name: string
  idempotency_key: string
  agent_run_name: string | null
  agent_run_uid: string | null
  terminal_phase: string | null
  terminal_at: Date | null
  created_at: Date
  updated_at: Date
}

const makeIdempotencyRow = (overrides: Partial<IdempotencyDbRow> = {}): IdempotencyDbRow => ({
  id: 'idempotency-1',
  namespace: 'agents',
  agent_name: 'codex-agent',
  idempotency_key: 'delivery-1',
  agent_run_name: null,
  agent_run_uid: null,
  terminal_phase: null,
  terminal_at: null,
  created_at: new Date('2026-07-04T00:00:00.000Z'),
  updated_at: new Date('2026-07-04T00:00:00.000Z'),
  ...overrides,
})

const makeFakeDb = (options: { insertedRow?: IdempotencyDbRow; existingRow?: IdempotencyDbRow }) => {
  const doNothing = vi.fn()
  const columns = vi.fn(() => ({ doNothing }))
  const insertBuilder = {
    values: vi.fn(),
    onConflict: vi.fn(),
    returningAll: vi.fn(),
    executeTakeFirst: vi.fn(),
  }
  const selectBuilder = {
    selectAll: vi.fn(),
    where: vi.fn(),
    executeTakeFirst: vi.fn(),
  }

  insertBuilder.values.mockReturnValue(insertBuilder)
  insertBuilder.onConflict.mockImplementation((callback: (builder: { columns: typeof columns }) => unknown) => {
    callback({ columns })
    return insertBuilder
  })
  insertBuilder.returningAll.mockReturnValue(insertBuilder)
  insertBuilder.executeTakeFirst.mockResolvedValue(options.insertedRow)

  selectBuilder.selectAll.mockReturnValue(selectBuilder)
  selectBuilder.where.mockReturnValue(selectBuilder)
  selectBuilder.executeTakeFirst.mockResolvedValue(options.existingRow)

  const db = {
    insertInto: vi.fn(() => insertBuilder),
    selectFrom: vi.fn(() => selectBuilder),
    destroy: vi.fn(async () => {}),
  }

  return { db: db as unknown as Db, insertBuilder, selectBuilder }
}

describe('createPrimitivesStore', () => {
  const previousMigrationsMode = process.env.AGENTS_MIGRATIONS

  beforeEach(() => {
    process.env.AGENTS_MIGRATIONS = 'skip'
  })

  afterEach(() => {
    if (previousMigrationsMode === undefined) {
      delete process.env.AGENTS_MIGRATIONS
    } else {
      process.env.AGENTS_MIGRATIONS = previousMigrationsMode
    }
  })

  it('reserves new AgentRun idempotency keys without a follow-up lookup', async () => {
    const insertedRow = makeIdempotencyRow()
    const { db, selectBuilder } = makeFakeDb({ insertedRow })
    const store = createPrimitivesStore({
      url: 'postgresql://user:pass@localhost:5432/agents',
      createDb: () => db,
    })

    const result = await store.reserveAgentRunIdempotencyKey({
      namespace: 'agents',
      agentName: 'codex-agent',
      idempotencyKey: 'delivery-1',
    })

    expect(result).toMatchObject({
      created: true,
      record: {
        id: 'idempotency-1',
        namespace: 'agents',
        agentName: 'codex-agent',
        idempotencyKey: 'delivery-1',
      },
    })
    expect(selectBuilder.executeTakeFirst).not.toHaveBeenCalled()
  })

  it('resolves conflicting AgentRun idempotency keys in a separate statement', async () => {
    const existingRow = makeIdempotencyRow({ agent_run_name: 'codex-agent-existing' })
    const { db, selectBuilder } = makeFakeDb({ existingRow })
    const store = createPrimitivesStore({
      url: 'postgresql://user:pass@localhost:5432/agents',
      createDb: () => db,
    })

    const result = await store.reserveAgentRunIdempotencyKey({
      namespace: 'agents',
      agentName: 'codex-agent',
      idempotencyKey: 'delivery-1',
    })

    expect(result).toMatchObject({
      created: false,
      record: {
        id: 'idempotency-1',
        namespace: 'agents',
        agentName: 'codex-agent',
        idempotencyKey: 'delivery-1',
        agentRunName: 'codex-agent-existing',
      },
    })
    expect(selectBuilder.executeTakeFirst).toHaveBeenCalledTimes(1)
  })
})
