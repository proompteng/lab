import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'

import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { makeCycleStore } from '../cycle/store/postgres'
import {
  makeNativeAlphaBaselinePreparation,
  recordNativeAlphaBaselinePreparation,
} from '../db/alpha-baseline-preparation-postgres'
import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { canonicalJsonV1Result, sha256 } from '../hash'
import { JevAwaitingEvidence } from '../jev/runtime'
import { exchangeSessions } from '../market-hours'
import { TrailingBaselinePendingCoverage } from '../market-data/intraday/trailing-baseline'
import {
  RecordedAlphaBaselinePreparationSchema,
  reproduceAlphaBaselinePreparation,
} from '../observe-composition/alpha-baseline-preparation'
import {
  partialAlphaBaselineAcquisitionFixture,
  preparedAlphaBaselineFixture,
} from '../observe-composition/alpha-baseline-preparation.test-support'
import { makeIntradayAlphaEntryQuery } from '../strategy/intraday-alpha/runtime'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  prepareClonedPostgres,
  type PostgresTestDatabase,
  type PostgresTestTemplate,
} from '../testing/postgres-template.test-support'
import { derivePreparedAlphaBaselineSources } from './alpha-baseline-witness'
import { readPreparedAlphaSystemDurableObservations, readSystemAlphaBaselinePreparations } from './capture-queries'
import { nativeRegistrationFixture, registrationFixture, testHash } from './fixtures.test-support'
import { initializeQualificationHistory, registerSystemQualification } from './postgres'
import { preparedAlphaRegistrationFixture } from './prepared-alpha-registration.test-support'
import { persistSystemSourceCut, PreparedAlphaSystemSourceCutSchema, readSystemSourceCut } from './source-cut'

const postgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    PostgresClientLive(
      {
        operationTimeoutMs: 10000,
        postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
      },
      { maxConnections: 1, applicationName: 'bayn-baseline-witness-test' },
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  )
const fixture = preparedAlphaBaselineFixture()
const history = {
  schemaVersion: 'bayn.system-qualification-history.v1',
  program: 'BAYN_SYSTEM_QUALIFICATION',
  historySourceHash: sha256('prepared alpha history'),
  auditedAt: '2026-09-01T00:00:00.000Z',
  attempts: [],
}
const registration = preparedAlphaRegistrationFixture(
  nativeRegistrationFixture(
    {
      ...registrationFixture('2026-09-03T11:00:00.000Z', 1),
      priorAttemptHash: testHash(history),
    },
    fixture.payload.calendar,
  ),
)
const candidate = registration.policies.find((policy) => policy.policy === 'JEV')
if (candidate === undefined || candidate.strategyBinding.engine !== 'INTRADAY_ALPHA_V2')
  throw new Error('Missing prepared alpha candidate')
const policy = candidate.strategyBinding.parameters
const accountId = candidate.riskPolicy.accountId
const executionBuild = {
  sourceRevision: candidate.sourceRevision,
  imageRepository: candidate.capitalAuthorization?.buildLineage.activation.imageRepository ?? 'ghcr.io/proompteng/bayn',
  imageDigest: `sha256:${candidate.imageDigest}`,
}
const identity = Result.getOrThrow(
  makeBrokerIdentity({
    schemaVersion: 'bayn.broker-identity.v2',
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    accountId,
  }),
)
const session = exchangeSessions(fixture.payload.calendar)[0]
const executionPolicy = Result.getOrThrow(makeCycleExecutionPolicyFromModel(policy.sharedProtocol.executionModel))
if (session === undefined || executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
  throw new Error('Missing native preparation window')
const draft = Result.getOrThrow(
  makeIntradayCycleDraft(
    {
      cycleBindingId: candidate.authorityGenerationHash,
      strategyName: 'jev',
      strategyProtocolHash: candidate.protocolHash,
      accountId,
      executionPolicy,
    },
    fixture.payload.calendar,
    session,
  ),
)
const request = {
  cycleId: draft.identity.cycleId,
  authorityGenerationHash: candidate.authorityGenerationHash,
  accountId,
  sessionDate: fixture.payload.sessionDate,
  calendar: fixture.payload.calendar,
  policy,
}
const source = Result.getOrThrow(reproduceAlphaBaselinePreparation({ ...fixture.payload, ...request, executionBuild }))
const registrationHash = testHash(registration)
const startedAt = fixture.payload.acquisition.startedAt

// One disposable connection keeps the test clock across autocommit statements. The source transaction is real.
const setClock = (at: string) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    yield* sql`SET search_path=public,pg_catalog`
    yield* sql`SELECT set_config('bayn_test.now',${at},false)`
  })
const register = Effect.gen(function* () {
  yield* setClock('2026-09-03T12:00:00.000Z')
  yield* registerSystemQualification(
    registration,
    new Set([
      registration.calendar.sourceHash,
      ...registration.costAllocationPlans.map((plan) => plan.basisSourceHash),
      ...registration.statisticalPlan.supports.map((support) => support.sourceHash),
    ]),
  )
})
const initializeCycle = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* setClock(startedAt)
  yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,maximum,authority_version,account_id,
    broker_identity_schema_version,broker_identity_hash,broker_provider,broker_environment,activated_at)
    VALUES (${candidate.authorityGenerationHash},'bayn.authority-generation-history.v1','OBSERVE',1,${accountId},
      'bayn.broker-identity.v2',${identity.identityHash},'alpaca','sandbox',${startedAt})`
  yield* (yield* makeCycleStore({ now: sql`${startedAt}::timestamptz` })).acquire(draft, startedAt)
  yield* sql`INSERT INTO execution_controller_status(controller_key,plan_hash,active,epoch,next_sequence)
    VALUES (${identity.identityHash},${registration.obligations.configuration.controllerPlanHash},true,1,0)`
})
const witness = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`UPDATE execution_controller_status SET last_receipt_hash=last_receipt_hash WHERE controller_key=${identity.identityHash}`
})
const readSources = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return yield* Schema.decodeUnknownEffect(Schema.Array(RecordedAlphaBaselinePreparationSchema))(
    yield* sql`
    SELECT content_hash AS "contentHash",payload,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "recordedAt"
    FROM intraday_alpha_baseline_preparations ORDER BY recorded_at,content_hash`,
  )
})
const readWitnesses = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return yield* Schema.decodeUnknownEffect(
    Schema.Array(
      Schema.Struct({
        kind: Schema.Literal('ALPHA_BASELINE'),
        sourceHash: Schema.String,
        sourceAt: Schema.String,
        witnessedAt: Schema.String,
        correct: Schema.Boolean,
      }),
    ),
  )(
    yield* sql`
    SELECT kind,source_hash AS "sourceHash",to_char(source_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceAt",
      to_char((date_trunc('milliseconds',witnessed_at)+CASE WHEN witnessed_at>date_trunc('milliseconds',witnessed_at) THEN interval '1 millisecond' ELSE interval '0' END) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "witnessedAt",correct
    FROM system_durable_observations WHERE registration_hash=${registrationHash} AND kind='ALPHA_BASELINE'`,
  )
})
const readPending = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  return yield* sql`
    SELECT source_hash,to_char(source_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS source_at
    FROM system_pending_evidence WHERE registration_hash=${registrationHash} AND kind='ALPHA_BASELINE'`
})

postgres('committed prospective alpha baseline preparation', () => {
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
        yield* sql`CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz LANGUAGE sql VOLATILE RETURN coalesce(current_setting('bayn_test.now',true)::timestamptz,pg_catalog.clock_timestamp())`
        yield* setClock('2026-09-03T11:00:00.000Z')
        yield* initializeQualificationHistory(history, new Set([history.historySourceHash]))
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

  for (const regularCoverage of ['improved', 'still-partial'] as const) {
    test(`pending preopen coverage leaves no source or witness and a new regular acquisition is ${regularCoverage}`, async () => {
      await runtime.runPromise(register.pipe(Effect.andThen(initializeCycle)))
      let acquisition = partialAlphaBaselineAcquisitionFixture()
      let acquisitions = 0
      const service = await runtime.runPromise(
        Effect.map(PgClient.PgClient, (sql) =>
          makeNativeAlphaBaselinePreparation(
            sql,
            {
              load: () => Effect.die('Preparation must not fall back to the legacy load'),
              acquire: (query, window) =>
                Effect.sync(() => {
                  acquisitions++
                  expect(query).toEqual(source.payload.acquisition.query)
                  expect(window).toEqual({ regularOpenAt: '2026-09-04T13:30:00.000Z' })
                  return acquisition
                }),
            },
            executionBuild,
          ),
        ),
      )
      // Even a stale service returning its earlier partial result after open cannot relabel that acquisition.
      for (const at of ['2026-09-04T12:01:03.000500Z', '2026-09-04T13:31:02.000Z']) {
        await runtime.runPromise(setClock(at))
        const pending = await runtime.runPromise(service.prepare(request).pipe(Effect.result))
        expect(Result.isFailure(pending)).toBe(true)
        if (Result.isFailure(pending)) expect(pending.failure).toBeInstanceOf(TrailingBaselinePendingCoverage)
        expect(await runtime.runPromise(readSources)).toEqual([])
        expect(await runtime.runPromise(readPending)).toEqual([])
        await runtime.runPromise(witness)
        expect(await runtime.runPromise(readWitnesses)).toEqual([])
      }
      acquisition = {
        ...(regularCoverage === 'improved' ? source.payload.acquisition : acquisition),
        startedAt: '2026-09-04T13:31:02.000Z',
        completedAt: '2026-09-04T13:31:03.000Z',
      }
      await runtime.runPromise(setClock('2026-09-04T13:31:03.000500Z'))
      const record = await runtime.runPromise(service.prepare(request))
      expect(record.recordedAt).toBe('2026-09-04T13:31:03.001Z')
      expect(record.payload.acquisition).toEqual(acquisition)
      expect(Object.keys(record.payload.acquisition.trailingBaseline.symbols)).toHaveLength(
        regularCoverage === 'improved' ? 20 : 1,
      )
      expect(await runtime.runPromise(readPending)).toEqual([
        { source_hash: record.contentHash, source_at: record.recordedAt },
      ])
      await runtime.runPromise(setClock('2026-09-04T13:31:03.250500Z').pipe(Effect.andThen(witness)))
      const durableObservations = await runtime.runPromise(readWitnesses)
      expect(durableObservations).toHaveLength(1)
      const asOf = '2026-09-04T13:32:02.000Z'
      const records = await runtime.runPromise(readSystemAlphaBaselinePreparations(registration, asOf))
      expect(records).toEqual([record])
      expect(
        Result.getOrThrow(
          derivePreparedAlphaBaselineSources({
            registrationHash,
            asOf,
            alphaBaselinePreparations: records,
            durableObservations,
          }),
        )[0]?.availableAt,
      ).toBe('2026-09-04T13:31:03.251Z')
      const restarted = await runtime.runPromise(
        Effect.map(PgClient.PgClient, (sql) =>
          makeNativeAlphaBaselinePreparation(
            sql,
            {
              load: () => Effect.die('Restart must not load new inputs'),
              acquire: () => Effect.die('The first regular source stays immutable even if coverage later improves'),
            },
            executionBuild,
          ),
        ),
      )
      await runtime.runPromise(setClock(asOf))
      expect(await runtime.runPromise(restarted.prepare(request))).toEqual(record)
      expect(acquisitions).toBe(3)
    })
  }

  test('direct and raw SQL writers cannot persist partial preopen queries by completing or recording them after open', async () => {
    await runtime.runPromise(
      register.pipe(Effect.andThen(initializeCycle), Effect.andThen(setClock('2026-09-04T13:31:04.000Z'))),
    )
    for (const missing of ['symbols', 'checkpoint'] as const) {
      for (const [startedAt, completedAt] of [
        ['2026-09-04T12:01:02.000Z', '2026-09-04T12:01:03.000Z'],
        ['2026-09-04T13:29:59.999Z', '2026-09-04T13:30:01.000Z'],
      ] as const) {
        const payload = {
          ...source.payload,
          acquisition: partialAlphaBaselineAcquisitionFixture(missing, startedAt, completedAt),
        }
        const direct = await runtime.runPromiseExit(
          Effect.flatMap(PgClient.PgClient, (sql) => recordNativeAlphaBaselinePreparation(sql, payload)),
        )
        expect(Exit.isFailure(direct)).toBe(true)
        if (Exit.isFailure(direct)) expect(Cause.pretty(direct.cause)).toContain('Preopen baseline preparation')
        const bypass = await runtime.runPromiseExit(
          Effect.flatMap(
            PgClient.PgClient,
            (sql) => sql`INSERT INTO intraday_alpha_baseline_preparations
              (content_hash,scope_hash,scope_text,cycle_id,authority_generation_hash,account_id,session_date,payload_text)
              VALUES (${testHash(payload)},${source.scopeHash},${Result.getOrThrow(canonicalJsonV1Result(source.scope))},
                ${payload.cycleId},${payload.authorityGenerationHash},${payload.accountId},${payload.sessionDate},
                ${Result.getOrThrow(canonicalJsonV1Result(payload))})`,
          ),
        )
        expect(Exit.isFailure(bypass)).toBe(true)
        if (Exit.isFailure(bypass))
          expect(Cause.pretty(bypass.cause)).toContain('preopen baseline preparation requires complete')
      }
    }
    await runtime.runPromise(witness)
    expect(await runtime.runPromise(readSources)).toEqual([])
    expect(await runtime.runPromise(readPending)).toEqual([])
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
  })

  test('warmup preserves its committed source, the next controller witnesses it, and restart reuses the first baseline', async () => {
    await runtime.runPromise(register.pipe(Effect.andThen(initializeCycle)))
    let acquisitions = 0
    const service = await runtime.runPromise(
      Effect.map(PgClient.PgClient, (sql) =>
        makeNativeAlphaBaselinePreparation(
          sql,
          {
            load: () => Effect.die('Native preparation must use source-retaining acquire'),
            acquire: () =>
              Effect.sync(() => {
                acquisitions++
                return source.payload.acquisition
              }),
          },
          executionBuild,
        ),
      ),
    )
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        yield* setClock('2026-09-04T12:01:03.000500Z')
        yield* service.prepare(request)
        return yield* Effect.fromResult(
          makeIntradayAlphaEntryQuery({
            policy,
            calendar: request.calendar,
            sessionDate: request.sessionDate,
            observedAtMs: Date.parse(startedAt),
          }),
        )
      }).pipe(Effect.result),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(JevAwaitingEvidence)
      if (result.failure instanceof JevAwaitingEvidence)
        expect(result.failure.readiness).toBe(DecisionReadinessReason.LookbackWarmup)
    }
    expect(acquisitions).toBe(1)
    const [record] = await runtime.runPromise(readSources)
    expect(record?.recordedAt).toBe('2026-09-04T12:01:03.001Z')
    expect(await runtime.runPromise(readPending)).toEqual([
      { source_hash: record?.contentHash, source_at: '2026-09-04T12:01:03.001Z' },
    ])
    expect(
      await runtime.runPromise(readSystemAlphaBaselinePreparations(registration, '2026-09-04T12:01:03.000Z')),
    ).toEqual([])
    expect(
      await runtime.runPromise(readSystemAlphaBaselinePreparations(registration, '2026-09-04T12:01:03.001Z')),
    ).toEqual([record])
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
    await runtime.runPromise(setClock('2026-09-04T12:01:03.000750Z').pipe(Effect.andThen(witness)))
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
    expect(await runtime.runPromise(readPending)).toEqual([
      { source_hash: record?.contentHash, source_at: '2026-09-04T12:01:03.001Z' },
    ])
    await runtime.runPromise(setClock('2026-09-04T12:01:03.250500Z').pipe(Effect.andThen(witness)))
    const durableObservations = await runtime.runPromise(readWitnesses)
    expect(durableObservations).toHaveLength(1)
    expect(await runtime.runPromise(readPending)).toEqual([])
    expect(durableObservations[0]?.witnessedAt).toBe('2026-09-04T12:01:03.251Z')
    expect(
      await runtime.runPromise(
        readPreparedAlphaSystemDurableObservations(registrationHash, '2026-09-04T12:01:03.250Z'),
      ),
    ).toEqual([])
    expect(
      await runtime.runPromise(
        readPreparedAlphaSystemDurableObservations(registrationHash, '2026-09-04T12:01:03.251Z'),
      ),
    ).toEqual(durableObservations)
    const carriers = Result.getOrThrow(
      derivePreparedAlphaBaselineSources({
        registrationHash,
        asOf: '2026-09-04T13:31:02.000Z',
        alphaBaselinePreparations: await runtime.runPromise(readSources),
        durableObservations,
      }),
    )
    expect(carriers[0]?.availableAt < '2026-09-04T13:31:02.000Z').toBe(true)
    const restarted = await runtime.runPromise(
      Effect.map(PgClient.PgClient, (sql) =>
        makeNativeAlphaBaselinePreparation(
          sql,
          { load: () => Effect.die('no load'), acquire: () => Effect.die('restart must use the first durable source') },
          executionBuild,
        ),
      ),
    )
    await runtime.runPromise(setClock('2026-09-04T13:31:02.000Z'))
    expect(await runtime.runPromise(restarted.prepare(request))).toEqual(record)
    const nextBuild = { ...executionBuild, imageDigest: `sha256:${'f'.repeat(64)}` }
    const next = await runtime.runPromise(
      Effect.map(PgClient.PgClient, (sql) =>
        makeNativeAlphaBaselinePreparation(
          sql,
          { load: () => Effect.die('no load'), acquire: () => Effect.succeed(source.payload.acquisition) },
          nextBuild,
        ),
      ),
    )
    const otherBuild = await runtime.runPromise(next.prepare(request))
    expect(otherBuild.contentHash).not.toBe(record?.contentHash)
    expect(otherBuild.payload.executionBuild).toEqual(nextBuild)
    expect(await runtime.runPromise(readSources)).toHaveLength(2)
    expect(
      await runtime.runPromise(readSystemAlphaBaselinePreparations(registration, '2026-09-04T13:31:02.000Z')),
    ).toEqual([record])
    await runtime.runPromise(witness)
    expect(await runtime.runPromise(readWitnesses)).toEqual(durableObservations)
  })

  test('source rollback or released savepoint cannot grant a later identical insertion an earlier witness', async () => {
    await runtime.runPromise(
      register.pipe(Effect.andThen(initializeCycle), Effect.andThen(setClock('2026-09-04T12:01:04.000Z'))),
    )
    const rolledBack = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* recordNativeAlphaBaselinePreparation(sql, source.payload)
            yield* witness
            expect(yield* readWitnesses).toEqual([])
            return yield* Effect.fail('rollback source and its pending record')
          }),
        )
      }),
    )
    expect(Exit.isFailure(rolledBack)).toBe(true)
    expect(await runtime.runPromise(readSources)).toEqual([])
    expect(await runtime.runPromise(readPending)).toEqual([])
    await runtime.runPromise(setClock('2026-09-04T12:01:05.000Z').pipe(Effect.andThen(witness)))
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
    const later = await runtime.runPromise(
      Effect.flatMap(PgClient.PgClient, (sql) => recordNativeAlphaBaselinePreparation(sql, source.payload)),
    )
    expect(later.recordedAt).toBe('2026-09-04T12:01:05.000Z')
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
    for (const table of ['system_pending_evidence', 'system_durable_observations'] as const) {
      const attempted = await runtime.runPromiseExit(
        Effect.flatMap(PgClient.PgClient, (sql) =>
          table === 'system_pending_evidence'
            ? sql`INSERT INTO system_pending_evidence(registration_hash,kind,source_hash,source_at,correct) VALUES (${registrationHash},'ALPHA_BASELINE',${sha256('manual pending identity')},${later.recordedAt},true)`
            : sql`INSERT INTO system_durable_observations(registration_hash,kind,source_hash,source_at,correct) VALUES (${registrationHash},'ALPHA_BASELINE',${later.contentHash},${later.recordedAt},true)`,
        ),
      )
      expect(Exit.isFailure(attempted)).toBe(true)
    }
    await runtime.runPromise(setClock('2026-09-04T12:01:06.000Z').pipe(Effect.andThen(witness)))
    expect((await runtime.runPromise(readWitnesses))[0]?.sourceAt).toBe(later.recordedAt)
  })

  test('a deferred source failure leaves neither source nor witness', async () => {
    await runtime.runPromise(
      register.pipe(Effect.andThen(initializeCycle), Effect.andThen(setClock('2026-09-04T12:01:04.000Z'))),
    )
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE FUNCTION reject_prepared_alpha_test_source() RETURNS trigger LANGUAGE plpgsql AS $function$ BEGIN RAISE EXCEPTION 'deferred preparation rejection' USING ERRCODE='23514'; END $function$`
        yield* sql`CREATE CONSTRAINT TRIGGER reject_prepared_alpha_test_source AFTER INSERT ON intraday_alpha_baseline_preparations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_prepared_alpha_test_source()`
      }),
    )
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          Effect.flatMap(PgClient.PgClient, (sql) => recordNativeAlphaBaselinePreparation(sql, source.payload)),
        ),
      ),
    ).toBe(true)
    await runtime.runPromise(setClock('2026-09-04T12:01:05.000Z').pipe(Effect.andThen(witness)))
    expect(await runtime.runPromise(readSources)).toEqual([])
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
  })

  test('unregistered preparation stays unwitnessed and cannot admit a retroactive registration', async () => {
    await runtime.runPromise(initializeCycle.pipe(Effect.andThen(setClock('2026-09-04T12:01:04.000Z'))))
    await runtime.runPromise(
      Effect.flatMap(PgClient.PgClient, (sql) => recordNativeAlphaBaselinePreparation(sql, source.payload)),
    )
    await runtime.runPromise(witness)
    expect(await runtime.runPromise(readSources)).toHaveLength(1)
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
    const attempted = await runtime.runPromiseExit(
      registerSystemQualification(
        registration,
        new Set([
          registration.calendar.sourceHash,
          ...registration.costAllocationPlans.map((plan) => plan.basisSourceHash),
          ...registration.statisticalPlan.supports.map((support) => support.sourceHash),
        ]),
      ),
    )
    expect(Exit.isFailure(attempted)).toBe(true)
    await runtime.runPromise(
      Effect.flatMap(PgClient.PgClient, (sql) => recordNativeAlphaBaselinePreparation(sql, source.payload)).pipe(
        Effect.andThen(witness),
      ),
    )
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
  })

  test('an uncommitted registration cannot enqueue acquisition and its late outer commit rolls everything back', async () => {
    const rejected = await runtime.runPromiseExit(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            // Admission appears earlier by clock, but remains in the same uncommitted parent transaction.
            yield* sql.withTransaction(register)
            yield* initializeCycle
            yield* setClock('2026-09-04T12:01:04.000Z')
            yield* recordNativeAlphaBaselinePreparation(sql, source.payload)
            expect(yield* readSources).toHaveLength(1)
            expect(yield* readPending).toEqual([])
            expect(yield* readWitnesses).toEqual([])
          }),
        )
      }),
    )
    expect(Exit.isFailure(rejected)).toBe(true)
    if (Exit.isFailure(rejected))
      expect(Cause.pretty(rejected.cause)).toContain('registration committed after the first open')
    await runtime.runPromise(setClock('2026-09-04T12:01:05.000Z').pipe(Effect.andThen(witness)))
    expect(await runtime.runPromise(readWitnesses)).toEqual([])
    expect(await runtime.runPromise(readSources)).toEqual([])
    expect(await runtime.runPromise(readPending)).toEqual([])
    expect(
      await runtime.runPromise(
        Effect.flatMap(
          PgClient.PgClient,
          (sql) =>
            sql`SELECT registration_hash FROM system_qualification_registrations WHERE registration_hash=${registrationHash}`,
        ),
      ),
    ).toEqual([])
  })

  test('another generation cannot claim a native cycle just by sharing its account and policy', async () => {
    await runtime.runPromise(
      register.pipe(Effect.andThen(initializeCycle), Effect.andThen(setClock('2026-09-04T12:01:04.000Z'))),
    )
    const foreignGeneration = sha256('different preparation owner')
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO authority_generations(generation_hash,schema_version,previous_generation_hash,maximum,
          authority_version,account_id,broker_identity_schema_version,broker_identity_hash,broker_provider,broker_environment,activated_at)
          VALUES (${foreignGeneration},'bayn.authority-generation-history.v1',${candidate.authorityGenerationHash},'OBSERVE',2,
            ${accountId},'bayn.broker-identity.v2',${identity.identityHash},'alpaca','sandbox',${startedAt})`
      }),
    )
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          Effect.flatMap(PgClient.PgClient, (sql) =>
            recordNativeAlphaBaselinePreparation(sql, {
              ...source.payload,
              authorityGenerationHash: foreignGeneration,
            }),
          ),
        ),
      ),
    ).toBe(true)
    const foreign = Result.getOrThrow(
      reproduceAlphaBaselinePreparation({ ...source.payload, authorityGenerationHash: foreignGeneration }),
    )
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(
          Effect.flatMap(
            PgClient.PgClient,
            (sql) => sql`INSERT INTO intraday_alpha_baseline_preparations
              (content_hash,scope_hash,scope_text,cycle_id,authority_generation_hash,account_id,session_date,payload_text)
              VALUES (${foreign.contentHash},${foreign.scopeHash},${Result.getOrThrow(canonicalJsonV1Result(foreign.scope))},
                ${foreign.payload.cycleId},${foreignGeneration},${accountId},${request.sessionDate},
                ${Result.getOrThrow(canonicalJsonV1Result(foreign.payload))})`,
          ),
        ),
      ),
    ).toBe(true)
    expect(await runtime.runPromise(readSources)).toEqual([])
    expect(await runtime.runPromise(readPending)).toEqual([])
  })

  test('v6 source cuts retain unwitnessed preparation and bind the exact later committed witness', async () => {
    await runtime.runPromise(
      register.pipe(Effect.andThen(initializeCycle), Effect.andThen(setClock('2026-09-04T12:01:04.000Z'))),
    )
    const record = await runtime.runPromise(
      Effect.flatMap(PgClient.PgClient, (sql) => recordNativeAlphaBaselinePreparation(sql, source.payload)),
    )
    await runtime.runPromise(setClock('2026-09-04T12:01:05.000Z'))
    const alphaBaselinePreparations = await runtime.runPromise(
      readSystemAlphaBaselinePreparations(registration, '2026-09-04T12:01:05.000Z'),
    )
    expect(alphaBaselinePreparations).toEqual([record])
    const sourceMaterial = { alphaBaselinePreparations }
    const cut = Schema.decodeUnknownSync(PreparedAlphaSystemSourceCutSchema)({
      schemaVersion: 'bayn.system-source-cut.v6',
      registrationHash,
      asOf: '2026-09-04T12:01:05.000Z',
      runtimeConfigurationHash: registration.obligations.runtimeConfigurationHash,
      alphaBaselinePreparations,
      alphaObservations: [],
      financial: [],
      inference: [],
      inferenceLedgerEvidenceHash: sha256('prepared baseline inference'),
      protectionIntents: [],
      decisions: [],
      batches: [],
      decisionAdmissions: [],
      mutations: [],
      fills: [],
      orders: [],
      accountMarks: [],
      controllerPasses: [],
      durableObservations: [],
      sourceMaterial,
      sourceMaterialHash: testHash(sourceMaterial),
    })
    const saved = await runtime.runPromise(persistSystemSourceCut(cut))
    expect(await runtime.runPromise(readSystemSourceCut(saved.sourceCutHash))).toEqual(cut)
    expect(Result.getOrThrow(derivePreparedAlphaBaselineSources(cut))).toEqual([])
    await runtime.runPromise(setClock('2026-09-04T12:01:06.000Z').pipe(Effect.andThen(witness)))
    await runtime.runPromise(setClock('2026-09-04T12:01:07.000Z'))
    const durableObservations = await runtime.runPromise(
      readPreparedAlphaSystemDurableObservations(registrationHash, '2026-09-04T12:01:07.000Z'),
    )
    const witnessed = { ...cut, asOf: '2026-09-04T12:01:07.000Z', durableObservations }
    await runtime.runPromise(persistSystemSourceCut(witnessed))
    expect(Result.getOrThrow(derivePreparedAlphaBaselineSources(witnessed))[0]?.availableAt).toBe(
      '2026-09-04T12:01:06.000Z',
    )
    for (const forged of [
      {
        ...witnessed,
        alphaBaselinePreparations: [{ ...record, recordedAt: '2026-09-04T12:01:03.999Z' }],
      },
      {
        ...witnessed,
        durableObservations: durableObservations.map((row) => ({ ...row, witnessedAt: cut.asOf })),
      },
    ])
      expect(Exit.isFailure(await runtime.runPromiseExit(persistSystemSourceCut(forged)))).toBe(true)
    const { alphaBaselinePreparations: _preparations, ...oldCut } = witnessed
    expect(
      Exit.isFailure(
        await runtime.runPromiseExit(persistSystemSourceCut({ ...oldCut, schemaVersion: 'bayn.system-source-cut.v5' })),
      ),
    ).toBe(true)
  })
})
