import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Redacted } from 'effect'

import { loadConfig } from './config'

const sourceRevision = 'a'.repeat(40)
const imageRepository = 'registry.ide-newton.ts.net/lab/signal-publisher'
const environment = {
  SIGNAL_CLICKHOUSE_URL: 'http://clickhouse.test:8123',
  SIGNAL_CLICKHOUSE_USERNAME: 'signal_publisher',
  SIGNAL_CLICKHOUSE_PASSWORD: 'secret',
  APCA_API_KEY_ID: 'key',
  APCA_API_SECRET_KEY: 'secret',
  SIGNAL_SYMBOLS: 'TLT,SPY',
  SIGNAL_START_DATE: '2017-01-01',
  SIGNAL_CODE_REVISION: sourceRevision,
  SIGNAL_IMAGE_REPOSITORY: imageRepository,
  SIGNAL_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
}

const provide = (values: Record<string, string>) =>
  loadConfig({ sourceRevision, imageRepository }).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
  )

describe('Signal publisher config', () => {
  test('loads typed secrets, deterministic symbols, and pinned provenance', async () => {
    const config = await Effect.runPromise(provide(environment))
    expect(config.symbols).toEqual(['SPY', 'TLT'])
    expect(config.alpaca.feed).toBe('sip')
    expect(config.finalizationLagMinutes).toBe(90)
    expect(Redacted.isRedacted(config.alpaca.key)).toBe(true)
    expect(config.provenance).toEqual({
      sourceRevision,
      imageRepository,
      imageDigest: `sha256:${'b'.repeat(64)}`,
    })
  })

  test('fails when build facts are absent, mismatched, or symbols duplicate', async () => {
    const missingBuild = await Effect.runPromise(
      Effect.flip(
        loadConfig(undefined).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(environment)),
        ),
      ),
    )
    const mismatchedBuild = await Effect.runPromise(
      Effect.flip(provide({ ...environment, SIGNAL_CODE_REVISION: 'c'.repeat(40) })),
    )
    const duplicateSymbols = await Effect.runPromise(
      Effect.flip(provide({ ...environment, SIGNAL_SYMBOLS: 'SPY,SPY' })),
    )
    const invalidUrl = await Effect.runPromise(
      Effect.flip(provide({ ...environment, SIGNAL_CLICKHOUSE_URL: 'not-a-url' })),
    )

    expect(missingBuild.message).toContain('compile-time build metadata')
    expect(mismatchedBuild.message).toContain('does not match embedded revision')
    expect(duplicateSymbols.message).toContain('contains duplicates')
    expect(invalidUrl.message).toContain('cannot be parsed as a URL')
  })
})
