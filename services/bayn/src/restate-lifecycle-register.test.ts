import { describe, expect, test } from 'bun:test'

import {
  decodeRestateAcceptedInvocation,
  restateDeploymentRegistration,
  restateLifecycleActivationAcceptTimeoutMs,
  restateLifecycleActivationIdempotencyKey,
  restateLifecycleActivationRequest,
} from './restate-lifecycle-register'
import { Result } from 'effect'

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

  test('accepts only a closed Restate send receipt', () => {
    expect(
      Result.isSuccess(
        decodeRestateAcceptedInvocation({ invocationId: 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5', status: 'Accepted' }),
      ),
    ).toBe(true)
    expect(Result.isFailure(decodeRestateAcceptedInvocation({ invocationId: 'other', status: 'Accepted' }))).toBe(true)
    expect(
      Result.isFailure(
        decodeRestateAcceptedInvocation({ invocationId: 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5', status: 'Done' }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decodeRestateAcceptedInvocation({
          invocationId: 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5',
          status: 'Accepted',
          extra: true,
        }),
      ),
    ).toBe(true)
  })
})
