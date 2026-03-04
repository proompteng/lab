import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { CodexAppServerClientMock, ctorCalls, stopMock } = vi.hoisted(() => {
  const calls: Array<Record<string, unknown>> = []
  const stop = vi.fn()
  const mock = vi.fn(function (this: unknown, options: Record<string, unknown>) {
    calls.push(options)
    return {
      stop,
    }
  })
  return {
    CodexAppServerClientMock: mock,
    ctorCalls: calls,
    stopMock: stop,
  }
})

vi.mock('@proompteng/codex', () => ({
  CodexAppServerClient: CodexAppServerClientMock,
}))

import { getCodexClient, resetCodexClient } from '~/server/codex-client'

const readSummaryConfig = () => {
  const options = ctorCalls.at(-1)
  if (!options) throw new Error('codex client constructor was not called')
  const threadConfig = options.threadConfig as Record<string, unknown>
  return threadConfig.model_reasoning_summary
}

describe('codex-client reasoning summary config', () => {
  beforeEach(() => {
    ctorCalls.length = 0
    stopMock.mockReset()
    delete process.env.JANGAR_CODEX_MODEL_REASONING_SUMMARY
    resetCodexClient()
  })

  afterEach(() => {
    delete process.env.JANGAR_CODEX_MODEL_REASONING_SUMMARY
    resetCodexClient()
  })

  it('defaults model reasoning summary to none', async () => {
    await Effect.runPromise(getCodexClient())
    expect(readSummaryConfig()).toBe('none')
  })

  it('accepts valid model reasoning summary overrides', async () => {
    process.env.JANGAR_CODEX_MODEL_REASONING_SUMMARY = 'concise'
    await Effect.runPromise(getCodexClient())
    expect(readSummaryConfig()).toBe('concise')
  })

  it('falls back to none for invalid model reasoning summary values', async () => {
    process.env.JANGAR_CODEX_MODEL_REASONING_SUMMARY = 'invalid'
    await Effect.runPromise(getCodexClient())
    expect(readSummaryConfig()).toBe('none')
  })
})
