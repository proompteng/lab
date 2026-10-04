import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result } from 'effect'
import { Reactivity } from 'effect/reactivity'
import { SqlClient } from 'effect/sql'
import type { Statement } from 'effect/sql/Statement'
import { TestClock } from 'effect/testing'

import { JevBatchPlanVersion, JevCandidatePlanStatus } from '../jev/batch'
import { JevEvaluationStore } from '../jev/evaluation'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevBatchStore } from './jev-batch-postgres'

test('batch finalization binds its observation lookup to the indexed cycle and millisecond timestamp', async () => {
  const fixture = candidateObservationFixture()
  const observed = Date.parse(fixture.input.observedAt)
  const plan = Result.getOrThrow(
    makeJevTradingSignalBatch({
      observation: fixture.observation.payload,
      expiresAt: utcInstantFromEpochMillis(observed + 5000),
      planVersion: JevBatchPlanVersion.V1,
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
            begin: () => Effect.die('Finalization must not acquire inference'),
            record: () => Effect.die('Finalization must not record inference'),
            abandon: () => Effect.die('Finalization must not call the independent abandonment writer'),
          }),
        )
        expect((yield* store.finish(plan.batchId)).result).toBeNull()
      }),
    ).pipe(Effect.provide(TestClock.layer()), Effect.provide(Reactivity.layer)),
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
