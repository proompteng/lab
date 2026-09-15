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

type RerunSubmissionDbRow = {
  id: string
  parent_ref: string
  parent_agent_run_id: string | null
  parent_agent_run_name: string | null
  parent_agent_run_namespace: string | null
  attempt: number
  delivery_id: string
  status: string
  submission_attempt: number
  response_status: number | null
  error: string | null
  request_payload: Record<string, unknown>
  response_payload: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
  submitted_at: Date | null
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

const makeRerunSubmissionRow = (overrides: Partial<RerunSubmissionDbRow> = {}): RerunSubmissionDbRow => ({
  id: 'rerun-submission-1',
  parent_ref: 'agent_runs:agent-run-1',
  parent_agent_run_id: 'agent-run-1',
  parent_agent_run_name: 'codex-agent-1',
  parent_agent_run_namespace: 'agents',
  attempt: 2,
  delivery_id: 'rerun-delivery-1',
  status: 'pending',
  submission_attempt: 1,
  response_status: null,
  error: null,
  request_payload: {},
  response_payload: null,
  created_at: new Date('2026-07-04T00:00:00.000Z'),
  updated_at: new Date('2026-07-04T00:00:00.000Z'),
  submitted_at: null,
  ...overrides,
})

const makeFakeDb = (options: {
  insertedRow?: IdempotencyDbRow
  existingRow?: IdempotencyDbRow
  insertedRows?: Array<IdempotencyDbRow | undefined>
  existingRows?: Array<IdempotencyDbRow | undefined>
  updatedRow?: RerunSubmissionDbRow
}) => {
  const insertedRows = [...(options.insertedRows ?? [options.insertedRow])]
  const existingRows = [...(options.existingRows ?? [options.existingRow])]
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
  const updateBuilder = {
    set: vi.fn(),
    where: vi.fn(),
    returningAll: vi.fn(),
    executeTakeFirst: vi.fn(),
  }

  insertBuilder.values.mockReturnValue(insertBuilder)
  insertBuilder.onConflict.mockImplementation((callback: (builder: { columns: typeof columns }) => unknown) => {
    callback({ columns })
    return insertBuilder
  })
  insertBuilder.returningAll.mockReturnValue(insertBuilder)
  insertBuilder.executeTakeFirst.mockImplementation(async () => insertedRows.shift())

  selectBuilder.selectAll.mockReturnValue(selectBuilder)
  selectBuilder.where.mockReturnValue(selectBuilder)
  selectBuilder.executeTakeFirst.mockImplementation(async () => existingRows.shift())

  updateBuilder.set.mockReturnValue(updateBuilder)
  updateBuilder.where.mockReturnValue(updateBuilder)
  updateBuilder.returningAll.mockReturnValue(updateBuilder)
  updateBuilder.executeTakeFirst.mockResolvedValue(options.updatedRow)

  const db = {
    insertInto: vi.fn(() => insertBuilder),
    selectFrom: vi.fn(() => selectBuilder),
    updateTable: vi.fn(() => updateBuilder),
    destroy: vi.fn(async () => {}),
  }

  return { db: db as unknown as Db, insertBuilder, selectBuilder, updateBuilder }
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

  it('retries reservation when the conflicting key disappears before lookup', async () => {
    const insertedRow = makeIdempotencyRow({ id: 'idempotency-2' })
    const { db, insertBuilder, selectBuilder } = makeFakeDb({
      insertedRows: [undefined, insertedRow],
      existingRows: [undefined],
    })
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
        id: 'idempotency-2',
        namespace: 'agents',
        agentName: 'codex-agent',
        idempotencyKey: 'delivery-1',
      },
    })
    expect(insertBuilder.executeTakeFirst).toHaveBeenCalledTimes(2)
    expect(selectBuilder.executeTakeFirst).toHaveBeenCalledTimes(1)
  })

  it('scopes rerun claims to the requested delivery id', async () => {
    const { db, updateBuilder } = makeFakeDb({ updatedRow: makeRerunSubmissionRow() })
    const store = createPrimitivesStore({
      url: 'postgresql://user:pass@localhost:5432/agents',
      createDb: () => db,
    })

    const result = await store.claimAgentRunRerunSubmission({
      parentRef: 'agent_runs:agent-run-1',
      attempt: 2,
      deliveryId: 'rerun-delivery-1',
    })

    expect(result?.shouldSubmit).toBe(true)
    expect(updateBuilder.where).toHaveBeenCalledWith('delivery_id', '=', 'rerun-delivery-1')
  })
})
