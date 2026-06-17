import { afterEach, describe, expect, it } from 'bun:test'

import { __private, buildAndPushDockerImage, inspectImageDigest, resolveBuildAttestations } from '../docker'

const originalSpawn = Bun.spawn
const originalWhich = Bun.which

afterEach(() => {
  __private.setSpawnSync()
  Bun.spawn = originalSpawn
  Bun.which = originalWhich
  delete process.env.DOCKER_COMMAND_RETRY_ATTEMPTS
  delete process.env.DOCKER_COMMAND_RETRY_DELAY_SECONDS
  delete process.env.DOCKER_BUILD_PROVENANCE
  delete process.env.DOCKER_BUILD_SBOM
})

const streamFromText = (text: string) => new Response(text).body!

describe('inspectImageDigest', () => {
  it('prefers the remote repo digest when both remote and local digests are available', () => {
    const calls: string[] = []
    const spawnMock = ((command: Parameters<typeof Bun.spawnSync>[0], args, _opts) => {
      const commandString = typeof command === 'string' ? command : Array.prototype.join.call(command, ' ')
      const argString = Array.isArray(args) ? args.join(' ') : args ? String(args) : ''
      const joined = `${commandString} ${argString}`.trim()
      calls.push(joined)
      if (joined.startsWith('docker buildx imagetools inspect')) {
        const payload = JSON.stringify({ digest: 'sha256:222' })
        return { exitCode: 0, stdout: Buffer.from(payload), stderr: new Uint8Array() } as ReturnType<
          typeof Bun.spawnSync
        >
      }
      if (joined.startsWith('docker image inspect')) {
        return {
          exitCode: 0,
          stdout: Buffer.from('["registry/repo@sha256:111"]'),
          stderr: new Uint8Array(),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    __private.setSpawnSync(spawnMock)

    const digest = inspectImageDigest('registry/repo:tag')
    expect(digest).toBe('registry/repo@sha256:222')
    expect(calls.some((call) => call.startsWith('docker image inspect'))).toBe(false)
  })

  it('falls back to the locally cached repo digest when the remote image is missing', () => {
    const spawnMock = ((command: Parameters<typeof Bun.spawnSync>[0], args, _opts) => {
      const commandString = typeof command === 'string' ? command : Array.prototype.join.call(command, ' ')
      const argString = Array.isArray(args) ? args.join(' ') : args ? String(args) : ''
      const joined = `${commandString} ${argString}`.trim()
      if (joined.startsWith('docker buildx imagetools inspect')) {
        return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
      }
      if (joined.startsWith('docker image inspect')) {
        return {
          exitCode: 0,
          stdout: Buffer.from('["registry.example/froussard@sha256:111"]'),
          stderr: new Uint8Array(),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    __private.setSpawnSync(spawnMock)

    const digest = inspectImageDigest('registry.example/froussard:latest')
    expect(digest).toBe('registry.example/froussard@sha256:111')
  })
})

describe('resolveBuildAttestations', () => {
  it('enables BuildKit provenance and SBOM attestations from env', () => {
    process.env.DOCKER_BUILD_PROVENANCE = 'max'
    process.env.DOCKER_BUILD_SBOM = 'true'

    expect(resolveBuildAttestations()).toEqual(['type=provenance,mode=max', 'type=sbom'])
  })

  it('accepts explicit BuildKit attestation strings', () => {
    process.env.DOCKER_BUILD_PROVENANCE = 'type=provenance,mode=min'
    process.env.DOCKER_BUILD_SBOM = 'type=sbom,generator=image'

    expect(resolveBuildAttestations()).toEqual(['type=provenance,mode=min', 'type=sbom,generator=image'])
  })

  it('keeps attestations disabled by default', () => {
    expect(resolveBuildAttestations()).toEqual([])
  })

  it('uses buildx when attestations are requested for a single image build', async () => {
    const commands: string[][] = []

    process.env.DOCKER_BUILD_PROVENANCE = 'max'
    Bun.which = ((binary: string) => (binary === 'docker' ? '/usr/bin/docker' : null)) as typeof Bun.which
    Bun.spawn = ((command: Parameters<typeof Bun.spawn>[0], _options: Parameters<typeof Bun.spawn>[1]) => {
      commands.push(typeof command === 'string' ? [command] : [...command])
      return { exited: Promise.resolve(0) } as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn
    __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
      const joined = typeof command === 'string' ? command : command.join(' ')
      if (joined === 'docker buildx version') {
        return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
      }
      return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync)

    await buildAndPushDockerImage({
      registry: 'registry.example',
      repository: 'lab/jangar',
      tag: 'test',
      context: '.',
      dockerfile: 'Dockerfile',
    })

    expect(commands).toHaveLength(1)
    expect(commands[0].slice(0, 4)).toEqual(['docker', 'buildx', 'build', '--push'])
    expect(commands[0]).toContain('--attest')
    expect(commands[0]).toContain('type=provenance,mode=max')
  })

  it('retries transient registry upload failures from buildx push', async () => {
    const commands: string[][] = []

    process.env.DOCKER_COMMAND_RETRY_ATTEMPTS = '2'
    process.env.DOCKER_COMMAND_RETRY_DELAY_SECONDS = '1'
    Bun.which = ((binary: string) => (binary === 'docker' ? '/usr/bin/docker' : null)) as typeof Bun.which
    Bun.spawn = ((command: Parameters<typeof Bun.spawn>[0], _options: Parameters<typeof Bun.spawn>[1]) => {
      commands.push(typeof command === 'string' ? [command] : [...command])
      const failedAttempt = commands.length === 1
      return {
        exited: Promise.resolve(failedAttempt ? 1 : 0),
        stdout: streamFromText(''),
        stderr: streamFromText(failedAttempt ? 'unknown: invalid content range' : ''),
      } as ReturnType<typeof Bun.spawn>
    }) as typeof Bun.spawn
    __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
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

    await buildAndPushDockerImage({
      registry: 'registry.example',
      repository: 'lab/agents-control-plane',
      tag: 'test',
      context: '.',
      dockerfile: 'Dockerfile',
      cacheRef: 'registry.example/lab/agents-control-plane:buildcache',
    })

    expect(commands).toHaveLength(2)
    expect(commands[0].slice(0, 4)).toEqual(['docker', 'buildx', 'build', '--push'])
    expect(commands[1].slice(0, 4)).toEqual(['docker', 'buildx', 'build', '--push'])
  })

  it('preserves the process PATH when setting Docker BuildKit env', async () => {
    const originalPath = process.env.PATH
    process.env.PATH = '/custom/bin:/usr/bin'
    let dockerEnv: Record<string, string> | undefined

    try {
      Bun.which = ((binary: string) => (binary === 'docker' ? '/custom/bin/docker' : null)) as typeof Bun.which
      Bun.spawn = ((_command: Parameters<typeof Bun.spawn>[0], options: Parameters<typeof Bun.spawn>[1]) => {
        dockerEnv = options?.env as Record<string, string> | undefined
        return {
          exited: Promise.resolve(0),
          stdout: streamFromText(''),
          stderr: streamFromText(''),
        } as ReturnType<typeof Bun.spawn>
      }) as typeof Bun.spawn
      __private.setSpawnSync(((command: Parameters<typeof Bun.spawnSync>[0]) => {
        const joined = typeof command === 'string' ? command : command.join(' ')
        if (joined === 'docker buildx version') {
          return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
        }
        return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
      }) as typeof Bun.spawnSync)

      await buildAndPushDockerImage({
        registry: 'registry.example',
        repository: 'lab/agents-control-plane',
        tag: 'test',
        context: '.',
        dockerfile: 'Dockerfile',
      })

      expect(dockerEnv?.PATH).toBe('/custom/bin:/usr/bin')
      expect(dockerEnv?.DOCKER_BUILDKIT).toBe('1')
    } finally {
      process.env.PATH = originalPath
    }
  })
})
