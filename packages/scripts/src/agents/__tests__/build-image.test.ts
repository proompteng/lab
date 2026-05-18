import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('copies only server output when prebuilt transitional Jangar output is used', () => {
    const root = mkdtempSync(join(tmpdir(), 'agents-build-image-test-'))
    try {
      const source = join(root, 'source')
      const destination = join(root, 'destination')
      mkdirSync(join(source, 'server/proto/proompteng/jangar/v1'), { recursive: true })
      mkdirSync(join(source, 'public/assets'), { recursive: true })
      writeFileSync(join(source, 'server/index.mjs'), 'export {}')
      writeFileSync(join(source, 'server/proto/proompteng/jangar/v1/agentctl.proto'), 'syntax = "proto3";')
      writeFileSync(join(source, 'public/assets/app.js'), 'console.log("client")')

      __private.copyPrebuiltServerOutput(source, destination)

      expect(existsSync(join(destination, 'server/index.mjs'))).toBeTrue()
      expect(existsSync(join(destination, 'server/proto/proompteng/jangar/v1/agentctl.proto'))).toBeTrue()
      expect(existsSync(join(destination, 'public'))).toBeFalse()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
