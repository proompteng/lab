import { entryInferenceFixtureLayer } from '../jev/entry-inference.test-support'
import { expect, spyOn, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Exit, Logger, References, Result } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'
import type { Statement } from 'effect/sql/Statement'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../hash'
import { JevBatchPlanVersion, JevCandidatePlanStatus, usableEntryBatchInferences } from '../jev/batch'
import { evaluateJevBatch, JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevBatchStore } from './jev-batch-postgres'
import * as observations from '../jev/observation'
import * as evaluationPersistence from './jev-evaluation-postgres'
import { ExecutionStageTimings, type ExecutionStageTiming } from '../telemetry'

test.each(['success', 'validation', 'lock', 'receipts', 'evidence', 'result'])(
  'completion phases retain transaction outcome and attribute interruption at %s',
  async (interrupted) => {
    const fixture = nativeJevFixture()
    const { batchPlan: plan, batchResult: result } = nativeJevDecisionEvidence(fixture)
    const timings = new Map<string, ExecutionStageTiming>()
    const order: string[] = []
    const phase = (name: string) =>
      Effect.sync(() => order.push(name)).pipe(
        Effect.andThen(TestClock.adjust(1100)),
        Effect.andThen(name === interrupted ? Effect.interrupt : Effect.void),
      )
    const receipts = spyOn(evaluationPersistence, 'recordJevEvaluationReceipts').mockImplementation(() =>
      phase('receipts').pipe(
        Effect.as(
          new Map(
            result.candidates.flatMap((candidate) =>
              candidate.status === 'RESOLVED' ? [[candidate.requestId, candidate.resolution] as const] : [],
            ),
          ),
        ),
      ),
    )
    const logger = Logger.make(({ fiber }) => {
      if (fiber.getRef(References.CurrentLogAnnotations)['stage'] === 'bayn.jev.batch-completion.phase')
        throw new Error('phase logger failed')
    })
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* SqlClient.make({
              acquirer: Effect.die('Completion phase test must not connect to PostgreSQL'),
              compiler: PgClient.makeCompiler(undefined, false),
              spanAttributes: [],
            })
            const sql = new Proxy(client, {
              apply(target, receiver, args) {
                const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, args)
                const [query] = statement.compile()
                if (query.includes('SELECT batch_id FROM jev_batch_plans'))
                  return phase('lock').pipe(Effect.as([{ batch_id: plan.batchId }]))
                if (query.includes('SELECT EXISTS')) return phase('evidence').pipe(Effect.as([{ matches: true }]))
                if (query.includes('INSERT INTO jev_batch_results'))
                  return phase('result').pipe(Effect.as([{ payload: result }]))
                throw new Error('Unexpected completion query')
              },
              get(target, property, receiver) {
                if (property === 'withTransaction')
                  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                    Effect.sync(() => order.push('begin')).pipe(
                      Effect.andThen(effect),
                      Effect.onExit((exit) =>
                        Effect.sync(() => order.push(Exit.isSuccess(exit) ? 'commit' : 'rollback')),
                      ),
                    )
                if (property === 'json') return (value: unknown) => client`${JSON.stringify(value)}::jsonb`
                return Reflect.get(target, property, receiver)
              },
            }) as PgClient.PgClient
            const store = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, sql))
            return yield* store.complete(
              plan,
              interrupted === 'validation'
                ? {
                    ...fixture.observation.payload,
                    observedAt: utcInstantFromEpochMillis(Date.parse(plan.observedAt) + 1),
                  }
                : fixture.observation.payload,
              result,
            )
          }),
        ).pipe(
          Effect.provide(TestClock.layer()),
          Effect.provide(Reactivity.layer),
          Effect.provide(Logger.layer([logger])),
          Effect.provideService(ExecutionStageTimings, timings),
        ),
      )
      expect(Exit.isSuccess(exit)).toBe(interrupted === 'success')
      if (interrupted === 'validation') {
        expect(order).toEqual([])
        expect(timings.get('bayn.jev.batch-completion.phase:validation')?.failures).toBe(1)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons).toHaveLength(1)
          expect(exit.cause.reasons[0]?._tag).toBe('Fail')
        }
        return
      }
      expect(order.at(-1)).toBe(interrupted === 'success' ? 'commit' : 'rollback')
      const phases = ['lock', 'receipts', 'evidence', 'result']
      const visited = interrupted === 'success' ? phases : phases.slice(0, phases.indexOf(interrupted) + 1)
      expect(order).toEqual(['begin', ...visited, interrupted === 'success' ? 'commit' : 'rollback'])
      expect(timings.get('bayn.jev.batch-completion.phase:validation')?.count).toBe(1)
      for (const name of visited) {
        const timing = timings.get('bayn.jev.batch-completion.phase:' + name)
        expect(timing?.count).toBe(1)
        expect(timing?.interruptions).toBe(name === interrupted ? 1 : 0)
      }
      if (Exit.isFailure(exit)) expect(exit.cause.reasons.every((reason) => reason._tag === 'Interrupt')).toBe(true)
    } finally {
      receipts.mockRestore()
    }
  },
)

test.each([
  { commitDelayMs: 0, sourceMatches: true, usable: true },
  { commitDelayMs: 2000, sourceMatches: true, usable: false },
  { commitDelayMs: 0, sourceMatches: false, usable: false },
])(
  'recorded batch finalization preserves freshness with $commitDelayMs ms commit and source=$sourceMatches',
  async (scenario) => {
    const fixture = nativeJevFixture()
    const { batchPlan: plan, batchResult } = nativeJevDecisionEvidence(fixture)
    const observed = Date.parse(plan.observedAt)
    const requests = plan.candidates.flatMap((candidate) =>
      candidate.status === JevCandidatePlanStatus.Requested ? [candidate.request] : [],
    )
    const rows = requests.map((request) => {
      const candidate = batchResult.candidates.find(
        (candidate) => 'requestId' in candidate && candidate.requestId === request.requestId,
      )
      if (candidate === undefined || !('receipt' in candidate)) throw new Error('Missing committed fixture evidence')
      return {
        request_id: request.requestId,
        request,
        receipt: candidate.receipt,
        resolution: candidate.resolution,
        handoff:
          candidate.receipt?.outcome.status === 'COMPLETED' ? candidate.receipt.outcome.completion.handoff : null,
      }
    })
    let persisted: unknown = null
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* SqlClient.make({
            acquirer: Effect.die('The finalization contract must not connect to PostgreSQL'),
            compiler: PgClient.makeCompiler(undefined, false),
            spanAttributes: [],
          })
          const sql = new Proxy(client, {
            apply(target, receiver, argumentsList) {
              const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
              const [query, parameters] = statement.compile()
              if (query.startsWith('observation.cycle_id =')) return statement
              if (query.includes('SELECT plan.payload AS plan')) return Effect.succeed([{ plan, result: persisted }])
              if (query.includes('SELECT batch_id FROM jev_batch_plans'))
                return Effect.succeed([{ batch_id: plan.batchId }])
              if (query.includes('SELECT payload FROM intraday_candidate_observations'))
                return Effect.succeed([{ payload: fixture.observation.payload }])
              if (query.includes('AS matching_request_ids') || query.includes('AS matching_symbols'))
                return Effect.succeed([
                  {
                    content_hash: scenario.sourceMatches ? plan.observationHash : 'f'.repeat(64),
                    payload: fixture.observation.payload,
                    ...(query.includes('AS matching_request_ids')
                      ? { matching_request_ids: requests.map((request) => request.requestId) }
                      : { matching_symbols: requests.map((request) => request.symbol) }),
                  },
                ])
              if (query.includes('FROM jev_evaluation_requests')) return Effect.succeed(rows)
              if (query.includes('INSERT INTO jev_batch_results')) {
                const encoded = parameters.at(-1)
                if (typeof encoded !== 'string') throw new Error('Expected the parameterized result JSON')
                return TestClock.adjust(scenario.commitDelayMs).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      persisted = JSON.parse(encoded)
                      return [{ payload: persisted }]
                    }),
                  ),
                )
              }
              throw new Error(`Unexpected finalization query: ${query}`)
            },
            get(target, property, receiver) {
              if (property === 'withTransaction')
                return <A, E, R>(effect: Effect.Effect<A, E, R>) => TestClock.adjust(2000).pipe(Effect.andThen(effect))
              if (property === 'json') return (value: unknown) => client`${JSON.stringify(value)}::jsonb`
              return Reflect.get(target, property, receiver)
            },
          }) as PgClient.PgClient
          yield* TestClock.setTime(observed + 9000)
          const store = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, sql))
          const finalized = yield* store.finish(plan.batchId).pipe(Effect.result)
          expect(Result.isSuccess(finalized)).toBe(scenario.sourceMatches)
          if (Result.isSuccess(finalized)) {
            expect(finalized.success.result).not.toBeNull()
            if (finalized.success.result === null) throw new Error('Committed receipts must produce a complete result')
            expect(
              Result.isSuccess(
                usableEntryBatchInferences(
                  plan,
                  finalized.success.result,
                  yield* Clock.currentTimeMillis,
                  JevBatchPlanVersion.V8,
                ),
              ),
            ).toBe(scenario.usable)
          } else expect(persisted).toBeNull()
        }),
      ).pipe(
        Effect.provide(entryInferenceFixtureLayer),
        Effect.provide(TestClock.layer()),
        Effect.provide(Reactivity.layer),
      ),
    )
  },
)

test.each([
  {
    cycleMatches: true,
    portfolioMatches: true,
    admitted: true,
    checks: 2,
    source: 'stored',
    mutate: false,
    readDelayMs: 250,
  },
  { cycleMatches: false, portfolioMatches: true, admitted: false, checks: 1, source: 'stored', mutate: false },
  { cycleMatches: true, portfolioMatches: false, admitted: false, checks: 2, source: 'stored', mutate: false },
  { cycleMatches: true, portfolioMatches: true, admitted: true, checks: 2, source: 'supplied', mutate: true },
  { cycleMatches: true, portfolioMatches: true, admitted: true, checks: 2, source: 'stored', mutate: true },
])('admission $source mutate=$mutate cycle=$cycleMatches portfolio=$portfolioMatches', async (scenario) => {
  const fixture = nativeJevFixture()
  const suppliedObservation = structuredClone(fixture.observation.payload)
  const storedObservation = structuredClone(fixture.observation.payload)
  const observed = Date.parse(fixture.observation.payload.observedAt)
  const plan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: fixture.observation.payload,
      expiresAt: utcInstantFromEpochMillis(observed + fixture.protocol.inferenceValidityMs),
      planVersion: JevBatchPlanVersion.V8,
    }),
  )
  const reproduce = spyOn(observations, 'reproduceJevCandidateObservation')
  const statements: string[] = []
  let admitted = false
  let sourceChecks = 0
  let recordedObservation: unknown
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* SqlClient.make({
            acquirer: Effect.die('Admission contract must not connect to PostgreSQL'),
            compiler: PgClient.makeCompiler(undefined, false),
            spanAttributes: [],
          })
          const sql = new Proxy(client, {
            apply(target, receiver, argumentsList) {
              const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
              const [query, parameters] = statement.compile()
              statements.push(query)
              if (query.includes('SELECT payload FROM intraday_candidate_observations'))
                return Effect.succeed(scenario.source === 'stored' ? [{ payload: storedObservation }] : [])
              if (query.includes('SELECT plan.payload AS plan')) {
                if (!admitted && scenario.mutate) {
                  // The source owner can change its graph while admission awaits this read.
                  const selected = scenario.source === 'stored' ? storedObservation : suppliedObservation
                  const quote = selected.rows.quotes[0]
                  if (typeof quote !== 'object' || quote === null) throw new Error('Expected a fixture quote to mutate')
                  Object.assign(quote, { ask_price: 999999 })
                }
                return Effect.succeed(admitted ? [{ plan, result: null }] : [])
              }
              if (query.includes('AS matches')) {
                const matches = sourceChecks === 0 ? scenario.cycleMatches : scenario.portfolioMatches
                sourceChecks += 1
                return Effect.succeed([{ matches }])
              }
              if (query.includes('INSERT INTO intraday_candidate_observations')) {
                const encoded = parameters.at(-1)
                if (typeof encoded !== 'string') throw new Error('Expected the parameterized observation JSON')
                recordedObservation = JSON.parse(encoded)
                return Effect.succeed([{ content_hash: plan.observationHash }])
              }
              if (query.includes('INSERT INTO jev_batch_plans')) {
                admitted = true
                return Effect.succeed([{ batch_id: plan.batchId }])
              }
              if (query.includes('INSERT INTO jev_evaluation_requests')) return Effect.succeed([])
              if (query.includes('SELECT payload FROM jev_evaluation_requests')) {
                const candidate = plan.candidates.find(
                  (candidate) =>
                    candidate.status === JevCandidatePlanStatus.Requested &&
                    candidate.request.requestId === parameters[0],
                )
                if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Unknown admission request')
                return TestClock.adjust('readDelayMs' in scenario ? scenario.readDelayMs : 0).pipe(
                  Effect.as([{ payload: candidate.request }]),
                )
              }
              if (query.includes('SELECT payload FROM jev_staged_'))
                return TestClock.adjust('readDelayMs' in scenario ? scenario.readDelayMs : 0).pipe(Effect.as([]))
              if (query.includes('INSERT INTO jev_staged_dispatch_claims'))
                return Effect.succeed([{ claim_hash: parameters[2] }])
              throw new Error(`Unexpected admission query: ${query}`)
            },
            get(target, property, receiver) {
              if (property === 'withTransaction') return <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
              if (property === 'json') return (value: unknown) => client`${JSON.stringify(value)}::jsonb`
              return Reflect.get(target, property, receiver)
            },
          }) as PgClient.PgClient
          yield* TestClock.setTime(observed)
          const store = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, sql))
          const saved = yield* store.begin(plan, suppliedObservation).pipe(Effect.result)
          expect(Result.isSuccess(saved)).toBe(scenario.admitted)
          if (Result.isSuccess(saved)) {
            expect(saved.success.dispatches).toHaveLength(
              plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested).length,
            )
            // Newly inserted request/checkpoint rows must not consume the inference window in reloads.
            expect(yield* Clock.currentTimeMillis).toBeLessThan(Date.parse(plan.expiresAt))
          }
        }),
      ).pipe(
        Effect.provide(entryInferenceFixtureLayer),
        Effect.provide(TestClock.layer()),
        Effect.provide(Reactivity.layer),
      ),
    )
    expect(reproduce).toHaveBeenCalledTimes(1)
    expect(admitted).toBe(scenario.admitted)
    expect(recordedObservation).toEqual(scenario.admitted ? fixture.observation.payload : undefined)
    if (scenario.admitted) {
      expect(Result.getOrThrow(canonicalHashV1Result(recordedObservation))).toBe(plan.observationHash)
      if (scenario.mutate) {
        const selected = scenario.source === 'stored' ? storedObservation : suppliedObservation
        expect(Result.getOrThrow(canonicalHashV1Result(selected))).not.toBe(plan.observationHash)
      }
    }
    expect(statements.filter((query) => query.includes('AS matches'))).toHaveLength(scenario.checks)
  } finally {
    reproduce.mockRestore()
  }
})

test.each([
  { elapsedMs: 10000, corrupt: false, expectedTag: 'JevBatchExpired', queries: 2 },
  { elapsedMs: 10001, corrupt: false, expectedTag: 'JevBatchExpired', queries: 2 },
  { elapsedMs: 16000, corrupt: false, expectedTag: 'JevBatchExpired', queries: 2 },
  { elapsedMs: -1, corrupt: false, expectedTag: 'OperationalError', queries: 2 },
  { elapsedMs: 16000, corrupt: true, expectedTag: 'OperationalError', queries: 1 },
])('unrecorded batch admission at $elapsedMs ms preserves $expectedTag (corrupt=$corrupt)', async (scenario) => {
  const fixture = nativeJevFixture()
  const observed = Date.parse(fixture.observation.payload.observedAt)
  const plan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: fixture.observation.payload,
      expiresAt: utcInstantFromEpochMillis(observed + fixture.protocol.inferenceValidityMs),
      planVersion: JevBatchPlanVersion.V8,
    }),
  )
  const statements: string[] = []
  let providerCalls = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* SqlClient.make({
          acquirer: Effect.die('Admission must not connect to PostgreSQL'),
          compiler: PgClient.makeCompiler(undefined, false),
          spanAttributes: [],
        })
        const sql = new Proxy(client, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            const [query] = statement.compile()
            statements.push(query)
            if (query.includes('SELECT payload FROM intraday_candidate_observations'))
              return Effect.succeed([
                {
                  payload: scenario.corrupt
                    ? { ...fixture.observation.payload, observedAt: plan.expiresAt }
                    : fixture.observation.payload,
                },
              ])
            if (query.includes('SELECT plan.payload AS plan')) return Effect.succeed([])
            throw new Error(`Unexpected admission query: ${query}`)
          },
        }) as PgClient.PgClient
        yield* TestClock.setTime(observed + scenario.elapsedMs)
        const store = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, sql))
        const result = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, store),
          Effect.result,
        )
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({ _tag: scenario.expectedTag })
          if (scenario.expectedTag === 'JevBatchExpired')
            expect(result.failure).toMatchObject({
              batchId: plan.batchId,
              cycleId: plan.cycleId,
              observedAt: plan.observedAt,
              expiresAt: plan.expiresAt,
              checkedAt: utcInstantFromEpochMillis(observed + scenario.elapsedMs),
            })
        }
      }),
    ).pipe(
      Effect.provideService(JevEvaluationStore, {
        read: () => Effect.die('Admission must not read a candidate request'),
        recordAll: () => Effect.die('Admission must not record inference'),
        abandon: () => Effect.die('Admission must not abandon inference'),
      }),
      Effect.provideService(JevClient, {
        evaluate: () =>
          Effect.sync(() => {
            providerCalls += 1
          }).pipe(Effect.andThen(Effect.die('Admission must not call the provider'))),
      }),
      Effect.provide(entryInferenceFixtureLayer),
      Effect.provide(TestClock.layer()),
      Effect.provide(Reactivity.layer),
    ),
  )
  expect(statements).toHaveLength(scenario.queries)
  expect(statements.every((query) => query.trimStart().startsWith('SELECT'))).toBe(true)
  expect(providerCalls).toBe(0)
})

test('batch finalization binds its observation lookup to the indexed cycle and millisecond timestamp', async () => {
  const fixture = nativeJevFixture()
  const observed = Date.parse(fixture.observation.payload.observedAt)
  const plan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: fixture.observation.payload,
      expiresAt: utcInstantFromEpochMillis(observed + fixture.protocol.inferenceValidityMs),
      planVersion: JevBatchPlanVersion.V8,
    }),
  )
  const symbols = plan.candidates.flatMap((candidate) =>
    candidate.status === JevCandidatePlanStatus.Requested ? [candidate.symbol] : [],
  )
  const statements: { query: string; parameters: readonly unknown[] }[] = []
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* SqlClient.make({
          acquirer: Effect.die('The query contract test must never connect to PostgreSQL'),
          compiler: PgClient.makeCompiler(undefined, false),
          spanAttributes: [],
        })
        const sql = new Proxy(client, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            const [query, parameters] = statement.compile()
            statements.push({ query, parameters })
            if (query.includes('SELECT batch_id FROM jev_batch_plans'))
              return Effect.succeed([{ batch_id: plan.batchId }])
            if (query.includes('SELECT plan.payload AS plan')) return Effect.succeed([{ plan, result: null }])
            if (query.includes('SELECT payload FROM intraday_candidate_observations'))
              return Effect.succeed([{ payload: fixture.observation.payload }])
            if (query.includes('AS matching_symbols'))
              return Effect.succeed([
                {
                  content_hash: fixture.observation.contentHash,
                  payload: fixture.observation.payload,
                  matching_symbols: symbols,
                },
              ])
            if (query.includes('FROM jev_evaluation_requests')) return Effect.succeed([])
            throw new Error(`Unexpected finalization query: ${query}`)
          },
          get(target, property, receiver) {
            if (property === 'withTransaction') return <A, E, R>(effect: Effect.Effect<A, E, R>) => effect
            return Reflect.get(target, property, receiver)
          },
        }) as PgClient.PgClient
        yield* TestClock.setTime(observed)
        const store = yield* makeJevBatchStore.pipe(
          Effect.provideService(PgClient.PgClient, sql),
          Effect.provideService(JevEvaluationStore, {
            read: () => Effect.die('Finalization must use its bulk evidence read'),

            recordAll: () => Effect.die('Finalization must not record inference'),
            abandon: () => Effect.die('Finalization must not call the independent abandonment writer'),
          }),
        )
        expect((yield* store.finish(plan.batchId)).result).toBeNull()
      }),
    ).pipe(
      Effect.provide(entryInferenceFixtureLayer),
      Effect.provide(TestClock.layer()),
      Effect.provide(Reactivity.layer),
    ),
  )
  const lookup = statements.find((statement) => statement.query.includes('AS matching_symbols'))
  if (lookup === undefined) throw new Error('Batch finalization did not query matching observations')
  const cycle = /observation\.cycle_id\s*=\s*\$(\d+)/.exec(lookup.query)
  const time = /observation\.observed_at\s*=\s*\$(\d+)::timestamptz/.exec(lookup.query)
  expect(cycle).not.toBeNull()
  expect(time).not.toBeNull()
  expect(lookup.parameters[Number(cycle?.[1]) - 1]).toBe(plan.cycleId)
  expect(lookup.parameters[Number(time?.[1]) - 1]).toBe(plan.observedAt)
})
