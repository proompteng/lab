import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Exit, Redacted } from 'effect'

import { loadBackfillConfig } from './backfill-config'
import type { EmbeddedBuildMetadata } from './build'
import { loadConfig } from './config'

const sourceRevision = 'a'.repeat(40)
const imageRepository = 'registry.ide-newton.ts.net/lab/bayn'
const imageDigest = `sha256:${'b'.repeat(64)}`
const buildMetadata: EmbeddedBuildMetadata = {
  sourceRevision,
  imageRepository,
  strategyBehaviorHash: 'c'.repeat(64),
}

const runtimeEnvironment = new Map([
  ['BAYN_CODE_REVISION', sourceRevision],
  ['BAYN_IMAGE_REPOSITORY', imageRepository],
  ['BAYN_IMAGE_DIGEST', imageDigest],
  ['BAYN_CLICKHOUSE_URL', 'http://clickhouse.test:8123'],
  ['BAYN_CLICKHOUSE_USERNAME', 'bayn'],
  ['BAYN_CLICKHOUSE_PASSWORD', 'secret'],
  ['BAYN_DATASET_VERSION', 'fixture-v1'],
  ['BAYN_TIGERBEETLE_ADDRESSES', 'tigerbeetle.test:3000'],
])

const backfillEnvironment = new Map([
  ['BAYN_CLICKHOUSE_URL', 'http://clickhouse.test:8123'],
  ['BAYN_CLICKHOUSE_USERNAME', 'operator'],
  ['BAYN_CLICKHOUSE_PASSWORD', 'secret'],
  ['APCA_API_KEY_ID', 'alpaca-key'],
  ['APCA_API_SECRET_KEY', 'alpaca-secret'],
  ['BAYN_DATASET_START', '2025-01-01'],
  ['BAYN_DATASET_END', '2025-12-31'],
  ['BAYN_DATASET_VERSION', 'fixture-v1'],
])

const provideEnvironment = <A, E>(effect: Effect.Effect<A, E>, environment: Map<string, string>) =>
  effect.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(Object.fromEntries(environment))),
  )

describe('Effect configuration', () => {
  test('loads runtime configuration with validated defaults', async () => {
    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), runtimeEnvironment))

    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(8080)
    expect(config.operationTimeoutMs).toBe(30_000)
    expect(config.clickhouse.database).toBe('signal')
    expect(Redacted.isRedacted(config.clickhouse.password)).toBe(true)
    expect(config.tigerBeetle.clusterId).toBe(2001n)
    expect(config.tigerBeetle.replicaAddresses).toEqual(['tigerbeetle.test:3000'])
    expect(config.build).toEqual({ ...buildMetadata, imageDigest, verification: 'embedded' })
  })

  test('supports an explicit, visibly unverified development provenance path', async () => {
    const development = new Map(runtimeEnvironment)
    development.set('BAYN_PROVENANCE_MODE', 'development')

    const config = await Effect.runPromise(provideEnvironment(loadConfig(undefined), development))

    expect(config.build).toMatchObject({
      sourceRevision,
      imageRepository,
      imageDigest,
      verification: 'development-configured',
    })
    expect(config.build.strategyBehaviorHash).toMatch(/^[a-f0-9]{64}$/)
    expect(config.runOnStartup).toBe(false)
  })

  test('does not let missing build facts or development mode bypass production verification', async () => {
    const missing = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(undefined), runtimeEnvironment)))
    expect(missing).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'provenance',
    })

    const bypass = new Map(runtimeEnvironment)
    bypass.set('BAYN_PROVENANCE_MODE', 'development')
    const mismatch = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), bypass)))
    expect(mismatch).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'provenance',
    })
  })

  test('returns a typed configuration failure for invalid values', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_OPERATION_TIMEOUT_MS', '0')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'load',
    })
  })

  test('fails closed when configured and embedded provenance diverge', async () => {
    for (const [name, value] of [
      ['BAYN_CODE_REVISION', 'd'.repeat(40)],
      ['BAYN_IMAGE_REPOSITORY', 'registry.example.invalid/bayn'],
    ] as const) {
      const invalid = new Map(runtimeEnvironment)
      invalid.set(name, value)

      const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
      expect(error).toMatchObject({
        _tag: 'OperationalError',
        component: 'config',
        operation: 'provenance',
      })
    }
  })

  test('loads and validates backfill configuration without reading process.env directly', async () => {
    const config = await Effect.runPromise(provideEnvironment(loadBackfillConfig, backfillEnvironment))

    expect(config.database).toBe('signal')
    expect(config.table).toBe('adjusted_daily_bars_v1')
    expect(config.cluster).toBe('default')
    expect(config.feed).toBe('iex')
    expect(Redacted.isRedacted(config.clickhousePassword)).toBe(true)
    expect(Redacted.isRedacted(config.alpacaKey)).toBe(true)
    expect(Redacted.isRedacted(config.alpacaSecret)).toBe(true)

    const invalid = new Map(backfillEnvironment)
    invalid.set('BAYN_ALPACA_FEED', 'invalid')
    const exit = await Effect.runPromiseExit(provideEnvironment(loadBackfillConfig, invalid))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
