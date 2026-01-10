import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from 'vitest'

import { getTerminalPtyManager } from './terminal-pty-manager'

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
  it('replays buffered output on reconnect', async () => {
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
