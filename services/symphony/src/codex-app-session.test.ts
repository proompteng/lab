import { describe, expect, test } from 'bun:test'

import { CodexProtocolError } from './errors'
import { decodeProtocolMessage } from './codex-app-session'

describe('codex protocol decoding', () => {
  test('decodes JSON-RPC protocol lines', () => {
    const decoded = decodeProtocolMessage('{"id":1,"method":"initialize","params":{}}')
    expect(decoded).toEqual({ id: 1, method: 'initialize', params: {} })
  })

  test('rejects non-object JSON payloads', () => {
    expect(() => decodeProtocolMessage('"text"')).toThrow(CodexProtocolError)
  })
})
