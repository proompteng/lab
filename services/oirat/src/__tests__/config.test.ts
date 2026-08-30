import { describe, expect, it } from 'bun:test'
import { ALLOWED_THREAD_ARCHIVE_MINUTES, parseArchiveMinutes, parseList, parseNumber, requiredEnv } from '../config'

describe('config helpers', () => {
  it('parseList returns null for empty values', () => {
    expect(parseList()).toBeNull()
    expect(parseList('')).toBeNull()
    expect(parseList(' , ')).toBeNull()
  })

  it('parseList returns a set of ids', () => {
    const result = parseList('123, 456,789')
    expect(result?.has('123')).toBe(true)
    expect(result?.has('456')).toBe(true)
    expect(result?.has('789')).toBe(true)
  })

  it('parseNumber falls back on invalid values', () => {
    expect(parseNumber(undefined, 10)).toBe(10)
    expect(parseNumber('nope', 10)).toBe(10)
    expect(parseNumber('42', 10)).toBe(42)
  })

  it('parseArchiveMinutes enforces allowed durations', () => {
    const allowed = Array.from(ALLOWED_THREAD_ARCHIVE_MINUTES)[0]
    expect(parseArchiveMinutes(String(allowed), 1440)).toBe(allowed)
    expect(parseArchiveMinutes('5', 1440)).toBe(1440)
  })

  it('requiredEnv throws when missing', () => {
    const key = 'OIRAT_TEST_MISSING'
    delete process.env[key]
    expect(() => requiredEnv(key)).toThrow(`Missing required env var: ${key}`)
  })
})
