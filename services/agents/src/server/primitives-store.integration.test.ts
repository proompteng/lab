import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentsDatabase } from './db'
import { createPrimitivesStore } from './primitives-store'

vi.mock('./kysely-migrations', () => ({ ensureMigrations: async () => undefined }))

const databaseUrl = process.env.AGENTS_STORE_TEST_DATABASE_URL

describe.skipIf(!databaseUrl)('AgentRun updates on PostgreSQL', () => {
  let store: ReturnType<typeof createPrimitivesStore>
  beforeAll(async () => {
    const db = new Kysely<AgentsDatabase>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl, max: 1 }) }),
    })
    await sql`create temporary table agent_runs (
      id uuid primary key default gen_random_uuid(),
      agent_name text not null,
      delivery_id text not null unique,
      provider text not null,
      status text not null,
      external_run_id text,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )`.execute(db)
    store = createPrimitivesStore({ url: databaseUrl, createDb: () => db })
    await store.ready
  })
  afterAll(async () => {
    await store?.close()
  })

  const seed = () =>
    store.createAgentRun({
      agentName: 'codex-agent',
      deliveryId: crypto.randomUUID(),
      provider: 'job',
      status: 'Running',
      externalRunId: 'run-1',
      payload: { resource: { metadata: { uid: 'original-uid' }, status: { phase: 'Running' } } },
    })

  it('preserves cancellation against a projection writer with an older snapshot', async () => {
    const run = await seed()
    const cancellation = { requestedAt: '2026-11-01T00:00:00Z', uid: 'original-uid' }
    await Promise.all([
      store.updateAgentRunDetails({ id: run.id, status: 'Cancelling', payload: { ...run.payload, cancellation } }),
      store.updateAgentRunDetails({ id: run.id, status: 'Running', payload: run.payload }),
    ])
    expect(await store.getAgentRunById(run.id)).toMatchObject({ status: 'Cancelling', payload: { cancellation } })
  })

  it('preserves terminal results against a late running snapshot or cancellation', async () => {
    const run = await seed()
    const resource = {
      metadata: { uid: 'original-uid' },
      status: { phase: 'Succeeded', artifacts: [{ name: 'result', url: 's3://agents/result.json' }] },
    }
    await store.updateAgentRunDetails({ id: run.id, status: 'Succeeded', payload: { resource } })
    await store.updateAgentRunDetails({ id: run.id, status: 'Running', payload: run.payload })
    await store.updateAgentRunDetails({
      id: run.id,
      status: 'Cancelled',
      payload: { ...run.payload, cancellation: { uid: 'original-uid' } },
    })
    expect(await store.getAgentRunById(run.id)).toMatchObject({ status: 'Succeeded', payload: { resource } })
  })

  it('keeps the first cancellation receipt across retries', async () => {
    const run = await seed()
    const cancellation = { requestedAt: '2026-11-01T00:00:00Z', uid: 'original-uid' }
    await store.updateAgentRunDetails({ id: run.id, status: 'Cancelling', payload: { cancellation } })
    await store.updateAgentRunDetails({
      id: run.id,
      status: 'Cancelling',
      payload: { cancellation: { ...cancellation, requestedAt: 'later' } },
    })
    expect(await store.getAgentRunById(run.id)).toMatchObject({
      payload: { cancellation, resource: run.payload.resource },
    })
  })

  it('allows rerun review states after completion and retains them against stale execution updates', async () => {
    const run = await seed()
    const resource = { ...(run.payload.resource as object), status: { phase: 'Succeeded' } }
    await store.updateAgentRunDetails({ id: run.id, status: 'Succeeded', payload: { resource } })
    await store.updateAgentRunDetails({ id: run.id, status: 'needs_iteration', payload: { rerun: { attempt: 1 } } })
    await store.updateAgentRunDetails({ id: run.id, status: 'Succeeded', payload: { resource } })
    expect(await store.getAgentRunById(run.id)).toMatchObject({
      status: 'needs_iteration',
      payload: { resource, rerun: { attempt: 1 } },
    })
    await store.updateAgentRunDetails({ id: run.id, status: 'needs_human', payload: { rerun: { error: 'rejected' } } })
    expect(await store.getAgentRunById(run.id)).toMatchObject({
      status: 'needs_human',
      payload: { rerun: { error: 'rejected' } },
    })
  })

  it('rejects rebinding the projection to another Kubernetes UID', async () => {
    const run = await seed()
    await expect(
      store.updateAgentRunDetails({
        id: run.id,
        status: 'Running',
        payload: { resource: { metadata: { uid: 'replacement-uid' } } },
      }),
    ).rejects.toThrow('AgentRun resource UID cannot change')
    expect(await store.getAgentRunById(run.id)).toMatchObject({ payload: run.payload })
  })
})
