import { describe, expect, test } from 'bun:test'

import { Effect, Exit, Result, Schema } from 'effect'

import type { MarketCalendarObservation, MarketCalendarSession } from './broker/alpaca'
import {
  CycleState,
  CycleIdentitySchema,
  cycleDraftMatches,
  decodeCycleDraft,
  decodeCycleIdentity,
  decodeCycleWindow,
  decodeExecutionCalendarObservation,
  isCycleStateTransitionAllowed,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  signalSessionCloseAt,
  type CycleConstructionFailure,
  type CycleExecutionPolicy,
  type CycleIdentityMaterial,
  type ExecutionCalendarObservation,
} from './cycle'
import { defaultExecutionModel } from './execution-model'
import { canonicalHashV1 } from './hash'
import type { SignalSessionRow } from './market-data'
import { strictParseOptions } from './schemas'
import type { IsoDate } from './types'

const signalCalendarVersion = 'signal-XNYS-2026-v1'
const qualificationRunId = 'a'.repeat(64)
const strategyProtocolHash = 'b'.repeat(64)
const strategyExecutionModelHash = 'c'.repeat(64)
const defaultSubmissionWindowMs = 30 * 60 * 1_000
const defaultSubmissionCutoffBeforeOpenMs = 2 * 60 * 1_000
const springDstSession: MarketCalendarSession = {
  date: '2026-03-09',
  openAt: '2026-03-09T13:30:00.000Z',
  closeAt: '2026-03-09T20:00:00.000Z',
}

const resultValue = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure
  return result.success
}
const makeCycleDraftSuccess = (...args: Parameters<typeof makeCycleDraft>) => resultValue(makeCycleDraft(...args))
const makeCycleExecutionPolicySuccess = (...args: Parameters<typeof makeCycleExecutionPolicy>) =>
  resultValue(makeCycleExecutionPolicy(...args))
const makeCycleExecutionPolicyFromModelSuccess = (...args: Parameters<typeof makeCycleExecutionPolicyFromModel>) =>
  resultValue(makeCycleExecutionPolicyFromModel(...args))
const makeCycleIdentitySuccess = (...args: Parameters<typeof makeCycleIdentity>) =>
  resultValue(makeCycleIdentity(...args))
const makeCycleWindowSuccess = (...args: Parameters<typeof makeCycleWindow>) => resultValue(makeCycleWindow(...args))
const makeExecutionCalendarObservationSuccess = (...args: Parameters<typeof makeExecutionCalendarObservation>) =>
  resultValue(makeExecutionCalendarObservation(...args))

const signalSession = (
  sessionDate: IsoDate,
  closeTime = '16:00',
  calendarVersion = signalCalendarVersion,
): Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'> => ({
  calendar_version: calendarVersion,
  session_date: sessionDate,
  close_time: closeTime,
  timezone: 'America/New_York',
})

const executionCalendar = (session: MarketCalendarSession = springDstSession): ExecutionCalendarObservation =>
  makeExecutionCalendarObservationSuccess({
    schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
    source: 'alpaca-v2-calendar',
    ...session,
  })

const brokerCalendarObservation = (
  requestedRange: MarketCalendarObservation['requestedRange'],
  sessions: readonly MarketCalendarSession[],
  normalizedResponseHash: string,
): MarketCalendarObservation => ({
  schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
  source: 'alpaca-v2-calendar',
  requestedRange,
  timeZone: 'UTC',
  sessions,
  normalizedResponseHash,
})

const makeExecutionPolicy = (
  submissionWindowMs = defaultSubmissionWindowMs,
  submissionCutoffBeforeOpenMs = defaultSubmissionCutoffBeforeOpenMs,
  modelHash = strategyExecutionModelHash,
): CycleExecutionPolicy =>
  makeCycleExecutionPolicySuccess({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash: modelHash,
    submissionWindowMs,
    submissionCutoffBeforeOpenMs,
  })

const makeIdentityMaterial = (
  signalSessionDate: IsoDate,
  observedExecutionCalendar = executionCalendar(),
  executionPolicy = makeExecutionPolicy(),
): CycleIdentityMaterial => ({
  schemaVersion: 'bayn.autonomous-cycle-identity.v1',
  strategyName: 'risk-balanced-trend',
  qualificationRunId,
  strategyProtocolHash,
  accountId: 'paper-account-1',
  signalSessionDate,
  signalCalendarVersion,
  executionSessionDate: observedExecutionCalendar.executionSessionDate,
  executionCalendarSchemaVersion: observedExecutionCalendar.executionCalendarSchemaVersion,
  executionCalendarSource: observedExecutionCalendar.executionCalendarSource,
  executionCalendarHash: observedExecutionCalendar.executionCalendarHash,
  executionPolicy,
})

describe('autonomous cycle identity and calendar', () => {
  test('derives the one source-controlled runner policy from the loaded v2 execution model', () => {
    if (defaultExecutionModel.schemaVersion !== 'bayn.execution-model.v2') {
      throw new Error('default execution model must be the causal v2 contract')
    }
    const policy = makeCycleExecutionPolicyFromModelSuccess(defaultExecutionModel)

    expect(policy).toMatchObject({
      schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
      strategyExecutionModelHash: canonicalHashV1(defaultExecutionModel),
      submissionWindowMs: 30 * 60_000,
      submissionCutoffBeforeOpenMs: defaultExecutionModel.order.submissionCutoffLeadMinutes * 60_000,
    })
    expect(policy.executionPolicyHash).toBe(
      canonicalHashV1({
        schemaVersion: policy.schemaVersion,
        strategyExecutionModelHash: policy.strategyExecutionModelHash,
        submissionWindowMs: policy.submissionWindowMs,
        submissionCutoffBeforeOpenMs: policy.submissionCutoffBeforeOpenMs,
      }),
    )
  })

  test('derives stable identities from all Signal, execution-calendar, account, and policy inputs', () => {
    const material = makeIdentityMaterial('2026-03-06')
    const first = makeCycleIdentitySuccess(material)
    const replay = makeCycleIdentitySuccess(structuredClone(material))
    const otherAccount = makeCycleIdentitySuccess({ ...material, accountId: 'paper-account-2' })
    const otherModel = makeCycleIdentitySuccess({
      ...material,
      executionPolicy: makeExecutionPolicy(
        defaultSubmissionWindowMs,
        defaultSubmissionCutoffBeforeOpenMs,
        'd'.repeat(64),
      ),
    })
    const changedExecutionCalendar = executionCalendar({
      ...springDstSession,
      closeAt: '2026-03-09T17:00:00.000Z',
    })
    const otherExecutionCalendar = makeCycleIdentitySuccess(
      makeIdentityMaterial('2026-03-06', changedExecutionCalendar),
    )

    expect(replay).toEqual(first)
    expect(first.cycleId).toBe('0abeb0fa91334072af88e44f66e88974c33c3b5261adb327c26719bd9110e0d9')
    expect(otherAccount.cycleId).not.toBe(first.cycleId)
    expect(otherModel.cycleId).not.toBe(first.cycleId)
    expect(otherModel.executionPolicy.executionPolicyHash).not.toBe(first.executionPolicy.executionPolicyHash)
    expect(otherExecutionCalendar.cycleId).not.toBe(first.cycleId)
  })

  test('rejects ill-formed Unicode at the cycle identity field before canonical hashing', () => {
    const material = makeIdentityMaterial('2026-03-06')
    const constructed = makeCycleIdentity({ ...material, accountId: '\ud800' })
    expect(Result.isFailure(constructed)).toBe(true)
    if (Result.isFailure(constructed)) {
      expect(constructed.failure).toMatchObject({
        _tag: 'CycleConstructionFailure',
        operation: 'cycle-identity',
        reason: 'decode',
      })
      expect(String(constructed.failure.cause)).toContain('["accountId"]')
      expect(String(constructed.failure.cause)).toContain('well-formed Unicode')
    }

    const identity = makeCycleIdentitySuccess(material)
    const decoded = Schema.decodeUnknownResult(
      CycleIdentitySchema,
      strictParseOptions,
    )({
      ...identity,
      accountId: '\ud800',
    })
    expect(Result.isFailure(decoded)).toBe(true)
    if (Result.isFailure(decoded)) {
      expect(String(decoded.failure)).toContain('["accountId"]')
      expect(String(decoded.failure)).toContain('well-formed Unicode')
    }
  })

  test('binds only the selected #13136 session across different response ranges and evidence hashes', () => {
    const narrowResponse = brokerCalendarObservation(
      { start: '2026-03-09', end: '2026-03-09' },
      [springDstSession],
      '1'.repeat(64),
    )
    const broadResponse = brokerCalendarObservation(
      { start: '2026-03-06', end: '2026-03-10' },
      [
        {
          date: '2026-03-06',
          openAt: '2026-03-06T14:30:00.000Z',
          closeAt: '2026-03-06T21:00:00.000Z',
        },
        springDstSession,
        {
          date: '2026-03-10',
          openAt: '2026-03-10T13:30:00.000Z',
          closeAt: '2026-03-10T20:00:00.000Z',
        },
      ],
      '2'.repeat(64),
    )
    const narrowSelected = makeExecutionCalendarObservationSuccess({
      schemaVersion: narrowResponse.schemaVersion,
      source: narrowResponse.source,
      ...narrowResponse.sessions[0]!,
    })
    const broadSelected = makeExecutionCalendarObservationSuccess({
      schemaVersion: broadResponse.schemaVersion,
      source: broadResponse.source,
      ...broadResponse.sessions.find((session) => session.date === springDstSession.date)!,
    })

    expect(narrowResponse.normalizedResponseHash).not.toBe(broadResponse.normalizedResponseHash)
    expect(narrowSelected).toEqual(broadSelected)
    expect(makeCycleIdentitySuccess(makeIdentityMaterial('2026-03-06', narrowSelected)).cycleId).toBe(
      makeCycleIdentitySuccess(makeIdentityMaterial('2026-03-06', broadSelected)).cycleId,
    )
  })

  test('binds a decoded future broker-calendar observation across the spring DST boundary', () => {
    const observedExecutionCalendar = executionCalendar()
    const window = makeCycleWindowSuccess(signalSession('2026-03-06'), observedExecutionCalendar, makeExecutionPolicy())

    expect(window).toEqual({
      schemaVersion: 'bayn.autonomous-cycle-window.v1',
      signalCalendarVersion,
      signalSessionDate: '2026-03-06',
      ...observedExecutionCalendar,
      signalCloseAt: '2026-03-06T21:00:00.000Z',
      publicationDeadlineAt: '2026-03-09T12:58:00.000Z',
      submissionOpenAt: '2026-03-09T12:58:00.000Z',
      submissionCutoffAt: '2026-03-09T13:28:00.000Z',
    })
    expect(window.executionOpenAt).toBe('2026-03-09T13:30:00.000Z')
    expect(window.executionCloseAt).toBe('2026-03-09T20:00:00.000Z')
  })

  test('accepts observed holiday gaps and early closes without deriving the next session from Signal rows', () => {
    const holidayWindow = makeCycleWindowSuccess(
      signalSession('2026-07-02'),
      executionCalendar({
        date: '2026-07-06',
        openAt: '2026-07-06T13:30:00.000Z',
        closeAt: '2026-07-06T20:00:00.000Z',
      }),
      makeExecutionPolicy(),
    )
    expect(holidayWindow.executionSessionDate).toBe('2026-07-06')
    expect(holidayWindow.executionOpenAt).toBe('2026-07-06T13:30:00.000Z')

    const earlyCloseWindow = makeCycleWindowSuccess(
      signalSession('2026-11-25'),
      executionCalendar({
        date: '2026-11-27',
        openAt: '2026-11-27T14:30:00.000Z',
        closeAt: '2026-11-27T18:00:00.000Z',
      }),
      makeExecutionPolicy(18 * 60 * 60 * 1_000),
    )
    expect(earlyCloseWindow).toMatchObject({
      submissionOpenAt: '2026-11-26T20:28:00.000Z',
      submissionCutoffAt: '2026-11-27T14:28:00.000Z',
      executionOpenAt: '2026-11-27T14:30:00.000Z',
      executionCloseAt: '2026-11-27T18:00:00.000Z',
    })

    expect(() =>
      makeCycleWindowSuccess(
        signalSession('2026-03-09'),
        executionCalendar({
          date: '2026-03-10',
          openAt: '2026-03-10T13:30:00.000Z',
          closeAt: '2026-03-10T20:00:00.000Z',
        }),
        makeExecutionPolicy(18 * 60 * 60 * 1_000),
      ),
    ).toThrow('submission window must begin after the Signal session close')
  })

  test('enforces the one-day duration cap in the pure window factory', () => {
    const excessiveWindow = makeCycleWindow(signalSession('2026-03-06'), executionCalendar(), {
      submissionWindowMs: 86_400_001,
      submissionCutoffBeforeOpenMs: defaultSubmissionCutoffBeforeOpenMs,
    })
    const excessiveLead = makeCycleWindow(signalSession('2026-03-06'), executionCalendar(), {
      submissionWindowMs: defaultSubmissionWindowMs,
      submissionCutoffBeforeOpenMs: 86_400_001,
    })
    expect(Result.isFailure(excessiveWindow)).toBe(true)
    expect(Result.isFailure(excessiveWindow) ? excessiveWindow.failure : null).toMatchObject({
      _tag: 'CycleConstructionFailure',
      operation: 'cycle-window',
      reason: 'duration',
      message: 'submission window must be between one millisecond and one day',
    })
    expect(Result.isFailure(excessiveLead)).toBe(true)
    expect(Result.isFailure(excessiveLead) ? excessiveLead.failure : null).toMatchObject({
      _tag: 'CycleConstructionFailure',
      operation: 'cycle-window',
      reason: 'duration',
      message: 'broker cutoff lead must be between one millisecond and one day',
    })
  })

  test('rejects forged execution observations, UTC drift, and identity provenance mismatches', async () => {
    const observedExecutionCalendar = executionCalendar()
    const executionPolicy = makeExecutionPolicy()
    const material = makeIdentityMaterial('2026-03-06', observedExecutionCalendar, executionPolicy)
    const identity = makeCycleIdentitySuccess(material)
    const window = makeCycleWindowSuccess(signalSession('2026-03-06'), observedExecutionCalendar, executionPolicy)

    const forgedObservation = await Effect.runPromiseExit(
      decodeExecutionCalendarObservation({
        ...observedExecutionCalendar,
        executionCalendarHash: 'f'.repeat(64),
      }),
    )
    expect(Exit.isFailure(forgedObservation)).toBe(true)

    const driftedUtcWindow = await Effect.runPromiseExit(
      decodeCycleWindow({ ...window, executionOpenAt: '2026-03-09T13:31:00.000Z' }),
    )
    expect(Exit.isFailure(driftedUtcWindow)).toBe(true)

    const forgedHash = 'f'.repeat(64)
    const forgedDraft = await Effect.runPromiseExit(
      decodeCycleDraft({
        schemaVersion: 'bayn.autonomous-cycle.v1',
        identity: makeCycleIdentitySuccess({ ...material, executionCalendarHash: forgedHash }),
        window: { ...window, executionCalendarHash: forgedHash },
      }),
    )
    expect(Exit.isFailure(forgedDraft)).toBe(true)

    const forgedIdentity = await Effect.runPromiseExit(decodeCycleIdentity({ ...identity, cycleId: 'f'.repeat(64) }))
    expect(Exit.isFailure(forgedIdentity)).toBe(true)

    const otherSignalCalendarWindow = makeCycleWindowSuccess(
      signalSession('2026-03-06', '16:00', 'signal-XNYS-2026-other'),
      observedExecutionCalendar,
      executionPolicy,
    )
    expect(() => makeCycleDraftSuccess(identity, otherSignalCalendarWindow)).toThrow(
      'cycle identity and window bindings are incoherent',
    )

    const otherExecutionCalendarWindow = makeCycleWindowSuccess(
      signalSession('2026-03-06'),
      executionCalendar({
        ...springDstSession,
        closeAt: '2026-03-09T19:59:00.000Z',
      }),
      executionPolicy,
    )
    expect(() => makeCycleDraftSuccess(identity, otherExecutionCalendarWindow)).toThrow(
      'cycle identity and window bindings are incoherent',
    )

    expect(() =>
      makeCycleDraftSuccess(
        makeCycleIdentitySuccess(
          makeIdentityMaterial('2026-03-06', observedExecutionCalendar, makeExecutionPolicy(15 * 60 * 1_000)),
        ),
        window,
      ),
    ).toThrow('cycle identity and window bindings are incoherent')
    expect(() =>
      makeCycleDraftSuccess(
        makeCycleIdentitySuccess(
          makeIdentityMaterial(
            '2026-03-06',
            observedExecutionCalendar,
            makeExecutionPolicy(defaultSubmissionWindowMs, 3 * 60 * 1_000),
          ),
        ),
        window,
      ),
    ).toThrow('cycle identity and window bindings are incoherent')

    expect(isCycleStateTransitionAllowed(CycleState.Pending, CycleState.Active)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Active, CycleState.Blocked)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Active, CycleState.NoTrade)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Active, CycleState.Completed)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Blocked, CycleState.Blocked)).toBe(false)
  })

  test('treats non-canonicalizable typed draft material as a non-match without throwing', () => {
    const observedExecutionCalendar = executionCalendar()
    const executionPolicy = makeExecutionPolicy()
    const identity = makeCycleIdentitySuccess(
      makeIdentityMaterial('2026-03-06', observedExecutionCalendar, executionPolicy),
    )
    const window = makeCycleWindowSuccess(signalSession('2026-03-06'), observedExecutionCalendar, executionPolicy)
    const valid = makeCycleDraftSuccess(identity, window)
    const cyclic = Object.assign({ ...valid }, { self: undefined as unknown })
    cyclic.self = cyclic

    expect(cycleDraftMatches(valid, cyclic)).toBe(false)
  })

  test('returns closed tagged failures for every reachable constructor invariant', () => {
    const observedExecutionCalendar = executionCalendar()
    const executionPolicy = makeExecutionPolicy()
    const identity = makeCycleIdentitySuccess(
      makeIdentityMaterial('2026-03-06', observedExecutionCalendar, executionPolicy),
    )
    const window = makeCycleWindowSuccess(signalSession('2026-03-06'), observedExecutionCalendar, executionPolicy)
    const otherSignalWindow = makeCycleWindowSuccess(
      signalSession('2026-03-06', '16:00', 'signal-calendar-other'),
      observedExecutionCalendar,
      executionPolicy,
    )
    const sameDayCalendar = executionCalendar({
      date: '2026-03-06',
      openAt: '2026-03-06T14:30:00.000Z',
      closeAt: '2026-03-06T21:00:00.000Z',
    })
    const cases: ReadonlyArray<readonly [string, string, Result.Result<unknown, CycleConstructionFailure>]> = [
      ['signal-close', 'decode', signalSessionCloseAt({})],
      ['signal-close', 'market-time', signalSessionCloseAt(signalSession('2026-03-08', '02:30'))],
      ['execution-policy', 'decode', makeCycleExecutionPolicy({})],
      ['execution-policy', 'decode', makeCycleExecutionPolicyFromModel({})],
      ['execution-calendar', 'decode', makeExecutionCalendarObservation({})],
      ['cycle-identity', 'decode', makeCycleIdentity({})],
      [
        'cycle-identity',
        'session-order',
        makeCycleIdentity(makeIdentityMaterial('2026-03-06', sameDayCalendar, executionPolicy)),
      ],
      ['cycle-window', 'decode', makeCycleWindow({}, observedExecutionCalendar, executionPolicy)],
      [
        'cycle-window',
        'session-order',
        makeCycleWindow(signalSession('2026-03-09'), observedExecutionCalendar, executionPolicy),
      ],
      [
        'cycle-window',
        'market-time',
        makeCycleWindow(signalSession('2026-03-08', '02:30'), observedExecutionCalendar, executionPolicy),
      ],
      [
        'cycle-window',
        'submission-window',
        makeCycleWindow(
          signalSession('2026-03-09'),
          executionCalendar({
            date: '2026-03-10',
            openAt: '2026-03-10T13:30:00.000Z',
            closeAt: '2026-03-10T20:00:00.000Z',
          }),
          makeExecutionPolicy(18 * 60 * 60 * 1_000),
        ),
      ],
      ['cycle-draft', 'decode', makeCycleDraft({}, window)],
      ['cycle-draft', 'decode', makeCycleDraft(identity, {})],
      ['cycle-draft', 'binding', makeCycleDraft(identity, otherSignalWindow)],
    ] as const

    for (const [operation, reason, result] of cases) {
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: 'CycleConstructionFailure',
          operation,
          reason,
        })
      }
    }
  })
})
