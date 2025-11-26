import { describe, expect, test } from 'bun:test'

import {
  createDefaultDataConverter,
  decodeFailurePayloads,
  decodePayloadsToValues,
  encodeErrorToFailure,
  encodeFailurePayloads,
  encodeValuesToPayloads,
  failureToError,
} from '../../src/common/payloads'
import { createAesGcmCodec, createGzipCodec } from '../../src/common/payloads/codecs'

const aesKey = Buffer.alloc(32, 7)

describe('payload codec chain', () => {
  const dataConverter = createDefaultDataConverter({
    payloadCodecs: [createGzipCodec(), createAesGcmCodec({ key: aesKey, keyId: 'test-key' })],
  })

  test('round-trips values with gzip + aes-gcm codecs', async () => {
    const values = [{ foo: 'bar', nested: { count: 2 } }, 'codec-chain', 42]

    const encoded = await encodeValuesToPayloads(dataConverter, values)
    expect(encoded).toBeDefined()
    expect(encoded?.length).toBe(values.length)

    const decoded = await decodePayloadsToValues(dataConverter, encoded)
    expect(decoded).toEqual(values)
  })

  test('encodes failure details through codec pipeline', async () => {
    const root = new Error('workflow exploded')
    ;(root as { details?: unknown[] }).details = [{ reason: 'boom', code: 500 }]
    root.cause = new Error('inner-cause')

    const failure = await encodeErrorToFailure(dataConverter, root)
    const encodedFailure = await encodeFailurePayloads(dataConverter, failure)
    const decodedFailure = await decodeFailurePayloads(dataConverter, encodedFailure)
    const error = await failureToError(dataConverter, decodedFailure)

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('workflow exploded')
    expect((error as { cause?: Error }).cause?.message).toBe('inner-cause')
    expect((error as { details?: unknown[] }).details).toEqual([{ reason: 'boom', code: 500 }])
  })

  test('failure details are not double-encoded by codec pipeline', async () => {
    const root = new Error('codec-wrapped failure')
    ;(root as { details?: unknown[] }).details = ['detail-value']

    const failure = await encodeErrorToFailure(dataConverter, root)
    // encodeFailurePayloads should be a no-op for already encoded details
    const encodedFailure = await encodeFailurePayloads(dataConverter, failure)
    const error = await failureToError(dataConverter, encodedFailure)

    expect(error).toBeInstanceOf(Error)
    expect((error as { details?: unknown[] }).details).toEqual(['detail-value'])
  })
})
