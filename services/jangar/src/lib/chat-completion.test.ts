import { describe, expect, it } from 'bun:test'

import { buildPrompt, deriveTitle, estimateTokens, formatToolDelta, resolveModel, stripAnsi } from './chat-completion'

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\u001b[32mhello\u001b[0m world')).toBe('hello world')
  })
})

describe('resolveModel', () => {
  it('falls back to the default model when unspecified or meta-orchestrator', () => {
    const defaultModel = resolveModel(undefined)

    expect(resolveModel('meta-orchestrator')).toBe(defaultModel)
    expect(defaultModel).toBeTruthy()
  })

  it('returns the requested model when provided', () => {
    expect(resolveModel('gpt-4.1')).toBe('gpt-4.1')
  })
})

describe('buildPrompt', () => {
  it('serializes messages into the codex prompt format', () => {
    const prompt = buildPrompt([
      { role: 'system', content: { topic: 'tests' } },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])

    expect(prompt).toBe('system: {"topic":"tests"}\nuser: hello\nassistant: hi')
  })
})

describe('deriveTitle', () => {
  it('uses the chat id when provided', () => {
    expect(deriveTitle('abc-123', [])).toBe('openwebui:abc-123')
  })

  it('derives a title from the first user message and truncates to 60 characters', () => {
    const long = 'a'.repeat(80)

    expect(deriveTitle(undefined, [{ role: 'user', content: long }])).toBe(long.slice(0, 60))
  })

  it('defaults to a generic label when no messages exist', () => {
    expect(deriveTitle(undefined, [])).toBe('OpenWebUI chat')
  })
})

describe('estimateTokens', () => {
  it('returns at least one token for empty input', () => {
    expect(estimateTokens('')).toBe(1)
  })

  it('approximates tokens at a 4:1 character ratio', () => {
    expect(estimateTokens('a'.repeat(20))).toBe(5)
  })
})

describe('formatToolDelta', () => {
  it('wraps streaming command output in a TypeScript code fence', () => {
    const delta: Parameters<typeof formatToolDelta>[0] = {
      type: 'tool',
      id: 'tool-1',
      status: 'delta',
      toolKind: 'command',
      title: 'Run tests',
      detail: '\u001b[32mpnpm test\u001b[0m',
    }

    expect(formatToolDelta(delta)).toBe('\n\n```ts\npnpm test\n```\n')
  })

  it('renders non-delta command updates as bash fences with normalized status', () => {
    const delta: Parameters<typeof formatToolDelta>[0] = {
      type: 'tool',
      id: 'tool-2',
      status: 'completed',
      toolKind: 'command',
      title: 'Run tests',
      detail: '2.3s',
    }

    expect(formatToolDelta(delta)).toBe('\n```bash\n[end] Run tests in 2.3s\n```\n')
  })

  it('passes through non-command deltas without wrapping', () => {
    const delta: Parameters<typeof formatToolDelta>[0] = {
      type: 'tool',
      id: 'tool-3',
      status: 'delta',
      toolKind: 'mcp',
      title: 'search',
      detail: 'indexing',
    }

    expect(formatToolDelta(delta)).toBe('indexing')
  })
})
