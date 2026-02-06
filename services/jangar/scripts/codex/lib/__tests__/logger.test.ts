import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCodexLogger } from '../logger'

describe('createCodexLogger', () => {
  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  const originalDebug = console.debug

  let workspace: string
  let logPath: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'codex-logger-test-'))
    logPath = join(workspace, 'runtime.log')
    console.log = vi.fn()
    console.warn = vi.fn()
    console.error = vi.fn()
    console.debug = vi.fn()
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    console.debug = originalDebug
  })

  it('writes structured log entries with context and flushes the stream', async () => {
    const logger = await createCodexLogger({
      logPath,
      context: {
        stage: 'implementation',
        repository: 'owner/repo',
        run_id: 'abc123',
        'bad key': ' value ',
        empty: '',
        undefinedValue: undefined,
      },
    })

    logger.info('Starting run', { status: 'ready' })
    logger.error(new Error('boom'))

    await logger.flush()

    const raw = await readFile(logPath, 'utf8')
    const lines = raw.trim().split('\n')
    expect(lines).toHaveLength(2)

    const [infoEntry, errorEntry] = lines.map((line) => JSON.parse(line))
    expect(infoEntry.stage).toBe('implementation')
    expect(infoEntry.repository).toBe('owner/repo')
    expect(infoEntry.run_id).toBe('abc123')
    expect(infoEntry).not.toHaveProperty('bad key')
    expect(infoEntry.message).toContain('Starting run')
    expect(infoEntry.message).toContain('"status":"ready"')
    expect(typeof infoEntry.timestamp).toBe('string')

    expect(errorEntry.message).toContain('boom')

    // flush again to ensure idempotence
    await logger.flush()
  })

  it('truncates existing log file on new logger creation', async () => {
    const firstLogger = await createCodexLogger({ logPath })
    firstLogger.info('first run')
    await firstLogger.flush()

    const firstContents = (await readFile(logPath, 'utf8')).trim()
    expect(firstContents).toContain('first run')

    const secondLogger = await createCodexLogger({ logPath })
    secondLogger.info('second run')
    await secondLogger.flush()

    const after = (await readFile(logPath, 'utf8')).trim().split('\n')
    expect(after).toHaveLength(1)
    expect(after[0]).toContain('second run')
    expect(after[0]).not.toContain('first run')
  })
})
