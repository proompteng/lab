import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Option, Redacted, Result } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  isIntradayCycleDraft,
  makeCycleDraft,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
  type IntradayCycleDraft,
} from '../index'
import { PostgresClientLive } from '../../db/postgres-client'
import { postgresMigrations } from '../../db/postgres-migrations'
import { canonicalHashV1 } from '../../hash'
import { intradayMomentumExecutionModel } from '../../strategy/intraday-momentum/protocol'
import { baynTestPostgresUrl } from '../../test-environment.test-support'
import { config as fixtureConfig } from '../../testing/runtime-fixtures'
import { CycleStore, CycleStoreLive } from '.'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const accountId = 'paper-account-intraday-store'
const qualificationRunId = '1'.repeat(64)
const sessionDate = '2026-08-28' as const
const acquiredAt = '2026-08-28T13:00:00.000Z'
const activatedAt = '2026-08-28T14:31:00.000Z'
const blockedAt = '2026-08-28T15:00:00.000Z'
const config = {
  ...fixtureConfig,
  operationTimeoutMs: 5_000,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const value = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}

const draft = (strategyProtocolHash = canonicalHashV1({ strategy: 'intraday-momentum', version: 1 })) => {
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: sessionDate,
      openAt: '2026-08-28T13:30:00.000Z',
      closeAt: '2026-08-28T20:00:00.000Z',
    }),
  )
  const executionPolicy = value(makeCycleExecutionPolicyFromModel(intradayMomentumExecutionModel))
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v3',
      strategyName: 'intraday-momentum',
      qualificationRunId,
      strategyProtocolHash,
      accountId,
      executionSessionDate: sessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy,
    }),
  )
  const candidate = value(makeCycleDraft(identity, value(makeIntradayCycleWindow(calendar, executionPolicy))))
  if (!isIntradayCycleDraft(candidate)) throw new Error('expected the active intraday cycle contract')
  return candidate satisfies IntradayCycleDraft
}

const makeRuntime = () =>
  ManagedRuntime.make(
    CycleStoreLive.pipe(Layer.provideMerge(PostgresClientLive(config)), Layer.provideMerge(NodeServices.layer)),
  )

const resetDatabase = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  yield* sql`DROP SCHEMA public CASCADE`
  yield* sql`CREATE SCHEMA public`
  yield* postgresMigrations
})

describePostgres('PostgreSQL intraday cycle store', () => {
  let runtime: ReturnType<typeof makeRuntime>

  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
    runtime = makeRuntime()
  })

  beforeEach(async () => {
    await runtime.runPromise(resetDatabase)
  })

  afterAll(async () => {
    await runtime?.dispose()
  })

  test('converges concurrent acquisition on one immutable intraday cycle', async () => {
    const candidate = draft()
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        const receipts = yield* Effect.all(
          [store.acquire(candidate, acquiredAt), store.acquire(candidate, acquiredAt)],
          { concurrency: 'unbounded' },
        )
        return {
          receipts,
          stored: yield* store.read(candidate.identity.cycleId),
          slot: yield* store.readAuthoritySlot({
            qualificationRunId,
            accountId,
            executionSessionDate: sessionDate,
          }),
        }
      }),
    )

    expect(result.receipts.filter(({ created }) => created)).toHaveLength(1)
    expect(result.receipts.map(({ cycle }) => cycle.identity.cycleId)).toEqual([
      candidate.identity.cycleId,
      candidate.identity.cycleId,
    ])
    expect(Option.getOrThrow(result.stored)).toMatchObject({ state: CycleState.Pending, stateVersion: 1 })
    expect(Option.getOrThrow(result.slot).identity.cycleId).toBe(candidate.identity.cycleId)
  })

  test('recovers the oldest active cycle and releases it after terminal blocking', async () => {
    const candidate = draft()
    const scope = { qualificationRunId, accountId }
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(candidate, acquiredAt)
        const activated = yield* store.activate(candidate.identity.cycleId, activatedAt)
        const recovered = yield* store.readOldestUnfinished(scope)
        const blocked = yield* store.block(candidate.identity.cycleId, CycleTerminalReason.DataUnavailable, blockedAt)
        const replayed = yield* store.block(candidate.identity.cycleId, CycleTerminalReason.DataUnavailable, blockedAt)
        return {
          activated,
          recovered,
          blocked,
          replayed,
          after: yield* store.readOldestUnfinished(scope),
        }
      }),
    )

    expect(result.activated).toMatchObject({ changed: true, cycle: { state: CycleState.Active, stateVersion: 2 } })
    expect(Option.getOrThrow(result.recovered).identity.cycleId).toBe(candidate.identity.cycleId)
    expect(result.blocked).toMatchObject({
      changed: true,
      cycle: {
        state: CycleState.Blocked,
        terminalReason: CycleTerminalReason.DataUnavailable,
        stateVersion: 3,
      },
    })
    expect(result.replayed).toMatchObject({ changed: false, cycle: { state: CycleState.Blocked } })
    expect(Option.isNone(result.after)).toBeTrue()
  })

  test('rejects conflicting authority-slot content and invalid lifecycle transitions', async () => {
    const candidate = draft()
    const conflicting = draft('f'.repeat(64))
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CycleStore
        yield* store.acquire(candidate, acquiredAt)
        const authorityConflict = yield* store.acquire(conflicting, acquiredAt).pipe(Effect.flip)
        const backwardActivation = yield* store
          .activate(candidate.identity.cycleId, '2026-08-28T12:59:59.000Z')
          .pipe(Effect.flip)
        yield* store.activate(candidate.identity.cycleId, activatedAt)
        const prematureCompletion = yield* store
          .finish(candidate.identity.cycleId, CycleState.NoTrade, blockedAt)
          .pipe(Effect.flip)
        return { authorityConflict, backwardActivation, prematureCompletion }
      }),
    )

    expect(result.authorityConflict).toMatchObject({ operation: 'acquire', failure: 'conflict' })
    expect(result.backwardActivation).toMatchObject({ operation: 'activate', failure: 'conflict' })
    expect(result.prematureCompletion).toMatchObject({ operation: 'finish', failure: 'invariant' })
  })
})
