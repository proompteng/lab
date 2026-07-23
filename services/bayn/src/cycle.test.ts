import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import type { MarketCalendarObservation, MarketCalendarSession } from './broker/alpaca'
import {
  CycleState,
  CycleTerminalReason,
  cycleTerminalReasonForTargetPlanBlock,
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
  type CycleExecutionPolicy,
  type CycleIdentityMaterial,
  type ExecutionCalendarObservation,
} from './cycle'
import { defaultExecutionModel } from './execution-model'
import { canonicalHashV1 } from './hash'
import type { SignalSessionRow } from './market-data'
import { TargetPlanReason } from './target-planner'
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
  makeExecutionCalendarObservation({
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
  makeCycleExecutionPolicy({
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
    const policy = makeCycleExecutionPolicyFromModel(defaultExecutionModel)

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

  test('maps every blocked target-plan reason to its exact cycle terminal reason', () => {
    expect([
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.SubmissionCutoffReached),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.IdentityMismatch),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.InputMismatch),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.InputStale),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.ReconciliationNotExact),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.AccountNotActive),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.UnknownOrder),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.UnresolvedOrder),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.BelowMinimumBuyNotional),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.InsufficientBuyingPower),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.NonPositiveEquity),
      cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.ShortPositionNotAllowed),
    ]).toEqual([
      CycleTerminalReason.MissedSubmission,
      CycleTerminalReason.ProvenanceMismatch,
      CycleTerminalReason.DataInvalid,
      CycleTerminalReason.DataStale,
      CycleTerminalReason.Reconciliation,
      CycleTerminalReason.BrokerDisabled,
      CycleTerminalReason.UnresolvedMutation,
      CycleTerminalReason.UnresolvedMutation,
      CycleTerminalReason.Risk,
      CycleTerminalReason.Risk,
      CycleTerminalReason.Risk,
      CycleTerminalReason.Risk,
    ])
    expect(() => cycleTerminalReasonForTargetPlanBlock(TargetPlanReason.TargetsSatisfied)).toThrow(
      'blocked target plan cannot use the no-trade reason',
    )
  })

  test('derives stable identities from all Signal, execution-calendar, account, and policy inputs', () => {
    const material = makeIdentityMaterial('2026-03-06')
    const first = makeCycleIdentity(material)
    const replay = makeCycleIdentity(structuredClone(material))
    const otherAccount = makeCycleIdentity({ ...material, accountId: 'paper-account-2' })
    const otherModel = makeCycleIdentity({
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
    const otherExecutionCalendar = makeCycleIdentity(makeIdentityMaterial('2026-03-06', changedExecutionCalendar))

    expect(replay).toEqual(first)
    expect(otherAccount.cycleId).not.toBe(first.cycleId)
    expect(otherModel.cycleId).not.toBe(first.cycleId)
    expect(otherModel.executionPolicy.executionPolicyHash).not.toBe(first.executionPolicy.executionPolicyHash)
    expect(otherExecutionCalendar.cycleId).not.toBe(first.cycleId)
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
    const narrowSelected = makeExecutionCalendarObservation({
      schemaVersion: narrowResponse.schemaVersion,
      source: narrowResponse.source,
      ...narrowResponse.sessions[0]!,
    })
    const broadSelected = makeExecutionCalendarObservation({
      schemaVersion: broadResponse.schemaVersion,
      source: broadResponse.source,
      ...broadResponse.sessions.find((session) => session.date === springDstSession.date)!,
    })

    expect(narrowResponse.normalizedResponseHash).not.toBe(broadResponse.normalizedResponseHash)
    expect(narrowSelected).toEqual(broadSelected)
    expect(makeCycleIdentity(makeIdentityMaterial('2026-03-06', narrowSelected)).cycleId).toBe(
      makeCycleIdentity(makeIdentityMaterial('2026-03-06', broadSelected)).cycleId,
    )
  })

  test('binds a decoded future broker-calendar observation across the spring DST boundary', () => {
    const observedExecutionCalendar = executionCalendar()
    const window = makeCycleWindow(signalSession('2026-03-06'), observedExecutionCalendar, makeExecutionPolicy())

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
    const holidayWindow = makeCycleWindow(
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

    const earlyCloseWindow = makeCycleWindow(
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
      makeCycleWindow(
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
    expect(() =>
      makeCycleWindow(signalSession('2026-03-06'), executionCalendar(), makeExecutionPolicy(86_400_001)),
    ).toThrow('submission window must be between one millisecond and one day')
    expect(() =>
      makeCycleWindow(
        signalSession('2026-03-06'),
        executionCalendar(),
        makeExecutionPolicy(defaultSubmissionWindowMs, 86_400_001),
      ),
    ).toThrow('broker cutoff lead must be between one millisecond and one day')
  })

  test('rejects forged execution observations, UTC drift, and identity provenance mismatches', async () => {
    const observedExecutionCalendar = executionCalendar()
    const executionPolicy = makeExecutionPolicy()
    const material = makeIdentityMaterial('2026-03-06', observedExecutionCalendar, executionPolicy)
    const identity = makeCycleIdentity(material)
    const window = makeCycleWindow(signalSession('2026-03-06'), observedExecutionCalendar, executionPolicy)

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
        identity: makeCycleIdentity({ ...material, executionCalendarHash: forgedHash }),
        window: { ...window, executionCalendarHash: forgedHash },
      }),
    )
    expect(Exit.isFailure(forgedDraft)).toBe(true)

    const forgedIdentity = await Effect.runPromiseExit(decodeCycleIdentity({ ...identity, cycleId: 'f'.repeat(64) }))
    expect(Exit.isFailure(forgedIdentity)).toBe(true)

    const otherSignalCalendarWindow = makeCycleWindow(
      signalSession('2026-03-06', '16:00', 'signal-XNYS-2026-other'),
      observedExecutionCalendar,
      executionPolicy,
    )
    expect(() => makeCycleDraft(identity, otherSignalCalendarWindow)).toThrow(
      'cycle identity and window must bind the same Signal calendar',
    )

    const otherExecutionCalendarWindow = makeCycleWindow(
      signalSession('2026-03-06'),
      executionCalendar({
        ...springDstSession,
        closeAt: '2026-03-09T19:59:00.000Z',
      }),
      executionPolicy,
    )
    expect(() => makeCycleDraft(identity, otherExecutionCalendarWindow)).toThrow(
      'cycle identity and window must bind the same execution calendar observation',
    )

    expect(() =>
      makeCycleDraft(
        makeCycleIdentity(
          makeIdentityMaterial('2026-03-06', observedExecutionCalendar, makeExecutionPolicy(15 * 60 * 1_000)),
        ),
        window,
      ),
    ).toThrow('cycle window must match the bound execution policy')
    expect(() =>
      makeCycleDraft(
        makeCycleIdentity(
          makeIdentityMaterial(
            '2026-03-06',
            observedExecutionCalendar,
            makeExecutionPolicy(defaultSubmissionWindowMs, 3 * 60 * 1_000),
          ),
        ),
        window,
      ),
    ).toThrow('cycle broker cutoff must match the bound execution policy')

    expect(isCycleStateTransitionAllowed(CycleState.Pending, CycleState.Active)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Active, CycleState.Blocked)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Active, CycleState.NoTrade)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Active, CycleState.Completed)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Blocked, CycleState.Blocked)).toBe(false)
  })
})
