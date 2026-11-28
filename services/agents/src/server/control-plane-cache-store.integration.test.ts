import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { createControlPlaneCacheStore, type UpsertControlPlaneCacheResourceInput } from './control-plane-cache-store'
import type { AgentsDatabase } from './db'
import { up } from './migrations/20260205_agents_control_plane_cache'

vi.mock('./kysely-migrations', () => ({ ensureMigrations: async () => undefined }))

const url = process.env.AGENTS_STORE_TEST_DATABASE_URL

describe.skipIf(!url)('control plane cache batching on PostgreSQL', () => {
  it('writes 200 rows in eight upserts and preserves newer watch writes and tombstones', async () => {
    const queries: string[] = []
    const db = new Kysely<AgentsDatabase>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 1 }) }),
      log: ({ level, query }) => {
        if (level === 'query' && query.sql.startsWith('insert into')) queries.push(query.sql)
      },
    })
    const cluster = `cache-test-${crypto.randomUUID()}`
    const scope = { cluster, kind: 'AgentRun', namespace: 'agents' }
    const projection = (name: string, phase: string): UpsertControlPlaneCacheResourceInput => ({
      key: { ...scope, name },
      uid: name,
      apiVersion: null,
      resourceVersion: null,
      generation: 1,
      labels: {},
      annotations: {},
      resource: { apiVersion: null, kind: scope.kind, metadata: { name }, spec: {}, status: { phase } },
      fingerprint: phase,
      resourceCreatedAt: null,
      resourceUpdatedAt: null,
      statusPhase: phase,
      specRuntimeType: 'job',
      specAgentRefName: null,
      specImplementationSpecRefName: null,
      specSourceProvider: null,
      specSourceExternalId: null,
      specSummary: null,
      specLabels: [],
    })
    const store = createControlPlaneCacheStore({ url, createDb: () => db })
    try {
      await up(db)
      const snapshot = Array.from({ length: 200 }, (_, i) => projection(`run-${i}`, 'Pending'))
      await store.upsertResources(snapshot)
      expect(queries).toHaveLength(8)
      expect((await store.listResources({ ...scope, phase: 'Pending' })).total).toBe(200)

      // Use a fixed cutoff below all watch writes, so the test does not depend on timer resolution.
      await store.upsertResources([projection('run-0', 'Running')])
      await store.markDeleted({ ...scope, name: 'run-1' })
      await store.upsertResources([...snapshot, projection('new-to-cache', 'Pending')], new Date(0))
      expect((await store.getResource({ ...scope, name: 'run-0' }))?.resource.status.phase).toBe('Running')
      expect(await store.getResource({ ...scope, name: 'run-1' })).toBeNull()
      expect((await store.listResources(scope)).total).toBe(200)

      await store.upsertResources([projection('run-0', 'Succeeded')], '2099-01-01T00:00:00Z')
      expect((await store.listResources({ ...scope, phase: 'Succeeded' })).total).toBe(1)
    } finally {
      try {
        await db.deleteFrom('agents_control_plane.resources_current').where('cluster', '=', cluster).execute()
      } finally {
        await store.close()
      }
    }
  })
})
