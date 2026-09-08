import { describe, expect, test } from 'bun:test'
import { create } from '@bufbuild/protobuf'

import {
  createDefaultDataConverter,
  decodePayloadMapToValues,
  decodePayloadsToValues,
  encodeMapValuesToPayloads,
  encodeValuesToPayloads,
} from '../../src/common/payloads'
import {
  PAYLOAD_TUNNEL_FIELD,
  jsonToPayload,
  jsonToPayloadMap,
  jsonToPayloads,
  payloadMapToJson,
  payloadToJson,
  payloadsToJson,
} from '../../src/common/payloads/json-codec'
import { PayloadSchema } from '../../src/proto/temporal/api/common/v1/message_pb'

const encoder = new TextEncoder()

describe('payload json codec', () => {
  test('round-trips json payloads', () => {
    const payload = jsonToPayload({ foo: 'bar', count: 3 })
    expect(payloadToJson(payload)).toEqual({ foo: 'bar', count: 3 })
  })

  test('tunnels non-json payloads and restores them', () => {
    const binaryPayload = create(PayloadSchema, {
      metadata: { encoding: encoder.encode('binary/plain'), custom: encoder.encode('meta') },
      data: new Uint8Array([1, 2, 3]),
    })

    const tunneled = payloadToJson(binaryPayload)
    expect(typeof tunneled).toBe('object')
    expect(tunneled).not.toEqual(null)
    expect(tunneled).toHaveProperty(PAYLOAD_TUNNEL_FIELD)

    const restored = jsonToPayload(tunneled)
    expect(restored.metadata?.encoding).toEqual(binaryPayload.metadata?.encoding)
    expect(restored.metadata?.custom).toEqual(binaryPayload.metadata?.custom)
    expect(restored.data).toEqual(binaryPayload.data)
  })

  test('payload arrays and maps handle empty/undefined inputs', () => {
    expect(jsonToPayloads([])).toEqual([])
    expect(payloadsToJson(undefined)).toEqual([])

    expect(jsonToPayloadMap(undefined)).toBeUndefined()
    expect(jsonToPayloadMap({})).toEqual({})
    expect(payloadMapToJson(undefined)).toBeUndefined()
    expect(payloadMapToJson({})).toEqual({})
  })
})

describe('data converter helpers', () => {
  test('encode/decode values and maps', async () => {
    const converter = createDefaultDataConverter()
    const payloads = await encodeValuesToPayloads(converter, ['alpha', { nested: true }])
    expect(payloads).toBeDefined()

    const decoded = await decodePayloadsToValues(converter, payloads)
    expect(decoded).toEqual(['alpha', { nested: true }])

    const empty = await encodeValuesToPayloads(converter, [])
    expect(empty).toBeUndefined()

    const mapPayloads = await encodeMapValuesToPayloads(converter, { config: 123 })
    expect(mapPayloads).toBeDefined()

    const decodedMap = await decodePayloadMapToValues(converter, mapPayloads)
    expect(decodedMap).toEqual({ config: 123 })

    expect(await encodeMapValuesToPayloads(converter, undefined)).toBeUndefined()
    expect(await decodePayloadMapToValues(converter, undefined)).toBeUndefined()
  })
})
