import { describe, expect, it } from 'bun:test'

import { truncateForConvex } from './utils'

describe('truncateForConvex', () => {
  it('does not truncate when under limit', () => {
    const input = 'short message'
    const result = truncateForConvex(input, 'payload', 1024)
    expect(result).toBe(input)
  })

  it('keeps as many bytes as possible before suffix', () => {
    const maxBytes = 1000
    const input = 'a'.repeat(2000)
    const result = truncateForConvex(input, 'payload', maxBytes)

    const suffix = `\n\n[truncated ${2000 - maxBytes} bytes from payload]`
    const suffixBytes = Buffer.byteLength(suffix, 'utf8')
    const allowedPrefix = maxBytes - suffixBytes

    const prefix = result.replace(suffix, '')
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect(Buffer.byteLength(prefix, 'utf8')).toBe(allowedPrefix)
    expect(result.endsWith(suffix)).toBe(true)
  })

  it('returns trimmed suffix when suffix alone exceeds budget', () => {
    const maxBytes = 10
    const input = 'a'.repeat(200)
    const result = truncateForConvex(input, 'payload', maxBytes)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(maxBytes)
    // ensure we kept at least part of the suffix
    expect(result.length).toBeGreaterThan(0)
  })
})
