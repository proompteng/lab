import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import {
  CycleState,
  decodeCycleIdentity,
  isCycleStateTransitionAllowed,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  type CycleIdentityMaterial,
} from './cycle'
import type { SignalSessionRow } from './market-data'
import type { IsoDate } from './types'

const calendarVersion = 'XNYS-2026-v1'
const qualificationRunId = 'a'.repeat(64)
const strategyProtocolHash = 'b'.repeat(64)
const strategyExecutionModelHash = 'c'.repeat(64)

const session = (
  sessionDate: IsoDate,
  openTime = '09:30',
  closeTime = '16:00',
): Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'open_time' | 'close_time' | 'timezone'> => ({
  calendar_version: calendarVersion,
  session_date: sessionDate,
  open_time: openTime,
  close_time: closeTime,
  timezone: 'America/New_York',
})

const makeIdentityMaterial = (
  signalSessionDate: IsoDate,
  submissionWindowMs = 30 * 60 * 1_000,
): CycleIdentityMaterial => ({
  schemaVersion: 'bayn.autonomous-cycle-identity.v1',
  strategyName: 'risk-balanced-trend',
  qualificationRunId,
  strategyProtocolHash,
  accountId: 'paper-account-1',
  signalSessionDate,
  calendarVersion,
  executionPolicy: makeCycleExecutionPolicy({
    schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
    strategyExecutionModelHash,
    submissionWindowMs,
  }),
})

describe('autonomous cycle identity and calendar', () => {
  test('derives stable identities from every execution-critical input', () => {
    const material = makeIdentityMaterial('2026-03-06')
    const first = makeCycleIdentity(material)
    const replay = makeCycleIdentity(structuredClone(material))
    const otherAccount = makeCycleIdentity({ ...material, accountId: 'paper-account-2' })
    const otherModel = makeCycleIdentity({
      ...material,
      executionPolicy: makeCycleExecutionPolicy({
        ...material.executionPolicy,
        strategyExecutionModelHash: 'd'.repeat(64),
      }),
    })

    expect(replay).toEqual(first)
    expect(otherAccount.cycleId).not.toBe(first.cycleId)
    expect(otherModel.cycleId).not.toBe(first.cycleId)
    expect(otherModel.executionPolicy.executionPolicyHash).not.toBe(first.executionPolicy.executionPolicyHash)
  })

  test('uses the next verified session across the spring DST boundary', () => {
    const window = makeCycleWindow([session('2026-03-06'), session('2026-03-09')], '2026-03-06', 30 * 60 * 1_000)

    expect(window).toEqual({
      schemaVersion: 'bayn.autonomous-cycle-window.v1',
      signalSessionDate: '2026-03-06',
      executionSessionDate: '2026-03-09',
      signalCloseAt: '2026-03-06T21:00:00.000Z',
      publicationDeadlineAt: '2026-03-09T13:30:00.000Z',
      executionOpenAt: '2026-03-09T13:30:00.000Z',
      executionCloseAt: '2026-03-09T20:00:00.000Z',
      submissionCutoffAt: '2026-03-09T14:00:00.000Z',
    })
  })

  test('skips absent holidays and respects early closes from the verified calendar', () => {
    const holidayWindow = makeCycleWindow([session('2026-07-02'), session('2026-07-06')], '2026-07-02', 30 * 60 * 1_000)
    expect(holidayWindow.executionSessionDate).toBe('2026-07-06')
    expect(holidayWindow.executionOpenAt).toBe('2026-07-06T13:30:00.000Z')

    expect(() =>
      makeCycleWindow(
        [session('2026-11-25'), session('2026-11-27', '09:30', '13:00')],
        '2026-11-25',
        4 * 60 * 60 * 1_000,
      ),
    ).toThrow('submission window extends beyond the execution session close')
  })

  test('rejects forged identities, policy/window drift, and illegal terminal rewrites', async () => {
    const material = makeIdentityMaterial('2026-03-06')
    const identity = makeCycleIdentity(material)
    const window = makeCycleWindow([session('2026-03-06'), session('2026-03-09')], '2026-03-06', 30 * 60 * 1_000)

    const forgedIdentity = await Effect.runPromiseExit(decodeCycleIdentity({ ...identity, cycleId: 'f'.repeat(64) }))
    expect(Exit.isFailure(forgedIdentity)).toBe(true)
    expect(() =>
      makeCycleDraft(makeCycleIdentity(makeIdentityMaterial('2026-03-06', 15 * 60 * 1_000)), window),
    ).toThrow('cycle window must match the bound execution policy')

    expect(isCycleStateTransitionAllowed(CycleState.Pending, CycleState.Active)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Active, CycleState.NoTrade)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Completed, CycleState.Active)).toBe(false)
    expect(isCycleStateTransitionAllowed(CycleState.Blocked, CycleState.Blocked)).toBe(false)
  })
})
