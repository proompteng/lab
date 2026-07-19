import { describe, expect, test } from 'bun:test'

import { ConfigProvider, Effect, Exit } from 'effect'

import { loadBackfillConfig } from './backfill-config'
import { loadConfig } from './config'

const runtimeEnvironment = new Map([
  ['BAYN_CODE_REVISION', 'test-revision'],
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
  effect.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(environment)))

describe('Effect configuration', () => {
  test('loads runtime configuration with validated defaults', async () => {
    const config = await Effect.runPromise(provideEnvironment(loadConfig, runtimeEnvironment))

    expect(config.host).toBe('0.0.0.0')
    expect(config.port).toBe(8080)
    expect(config.operationTimeoutMs).toBe(30_000)
    expect(config.clickhouse.database).toBe('signal')
    expect(config.tigerBeetle.clusterId).toBe(2001n)
    expect(config.tigerBeetle.replicaAddresses).toEqual(['tigerbeetle.test:3000'])
  })

  test('returns a typed configuration failure for invalid values', async () => {
    const invalid = new Map(runtimeEnvironment)
    invalid.set('BAYN_OPERATION_TIMEOUT_MS', '0')

    const error = await Effect.runPromise(Effect.flip(provideEnvironment(loadConfig, invalid)))
    expect(error).toMatchObject({
      _tag: 'BaynError',
      component: 'config',
      operation: 'load',
    })
  })

  test('loads and validates backfill configuration without reading process.env directly', async () => {
    const config = await Effect.runPromise(provideEnvironment(loadBackfillConfig, backfillEnvironment))

    expect(config.database).toBe('signal')
    expect(config.table).toBe('adjusted_daily_bars_v1')
    expect(config.cluster).toBe('default')
    expect(config.feed).toBe('iex')

    const invalid = new Map(backfillEnvironment)
    invalid.set('BAYN_ALPACA_FEED', 'invalid')
    const exit = await Effect.runPromiseExit(provideEnvironment(loadBackfillConfig, invalid))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
