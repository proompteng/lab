import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient, PgMigrator } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import currentAuthorityWrites from '../../migrations/0136_current_authority_writes'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { Authority } from '../execution/contracts'
import { canonicalHashV1Result } from '../hash'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { makeAuthorityPostgres } from './execution-store/authority-shared'
import { makeObserveAuthorityInterpreter } from './execution-store/observe-authority'
import { migrationLoader } from './migrations'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const url = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const hash = (value: string) => Result.getOrThrow(canonicalHashV1Result({ value }))
const original = hash('current-authority-root')
const retained = hash('retained-authority')
const successor = hash('current-authority-successor')
const broker = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId: 'authority-cutover-test',
  }),
)
const retiredStrategies = [
  ['risk-balanced-trend', 'bayn.risk-balanced-trend.protocol.v3'],
  ['risk-balanced-trend', 'bayn.risk-balanced-trend.protocol.v4'],
  ['opening-drive-momentum', 'bayn.opening-drive.protocol.v2'],
  ['intraday-momentum', 'bayn.intraday-momentum.protocol.v1'],
  ['intraday-momentum', 'bayn.intraday-momentum.protocol.v2'],
  ['intraday-momentum', 'bayn.intraday-momentum.protocol.v3'],
] as const

const makeStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const authority = makeAuthorityPostgres(sql)
  return { authority, ensure: makeObserveAuthorityInterpreter(sql, authority, broker).ensureAuthorityGeneration }
})
const reconcile = (label: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at)
      VALUES(${hash(`${label}-positions`)},'bayn.paper-position-snapshot.v1',${broker.accountId},${hash(label)},${hash(label)},0,clock_timestamp())`
    yield* sql`INSERT INTO reconciliations(reconciliation_id,schema_version,account_id,
      expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
      VALUES(${hash(label)},'bayn.paper-reconciliation.v1',${broker.accountId},${hash(label)},${hash(label)},
        ${hash(label)},'EXACT','[]'::jsonb,clock_timestamp())`
  })
const insertResearch = (
  generationHash: string,
  previous: string,
  version: number,
  strategy: string,
  protocol: string,
  reconciliation: string,
) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,activation_schema_version,
      previous_generation_hash,maximum,authority_version,broker_identity_schema_version,broker_identity_hash,
      broker_provider,broker_environment,activation_source_revision,activation_image_repository,
      activation_image_digest,strategy_name,strategy_behavior_hash,strategy_parameter_hash,
      strategy_parameter_schema_version,account_id,risk_policy_hash,proof_plan_hash,reconciliation_id,
      reconciliation_content_hash,research_plan_hash,strategy_protocol_hash,activated_at)
      VALUES(${generationHash},'bayn.authority-generation-history.v1','bayn.paper-authority-generation.v3',
        ${previous},'PAPER',${version},${broker.schemaVersion},${broker.identityHash},${broker.provider},${broker.environment},
        ${'1'.repeat(40)},'registry.example/bayn',${`sha256:${'2'.repeat(64)}`},${strategy},
        ${hash('behavior')},${hash('parameters')},${protocol},${broker.accountId},${hash('risk')},${hash('plan')},${hash(reconciliation)},
        ${hash(reconciliation)},${hash('research')},${hash('protocol')},clock_timestamp())`
  })
const activate = (generationHash: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`UPDATE authority_state SET generation_hash=${generationHash},maximum='PAPER',effective='PAPER',
      kill_state='CLEAR',reason=NULL,version=(SELECT authority_version FROM authority_generations WHERE generation_hash=${generationHash}),
      updated_at=(SELECT activated_at FROM authority_generations WHERE generation_hash=${generationHash}) WHERE singleton`
  })
const fenceId = 136
const migrate = PgMigrator.run({
  loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id <= fenceId))),
  table: 'schema_migrations',
})
const makeRuntime = () =>
  ManagedRuntime.make(
    PgClient.layer({ url: Redacted.make(url), maxConnections: 1 }).pipe(Layer.provideMerge(NodeServices.layer)),
  )

integration('current authority write cutover', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Authority cutover tests require an isolated local _test database')
    runtime = makeRuntime()
  })
  afterAll(async () => runtime.dispose())
  beforeEach(async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < fenceId))),
          table: 'schema_migrations',
        })
      }),
    ),
  )

  test.each(retiredStrategies)(
    'retains %s / %s and recovers without reopening retired writes',
    async (strategy, protocol) => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const { authority, ensure } = yield* makeStore
          yield* ensure({ generationHash: original, maximum: Authority.Observe })
          yield* reconcile('before')
          yield* insertResearch(retained, original, 2, strategy, protocol, 'before')
          yield* activate(retained)
          const before = yield* sql`SELECT to_jsonb(g)::text AS generation, to_jsonb(s)::text AS state
          FROM authority_generations g JOIN authority_state s USING (generation_hash) WHERE g.generation_hash=${retained}`
          yield* migrate
          expect(
            yield* sql`SELECT to_jsonb(g)::text AS generation, to_jsonb(s)::text AS state
          FROM authority_generations g JOIN authority_state s USING (generation_hash) WHERE g.generation_hash=${retained}`,
          ).toEqual(before)
          expect((yield* authority.readGeneration(retained))[0]?.strategy_parameter_schema_version).toBe(protocol)
          const rejected = yield* insertResearch(hash('rejected'), original, 90, strategy, protocol, 'before').pipe(
            Effect.result,
          )
          expect(Result.isFailure(rejected)).toBe(true)
          if (Result.isFailure(rejected))
            expect(rejected.failure.reason.cause).toMatchObject({
              code: '23514',
              constraint: expect.stringContaining('authority_generations_strategy_'),
            })
          expect(
            Result.isFailure(
              yield* sql`UPDATE authority_generations SET activated_at=activated_at WHERE generation_hash=${retained}`.pipe(
                Effect.result,
              ),
            ),
          ).toBe(true)

          yield* sql`UPDATE authority_state SET effective='OBSERVE',kill_state='ACTIVE',reason='BLOCKED_STRATEGY_PROTOCOL_CUTOVER',
          version=version+1,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond') WHERE singleton`
          expect(
            Result.isFailure(
              yield* ensure({ generationHash: successor, maximum: Authority.Observe }).pipe(Effect.result),
            ),
          ).toBe(true)
          yield* reconcile('after')
          const recovered = yield* ensure({ generationHash: successor, maximum: Authority.Observe })
          expect(recovered).toMatchObject({
            generationHash: successor,
            maximum: Authority.Observe,
            effective: Authority.Observe,
            kill: 'CLEAR',
          })
          expect(yield* ensure({ generationHash: successor, maximum: Authority.Observe })).toEqual(recovered)
          const current = hash('current-paper')
          yield* insertResearch(current, successor, recovered.version + 1, 'jev', 'bayn.jev.protocol.v16', 'after')
          yield* activate(current)
          expect((yield* authority.readGeneration(current))[0]?.strategy_parameter_schema_version).toBe(
            'bayn.jev.protocol.v16',
          )
          expect(
            yield* sql`SELECT to_jsonb(g)::text AS generation FROM authority_generations g WHERE generation_hash=${retained}`,
          ).toEqual(before.map(({ generation }) => ({ generation })))
        }),
      )
    },
  )

  test('initializes and rotates OBSERVE under the installed write contract', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* migrate
        const { ensure } = yield* makeStore
        const initialized = yield* ensure({ generationHash: original, maximum: Authority.Observe })
        expect(initialized).toMatchObject({
          generationHash: original,
          maximum: Authority.Observe,
          kill: 'CLEAR',
          version: 1,
        })
        const rotated = yield* ensure({ generationHash: successor, maximum: Authority.Observe })
        expect(rotated).toMatchObject({
          generationHash: successor,
          maximum: Authority.Observe,
          kill: 'CLEAR',
          version: 2,
        })
      }),
    )
  })

  test.each([
    { strategy_name: null, strategy_parameter_schema_version: 'bayn.jev.protocol.v16' },
    { strategy_name: 'jev', strategy_parameter_schema_version: null },
    { strategy_name: null, strategy_parameter_schema_version: null },
  ])('rejects missing PAPER strategy identity %j', async (identity) => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* migrate
        const { ensure } = yield* makeStore
        yield* ensure({ generationHash: original, maximum: Authority.Observe })
        yield* reconcile('partial')
        yield* insertResearch(retained, original, 2, 'jev', 'bayn.jev.protocol.v16', 'partial')
        const changed = { ...identity, generation_hash: hash('partial-rejected'), authority_version: 3 }
        const rejected = yield* sql`INSERT INTO authority_generations
          SELECT (jsonb_populate_record(NULL::authority_generations,to_jsonb(g)||${sql.json(changed)})).*
          FROM authority_generations g WHERE generation_hash=${retained}`.pipe(Effect.result)
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected)) expect(rejected.failure.reason.cause).toMatchObject({ code: '23514' })
      }),
    )
  })

  test('rejects PAPER with a null activation schema', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* migrate
        const { ensure } = yield* makeStore
        yield* ensure({ generationHash: original, maximum: Authority.Observe })
        yield* reconcile('missing-activation')
        yield* insertResearch(retained, original, 2, 'jev', 'bayn.jev.protocol.v16', 'missing-activation')
        const changed = {
          activation_schema_version: null,
          generation_hash: hash('missing-activation-rejected'),
          authority_version: 3,
        }
        const rejected = yield* sql`INSERT INTO authority_generations
          SELECT (jsonb_populate_record(NULL::authority_generations,to_jsonb(g)||${sql.json(changed)})).*
          FROM authority_generations g WHERE generation_hash=${retained}`.pipe(Effect.result)
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected))
          expect(rejected.failure.reason.cause).toMatchObject({
            code: '23514',
            constraint: 'authority_generations_activation_schema_version_check',
          })
      }),
    )
  })

  test('does not reopen the prior Jev protocol', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        yield* migrate
        const { ensure } = yield* makeStore
        yield* ensure({ generationHash: original, maximum: Authority.Observe })
        yield* reconcile('retired-jev')
        const rejected = yield* insertResearch(
          retained,
          original,
          2,
          'jev',
          'bayn.jev.protocol.v15',
          'retired-jev',
        ).pipe(Effect.result)
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected))
          expect(rejected.failure.reason.cause).toMatchObject({
            code: '23514',
            constraint: expect.stringContaining('authority_generations_strategy_'),
          })
      }),
    )
  })

  test('preserves current PAPER authority without requiring a flat snapshot', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const { ensure } = yield* makeStore
        yield* ensure({ generationHash: original, maximum: Authority.Observe })
        yield* reconcile('current-paper')
        yield* insertResearch(retained, original, 2, 'jev', 'bayn.jev.protocol.v16', 'current-paper')
        yield* activate(retained)
        yield* sql`INSERT INTO position_snapshots(snapshot_id,schema_version,account_id,source_hash,content_hash,position_count,observed_at)
          VALUES(${hash('non-flat-positions')},'bayn.paper-position-snapshot.v1',${broker.accountId},${hash('non-flat')},${hash('non-flat')},1,clock_timestamp())`
        const before = yield* sql`SELECT to_jsonb(g)::text AS generation, to_jsonb(s)::text AS state
          FROM authority_generations g JOIN authority_state s USING (generation_hash) WHERE g.generation_hash=${retained}`
        yield* migrate
        expect(
          yield* sql`SELECT to_jsonb(g)::text AS generation, to_jsonb(s)::text AS state
          FROM authority_generations g JOIN authority_state s USING (generation_hash) WHERE g.generation_hash=${retained}`,
        ).toEqual(before)
      }),
    )
  })

  test('preserves qualified v2 evidence while rejecting another qualified write', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const { ensure } = yield* makeStore
        yield* ensure({ generationHash: original, maximum: Authority.Observe })
        yield* reconcile('qualified')
        yield* insertResearch(retained, original, 2, 'jev', 'bayn.jev.protocol.v16', 'qualified')
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Copy the installed checks, without unrelated qualification evidence foreign keys.
            // The temporary table shadows only this transaction's authority write target.
            yield* sql`CREATE TEMP TABLE authority_generations (LIKE public.authority_generations INCLUDING ALL) ON COMMIT DROP`
            const qualified = {
              activation_schema_version: 'bayn.paper-authority-generation.v2',
              qualification_run_id: hash('run'),
              qualification_lock_id: hash('lock'),
              qualification_result_hash: hash('result'),
              protocol_hash: hash('protocol'),
              qualification_execution_policy_hash: hash('policy'),
              qualification_source_revision: '3'.repeat(40),
              qualification_image_repository: 'registry.example/bayn',
              qualification_image_digest: `sha256:${'4'.repeat(64)}`,
              research_plan_hash: null,
              strategy_protocol_hash: null,
            }
            yield* sql`INSERT INTO authority_generations SELECT (jsonb_populate_record(NULL::authority_generations,to_jsonb(g)||${sql.json(qualified)})).*
            FROM public.authority_generations g WHERE generation_hash=${retained}`
            const before = yield* sql`SELECT to_jsonb(g)::text AS generation FROM authority_generations g`
            yield* currentAuthorityWrites
            expect(yield* sql`SELECT to_jsonb(g)::text AS generation FROM authority_generations g`).toEqual(before)
            const rejected = yield* sql
              .withTransaction(sql`INSERT INTO authority_generations
            SELECT (jsonb_populate_record(NULL::authority_generations,to_jsonb(g)||jsonb_build_object('generation_hash',${hash('qualified-rejected')}::text,'authority_version',90))).*
            FROM authority_generations g`)
              .pipe(Effect.result)
            expect(Result.isFailure(rejected)).toBe(true)
            if (Result.isFailure(rejected))
              expect(rejected.failure.reason.cause).toMatchObject({
                code: '23514',
                constraint: 'authority_generations_activation_schema_version_check',
              })
          }),
        )
      }),
    )
  })
})
