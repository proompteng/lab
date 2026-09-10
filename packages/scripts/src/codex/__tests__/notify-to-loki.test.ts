import { describe, expect, it } from 'bun:test'
import os from 'node:os'

import { buildStreams } from '../notify-to-loki'

const basePayload = {
  type: 'agent-turn-complete',
  'thread-id': 'thread-123',
  'turn-id': 'turn-456',
  cwd: '/tmp/work',
  'input-messages': ['Hello'],
  'last-assistant-message': 'Hi there!',
}

describe('notify-to-loki', () => {
  it('emits a single log line with the full assistant message', () => {
    const streams = buildStreams(basePayload, {
      originator: 'codex',
      hostname: 'test-host',
      includeInputs: true,
      now: new Date('2025-01-01T00:00:00.000Z'),
    })

    expect(streams).toHaveLength(1)
    expect(streams[0].values).toHaveLength(1)

    const [timestamp, line] = streams[0].values[0]
    expect(Number.parseInt(timestamp, 10)).toBeGreaterThan(0)

    const parsed = JSON.parse(line)
    expect(parsed.thread_id).toBe('thread-123')
    expect(parsed.turn_id).toBe('turn-456')
    expect(parsed.assistant_message).toBe('Hi there!')
    expect(parsed.input_messages).toEqual(['Hello'])

    expect(streams[0].stream).toMatchObject({
      job: 'codex',
      service: 'codex',
      exporter: 'notify',
      level: 'INFO',
      hostname: 'test-host',
      source: 'codex-notify',
    })
  })

  it('omits input messages unless explicitly enabled', () => {
    const streams = buildStreams(basePayload, {
      originator: 'codex',
      hostname: 'test-host',
      includeInputs: false,
      now: new Date('2025-01-01T00:00:00.000Z'),
    })

    const [, line] = streams[0].values[0]
    const parsed = JSON.parse(line)
    expect(parsed.input_messages).toBeUndefined()
  })

  it('adds extra labels when provided', () => {
    const streams = buildStreams(basePayload, {
      originator: 'codex',
      hostname: os.hostname(),
      includeInputs: false,
      extraLabels: { team: 'observability' },
      now: new Date('2025-01-01T00:00:00.000Z'),
    })

    expect(streams[0].stream.team).toBe('observability')
  })
})
