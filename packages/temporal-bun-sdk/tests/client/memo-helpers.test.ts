import { describe, expect, test } from 'bun:test'

import { createDefaultDataConverter } from '../../src/common/payloads'
import {
  encodeMemoAttributes,
  decodeMemoAttributes,
  encodeSearchAttributes,
  decodeSearchAttributes,
} from '../../src/client/serialization'

describe('memo and search helpers', () => {
  const converter = createDefaultDataConverter()

  test('round-trips memo payloads with complex values', async () => {
    const memo = await encodeMemoAttributes(converter, {
      runId: 'abc',
      attempts: 3,
      nested: { flag: true },
    })
    expect(memo).toBeDefined()

    const decoded = await decodeMemoAttributes(converter, memo)
    expect(decoded).toEqual({ runId: 'abc', attempts: 3, nested: { flag: true } })
  })

  test('round-trips search attributes map', async () => {
    const encoded = await encodeSearchAttributes(converter, {
      customerId: 'cust-1',
      ttlDays: 30,
    })
    expect(encoded).toBeDefined()

    const decoded = await decodeSearchAttributes(converter, encoded)
    expect(decoded).toEqual({ customerId: 'cust-1', ttlDays: 30 })
  })
})
