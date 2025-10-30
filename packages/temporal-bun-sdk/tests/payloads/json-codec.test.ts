import { Buffer } from 'node:buffer'

import { describe, expect, test } from 'bun:test'
import { DefaultPayloadConverter } from '@temporalio/common'

import { PAYLOAD_TUNNEL_FIELD, jsonToPayload, payloadToJson, type Payload } from '../../src/common/payloads'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe('payload json codec', () => {
  test('round-trips json/plain payloads as native values', () => {
    const converter = new DefaultPayloadConverter()
    const values: unknown[] = [42, 'Temporal', { nested: ['hello', 99] }, null, undefined]

    for (const value of values) {
      const payload = converter.toPayload(value) as Payload
      const jsonValue = payloadToJson(payload)
      const reconstructed = jsonToPayload(jsonValue)
      const decoded = converter.fromPayload(reconstructed)
      if (value === undefined) {
        expect(decoded).toBeUndefined()
      } else {
        expect(decoded).toEqual(value)
      }
    }
  })

  test('tunnels non-json payload metadata via sentinel envelope', () => {
    const payload: Payload = {
      metadata: {
        encoding: encoder.encode('binary/custom'),
        'custom-key': encoder.encode('temporal-bun'),
      },
      data: Uint8Array.from([1, 2, 3, 4]),
    }

    const jsonValue = payloadToJson(payload)
    expect(typeof jsonValue).toBe('object')
    expect(jsonValue).not.toBeNull()
    expect((jsonValue as Record<string, unknown>)).toHaveProperty(PAYLOAD_TUNNEL_FIELD)

    const reconstructed = jsonToPayload(jsonValue)
    expect(reconstructed.metadata).toBeDefined()
    expect(reconstructed.metadata?.encoding).toBeDefined()
    expect(decoder.decode(reconstructed.metadata?.encoding ?? new Uint8Array(0))).toBe('binary/custom')
    expect(Buffer.from(reconstructed.data ?? new Uint8Array(0))).toEqual(Buffer.from([1, 2, 3, 4]))
  })

  test('falls back to tunnelling when json/plain payload data is malformed', () => {
    const payload: Payload = {
      metadata: {
        encoding: encoder.encode('json/plain'),
      },
      data: encoder.encode('{ invalid json'),
    }

    const jsonValue = payloadToJson(payload)
    expect(typeof jsonValue).toBe('object')
    expect(jsonValue).not.toBeNull()
    expect((jsonValue as Record<string, unknown>)).toHaveProperty(PAYLOAD_TUNNEL_FIELD)

    const reconstructed = jsonToPayload(jsonValue)
    expect(decoder.decode(reconstructed.metadata?.encoding ?? new Uint8Array(0))).toBe('json/plain')
    expect(decoder.decode(reconstructed.data ?? new Uint8Array(0))).toBe('{ invalid json')
  })
})
