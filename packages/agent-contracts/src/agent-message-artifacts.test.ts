import { describe, expect, it } from 'vitest'

import {
  buildBackfillDedupeKey,
  parseAgentMessagesFromEvents,
  parseAgentMessagesFromLog,
} from './agent-message-artifacts'

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

    const messages = parseAgentMessagesFromEvents(payload)

    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('hello')
    expect(messages[0].attrs).toEqual(expect.objectContaining({ artifact: 'implementation-events', line: 1 }))
    expect(messages[1].content).toBe('foobar')
    expect(messages[1].attrs).toEqual(expect.objectContaining({ artifact: 'implementation-events', line: 2 }))
  })

  it('parses agent log lines', async () => {
    const payload = 'first line\n\nsecond line\n'

    const messages = parseAgentMessagesFromLog(payload)

    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('first line')
    expect(messages[0].attrs).toEqual(expect.objectContaining({ artifact: 'implementation-agent-log', line: 1 }))
    expect(messages[1].content).toBe('second line')
    expect(messages[1].attrs).toEqual(expect.objectContaining({ artifact: 'implementation-agent-log', line: 3 }))
  })

  it('builds stable artifact line dedupe keys', () => {
    expect(buildBackfillDedupeKey('run-1', { artifact: 'implementation-events', line: '12' })).toBe(
      'backfill:run-1:implementation-events:12',
    )
    expect(buildBackfillDedupeKey('run-1', { artifact: 'implementation-events' })).toBeNull()
  })
})
