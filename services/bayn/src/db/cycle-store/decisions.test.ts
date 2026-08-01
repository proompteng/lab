import { describe, expect, test } from 'bun:test'

import { Result } from 'effect'

import {
  CycleState,
  CycleTerminalReason,
  makeCycleDraft,
  makeCycleExecutionPolicy,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
  type CycleDraft,
} from '../../cycle'
import { canonicalHashV1 } from '../../hash'
import { makeObserveShadowDecisionDocument, type ObserveShadowDecisionDocument } from '../../shadow-decision-contract'
import { TargetPlanReason, TargetPlanStatus, type BlockedTargetPlanReason } from '../../target-planner'
import { DataFeed, DataSource, PriceAdjustment, PublicationSchema, type InputManifest } from '../../types'
import {
  decideAcquire,
  decideActivation,
  decideBlock,
  decideCompletion,
  decideDecisionBinding,
  decideSnapshotBinding,
  makeInitialCycle,
  validateBlockedDecision,
  validateCompletionDocument,
} from './decisions'
import type { CycleStoreDecisionFailure } from './decision-contract'

const hash = (character: string): string => character.repeat(64)
const accountId = 'paper-account-1'
const snapshotId = hash('3')

const value = <A, E>(result: Result.Result<A, E>): A => {
  expect(Result.isSuccess(result)).toBe(true)
  if (Result.isFailure(result)) return expect.unreachable('expected a successful cycle-store decision')
  return result.success
}

const failure = <A>(result: Result.Result<A, CycleStoreDecisionFailure>): CycleStoreDecisionFailure => {
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) return expect.unreachable('expected a failed cycle-store decision')
  return result.failure
}

const draft = (): CycleDraft => {
  const calendar = value(
    makeExecutionCalendarObservation({
      schemaVersion: 'bayn.alpaca-market-calendar-observation.v1',
      source: 'alpaca-v2-calendar',
      date: '2026-02-02',
      openAt: '2026-02-02T14:30:00.000Z',
      closeAt: '2026-02-02T21:00:00.000Z',
    }),
  )
  const policy = value(
    makeCycleExecutionPolicy({
      schemaVersion: 'bayn.autonomous-cycle-execution-policy.v1',
      strategyExecutionModelHash: hash('4'),
      submissionWindowMs: 30 * 60_000,
      submissionCutoffBeforeOpenMs: 2 * 60_000,
    }),
  )
  const identity = value(
    makeCycleIdentity({
      schemaVersion: 'bayn.autonomous-cycle-identity.v1',
      strategyName: 'risk-balanced-trend',
      qualificationRunId: hash('1'),
      strategyProtocolHash: hash('2'),
      accountId,
      signalSessionDate: '2026-01-30',
      signalCalendarVersion: 'XNYS-v1',
      executionSessionDate: calendar.executionSessionDate,
      executionCalendarSchemaVersion: calendar.executionCalendarSchemaVersion,
      executionCalendarSource: calendar.executionCalendarSource,
      executionCalendarHash: calendar.executionCalendarHash,
      executionPolicy: policy,
    }),
  )
  return value(
    makeCycleDraft(
      identity,
      value(
        makeCycleWindow(
          {
            calendar_version: 'XNYS-v1',
            session_date: '2026-01-30',
            close_time: '16:00',
            timezone: 'America/New_York',
          },
          calendar,
          policy,
        ),
      ),
    ),
  )
}

const pendingCycle = (): AutonomousCycle => ({
  ...draft(),
  state: CycleState.Pending,
  bindings: {},
  stateVersion: 1,
  createdAt: '2026-01-30T21:15:00.000Z',
  updatedAt: '2026-01-30T21:15:00.000Z',
})

const boundPendingCycle = (): AutonomousCycle => ({
  ...pendingCycle(),
  bindings: { snapshotId },
  stateVersion: 2,
  updatedAt: '2026-01-30T21:16:00.000Z',
})

const activeCycle = (): AutonomousCycle => ({
  ...boundPendingCycle(),
  state: CycleState.Active,
  stateVersion: 3,
  updatedAt: '2026-02-02T13:56:00.000Z',
})

const snapshot: InputManifest['finalizedSnapshot'] = {
  schemaVersion: 'bayn.finalized-snapshot.v3',
  snapshotId,
  publicationId: hash('4'),
  publicationSchemaVersion: PublicationSchema.AdjustedDailySnapshotV2,
  universeId: 'cross-asset-taa-v1',
  universeSymbolHash: hash('5'),
  source: DataSource.Alpaca,
  sourceFeed: DataFeed.Sip,
  adjustment: PriceAdjustment.All,
  calendarVersion: 'XNYS-v1',
  publisherSourceRevision: 'a'.repeat(40),
  publisherImage: {
    repository: 'registry.ide-newton.ts.net/lab/signal-publisher',
    digest: `sha256:${hash('6')}`,
  },
  finalizedAt: '2026-01-30T21:01:00.000Z',
  requestedStart: '2016-01-04',
  firstSession: '2016-01-04',
  lastSession: '2026-01-30',
  asOfSession: '2026-01-30',
  symbols: ['AMD'],
  rowCount: 1,
  sessionCount: 1,
  contentHash: hash('7'),
  sessionsContentHash: hash('8'),
}

const targetPlan = (
  status: TargetPlanStatus.NoTrade | TargetPlanStatus.Blocked,
  reason: TargetPlanReason.TargetsSatisfied | BlockedTargetPlanReason,
) => {
  const material = {
    schemaVersion: 'bayn.paper-reference-target-plan.v1' as const,
    inputHash: hash('9'),
    status,
    reason,
    targets:
      status === TargetPlanStatus.NoTrade
        ? [
            {
              symbol: 'AMD',
              targetWeight: 0.5,
              referencePriceMicros: '100000000',
              currentQuantityMicros: '1000000',
              targetQuantityMicros: '1000000',
            },
          ]
        : [],
    intentTargets: [],
    requiredReferenceBuyNotionalMicros: '0',
    availableBuyingPowerMicros: '0',
    residualBuyingPowerMicros: '0',
  }
  return { ...material, outputHash: canonicalHashV1(material) }
}

const document = (
  cycle: AutonomousCycle,
  status: TargetPlanStatus.NoTrade | TargetPlanStatus.Blocked = TargetPlanStatus.NoTrade,
  reason: TargetPlanReason.TargetsSatisfied | BlockedTargetPlanReason = TargetPlanReason.TargetsSatisfied,
): ObserveShadowDecisionDocument =>
  value(
    makeObserveShadowDecisionDocument({
      schemaVersion: 'bayn.observe-shadow-decision.v1',
      mode: 'OBSERVE',
      dispatchable: false,
      bindings: {
        strategyName: cycle.identity.strategyName,
        cycleId: cycle.identity.cycleId,
        strategyProtocolHash: cycle.identity.strategyProtocolHash,
        snapshotId,
        snapshotContentHash: hash('a'),
        snapshotFinalizedAt: cycle.window.signalCloseAt,
        strategyDecisionHash: hash('b'),
        policyHash: hash('c'),
        accountId,
        planningBrokerStateHash: hash('d'),
        reconciliationId: hash('e'),
        reconciliationHash: hash('f'),
      },
      targetPlan: targetPlan(status, reason),
      deltaRisk: [],
      createdAt: '2026-02-02T13:57:00.000Z',
      submissionCutoffAt: cycle.window.submissionCutoffAt,
      expiresAt: cycle.window.submissionCutoffAt,
    }),
  )

describe('cycle store decisions', () => {
  test('constructs and acquires the deterministic cycle without mutable state', () => {
    const input = draft()
    const initial = makeInitialCycle(input, '2026-01-30T21:15:00.000Z')
    expect(initial).toMatchObject({ state: CycleState.Pending, stateVersion: 1, bindings: {} })
    expect(value(decideAcquire(initial, input, initial.updatedAt, true))).toEqual({
      _tag: 'Return',
      cycle: initial,
      created: true,
    })

    const deadlineCycle = makeInitialCycle(input, input.window.publicationDeadlineAt)
    expect(deadlineCycle).toMatchObject({
      state: CycleState.Blocked,
      terminalReason: CycleTerminalReason.MissedPublication,
      terminalAt: input.window.publicationDeadlineAt,
    })
    expect(
      failure(
        decideAcquire(
          initial,
          { ...input, identity: { ...input.identity, strategyProtocolHash: hash('0') } },
          initial.updatedAt,
          false,
        ),
      ),
    ).toMatchObject({ failure: 'conflict' })
  })

  test('selects snapshot replay, persistence, deadline blocking, and conflicts', () => {
    const pending = pendingCycle()
    expect(value(decideSnapshotBinding(pending, snapshot, '2026-01-30T21:16:00.000Z'))).toMatchObject({
      _tag: 'Persist',
      snapshotId,
    })
    expect(value(decideSnapshotBinding(boundPendingCycle(), snapshot, '2026-01-30T21:17:00.000Z'))).toMatchObject({
      _tag: 'Replay',
    })
    expect(value(decideSnapshotBinding(pending, snapshot, pending.window.publicationDeadlineAt))).toMatchObject({
      _tag: 'Block',
      reason: CycleTerminalReason.MissedPublication,
    })
    expect(
      failure(
        decideSnapshotBinding(boundPendingCycle(), { ...snapshot, snapshotId: hash('0') }, '2026-01-30T21:17:00.000Z'),
      ),
    ).toMatchObject({ failure: 'conflict', message: 'cycle snapshot binding cannot be replaced' })
  })

  test('selects activation replay, persistence, deadline blocking, and invalid states', () => {
    const bound = boundPendingCycle()
    expect(value(decideActivation(bound, '2026-02-02T13:57:00.000Z'))).toMatchObject({ _tag: 'Persist' })
    expect(value(decideActivation(activeCycle(), '2026-02-02T13:57:00.000Z'))).toMatchObject({
      _tag: 'Replay',
    })
    expect(value(decideActivation(bound, bound.window.submissionCutoffAt))).toMatchObject({
      _tag: 'Block',
      reason: CycleTerminalReason.MissedSubmission,
    })
    expect(failure(decideActivation(pendingCycle(), '2026-02-02T13:57:00.000Z'))).toMatchObject({
      failure: 'invariant',
      message: 'cycle activation requires a bound snapshot',
    })
  })

  test('validates decision binding before any durable evidence query or write', () => {
    const active = activeCycle()
    const input = document(active)
    expect(value(decideDecisionBinding(active, input, '2026-02-02T13:58:00.000Z', []))).toMatchObject({
      _tag: 'Persist',
      document: input,
    })

    const bound: AutonomousCycle = {
      ...active,
      bindings: { snapshotId, decisionHash: input.contentHash },
      stateVersion: 4,
      updatedAt: '2026-02-02T13:58:00.000Z',
    }
    expect(value(decideDecisionBinding(bound, input, bound.updatedAt, [input]))).toMatchObject({
      _tag: 'Replay',
    })
    expect(failure(decideDecisionBinding(bound, input, bound.updatedAt, []))).toMatchObject({
      failure: 'conflict',
      message: 'cycle decision binding cannot be replaced',
    })
    expect(value(decideDecisionBinding(active, input, active.window.submissionCutoffAt, []))).toMatchObject({
      _tag: 'Block',
      reason: CycleTerminalReason.MissedSubmission,
    })
  })

  test('requires completion to match the exact bound durable decision', () => {
    const active = activeCycle()
    const noTrade = document(active)
    const bound: AutonomousCycle = {
      ...active,
      bindings: { snapshotId, decisionHash: noTrade.contentHash },
      stateVersion: 4,
      updatedAt: '2026-02-02T13:58:00.000Z',
    }
    const selected = value(decideCompletion(bound, CycleState.NoTrade, '2026-02-02T13:59:00.000Z'))
    expect(selected).toMatchObject({ _tag: 'VerifyDecision', decisionHash: noTrade.contentHash })
    if (selected._tag !== 'VerifyDecision') return expect.unreachable('expected decision verification')
    expect(value(validateCompletionDocument(selected, [noTrade]))).toBeUndefined()
    expect(failure(validateCompletionDocument(selected, []))).toMatchObject({
      failure: 'invariant',
      message: 'cycle terminal state must match its exact durable shadow decision',
    })
  })

  test('requires a decision-bound block to match the exact target-plan reason', () => {
    const active = activeCycle()
    const blocked = document(active, TargetPlanStatus.Blocked, TargetPlanReason.InputStale)
    const bound: AutonomousCycle = {
      ...active,
      bindings: { snapshotId, decisionHash: blocked.contentHash },
      stateVersion: 4,
      updatedAt: '2026-02-02T13:58:00.000Z',
    }
    const selected = value(decideBlock(bound, CycleTerminalReason.DataStale, '2026-02-02T13:59:00.000Z'))
    expect(selected).toMatchObject({ _tag: 'VerifyDecision', reason: CycleTerminalReason.DataStale })
    if (selected._tag !== 'VerifyDecision') return expect.unreachable('expected decision verification')
    expect(value(validateBlockedDecision(selected, [blocked]))).toBeUndefined()
    expect(
      failure(validateBlockedDecision({ ...selected, reason: CycleTerminalReason.DataInvalid }, [blocked])),
    ).toMatchObject({
      failure: 'invariant',
      message: 'cycle blocked reason must match its exact durable shadow decision',
    })
  })
})
