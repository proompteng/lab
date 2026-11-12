import { makePostgresFixture } from '../testing/postgres-fixture.test-support'
import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Effectable, Exit, Result } from 'effect'
import { Reactivity } from 'effect/reactivity'
import type { Statement } from 'effect/sql/Statement'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../hash'
import { JevBatchPlanVersion, usableEntryBatchInferences } from '../jev/batch'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { makeJevEvaluationStore } from './jev-evaluation-postgres'

const fixture = nativeJevFixture(undefined, undefined, 'receipt-cohort-test', {
  ...defaultJevProtocolDocument,
  candidateSymbols: ['AAPL', 'AMZN', 'IWM', 'NVDA'],
})
const { batchPlan: plan, batchResult: batch } = nativeJevDecisionEvidence(fixture)
const entries = plan.candidates.map((candidate, index) => {
  const result = batch.candidates[index]
  if (candidate.status !== 'REQUESTED' || result?.status !== 'RESOLVED' || result.receipt === null)
    throw new Error('Receipt timing fixture requires four completed candidates')
  return { request: candidate.request, receipt: result.receipt }
})

const recordWithStatementLatency = (remainingMs: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const queries: string[] = []
      let commits = 0
      const client = yield* makePostgresFixture({
        acquirer: Effect.die('Receipt timing test must not connect to PostgreSQL'),
        compiler: PgClient.makeCompiler(undefined, false),
        spanAttributes: [],
      })
      const sql = new Proxy(client, {
        apply(target, receiver, args) {
          const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, args)
          const [query] = statement.compile()
          const observed = Effectable.Prototype({
            label: 'Receipt timing statement',
            evaluate: () =>
              Effect.sync(() => queries.push(query)).pipe(
                Effect.andThen(TestClock.adjust(40)),
                Effect.andThen(
                  Effect.sync(() => {
                    if (query.includes('SELECT plan.batch_id')) return [{ batch_id: plan.batchId }]
                    if (query.includes('SELECT request_id,payload'))
                      return entries.map(({ request }) => ({ request_id: request.requestId, payload: request }))
                    if (query.includes('SELECT request.request_id'))
                      return entries.map(({ request, receipt }) => ({
                        request_id: request.requestId,
                        request,
                        receipt: null,
                        resolution: null,
                        handoff: receipt.outcome.status === 'COMPLETED' ? receipt.outcome.completion.handoff : null,
                      }))
                    if (query.includes('JOIN intraday_candidate_observations'))
                      return [
                        {
                          content_hash: Result.getOrThrow(canonicalHashV1Result(fixture.observation.payload)),
                          payload: fixture.observation.payload,
                          matching_request_ids: entries.map(({ request }) => request.requestId),
                        },
                      ]
                    if (query.includes('INSERT INTO jev_evaluation_receipts')) return []
                    if (query.includes('jev_evaluation_receipts') && query.includes('AS matches'))
                      return [{ matches: true }]
                    if (query.includes('INSERT INTO jev_evaluation_resolutions')) return []
                    throw new Error(`Unexpected receipt timing query: ${query}`)
                  }),
                ),
              ),
          })
          return new Proxy(statement, {
            get(target, property, receiver) {
              return Object.hasOwn(observed, property)
                ? Reflect.get(observed, property, receiver)
                : Reflect.get(target, property, receiver)
            },
          })
        },
        get(target, property, receiver) {
          if (property === 'withTransaction')
            return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.onExit((exit) =>
                  Exit.isSuccess(exit)
                    ? TestClock.adjust(40).pipe(Effect.andThen(Effect.sync(() => commits++)))
                    : Effect.void,
                ),
              )
          if (property === 'json') return (value: unknown) => client`${JSON.stringify(value)}::jsonb`
          return Reflect.get(target, property, receiver)
        },
      })
      const start = Date.parse(plan.expiresAt) - remainingMs
      yield* TestClock.setTime(start)
      const store = yield* makeJevEvaluationStore.pipe(Effect.provideService(PgClient.PgClient, sql))
      const resolutions = yield* store.recordAll(entries)
      const finishedAt = yield* Clock.currentTimeMillis
      return {
        statements: queries.length,
        commits,
        elapsedMs: finishedAt - start,
        resolutions,
        usable: Result.isSuccess(usableEntryBatchInferences(plan, batch, finishedAt, JevBatchPlanVersion.V8)),
      }
    }),
  ).pipe(Effect.provide(TestClock.layer()), Effect.provide(Reactivity.layer))

test('cohort receipt persistence keeps a completed batch usable within its original deadline', async () => {
  const result = await Effect.runPromise(recordWithStatementLatency(500))
  expect(result).toMatchObject({ statements: 7, commits: 1, elapsedMs: 320, usable: true })
  expect(result.resolutions.size).toBe(4)
  for (const candidate of batch.candidates) {
    if (candidate.status === 'RESOLVED')
      expect(result.resolutions.get(candidate.requestId)).toEqual(candidate.resolution)
  }
})

test('cohort persistence cannot make evidence usable after the original deadline', async () => {
  const result = await Effect.runPromise(recordWithStatementLatency(200))
  expect(result).toMatchObject({ commits: 1, usable: false })
  expect(result.resolutions.size).toBe(4)
})
