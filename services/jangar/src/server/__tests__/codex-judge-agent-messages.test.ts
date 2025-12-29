import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CodexJudgeStore } from '../codex-judge-store'

const globalState = globalThis as typeof globalThis & {
  __codexJudgeStoreMock?: CodexJudgeStore
}

const buildStoreMock = (): CodexJudgeStore => ({
  upsertRunComplete: vi.fn(),
  attachNotify: vi.fn(),
  updateCiStatus: vi.fn(),
  updateReviewStatus: vi.fn(),
  updateDecision: vi.fn(),
  updateRunStatus: vi.fn(),
  updateRunPrompt: vi.fn(),
  updateRunPrInfo: vi.fn(),
  upsertArtifacts: vi.fn(),
  listRunsByStatus: vi.fn(),
  claimRerunSubmission: vi.fn(),
  updateRerunSubmission: vi.fn(),
  getRunByWorkflow: vi.fn(),
  getRunById: vi.fn(),
  listRunsByIssue: vi.fn(),
  getRunHistory: vi.fn(),
  getLatestPromptTuningByIssue: vi.fn(),
  createPromptTuning: vi.fn(),
  close: vi.fn(),
})

let __private: Awaited<typeof import('../codex-judge')>['__private'] | null = null

const getPrivate = async () => {
  if (!__private) {
    __private = (await import('../codex-judge')).__private
  }
  if (!__private) {
    throw new Error('Missing codex judge private API')
  }
  return __private
}

beforeEach(() => {
  globalState.__codexJudgeStoreMock = buildStoreMock()
})

afterEach(() => {
  delete globalState.__codexJudgeStoreMock
  __private = null
  vi.resetModules()
})

describe('agent message parsing', () => {
  it('parses agent messages from events', async () => {
    const payload = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello' } }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', content: [{ text: 'foo' }, { delta: 'bar' }] },
      }),
      'not json',
      JSON.stringify({ type: 'item.completed', item: { type: 'tool', text: 'skip' } }),
    ].join('\n')

    const privateApi = await getPrivate()
    const messages = privateApi.parseAgentMessagesFromEvents(payload)

    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('hello')
    expect(messages[0].attrs).toEqual(expect.objectContaining({ artifact: 'implementation-events', line: 1 }))
    expect(messages[1].content).toBe('foobar')
    expect(messages[1].attrs).toEqual(expect.objectContaining({ artifact: 'implementation-events', line: 2 }))
  })

  it('parses agent log lines', async () => {
    const payload = 'first line\n\nsecond line\n'

    const privateApi = await getPrivate()
    const messages = privateApi.parseAgentMessagesFromLog(payload)

    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('first line')
    expect(messages[0].attrs).toEqual(expect.objectContaining({ artifact: 'implementation-agent-log', line: 1 }))
    expect(messages[1].content).toBe('second line')
    expect(messages[1].attrs).toEqual(expect.objectContaining({ artifact: 'implementation-agent-log', line: 3 }))
  })
})
