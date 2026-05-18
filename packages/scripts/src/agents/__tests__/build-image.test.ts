import { afterEach, describe, expect, it } from 'bun:test'

import { __private } from '../build-image'

const envKeys = [
  'AGENTS_BUILD_CACHE_MODE',
  'AGENTS_BUILD_CI',
  'AGENTS_BUILD_CONTEXT',
  'AGENTS_BUILD_LOG_LEVEL',
  'AGENTS_BUILD_MINIFY',
  'AGENTS_BUILD_NODE_OPTIONS',
  'AGENTS_BUILD_PRUNE_SCOPE',
  'AGENTS_BUILD_SOURCEMAP',
  'AGENTS_COMMIT',
  'AGENTS_DOCKERFILE',
  'AGENTS_DOCKER_TARGET',
  'AGENTS_IMAGE_PLATFORMS',
  'AGENTS_IMAGE_REGISTRY',
  'AGENTS_IMAGE_REPOSITORY',
  'AGENTS_IMAGE_TAG',
  'AGENTS_VERSION',
  'JANGAR_BUILD_CACHE_MODE',
  'JANGAR_BUILD_CI',
  'JANGAR_BUILD_LOG_LEVEL',
  'JANGAR_BUILD_MINIFY',
  'JANGAR_BUILD_NODE_OPTIONS',
  'JANGAR_BUILD_SOURCEMAP',
]

afterEach(() => {
  for (const key of envKeys) {
    delete process.env[key]
  }
})

describe('agents build-image helpers', () => {
  it('defaults to an Agents-owned Dockerfile and image repository', () => {
    const config = __private.resolveBuildConfiguration({
      tag: 'abc123',
      commit: 'abcdef',
    })

    expect(config.repository).toBe('lab/agents-control-plane')
    expect(config.dockerfile.endsWith('/services/agents/Dockerfile')).toBeTrue()
    expect(config.buildArgs).toMatchObject({
      AGENTS_VERSION: 'abc123',
      AGENTS_COMMIT: 'abcdef',
    })
  })

  it('uses AGENTS build environment names before legacy Jangar aliases', () => {
    process.env.AGENTS_BUILD_NODE_OPTIONS = '--max-old-space-size=4096'
    process.env.AGENTS_BUILD_SOURCEMAP = '0'
    process.env.AGENTS_BUILD_CI = 'true'
    process.env.AGENTS_BUILD_LOG_LEVEL = 'warn'
    process.env.JANGAR_BUILD_NODE_OPTIONS = '--max-old-space-size=1024'
    process.env.JANGAR_BUILD_SOURCEMAP = '1'

    expect(__private.buildArgsFromEnv('v1', 'commit1')).toEqual({
      AGENTS_VERSION: 'v1',
      AGENTS_COMMIT: 'commit1',
      AGENTS_BUILD_NODE_OPTIONS: '--max-old-space-size=4096',
      AGENTS_BUILD_SOURCEMAP: '0',
      AGENTS_BUILD_CI: 'true',
      AGENTS_BUILD_LOG_LEVEL: 'warn',
    })
  })

  it('keeps legacy Jangar build env as read-only compatibility for one release', () => {
    process.env.JANGAR_BUILD_MINIFY = '0'
    process.env.JANGAR_BUILD_CI = 'true'

    expect(__private.buildArgsFromEnv('v1', 'commit1')).toEqual({
      AGENTS_VERSION: 'v1',
      AGENTS_COMMIT: 'commit1',
      AGENTS_BUILD_MINIFY: '0',
      AGENTS_BUILD_CI: 'true',
    })
  })

  it('keeps the transitional prune scope explicit until the server output moves', () => {
    expect(__private.parsePruneScopes(undefined)).toEqual(['@proompteng/jangar'])
    expect(__private.parsePruneScopes('@proompteng/agents,@proompteng/jangar')).toEqual([
      '@proompteng/agents',
      '@proompteng/jangar',
    ])
  })
})
