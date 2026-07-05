import { describe, expect, it } from 'bun:test'

import { __private } from '../build-image'

describe('arc-runner build-image helpers', () => {
  it('uses the same architecture tags as the ARC runner OCI workflow before publishing the index', () => {
    expect(__private.platformTag('sha-123', 'linux/amd64')).toBe('sha-123-amd64')
    expect(__private.platformTag('sha-123', 'linux/arm64')).toBe('sha-123-arm64')

    expect(__private.platformIndexTags('sha-123')).toEqual([
      { platform: 'linux/amd64', tag: 'sha-123-amd64' },
      { platform: 'linux/arm64', tag: 'sha-123-arm64' },
    ])
  })

  it('keeps platform suffixes registry-safe for variant platforms', () => {
    expect(__private.platformSuffix('linux/arm/v7')).toBe('arm_v7')
  })
})
