import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSystemPrompt } from '../codex-implement'

const ORIGINAL_ENV = { ...process.env }

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value
  }
}

describe('legacy codex-implement system prompt loading', () => {
  let workdir: string

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'codex-implement-legacy-'))
    delete process.env.CODEX_SYSTEM_PROMPT_PATH
    delete process.env.CODEX_SYSTEM_PROMPT_EXPECTED_HASH
    delete process.env.CODEX_SYSTEM_PROMPT_REQUIRED
  })

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true })
    resetEnv()
  })

  it('prefers CODEX_SYSTEM_PROMPT_PATH over payload systemPrompt', async () => {
    const systemPromptPath = join(workdir, 'system-prompt.txt')
    await writeFile(systemPromptPath, 'FROM FILE', 'utf8')
    process.env.CODEX_SYSTEM_PROMPT_PATH = systemPromptPath

    const loaded = loadSystemPrompt({ systemPrompt: 'FROM PAYLOAD' })
    expect(loaded.systemPrompt).toBe('FROM FILE')
  })

  it('throws when required system prompt is unavailable', () => {
    process.env.CODEX_SYSTEM_PROMPT_REQUIRED = 'true'
    process.env.CODEX_SYSTEM_PROMPT_PATH = join(workdir, 'missing-prompt.txt')

    expect(() => loadSystemPrompt({})).toThrow('System prompt is required but was not loaded')
  })

  it('throws when expected hash does not match loaded prompt', async () => {
    const systemPromptPath = join(workdir, 'system-prompt.txt')
    await writeFile(systemPromptPath, 'FROM FILE', 'utf8')
    process.env.CODEX_SYSTEM_PROMPT_PATH = systemPromptPath
    process.env.CODEX_SYSTEM_PROMPT_EXPECTED_HASH = createHash('sha256').update('DIFFERENT', 'utf8').digest('hex')

    expect(() => loadSystemPrompt({})).toThrow('System prompt hash mismatch')
  })

  it('accepts case-insensitive expected hash match', async () => {
    const systemPrompt = 'FROM FILE'
    const systemPromptPath = join(workdir, 'system-prompt.txt')
    await writeFile(systemPromptPath, systemPrompt, 'utf8')
    process.env.CODEX_SYSTEM_PROMPT_PATH = systemPromptPath
    process.env.CODEX_SYSTEM_PROMPT_EXPECTED_HASH = createHash('sha256').update(systemPrompt, 'utf8').digest('hex').toUpperCase()

    const loaded = loadSystemPrompt({})
    expect(loaded.systemPrompt).toBe(systemPrompt)
  })
})
