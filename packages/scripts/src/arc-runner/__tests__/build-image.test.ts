import { describe, expect, it } from 'bun:test'

import { __private } from '../build-image'

const localRef = `registry.example/lab/arc-runner@sha256:${'a'.repeat(64)}`
const armRef = `registry.example/lab/arc-runner@sha256:${'b'.repeat(64)}`

describe('arc-runner build-image helpers', () => {
  it('uses explicit prebuilt arch references plus the local platform build before publishing the index', () => {
    expect(__private.platformTag('sha-123', 'linux/amd64')).toBe('sha-123-amd64')
    expect(__private.platformTag('sha-123', 'linux/arm64')).toBe('sha-123-arm64')

    expect(
      __private.platformIndexTags({
        tag: 'sha-123',
        buildPlatform: 'linux/amd64',
        localImageRef: localRef,
        prebuiltRefs: { 'linux/arm64': armRef },
      }),
    ).toEqual([
      { platform: 'linux/amd64', tag: localRef },
      { platform: 'linux/arm64', tag: armRef },
    ])
  })

  it('fails before building when the opposite platform reference is missing', () => {
    expect(__private.missingPrebuiltPlatforms('linux/amd64', {})).toEqual(['linux/arm64'])
    expect(() => __private.assertPrebuiltPlatformRefs('sha-123', 'linux/amd64', {})).toThrow(
      'requires prebuilt image reference(s) for linux/arm64',
    )
    expect(() =>
      __private.assertPrebuiltPlatformRefs('sha-123', 'linux/amd64', { 'linux/arm64': armRef }),
    ).not.toThrow()
  })

  it('parses explicit prebuilt architecture references', () => {
    expect(
      __private.parseArgs([
        '--tag',
        'sha-123',
        '--amd64-image-ref',
        'registry.example/lab/arc-runner:sha-123-amd64',
        '--arm64-image-ref=registry.example/lab/arc-runner:sha-123-arm64',
      ]),
    ).toMatchObject({
      tag: 'sha-123',
      amd64ImageRef: 'registry.example/lab/arc-runner:sha-123-amd64',
      arm64ImageRef: 'registry.example/lab/arc-runner:sha-123-arm64',
    })
  })

  it('keeps platform suffixes registry-safe for variant platforms', () => {
    expect(__private.platformSuffix('linux/arm/v7')).toBe('arm_v7')
  })
})
