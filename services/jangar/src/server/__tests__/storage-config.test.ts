import { describe, expect, it } from 'vitest'

import {
  resolveClickHouseConfig,
  resolveDatabaseConfig,
  resolveRedisConfig,
  validateStorageConfig,
} from '~/server/storage-config'

describe('storage-config', () => {
  it('parses database and redis settings', () => {
    expect(
      resolveDatabaseConfig({
        DATABASE_URL: 'postgres://jangar@db/jangar',
        PGSSLMODE: 'require',
        PGCONNECT_TIMEOUT_MS: '5000',
      }),
    ).toEqual({
      url: 'postgres://jangar@db/jangar',
      sslMode: 'require',
      caCertPath: null,
      connectTimeoutMs: 5000,
      queryTimeoutMs: 30000,
    })

    expect(
      resolveRedisConfig({
        JANGAR_REDIS_URL: 'redis://redis:6379/0',
        JANGAR_CHAT_KEY_PREFIX: 'chat:',
        JANGAR_OPENWEBUI_RENDER_KEY_PREFIX: 'render:',
      }),
    ).toMatchObject({
      url: 'redis://redis:6379/0',
      chatKeyPrefix: 'chat',
      renderKeyPrefix: 'render',
    })
  })

  it('parses clickhouse settings', () => {
    expect(
      resolveClickHouseConfig({
        CH_HOST: 'clickhouse.internal',
        CH_USER: 'torghut',
        CH_PORT: '9440',
        CH_SECURE: 'false',
      }),
    ).toEqual({
      host: 'clickhouse.internal',
      user: 'torghut',
      password: '',
      port: 9440,
      database: 'torghut',
      secure: false,
      timeoutMs: 10000,
    })
  })

  it('rejects incomplete production storage config', () => {
    expect(() => validateStorageConfig({}, { enforceProductionDatabase: true })).toThrow(
      'DATABASE_URL is required for Jangar production runtime',
    )
    expect(() =>
      validateStorageConfig({ DATABASE_URL: 'postgres://jangar@db/jangar', CH_HOST: 'clickhouse.internal' }),
    ).toThrow('CH_USER is required when CH_HOST is configured')
  })
})
