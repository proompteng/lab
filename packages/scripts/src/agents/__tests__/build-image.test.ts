import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  it('uses canonical AGENTS build environment names', () => {
    process.env.AGENTS_BUILD_NODE_OPTIONS = '--max-old-space-size=4096'
    process.env.AGENTS_BUILD_SOURCEMAP = '0'
    process.env.AGENTS_BUILD_CI = 'true'
    process.env.AGENTS_BUILD_LOG_LEVEL = 'warn'

    expect(__private.buildArgsFromEnv('v1', 'commit1')).toEqual({
      AGENTS_VERSION: 'v1',
      AGENTS_COMMIT: 'commit1',
      AGENTS_BUILD_NODE_OPTIONS: '--max-old-space-size=4096',
      AGENTS_BUILD_SOURCEMAP: '0',
      AGENTS_BUILD_CI: 'true',
      AGENTS_BUILD_LOG_LEVEL: 'warn',
    })
  })

  it('uses the Agents workspace as the default control-plane prune scope', () => {
    expect(__private.parsePruneScopes(undefined, 'control-plane')).toEqual([
      '@proompteng/agents',
      '@proompteng/agent-contracts',
      '@proompteng/otel',
      '@proompteng/temporal-bun-sdk',
    ])
    expect(__private.parsePruneScopes(undefined, undefined)).toEqual([
      '@proompteng/agents',
      '@proompteng/agent-contracts',
      '@proompteng/otel',
      '@proompteng/temporal-bun-sdk',
    ])
  })

  it('uses the Agents workspace as the default controller prune scope', () => {
    expect(__private.parsePruneScopes(undefined, 'controller')).toEqual([
      '@proompteng/agents',
      '@proompteng/agent-contracts',
      '@proompteng/otel',
      '@proompteng/temporal-bun-sdk',
    ])
  })

  it('rejects Jangar prune scopes for Agents images', () => {
    expect(() => __private.parsePruneScopes('@proompteng/agents,@proompteng/jangar')).toThrow(
      'Agents images must not prune or package @proompteng/jangar',
    )
  })

  it('removes nested node_modules from pruned Docker contexts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-prune-node-modules-'))
    try {
      const agentsNodeModules = join(dir, 'full/services/agents/node_modules')
      const nestedNodeModules = join(dir, 'json/packages/cx-tools/node_modules')
      const sourceDirectory = join(dir, 'full/services/agents/src')
      mkdirSync(agentsNodeModules, { recursive: true })
      mkdirSync(nestedNodeModules, { recursive: true })
      mkdirSync(sourceDirectory, { recursive: true })
      symlinkSync('../../../node_modules/.bun/yaml@2.9.0/node_modules/yaml', join(agentsNodeModules, 'yaml'))
      writeFileSync(join(nestedNodeModules, 'placeholder'), '')
      writeFileSync(join(sourceDirectory, 'index.ts'), 'export {}\n')

      __private.removeNestedNodeModules(dir)

      expect(existsSync(agentsNodeModules)).toBeFalse()
      expect(existsSync(nestedNodeModules)).toBeFalse()
      expect(existsSync(sourceDirectory)).toBeTrue()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
