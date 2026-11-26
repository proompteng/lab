import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { makeCycleStore } from '../cycle/store/postgres'
import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../hash'
import { exchangeSessions } from '../market-hours'
import { makeOwnedIntradayAlphaObservation } from '../strategy/intraday-alpha/observation'
import {
  makeAlphaStreamingSnapshot,
  makeFlatAlphaPortfolio,
  makeTestTrailingBaseline,
} from '../strategy/intraday-alpha/test-support'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  prepareClonedPostgres,
  type PostgresTestDatabase,
  type PostgresTestTemplate,
} from '../testing/postgres-template.test-support'
import { deriveAlphaBaselineSources, earliestAlphaObservationWitness } from './alpha-observation-witness'
import { readStrategyBoundSystemDurableObservations, readSystemAlphaObservations } from './capture-queries'
import { nativeRegistrationFixture, registrationFixture, testHash } from './fixtures.test-support'
import { initializeQualificationHistory, registerSystemQualification } from './postgres'
import { persistSystemSourceCut, PreparedAlphaSystemSourceCutSchema } from './source-cut'
import { preparedAlphaRegistrationFixture } from './prepared-alpha-registration.test-support'

const postgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    PostgresClientLive({
      operationTimeoutMs: 10000,
      postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
    }).pipe(Layer.provideMerge(NodeServices.layer)),
  )
const history = {
  schemaVersion: 'bayn.system-qualification-history.v1',
  program: 'BAYN_SYSTEM_QUALIFICATION',
  historySourceHash: sha256('alpha witness history fixture'),
  auditedAt: '2026-09-01T00:00:00.000Z',
  attempts: [],
}
const calendar = Result.getOrThrow(
  normalizeMarketCalendarResult(
    [{ session_open: '0400', session_close: '2000', date: '2026-09-04', open: '09:30', close: '16:00' }],
    { start: '2026-09-04', end: '2026-09-04' },
  ),
)
const registration = preparedAlphaRegistrationFixture(
  nativeRegistrationFixture(
    {
      ...registrationFixture('2026-09-03T11:00:00.000Z', 1),
      priorAttemptHash: testHash(history),
    },
    calendar,
  ),
)
const candidate = registration.policies.find((policy) => policy.policy === 'JEV')
if (candidate === undefined) throw new Error('Missing alpha candidate')
const protocol = registration.obligations.configuration.protocol
const market = makeAlphaStreamingSnapshot({ minutesFromOpen: 121, profiles: {}, snapshotCalendar: calendar })
const session = exchangeSessions(market.snapshot.manifest.calendar)[0]
const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(protocol.executionModel))
if (session === undefined || executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
  throw new Error('Missing alpha execution session')
const accountId = candidate.riskPolicy.accountId
const identity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId,
  }),
)
const draft = Result.getOrThrow(
  makeIntradayCycleDraft(
    {
      cycleBindingId: sha256('alpha witness cycle binding'),
      strategyName: 'jev',
      strategyProtocolHash: candidate.protocolHash,
      accountId,
      executionPolicy,
    },
    market.snapshot.manifest.calendar,
    session,
  ),
)
const observed = Result.getOrThrow(
  makeOwnedIntradayAlphaObservation({
    cycleId: draft.identity.cycleId,
    authorityGenerationHash: candidate.authorityGenerationHash,
    protocol,
    portfolio: makeFlatAlphaPortfolio(market.observedAt, undefined, undefined, accountId),
    trailingBaseline: makeTestTrailingBaseline(),
    snapshot: market.snapshot,
  }),
)
const registrationHash = testHash(registration)
const at = (delay: number) => new Date(Date.parse(market.observedAt) + delay).toISOString()
const atClock = <A, E>(time: string, work: Effect.Effect<A, E, PgClient.PgClient>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SET LOCAL search_path=public,pg_catalog`
        yield* sql`SELECT set_config('bayn_test.now',${time},true)`
        return yield* work
      }),
    )
  })
const insertObservation = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`INSERT INTO intraday_candidate_observations(content_hash,cycle_id,observed_at,payload)
    VALUES (${observed.contentHash},${draft.identity.cycleId},${market.observedAt},${sql.json(observed.payload)})`
})
const witness = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`UPDATE execution_controller_status SET last_receipt_hash=last_receipt_hash
    WHERE controller_key=${identity.identityHash}`
})
const retainedWitnesses = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return yield* sql`SELECT source_hash, to_char(witnessed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS witnessed_at
    FROM system_durable_observations WHERE registration_hash=${registrationHash} AND kind='ALPHA_OBSERVATION'`
})

postgres('committed alpha observation witnesses', () => {
  let template: PostgresTestTemplate
  let database: PostgresTestDatabase
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(async () => {
    template = await prepareClonedPostgres(baynTestPostgresUrl ?? '', async (url) => {
      const setup = makeRuntime(url)
      try {
        await setup.runPromise(postgresMigrations)
      } finally {
        await setup.dispose()
      }
    })
  }, 30000)
  beforeEach(async () => {
    database = await template.clone()
    runtime = makeRuntime(database.url)
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        // The disposable database clock advances deterministically; source/witness transactions remain real PostgreSQL commits.
        yield* sql`CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE
        RETURN current_setting('bayn_test.now')::timestamptz`
        yield* atClock(
          '2026-09-03T12:00:00.000Z',
          Effect.gen(function* () {
            yield* initializeQualificationHistory(history, new Set([history.historySourceHash]))
            yield* registerSystemQualification(
              registration,
              new Set([
                registration.calendar.sourceHash,
                ...registration.costAllocationPlans.map((plan) => plan.basisSourceHash),
                ...registration.statisticalPlan.supports.map((support) => support.sourceHash),
              ]),
            )
          }),
        )
        yield* atClock(
          market.observedAt,
          Effect.gen(function* () {
            yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,maximum,authority_version,account_id,
          broker_identity_schema_version,broker_identity_hash,broker_provider,broker_environment,activated_at)
          VALUES (${candidate.authorityGenerationHash},'bayn.authority-generation-history.v1','OBSERVE',1,${accountId},
            'bayn.broker-identity.v2',${identity.identityHash},'alpaca','sandbox',${market.observedAt})`
            expect(
              yield* sql`SELECT
              to_char(execution_account_now(${accountId}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed_at,
              to_char(execution_account_commit_now(${accountId}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS committed_at`,
            ).toEqual([{ observed_at: market.observedAt, committed_at: market.observedAt }])
            yield* (yield* makeCycleStore({ now: sql`${market.observedAt}::timestamptz` })).acquire(
              draft,
              market.observedAt,
            )
            yield* sql`INSERT INTO execution_controller_status(controller_key,plan_hash,active,epoch,next_sequence)
          VALUES (${identity.identityHash},${registration.obligations.configuration.controllerPlanHash},true,1,0)`
          }),
        )
      }),
    )
  }, 30000)
  afterEach(async () => {
    try {
      await runtime?.dispose()
    } finally {
      await database?.dispose()
    }
  })
  afterAll(async () => {
    await template?.dispose()
  })

  test('rollback and released savepoint cannot give a later identical source an earlier witness', async () => {
    const rolledBack = await runtime.runPromiseExit(
      atClock(
        at(100),
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          yield* sql.withTransaction(insertObservation)
          yield* witness
          expect(yield* retainedWitnesses).toEqual([])
          expect(
            yield* sql`SELECT count(*)::integer AS count FROM system_pending_evidence WHERE kind='ALPHA_OBSERVATION'`,
          ).toEqual([{ count: 1 }])
          return yield* Effect.fail('rollback source and its pending witness')
        }),
      ),
    )
    expect(Exit.isFailure(rolledBack)).toBe(true)
    await runtime.runPromise(atClock(at(1000), witness))
    expect(await runtime.runPromise(retainedWitnesses)).toEqual([])
    expect(
      await runtime.runPromise(
        Effect.flatMap(
          PgClient.PgClient,
          (sql) => sql`SELECT count(*)::integer AS count FROM intraday_candidate_observations`,
        ),
      ),
    ).toEqual([{ count: 0 }])
    await runtime.runPromise(atClock(at(2000), insertObservation))
    expect(await runtime.runPromise(retainedWitnesses)).toEqual([])
    await runtime.runPromise(atClock(at(3000), witness))
    expect(await runtime.runPromise(retainedWitnesses)).toEqual([
      { source_hash: observed.contentHash, witnessed_at: at(3000) },
    ])
    await runtime.runPromise(atClock(at(4000), witness))
    expect(await runtime.runPromise(retainedWitnesses)).toEqual([
      { source_hash: observed.contentHash, witnessed_at: at(3000) },
    ])
    // The consumed queue key is absent: rejection must come from the source-trigger guard, not a duplicate key.
    expect(
      await runtime.runPromise(
        Effect.flatMap(
          PgClient.PgClient,
          (sql) => sql`SELECT count(*)::integer AS count FROM system_pending_evidence WHERE kind='ALPHA_OBSERVATION'`,
        ),
      ),
    ).toEqual([{ count: 0 }])
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          atClock(
            at(5000),
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              yield* sql`INSERT INTO system_pending_evidence(registration_hash,kind,source_hash,source_at,correct)
        VALUES (${registrationHash},'ALPHA_OBSERVATION',${observed.contentHash},${market.observedAt},true)`
            }),
          ),
        ),
      ),
    ).toBe(true)
  })

  test('a deferred source rejection leaves no witness and manual witness insertion is rejected', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE FUNCTION reject_alpha_test_source() RETURNS trigger LANGUAGE plpgsql AS $function$
        BEGIN RAISE EXCEPTION 'deferred alpha source rejection' USING ERRCODE='23514'; END $function$`
        yield* sql`CREATE CONSTRAINT TRIGGER reject_alpha_test_source AFTER INSERT ON intraday_candidate_observations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_alpha_test_source()`
      }),
    )
    expect(
      Exit.isFailure(await runtime.runPromiseExit(atClock(at(100), insertObservation.pipe(Effect.andThen(witness))))),
    ).toBe(true)
    await runtime.runPromise(atClock(at(1000), witness))
    expect(await runtime.runPromise(retainedWitnesses)).toEqual([])
    await runtime.runPromise(
      Effect.flatMap(
        PgClient.PgClient,
        (sql) => sql`DROP TRIGGER reject_alpha_test_source ON intraday_candidate_observations`,
      ),
    )
    await runtime.runPromise(atClock(at(1500), insertObservation))
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          atClock(
            at(2000),
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              yield* sql`INSERT INTO system_durable_observations(registration_hash,kind,source_hash,source_at,witnessed_at,correct)
        VALUES (${registrationHash},'ALPHA_OBSERVATION',${observed.contentHash},${market.observedAt},${at(100)},true)`
            }),
          ),
        ),
      ),
    ).toBe(true)
  })

  test('persisted v6 cuts retain alpha observations for latency without substituting preparation availability', async () => {
    await runtime.runPromise(atClock(at(100), insertObservation))
    const capture = (asOf: string, account = accountId, generation = candidate.authorityGenerationHash) =>
      readSystemAlphaObservations(account, generation, registration.calendar, asOf, testHash(protocol))
    const alphaObservations = await runtime.runPromise(capture(at(5000)))
    expect(alphaObservations).toEqual([{ contentHash: observed.contentHash, payload: observed.payload }])
    expect(await runtime.runPromise(capture(at(-1)))).toEqual([])
    expect(await runtime.runPromise(capture(at(5000), 'another-account'))).toEqual([])
    expect(await runtime.runPromise(capture(at(5000), accountId, sha256('another generation')))).toEqual([])
    const cut = Schema.decodeUnknownSync(PreparedAlphaSystemSourceCutSchema)({
      schemaVersion: 'bayn.system-source-cut.v6',
      registrationHash,
      asOf: at(5000),
      runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
      alphaObservations,
      alphaBaselinePreparations: [],
      financial: [],
      inference: [],
      inferenceLedgerEvidenceHash: sha256('alpha witness inference'),
      protectionIntents: [],
      decisions: [],
      batches: [],
      decisionAdmissions: [],
      mutations: [],
      fills: [],
      orders: [],
      accountMarks: [],
      controllerPasses: [],
      durableObservations: await runtime.runPromise(
        readStrategyBoundSystemDurableObservations(registrationHash, at(5000)),
      ),
      sourceMaterial: {},
      sourceMaterialHash: testHash({}),
    })
    await runtime.runPromise(persistSystemSourceCut(cut))
    expect(Result.getOrThrow(deriveAlphaBaselineSources(cut))).toEqual([])
    expect(Result.getOrThrow(earliestAlphaObservationWitness(cut, observed.contentHash))).toBeNull()
    // A witness between milliseconds becomes available only at the next representable replay instant.
    await runtime.runPromise(atClock(at(1000).replace('.000Z', '.000500Z'), witness))
    expect(await runtime.runPromise(readStrategyBoundSystemDurableObservations(registrationHash, at(1000)))).toEqual([])
    const durableObservations = await runtime.runPromise(
      readStrategyBoundSystemDurableObservations(registrationHash, at(1001)),
    )
    expect(durableObservations).toEqual([
      {
        kind: 'ALPHA_OBSERVATION',
        sourceHash: observed.contentHash,
        sourceAt: market.observedAt,
        witnessedAt: at(1001),
        correct: true,
      },
    ])
    expect(
      await runtime.runPromise(readStrategyBoundSystemDurableObservations(sha256('another registration'), at(5000))),
    ).toEqual([])
    const witnessed = {
      ...cut,
      durableObservations,
    }
    await runtime.runPromise(persistSystemSourceCut(witnessed))
    expect(Result.getOrThrow(earliestAlphaObservationWitness(witnessed, observed.contentHash))?.witnessedAt).toBe(
      at(1001),
    )
    expect(Result.getOrThrow(deriveAlphaBaselineSources(witnessed))).toEqual([])
    for (const forged of [
      {
        ...witnessed,
        durableObservations: witnessed.durableObservations.map((row) => ({ ...row, witnessedAt: at(500) })),
      },
      {
        ...witnessed,
        alphaObservations: [
          { contentHash: observed.contentHash, payload: { ...observed.payload, cycleId: sha256('foreign cycle') } },
        ],
      },
    ])
      expect(Exit.isFailure(await runtime.runPromiseExit(persistSystemSourceCut(forged)))).toBe(true)
    const { alphaObservations: _alpha, alphaBaselinePreparations: _prepared, ...oldCut } = cut
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(persistSystemSourceCut({ ...oldCut, schemaVersion: 'bayn.system-source-cut.v4' })),
      ),
    ).toBe(true)
  })

  test('v7 SQL admission rejects incomplete material, role substitution and candidate runtime drift', async () => {
    const bad = [
      { ...registration, policies: registration.policies.map(({ strategyBinding: _binding, ...policy }) => policy) },
      {
        ...registration,
        policies: registration.policies.map((policy) => ({
          ...policy,
          strategyBinding: { ...policy.strategyBinding, engine: 'JEV_V44' },
        })),
      },
      {
        ...registration,
        obligations: {
          ...registration.obligations,
          configuration: {
            ...registration.obligations.configuration,
            strategyBinding: { ...candidate.strategyBinding, protocolHash: sha256('wrong engine protocol') },
          },
        },
      },
    ]
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        for (const invalid of bad) {
          const payload = yield* Effect.fromResult(canonicalJsonV1Result(invalid))
          expect(yield* sql`SELECT system_strategy_bound_registration_valid(${payload}::json) AS valid`).toEqual([
            { valid: false },
          ])
        }
        const canonical = yield* Effect.fromResult(canonicalJsonV1Result(registration))
        expect(yield* sql`SELECT system_strategy_bound_registration_valid(${canonical}::json) AS valid`).toEqual([
          { valid: true },
        ])
      }),
    )
    expect(Result.getOrThrow(canonicalHashV1Result(registration))).toBe(registrationHash)
  })
})
