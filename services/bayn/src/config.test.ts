import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Redacted } from 'effect'

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
  ['BAYN_SIGNAL_SNAPSHOT_ID', 'd'.repeat(64)],
  ['BAYN_SIGNAL_PUBLICATION_ASOF', '2026-07-17'],
  ['BAYN_SIGNAL_CALENDAR_VERSION', 'alpaca-us-equity-calendar-v1'],
  ['BAYN_SIGNAL_DATA_START', '2017-01-03'],
  ['BAYN_SIGNAL_DATA_END', '2026-07-17'],
  ['BAYN_SIGNAL_LOOKBACK_START', '2017-01-03'],
  ['BAYN_SIGNAL_EVALUATION_START', '2018-01-03'],
  ['BAYN_SIGNAL_EVALUATION_END', '2026-07-17'],
  ['BAYN_POSTGRES_URL', 'postgresql://bayn:secret@postgres.test:5432/bayn'],
  ['BAYN_TIGERBEETLE_ADDRESSES', 'tigerbeetle.test:3000'],
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
    expect(config.healthIntervalMs).toBe(30_000)
    expect(config.operationTimeoutMs).toBe(30_000)
    expect(config.clickhouse).toMatchObject({
      snapshotId: 'd'.repeat(64),
      publicationAsOf: '2026-07-17',
      calendarVersion: 'alpaca-us-equity-calendar-v1',
      bounds: {
        schemaVersion: 'bayn.evaluation-bounds.v1',
        dataStart: '2017-01-03',
        dataEnd: '2026-07-17',
        lookbackStart: '2017-01-03',
        evaluationStart: '2018-01-03',
        evaluationEnd: '2026-07-17',
      },
    })
    expect(Redacted.isRedacted(config.clickhouse.password)).toBe(true)
    expect(Redacted.isRedacted(config.postgres.url)).toBe(true)
    expect(config.postgres).toMatchObject({
      tls: true,
      caPath: '/var/run/secrets/bayn/postgres/ca.crt',
    })
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

  test('rejects evaluation bounds that are not ordered', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_SIGNAL_EVALUATION_START', '2026-07-18')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'load',
    })
  })

  test('does not permit plaintext PostgreSQL in a production artifact', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_POSTGRES_TLS', 'false')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'provenance',
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
})
