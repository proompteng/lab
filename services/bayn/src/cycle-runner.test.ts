import { describe, expect, test } from 'bun:test'

import { Cause, Deferred, Effect, Exit, Fiber, Logger, References } from 'effect'
import { TestClock } from 'effect/testing'

import {
  BrokerRead,
  BrokerReadError,
  BrokerReadErrorKind,
  type BrokerReadShape,
  type MarketCalendarObservation,
  type MarketCalendarQuery,
} from './broker/alpaca'
import { CycleState, makeCycleExecutionPolicy, type AutonomousCycle, type CycleDraft } from './cycle'
import {
  isMonthEndCycleDue,
  makeDueCycleDraft,
  marketCalendarQueryForSignal,
  runAutonomousCyclePass,
  selectNextExecutionSession,
  startAutonomousCycleLoop,
  type CycleCandidate,
} from './cycle-runner'
import { CycleStore, type CycleStoreShape } from './db/cycle-store'
import { canonicalHashV1 } from './hash'
import type { IsoDate } from './types'

const evidence = {
  requestId: 'calendar-request',
  status: 200,
  contentHash: 'c'.repeat(64),
  observedAt: '2026-01-30T21:01:00.000Z',
}

const executionPolicy = makeCycleExecutionPolicy({
  schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
  strategyExecutionModelHash: '3'.repeat(64),
  submissionWindowMs: 30 * 60 * 1_000,
  submissionCutoffBeforeOpenMs: 2 * 60 * 1_000,
})

const candidate = (
  signalSessionDate: IsoDate = '2026-01-30',
  accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
): CycleCandidate => ({
  qualificationRunId: '1'.repeat(64),
  strategyProtocolHash: '2'.repeat(64),
  accountId,
  signalSession: {
    calendar_version: 'signal-XNYS-2026-v1',
    session_date: signalSessionDate,
    close_time: '16:00',
    timezone: 'America/New_York',
  },
  executionPolicy,
})

const calendar = (
  sessions: MarketCalendarObservation['sessions'],
  requestedRange: MarketCalendarObservation['requestedRange'] = {
    start: '2026-01-30',
    end: '2026-03-01',
  },
): MarketCalendarObservation => {
  const material = {
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1' as const,
    source: 'alpaca-v2-calendar' as const,
    requestedRange,
    timeZone: 'UTC' as const,
    sessions,
  }
  return { ...material, normalizedResponseHash: canonicalHashV1(material) }
}

const monthEndCalendar = calendar([
  {
    date: '2026-01-30',
    openAt: '2026-01-30T14:30:00.000Z',
    closeAt: '2026-01-30T21:00:00.000Z',
  },
  {
    date: '2026-02-02',
    openAt: '2026-02-02T14:30:00.000Z',
    closeAt: '2026-02-02T20:00:00.000Z',
  },
])

const brokerRead = (marketCalendar: BrokerReadShape['marketCalendar']): BrokerReadShape => {
  const unused = Effect.die(new Error('cycle runner must use only the broker calendar read'))
  return {
    account: unused,
    positions: unused,
    orders: () => unused,
    orderById: () => unused,
    orderByClientId: () => unused,
    fillActivities: () => unused,
    marketCalendar,
  }
}

const cycleFrom = (draft: CycleDraft, observedAt: string): AutonomousCycle => ({
  ...draft,
  state: CycleState.Pending,
  bindings: {},
  stateVersion: 1,
  createdAt: observedAt,
  updatedAt: observedAt,
})

interface StoreControl {
  readonly acquisitions: Array<{ readonly draft: CycleDraft; readonly observedAt: string }>
}

const cycleStore = (control: StoreControl): CycleStoreShape => {
  const cycles = new Map<string, AutonomousCycle>()
  const unused = () => Effect.die(new Error('cycle runner must only acquire a cycle'))
  return {
    acquire: (draft, observedAt) =>
      Effect.sync(() => {
        control.acquisitions.push({ draft, observedAt })
        const existing = cycles.get(draft.identity.cycleId)
        if (existing !== undefined) return { cycle: existing, created: false }
        const created = cycleFrom(draft, observedAt)
        cycles.set(draft.identity.cycleId, created)
        return { cycle: created, created: true }
      }),
    read: unused,
    bindSnapshot: unused,
    activate: unused,
    bindDecision: unused,
    block: unused,
  }
}

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>, read: BrokerReadShape, store: CycleStoreShape) =>
  effect.pipe(Effect.provideService(BrokerRead, read), Effect.provideService(CycleStore, store))

describe('autonomous cycle runner', () => {
  test('builds one bounded calendar query and selects the first session strictly after Signal', () => {
    const query = marketCalendarQueryForSignal('2026-01-30')
    const inclusiveDays =
      (Date.parse(`${query.end}T00:00:00.000Z`) - Date.parse(`${query.start}T00:00:00.000Z`)) / 86_400_000 + 1
    expect(query).toEqual({ start: '2026-01-30', end: '2026-03-01' })
    expect(inclusiveDays).toBe(31)

    const selected = selectNextExecutionSession(
      '2026-01-30',
      calendar([
        {
          date: '2026-02-03',
          openAt: '2026-02-03T14:30:00.000Z',
          closeAt: '2026-02-03T21:00:00.000Z',
        },
        {
          date: '2026-01-30',
          openAt: '2026-01-30T14:30:00.000Z',
          closeAt: '2026-01-30T21:00:00.000Z',
        },
        {
          date: '2026-02-02',
          openAt: '2026-02-02T14:30:00.000Z',
          closeAt: '2026-02-02T20:00:00.000Z',
        },
      ]),
    )
    expect(selected?.date).toBe('2026-02-02')
  })

  test('keeps the month-end predicate pure and binds only selected-session material', () => {
    expect(isMonthEndCycleDue('2026-01-29', '2026-01-30')).toBe(false)
    expect(isMonthEndCycleDue('2026-01-30', '2026-02-02')).toBe(true)

    const selected = selectNextExecutionSession('2026-01-30', monthEndCalendar)
    if (selected === undefined) throw new Error('month-end fixture must have an execution session')
    const first = makeDueCycleDraft(candidate(), monthEndCalendar, selected)
    const changedEvidence = calendar([selected], {
      start: '2026-01-31',
      end: '2026-02-10',
    })
    const second = makeDueCycleDraft(candidate(), changedEvidence, selected)
    expect(first?.identity.cycleId).toBe(second?.identity.cycleId)
    expect(first?.window).toMatchObject({
      signalCloseAt: '2026-01-30T21:00:00.000Z',
      publicationDeadlineAt: '2026-02-02T13:58:00.000Z',
      submissionOpenAt: '2026-02-02T13:58:00.000Z',
      submissionCutoffAt: '2026-02-02T14:28:00.000Z',
      executionOpenAt: '2026-02-02T14:30:00.000Z',
      executionCloseAt: '2026-02-02T20:00:00.000Z',
    })

    const ordinaryCandidate = candidate('2026-01-29')
    const ordinarySession = {
      date: '2026-01-30',
      openAt: '2026-01-30T14:30:00.000Z',
      closeAt: '2026-01-30T18:00:00.000Z',
    }
    expect(makeDueCycleDraft(ordinaryCandidate, calendar([ordinarySession]), ordinarySession)).toBeUndefined()
  })

  test('does not acquire an ordinary session and retains response evidence outside identity', async () => {
    const control: StoreControl = { acquisitions: [] }
    let observedQuery: MarketCalendarQuery | undefined
    const observation = calendar([
      {
        date: '2026-01-30',
        openAt: '2026-01-30T14:30:00.000Z',
        closeAt: '2026-01-30T18:00:00.000Z',
      },
    ])
    const read = brokerRead((query) => {
      observedQuery = query
      return Effect.succeed({ value: observation, evidence })
    })

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-29T21:01:00.000Z'))
        return yield* provide(runAutonomousCyclePass(candidate('2026-01-29')), read, cycleStore(control))
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(observedQuery).toEqual(marketCalendarQueryForSignal('2026-01-29'))
    expect(result).toMatchObject({
      outcome: 'NOT_DUE',
      signalSessionDate: '2026-01-29',
      executionSessionDate: '2026-01-30',
      calendarResponseHash: observation.normalizedResponseHash,
      calendarReadContentHash: evidence.contentHash,
    })
    expect(control.acquisitions).toEqual([])
  })

  test('fails typed when the bounded calendar has no future session or BrokerRead rejects drift', async () => {
    const control: StoreControl = { acquisitions: [] }
    const empty = brokerRead(() => Effect.succeed({ value: calendar([]), evidence }))
    const missing = await Effect.runPromise(
      Effect.flip(provide(runAutonomousCyclePass(candidate()), empty, cycleStore(control))),
    )
    expect(missing).toMatchObject({
      _tag: 'CycleRunnerError',
      operation: 'select-session',
      failure: 'calendar-unavailable',
    })

    const drift = new BrokerReadError({
      operation: 'market-calendar',
      kind: BrokerReadErrorKind.InvalidResponse,
      message: 'injected normalized response drift',
      retryable: false,
    })
    const rejected = brokerRead(() => Effect.fail(drift))
    const invalid = await Effect.runPromise(
      Effect.flip(provide(runAutonomousCyclePass(candidate()), rejected, cycleStore(control))),
    )
    expect(invalid).toMatchObject({
      _tag: 'CycleRunnerError',
      operation: 'market-calendar',
      failure: 'calendar-read',
      cause: drift,
    })
    expect(control.acquisitions).toEqual([])
  })

  test('passes exact clock instants and committed boundaries to the store unchanged', async () => {
    const control: StoreControl = { acquisitions: [] }
    const read = brokerRead(() => Effect.succeed({ value: monthEndCalendar, evidence }))
    const boundaries = [
      '2026-01-30T21:00:00.000Z',
      '2026-02-02T13:58:00.000Z',
      '2026-02-02T14:28:00.000Z',
      '2026-02-02T14:30:00.000Z',
    ] as const
    const program = Effect.gen(function* () {
      for (const boundary of boundaries) {
        yield* TestClock.setTime(Date.parse(boundary))
        yield* provide(runAutonomousCyclePass(candidate()), read, cycleStore(control))
      }
    }).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(control.acquisitions.map((acquisition) => acquisition.observedAt)).toEqual([...boundaries])
    expect(
      control.acquisitions.every(
        (acquisition) =>
          acquisition.draft.window.submissionOpenAt < acquisition.draft.window.submissionCutoffAt &&
          acquisition.draft.window.submissionCutoffAt < acquisition.draft.window.executionOpenAt,
      ),
    ).toBe(true)
  })

  test('runs immediately, repeats on Schedule.spaced, and reacquires the same cycle on restart', async () => {
    const control: StoreControl = { acquisitions: [] }
    const store = cycleStore(control)
    const read = brokerRead(() => Effect.succeed({ value: monthEndCalendar, evidence }))
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:01:00.000Z'))
        const fiber = yield* provide(
          startAutonomousCycleLoop({
            candidate: Effect.succeed(candidate()),
            pollIntervalMs: 100,
          }),
          read,
          store,
        )
        yield* Effect.yieldNow
        expect(control.acquisitions).toHaveLength(1)
        yield* TestClock.adjust(99)
        expect(control.acquisitions).toHaveLength(1)
        yield* TestClock.adjust(1)
        expect(control.acquisitions).toHaveLength(2)
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    const restart = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-30T21:02:00.000Z'))
        return yield* provide(runAutonomousCyclePass(candidate()), read, store)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(restart.outcome).toBe('REACQUIRED')
    expect(new Set(control.acquisitions.map((acquisition) => acquisition.draft.identity.cycleId)).size).toBe(1)
  })

  test('publishes NOT_DUE broker-calendar evidence before the loop waits', async () => {
    const control: StoreControl = { acquisitions: [] }
    const observation = calendar([
      {
        date: '2026-01-30',
        openAt: '2026-01-30T14:30:00.000Z',
        closeAt: '2026-01-30T18:00:00.000Z',
      },
    ])
    const logs: Array<{ readonly message: unknown; readonly annotations: Record<string, unknown> }> = []
    const logger = Logger.make<unknown, void>((options) => {
      logs.push({
        message: options.message,
        annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
      })
    })
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse('2026-01-29T21:01:00.000Z'))
        const fiber = yield* provide(
          startAutonomousCycleLoop({
            candidate: Effect.succeed(candidate('2026-01-29')),
            pollIntervalMs: 100,
          }),
          brokerRead(() => Effect.succeed({ value: observation, evidence })),
          cycleStore(control),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(Effect.provide(Logger.layer([logger])), Effect.provide(TestClock.layer()))

    await Effect.runPromise(program)
    expect(control.acquisitions).toEqual([])
    expect(logs).toEqual([
      {
        message: ['Bayn autonomous cycle pass completed'],
        annotations: {
          outcome: 'NOT_DUE',
          signalSessionDate: '2026-01-29',
          executionSessionDate: '2026-01-30',
          observedAt: '2026-01-29T21:01:00.000Z',
          calendarResponseHash: observation.normalizedResponseHash,
          calendarReadContentHash: evidence.contentHash,
        },
      },
    ])
  })

  test('scope closure interrupts an in-flight calendar read', async () => {
    const started = await Effect.runPromise(Deferred.make<void>())
    let interrupted = false
    const read = brokerRead(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => void (interrupted = true))),
      ),
    )
    const control: StoreControl = { acquisitions: [] }

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* provide(
            startAutonomousCycleLoop({
              candidate: Effect.succeed(candidate()),
              pollIntervalMs: 100,
            }),
            read,
            cycleStore(control),
          )
          yield* Deferred.await(started)
        }),
      ),
    )
    expect(interrupted).toBe(true)
    expect(control.acquisitions).toEqual([])
  })

  test('maps candidate-source failures without touching the broker', async () => {
    const candidateFailure = new Error('Signal candidate unavailable')
    const control: StoreControl = { acquisitions: [] }
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* provide(
            startAutonomousCycleLoop({
              candidate: Effect.fail(candidateFailure),
              pollIntervalMs: 100,
            }),
            brokerRead(() => Effect.die(new Error('failed candidate must not read the broker'))),
            cycleStore(control),
          )
          return yield* Effect.flip(Fiber.join(fiber))
        }),
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'CycleRunnerError',
      operation: 'load-candidate',
      failure: 'candidate',
      cause: candidateFailure,
    })
    expect(control.acquisitions).toEqual([])
  })

  test('exposes a failed scoped fiber for scheduler health on defects', async () => {
    const read = brokerRead(() => Effect.die(new Error('injected broker defect')))
    const control: StoreControl = { acquisitions: [] }
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* provide(
            startAutonomousCycleLoop({
              candidate: Effect.succeed(candidate()),
              pollIntervalMs: 100,
            }),
            read,
            cycleStore(control),
          )
          return yield* Fiber.await(fiber)
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain('injected broker defect')
    expect(control.acquisitions).toEqual([])
  })

  test('rejects an invalid loop interval before forking or touching dependencies', async () => {
    const control: StoreControl = { acquisitions: [] }
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          provide(
            startAutonomousCycleLoop({
              candidate: Effect.succeed(candidate()),
              pollIntervalMs: 0,
            }),
            brokerRead(() => Effect.die(new Error('invalid config must not read the broker'))),
            cycleStore(control),
          ),
        ),
      ),
    )
    expect(failure).toMatchObject({
      _tag: 'CycleRunnerError',
      operation: 'configure',
      failure: 'invalid-config',
    })
    expect(control.acquisitions).toEqual([])
  })
})
