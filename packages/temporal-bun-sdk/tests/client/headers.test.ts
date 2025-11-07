import { describe, expect, test } from 'bun:test'

import { createDefaultHeaders, mergeHeaders, normalizeMetadataHeaders } from '../../src/client/headers'

describe('normalizeMetadataHeaders', () => {
  test('rejects duplicate header keys', () => {
    expect(() =>
      normalizeMetadataHeaders({ Foo: 'bar', foo: 'baz' }),
    ).toThrow("Header key 'foo' is duplicated (case-insensitive match)")
  })

  test('encodes binary and ascii metadata appropriately', () => {
    const normalized = normalizeMetadataHeaders({
      'trace-id': 'abc123',
      'custom-bin': new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    })

    expect(normalized['trace-id']).toBe('abc123')
    expect(normalized['custom-bin']).toBe(Buffer.from([0xde, 0xad, 0xbe, 0xef]).toString('base64'))
  })
})

describe('default and merged headers', () => {
  test('creates Authorization header when api key is provided', () => {
    const headers = createDefaultHeaders('test-key')
    expect(headers).toEqual({ authorization: 'Bearer test-key' })
  })

  test('mergeHeaders prefers new values', () => {
    const merged = mergeHeaders({ authorization: 'old' }, { authorization: 'new', 'trace-id': '123' })
    expect(merged).toEqual({ authorization: 'new', 'trace-id': '123' })
  })
})
