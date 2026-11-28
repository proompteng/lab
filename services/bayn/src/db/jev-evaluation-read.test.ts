import { expect, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Effectable, Exit, Redacted, Result } from 'effect'
import * as Reactivity from 'effect/reactivity/Reactivity'
import type { Statement } from 'effect/sql/Statement'
import { nativeJevFixture, nativeJevDecisionEvidence } from '../jev/native.test-support'
import { JevCandidatePlanStatus, JevCandidateResultStatus } from '../jev/batch'
import { JevOutcome } from '../jev/evidence'
import { canonicalHashV1Result } from '../hash'
import { readJevEvaluationEvidence } from './jev-evaluation-read'

const fixture = nativeJevFixture()
const { batchPlan, batchResult } = nativeJevDecisionEvidence(fixture)
const rows = batchPlan.candidates
  .flatMap((candidate, index) => {
    const result = batchResult.candidates[index]
    if (
      candidate.status !== JevCandidatePlanStatus.Requested ||
      result?.status !== JevCandidateResultStatus.Resolved ||
      result.receipt?.outcome.status !== JevOutcome.Completed
    )
      return []
    return [
      {
        request_id: candidate.request.requestId,
        request: candidate.request,
        receipt: result.receipt,
        handoff: result.receipt.outcome.completion.handoff,
        resolution: result.resolution,
      },
    ]
  })
  .slice(0, 2)

const readFixture = (onObservation: () => void, corruptHandoff = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* PgClient.make({
        url: Redacted.make('postgres://unused@127.0.0.1:1/unused_test'),
        minConnections: 0,
        stream: () => {
          throw new Error('Evidence scheduling test must not connect')
        },
      })
      const copied = structuredClone(rows)
      if (corruptHandoff && copied[0])
        copied[0] = { ...copied[0], handoff: { ...copied[0].handoff, handoffHash: '0'.repeat(64) } }
      const mocked = new Proxy(sql, {
        apply(target, receiver, args) {
          const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, args)
          const query = statement.compile()[0]
          const observed = Effectable.Prototype({
            label: 'Evidence fixture statement',
            evaluate: () =>
              Effect.sync(() => {
                if (query.includes('FROM jev_evaluation_requests')) return copied
                if (query.includes('JOIN intraday_candidate_observations')) {
                  onObservation()
                  return [
                    {
                      content_hash: Result.getOrThrow(canonicalHashV1Result(fixture.observation.payload)),
                      payload: fixture.observation.payload,
                      matching_request_ids: copied.map((row) => row.request_id),
                    },
                  ]
                }
                throw new Error('Unexpected evidence fixture query')
              }),
          })
          return new Proxy(statement, {
            get(target, property, receiver) {
              return Object.hasOwn(observed, property)
                ? Reflect.get(observed, property, receiver)
                : Reflect.get(target, property, receiver)
            },
          })
        },
      })
      return yield* readJevEvaluationEvidence(
        mocked,
        copied.map((row) => row.request_id),
      )
    }),
  ).pipe(Effect.provide(Reactivity.layer))

test('candidate evidence validation services the event loop before completing the receipt cohort', async () => {
  let serviced = false
  let immediate: ReturnType<typeof setImmediate> | undefined
  try {
    const result = await Effect.runPromise(
      readFixture(() => {
        immediate = setImmediate(() => {
          serviced = true
        })
      }),
    )
    expect(serviced).toBe(true)
    expect(rows).toHaveLength(2)
    expect(result.evidence.size).toBe(rows.length)
    expect([...result.evidence.keys()]).toEqual(rows.map((row) => row.request_id))
    for (const row of rows)
      expect(result.evidence.get(row.request_id)).toEqual({
        request: row.request,
        receipt: row.receipt,
        resolution: row.resolution,
      })
  } finally {
    if (immediate) clearImmediate(immediate)
  }
})

test('candidate evidence validation remains interruptible between receipt chunks', async () => {
  const controller = new AbortController()
  let immediate: ReturnType<typeof setImmediate> | undefined
  try {
    const exit = await Effect.runPromiseExit(
      readFixture(() => {
        immediate = setImmediate(() => controller.abort())
      }),
      { signal: controller.signal },
    )
    expect(Exit.hasInterrupts(exit)).toBe(true)
  } finally {
    if (immediate) clearImmediate(immediate)
  }
})

test('candidate evidence scheduling does not accept a substituted committed handoff', async () => {
  const exit = await Effect.runPromiseExit(readFixture(() => {}, true))
  expect(Exit.isFailure(exit)).toBe(true)
})
