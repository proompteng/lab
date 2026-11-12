import { expect, test } from 'bun:test'
import { Effect, Ref } from 'effect'

import { readinessResponseDecision, statusFacts } from '../http'
import {
  ExecutionControllerOutcome,
  type ExecutionControllerStatus,
  type ExecutionControllerStatusWithCompletion,
} from '../execution/controller-status'
import { config, provenance, readyState } from '../testing/runtime-fixtures'
import { deriveHealthTransition } from './decisions'
import type { HealthProbeResults } from './model'
import { checkHealth } from './program'

const checkedAt = '2026-08-28T16:00:00.000Z'
const results: HealthProbeResults = {
  postgresql: { _tag: 'Available', value: undefined },
  tigerBeetle: { _tag: 'Available', value: undefined },
  broker: null,
  cycle: {
    _tag: 'Available',
    value: {
      current: null,
      last: null,
      unfinishedCycleCount: 0,
      authority: null,
      reconciliation: null,
      mutations: {
        eventCount: 0,
        recoveryFoundCount: 0,
        approvedIntentCount: 0,
        acknowledgedIntentCount: 0,
        unresolvedCount: 0,
        oldestUnresolvedAt: null,
        latestOccurredAt: null,
      },
    },
  },
}
const transition = (probes: HealthProbeResults) => {
  const current = readyState()
  return deriveHealthTransition(
    { ...current, autonomousCycleLoop: { ...current.autonomousCycleLoop, owner: 'Process' } },
    {
      config,
      results: probes,
      broker: undefined,
      cycleFiber: { _tag: 'Running' },
      clock: { _tag: 'Available', checkedAt, checkedAtMs: Date.parse(checkedAt) },
    },
  )
}

const completedController: ExecutionControllerStatusWithCompletion = {
  schemaVersion: 1,
  controllerKey: 'a'.repeat(64),
  planHash: 'b'.repeat(64),
  active: true,
  epoch: 1,
  nextSequence: 1,
  lastSequence: 0,
  lastOutcome: ExecutionControllerOutcome.Waiting,
  lastReceiptHash: 'c'.repeat(64),
  completedAt: checkedAt,
  lastPass: { result: 'SUCCESS', outcome: 'WINDOW_CLOSED', observedAt: checkedAt },
}

const controllerTransition = (status: ExecutionControllerStatus | null, nowMs = Date.parse(checkedAt)) => {
  const current = readyState()
  return deriveHealthTransition(
    {
      ...current,
      executionController: {
        configured: true,
        controllerKey: completedController.controllerKey,
        planHash: completedController.planHash,
        status: null,
        readAvailable: true,
        checkedAt,
        error: null,
      },
    },
    {
      config,
      results: { ...results, executionController: { _tag: 'Available', value: status } },
      broker: undefined,
      cycleFiber: { _tag: 'NotProvided' },
      clock: { _tag: 'Available', checkedAt: new Date(nowMs).toISOString(), checkedAtMs: nowMs },
    },
  )
}

test('a completed streaming controller stays ready while idle without a domain deadline', () => {
  const nowMs = Date.parse(checkedAt) + config.cycleStallThresholdMs * 2
  const result = controllerTransition(completedController, nowMs)
  expect(result.health.dependencies.cycleRunner).toMatchObject({ status: 'AVAILABLE', error: null })
  expect(readinessResponseDecision(result.next, { nowMs, leaseMs: 1000 })).toMatchObject({
    status: 200,
    body: { ready: true },
  })
  expect(statusFacts(result.next, config.execution, provenance, config.build.verification)).toMatchObject({
    operational: { ready: true },
  })
})

test.each([
  {
    name: 'first completion missing',
    status: {
      schemaVersion: 1,
      controllerKey: completedController.controllerKey,
      planHash: completedController.planHash,
      active: true,
      epoch: 1,
      nextSequence: 0,
    },
    error: 'Restate lifecycle has not completed its first durable pass',
  },
  {
    name: 'inactive controller',
    status: { ...completedController, active: false },
    error: 'Restate execution controller is durably inactive',
  },
  {
    name: 'different controller identity',
    status: { ...completedController, controllerKey: 'd'.repeat(64) },
    error: 'Restate execution-controller projection identity differs from the configured controller',
  },
  {
    name: 'different controller plan',
    status: { ...completedController, planHash: 'd'.repeat(64) },
    error: 'Restate execution-controller projection plan differs from the configured controller',
  },
  {
    name: 'last pass failed',
    status: {
      ...completedController,
      lastPass: {
        result: 'FAILURE',
        observedAt: checkedAt,
        operation: 'run-cycle-pass',
        failure: 'database',
        message: 'database unavailable',
      },
    },
    error: 'run-cycle-pass/database: database unavailable',
  },
  {
    name: 'invalid completion time',
    status: { ...completedController, completedAt: 'invalid' },
    error: 'Restate execution-controller projection has an invalid completion schedule',
  },
  {
    name: 'future idle completion',
    status: { ...completedController, completedAt: new Date(Date.parse(checkedAt) + 1).toISOString() },
    error: 'Restate execution-controller completion time is in the future',
  },
  {
    name: 'invalid scheduled deadline',
    status: { ...completedController, nextDueAt: 'invalid' },
    error: 'Restate execution-controller projection has an invalid completion schedule',
  },
] satisfies readonly { name: string; status: ExecutionControllerStatus; error: string }[])(
  '$name cannot establish controller readiness',
  ({ status, error }) => {
    const result = controllerTransition(status)
    expect(result.health.dependencies.cycleRunner).toMatchObject({ status: 'UNAVAILABLE', error })
    expect(readinessResponseDecision(result.next)).toMatchObject({ status: 503, body: { ready: false } })
  },
)

test.each([0, 1, 1_000])(
  'a deadline elapsed by %dms at completion retains its original overdue boundary',
  (elapsedMs) => {
    const nextDueAtMs = Date.parse(checkedAt) - elapsedMs
    const scheduled = { ...completedController, nextDueAt: new Date(nextDueAtMs).toISOString() }
    const completed = controllerTransition(scheduled)
    expect(completed.health.dependencies.cycleRunner).toMatchObject({ status: 'AVAILABLE', error: null })
    expect(readinessResponseDecision(completed.next)).toMatchObject({ status: 200, body: { ready: true } })
    expect(completed.next.executionController?.status).toMatchObject({ nextDueAt: scheduled.nextDueAt })
    const deadline = nextDueAtMs + config.cycleStallThresholdMs
    expect(readinessResponseDecision(controllerTransition(scheduled, deadline - 1).next)).toMatchObject({
      status: 200,
      body: { ready: true },
    })
    const overdue = controllerTransition(scheduled, deadline)
    expect(overdue.health.dependencies.cycleRunner).toMatchObject({
      status: 'UNAVAILABLE',
      error: `Restate execution controller is overdue by ${config.cycleStallThresholdMs}ms`,
    })
    expect(readinessResponseDecision(overdue.next)).toMatchObject({ status: 503, body: { ready: false } })
  },
)

test('status health without a direct market probe removes the prior signal result and reports unknown data', () => {
  const result = transition(results)
  expect(result.failedDependencies).toEqual([])
  expect(result.health.dependencies).not.toHaveProperty('signal')
  expect(statusFacts(result.next, config.execution, provenance, config.build.verification)).toMatchObject({
    operational: { ready: true },
    data: { status: 'UNKNOWN' },
  })
})

test('direct market-data failure still prevents readiness', () => {
  const result = transition({ ...results, signal: { _tag: 'Unavailable', error: 'Kafka projection is rebuilding' } })
  expect(result.failedDependencies).toContain('signal')
  expect(statusFacts(result.next, config.execution, provenance, config.build.verification)).toMatchObject({
    operational: { ready: false },
    data: { status: 'INVALID' },
  })
})

test('status without a market probe still fails closed on PostgreSQL failure', () => {
  const result = transition({ ...results, postgresql: { _tag: 'Unavailable', error: 'connection deadline exceeded' } })
  expect(result.failedDependencies).toContain('postgresql')
  expect(statusFacts(result.next, config.execution, provenance, config.build.verification)).toMatchObject({
    operational: { ready: false },
    data: { status: 'UNKNOWN' },
  })
})

test('a public health pass without market data still probes its dependencies and rejects missing controller evidence', () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* Ref.make(readyState())
      const projection = results.cycle
      if (projection._tag !== 'Available') throw new Error('Invalid test projection')
      yield* checkHealth(
        config,
        state,
        {
          postgresql: Effect.void,
          journal: {
            check: Effect.void,
            post: () => Effect.die('Unexpected journal write'),
            verifyAccount: () => Effect.die('Unexpected ledger account check'),
            journalAndReconcile: () => Effect.die('Unexpected ledger mutation'),
            checkRun: () => Effect.die('Unexpected journal result check'),
          },
          cycleObservability: { read: () => Effect.succeed(projection.value) },
        },
        undefined,
        undefined,
        { _tag: 'Exact', bindingId: 'a'.repeat(64) },
      )
      const current = yield* Ref.get(state)
      expect(current.health.dependencies).not.toHaveProperty('signal')
      expect(current.health.dependencies.postgresql.status).toBe('AVAILABLE')
      expect(current.health.dependencies.tigerBeetle.status).toBe('AVAILABLE')
      expect(current.health.dependencies.cycle.status).toBe('AVAILABLE')
      expect(current.health.dependencies.cycleRunner.status).toBe('UNAVAILABLE')
      expect(statusFacts(current, config.execution, provenance, config.build.verification)).toMatchObject({
        operational: { ready: false },
        data: { status: 'UNKNOWN' },
      })
    }),
  ))
