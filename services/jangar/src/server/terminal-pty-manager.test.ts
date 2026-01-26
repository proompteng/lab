import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() =>
  vi.fn(() => {
    const dataListeners = new Set<(data: string) => void>()
    const exitListeners = new Set<(event: { exitCode: number | null; signal: number | null }) => void>()
    return {
      write: (data: string) => {
        for (const listener of dataListeners) listener(data)
      },
      resize: () => {},
      kill: () => {
        for (const listener of exitListeners) listener({ exitCode: 0, signal: null })
      },
      onData: (listener: (data: string) => void) => {
        dataListeners.add(listener)
      },
      onExit: (listener: (event: { exitCode: number | null; signal: number | null }) => void) => {
        exitListeners.add(listener)
      },
    }
  }),
)

vi.mock('node-pty', () => ({
  spawn: spawnMock,
}))

import { getTerminalPtyManager, resetTerminalPtyManager } from './terminal-pty-manager'

const decodeFrame = (data: Uint8Array) => {
  if (data.length < 6 || data[0] !== 1) return null
  const text = new TextDecoder().decode(data.subarray(5))
  return text
}

const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for condition')
}

describe('TerminalPtyManager', () => {
  it('starts an interactive shell when using script fallback', async () => {
    resetTerminalPtyManager()
    const originalBun = (globalThis as { Bun?: unknown }).Bun
    const originalPtyMode = process.env.JANGAR_PTY_MODE
    const originalScriptBin = process.env.SCRIPT_BIN

    const bunSpawn = vi.fn(() => ({
      stdin: { write: vi.fn() },
      stdout: null,
      stderr: null,
      pid: 123,
      exited: Promise.resolve(0),
      kill: vi.fn(),
    }))

    ;(globalThis as { Bun?: unknown }).Bun = { spawn: bunSpawn }
    process.env.JANGAR_PTY_MODE = 'script'
    process.env.SCRIPT_BIN = '/usr/bin/script'

    const manager = getTerminalPtyManager({ idleTimeoutMs: 0 })
    const worktreePath = await mkdtemp(join(tmpdir(), 'jangar-terminal-test-'))
    const sessionId = `jangar-terminal-test-${Date.now()}`
    manager.startSession({ sessionId, worktreePath, worktreeName: 'test' })

    expect(bunSpawn).toHaveBeenCalled()
    const calls = bunSpawn.mock.calls as unknown as Array<[string[]]>
    const args = calls[0]?.[0] ?? []
    expect(Array.isArray(args)).toBe(true)
    expect(args.join(' ')).toContain('-l -i')

    resetTerminalPtyManager()
    ;(globalThis as { Bun?: unknown }).Bun = originalBun
    if (originalPtyMode === undefined) {
      delete process.env.JANGAR_PTY_MODE
    } else {
      process.env.JANGAR_PTY_MODE = originalPtyMode
    }
    if (originalScriptBin === undefined) {
      delete process.env.SCRIPT_BIN
    } else {
      process.env.SCRIPT_BIN = originalScriptBin
    }
  })

  it('starts an interactive shell when using native PTY', async () => {
    resetTerminalPtyManager()
    const originalPtyMode = process.env.JANGAR_PTY_MODE
    process.env.JANGAR_PTY_MODE = 'native'
    spawnMock.mockClear()

    try {
      const manager = getTerminalPtyManager({ idleTimeoutMs: 0 })
      const worktreePath = await mkdtemp(join(tmpdir(), 'jangar-terminal-test-'))
      const sessionId = `jangar-terminal-test-${Date.now()}`
      manager.startSession({ sessionId, worktreePath, worktreeName: 'test' })

      expect(spawnMock).toHaveBeenCalled()
      const call = spawnMock.mock.calls[0] as unknown as [string, string[]] | undefined
      const args = call?.[1] ?? []
      expect(args).toEqual(['-l', '-i'])
    } finally {
      resetTerminalPtyManager()
      if (originalPtyMode === undefined) {
        delete process.env.JANGAR_PTY_MODE
      } else {
        process.env.JANGAR_PTY_MODE = originalPtyMode
      }
    }
  })

  it('replays buffered output on reconnect', async () => {
    resetTerminalPtyManager()
    const manager = getTerminalPtyManager({ bufferBytes: 256 * 1024, idleTimeoutMs: 0 })
    const worktreePath = await mkdtemp(join(tmpdir(), 'jangar-terminal-test-'))
    const sessionId = `jangar-terminal-test-${Date.now()}`
    manager.startSession({ sessionId, worktreePath, worktreeName: 'test' })

    const output: string[] = []
    const peer = {
      send: (payload: string | Uint8Array) => {
        if (typeof payload === 'string') return
        const decoded = decodeFrame(payload)
        if (decoded) output.push(decoded)
      },
      close: () => {},
    }

    manager.attach(sessionId, peer, { token: 'token-a', since: 0 })
    manager.handleInput(sessionId, new TextEncoder().encode('printf "hello-from-terminal"\n'))

    await waitFor(() => output.join('').includes('hello-from-terminal'))

    manager.detach(sessionId, 'token-a')

    const replay: string[] = []
    const peer2 = {
      send: (payload: string | Uint8Array) => {
        if (typeof payload === 'string') return
        const decoded = decodeFrame(payload)
        if (decoded) replay.push(decoded)
      },
      close: () => {},
    }

    manager.attach(sessionId, peer2, { token: 'token-b', since: 0 })

    await waitFor(() => replay.join('').includes('hello-from-terminal'))

    manager.terminate(sessionId)
  })
})
