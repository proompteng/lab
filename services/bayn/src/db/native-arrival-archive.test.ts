import { describe, expect, test } from 'bun:test'
import { Redacted, Result } from 'effect'

import { nativeArrivalArchiveConfig } from './native-arrival-archive'

const postgres = {
  url: Redacted.make('postgresql://financial:financial-secret@financial:5432/bayn'),
  tls: true,
  caPath: '/financial/ca.crt',
}
const archive = {
  url: Redacted.make('postgresql://archive:archive-secret@archive:5432/bayn_native_arrival'),
  tls: true,
  caPath: '/archive/ca.crt',
}

describe('native arrival database isolation', () => {
  test('requires the archive without a financial fallback', () => {
    const result = nativeArrivalArchiveConfig({ postgres, operationTimeoutMs: 30_000 })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.message).toContain('requires its archive database')
  })

  test('uses the archive connection and certificate without changing its timeout or TLS policy', () => {
    expect(
      Result.getOrThrow(
        nativeArrivalArchiveConfig({ postgres, nativeArrivalPostgres: archive, operationTimeoutMs: 30_000 }),
      ),
    ).toEqual({
      postgres: archive,
      operationTimeoutMs: 30_000,
    })
  })

  test('rejects another logical database sharing the financial endpoint, including URL host overrides', () => {
    for (const url of [
      'postgresql://archive:archive-secret@financial/bayn_native_arrival',
      'postgresql://archive:archive-secret@different/bayn_native_arrival?host=financial&port=5432',
    ]) {
      const result = nativeArrivalArchiveConfig({
        postgres,
        nativeArrivalPostgres: { ...archive, url: Redacted.make(url) },
        operationTimeoutMs: 30_000,
      })
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure.message).toContain('cannot share')
    }
  })

  test('does not disclose connection credentials in validation errors', () => {
    for (const url of [
      'postgresql://archive:archive-secret@financial/bayn',
      'https://archive:archive-secret@archive/bayn',
      'archive-secret',
    ]) {
      const result = nativeArrivalArchiveConfig({
        postgres,
        nativeArrivalPostgres: { ...archive, url: Redacted.make(url) },
        operationTimeoutMs: 30_000,
      })
      expect(Result.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).not.toContain('archive-secret')
      expect(JSON.stringify(result)).not.toContain('financial-secret')
    }
  })
})
