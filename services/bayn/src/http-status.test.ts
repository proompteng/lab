import { expect, test } from 'bun:test'

import type { RetainedAutonomousCyclePassObservation } from './cycle/runner/pass-observation'
import { DecisionReadinessReason } from './cycle/runner/readiness'
import { ExecutionControllerOutcome } from './execution/controller-status'
import { statusResponseDecision } from './http'
import { MarketFeatureDefinition } from './market-data/features/contract'
import { initialState } from './runtime-state'
import { config, provenance } from './testing/runtime-fixtures'

const observedAt = '2026-09-17T14:30:00.000Z'

const responseWithPass = (lastPass: RetainedAutonomousCyclePassObservation | undefined) =>
  statusResponseDecision(
    {
      ...initialState({}),
      autonomousCycleLoop: {
        configured: true,
        owner: 'Restate',
        startedAt: observedAt,
        lastPass: lastPass ?? null,
      },
      executionController: {
        configured: true,
        controllerKey: 'primary',
        planHash: 'f'.repeat(64),
        readAvailable: true,
        checkedAt: observedAt,
        error: null,
        status: {
          schemaVersion: 1,
          controllerKey: 'primary',
          planHash: 'f'.repeat(64),
          active: true,
          epoch: 1,
          nextSequence: 2,
          lastSequence: 1,
          lastOutcome: ExecutionControllerOutcome.Waiting,
          lastReceiptHash: 'a'.repeat(64),
          completedAt: observedAt,
          ...(lastPass === undefined ? {} : { lastPass }),
        },
      },
    },
    config.execution,
    provenance,
    config.build.verification,
  )

test('status identifies an ordinary holding wait in both pass projections', () => {
  const lastPass = {
    result: 'SUCCESS',
    outcome: 'RECOVERED',
    recoveryAction: 'WAITING',
    waitReason: 'ENTRY_INTENTS_SETTLED_UNTIL_CLOSE',
    observedAt,
  } as const
  expect(responseWithPass(lastPass)).toMatchObject({
    _tag: 'Json',
    status: 200,
    body: { autonomousCycleLoop: { lastPass }, executionController: { status: { lastPass } } },
  })
})

test('status exposes missing feature evidence without publishing free-form readiness text', () => {
  const readiness = {
    reason: DecisionReadinessReason.SnapshotUnavailable,
    symbol: 'SPY',
    eventAt: observedAt,
    availableAt: '2026-09-17T14:31:00.000Z',
    requiredFeature: {
      definitionId: MarketFeatureDefinition.RollingPrice30m,
      definitionHash: 'b'.repeat(64),
      windowStartAt: '2026-09-17T14:00:00.000Z',
      windowEndAt: observedAt,
    },
    snapshotQuery: {
      rangeStartAt: '2026-09-17T14:00:00.000Z',
      rangeEndAt: observedAt,
      symbols: ['SPY', 'NVDA'],
    },
  }
  const projected = {
    result: 'SUCCESS',
    outcome: 'RECOVERED',
    recoveryAction: 'WAITING',
    observedAt,
    readiness,
  } as const
  const response = responseWithPass({
    ...projected,
    readiness: { ...readiness, message: 'private-account-identity in a diagnostic message' },
  })
  expect(response).toMatchObject({
    _tag: 'Json',
    body: { autonomousCycleLoop: { lastPass: projected }, executionController: { status: { lastPass: projected } } },
  })
  expect(JSON.stringify(response)).not.toContain('private-account-identity')
  expect(JSON.stringify(response)).not.toContain('"message"')
})

test('status retains historical successful pass observations without adding a reason', () => {
  const lastPass = { result: 'SUCCESS', outcome: 'RECOVERED', observedAt } as const
  expect(responseWithPass(lastPass)).toMatchObject({
    body: { autonomousCycleLoop: { lastPass }, executionController: { status: { lastPass } } },
  })
})

test('status returns null for a controller receipt without a retained pass', () => {
  expect(responseWithPass(undefined)).toMatchObject({
    body: { autonomousCycleLoop: { lastPass: null }, executionController: { status: { lastPass: null } } },
  })
})

test('status classifies failures in both pass projections without exposing their messages', () => {
  const pass = { result: 'FAILURE', observedAt, operation: 'recover-cycle', failure: 'contract' } as const
  const projected = { ...pass, reasonCode: 'AUTONOMOUS_CYCLE_PASS_FAILED' }
  const response = responseWithPass({ ...pass, message: 'private-account-identity in a failure' })
  expect(response).toMatchObject({
    body: { autonomousCycleLoop: { lastPass: projected }, executionController: { status: { lastPass: projected } } },
  })
  expect(JSON.stringify(response)).not.toContain('private-account-identity')
})
