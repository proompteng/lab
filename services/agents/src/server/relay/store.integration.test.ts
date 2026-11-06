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
    await sql`CREATE TABLE agent_runs (id uuid PRIMARY KEY, status text NOT NULL DEFAULT 'Pending')`.execute(db)
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
    request_payload: { implementation: { text: 'task' } },
    run_name: 'relay-fixture',
  })
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
    const id = crypto.randomUUID(),
      replacement = crypto.randomUUID()
    await sql`INSERT INTO agent_runs(id) VALUES (${id}), (${replacement})`.execute(db)
    await store.accepted(request.operation_id, id)
    await store.accepted(request.operation_id, id)
    await expect(store.accepted(request.operation_id, replacement)).rejects.toThrow()
    await store.rejected(request.operation_id, 400, 'late error')
    expect(await store.get(request.operation_id, request.workspace_id, request.target_id)).toMatchObject({
      projection_id: id,
      rejection: null,
    })
  })
})
