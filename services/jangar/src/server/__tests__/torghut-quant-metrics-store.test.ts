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

type SqlCall = { sql: string; params: readonly unknown[] }

const dbMocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}))

const migrationMocks = vi.hoisted(() => ({
  ensureMigrations: vi.fn(async () => {}),
}))

vi.mock('../db', () => ({
  getDb: dbMocks.getDb,
}))

vi.mock('../kysely-migrations', () => ({
  ensureMigrations: migrationMocks.ensureMigrations,
}))

const makeFakeDb = () => {
  const calls: SqlCall[] = []

  class TestConnection implements DatabaseConnection {
    async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
      calls.push({
        sql: compiledQuery.sql,
        params: (compiledQuery.parameters ?? []) as readonly unknown[],
      })
      return { rows: [] as R[] }
    }

    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      yield { rows: [] as R[] }
    }
  }

  class TestDriver implements Driver {
    private readonly connection = new TestConnection()

    async init(): Promise<void> {}

    async acquireConnection(): Promise<DatabaseConnection> {
      return this.connection
    }

    async beginTransaction(): Promise<void> {}

    async commitTransaction(): Promise<void> {}

    async rollbackTransaction(): Promise<void> {}

    async releaseConnection(): Promise<void> {}

    async destroy(): Promise<void> {}
  }

  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new TestDriver(),
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })

  return { db, calls }
}

describe('torghut quant metrics store', () => {
  beforeEach(() => {
    dbMocks.getDb.mockReset()
    migrationMocks.ensureMigrations.mockClear()
  })

  it('uses the primary-keyed pipeline-health latest table', async () => {
    const { db, calls } = makeFakeDb()
    dbMocks.getDb.mockReturnValue(db)
    const { listLatestQuantPipelineHealth } = await import('../torghut-quant-metrics-store')

    await listLatestQuantPipelineHealth({
      account: 'paper',
      window: '15m',
      minCreatedAt: '2026-05-05T15:00:00.000Z',
    })

    const pipelineHealthSql = calls.find((call) => call.sql.includes('quant_pipeline_health_latest'))?.sql
    expect(pipelineHealthSql).toBeTruthy()
    const normalized = String(pipelineHealthSql).toLowerCase().replace(/\s+/g, ' ')

    expect(normalized).toContain('from torghut_control_plane.quant_pipeline_health_latest')
    expect(normalized).toContain('where account = $1 and "window" = $2 and updated_at >= $3')
    expect(normalized).not.toContain('distinct on')
    expect(normalized).not.toContain('torghut_control_plane.quant_pipeline_health where')
  })

  it('creates the latest-state table and index without scanning legacy health history', async () => {
    const { db, calls } = makeFakeDb()
    const { up } = await import('../migrations/20260715_torghut_quant_pipeline_health_latest')

    await up(db)

    expect(calls).toHaveLength(2)
    const normalized = calls.map((call) => call.sql.toLowerCase().replace(/\s+/g, ' '))
    expect(normalized[0]).toContain('create table if not exists "torghut_control_plane"."quant_pipeline_health_latest"')
    expect(normalized[0]).toContain('primary key (strategy_id, account, "window", stage)')
    expect(normalized[1]).toContain(
      'on "torghut_control_plane"."quant_pipeline_health_latest" (account, "window", updated_at desc)',
    )
    expect(normalized.join(' ')).not.toContain('torghut_control_plane.quant_pipeline_health ')
  })

  it('cuts series writes over to an empty partitioned store without copying legacy history', async () => {
    const { db, calls } = makeFakeDb()
    const { up } = await import('../migrations/20260715_torghut_quant_series_active')

    await up(db)

    expect(calls).toHaveLength(24)
    const normalized = calls.map((call) => call.sql.toLowerCase().replace(/\s+/g, ' '))
    expect(normalized[0]).toContain("set local lock_timeout = '5s'")
    expect(normalized[1]).toContain(
      'alter table torghut_control_plane.quant_metrics_series rename to quant_metrics_series_legacy',
    )
    expect(normalized[2]).toContain('create table "torghut_control_plane"."quant_metrics_series_active"')
    expect(normalized[2]).toContain('partition by hash (strategy_id)')

    const partitions = normalized.filter((statement) => statement.includes('partition of'))
    expect(partitions).toHaveLength(16)
    expect(partitions[0]).toContain('modulus 16, remainder 0')
    expect(partitions[15]).toContain('modulus 16, remainder 15')

    expect(normalized.join(' ')).toContain('torghut_qm_series_active_lookup_idx')
    expect(normalized.join(' ')).toContain('torghut_qm_series_active_as_of_brin')
    expect(normalized.join(' ')).toContain('create view torghut_control_plane.quant_metrics_series as')
    expect(normalized.join(' ')).toContain('union all')
    expect(normalized.join(' ')).toContain('instead of insert on torghut_control_plane.quant_metrics_series')
    expect(normalized.join(' ')).not.toContain('insert into torghut_control_plane.quant_metrics_series_legacy select')
    expect(normalized.join(' ')).not.toContain('create table as select')
  })

  it('avoids physical latest-metric updates when every material value is unchanged', async () => {
    const { db, calls } = makeFakeDb()
    dbMocks.getDb.mockReturnValue(db)
    const { upsertQuantLatestMetrics } = await import('../torghut-quant-metrics-store')

    await upsertQuantLatestMetrics({
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account: 'paper',
      window: '1m',
      metrics: [
        {
          metricName: 'net_pnl',
          window: '1m',
          status: 'ok',
          quality: 'good',
          unit: 'usd',
          valueNumeric: 12.5,
          formulaVersion: 'v1',
          asOf: '2026-07-15T03:00:00.000Z',
          freshnessSeconds: 1,
        },
      ],
    })

    const latestSql = calls.find((call) => call.sql.includes('quant_metrics_latest'))?.sql
    const normalized = String(latestSql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).toContain('on conflict')
    expect(normalized).toContain('do update set')
    expect(normalized).toContain('is distinct from')
  })

  it('upserts one pipeline-health row per strategy, account, window, and stage', async () => {
    const { db, calls } = makeFakeDb()
    dbMocks.getDb.mockReturnValue(db)
    const { upsertQuantPipelineHealth } = await import('../torghut-quant-metrics-store')

    await upsertQuantPipelineHealth({
      rows: [
        {
          strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          account: 'paper',
          stage: 'compute',
          ok: true,
          lagSeconds: 1,
          asOf: '2026-07-15T03:00:00.000Z',
          details: { window: '1m' },
        },
      ],
    })

    const healthSql = calls.find((call) => call.sql.includes('quant_pipeline_health_latest'))?.sql
    const normalized = String(healthSql).toLowerCase().replace(/\s+/g, ' ')
    expect(normalized).toContain('insert into "torghut_control_plane"."quant_pipeline_health_latest"')
    expect(normalized).toContain('on conflict ("strategy_id", "account", "window", "stage") do update set')
  })

  it('rejects pipeline-health rows without an explicit window', async () => {
    const { db } = makeFakeDb()
    dbMocks.getDb.mockReturnValue(db)
    const { upsertQuantPipelineHealth } = await import('../torghut-quant-metrics-store')

    await expect(
      upsertQuantPipelineHealth({
        rows: [
          {
            strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            account: 'paper',
            stage: 'compute',
            ok: true,
            lagSeconds: 1,
            asOf: '2026-07-15T03:00:00.000Z',
            details: {},
          },
        ],
      }),
    ).rejects.toThrow('quant pipeline health details.window is required')
  })
})
