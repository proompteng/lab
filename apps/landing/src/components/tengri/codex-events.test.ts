import { describe, expect, test } from 'bun:test'
import type { TengriCodexEvent } from '@/lib/tengri/types'
import { appendCodexEvent, codexEventDisplayText, codexTranscriptFromThread, parseCodexEvent } from './codex-events'

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

  test('decodes base64 command deltas before coalescing them', () => {
    const first = {
      ...event,
      method: 'item/commandExecution/outputDelta',
      kind: 'tool-output' as const,
      text: 'aGk=',
      sequence: 1,
    }
    const second = { ...first, text: 'IHRoZXJl', sequence: 2 }
    expect(appendCodexEvent(appendCodexEvent([], first), second)).toEqual([{ ...second, text: 'hi there' }])
  })

  test('replaces streamed text with the authoritative completed item', () => {
    const delta = { ...event, method: 'item/agentMessage/delta', text: 'Hel', sequence: 1 }
    const completed = { ...event, method: 'item/completed', text: 'Hello', sequence: 2 }
    expect(appendCodexEvent([delta], completed)).toEqual([completed])
  })

  test('bounds coalesced deltas instead of allowing an unbounded transcript item', () => {
    const first = {
      ...event,
      method: 'item/commandExecution/outputDelta',
      kind: 'tool-output' as const,
      text: 'x'.repeat((512 << 10) - 8),
      sequence: 1,
    }
    const second = { ...first, text: 'y'.repeat(128), sequence: 2 }
    const [combined] = appendCodexEvent(appendCodexEvent([], first), second)

    expect(new TextEncoder().encode(combined?.text).byteLength).toBeLessThanOrEqual(512 << 10)
    expect(combined?.text).toEndWith('… output truncated …')
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
    const bounded = parseCodexEvent(JSON.stringify({ ...event, text: 'x'.repeat((512 << 10) + 1) }))?.text || ''
    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(512 << 10)
    expect(bounded).toEndWith('… output truncated …')
  })

  test('shows the complete command, file, and permission scope of approval requests', () => {
    expect(
      codexEventDisplayText({
        ...event,
        kind: 'approval',
        text: '',
        rawJson: JSON.stringify({
          params: {
            reason: 'Needs network',
            command: ['git', 'fetch', 'origin', 'feature branch'],
            cwd: '/workspace',
            fileChanges: {
              '/workspace/app.ts': { type: 'update' },
              '/workspace/new.ts': { type: 'add' },
            },
            permissions: {
              network: { enabled: true },
              fileSystem: {
                read: ['/workspace/input'],
                write: ['/workspace/output'],
                entries: [{ path: { type: 'glob_pattern', pattern: '/tmp/*.json' }, access: 'read' }],
              },
            },
            additionalPermissions: {
              network: null,
              fileSystem: { read: null, write: ['/var/tmp'], entries: [] },
            },
          },
        }),
      }),
    ).toBe(
      [
        'Needs network',
        "Command: git fetch origin 'feature branch'",
        'Working directory: /workspace',
        'Files:',
        '- /workspace/app.ts (update)',
        '- /workspace/new.ts (add)',
        'Requested permissions:',
        'Network: enabled',
        'Read access:',
        '- /workspace/input',
        'Write access:',
        '- /workspace/output',
        '- /tmp/*.json (read)',
        'Additional permissions:',
        'Write access:',
        '- /var/tmp',
      ].join('\n'),
    )
  })

  test('renders token usage and rate-limit snapshots', () => {
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
          params: {
            rateLimits: {
              primary: { usedPercent: 12, windowDurationMins: 300 },
              secondary: { usedPercent: 45, windowDurationMins: 10_080 },
              credits: { balance: '17.50' },
              rateLimitReachedType: null,
            },
          },
        }),
      }),
    ).toBe('5h window: 12% used · 7d window: 45% used · Credits: 17.50')
  })

  test('decodes printable base64 command output without corrupting ordinary text', () => {
    expect(
      codexEventDisplayText({
        ...event,
        kind: 'tool-output',
        method: 'item/commandExecution/outputDelta',
        text: 'aGVsbG8K',
      }),
    ).toBe('hello\n')
    expect(codexEventDisplayText({ ...event, kind: 'tool-output', text: '12 pass' })).toBe('12 pass')
  })

  test('shows web search and sub-agent activity from typed raw events', () => {
    expect(
      codexEventDisplayText({
        ...event,
        kind: 'tool-call',
        text: '',
        rawJson: JSON.stringify({ params: { item: { type: 'webSearch', query: 'Kata Firecracker' } } }),
      }),
    ).toBe('Web search: Kata Firecracker')
    expect(
      codexEventDisplayText({
        ...event,
        kind: 'tool-call',
        text: '',
        rawJson: JSON.stringify({
          params: {
            item: {
              type: 'subAgentActivity',
              kind: 'started',
              agentPath: '/root/reviewer',
              agentThreadId: 'thread-child',
            },
          },
        }),
      }),
    ).toBe('Sub-agent: started: /root/reviewer')
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
                {
                  id: 'user-2',
                  type: 'userMessage',
                  content: [
                    { type: 'image', url: 'data:image/png;base64,opaque' },
                    { type: 'localImage', path: '/workspace/reference.png' },
                    { type: 'skill', name: 'release', path: '/skills/release/SKILL.md' },
                    { type: 'mention', name: 'api.ts', path: '/workspace/api.ts' },
                  ],
                },
                { id: 'assistant-1', type: 'agentMessage', text: 'Done' },
                { id: 'plan-1', type: 'plan', text: '- [x] Build it' },
                { id: 'reasoning-1', type: 'reasoning', summary: ['Checked the result'], content: [] },
                { id: 'command-1', type: 'commandExecution', command: 'bun test', aggregatedOutput: '12 pass' },
                {
                  id: 'command-2',
                  type: 'commandExecution',
                  command: 'true',
                  status: 'completed',
                  aggregatedOutput: '',
                  exitCode: 0,
                },
                {
                  id: 'file-1',
                  type: 'fileChange',
                  changes: [{ path: '/workspace/app.ts', diff: '+export {}' }],
                },
                {
                  id: 'mcp-1',
                  type: 'mcpToolCall',
                  server: 'linear',
                  tool: 'get_issue',
                  result: { content: [], structuredContent: { id: 'ENG-123', state: 'Done' } },
                },
                { id: 'search-1', type: 'webSearch', query: 'Kata Firecracker', action: null },
                {
                  id: 'collab-1',
                  type: 'collabAgentToolCall',
                  tool: 'spawnAgent',
                  status: 'completed',
                  receiverThreadIds: ['thread-child'],
                  prompt: 'Review this change',
                },
                {
                  id: 'subagent-1',
                  type: 'subAgentActivity',
                  kind: 'started',
                  agentPath: '/root/reviewer',
                  agentThreadId: 'thread-child',
                },
              ],
            },
          ],
        },
      }),
    )
    expect(transcript).toEqual([
      { id: 'user-1', kind: 'user-message', text: 'Build it' },
      {
        id: 'user-2',
        kind: 'user-message',
        text: [
          '[Image]',
          '[Local image: /workspace/reference.png]',
          '[Skill: release — /skills/release/SKILL.md]',
          '[Mention: @api.ts — /workspace/api.ts]',
        ].join('\n'),
      },
      { id: 'assistant-1', kind: 'assistant-text', text: 'Done' },
      { id: 'plan-1', kind: 'plan', text: '- [x] Build it' },
      { id: 'reasoning-1', kind: 'reasoning-summary', text: 'Checked the result' },
      { id: 'command-1', kind: 'tool-output', text: '12 pass' },
      { id: 'command-2', kind: 'tool-output', text: 'Command completed (exit 0)' },
      { id: 'file-1', kind: 'file-diff', text: '+export {}' },
      { id: 'mcp-1', kind: 'tool-output', text: '{\n  "id": "ENG-123",\n  "state": "Done"\n}' },
      { id: 'search-1', kind: 'tool-call', text: 'Web search: Kata Firecracker' },
      {
        id: 'collab-1',
        kind: 'tool-output',
        text: 'Agent collaboration: spawnAgent: completed\nPrompt: Review this change\nAgents: thread-child',
      },
      { id: 'subagent-1', kind: 'tool-call', text: 'Sub-agent: started: /root/reviewer' },
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
})
