import { describe, expect, it } from 'bun:test'

import { imageIdMatchesDigest } from './verify-deployment'

describe('Symphony deployment image verification', () => {
  const digest = `sha256:${'a'.repeat(64)}`

  it('accepts Kubernetes image IDs pinned to the expected digest', () => {
    expect(imageIdMatchesDigest(`registry.example/symphony@${digest}`, digest)).toBe(true)
    expect(imageIdMatchesDigest(`docker-pullable://registry.example/symphony@${digest}`, digest)).toBe(true)
  })

  it('rejects a healthy pod running a different digest', () => {
    expect(imageIdMatchesDigest(`registry.example/symphony@sha256:${'b'.repeat(64)}`, digest)).toBe(false)
  })
})
