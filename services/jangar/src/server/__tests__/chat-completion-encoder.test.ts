import { describe, expect, it } from 'vitest'

import { chatCompletionEncoderLive } from '~/server/chat-completion-encoder'
import type { ToolRenderer } from '~/server/chat-tool-event-renderer'

const createSession = (options: { includeUsage?: boolean; toolRenderer?: ToolRenderer } = {}) => {
  const toolRenderer: ToolRenderer =
    options.toolRenderer ??
    ({
      onToolEvent: () => [],
    } satisfies ToolRenderer)

  return chatCompletionEncoderLive.create({
    id: 'chatcmpl-test',
    created: 123,
    model: 'gpt-5.3-codex',
    includeUsage: options.includeUsage ?? false,
    toolRenderer,
    meta: { threadId: 'thread-1', turnNumber: 1, chatId: 'chat-1' },
  })
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

const getFirstChoice = (frame: Record<string, unknown>) => {
  const choices = frame.choices
  if (!Array.isArray(choices)) return null
  const first = choices[0]
  return asRecord(first)
}

const getDeltaRecord = (frame: Record<string, unknown>) => {
  const firstChoice = getFirstChoice(frame)
  if (!firstChoice) return null
  return asRecord(firstChoice.delta)
}

const getDeltaContent = (frame: Record<string, unknown>) => {
  const delta = getDeltaRecord(frame)
  if (!delta) return undefined
  const content = delta.content
  return typeof content === 'string' ? content : undefined
}

const getDeltaRole = (frame: Record<string, unknown>) => {
  const delta = getDeltaRecord(frame)
  if (!delta) return undefined
  const role = delta.role
  return typeof role === 'string' ? role : undefined
}

const getFinishReason = (frame: Record<string, unknown>) => {
  const firstChoice = getFirstChoice(frame)
  if (!firstChoice) return undefined
  const reason = firstChoice.finish_reason
  return typeof reason === 'string' ? reason : undefined
}

const collectContent = (frames: Record<string, unknown>[]) =>
  frames
    .map((frame) => getDeltaContent(frame))
    .filter((value): value is string => Boolean(value))
    .join('')

const isUsageChunk = (frame: Record<string, unknown>) => {
  const choices = frame.choices
  return Array.isArray(choices) && choices.length === 0 && asRecord(frame.usage) != null
}

const getCompletionTokens = (frame: Record<string, unknown>) => {
  const usage = asRecord(frame.usage)
  if (!usage) return undefined
  const value = usage.completion_tokens
  return typeof value === 'number' ? value : undefined
}

describe('chat completion encoder', () => {
  it('starts the first assistant message delta on a new line', () => {
    const session = createSession()
    const frames = session.onDelta({ type: 'message', delta: 'hi' })
    const content = collectContent(frames)
    expect(content.startsWith('\n')).toBe(true)
  })

  it('emits assistant role only once', () => {
    const session = createSession()

    const reasoningFrames = session.onDelta({ type: 'reasoning', delta: 'thinking' })
    const messageFrames = session.onDelta({ type: 'message', delta: 'ok' })

    expect(getDeltaRole(reasoningFrames[0] ?? {})).toBe('assistant')
    expect(getDeltaRole(messageFrames[0] ?? {})).toBeUndefined()
  })

  it('attaches thread metadata to emitted chunks', () => {
    const session = createSession()
    const frames = session.onDelta({ type: 'message', delta: 'hi' })

    type FrameMeta = { thread_id?: string; turn_number?: number }
    const first = (frames[0] as unknown as FrameMeta | undefined) ?? {}
    expect(first.thread_id).toBe('thread-1')
    expect(first.turn_number).toBe(1)

    session.setThreadMeta({ turnNumber: 2 })
    const frames2 = session.onDelta({ type: 'message', delta: 'again' })
    const second = (frames2[0] as unknown as FrameMeta | undefined) ?? {}
    expect(second.turn_number).toBe(2)
  })

  it('opens and closes command fences via tool actions', () => {
    const toolRenderer: ToolRenderer = {
      onToolEvent: () => [
        { type: 'openCommandFence' },
        { type: 'emitContent', content: 'hello' },
        { type: 'closeCommandFence' },
      ],
    }

    const session = createSession({ toolRenderer })
    const frames = session.onDelta({ type: 'tool', id: 'tool-1', toolKind: 'command' })

    const content = collectContent(frames)
    expect(content).toContain('```ts\n')
    expect(content).toContain('\n```\n\n')
  })

  it('renders plan updates as markdown todos', () => {
    const session = createSession()

    const frames = session.onDelta({
      type: 'plan',
      explanation: null,
      plan: [
        { step: 'Audit current thread-store behavior', status: 'completed' },
        { step: 'Create tagged thread-store service', status: 'in_progress' },
        { step: 'Wire chat handler to service', status: 'pending' },
      ],
    })

    const content = collectContent(frames)
    expect(content).toContain('**Plan**')
    expect(content).toContain('- [x] Audit current thread-store behavior')
    expect(content).toContain('- [ ] Create tagged thread-store service (in progress)')
    expect(content).toContain('- [ ] Wire chat handler to service')
    expect(content.endsWith('\n\n\n')).toBe(true)
  })

  it('renders rate limit updates as blockquote markdown', () => {
    const session = createSession()

    const frames = session.onDelta({
      type: 'rate_limits',
      rateLimits: {
        planType: 'pro',
        primary: { usedPercent: 42, windowDurationMins: 90, resetsAt: 1_735_000_000 },
        secondary: { usedPercent: 10, windowDurationMins: 60, resetsAt: 1_735_000_600 },
        credits: { hasCredits: true, unlimited: false, balance: '12.34' },
      },
    })

    const content = collectContent(frames)
    expect(content).toContain('> **Rate limits**')
    expect(content).toContain('> Plan: pro')
    expect(content).toContain('> Primary: 58% left · 1h 30m window · resets')
    expect(content).toContain('> Secondary: 90% left · 1h window · resets')
    expect(content).toContain('> Credits: has credits · balance 12.34')
  })

  it('emits usage and stop chunks on finalize when successful', () => {
    const session = createSession({ includeUsage: true })

    session.onDelta({ type: 'message', delta: 'hi' })
    session.onDelta({ type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } })

    const finalFrames = session.finalize({ aborted: false, turnFinished: true })

    const usageChunk = finalFrames.find(isUsageChunk)
    expect(usageChunk ? getCompletionTokens(usageChunk) : undefined).toBe(2)

    const stopChunk = finalFrames.find((frame) => getFinishReason(frame) === 'stop')
    expect(stopChunk).toBeTruthy()
  })

  it('emits final usage after upstream error and still finalizes', () => {
    const session = createSession({ includeUsage: true })

    const errorFrames = session.onDelta({ type: 'error', error: { message: 'boom' } })
    const messageFrames = session.onDelta({ type: 'message', delta: 'should-not-emit' })
    session.onDelta({ type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } })

    expect(errorFrames.length).toBe(1)
    expect(messageFrames.length).toBe(0)

    const finalFrames = session.finalize({ aborted: false, turnFinished: true })
    const stopChunk = finalFrames.find((frame) => getFinishReason(frame) === 'stop')
    expect(stopChunk).toBeTruthy()

    const usageChunk = finalFrames.find(isUsageChunk)
    expect(usageChunk ? getCompletionTokens(usageChunk) : undefined).toBe(1)
  })
})
