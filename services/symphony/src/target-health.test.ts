import { afterEach, describe, expect, test } from 'bun:test'

import { Effect, Layer, ManagedRuntime } from 'effect'
import * as Stream from 'effect/Stream'

import { OrchestratorError } from './errors'
import { createLogger } from './logger'
import {
  isEffectivelySyncedAfterSuccessfulOperation,
  makeTargetHealthLayer,
  TargetHealthDependencies,
  type TargetHealthDependenciesDefinition,
  TargetHealthService,
} from './target-health'
import { makeTestConfig } from './test-fixtures'
import { WorkflowService } from './workflow'

afterEach(() => {
  delete process.env.SYMPHONY_TRANSIENT_HEALTH_GRACE_MS
})

const makeTargetHealthDependencies = (
  overrides: Partial<TargetHealthDependenciesDefinition> = {},
): TargetHealthDependenciesDefinition => ({
  now: Effect.succeed(new Date('2026-05-25T06:33:39.000Z')),
  readServiceAccountToken: Effect.succeed(''),
  readServiceAccountCa: Effect.succeed(''),
  githubToken: Effect.succeed('test-token'),
  requestKubernetes: (_method, path) =>
    Effect.fail(new OrchestratorError('target_health_check_failed', `unexpected kubernetes request ${path}`)),
  fetchHttpStatus: (url) =>
    Effect.fail(new OrchestratorError('target_health_check_failed', `unexpected http health request ${url}`)),
  fetchOpenPromotionPrCount: () => Effect.succeed(0),
  ...overrides,
})

const makeTargetHealthRuntime = (
  config: ReturnType<typeof makeTestConfig>,
  dependencies: TargetHealthDependenciesDefinition,
) =>
  ManagedRuntime.make(
    makeTargetHealthLayer(createLogger({ test: 'target-health' })).pipe(
      Layer.provide(Layer.succeed(TargetHealthDependencies, dependencies)),
      Layer.provide(
        Layer.succeed(WorkflowService, {
          current: Effect.succeed({
            definition: { config: {}, promptTemplate: '' },
            config,
          }),
          config: Effect.succeed(config),
          reload: Effect.succeed({
            definition: { config: {}, promptTemplate: '' },
            config,
          }),
          changes: Stream.empty,
        }),
      ),
    ),
  )

describe('target health resilience', () => {
  test('treats short-lived HTTP health failures as transient after a recent healthy check', async () => {
    const config = makeTestConfig({
      health: {
        preDispatch: [
          {
            name: 'symphony-livez',
            type: 'http',
            namespace: null,
            application: null,
            url: 'https://symphony.example.test/livez',
            expectedStatus: 200,
            expectedSync: null,
            expectedHealth: null,
            resourceKind: null,
            resourceName: null,
            path: null,
          },
        ],
      },
    })

    let livezRequests = 0
    let nowMs = Date.parse('2026-05-25T06:33:39.000Z')
    process.env.SYMPHONY_TRANSIENT_HEALTH_GRACE_MS = '60000'

    const dependencies = makeTargetHealthDependencies({
      now: Effect.sync(() => new Date(nowMs)),
      fetchHttpStatus: (url) => {
        expect(url).toBe('https://symphony.example.test/livez')
        livezRequests += 1
        if (livezRequests === 1) return Effect.succeed(200)
        return Effect.fail(
          new OrchestratorError('target_health_check_failed', `failed to fetch ${url}`, 'temporary connection reset'),
        )
      },
    })
    const runtime = makeTargetHealthRuntime(config, dependencies)

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const targetHealth = yield* TargetHealthService
          const healthy = yield* targetHealth.evaluatePreDispatch
          expect(healthy.readyForDispatch).toBe(true)
          expect(healthy.lastError).toBeNull()

          nowMs += 1_000
          const transient = yield* targetHealth.evaluatePreDispatch
          expect(transient.readyForDispatch).toBe(true)
          expect(transient.lastError).toBeNull()
          expect(transient.checks[0]?.ok).toBe(false)
          expect(transient.checks[0]?.message).toContain('transient observation:')
        }),
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('uses injected promotion pull request dependency when computing readiness', async () => {
    const config = makeTestConfig({
      health: { preDispatch: [] },
      release: { promotionBranchPrefix: 'codex/release-' },
      target: { repo: 'proompteng/lab', defaultBranch: 'main' },
    })
    let callCount = 0
    const dependencies = makeTargetHealthDependencies({
      githubToken: Effect.succeed('injected-token'),
      fetchOpenPromotionPrCount: (repo, defaultBranch, promotionBranchPrefix, token, timeoutMs) =>
        Effect.sync(() => {
          callCount += 1
          expect(repo).toBe('proompteng/lab')
          expect(defaultBranch).toBe('main')
          expect(promotionBranchPrefix).toBe('codex/release-')
          expect(token).toBe('injected-token')
          expect(timeoutMs).toBe(15_000)
          return 2
        }),
    })
    const runtime = makeTargetHealthRuntime(config, dependencies)

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const targetHealth = yield* TargetHealthService
          const summary = yield* targetHealth.evaluatePreDispatch
          expect(summary.readyForDispatch).toBe(false)
          expect(summary.openPromotionPr).toBe(true)
          expect(summary.promotionPrCount).toBe(2)
          expect(summary.lastError).toBeNull()
          expect(callCount).toBe(1)
        }),
      )
    } finally {
      await runtime.dispose()
    }
  })

  test('treats stale argo out-of-sync status as ready after a successful sync result', async () => {
    const effective = isEffectivelySyncedAfterSuccessfulOperation({
      status: {
        sync: { status: 'OutOfSync' },
        health: { status: 'Healthy' },
        resources: [
          { group: 'batch', kind: 'Job', namespace: 'torghut', name: 'torghut-whitepapers-bootstrap', status: null },
          { group: 'serving.knative.dev', kind: 'Service', namespace: 'torghut', name: 'torghut', status: 'OutOfSync' },
        ],
        operationState: {
          phase: 'Succeeded',
          message: 'successfully synced (no more tasks)',
          syncResult: {
            resources: [
              {
                group: 'serving.knative.dev',
                kind: 'Service',
                namespace: 'torghut',
                name: 'torghut',
                status: 'Synced',
              },
            ],
          },
        },
      },
    })

    expect(effective).toBe(true)
  })
})
