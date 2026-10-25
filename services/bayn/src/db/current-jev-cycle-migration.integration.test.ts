import { PgClient, PgMigrator } from '@effect/sql-pg'
import { NodeServices } from '@effect/platform-node'
import { Effect, Exit, Layer, Option, Redacted, Result } from 'effect'
import { expect, test } from 'bun:test'

import { migrationLoader } from './migrations'
import { makeCycleStore } from '../cycle/store/postgres'
import { nativeJevFixture } from '../jev/native.test-support'
import { canonicalHashV1Result } from '../hash'
import { makeCycleDraft, makeCycleIdentity } from '../cycle/construction'
import { baynTestPostgresUrl } from '../test-environment.test-support'

const integration = baynTestPostgresUrl === undefined ? test.skip : test
const url = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55479/bayn_test'
const parsed = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
  throw new Error('Cycle cutover integration requires an isolated local _test database')
const client = PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })
const migrate = PgMigrator.run({ loader: migrationLoader, table: 'schema_migrations' })
const insertRetired = (native: ReturnType<typeof nativeJevFixture>, binding: string, version: 'v3' | 'v4' = 'v3') =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const { cycleId: _cycle, entryAttemptOrdinal: _attempt, ...material } = native.draft.identity
    const identity = {
      ...material,
      qualificationRunId: binding,
      schemaVersion: `bayn.autonomous-cycle-identity.${version}`,
      ...(version === 'v4' ? { entryAttemptOrdinal: 1 } : {}),
      strategyName: 'intraday-momentum',
    }
    const oldId = Result.getOrThrow(canonicalHashV1Result(identity))
    const changed = {
      cycle_id: oldId,
      qualification_run_id: binding,
      schema_version: `bayn.autonomous-cycle.${version}`,
      identity_schema_version: identity.schemaVersion,
      strategy_name: identity.strategyName,
    }
    yield* sql`INSERT INTO autonomous_cycles SELECT (jsonb_populate_record(NULL::autonomous_cycles, to_jsonb(c) || ${sql.json(changed)})).*
    FROM autonomous_cycles c WHERE cycle_id = ${native.draft.identity.cycleId}`
    return oldId
  })
const settleRetired = (oldId: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`UPDATE autonomous_cycles SET state = 'BLOCKED', terminal_reason = 'BLOCKED_AUTHORITY',
    state_version = state_version + 1, terminal_at = updated_at WHERE cycle_id = ${oldId}`
  })
const prepare = (terminal = true, version: 'v3' | 'v4' = 'v3') =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`DROP SCHEMA public CASCADE`
    yield* sql`CREATE SCHEMA public`
    yield* PgMigrator.run({
      loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 127))),
      table: 'schema_migrations',
    })
    const native = nativeJevFixture()
    const store = yield* makeCycleStore()
    yield* store.acquire(native.draft, native.observation.payload.observedAt)
    const oldId = yield* insertRetired(native, 'e'.repeat(64), version)
    if (terminal) yield* settleRetired(oldId)
    return { native, store, oldId }
  })

const run = <A, E>(
  work: Effect.Effect<A, E, Layer.Success<typeof client> | Layer.Success<typeof NodeServices.layer>>,
) => Effect.runPromise(work.pipe(Effect.provide(client), Effect.provide(NodeServices.layer)))

integration.each(['v3', 'v4'] as const)(
  'keeps terminal %s history byte-identical while rejecting new retired writes',
  async (version) => {
    const result = await run(
      Effect.gen(function* () {
        const { native, store, oldId } = yield* prepare(true, version)
        const sql = yield* PgClient.PgClient
        const before =
          yield* sql`SELECT to_jsonb(c)::text AS payload FROM autonomous_cycles c WHERE cycle_id = ${oldId}`
        yield* migrate
        const after = yield* sql`SELECT to_jsonb(c)::text AS payload FROM autonomous_cycles c WHERE cycle_id = ${oldId}`
        const { cycleId: _id, ...identity } = native.draft.identity
        const draft = Result.getOrThrow(
          makeCycleDraft(
            Result.getOrThrow(makeCycleIdentity({ ...identity, qualificationRunId: 'f'.repeat(64) })),
            native.draft.window,
          ),
        )
        const current = yield* store.acquire(draft, native.observation.payload.observedAt)
        const retiredSlot = yield* store.readAuthoritySlot({
          qualificationRunId: 'e'.repeat(64),
          accountId: native.draft.identity.accountId,
          executionSessionDate: native.draft.identity.executionSessionDate,
        })
        const rejected = yield* insertRetired(native, 'c'.repeat(64)).pipe(Effect.result)
        const historicalRewrite = yield* sql`UPDATE autonomous_cycles SET updated_at = updated_at
      WHERE cycle_id = ${oldId}`.pipe(Effect.result)
        return { before, after, current, rejected, historicalRewrite, retiredSlot }
      }),
    )
    expect(result.after).toEqual(result.before)
    expect(Option.isNone(result.retiredSlot)).toBe(true)
    expect(result.current.cycle.identity.strategyName).toBe('jev')
    expect(Result.isFailure(result.rejected)).toBe(true)
    expect(Result.isFailure(result.historicalRewrite)).toBe(true)
  },
)

integration('rolls the cutover back with unfinished retired work and permits retry after settlement', async () => {
  const result = await run(
    Effect.gen(function* () {
      const { oldId } = yield* prepare(false)
      const sql = yield* PgClient.PgClient
      const rejected = yield* migrate.pipe(Effect.exit)
      const recorded = yield* sql`SELECT migration_id FROM schema_migrations WHERE migration_id = 127`
      const constraints =
        yield* sql`SELECT conname FROM pg_constraint WHERE conname = 'autonomous_cycles_current_jev_write'`
      yield* settleRetired(oldId)
      yield* migrate
      const retried = yield* sql`SELECT migration_id FROM schema_migrations WHERE migration_id = 127`
      return { rejected, recorded, constraints, retried }
    }),
  )
  expect(Exit.isFailure(result.rejected)).toBe(true)
  expect(result.recorded).toEqual([])
  expect(result.constraints).toEqual([])
  expect(result.retried).toHaveLength(1)
})
