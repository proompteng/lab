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
      '--health-attempts',
      '10',
      '--health-interval-seconds',
      '5',
    ])

    expect(parsed.namespace).toBe('jangar')
    expect(parsed.deployments).toEqual(['jangar', 'jangar-worker'])
    expect(parsed.requireSynced).toBe(true)
    expect(parsed.healthAttempts).toBe(10)
    expect(parsed.healthIntervalSeconds).toBe(5)
  })
})
