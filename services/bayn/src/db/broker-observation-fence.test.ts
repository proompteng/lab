import { describe, expect, test } from 'bun:test'
import type { PgClient } from '@effect/sql-pg'
import { Cause, Effect, Exit, Logger, Result, type Tracer } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerReadErrorKind } from '../broker/alpaca/failures'
import { observedBrokerSnapshotFixture } from '../broker/alpaca/observed-snapshot.fixture'
import { observedBrokerState } from '../broker/alpaca/observed-snapshot'
import { canonicalHashV1Result } from '../hash'
import { valkeyFixture } from '../testing/valkey-fixture'
import { makeBrokerObservationStore } from './broker-observations'

const unavailableRead = (diagnostic: Effect.Effect<readonly unknown[], unknown>) => {
  let queries = 0
  const sql = (() =>
    Effect.suspend(() => (++queries <= 2 ? Effect.succeed([]) : diagnostic))) as unknown as PgClient.PgClient
  return makeBrokerObservationStore(sql, 'private-account', 'a'.repeat(40), 60_000, valkeyFixture().cache).readState
}

interface PendingFences {
  readonly newerMutation: boolean
  readonly newerBrokerEvent: boolean
  readonly newerNotification: boolean
}

const pendingAttributes = (span: Tracer.Span | undefined) =>
  Object.fromEntries(
    [...(span?.attributes ?? [])].filter(([key]) => key.startsWith('bayn.broker.observation.pending.')),
  )

const projectedRead = (fences: readonly PendingFences[], admitted = false, brokenDiagnostic = false) =>
  Effect.gen(function* () {
    const accountId = 'private-account'
    const at = '2026-11-12T18:00:00.000Z'
    yield* TestClock.setTime(Date.parse(at))
    const snapshot = observedBrokerSnapshotFixture(accountId, at)
    const snapshotHash = Result.getOrThrow(canonicalHashV1Result(snapshot))
    const stateHash = Result.getOrThrow(canonicalHashV1Result({ snapshotHash, state: observedBrokerState(snapshot) }))
    const row = { snapshot_hash: snapshotHash, state_hash: stateHash, observedAt: at }
    let publishing = true
    let reads = 0
    let span: Tracer.Span | undefined
    const sql = (() =>
      Effect.gen(function* () {
        if (publishing) return [{ account_id: accountId }]
        reads++
        if (reads === 1) return admitted ? [row] : []
        span = yield* Effect.currentSpan.pipe(Effect.orDie)
        if (brokenDiagnostic) {
          const attribute = span.attribute.bind(span)
          span.attribute = (key, value) => {
            if (key.startsWith('bayn.broker.observation.pending.')) throw new Error('diagnostic sink failed')
            attribute(key, value)
          }
        }
        return fences.map((flags) => ({ ...row, ...flags }))
      })) as unknown as PgClient.PgClient
    const store = makeBrokerObservationStore(sql, accountId, 'a'.repeat(40), 60_000, valkeyFixture().cache)
    expect(yield* store.publish({ generation: 1, startedAt: at }, snapshot, 0)).toBe(true)
    publishing = false
    const result = yield* store.readState.pipe(Effect.result)
    return { result, reads, attributes: pendingAttributes(span), state: observedBrokerState(snapshot) }
  }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([])))

describe('Broker pending-cut diagnostics', () => {
  test.each(Array.from({ length: 7 }, (_, index) => index + 1))(
    'retains only the three fixed fences from the selected pending row: %s',
    async (mask) => {
      const flags = {
        newerMutation: (mask & 1) !== 0,
        newerBrokerEvent: (mask & 2) !== 0,
        newerNotification: (mask & 4) !== 0,
      }
      const actual = await projectedRead([flags]).pipe(Effect.runPromise)
      expect(actual.reads).toBe(2)
      expect(Result.isFailure(actual.result)).toBe(true)
      if (Result.isFailure(actual.result)) {
        expect(actual.result.failure.kind).toBe(BrokerReadErrorKind.ObservationPending)
        expect(actual.result.failure.retryable).toBe(true)
        expect(actual.result.failure.observationFailure).toBeUndefined()
      }
      expect(actual.attributes).toEqual({
        'bayn.broker.observation.pending.newer_mutation': flags.newerMutation,
        'bayn.broker.observation.pending.newer_broker_event': flags.newerBrokerEvent,
        'bayn.broker.observation.pending.newer_notification': flags.newerNotification,
      })
      expect(JSON.stringify(actual.attributes)).not.toContain('private-account')
      expect(JSON.stringify(actual.attributes)).not.toContain('2026-11-12')
      expect(Object.values(actual.attributes).every((value) => typeof value === 'boolean')).toBe(true)
    },
  )

  test('does not combine fences from different candidate rows', async () => {
    const actual = await projectedRead([
      { newerMutation: true, newerBrokerEvent: false, newerNotification: false },
      { newerMutation: false, newerBrokerEvent: true, newerNotification: true },
    ]).pipe(Effect.runPromise)
    expect(actual.attributes).toEqual({
      'bayn.broker.observation.pending.newer_mutation': true,
      'bayn.broker.observation.pending.newer_broker_event': false,
      'bayn.broker.observation.pending.newer_notification': false,
    })
    expect(actual.reads).toBe(2)
  })

  test('does not query or annotate pending fences for an admitted cut', async () => {
    const actual = await projectedRead([], true).pipe(Effect.runPromise)
    expect(actual.result).toEqual(Result.succeed(actual.state))
    expect(actual.reads).toBe(1)
    expect(actual.attributes).toEqual({})
  })

  test('a broken diagnostic sink cannot replace the existing pending error', async () => {
    const actual = await projectedRead(
      [{ newerMutation: true, newerBrokerEvent: false, newerNotification: false }],
      false,
      true,
    ).pipe(Effect.runPromise)
    expect(Result.isFailure(actual.result)).toBe(true)
    if (Result.isFailure(actual.result)) expect(actual.result.failure.kind).toBe(BrokerReadErrorKind.ObservationPending)
    expect(actual.reads).toBe(2)
  })
})

describe('Broker observation revision diagnostic', () => {
  test.each([false, true])(
    'reports a verified foreign revision without changing rejection: %s',
    async (foreignRevision) => {
      const failure = await unavailableRead(Effect.succeed([{ foreignRevision }])).pipe(Effect.flip, Effect.runPromise)
      expect(failure.kind).toBe(BrokerReadErrorKind.Timeout)
      expect(failure.retryable).toBe(true)
      expect(failure.observationFailure).toBe('NO_ADMISSIBLE_CUT')
      expect(failure.message).toBe(
        foreignRevision
          ? 'Broker observation source revision differs from this runtime'
          : 'Broker observation is unavailable or invalidated by a mutation',
      )
      expect(failure.message).not.toContain('private-account')
    },
  )

  test('a failed diagnostic remains a typed persistence failure', async () => {
    const failure = await unavailableRead(Effect.fail(new Error('test database failure'))).pipe(
      Effect.flip,
      Effect.runPromise,
    )
    expect(failure.message).toBe('Broker observation persistence failed')
    expect(failure.observationFailure).toBeUndefined()
  })

  test('malformed diagnostic evidence cannot assert a revision mismatch', async () => {
    const failure = await unavailableRead(Effect.succeed([{ foreignRevision: 'true' }])).pipe(
      Effect.flip,
      Effect.runPromise,
    )
    expect(failure.message).toBe('Broker observation persistence failed')
  })

  test('diagnostic interruption remains interruption', async () => {
    const exit = await unavailableRead(Effect.interrupt).pipe(Effect.runPromiseExit)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })
})
