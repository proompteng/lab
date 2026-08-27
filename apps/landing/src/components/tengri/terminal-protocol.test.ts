import { describe, expect, mock, test } from 'bun:test'

import {
  buildTerminalWebSocketUrl,
  normalizeTerminalSize,
  parseTerminalControlFrame,
  parseTerminalOutputFrame,
  parseTerminalResumeState,
  safelyDisposeTerminal,
  terminalPlainText,
  terminalReconnectDelay,
  terminalResumeStorageKey,
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
    expect(parseTerminalResumeState(serialized, 'agent-b')).toBeNull()
    expect(terminalResumeStorageKey('agent/a', 'terminal:7')).toBe('tengri:terminal:agent%2Fa:terminal%3A7')
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
