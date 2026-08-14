import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Exit } from 'effect'

import {
  restateDeploymentRegistration,
  restateLifecycleActivationAcceptTimeoutMs,
  restateLifecycleActivationCompletionMaximumAttempts,
  restateLifecycleActivationCompletionPollIntervalMs,
  restateLifecycleActivationIdempotencyKey,
  restateLifecycleActivationRequest,
  restateLifecycleRegistrationConfig,
} from './restate-lifecycle-register'

describe('Restate lifecycle deployment registration', () => {
  test('registers one immutable HTTP/2 endpoint without forcing replacement', () => {
    const sourceRevision = 'a'.repeat(40)

    expect(
      restateDeploymentRegistration('http://bayn-lifecycle-a.bayn.svc.cluster.local:9080', sourceRevision),
    ).toEqual({
      uri: 'http://bayn-lifecycle-a.bayn.svc.cluster.local:9080',
      force: false,
      metadata: {
        managed_by: 'argocd',
        service: 'bayn-lifecycle',
        source_revision: sourceRevision,
      },
    })
  })

  test('deduplicates pod retries while accepting a detached activation', () => {
    const sourceRevision = 'b'.repeat(40)
    const controllerKey = 'primary'

    expect(restateLifecycleActivationIdempotencyKey(sourceRevision, controllerKey)).toBe(
      `bayn-lifecycle-${sourceRevision}-${controllerKey}`,
    )
    expect(restateLifecycleActivationRequest(sourceRevision, controllerKey)).toEqual({
      path: '/restate/send/BaynLifecycleBootstrap/start',
      body: {
        schemaVersion: 'bayn.restate-lifecycle-activation.v1',
        controllerKey,
      },
      headers: {
        'idempotency-key': `bayn-lifecycle-${sourceRevision}-${controllerKey}`,
      },
      timeoutMs: restateLifecycleActivationAcceptTimeoutMs,
    })
  })

  test('rejects operation timeouts outside the lifecycle endpoint bound before registration', async () => {
    for (const operationTimeoutMs of ['999', '86400001']) {
      const loaded = await Effect.runPromiseExit(
        restateLifecycleRegistrationConfig.pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ BAYN_OPERATION_TIMEOUT_MS: operationTimeoutMs }),
          ),
        ),
      )
      expect(Exit.isFailure(loaded)).toBe(true)
    }
  })

  test('derives a bounded completion window from the lifecycle handler contract', () => {
    expect(restateLifecycleActivationCompletionMaximumAttempts(30_000)).toBe(208)
    expect(
      (restateLifecycleActivationCompletionMaximumAttempts(30_000) - 1) *
        restateLifecycleActivationCompletionPollIntervalMs,
    ).toBe(621_000)
  })
})
