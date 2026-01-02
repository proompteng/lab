import { appendFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const decodeOutput = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return null
  if (!('type' in payload) || !('data' in payload)) return null
  const record = payload as { type?: string; data?: string }
  if (record.type !== 'output' || typeof record.data !== 'string') return null
  return Buffer.from(record.data, 'base64').toString('utf8')
}

describe('TerminalLogTailer', () => {
  const previousEnv = { ...process.env }
  let logDir = ''

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), 'jangar-terminal-log-'))
    process.env.JANGAR_TERMINAL_LOG_DIR = logDir
    process.env.JANGAR_TERMINAL_LOG_MAX_BYTES = '256'
    process.env.JANGAR_TERMINAL_LOG_RETAIN_BYTES = '128'
    vi.resetModules()
  })

  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, previousEnv)
    if (logDir) {
      await rm(logDir, { recursive: true, force: true })
    }
  })

  test('streams output after log trim', async () => {
    const sessionId = 'jangar-terminal-log-test'
    const { getTerminalLogPath } = await import('./terminals')
    const { TerminalLogTailer } = await import('./terminal-log-tailer')

    const logPath = await getTerminalLogPath(sessionId)
    const outputs: string[] = []

    const tailer = new TerminalLogTailer(sessionId, { watch: false, minPollIntervalMs: 5, maxPollIntervalMs: 10 })
    await tailer.addPeer({
      send: (payload) => {
        const decoded = decodeOutput(payload)
        if (decoded) outputs.push(decoded)
      },
    })

    await appendFile(logPath, 'alpha-'.repeat(24))
    await tailer.readNow()

    await appendFile(logPath, 'beta-'.repeat(40))
    await tailer.readNow()

    await appendFile(logPath, 'gamma')
    await tailer.readNow()

    tailer.dispose()

    const combined = outputs.join('')
    expect(combined).toContain('alpha-')
    expect(combined).toContain('beta-')
    expect(combined).toContain('gamma')
  })
})
