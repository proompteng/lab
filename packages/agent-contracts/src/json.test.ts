import { describe, expect, it } from 'vitest'

import {
  asRecord,
  asString,
  errorResponse,
  normalizeNamespace,
  okResponse,
  parseJsonBody,
  readNested,
  requireIdempotencyKey,
  stableJsonStringifyForHash,
} from './json'

describe('json contracts', () => {
  it('normalizes shared primitive values', () => {
    expect(asString('  value  ')).toBe('value')
    expect(asString('')).toBeNull()
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
    expect(asRecord(['a'])).toBeNull()
    expect(readNested({ a: { b: 'c' } }, ['a', 'b'])).toBe('c')
    expect(readNested({ a: null }, ['a', 'b'])).toBeNull()
    expect(normalizeNamespace('  torghut  ')).toBe('torghut')
    expect(normalizeNamespace('', 'fallback')).toBe('fallback')
  })

  it('keeps stable hashes independent of object key order', () => {
    const left = { z: 1, a: { d: 4, b: 2 }, omit: undefined }
    const right = { a: { b: 2, d: 4 }, z: 1 }
    expect(stableJsonStringifyForHash(left)).toBe(stableJsonStringifyForHash(right))
  })

  it('builds small JSON responses and validates request bodies', async () => {
    const ok = okResponse({ ok: true })
    expect(ok.headers.get('content-type')).toBe('application/json')
    expect(await ok.json()).toEqual({ ok: true })

    const error = errorResponse('bad input', 422, { field: 'name' })
    expect(error.status).toBe(422)
    expect(await error.json()).toEqual({ ok: false, error: 'bad input', details: { field: 'name' } })

    const parsed = await parseJsonBody(new Request('http://agents.test', { method: 'POST', body: '{"name":"run"}' }))
    expect(parsed).toEqual({ name: 'run' })

    await expect(parseJsonBody(new Request('http://agents.test', { method: 'POST', body: '[]' }))).rejects.toThrow(
      'invalid JSON body',
    )
  })

  it('requires idempotency keys at the shared HTTP boundary', () => {
    expect(
      requireIdempotencyKey(
        new Request('http://agents.test', {
          headers: { 'idempotency-key': '  run-key  ' },
        }),
      ),
    ).toBe('run-key')

    expect(() => requireIdempotencyKey(new Request('http://agents.test'))).toThrow('Idempotency-Key')
  })
})
