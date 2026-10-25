import { strictParseOptions } from '../../schemas'
import { withProviderSessions } from '../../testing/market-calendar-fixture'
import { describe, expect, test } from 'bun:test'

import { Effect, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, type BrokerReadShape, type MarketCalendarObservation } from '../../broker/alpaca/model'
import { makeCycleExecutionPolicy, makeCycleIdentity } from '../construction'
import { CycleState, CycleTerminalReason, type AutonomousCycle, AutonomousCycleSchema } from '../model'
import { CycleStore, CycleStoreError, type CycleStoreShape } from '../store/model'
import { makeInitialCycle } from '../store/decisions'
import { unusedEntryExpiresAt } from '../entry-admission'
import { continuousMarketHours } from '../../market-hours'
import { makeIntradayCycleDraft, selectIntradayExecutionSession } from './calendar-decisions'
import type { CycleRunContext } from './model'
import { discoverAutonomousCyclePass } from './program'

const forbidden = () => Effect.die(new Error('unexpected discovery side effect'))
const policy = Result.getOrThrow(
  makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
    strategyExecutionModelHash: '1'.repeat(64),
    warmupAfterOpenMs: 0,
    submissionCutoffBeforeCloseMs: 300_000,
  }),
)
if (policy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3') throw new Error('invalid fixture policy')
const changedPolicy = Result.getOrThrow(
  makeCycleExecutionPolicy({
    schemaVersion: policy.schemaVersion,
    strategyExecutionModelHash: policy.strategyExecutionModelHash,
    warmupAfterOpenMs: 60_000,
    submissionCutoffBeforeCloseMs: 300_000,
  }),
)
if (changedPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
  throw new Error('invalid changed policy')
const context: CycleRunContext = {
  cycleBindingId: '2'.repeat(64),
  strategyName: 'jev',
  strategyProtocolHash: '3'.repeat(64),
  accountId: 'sandbox-recovery-account',
  authorityGenerationHash: '4'.repeat(64),
  executionPolicy: policy,
  buildDecision: forbidden,
  buildDecisionEvidence: forbidden,
}
const session = { date: '2026-09-18', openAt: '2026-09-18T13:30:00.000Z', closeAt: '2026-09-18T20:00:00.000Z' }
const calendar: MarketCalendarObservation = withProviderSessions({
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
  source: 'alpaca-v2-calendar',
  requestedRange: { start: session.date, end: session.date },
  timeZone: 'UTC',
  sessions: [session],
  normalizedResponseHash: '5'.repeat(64),
})
const blockedAt = '2026-09-18T13:05:00.000Z'
const rearmAt = '2026-09-18T14:06:00.000Z'
const blockedCycle = (ordinal = 1, overrides: Record<string, unknown> = {}): AutonomousCycle =>
  Effect.runSync(
    Schema.decodeUnknownEffect(
      AutonomousCycleSchema,
      strictParseOptions,
    )({
      ...Result.getOrThrow(makeIntradayCycleDraft(context, calendar, session, ordinal)),
      state: CycleState.Blocked,
      bindings: {},
      stateVersion: 3,
      createdAt: '2026-09-18T13:00:00.000Z',
      updatedAt: blockedAt,
      terminalAt: blockedAt,
      terminalReason: CycleTerminalReason.ProvenanceMismatch,
      ...overrides,
    }),
  )

const fixture = (
  cycle: AutonomousCycle | null = blockedCycle(),
  observation = calendar,
  readDecisionDocument: CycleStoreShape['readDecisionDocument'] = () => Effect.succeed(Option.none()),
) => {
  const cycles = new Map<string, AutonomousCycle>(cycle === null ? [] : [[cycle.identity.cycleId, cycle]])
  let latest = cycle
  let acquisitions = 0
  const broker: BrokerReadShape = {
    account: forbidden(),
    accountConfiguration: forbidden(),
    positions: forbidden(),
    assetBySymbol: forbidden,
    orders: forbidden,
    orderById: forbidden,
    orderByClientId: forbidden,
    fillActivities: forbidden,
    feeActivities: forbidden,
    marketCalendar: () =>
      Effect.succeed({
        value: observation,
        evidence: {
          requestId: 'calendar-recovery',
          status: 200,
          contentHash: '6'.repeat(64),
          observedAt: rearmAt,
        },
      }),
  }
  const store: CycleStoreShape = {
    read: (id) => Effect.sync(() => Option.fromUndefinedOr(cycles.get(id))),
    readAuthoritySlot: () => Effect.sync(() => (latest === null ? Option.none() : Option.some(latest))),
    readDecisionDocument,
    readOldestUnfinished: forbidden,
    activate: forbidden,
    bindDecision: forbidden,
    finish: forbidden,
    block: forbidden,
    acquire: (draft, observedAt) =>
      Effect.sync(() => {
        acquisitions += 1
        const existing = cycles.get(draft.identity.cycleId)
        if (existing !== undefined) return { cycle: existing, created: false }
        latest = makeInitialCycle(draft, observedAt)
        cycles.set(latest.identity.cycleId, latest)
        return { cycle: latest, created: true }
      }),
  }
  const run = (candidate = context, at = rearmAt) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(at))
        return yield* discoverAutonomousCyclePass(candidate)
      }).pipe(
        Effect.provideService(BrokerRead, broker),
        Effect.provideService(CycleStore, store),
        Effect.provide(TestClock.layer()),
      ),
    )
  return { run, store, cycles, acquisitions: () => acquisitions }
}

describe('unbound pre-submission cycle recovery', () => {
  test.each([
    { at: '2026-09-18T13:29:59.999Z', equityReady: false },
    { at: '2026-09-18T13:30:00.000Z', equityReady: false },
    { at: '2026-09-18T13:30:59.999Z', equityReady: false },
    { at: '2026-09-18T13:31:01.999Z', equityReady: false },
    { at: '2026-09-18T13:31:02.000Z', equityReady: true },
  ])('starts the equity entry lease only when a completed minute can be observed: $at', async ({ at, equityReady }) => {
    const result = await fixture(null).run(context, at)
    expect(result.outcome).toBe('ACQUIRED')
    if (result.outcome !== 'ACQUIRED') throw new Error('entry cycle not acquired')
    expect(result.receipt.cycle.window.executionCalendarSchemaVersion).toBe(
      equityReady ? 'bayn.alpaca-market-calendar-observation.v2' : 'bayn.continuous-market-hours.v1',
    )
    expect(unusedEntryExpiresAt(result.receipt.cycle)).toBe(Date.parse(at) + 60_000)
  })

  test('keeps continuous admission available at equity open after a settled crypto attempt', async () => {
    const createdAt = '2026-09-18T13:28:00.000Z'
    const previousSession = selectIntradayExecutionSession(continuousMarketHours, policy, createdAt)
    if (previousSession === undefined) throw new Error('continuous fixture session missing')
    const previous = makeInitialCycle(
      Result.getOrThrow(makeIntradayCycleDraft(context, continuousMarketHours, previousSession, 2)),
      createdAt,
    )
    const result = await fixture({
      ...previous,
      state: CycleState.NoTrade,
      bindings: { snapshotId: '7'.repeat(64), decisionHash: '8'.repeat(64) },
      stateVersion: 4,
      updatedAt: '2026-09-18T13:28:05.000Z',
      terminalAt: '2026-09-18T13:28:05.000Z',
    }).run(context, session.openAt)
    expect(result).toMatchObject({
      outcome: 'ACQUIRED',
      receipt: {
        cycle: {
          identity: { entryAttemptOrdinal: 3 },
          window: { executionCalendarSchemaVersion: 'bayn.continuous-market-hours.v1' },
        },
      },
    })
  })

  test('completed attempts alternate markets even when lease and cooldown return to the same UTC minute parity', async () => {
    const { terminalReason: _, ...prior } = blockedCycle(1, {
      bindings: { snapshotId: '7'.repeat(64), decisionHash: '8'.repeat(64) },
      terminalAt: '2026-09-18T14:05:00.000Z',
      updatedAt: '2026-09-18T14:05:00.000Z',
    })
    const result = await fixture({ ...prior, state: CycleState.Completed }).run()
    expect(result).toMatchObject({
      outcome: 'ACQUIRED',
      receipt: {
        cycle: {
          identity: { entryAttemptOrdinal: 2 },
          window: { executionCalendarSchemaVersion: 'bayn.continuous-market-hours.v1' },
        },
      },
    })
  })

  test('rejects constructing a retired strategy cycle under the current execution contract', () => {
    const current = Result.getOrThrow(makeIntradayCycleDraft(context, calendar, session))
    const { cycleId: _id, schemaVersion: _schema, entryAttemptOrdinal: _ordinal, ...material } = current.identity
    expect(
      Result.isFailure(
        makeCycleIdentity({
          ...material,
          schemaVersion: 'bayn.autonomous-cycle-identity.v3',
          strategyName: 'intraday-momentum',
        }),
      ),
    ).toBe(true)
  })

  test('acquires a distinct same-session successor without changing the blocked historical cycle', async () => {
    const prior = blockedCycle()
    const f = fixture(prior)
    const result = await f.run()
    expect(result.outcome).toBe('ACQUIRED')
    if (result.outcome !== 'ACQUIRED') throw new Error('successor not acquired')
    expect(result.receipt.cycle.identity).toMatchObject({ entryAttemptOrdinal: 2, executionSessionDate: session.date })
    expect(result.receipt.cycle.identity.cycleId).not.toBe(prior.identity.cycleId)
    expect(result.receipt.cycle.bindings).toEqual({})
    expect(result.receipt.cycle.window.executionCalendarSchemaVersion).toBe('bayn.continuous-market-hours.v1')
    expect(f.cycles.get(prior.identity.cycleId)).toEqual(prior)
    expect((await f.run()).outcome).toBe('ALREADY_ACQUIRED')
    expect(f.acquisitions()).toBe(1)
  })

  test('recovers later untouched ordinals without reusing the first attempt identity', async () => {
    const result = await fixture(blockedCycle(3)).run()
    expect(result.outcome).toBe('ACQUIRED')
    if (result.outcome !== 'ACQUIRED') throw new Error('successor not acquired')
    expect(result.receipt.cycle.identity).toMatchObject({ entryAttemptOrdinal: 4 })
  })

  test('retains the rearm cooldown and hands the closing equity session to continuous markets', async () => {
    const f = fixture()
    expect((await f.run(context, '2026-09-18T13:05:59.999Z')).outcome).toBe('ALREADY_TERMINAL')
    const cutoffResult = await f.run(context, '2026-09-18T19:55:00.000Z').catch((cause: unknown) => cause)
    expect(cutoffResult).toMatchObject({
      outcome: 'ACQUIRED',
      receipt: { cycle: { window: { executionCalendarSchemaVersion: 'bayn.continuous-market-hours.v1' } } },
    })
    expect(f.acquisitions()).toBe(1)
  })

  test('cannot recover without current execution authority', async () => {
    const { authorityGenerationHash: _, ...observe } = context
    const f = fixture()
    expect((await f.run(observe)).outcome).toBe('ALREADY_TERMINAL')
    expect(f.acquisitions()).toBe(0)
  })

  for (const reason of Object.values(CycleTerminalReason).filter((r) => r !== CycleTerminalReason.ProvenanceMismatch)) {
    test(`does not bypass ${reason}`, async () => {
      const f = fixture(blockedCycle(1, { terminalReason: reason }))
      expect((await f.run()).outcome).toBe('ALREADY_TERMINAL')
      expect(f.acquisitions()).toBe(0)
    })
  }

  for (const bindings of [
    { snapshotId: '7'.repeat(64) },
    { snapshotId: '7'.repeat(64), decisionHash: '8'.repeat(64) },
  ]) {
    test(`does not reinterpret a cycle with existing ${bindings.decisionHash ? 'decision' : 'snapshot'} evidence`, async () => {
      const f = fixture(blockedCycle(1, { bindings }))
      expect((await f.run()).outcome).toBe('ALREADY_TERMINAL')
      expect(f.acquisitions()).toBe(0)
    })
  }

  for (const [name, candidate] of [
    ['protocol', { ...context, strategyProtocolHash: '9'.repeat(64) }],
    ['mandate', { ...context, cycleBindingId: '9'.repeat(64) }],
    ['account', { ...context, accountId: 'another-sandbox-account' }],
    ['policy', { ...context, executionPolicy: changedPolicy }],
  ] as const) {
    test(`does not replace changed immutable ${name}`, async () => {
      const f = fixture()
      expect((await f.run(candidate)).outcome).toBe('ALREADY_TERMINAL')
      expect(f.acquisitions()).toBe(0)
    })
  }

  test('rejects changed exchange-calendar evidence', async () => {
    const f = fixture(blockedCycle(2), { ...calendar, sessions: [{ ...session, closeAt: '2026-09-18T19:00:00.000Z' }] })
    expect((await f.run()).outcome).toBe('ALREADY_TERMINAL')
    expect(f.acquisitions()).toBe(0)
  })

  test('does not reinterpret a provenance block applied at or after submission open', async () => {
    const f = fixture(blockedCycle(1, { terminalAt: session.openAt, updatedAt: session.openAt }))
    expect((await f.run(context, '2026-09-18T13:31:00.000Z')).outcome).toBe('ALREADY_TERMINAL')
    expect(f.acquisitions()).toBe(0)
  })

  test('a failed evidence read cannot be treated as an absent decision', async () => {
    const f = fixture(blockedCycle(), calendar, () =>
      Effect.fail(
        new CycleStoreError({
          operation: 'read-decision-document',
          failure: 'query',
          message: 'fixture read unavailable',
        }),
      ),
    )
    const failure = await f.run().catch((cause: unknown) => cause)
    expect(failure).toMatchObject({ operation: 'read-authority-slot', failure: 'store' })
    expect(f.acquisitions()).toBe(0)
  })
})
