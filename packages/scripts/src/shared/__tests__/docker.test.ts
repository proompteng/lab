import { afterEach, describe, expect, it } from 'bun:test'

import { __private, inspectImageDigest } from '../docker'

afterEach(() => {
  __private.setSpawnSync()
})

describe('inspectImageDigest', () => {
  it('prefers the locally cached repo digest when available', () => {
    const spawnMock = ((command: Parameters<typeof Bun.spawnSync>[0], args, _opts) => {
      const commandString = typeof command === 'string' ? command : Array.prototype.join.call(command, ' ')
      const argString = Array.isArray(args) ? args.join(' ') : args ? String(args) : ''
      const joined = `${commandString} ${argString}`.trim()
      if (joined.startsWith('docker image inspect')) {
        return {
          exitCode: 0,
          stdout: Buffer.from('registry/repo@sha256:111\n'),
          stderr: new Uint8Array(),
        } as ReturnType<typeof Bun.spawnSync>
      }
      return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    __private.setSpawnSync(spawnMock)

    const digest = inspectImageDigest('registry/repo:tag')
    expect(digest).toBe('registry/repo@sha256:111')
  })

  it('falls back to docker imagetools when the local image is missing', () => {
    let imagetoolsCalled = false
    const spawnMock = ((command: Parameters<typeof Bun.spawnSync>[0], args, _opts) => {
      const commandString = typeof command === 'string' ? command : Array.prototype.join.call(command, ' ')
      const argString = Array.isArray(args) ? args.join(' ') : args ? String(args) : ''
      const joined = `${commandString} ${argString}`.trim()
      if (joined.startsWith('docker image inspect')) {
        return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
      }
      if (joined.startsWith('docker buildx imagetools inspect')) {
        imagetoolsCalled = true
        const payload = JSON.stringify({ digest: 'sha256:222' })
        return { exitCode: 0, stdout: Buffer.from(payload), stderr: new Uint8Array() } as ReturnType<
          typeof Bun.spawnSync
        >
      }
      return { exitCode: 1, stdout: new Uint8Array(), stderr: new Uint8Array() } as ReturnType<typeof Bun.spawnSync>
    }) as typeof Bun.spawnSync

    __private.setSpawnSync(spawnMock)

    const digest = inspectImageDigest('registry.example/froussard:latest')
    expect(imagetoolsCalled).toBe(true)
    expect(digest).toBe('registry.example/froussard@sha256:222')
  })
})
