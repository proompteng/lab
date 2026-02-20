import { describe, expect, it } from 'bun:test'

import { __private } from '../verify-deployment'

describe('verify-deployment', () => {
  it('extracts expected digest for configured image', () => {
    const source = `images:
  - name: registry.ide-newton.ts.net/lab/jangar
    newTag: "abcd1234"
    digest: sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe
  - name: registry.ide-newton.ts.net/lab/other
    newTag: latest
    digest: sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff
`

    const digest = __private.extractExpectedDigest(source, 'registry.ide-newton.ts.net/lab/jangar')
    expect(digest).toBe('sha256:6af34b1781155267ed6821833feb0ee8856b2b08128cb0ac9b0c388615b380fe')
  })

  it('parses deployment and sync args', () => {
    const parsed = __private.parseArgs([
      '--namespace',
      'jangar',
      '--deployments',
      'jangar,jangar-worker',
      '--require-synced',
      '--expected-revision',
      '0123456789abcdef0123456789abcdef01234567',
      '--health-attempts',
      '10',
      '--health-interval-seconds',
      '5',
      '--digest-attempts',
      '8',
      '--digest-interval-seconds',
      '4',
    ])

    expect(parsed.namespace).toBe('jangar')
    expect(parsed.deployments).toEqual(['jangar', 'jangar-worker'])
    expect(parsed.requireSynced).toBe(true)
    expect(parsed.expectedRevision).toBe('0123456789abcdef0123456789abcdef01234567')
    expect(parsed.healthAttempts).toBe(10)
    expect(parsed.healthIntervalSeconds).toBe(5)
    expect(parsed.digestAttempts).toBe(8)
    expect(parsed.digestIntervalSeconds).toBe(4)
  })

  it('waits while Argo revision is not the expected revision', () => {
    const waitReason = __private.getArgoWaitReason(
      __private.parseArgoStatus('Synced Healthy abcdef0123456789abcdef0123456789abcdef01'),
      {
        argoApplication: 'jangar',
        argoNamespace: 'argocd',
        deployments: ['jangar'],
        digestAttempts: 1,
        digestIntervalSeconds: 1,
        expectedRevision: 'fedcba9876543210fedcba9876543210fedcba98',
        healthAttempts: 1,
        healthIntervalSeconds: 1,
        imageName: 'registry.ide-newton.ts.net/lab/jangar',
        kustomizationPath: 'argocd/applications/jangar/kustomization.yaml',
        namespace: 'jangar',
        requireSynced: true,
        rolloutTimeout: '10m',
      },
    )

    expect(waitReason).toContain('revision=')
    expect(waitReason).toContain('expected=')
  })

  it('returns no wait reason for synced healthy expected revision', () => {
    const waitReason = __private.getArgoWaitReason(
      __private.parseArgoStatus('Synced Healthy 0123456789abcdef0123456789abcdef01234567'),
      {
        argoApplication: 'jangar',
        argoNamespace: 'argocd',
        deployments: ['jangar'],
        digestAttempts: 1,
        digestIntervalSeconds: 1,
        expectedRevision: '0123456789abcdef0123456789abcdef01234567',
        healthAttempts: 1,
        healthIntervalSeconds: 1,
        imageName: 'registry.ide-newton.ts.net/lab/jangar',
        kustomizationPath: 'argocd/applications/jangar/kustomization.yaml',
        namespace: 'jangar',
        requireSynced: true,
        rolloutTimeout: '10m',
      },
    )

    expect(waitReason).toBeUndefined()
  })
})
