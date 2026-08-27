import { describe, expect, test } from 'bun:test'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import {
  appendCodexEvent,
  codexApprovalOptions,
  codexEventDisplayText,
  codexThreadStateFromThread,
  codexTranscriptFromThread,
  parseCodexEvent,
} from './codex-events'

const event: TengriCodexEvent = {
  sequence: 7,
  kind: 'assistant-text',
  method: 'item/completed',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  text: 'Ready',
  approvalId: '',
  rawJson: '{}',
}

describe('Codex event replay', () => {
  test('deduplicates an event replayed after an SSE reconnect', () => {
    const current = [event]
    expect(appendCodexEvent(current, { ...event })).toBe(current)
  })

  test('keeps the newest 500 distinct events', () => {
    const current = Array.from({ length: 500 }, (_, sequence) => ({ ...event, sequence }))
    const next = appendCodexEvent(current, { ...event, sequence: 500 })
    expect(next).toHaveLength(500)
    expect(next[0]?.sequence).toBe(1)
    expect(next.at(-1)?.sequence).toBe(500)
  })

  test('coalesces camel-case app-server deltas by authoritative item ID', () => {
    const first = {
      ...event,
      method: 'item/commandExecution/outputDelta',
      kind: 'tool-output' as const,
      text: 'Hel',
      sequence: 1,
    }
    const second = { ...first, text: 'lo', sequence: 2 }
    expect(appendCodexEvent(appendCodexEvent([], first), second)).toEqual([{ ...second, text: 'Hello' }])
  })

  test('replaces streamed text with the authoritative completed item', () => {
    const delta = { ...event, method: 'item/agentMessage/delta', text: 'Hel', sequence: 1 }
    const completed = { ...event, method: 'item/completed', text: 'Hello', sequence: 2 }
    expect(appendCodexEvent([delta], completed)).toEqual([completed])
  })

  test('bounds coalesced UTF-8 deltas without breaking the completed replacement', () => {
    const first = {
      ...event,
      method: 'item/agentMessage/delta',
      text: '😀'.repeat(131_100),
      sequence: 1,
    }
    const second = { ...first, text: 'more', sequence: 2 }
    const coalesced = appendCodexEvent(appendCodexEvent([], first), second)[0]!
    expect(new TextEncoder().encode(coalesced.text).byteLength).toBeLessThanOrEqual(512 << 10)
    expect(coalesced.text.endsWith('… output truncated …')).toBe(true)
    expect(appendCodexEvent([coalesced], { ...event, sequence: 3, text: 'Complete' })).toEqual([
      { ...event, sequence: 3, text: 'Complete' },
    ])
  })
})

describe('Codex event decoding', () => {
  test('accepts a bounded typed server event', () => {
    expect(parseCodexEvent(JSON.stringify(event))).toEqual(event)
  })

  test('rejects malformed and unbounded events', () => {
    expect(parseCodexEvent('{')).toBeNull()
    expect(parseCodexEvent(JSON.stringify({ ...event, sequence: -1 }))).toBeNull()
    expect(parseCodexEvent(JSON.stringify({ ...event, kind: 'made-up' }))).toBeNull()
    expect(parseCodexEvent(JSON.stringify({ ...event, method: '' }))).toBeNull()
    expect(parseCodexEvent(JSON.stringify({ ...event, text: 'x'.repeat((512 << 10) + 1) }))?.text).toBe('')
  })

  test('derives bounded approval and usage summaries without exposing raw payloads', () => {
    expect(
      codexEventDisplayText({
        ...event,
        kind: 'approval',
        text: '',
        rawJson: JSON.stringify({ params: { reason: 'Needs network', command: 'git fetch', cwd: '/workspace' } }),
      }),
    ).toBe('Needs network\nCommand: git fetch\nWorking directory: /workspace')
    expect(
      codexEventDisplayText({
        ...event,
        kind: 'usage',
        text: '',
        rawJson: JSON.stringify({
          params: { tokenUsage: { total: { inputTokens: 12, outputTokens: 4 } } },
        }),
      }),
    ).toBe('Tokens: 12 input · 4 output')
    expect(
      codexEventDisplayText({
        ...event,
        kind: 'usage',
        text: '',
        rawJson: JSON.stringify({
          params: { rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300 } } },
        }),
      }),
    ).toBe('Primary: 37% used / 300 min')
  })

  test('presents only approval decisions offered by the app-server', () => {
    expect(
      codexApprovalOptions({
        ...event,
        method: 'item/commandExecution/requestApproval',
        kind: 'approval',
        rawJson: JSON.stringify({ params: { availableDecisions: ['accept', 'cancel'] } }),
      }),
    ).toEqual(['approve-once', 'deny'])
    expect(
      codexApprovalOptions({
        ...event,
        method: 'item/commandExecution/requestApproval',
        kind: 'approval',
        rawJson: JSON.stringify({ params: { availableDecisions: [{ acceptWithExecpolicyAmendment: {} }] } }),
      }),
    ).toEqual([])
  })
})

describe('Codex thread restoration', () => {
  test('restores persisted typed items in thread order', () => {
    const transcript = codexTranscriptFromThread(
      JSON.stringify({
        thread: {
          turns: [
            {
              items: [
                { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Build it' }] },
                { id: 'assistant-1', type: 'agentMessage', text: 'Done' },
                { id: 'plan-1', type: 'plan', text: '- [x] Build it' },
                { id: 'reasoning-1', type: 'reasoning', summary: ['Checked the result'], content: [] },
                { id: 'command-1', type: 'commandExecution', command: 'bun test', aggregatedOutput: '12 pass' },
                {
                  id: 'file-1',
                  type: 'fileChange',
                  changes: [{ path: '/workspace/app.ts', diff: '+export {}' }],
                },
              ],
            },
          ],
        },
      }),
    )
    expect(transcript).toEqual([
      { id: 'user-1', kind: 'user-message', text: 'Build it' },
      { id: 'assistant-1', kind: 'assistant-text', text: 'Done' },
      { id: 'plan-1', kind: 'plan', text: '- [x] Build it' },
      { id: 'reasoning-1', kind: 'reasoning-summary', text: 'Checked the result' },
      { id: 'command-1', kind: 'tool-output', text: '12 pass' },
      { id: 'file-1', kind: 'file-diff', text: '+export {}' },
    ])
  })

  test('ignores invalid history and duplicate item IDs', () => {
    expect(codexTranscriptFromThread('{')).toEqual([])
    expect(
      codexTranscriptFromThread(
        JSON.stringify({
          thread: {
            turns: [
              { items: [{ id: 'same', type: 'agentMessage', text: 'First' }] },
              { items: [{ id: 'same', type: 'agentMessage', text: 'Duplicate' }] },
            ],
          },
        }),
      ),
    ).toEqual([{ id: 'same', kind: 'assistant-text', text: 'First' }])
  })

  test('restores the in-progress turn and supported persisted tool items', () => {
    const state = codexThreadStateFromThread(
      JSON.stringify({
        thread: {
          turns: [
            {
              id: 'turn-active',
              status: 'inProgress',
              items: [
                {
                  id: 'search-1',
                  type: 'webSearch',
                  query: 'Kata Firecracker',
                  action: { type: 'search', query: 'Kata Firecracker', queries: null },
                },
                { id: 'image-1', type: 'imageView', path: '/workspace/screenshot.png' },
                {
                  id: 'generated-1',
                  type: 'imageGeneration',
                  status: 'completed',
                  result: 'data:image/png;base64,secret',
                  revisedPrompt: 'A polished Tahoe desktop',
                  savedPath: '/workspace/result.png',
                },
                {
                  id: 'collab-1',
                  type: 'collabAgentToolCall',
                  tool: 'spawnAgent',
                  status: 'failed',
                  prompt: 'This input should not be rendered as output',
                  agentsStates: {
                    'thread-b': { status: 'failed', message: 'Validation failed' },
                    'thread-a': { status: 'completed', message: 'PR opened' },
                  },
                },
                {
                  id: 'dynamic-1',
                  type: 'dynamicToolCall',
                  namespace: 'media',
                  tool: 'render',
                  contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,secret' }],
                },
              ],
            },
          ],
        },
      }),
    )
    expect(state.activeTurnId).toBe('turn-active')
    expect(state.items).toEqual([
      { id: 'search-1', kind: 'tool-output', text: 'Web search: Kata Firecracker' },
      { id: 'image-1', kind: 'tool-call', text: 'Viewed image: /workspace/screenshot.png' },
      {
        id: 'generated-1',
        kind: 'tool-output',
        text: 'Image generation: completed\nPrompt: A polished Tahoe desktop\nResult: data:image/png;base64,secret\nSaved to /workspace/result.png',
      },
      {
        id: 'collab-1',
        kind: 'tool-output',
        text: 'Agent collaboration spawnAgent: failed\nthread-a: completed — PR opened\nthread-b: failed — Validation failed',
      },
      { id: 'dynamic-1', kind: 'tool-output', text: '[Image output]' },
    ])
  })

  test('keeps an unfinished persisted web search as an operation', () => {
    expect(
      codexTranscriptFromThread(
        JSON.stringify({
          thread: {
            turns: [
              {
                items: [{ id: 'search-pending', type: 'webSearch', query: 'Kata Firecracker', action: null }],
              },
            ],
          },
        }),
      ),
    ).toEqual([{ id: 'search-pending', kind: 'tool-call', text: 'Web search: Kata Firecracker' }])
  })
})
