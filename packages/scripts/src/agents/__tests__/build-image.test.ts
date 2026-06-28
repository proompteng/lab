import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __private, buildImages } from '../build-image'
import { __private as dockerPrivate } from '../../shared/docker'

const originalSpawn = Bun.spawn
const originalWhich = Bun.which

const envKeys = [
  'AGENTS_BUILD_CACHE_MODE',
  'AGENTS_BUILD_CI',
  'AGENTS_BUILD_CONTEXT',
  'AGENTS_BUILD_LOG_LEVEL',
  'AGENTS_BUILD_MINIFY',
  'AGENTS_BUILD_NODE_OPTIONS',
  'AGENTS_BUILD_PRUNE_SCOPE',
  'AGENTS_BUILD_CACHE_REF',
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
  Bun.spawn = originalSpawn
  Bun.which = originalWhich
  dockerPrivate.setSpawnSync()
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

  it('keeps batch cache exports target-specific when a shared cache ref is configured', () => {
    expect(__private.cacheRefForBatchTarget('registry.example/cache:amd64', 'controller', true)).toBe(
      'registry.example/cache:amd64-controller',
    )
    expect(__private.cacheRefForBatchTarget('registry.example/cache:amd64', 'controller', false)).toBe(
      'registry.example/cache:amd64',
    )
  })

  it('allows CI to disable registry cache refs explicitly', () => {
    process.env.AGENTS_BUILD_CACHE_REF = 'false'

    expect(
      __private.resolveBuildConfiguration({
        registry: 'registry.example',
        repository: 'lab/agents-controller',
        tag: 'abc123',
        commit: 'abcdef',
      }).cacheRef,
    ).toBeUndefined()
    expect(__private.resolveCacheRef(undefined, 'off', 'registry.example/cache:latest')).toBeUndefined()
    expect(__private.resolveCacheRef(undefined, undefined, 'registry.example/cache:latest')).toBe(
      'registry.example/cache:latest',
    )
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

  it('builds a batch of Agents images through one Buildx Bake invocation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-batch-context-'))
    const commands: string[][] = []
    try {
      process.env.AGENTS_BUILD_CONTEXT = dir
      Bun.which = ((binary: string) => (binary === 'docker' ? '/usr/bin/docker' : null)) as typeof Bun.which
      Bun.spawn = ((command: Parameters<typeof Bun.spawn>[0]) => {
        commands.push(typeof command === 'string' ? [command] : [...command])
        return {
          exited: Promise.resolve(0),
          stdout: new Response('').body,
          stderr: new Response('').body,
        } as ReturnType<typeof Bun.spawn>
      }) as typeof Bun.spawn
      dockerPrivate.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
        const joined = typeof command === 'string' ? command : command.join(' ')
        if (joined === 'docker buildx version') {
          return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
        }
        if (joined === 'docker buildx inspect') {
          return {
            exitCode: 0,
            stdout: Buffer.from('Driver: docker-container\n'),
            stderr: new Uint8Array(),
          } as ReturnType<typeof Bun.spawnSync>
        }
        return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
      }) as typeof Bun.spawnSync)

      const results = await buildImages([
        {
          registry: 'registry.example',
          repository: 'lab/agents-controller',
          tag: 'abc123',
          target: 'controller',
          platforms: ['linux/arm64'],
        },
        {
          registry: 'registry.example',
          repository: 'lab/agents-control-plane',
          tag: 'abc123',
          target: 'control-plane',
          platforms: ['linux/arm64'],
        },
      ])

      expect(results.map((result) => result.image)).toEqual([
        'registry.example/lab/agents-controller:abc123',
        'registry.example/lab/agents-control-plane:abc123',
      ])
      expect(commands).toHaveLength(1)
      expect(commands[0].slice(0, 3)).toEqual(['docker', 'buildx', 'bake'])
      expect(commands[0]).toContain('--push')
      expect(commands[0]).toContain('controller')
      expect(commands[0]).toContain('control-plane')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses native docker build and push when batch targets do not need Buildx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agents-native-context-'))
    const commands: string[][] = []
    try {
      process.env.AGENTS_BUILD_CACHE_REF = 'false'
      process.env.AGENTS_BUILD_CONTEXT = dir
      Bun.which = ((binary: string) => (binary === 'docker' ? '/usr/bin/docker' : null)) as typeof Bun.which
      Bun.spawn = ((command: Parameters<typeof Bun.spawn>[0]) => {
        commands.push(typeof command === 'string' ? [command] : [...command])
        return {
          exited: Promise.resolve(0),
          stdout: new Response('').body,
          stderr: new Response('').body,
        } as ReturnType<typeof Bun.spawn>
      }) as typeof Bun.spawn

      const results = await buildImages([
        {
          registry: 'registry.example',
          repository: 'lab/agents-controller',
          tag: 'abc123-amd64',
          target: 'controller',
        },
        {
          registry: 'registry.example',
          repository: 'lab/agents-control-plane',
          tag: 'abc123-amd64',
          target: 'control-plane',
        },
      ])

      expect(results.map((result) => result.image)).toEqual([
        'registry.example/lab/agents-controller:abc123-amd64',
        'registry.example/lab/agents-control-plane:abc123-amd64',
      ])
      expect(commands.map((command) => command.slice(0, 2))).toEqual([
        ['docker', 'build'],
        ['docker', 'push'],
        ['docker', 'build'],
        ['docker', 'push'],
      ])
      expect(commands.flat()).not.toContain('buildx')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
