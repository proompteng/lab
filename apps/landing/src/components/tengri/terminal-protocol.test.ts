import { describe, expect, mock, test } from 'bun:test'

import {
  buildTerminalWebSocketUrl,
  normalizeTerminalSize,
  parseTerminalControlFrame,
  parseTerminalCleanupState,
  parseTerminalOutputFrame,
  parseTerminalResumeState,
  safelyDisposeTerminal,
  settleTerminalCreation,
  terminalHeartbeatAction,
  terminalPlainText,
  terminalReconnectDelay,
  terminalResumeAttachment,
  terminalTicketProtocol,
} from './terminal-protocol'

describe('Tengri terminal protocol', () => {
  test('decodes framed binary output and rejects malformed frames', () => {
    const frame = new Uint8Array([1, 0, 0, 0, 42, 104, 105])
    expect(parseTerminalOutputFrame(frame)).toEqual({ sequence: 42, payload: frame.subarray(5) })
    expect(parseTerminalOutputFrame(new Uint8Array([2, 0, 0, 0, 1, 1]))).toBeNull()
    expect(parseTerminalOutputFrame(new Uint8Array([1, 0, 0, 0, 0, 1]))).toBeNull()
  })

  test('builds a bounded secure WebSocket URL without putting the ticket in the query string', () => {
    const result = new URL(
      buildTerminalWebSocketUrl('https://tengri.example.test/v1/terminal/ws?since=999', {
        reconnectToken: 'a'.repeat(24),
        sequence: 42,
        columns: 10_000,
        rows: 1,
      }),
    )
    expect(result.protocol).toBe('wss:')
    expect(result.searchParams.get('reconnect')).toBe('a'.repeat(24))
    expect(result.searchParams.get('since')).toBe('42')
    expect(result.searchParams.get('cols')).toBe('400')
    expect(result.searchParams.get('rows')).toBe('6')
    expect(result.search).not.toContain('ticket')
    expect(() =>
      buildTerminalWebSocketUrl('ws://example.test/v1/terminal/ws', {
        reconnectToken: '',
        sequence: 0,
        columns: 80,
        rows: 24,
      }),
    ).toThrow('secure WebSocket')
  })

  test('validates ticket subprotocols, control frames, and persisted resume state', () => {
    expect(terminalTicketProtocol('abcDEF_1234567890')).toBe('tengri.ticket.abcDEF_1234567890')
    expect(() => terminalTicketProtocol('contains a space')).toThrow('invalid')
    expect(
      parseTerminalControlFrame('{"type":"ready","token":"abcdefghijklmnopqrstuvwx","bufferStart":2,"bufferEnd":5}'),
    ).toEqual({
      type: 'ready',
      token: 'abcdefghijklmnopqrstuvwx',
      bufferStart: 2,
      bufferEnd: 5,
    })
    expect(parseTerminalControlFrame('{"type":"exit","exitCode":7}')).toEqual({ type: 'exit', exitCode: 7 })
    const serialized = JSON.stringify({
      agentId: 'agent-a',
      sessionId: 'abcdefghijklmnopqrstuvwx',
      reconnectToken: 'zyxwvutsrqponmlkjihgfedc',
      sequence: 12,
    })
    expect(parseTerminalResumeState(serialized, 'agent-a')?.sequence).toBe(12)
    expect(parseTerminalResumeState(serialized, 'agent-a')?.cleanupPending).toBe(false)
    expect(parseTerminalResumeState(serialized, 'agent-b')).toBeNull()
    expect(
      parseTerminalResumeState(JSON.stringify({ ...JSON.parse(serialized), cleanupPending: true }), 'agent-a')
        ?.cleanupPending,
    ).toBe(true)
  })

  test('probes after a suspended heartbeat before timing out an unanswered ping', () => {
    expect(terminalHeartbeatAction(60_000, 0, 1_000)).toBe('ping')
    expect(terminalHeartbeatAction(15_000, 0, null)).toBe('ping')
    expect(terminalHeartbeatAction(30_000, 15_000, 15_000)).toBe('wait')
    expect(terminalHeartbeatAction(60_001, 60_000, 15_000)).toBe('close')
  })

  test('validates and deduplicates the agent cleanup registry', () => {
    const value = JSON.stringify({
      agentId: 'agent-a',
      sessionIds: ['abcdefghijklmnopqrstuvwx', 'abcdefghijklmnopqrstuvwx'],
    })
    expect(parseTerminalCleanupState(value, 'agent-a')).toEqual({
      agentId: 'agent-a',
      sessionIds: ['abcdefghijklmnopqrstuvwx'],
    })
    expect(parseTerminalCleanupState(value, 'agent-b')).toBeNull()
    expect(parseTerminalCleanupState('{"agentId":"agent-a","sessionIds":["bad"]}', 'agent-a')).toBeNull()
  })

  test('replays a fresh display and detaches duplicated tabs from the inherited token', () => {
    const state = parseTerminalResumeState(
      JSON.stringify({
        agentId: 'agent-a',
        sessionId: 'abcdefghijklmnopqrstuvwx',
        reconnectToken: 'zyxwvutsrqponmlkjihgfedc',
        sequence: 42,
      }),
      'agent-a',
    )
    if (!state) throw new Error('expected valid terminal state')
    expect(terminalResumeAttachment(state, false)).toEqual({
      reconnectToken: 'zyxwvutsrqponmlkjihgfedc',
      sequence: 0,
    })
    expect(terminalResumeAttachment(state, true)).toEqual({ reconnectToken: '', sequence: 0 })
  })

  test('cleans an accepted terminal when its window closes before creation returns', async () => {
    const cleanup = mock(async () => undefined)
    const session = { id: 'abcdefghijklmnopqrstuvwx' }
    let failure: unknown
    try {
      await settleTerminalCreation(Promise.resolve(session), () => true, cleanup)
    } catch (cause) {
      failure = cause
    }
    expect(failure).toMatchObject({ name: 'AbortError' })
    expect(cleanup).toHaveBeenCalledWith(session)
    expect(await settleTerminalCreation(Promise.resolve(session), () => false, cleanup)).toBe(session)
  })

  test('bounds dimensions and reconnect backoff while neutralizing control text', () => {
    expect(normalizeTerminalSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ columns: 120, rows: 32 })
    expect(terminalReconnectDelay(0)).toBe(400)
    expect(terminalReconnectDelay(100)).toBe(8_000)
    expect(terminalPlainText('\u001b[2J unsafe\nmessage')).toBe('[2J unsafe message')
  })

  test('contains renderer disposal failures', () => {
    const warn = mock(() => undefined)
    expect(() =>
      safelyDisposeTerminal(
        {
          dispose: () => {
            throw new Error('context lost')
          },
        },
        { warn },
      ),
    ).not.toThrow()
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
