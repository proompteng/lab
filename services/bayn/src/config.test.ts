import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Redacted } from 'effect'

import type { EmbeddedBuildMetadata } from './build'
import { loadConfig } from './config'
import { Authority } from './paper'

const sourceRevision = 'a'.repeat(40)
const imageRepository = 'registry.ide-newton.ts.net/lab/bayn'
const imageDigest = `sha256:${'b'.repeat(64)}`
const buildMetadata: EmbeddedBuildMetadata = {
  sourceRevision,
  imageRepository,
  strategyBehaviorHash: 'c'.repeat(64),
  strategyParameterHash: 'f'.repeat(64),
}

const runtimeEnvironment = new Map([
  ['BAYN_CODE_REVISION', sourceRevision],
  ['BAYN_IMAGE_REPOSITORY', imageRepository],
  ['BAYN_IMAGE_DIGEST', imageDigest],
  ['BAYN_STRATEGY_BEHAVIOR_HASH', buildMetadata.strategyBehaviorHash],
  ['BAYN_STRATEGY_PARAMETER_HASH', buildMetadata.strategyParameterHash],
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
    expect(config.qualificationRunId).toBeUndefined()
    expect(config.maximumAuthority).toBe(Authority.Observe)
    expect(config.healthIntervalMs).toBe(30_000)
    expect(config.operationTimeoutMs).toBe(30_000)
    expect(config.cycleStallThresholdMs).toBe(300_000)
    expect(config.reconciliationStaleThresholdMs).toBe(120_000)
    expect(config.unknownMutationThresholdMs).toBe(300_000)
    expect(config.autonomousCycle).toEqual({
      enabled: false,
      pollIntervalMs: 30_000,
    })
    expect(config.alpaca).toBeUndefined()
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

  test('loads an optional pinned terminal qualification run', async () => {
    const pinned = new Map(runtimeEnvironment)
    pinned.set('BAYN_QUALIFICATION_RUN_ID', 'e'.repeat(64))

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), pinned))

    expect(config.qualificationRunId).toBe('e'.repeat(64))
  })

  test('loads one complete redacted Alpaca read binding', async () => {
    const configured = new Map(runtimeEnvironment)
    configured.set('BAYN_ALPACA_ACCOUNT_ID', '61e69015-8549-4bfd-b9c3-01e75843f47d')
    configured.set('BAYN_ALPACA_KEY_ID', 'paper-key')
    configured.set('BAYN_ALPACA_SECRET_KEY', 'paper-secret')

    const config = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), configured))

    expect(config.alpaca).toMatchObject({
      accountId: '61e69015-8549-4bfd-b9c3-01e75843f47d',
      proxyUrl: 'http://bayn-egress-proxy:3128',
      retryAttempts: 2,
      reconciliationIntervalMs: 30_000,
    })
    if (config.alpaca === undefined) throw new Error('expected an Alpaca configuration')
    expect(Redacted.isRedacted(config.alpaca.key)).toBe(true)
    expect(Redacted.isRedacted(config.alpaca.secret)).toBe(true)
  })

  test('rejects a partial Alpaca credential binding instead of silently staying dormant', async () => {
    const partial = new Map(runtimeEnvironment)
    partial.set('BAYN_ALPACA_KEY_ID', 'paper-key')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), partial)))

    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'alpaca',
    })
  })

  test('requires a complete Alpaca binding for PAPER while allowing credential-free OBSERVE', async () => {
    const observe = await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), runtimeEnvironment))
    expect(observe.maximumAuthority).toBe(Authority.Observe)
    expect(observe.alpaca).toBeUndefined()

    const paper = new Map(runtimeEnvironment)
    paper.set('BAYN_MAXIMUM_AUTHORITY', Authority.Paper)
    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), paper)))

    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'alpaca',
      message: 'PAPER maximum authority requires a complete Alpaca account binding',
    })
  })

  test('requires a complete read-only Alpaca binding before enabling the autonomous loop', async () => {
    const enabled = new Map(runtimeEnvironment)
    enabled.set('BAYN_AUTONOMOUS_CYCLE_ENABLED', 'true')
    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), enabled)))

    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'alpaca',
      message: 'the autonomous cycle loop requires a complete Alpaca account binding',
    })

    enabled.set('BAYN_ALPACA_ACCOUNT_ID', '61e69015-8549-4bfd-b9c3-01e75843f47d')
    enabled.set('BAYN_ALPACA_KEY_ID', 'paper-key')
    enabled.set('BAYN_ALPACA_SECRET_KEY', 'paper-secret')
    expect(
      (await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), enabled))).autonomousCycle.enabled,
    ).toBe(true)
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
    expect(config.build.strategyParameterHash).toMatch(/^[a-f0-9]{64}$/)
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

  test('keeps operational alert thresholds positive and bounded to one day', async () => {
    for (const [name, value] of [
      ['BAYN_CYCLE_STALL_THRESHOLD_MS', '999'],
      ['BAYN_RECONCILIATION_STALE_THRESHOLD_MS', '86400001'],
      ['BAYN_UNKNOWN_MUTATION_THRESHOLD_MS', '0'],
    ] as const) {
      const invalid = new Map(runtimeEnvironment)
      invalid.set(name, value)

      const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
      expect(error).toMatchObject({
        _tag: 'OperationalError',
        component: 'config',
        operation: 'load',
      })
    }
  })

  test('rejects an invalid pinned qualification run ID', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_QUALIFICATION_RUN_ID', 'not-a-run-id')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), invalid)))
    expect(error).toMatchObject({
      _tag: 'OperationalError',
      component: 'config',
      operation: 'load',
    })
  })

  test('accepts only the closed broker-authority vocabulary', async () => {
    const paper = new Map(runtimeEnvironment)
    paper.set('BAYN_MAXIMUM_AUTHORITY', Authority.Paper)
    paper.set('BAYN_ALPACA_ACCOUNT_ID', '61e69015-8549-4bfd-b9c3-01e75843f47d')
    paper.set('BAYN_ALPACA_KEY_ID', 'paper-key')
    paper.set('BAYN_ALPACA_SECRET_KEY', 'paper-secret')
    expect((await Effect.runPromise(provideEnvironment(loadConfig(buildMetadata), paper))).maximumAuthority).toBe(
      Authority.Paper,
    )

    const live = new Map(runtimeEnvironment)
    live.set('BAYN_MAXIMUM_AUTHORITY', 'LIVE')
    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig(buildMetadata), live)))
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
      ['BAYN_STRATEGY_BEHAVIOR_HASH', 'd'.repeat(64)],
      ['BAYN_STRATEGY_PARAMETER_HASH', 'e'.repeat(64)],
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
