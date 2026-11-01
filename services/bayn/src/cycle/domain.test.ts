import { strictParseOptions } from '../schemas'
import { describe, expect, test } from 'bun:test'
import { Effect, Exit, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { defaultJevProtocolDocument } from '../jev/protocol'
import {
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleExecutionPolicyFromModel,
  makeCycleIdentity,
  makeExecutionCalendarObservation,
  makeIntradayCycleWindow,
} from './construction'
import { CycleState, decodeCycleDraft, type CycleDraft, CycleIdentitySchema, CycleWindowSchema } from './model'
import { cycleDraftMatches, isCycleStateTransitionAllowed } from './transitions'

const value = Result.getOrThrow
const calendar = (closeAt = '2026-03-09T20:00:00.000Z') =>
  value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v2',
      source: 'alpaca-v2-calendar',
      date: '2026-03-09',
      openAt: '2026-03-09T13:30:00.000Z',
      closeAt,
    }),
  )
const policy = () => value(makeCycleExecutionPolicyFromModel(defaultJevProtocolDocument.executionModel))
const material = () => {
  const observation = calendar()
  return {
    schemaVersion: 'bayn.autonomous-cycle-identity.v4' as const,
    strategyName: 'jev' as const,
    qualificationRunId: 'a'.repeat(64),
    strategyProtocolHash: 'b'.repeat(64),
    accountId: 'cycle-test',
    entryAttemptOrdinal: 1,
    executionSessionDate: observation.executionSessionDate,
    executionCalendarSchemaVersion: observation.executionCalendarSchemaVersion,
    executionCalendarSource: observation.executionCalendarSource,
    executionCalendarHash: observation.executionCalendarHash,
    executionPolicy: policy(),
  }
}
const draft = () =>
  value(makeCycleDraft(value(makeCycleIdentity(material())), value(makeIntradayCycleWindow(calendar(), policy()))))

describe('current Jev cycle contracts', () => {
  test('preserves the source-controlled execution policy identity', () => {
    expect(policy()).toEqual({
      schemaVersion: 'bayn.autonomous-cycle-execution-policy.v3',
      strategyExecutionModelHash: '7271c89c52ade40bfc7a94cf966216a12776cf4e392d9d480e9dd92221106f31',
      warmupAfterOpenMs: 0,
      submissionCutoffBeforeCloseMs: 300000,
      executionPolicyHash: 'bd3ec06f0a8d55a05c48844050fac614afdc7b0a4964ae2a9b84306fbc5d7e36',
    })
  })

  test('derives regular and shortened windows from the selected broker calendar', () => {
    expect(value(makeIntradayCycleWindow(calendar(), policy()))).toMatchObject({
      submissionOpenAt: '2026-03-09T13:30:00.000Z',
      submissionCutoffAt: '2026-03-09T19:55:00.000Z',
    })
    expect(value(makeIntradayCycleWindow(calendar('2026-03-09T17:00:00.000Z'), policy()))).toMatchObject({
      submissionOpenAt: '2026-03-09T13:30:00.000Z',
      submissionCutoffAt: '2026-03-09T16:55:00.000Z',
    })
    expect(
      value(makeIntradayCycleWindow(calendar(), { warmupAfterOpenMs: 0, submissionCutoffBeforeCloseMs: 0 })),
    ).toMatchObject({
      submissionCutoffAt: '2026-03-09T20:00:00.000Z',
    })
  })

  test('binds account, attempt, calendar and policy into immutable cycle identity', () => {
    const input = material()
    const identity = value(makeCycleIdentity(input))
    expect(identity.cycleId).toBe(Result.getOrThrow(canonicalHashV1Result(input)))
    expect(value(makeCycleIdentity(structuredClone(input)))).toEqual(identity)
    for (const change of [
      { accountId: 'other-account' },
      { entryAttemptOrdinal: 2 },
      { qualificationRunId: 'c'.repeat(64) },
    ])
      expect(value(makeCycleIdentity({ ...input, ...change })).cycleId).not.toBe(identity.cycleId)
    expect(cycleDraftMatches(draft(), structuredClone(draft()))).toBe(true)
    expect(
      cycleDraftMatches(draft(), { ...draft(), identity: { ...identity, accountId: '\ud800' } } as CycleDraft),
    ).toBe(false)
  })

  test('rejects retired strategies and pre-reentry cycle identities before execution', () => {
    const input = material()
    for (const strategyName of ['risk-balanced-trend', 'opening-drive-momentum', 'intraday-momentum'])
      expect(Result.isFailure(makeCycleIdentity({ ...input, strategyName }))).toBe(true)
    const { entryAttemptOrdinal: _attempt, ...oldMaterial } = input
    expect(
      Result.isFailure(
        makeCycleIdentity({
          ...oldMaterial,
          schemaVersion: 'bayn.autonomous-cycle-identity.v3',
          strategyName: 'intraday-momentum',
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        makeCycleExecutionPolicy({
          schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
          strategyExecutionModelHash: 'a'.repeat(64),
          submissionWindowMs: 1800000,
          submissionCutoffBeforeOpenMs: 120000,
        }),
      ),
    ).toBe(true)
    expect(Result.isFailure(makeCycleIdentity({ ...input, accountId: '\ud800' }))).toBe(true)
  })

  test.each([Number.NaN, Infinity, -1, 86400001])('rejects invalid session offsets %s', (warmupAfterOpenMs) => {
    expect(
      Result.isFailure(makeIntradayCycleWindow(calendar(), { warmupAfterOpenMs, submissionCutoffBeforeCloseMs: 0 })),
    ).toBe(true)
  })

  test('rejects a window whose calendar or submission bounds diverge from its identity', async () => {
    const input = draft()
    for (const window of [
      { ...input.window, executionCalendarHash: 'd'.repeat(64) },
      { ...input.window, submissionOpenAt: '2026-03-09T13:29:59.000Z' },
      { ...input.window, submissionCutoffAt: '2026-03-09T20:00:00.000Z' },
    ]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(decodeCycleDraft({ ...input, window })))).toBe(true)
    }
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          Schema.decodeUnknownEffect(
            CycleIdentitySchema,
            strictParseOptions,
          )({ ...input.identity, cycleId: 'e'.repeat(64) }),
        ),
      ),
    ).toBe(true)
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          Schema.decodeUnknownEffect(
            CycleWindowSchema,
            strictParseOptions,
          )({ ...input.window, executionCalendarHash: 'e'.repeat(64) }),
        ),
      ),
    ).toBe(true)
  })

  test('terminal cycles cannot advance into another state', () => {
    for (const terminal of [CycleState.Completed, CycleState.NoTrade, CycleState.Blocked])
      for (const next of Object.values(CycleState)) expect(isCycleStateTransitionAllowed(terminal, next)).toBe(false)
    expect(isCycleStateTransitionAllowed(CycleState.Pending, CycleState.Active)).toBe(true)
    expect(isCycleStateTransitionAllowed(CycleState.Active, CycleState.NoTrade)).toBe(true)
  })
})
