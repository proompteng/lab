import { describe, expect, test } from 'bun:test'

import {
  restateDeploymentRegistration,
  restateLifecycleActivationIdempotencyKey,
  restateLifecycleActivationRequest,
} from './restate-lifecycle-register'
import { lifecycleActivationAwaitTimeoutMs } from './restate-lifecycle-controller'

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

  test('deduplicates pod retries while waiting for the bounded activation result', () => {
    const sourceRevision = 'b'.repeat(40)
    const controllerKey = 'primary'

    expect(restateLifecycleActivationIdempotencyKey(sourceRevision, controllerKey)).toBe(
      `bayn-lifecycle-${sourceRevision}-${controllerKey}`,
    )
    expect(restateLifecycleActivationRequest(sourceRevision, controllerKey, 30_000)).toEqual({
      body: {
        schemaVersion: 'bayn.restate-lifecycle-activation.v1',
        controllerKey,
      },
      headers: {
        'idempotency-key': `bayn-lifecycle-${sourceRevision}-${controllerKey}`,
      },
      timeoutMs: lifecycleActivationAwaitTimeoutMs(30_000),
    })
    expect(lifecycleActivationAwaitTimeoutMs(30_000)).toBe(621_000)
  })
})
