import { describe, expect, test } from 'bun:test'

import { restateDeploymentRegistration } from './restate-lifecycle-register'

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
})
