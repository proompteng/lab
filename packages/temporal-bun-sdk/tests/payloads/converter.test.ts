import { describe, expect, test } from 'bun:test'
import { ApplicationFailure, type PayloadCodec } from '@temporalio/common'

import {
  createDataConverter,
  decodeJsonToMap,
  decodeJsonToValues,
  encodeMapToJson,
  encodeValuesToJson,
  PAYLOAD_TUNNEL_FIELD,
  jsonToPayload,
  payloadToJson,
  type Payload,
} from '../../src/common/payloads'
import {
  decodeFailurePayloads,
  encodeErrorToFailure,
  failureToError,
} from '../../src/common/payloads/failure'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

class JsonEnvelopeCodec implements PayloadCodec {
  async encode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const jsonValue = payloadToJson(payload)
      const jsonText = JSON.stringify(jsonValue)
      return {
        metadata: {
          encoding: encoder.encode('binary/custom'),
        },
        data: encoder.encode(jsonText),
      }
    })
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return payloads.map((payload) => {
      const encoding = payload.metadata?.encoding ? decoder.decode(payload.metadata.encoding) : undefined
      if (encoding !== 'binary/custom') {
        return payload
      }
      const raw = decoder.decode(payload.data ?? new Uint8Array(0))
      const value = raw.length === 0 ? null : JSON.parse(raw)
      return jsonToPayload(value)
    })
  }
}

describe('payload data converter helpers', () => {
  test('encodes and decodes value arrays with codecs applied', async () => {
    const converter = createDataConverter({ payloadCodecs: [new JsonEnvelopeCodec()] })
    const values = ['Temporal', { ok: true }, undefined]

    const encoded = await encodeValuesToJson(converter, values)
    expect(encoded).toHaveLength(values.length)
    expect(typeof encoded[0]).toBe('object')

    const roundTrip = await decodeJsonToValues(converter, encoded)
    expect(roundTrip).toEqual(values)
  })

  test('encodes and decodes object maps', async () => {
    const converter = createDataConverter({ payloadCodecs: [new JsonEnvelopeCodec()] })
    const map = { alpha: 1, beta: { nested: 'value' } }

    const encoded = await encodeMapToJson(converter, map)
    expect(encoded).toBeDefined()
    expect(typeof encoded?.alpha).toBe('object')
    expect(encoded?.alpha && typeof encoded?.alpha === 'object').toBe(true)
    expect((encoded?.alpha as Record<string, unknown>)[PAYLOAD_TUNNEL_FIELD]).toBeDefined()

    const decoded = await decodeJsonToMap(converter, encoded)
    expect(decoded).toEqual(map)
  })

  test('converts failures through codecs and back to errors', async () => {
    const converter = createDataConverter({ payloadCodecs: [new JsonEnvelopeCodec()] })
    const error = ApplicationFailure.retryable('boom', 'CodecTest', { details: ['value'] })

    const failure = await encodeErrorToFailure(converter, error)
    const detailPayload = failure.applicationFailureInfo?.details?.payloads?.[0]
    expect(detailPayload).toBeDefined()
    expect(decoder.decode(detailPayload?.metadata?.encoding ?? new Uint8Array(0))).toBe('binary/custom')

    const decodedFailure = await decodeFailurePayloads(converter, failure)
    const decodedPayload = decodedFailure?.applicationFailureInfo?.details?.payloads?.[0]
    expect(decoder.decode(decodedPayload?.metadata?.encoding ?? new Uint8Array(0))).toBe('json/plain')

    const decodedError = await failureToError(converter, failure)
    expect(decodedError).toBeInstanceOf(ApplicationFailure)
    expect(decodedError?.message).toBe('boom')
  })
})
