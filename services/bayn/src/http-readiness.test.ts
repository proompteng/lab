import { expect, test } from 'bun:test'

import { CycleOperationsCondition, CycleOperationsReason } from './cycle/observability'
import { readinessResponseDecision, statusReadinessResponseDecision } from './http'
import type { RuntimeState } from './runtime-state'
import { readyState } from './testing/runtime-fixtures'

const healthy = readyState()
const freshness = { nowMs: Date.parse(healthy.health.checkedAt ?? '') + 1000, leaseMs: 90_000 }

test('the status service stays routable while post-mutation broker confirmation blocks trading readiness', () => {
  const state: RuntimeState = {
    ...healthy,
    status: 'DEGRADED' as const,
    broker: {
      configured: true,
      expectedAccountId: 'status-readiness-test',
      accountId: null,
      accountBound: false,
      readAvailable: false,
      checkedAt: healthy.health.checkedAt,
      error: 'BROKER_READ_UNAVAILABLE',
      executionEligible: true,
      executionDisabledReason: null,
    },
    cycle: {
      ...healthy.cycle,
      condition: CycleOperationsCondition.Failed,
      reason: CycleOperationsReason.ReconciliationPredatesMutation,
    },
  }
  expect(statusReadinessResponseDecision(state, freshness)).toMatchObject({ status: 200, body: { ready: true } })
  expect(readinessResponseDecision(state, freshness)).toMatchObject({
    status: 503,
    body: { ready: false, failedDependencies: ['broker', 'cycle'] },
  })
})

for (const dependency of ['postgresql', 'tigerBeetle', 'cycle'] as const) {
  test(`the status service refuses readiness when its ${dependency} read fails`, () => {
    const state = {
      ...healthy,
      health: {
        ...healthy.health,
        dependencies: {
          ...healthy.health.dependencies,
          [dependency]: { status: 'UNAVAILABLE' as const, checkedAt: healthy.health.checkedAt, error: 'read failed' },
        },
      },
    }
    expect(statusReadinessResponseDecision(state, freshness)).toMatchObject({ status: 503, body: { ready: false } })
  })
}

test('the status service rejects an expired health lease and incomplete or failed startup', () => {
  expect(statusReadinessResponseDecision(healthy, { ...freshness, nowMs: freshness.nowMs + 90_000 })).toMatchObject({
    status: 503,
    body: { ready: false },
  })
  for (const status of ['STARTING', 'FAILED'] as const)
    expect(statusReadinessResponseDecision({ ...healthy, status }, freshness)).toMatchObject({
      status: 503,
      body: { ready: false },
    })
})
