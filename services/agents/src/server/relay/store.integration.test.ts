import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentsDatabase } from '../db'
import { up } from '../migrations/20261106_agents_relay_submissions'
import { createSubmissionStore, type NewSubmission } from './store'

vi.mock('../kysely-migrations', () => ({ ensureMigrations: async () => undefined }))
const url = process.env.AGENTS_STORE_TEST_DATABASE_URL

describe.skipIf(!url)('Relay submissions on PostgreSQL', () => {
  const schema = `relay_fixture_${crypto.randomUUID().replaceAll('-', '')}`
  let db: Kysely<AgentsDatabase>
  let admin: Pool
  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 })
    await admin.query(`CREATE SCHEMA ${schema}`)
    db = new Kysely<AgentsDatabase>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: url, max: 8, options: `-c search_path=${schema}` }),
      }),
    })
    await sql`CREATE TABLE agent_runs (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'Pending',
      delivery_id text NOT NULL, external_run_id text NOT NULL, payload jsonb NOT NULL)`.execute(db)
    await up(db)
  })
  afterAll(async () => {
    await db?.destroy()
    if (admin) {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  })
  const input = (): NewSubmission => ({
    operation_id: crypto.randomUUID(),
    workspace_id: crypto.randomUUID(),
    target_id: 'agents/lab',
    client_service: 'opencode',
    actor: 'workload:fixture',
    authorization_receipt_id: crypto.randomUUID(),
    request_hash: 'hash',
    request_payload: {
      namespace: 'agents',
      metadata: { annotations: { 'relay.proompteng.ai/namespace-uid': 'namespace-uid' } },
      implementation: { text: 'task' },
    },
    run_name: 'relay-fixture',
  })
  const projectionPayload = (request: NewSubmission) => ({
    resource: {
      metadata: {
        name: request.run_name,
        namespace: 'agents',
        uid: crypto.randomUUID().toString(),
        annotations: {
          'relay.proompteng.ai/request-hash': request.request_hash,
          'relay.proompteng.ai/target': request.target_id,
          'relay.proompteng.ai/namespace-uid': 'namespace-uid',
        },
      },
    },
  })
  const insertProjection = async (request: NewSubmission, payload: Record<string, unknown>, status = 'Pending') => {
    const id = crypto.randomUUID()
    await sql`INSERT INTO agent_runs(id, delivery_id, external_run_id, payload, status)
      VALUES (${id}, ${request.operation_id}, ${request.run_name}, ${JSON.stringify(payload)}::jsonb, ${status})`.execute(
      db,
    )
    return id
  }
  it('gives only one concurrent caller submission authority and survives a new store instance', async () => {
    const first = createSubmissionStore(db),
      request = input()
    const results = await Promise.all(Array.from({ length: 16 }, () => first.reserve(request)))
    expect(results.filter((result) => result.created)).toHaveLength(1)
    const restarted = createSubmissionStore(db)
    expect((await restarted.reserve(request)).created).toBe(false)
    await expect(restarted.reserve({ ...request, request_hash: 'changed' })).rejects.toThrow('conflicts')
    await expect(restarted.reserve({ ...request, client_service: 'tengri-web' })).rejects.toThrow('conflicts')
    expect(await restarted.get(request.operation_id, crypto.randomUUID(), request.target_id)).toBeNull()
  })
  it('filters before limiting and never replaces the accepted projection', async () => {
    const store = createSubmissionStore(db),
      request = input(),
      other = input()
    await store.reserve(request)
    await store.reserve(other)
    expect((await store.list(request.workspace_id, request.target_id, 1)).map((row) => row.operation_id)).toEqual([
      request.operation_id,
    ])
    const id = await insertProjection(request, projectionPayload(request)),
      replacement = await insertProjection(request, projectionPayload(request))
    await store.accepted(request.operation_id, id)
    await store.accepted(request.operation_id, id)
    await expect(store.accepted(request.operation_id, replacement)).rejects.toThrow()
    await store.rejected(request.operation_id, 400, 'late error')
    expect(await store.get(request.operation_id, request.workspace_id, request.target_id)).toMatchObject({
      projection_id: id,
      rejection: null,
    })
  })
  it.each(['Cancelling', 'Succeeded', 'needs_human'])(
    'enriches a reconciler projection without changing %s evidence',
    async (status) => {
      const store = createSubmissionStore(db),
        request = input()
      await store.reserve(request)
      const payload = {
        ...projectionPayload(request),
        cancellation: { requestedAt: 'original' },
        result: { response: 'retained' },
      }
      const id = await insertProjection(request, payload, status)
      await Promise.all(Array.from({ length: 8 }, () => store.accepted(request.operation_id, id)))
      const record = await db.selectFrom('agent_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
      expect(record.status).toBe(status)
      expect(record.payload).toEqual({ ...payload, request: request.request_payload })
      expect((await store.get(request.operation_id, request.workspace_id, request.target_id))?.projection_id).toBe(id)
    },
  )
  it.each(['namespace', 'name', 'uid', 'hash', 'target', 'namespaceUid', 'request', 'delivery'])(
    'rejects a projection with mismatched %s before linking or changing it',
    async (field) => {
      const store = createSubmissionStore(db),
        request = input()
      await store.reserve(request)
      const payload: Record<string, unknown> = projectionPayload(request)
      const metadata = (payload.resource as ReturnType<typeof projectionPayload>['resource']).metadata
      if (field === 'namespace') metadata.namespace = 'other'
      if (field === 'name') metadata.name = 'other'
      if (field === 'uid') metadata.uid = ''
      if (field === 'hash') metadata.annotations['relay.proompteng.ai/request-hash'] = 'other'
      if (field === 'target') metadata.annotations['relay.proompteng.ai/target'] = 'other'
      if (field === 'namespaceUid') metadata.annotations['relay.proompteng.ai/namespace-uid'] = 'other'
      if (field === 'request') payload.request = { namespace: 'other' }
      const id = await insertProjection(
        field === 'delivery' ? { ...request, operation_id: crypto.randomUUID() } : request,
        payload,
      )
      await expect(store.accepted(request.operation_id, id)).rejects.toThrow()
      expect((await store.get(request.operation_id, request.workspace_id, request.target_id))?.projection_id).toBeNull()
      const record = await db.selectFrom('agent_runs').selectAll().where('id', '=', id).executeTakeFirstOrThrow()
      expect(record.payload).toEqual(payload)
    },
  )
})
