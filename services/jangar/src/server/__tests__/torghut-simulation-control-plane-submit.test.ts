import { beforeEach, describe, expect, it, vi } from 'vitest'

type FakeState = {
  runs: Map<string, Record<string, unknown>>
  events: Array<Record<string, unknown>>
  cache: Map<string, Record<string, unknown>>
  artifacts: Map<string, Record<string, unknown>>
  lanes: Map<string, Record<string, unknown>>
  operationLog: string[]
}

const state = vi.hoisted<FakeState>(() => ({
  runs: new Map(),
  events: [],
  cache: new Map(),
  artifacts: new Map(),
  lanes: new Map([
    ['sim-fast-1', { lane_id: 'sim-fast-1', lane_class: 'interactive', status: 'available', run_id: null }],
    ['sim-fast-2', { lane_id: 'sim-fast-2', lane_class: 'interactive', status: 'available', run_id: null }],
    ['sim-fast-3', { lane_id: 'sim-fast-3', lane_class: 'interactive', status: 'available', run_id: null }],
    ['sim-batch-1', { lane_id: 'sim-batch-1', lane_class: 'batch', status: 'available', run_id: null }],
  ]),
  operationLog: [],
}))

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}))

const migrationsMocks = vi.hoisted(() => ({
  ensureMigrations: vi.fn(async () => undefined),
}))

const kubeMocks = vi.hoisted(() => {
  const apply = vi.fn(async () => ({
    metadata: { name: 'workflow-demo', uid: 'wf-uid-1' },
    status: { phase: 'Running', startedAt: '2026-03-06T14:30:00Z' },
  }))
  return {
    apply,
    createKubernetesClient: vi.fn(() => ({
      apply,
      applyManifest: vi.fn(),
      applyStatus: vi.fn(),
      createManifest: vi.fn(),
      delete: vi.fn(),
      patch: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      listEvents: vi.fn(),
      logs: vi.fn(),
    })),
  }
})

vi.mock('~/server/db', () => dbMocks)
vi.mock('~/server/kysely-migrations', () => migrationsMocks)
vi.mock('~/server/primitives-kube', () => ({
  createKubernetesClient: kubeMocks.createKubernetesClient,
}))

const buildFakeDb = (currentState: FakeState) => {
  const readValue = (table: string, filters: Array<[string, unknown]>, mode: 'row' | 'maxseq' | 'rows') => {
    const filterValue = (row: Record<string, unknown>) => filters.every(([column, value]) => row[column] === value)

    if (table === 'torghut_control_plane.simulation_runs') {
      const rows = [...currentState.runs.values()].filter(filterValue)
      return mode === 'rows' ? rows : rows[0]
    }

    if (table === 'torghut_control_plane.dataset_cache') {
      const rows = [...currentState.cache.values()].filter(filterValue)
      return mode === 'rows' ? rows : rows[0]
    }

    if (table === 'torghut_control_plane.simulation_run_events') {
      const rows = currentState.events.filter(filterValue)
      if (mode === 'maxseq') {
        const maxSeq = rows.reduce<number>((max, row) => Math.max(max, Number(row.seq ?? 0)), 0)
        return rows.length > 0 ? { seq: maxSeq } : { seq: null }
      }
      return mode === 'rows' ? rows : rows[0]
    }

    if (table === 'torghut_control_plane.simulation_artifacts') {
      const rows = [...currentState.artifacts.values()].filter(filterValue)
      return mode === 'rows' ? rows : rows[0]
    }

    return mode === 'rows' ? [] : undefined
  }

  const makeSelect = (table: string) => {
    const filters: Array<[string, unknown]> = []
    let mode: 'row' | 'maxseq' | 'rows' = 'row'
    return {
      selectAll() {
        return this
      },
      select() {
        mode = 'maxseq'
        return this
      },
      where(columnOrCallback: string | ((builder: unknown) => unknown), _op?: string, value?: unknown) {
        if (typeof columnOrCallback === 'function') return this
        filters.push([columnOrCallback, value])
        return this
      },
      orderBy() {
        return this
      },
      limit() {
        mode = 'rows'
        return this
      },
      async executeTakeFirst() {
        return readValue(table, filters, mode === 'rows' ? 'row' : mode)
      },
      async executeTakeFirstOrThrow() {
        const value = readValue(table, filters, mode === 'rows' ? 'row' : mode)
        if (!value) throw new Error(`missing row for ${table}`)
        return value
      },
      async execute() {
        const value = readValue(table, filters, 'rows')
        return Array.isArray(value) ? value : []
      },
    }
  }

  const makeInsert = (table: string) => {
    let values: Record<string, unknown> = {}
    return {
      values(input: Record<string, unknown>) {
        values = input
        return this
      },
      onConflict(callback: (builder: unknown) => unknown) {
        callback({
          column: () => ({ doUpdateSet: () => undefined }),
          columns: () => ({ doUpdateSet: () => undefined }),
        })
        return this
      },
      async execute() {
        if (table === 'torghut_control_plane.simulation_runs') {
          currentState.operationLog.push('insert-run')
          currentState.runs.set(String(values.run_id), {
            ...values,
            updated_at: new Date().toISOString(),
          })
          return
        }
        if (table === 'torghut_control_plane.simulation_run_events') {
          currentState.events.push(values)
          return
        }
        if (table === 'torghut_control_plane.dataset_cache') {
          currentState.cache.set(String(values.cache_key), values)
          return
        }
        if (table === 'torghut_control_plane.simulation_artifacts') {
          currentState.artifacts.set(`${values.run_id}:${values.name}`, values)
        }
      },
    }
  }

  const makeUpdate = (table: string) => {
    const filters: Array<[string, unknown]> = []
    let values: Record<string, unknown> = {}
    return {
      set(input: Record<string, unknown>) {
        values = input
        return this
      },
      where(columnOrCallback: string | ((builder: unknown) => unknown), _op?: string, value?: unknown) {
        if (typeof columnOrCallback === 'function') return this
        filters.push([columnOrCallback, value])
        return this
      },
      async executeTakeFirst() {
        if (table !== 'torghut_control_plane.simulation_lane_leases') return { numUpdatedRows: 0 }
        currentState.operationLog.push('reserve-lane')
        const requestedRunId = values.run_id == null ? null : String(values.run_id)
        if (requestedRunId && !currentState.runs.has(requestedRunId)) {
          throw new Error(
            'insert or update on table "simulation_lane_leases" violates foreign key constraint "simulation_lane_leases_run_id_fkey"',
          )
        }
        const lane = currentState.lanes.get('sim-fast-1')
        if (!lane || lane.status !== 'available') return { numUpdatedRows: 0 }
        currentState.lanes.set('sim-fast-1', {
          ...lane,
          ...values,
        })
        return { numUpdatedRows: 1 }
      },
      async execute() {
        if (table === 'torghut_control_plane.simulation_runs') {
          const runId = String(filters.find(([column]) => column === 'run_id')?.[1] ?? '')
          const existing = currentState.runs.get(runId)
          if (existing) {
            currentState.runs.set(runId, {
              ...existing,
              ...values,
            })
          }
          return { numUpdatedRows: existing ? 1 : 0 }
        }
        if (table === 'torghut_control_plane.simulation_lane_leases') {
          const runId = String(filters.find(([column]) => column === 'run_id')?.[1] ?? '')
          for (const [laneId, lane] of currentState.lanes.entries()) {
            if (lane.run_id === runId) {
              currentState.lanes.set(laneId, {
                ...lane,
                ...values,
              })
            }
          }
        }
        return { numUpdatedRows: 1 }
      },
    }
  }

  const makeDelete = (table: string) => {
    const filters: Array<[string, unknown]> = []
    return {
      where(column: string, _op: string, value: unknown) {
        filters.push([column, value])
        return this
      },
      async execute() {
        if (table === 'torghut_control_plane.simulation_runs') {
          const runId = String(filters.find(([column]) => column === 'run_id')?.[1] ?? '')
          currentState.runs.delete(runId)
        }
        return { numDeletedRows: 1 }
      },
    }
  }

  return {
    selectFrom(table: string) {
      return makeSelect(table)
    },
    insertInto(table: string) {
      return makeInsert(table)
    },
    updateTable(table: string) {
      return makeUpdate(table)
    },
    deleteFrom(table: string) {
      return makeDelete(table)
    },
  }
}

import { submitTorghutSimulationRun } from '~/server/torghut-simulation-control-plane'

describe('submitTorghutSimulationRun', () => {
  beforeEach(() => {
    state.runs.clear()
    state.events.length = 0
    state.cache.clear()
    state.artifacts.clear()
    state.operationLog.length = 0
    state.lanes.set('sim-fast-1', {
      lane_id: 'sim-fast-1',
      lane_class: 'interactive',
      status: 'available',
      run_id: null,
    })
    state.lanes.set('sim-fast-2', {
      lane_id: 'sim-fast-2',
      lane_class: 'interactive',
      status: 'available',
      run_id: null,
    })
    state.lanes.set('sim-fast-3', {
      lane_id: 'sim-fast-3',
      lane_class: 'interactive',
      status: 'available',
      run_id: null,
    })
    state.lanes.set('sim-batch-1', { lane_id: 'sim-batch-1', lane_class: 'batch', status: 'available', run_id: null })
    dbMocks.getDb.mockReturnValue(buildFakeDb(state))
    migrationsMocks.ensureMigrations.mockClear()
    kubeMocks.apply.mockClear()
  })

  it('creates the run row before reserving a simulation lane', async () => {
    const result = await submitTorghutSimulationRun({
      runId: 'sim-fk-proof',
      profile: 'compact',
      cachePolicy: 'prefer_cache',
      manifest: {
        dataset_id: 'dataset-a',
        candidate_id: 'intraday_tsmom_v1@prod',
        strategy_spec_ref: 'strategy-specs/intraday_tsmom_v1@1.1.0.json',
        window: {
          start: '2026-03-06T14:30:00Z',
          end: '2026-03-06T14:45:00Z',
        },
      },
    })

    expect(result.idempotent).toBe(false)
    expect(result.run.runId).toBe('sim-fk-proof')
    expect(result.run.namespace).toBe('argo-workflows')
    expect(state.operationLog.indexOf('insert-run')).toBeLessThan(state.operationLog.indexOf('reserve-lane'))
    expect(state.lanes.get('sim-fast-1')?.run_id).toBe('sim-fk-proof')
    expect(state.runs.get('sim-fk-proof')?.lane_id).toBe('sim-fast-1')
    expect(state.runs.get('sim-fk-proof')?.namespace).toBe('argo-workflows')
    expect(state.runs.get('sim-fk-proof')?.workflow_name).toBe('workflow-demo')
    expect((state.runs.get('sim-fk-proof')?.metadata as Record<string, unknown>)?.workflowNamespace).toBe(
      'argo-workflows',
    )
    expect(kubeMocks.apply).toHaveBeenCalledOnce()
    expect((kubeMocks.apply.mock.calls[0]?.[0] as Record<string, unknown>)?.metadata).toMatchObject({
      namespace: 'argo-workflows',
    })
  })
})
