import { expect, test } from 'bun:test'
import { Schema } from 'effect'

import type { RetainedAutonomousCyclePassObservation } from './cycle/runner/pass-observation'
import { DecisionReadinessReason } from './cycle/runner/readiness'
import { ExecutionControllerOutcome, ExecutionControllerStatusSchema } from './execution/controller-status'
import { statusFacts } from './http'
import { MarketFeatureDefinition } from './market-data/features/contract'
import { initialState } from './runtime-state'
import { Reason as RiskReason } from './risk'
import { strictParseOptions } from './schemas'
import { config, provenance } from './testing/runtime-fixtures'

const observedAt = '2026-09-17T14:30:00.000Z'

const responseWithPass = (lastPass: RetainedAutonomousCyclePassObservation | undefined) =>
  statusFacts(
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
    autonomousCycleLoop: { lastPass },
    executionController: { status: { lastPass } },
  })
})

test('status exposes missing feature evidence without publishing free-form readiness text', () => {
  const readiness = {
    reason: DecisionReadinessReason.SnapshotUnavailable,
    symbol: 'SPY',
    eventAt: observedAt,
    availableAt: '2026-09-17T14:31:00.000Z',
    requiredFeature: {
      definitionId: MarketFeatureDefinition.ObservedPriceWindow,
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
    autonomousCycleLoop: { lastPass: projected },
    executionController: { status: { lastPass: projected } },
  })
  expect(JSON.stringify(response)).not.toContain('private-account-identity')
  expect(JSON.stringify(response)).not.toContain('"message"')
})

test('status retains historical successful pass observations without adding a reason', () => {
  const lastPass = { result: 'SUCCESS', outcome: 'RECOVERED', observedAt } as const
  expect(responseWithPass(lastPass)).toMatchObject({
    autonomousCycleLoop: { lastPass },
    executionController: { status: { lastPass } },
  })
})

test('status exposes breached account limits in both projections and wait modes without publishing the message', () => {
  const readiness = {
    reason: DecisionReadinessReason.AccountProtection,
    accountProtectionReasons: [RiskReason.DailyLossExceeded, RiskReason.DrawdownExceeded] as const,
  }
  const waits = [
    { outcome: 'RECOVERED', recoveryAction: 'WAITING' },
    {
      outcome: 'ADMISSION_WAITING',
      admissionProtection: {
        authorityGenerationHash: 'a'.repeat(64),
        authorityUpdatedAt: observedAt,
        reconciliationId: 'b'.repeat(64),
        tradingDate: '2026-09-17',
        validUntil: '2026-09-17T14:31:00.000Z',
      },
    },
  ] as const
  for (const wait of waits) {
    const projected = { result: 'SUCCESS', observedAt, ...wait, readiness } as const
    const controller = {
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
      lastPass: {
        ...projected,
        readiness: { ...readiness, message: 'private-account-identity exceeded account limits' },
      },
    }
    const decoded = Schema.decodeUnknownSync(
      ExecutionControllerStatusSchema,
      strictParseOptions,
    )(JSON.parse(JSON.stringify(controller)))
    const response = responseWithPass('lastPass' in decoded ? decoded.lastPass : undefined)
    expect(response).toMatchObject({
      autonomousCycleLoop: { lastPass: projected },
      executionController: { status: { lastPass: projected } },
    })
    expect(JSON.stringify(response)).not.toContain('private-account-identity')
    expect(JSON.stringify(response)).not.toContain('"message"')
    const historical = {
      ...controller,
      lastPass: {
        ...controller.lastPass,
        readiness: { reason: readiness.reason, message: 'Existing account limit' },
      },
    }
    const decodedHistorical = Schema.decodeUnknownSync(
      ExecutionControllerStatusSchema,
      strictParseOptions,
    )(JSON.parse(JSON.stringify(historical)))
    const historicalResponse = responseWithPass(
      'lastPass' in decodedHistorical ? decodedHistorical.lastPass : undefined,
    )
    expect(JSON.stringify(historicalResponse)).not.toContain('accountProtectionReasons')
    expect(historicalResponse).toMatchObject({
      autonomousCycleLoop: { lastPass: { readiness: { reason: readiness.reason } } },
      executionController: { status: { lastPass: { readiness: { reason: readiness.reason } } } },
    })
  }
})

test('status returns null for a controller receipt without a retained pass', () => {
  expect(responseWithPass(undefined)).toMatchObject({
    autonomousCycleLoop: { lastPass: null },
    executionController: { status: { lastPass: null } },
  })
})

test('status classifies failures in both pass projections without exposing their messages', () => {
  const pass = { result: 'FAILURE', observedAt, operation: 'recover-cycle', failure: 'contract' } as const
  const projected = { ...pass, reasonCode: 'AUTONOMOUS_CYCLE_PASS_FAILED' }
  const response = responseWithPass({ ...pass, message: 'private-account-identity in a failure' })
  expect(response).toMatchObject({
    autonomousCycleLoop: { lastPass: projected },
    executionController: { status: { lastPass: projected } },
  })
  expect(JSON.stringify(response)).not.toContain('private-account-identity')
})
