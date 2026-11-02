import { expect, test } from 'bun:test'
import { Effect, Ref } from 'effect'

import { statusFacts } from '../http'
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
