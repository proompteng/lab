import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { makeJevMarketTestSnapshot } from '../testing/jev-market-fixture'
import { currentEquityMarketProfile as equityMarketProfile } from '../jev/markets'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevPurpose } from '../jev/portfolio'
import { afterAll, afterEach, beforeAll, beforeEach, describe } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Effectable, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'
import type { Statement } from 'effect/sql/Statement'
import type { SqlError } from 'effect/sql/SqlError'
import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { Authority } from '../execution/contracts'
import { JevCandidatePlanStatus, JevBatchPlanVersion } from '../jev/batch'
import { type JevBatchAdmission } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { tradingSignalInferenceFixture } from '../jev/trading-signal.test-support'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeJevObservation } from '../jev/observation'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import {
  prepareClonedPostgres,
  type PostgresTestDatabase,
  type PostgresTestTemplate,
} from '../testing/postgres-template.test-support'
import { nativeJevFixture } from '../jev/native.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { JevInferenceWorkStoreLive } from './jev-inference-work-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_jev_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
export const immediateDispatches = (admission: JevBatchAdmission) => {
  if (admission.dispatches === null) throw new Error('Expected in-process dispatch rights for this fixture')
  return admission.dispatches
}
export const withTestEvaluation = <A extends object>(
  statement: Statement<A>,
  evaluate: () => Effect.Effect<ReadonlyArray<A>, SqlError>,
): Statement<A> => {
  const observed = Effectable.Prototype({ label: 'Observed test statement', evaluate })
  return new Proxy(statement, {
    get(target, property, receiver) {
      return Object.hasOwn(observed, property)
        ? Reflect.get(observed, property, receiver)
        : Reflect.get(target, property, receiver)
    },
  })
}
export const premiums = Object.fromEntries(equityMarketProfile.candidateSymbols.map((symbol) => [symbol, 0.02]))
const replaySourceHash = 'd'.repeat(64)
export const replayAccountId = `replay-${replaySourceHash}`
export const fixture = nativeJevFixture(
  JevPurpose.Entry,
  undefined,
  replayAccountId,
  defaultJevProtocolDocument,
  'a'.repeat(64),
  premiums,
)
export const foreignFixture = nativeJevFixture(
  JevPurpose.Entry,
  undefined,
  `replay-${'f'.repeat(64)}`,
  defaultJevProtocolDocument,
  'a'.repeat(64),
  premiums,
)
export const observed = Date.parse(fixture.observation.payload.observedAt)
export const plan = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: utcInstantFromEpochMillis(observed + fixture.protocol.inferenceValidityMs),
    planVersion: JevBatchPlanVersion.V8,
  }),
)
export const requested = plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
const excludedBase = nativeJevFixture(
  JevPurpose.Entry,
  undefined,
  replayAccountId,
  defaultJevProtocolDocument,
  'a'.repeat(64),
  Object.fromEntries(equityMarketProfile.candidateSymbols.map((symbol) => [symbol, -0.02])),
)
export const excludedFixture = (() => {
  const raw = makeJevMarketTestSnapshot(excludedBase.protocol, { ...excludedBase.query, archiveWatermarks: [] })
  const { snapshot } = streamingFixtureFromRaw(
    { ...raw, quotes: raw.quotes.map((quote) => ({ ...quote, askPrice: quote.bidPrice * 1.01 })) },
    excludedBase.query,
  )
  return {
    ...excludedBase,
    snapshot,
    observation: Result.getOrThrow(makeJevObservation({ ...excludedBase.input, snapshot })),
  }
})()
export const excludedPlan = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: excludedFixture.observation.payload,
    expiresAt: plan.expiresAt,
    planVersion: JevBatchPlanVersion.V8,
  }),
)
const firstCandidate = requested[0]
if (firstCandidate === undefined) throw new Error('Jev batch fixture requires a candidate')
export const first = firstCandidate
export const successful: typeof JevClient.Service = {
  evaluate: (request) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => tradingSignalInferenceFixture(request, utcInstantFromEpochMillis(now))),
    ),
}
export const atObservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(observed).pipe(Effect.andThen(effect), Effect.provide(TestClock.layer()))
const makeRuntime = (url: string) =>
  ManagedRuntime.make(
    Layer.mergeAll(
      CycleStoreLive,
      CandidateObservationStoreLive,
      JevBatchStoreLive,
      EntryInferenceJournalLive,
      JevInferenceWorkStoreLive,
    ).pipe(
      Layer.provideMerge(JevEvaluationStoreLive),
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 5000,
          postgres: { url: Redacted.make(url), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

export const describeJevBatchPostgres = (
  defineTests: (postgres: {
    readonly runtime: ReturnType<typeof makeRuntime>
    readonly database: PostgresTestDatabase
  }) => void,
  seed = fixture,
) => {
  describePostgres('PostgreSQL complete Jev batches', () => {
    let template: PostgresTestTemplate
    let database: PostgresTestDatabase
    let runtime: ReturnType<typeof makeRuntime>
    beforeAll(async () => {
      template = await prepareClonedPostgres(testUrl, async (url) => {
        const priorSchema = makeRuntime(url)
        try {
          await priorSchema.runPromise(
            Effect.gen(function* () {
              const sql = yield* PgClient.PgClient
              yield* postgresMigrations
              yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
              VALUES (${replayAccountId},${replaySourceHash},${seed.snapshot.manifest.observedAt})`
              yield* (yield* CycleStore).acquire(seed.draft, seed.snapshot.manifest.observedAt)
              yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
            VALUES (${seed.observation.payload.authorityGenerationHash}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 1, ${seed.snapshot.manifest.observedAt})`
              const r = seed.portfolio.brokerState.reconciliation
              yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
              VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId}, ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
              yield* (yield* CandidateObservationStore).record(seed.observation)
            }),
          )
        } finally {
          await priorSchema.dispose()
        }
      })
    })
    beforeEach(async () => {
      database = await template.clone()
      runtime = makeRuntime(database.url)
    })
    afterEach(async () => {
      try {
        await runtime?.dispose()
      } finally {
        await database?.dispose()
      }
    })
    afterAll(async () => template?.dispose())
    defineTests({
      get runtime() {
        return runtime
      },
      get database() {
        return database
      },
    })
  })
}
