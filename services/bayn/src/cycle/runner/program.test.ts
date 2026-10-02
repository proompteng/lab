import { describe, expect, test } from 'bun:test'

import { Effect, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, type BrokerReadShape, type MarketCalendarObservation } from '../../broker/alpaca'
import { makeCycleDraft, makeCycleExecutionPolicy, makeCycleIdentity } from '../construction'
import { CycleState, CycleTerminalReason, decodeAutonomousCycle, type AutonomousCycle } from '../model'
import { CycleStore, CycleStoreError, type CycleStoreShape } from '../store'
import { makeInitialCycle } from '../store/decisions'
import { makeIntradayCycleDraft } from './calendar-decisions'
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
}
const session = { date: '2026-09-18', openAt: '2026-09-18T13:30:00.000Z', closeAt: '2026-09-18T20:00:00.000Z' }
const calendar: MarketCalendarObservation = {
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
  source: 'alpaca-v2-calendar',
  requestedRange: { start: session.date, end: session.date },
  timeZone: 'UTC',
  sessions: [session],
  normalizedResponseHash: '5'.repeat(64),
}
const blockedAt = '2026-09-18T13:05:00.000Z'
const rearmAt = '2026-09-18T13:06:00.000Z'
const blockedCycle = (ordinal = 1, overrides: Record<string, unknown> = {}): AutonomousCycle =>
  Effect.runSync(
    decodeAutonomousCycle({
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
  cycle = blockedCycle(),
  observation = calendar,
  readDecisionDocument: CycleStoreShape['readDecisionDocument'] = () => Effect.succeed(Option.none()),
) => {
  const cycles = new Map([[cycle.identity.cycleId, cycle]])
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
    readAuthoritySlot: () => Effect.sync(() => Option.some(latest)),
    readDecisionDocument,
    readOldestUnfinished: forbidden,
    activate: forbidden,
    bindSnapshot: forbidden,
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
  test('retains a supported v3 record and acquires a v4 successor under the same immutable context', async () => {
    const candidate = { ...context, strategyName: 'intraday-momentum' as const }
    const current = Result.getOrThrow(makeIntradayCycleDraft(candidate, calendar, session))
    if (current.identity.schemaVersion !== 'bayn.autonomous-cycle-identity.v4') throw new Error('expected v4 fixture')
    const { cycleId: _id, schemaVersion: _schema, entryAttemptOrdinal: _ordinal, ...material } = current.identity
    const original = Result.getOrThrow(
      makeCycleDraft(
        Result.getOrThrow(makeCycleIdentity({ ...material, schemaVersion: 'bayn.autonomous-cycle-identity.v3' })),
        current.window,
      ),
    )
    const prior = blockedCycle(1, original)
    const f = fixture(prior)
    const result = await f.run(candidate)
    expect(result.outcome).toBe('ACQUIRED')
    if (result.outcome !== 'ACQUIRED') throw new Error('legacy successor not acquired')
    expect(result.receipt.cycle.identity).toMatchObject({
      schemaVersion: 'bayn.autonomous-cycle-identity.v4',
      entryAttemptOrdinal: 2,
    })
    expect(f.cycles.get(prior.identity.cycleId)).toEqual(prior)
    const mismatched = fixture(prior)
    expect((await mismatched.run({ ...candidate, strategyProtocolHash: 'a'.repeat(64) })).outcome).toBe(
      'ALREADY_TERMINAL',
    )
    expect(mismatched.acquisitions()).toBe(0)
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
    expect(result.receipt.cycle.window).toEqual(prior.window)
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

  test('retains the existing rearm cooldown and strict submission cutoff', async () => {
    const f = fixture()
    expect((await f.run(context, '2026-09-18T13:05:59.999Z')).outcome).toBe('ALREADY_TERMINAL')
    const cutoffResult = await f.run(context, '2026-09-18T19:55:00.000Z').catch((cause: unknown) => cause)
    expect(cutoffResult).toMatchObject({ failure: 'calendar-unavailable' })
    expect(f.acquisitions()).toBe(0)
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
    ['strategy', { ...context, strategyName: 'intraday-momentum' as const }],
    ['policy', { ...context, executionPolicy: changedPolicy }],
  ] as const) {
    test(`does not replace changed immutable ${name}`, async () => {
      const f = fixture()
      expect((await f.run(candidate)).outcome).toBe('ALREADY_TERMINAL')
      expect(f.acquisitions()).toBe(0)
    })
  }

  test('rejects changed exchange-calendar evidence', async () => {
    const f = fixture(blockedCycle(), { ...calendar, sessions: [{ ...session, closeAt: '2026-09-18T19:00:00.000Z' }] })
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
