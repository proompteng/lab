import { describe, expect, it } from 'bun:test'

import { buildPrompt, estimateTokens, formatToolDelta, stripAnsi } from './chat-completion'
import { defaultCodexModel, isSupportedModel, resolveModel, supportedModels } from './models'

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\u001b[32mhello\u001b[0m world')).toBe('hello world')
  })
})

describe('resolveModel', () => {
  it('falls back to the default model when unspecified or meta-orchestrator', () => {
    expect(resolveModel(undefined)).toBe(defaultCodexModel)
    expect(resolveModel('meta-orchestrator')).toBe(defaultCodexModel)
  })

  it('returns the requested model when provided', () => {
    expect(resolveModel(supportedModels[1])).toBe(supportedModels[1])
  })

  it('falls back to default for unsupported models', () => {
    expect(resolveModel('not-a-model')).toBe(defaultCodexModel)
  })
})

describe('isSupportedModel', () => {
  it('validates known ids', () => {
    expect(isSupportedModel(supportedModels[0])).toBe(true)
    expect(isSupportedModel('unknown')).toBe(false)
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
