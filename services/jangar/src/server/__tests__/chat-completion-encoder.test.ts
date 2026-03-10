import { describe, expect, it } from 'vitest'

import { chatCompletionEncoderLive } from '~/server/chat-completion-encoder'
import type { ToolRenderer } from '~/server/chat-tool-event-renderer'
import { createSignedOpenWebUIRenderHref, validateOpenWebUIRenderSignature } from '~/server/openwebui-render-signing'

const createSession = (
  options: {
    includeUsage?: boolean
    toolRenderer?: ToolRenderer
    jangarRender?: {
      detailLinks?: {
        enabled: boolean
        createRenderRef?: (args: { renderId: string; kind: string; messageBindingHash: string; expiresAt: string }) => {
          id: string
          kind: string
          href: string
          expiresAt: string
        } | null
      }
      jangarEvent?: {
        enabled: boolean
        mode: 'rich-ui-v1'
      }
    }
  } = {},
) => {
  const toolRenderer: ToolRenderer =
    options.toolRenderer ??
    ({
      onToolEvent: () => [],
    } satisfies ToolRenderer)

  return chatCompletionEncoderLive.create({
    id: 'chatcmpl-test',
    created: 123,
    model: 'gpt-5.4',
    includeUsage: options.includeUsage ?? false,
    toolRenderer,
    jangarRender: options.jangarRender,
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

const getDeltaReasoningContent = (frame: Record<string, unknown>) => {
  const delta = getDeltaRecord(frame)
  if (!delta) return undefined
  const content = delta.reasoning_content
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

const collectReasoningContent = (frames: Record<string, unknown>[]) =>
  frames
    .map((frame) => getDeltaReasoningContent(frame))
    .filter((value): value is string => Boolean(value))
    .join('')

const resolveDetailLinks = (
  session: ReturnType<typeof createSession>,
  frames: Record<string, unknown>[],
  failedRenderIds?: string[],
) => {
  session.resolvePendingDetailLinks(frames, failedRenderIds)
  return frames
}

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

const getJangarEvent = (frame: Record<string, unknown>) => {
  const delta = getDeltaRecord(frame)
  return delta && asRecord(delta.jangar_event)
}

const getJangarEvents = (frames: Record<string, unknown>[]) =>
  frames.map(getJangarEvent).filter((value): value is Record<string, unknown> => value != null)

const getMessageEvents = (frames: Record<string, unknown>[]) =>
  frames
    .map((frame) => getJangarEvent(frame))
    .filter((event): event is Record<string, unknown> => event != null && event.lane === 'message')

const getMessageEvent = (frames: Record<string, unknown>[]) => {
  const events = getMessageEvents(frames)
  return events[0] ?? null
}

const extractRenderLinks = (content: string) =>
  Array.from(content.matchAll(/<(?<href>https?:\/\/[^>]+\/api\/openwebui\/rich-ui\/render\/[^>]+)>/g)).flatMap(
    (match) => {
      const href = match.groups?.href?.trim()
      return href ? [href] : []
    },
  )

const buildMockItems = (prefix: string, count: number) =>
  Array.from(
    { length: count },
    (_, index) => `${prefix} ${index + 1} with mock detail payload ${String(index + 1).padStart(4, '0')}`,
  )

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

  it('strips reasoning details markup from reasoning deltas', () => {
    const session = createSession()

    const frames = session.onDelta({
      type: 'reasoning',
      delta:
        '<details type="reasoning" done="true" duration="1"><summary>Thought for 1 second</summary>\n> Investigating\n</details>',
    })

    expect(collectReasoningContent(frames)).toBe('\n> Investigating\n')
    expect(collectContent(frames)).toBe('')
  })

  it('closes command fences before emitting reasoning deltas', () => {
    const toolRenderer: ToolRenderer = {
      onToolEvent: () => [{ type: 'openCommandFence' }, { type: 'emitContent', content: 'kubectl get pods\n' }],
    }

    const session = createSession({ toolRenderer })

    const toolFrames = session.onDelta({ type: 'tool', id: 'tool-1', toolKind: 'command' })
    const reasoningFrames = session.onDelta({
      type: 'reasoning',
      delta: '<details type="reasoning" done="true"><summary>Thought</summary>checking</details>',
    })

    expect(collectContent(toolFrames)).toContain('```ts\nkubectl get pods\n')
    expect(collectContent(reasoningFrames)).toContain('\n```\n\n')
    expect(collectReasoningContent(reasoningFrames)).toBe('checking')
  })

  it('strips reasoning details markup split across reasoning deltas', () => {
    const session = createSession()

    const firstFrames = session.onDelta({
      type: 'reasoning',
      delta: '<details type="reasoning" done="true"><summary>Thought for 1 second</summary>check',
    })
    const secondFrames = session.onDelta({
      type: 'reasoning',
      delta: 'ing</details>',
    })

    expect(collectReasoningContent(firstFrames)).toBe('check')
    expect(collectReasoningContent(secondFrames)).toBe('ing')
    expect(collectContent([...firstFrames, ...secondFrames])).toBe('')
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

  it('suppresses later rate limit updates in the same session even when values change', () => {
    const session = createSession()

    const firstFrames = session.onDelta({
      type: 'rate_limits',
      rateLimits: {
        planType: 'pro',
        primary: { usedPercent: 42, windowDurationMins: 90, resetsAt: 1_735_000_000 },
      },
    })

    const secondFrames = session.onDelta({
      type: 'rate_limits',
      rateLimits: {
        planType: 'pro',
        primary: { usedPercent: 57, windowDurationMins: 90, resetsAt: 1_735_000_900 },
        secondary: { usedPercent: 18, windowDurationMins: 60, resetsAt: 1_735_001_200 },
      },
    })

    expect(collectContent(firstFrames)).toContain('> **Rate limits**')
    expect(secondFrames).toHaveLength(0)
  })

  it('renders rate limits again for a new session', () => {
    const firstSession = createSession()
    const secondSession = createSession()

    firstSession.onDelta({
      type: 'rate_limits',
      rateLimits: {
        planType: 'pro',
        primary: { usedPercent: 42, windowDurationMins: 90, resetsAt: 1_735_000_000 },
      },
    })

    const secondFrames = secondSession.onDelta({
      type: 'rate_limits',
      rateLimits: {
        planType: 'pro',
        primary: { usedPercent: 57, windowDurationMins: 90, resetsAt: 1_735_000_900 },
      },
    })

    expect(collectContent(secondFrames)).toContain('> **Rate limits**')
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

  it('includes jangar_event only when rich rendering is enabled', () => {
    const disabled = createSession({ jangarRender: { jangarEvent: { enabled: false, mode: 'rich-ui-v1' } } })
    const disabledFrames = disabled.onDelta({ type: 'message', delta: 'hi' })
    expect(getJangarEvents(disabledFrames)).toHaveLength(0)

    const enabled = createSession({ jangarRender: { jangarEvent: { enabled: true, mode: 'rich-ui-v1' } } })
    const enabledFrames = enabled.onDelta({ type: 'message', delta: 'hi' })
    expect(getJangarEvents(enabledFrames).length).toBe(1)
  })

  it('keeps full assistant message text inline even when detail links are enabled', () => {
    const session = createSession({
      jangarRender: {
        detailLinks: {
          enabled: true,
          createRenderRef: ({ renderId, kind, expiresAt }) => ({
            id: renderId,
            kind,
            href: `https://jangar.test/api/openwebui/rich-ui/render/${renderId}`,
            expiresAt,
          }),
        },
      },
    })

    const frames = session.onDelta({ type: 'message', delta: 'x'.repeat(9_000) })
    expect(collectContent(frames)).toContain('x'.repeat(9_000))
    expect(session.takePendingRenderBlobs()).toHaveLength(0)
  })

  it('stages detail links for oversized command transcripts without requiring jangar_event', () => {
    const session = createSession({
      jangarRender: {
        detailLinks: {
          enabled: true,
          createRenderRef: ({ renderId, kind, expiresAt }) => ({
            id: renderId,
            kind,
            href: `https://jangar.test/api/openwebui/rich-ui/render/${renderId}`,
            expiresAt,
          }),
        },
      },
    })

    session.onDelta({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'started',
      title: '/bin/bash -lc bun test packages/codex',
    })
    const frames = session.onDelta({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'completed',
      title: '/bin/bash -lc bun test packages/codex',
      data: { aggregatedOutput: 'x'.repeat(9_000), exitCode: 1 },
    })
    resolveDetailLinks(session, frames)

    expect(collectContent(frames)).toContain('Open full transcript')
    expect(getJangarEvents(frames)).toHaveLength(0)
    const blobs = session.takePendingRenderBlobs()
    expect(blobs).toHaveLength(1)
    expect(blobs[0]?.kind).toBe('command')
    expect(String(blobs[0]?.payload.text)).toContain('x'.repeat(9_000))
  })

  it('keeps transcript detail links valid when jangar_event and detail links are both enabled', () => {
    const baseUrl = 'https://jangar.test'
    const secret = 'test-openwebui-render-secret'
    const session = createSession({
      jangarRender: {
        detailLinks: {
          enabled: true,
          createRenderRef: ({ renderId, kind, messageBindingHash, expiresAt }) => ({
            id: renderId,
            kind,
            href: createSignedOpenWebUIRenderHref({
              baseUrl,
              renderId,
              kind,
              expiresAt,
              messageBindingHash,
              secret,
            }),
            expiresAt,
          }),
        },
        jangarEvent: { enabled: true, mode: 'rich-ui-v1' },
      },
    })

    const frames = [
      ...session.onDelta({
        type: 'tool',
        toolKind: 'mcp',
        id: 'mcp-1',
        status: 'completed',
        title: 'catalog.search',
        detail: 'Collected catalog inventory.',
        data: {
          arguments: { collection: 'catalog', pageSize: 20 },
          result: {
            summary: 'Catalog inventory collected.',
            items: buildMockItems('catalog item', 360),
          },
        },
      }),
      ...session.onDelta({
        type: 'tool',
        toolKind: 'dynamicTool',
        id: 'dynamic-1',
        status: 'completed',
        title: 'audit.report',
        detail: 'Generated audit findings for the mock activity.',
        data: {
          tool: 'audit.report',
          arguments: { scope: 'openwebui-rich-activity' },
          result: {
            summary: 'Audit output complete.',
            items: buildMockItems('audit item', 360),
          },
          success: true,
        },
      }),
    ]
    resolveDetailLinks(session, frames)

    const content = collectContent(frames)
    const detailLinks = extractRenderLinks(content)
    expect(detailLinks).toHaveLength(2)

    const blobsById = new Map(session.takePendingRenderBlobs().map((blob) => [blob.renderId, blob]))
    for (const href of detailLinks) {
      const url = new URL(href)
      const renderId = url.pathname.split('/').at(-1) ?? ''
      const signature = url.searchParams.get('sig') ?? ''
      const blob = blobsById.get(renderId)

      expect(blob).toBeTruthy()
      expect(
        validateOpenWebUIRenderSignature({
          renderId: String(blob?.renderId),
          kind: String(blob?.kind),
          expiresAt: String(blob?.expiresAt),
          messageBindingHash: String(blob?.messageBindingHash),
          signature,
          secret,
        }),
      ).toBe(true)
    }
  })

  it('aligns detail-link expiry with the render blob retention horizon', () => {
    const session = createSession({
      jangarRender: {
        detailLinks: {
          enabled: true,
          createRenderRef: ({ renderId, kind, expiresAt }) => ({
            id: renderId,
            kind,
            href: `https://jangar.test/api/openwebui/rich-ui/render/${renderId}`,
            expiresAt,
          }),
        },
      },
    })

    session.onDelta({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-ttl',
      status: 'started',
      title: 'bun test packages/codex',
    })
    session.onDelta({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-ttl',
      status: 'completed',
      title: 'bun test packages/codex',
      data: { aggregatedOutput: 'x'.repeat(9_000), exitCode: 1 },
    })

    const [blob] = session.takePendingRenderBlobs()
    const expiresAtMs = new Date(String(blob?.expiresAt)).getTime()
    const diffMs = expiresAtMs - Date.now()

    expect(diffMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    expect(diffMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 60_000)
  })

  it('emits deterministic jangar event metadata for message text', () => {
    const session = createSession({
      jangarRender: { jangarEvent: { enabled: true, mode: 'rich-ui-v1' } },
    })
    const frames = session.onDelta({ type: 'message', delta: 'hi' })
    const event = getMessageEvent(frames)
    expect(event).toBeTruthy()

    expect(event?.version).toBe('v1')
    expect(event?.seq).toBe(1)
    expect(event?.logicalId).toBe('message:assistant')
    expect(event?.revision).toBe(1)
    expect(event?.lane).toBe('message')
    expect(event?.op).toBe('append_text')
    expect(event?.payload).toEqual({ text: '\nhi' })
    expect(event?.preview).toEqual({ title: 'assistant', badge: 'message' })
  })

  it('keeps seq monotonic and revision monotonic per logicalId', () => {
    const session = createSession({
      jangarRender: { jangarEvent: { enabled: true, mode: 'rich-ui-v1' } },
    })
    const first = session.onDelta({ type: 'message', delta: 'hi' })
    const second = session.onDelta({ type: 'message', delta: ' there' })

    const events = getMessageEvents([...first, ...second])
    expect(events).toHaveLength(2)
    expect(events[0]?.seq).toBe(1)
    expect(events[0]?.revision).toBe(1)
    expect(events[1]?.seq).toBe(2)
    expect(events[1]?.revision).toBe(2)
  })

  it('emits tool events with deterministic logicalId and tool lane', () => {
    const session = createSession({
      jangarRender: { jangarEvent: { enabled: true, mode: 'rich-ui-v1' } },
      toolRenderer: {
        onToolEvent: () => [],
      },
    })

    const frames = session.onDelta({
      type: 'tool',
      toolKind: 'command',
      id: 'cmd-1',
      status: 'started',
      title: 'run cmd',
      delta: 'echo hi',
    })

    const events = getJangarEvents(frames).filter((event) => event.lane === 'tool')
    expect(events).toHaveLength(2)
    expect(events[0]?.logicalId).toBe('tool:command-cmd-1')
    expect(events[0]?.op).toBe('merge')
    expect(events[1]?.op).toBe('append_text')
  })

  it('does not include tool_calls in message deltas', () => {
    const session = createSession({
      jangarRender: { jangarEvent: { enabled: true, mode: 'rich-ui-v1' } },
    })
    const frames = session.onDelta({ type: 'message', delta: 'hi' })
    const delta = getDeltaRecord(frames[0] ?? {})
    expect(delta?.tool_calls).toBeUndefined()
  })
})
