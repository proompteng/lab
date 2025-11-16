import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Effect } from 'effect'

import {
  loadTemporalConfig,
  loadTemporalConfigEffect,
  TemporalConfigError,
  TemporalTlsConfigurationError,
} from '../../src/config'

const fixtures = (file: string) => join(import.meta.dir, '..', 'fixtures', 'tls', file)

describe('TLS config validation', () => {
  test('builds tls object from valid PEM files', async () => {
    const config = await loadTemporalConfig({
      env: {
        TEMPORAL_TLS_CA_PATH: fixtures('temporal-test-ca.pem'),
        TEMPORAL_TLS_CERT_PATH: fixtures('temporal-test-client.pem'),
        TEMPORAL_TLS_KEY_PATH: fixtures('temporal-test-client.key'),
        TEMPORAL_CLIENT_RETRY_MAX_ATTEMPTS: '7',
        TEMPORAL_CLIENT_RETRY_INITIAL_MS: '25',
        TEMPORAL_CLIENT_RETRY_MAX_MS: '50',
        TEMPORAL_CLIENT_RETRY_BACKOFF: '1.5',
        TEMPORAL_CLIENT_RETRY_JITTER_FACTOR: '0.4',
        TEMPORAL_CLIENT_RETRY_STATUS_CODES: 'Unavailable Internal',
      },
    })

    expect(config.tls?.clientCertPair).toBeDefined()
    expect(config.tls?.serverRootCACertificate).toBeDefined()
    expect(config.rpcRetryPolicy).toEqual({
      maxAttempts: 7,
      initialDelayMs: 25,
      maxDelayMs: 50,
      backoffCoefficient: 1.5,
      jitterFactor: 0.4,
      retryableStatusCodes: expect.arrayContaining([14, 13]),
    })
  })

  test('throws when cert/key pair is incomplete', async () => {
    await expect(
      loadTemporalConfig({
        env: {
          TEMPORAL_TLS_CERT_PATH: fixtures('temporal-test-client.pem'),
        },
      }),
    ).rejects.toThrow(TemporalTlsConfigurationError)
  })

  test('throws when cert and key do not match', async () => {
    await expect(
      loadTemporalConfig({
        env: {
          TEMPORAL_TLS_CA_PATH: fixtures('temporal-test-ca.pem'),
          TEMPORAL_TLS_CERT_PATH: fixtures('temporal-test-client.pem'),
          TEMPORAL_TLS_KEY_PATH: fixtures('temporal-test-ca.key'),
        },
      }),
    ).rejects.toThrow(TemporalTlsConfigurationError)
  })

  test('rejects invalid PEM contents', async () => {
    await expect(
      loadTemporalConfig({
        env: {
          TEMPORAL_TLS_CA_PATH: fixtures('invalid.pem'),
          TEMPORAL_TLS_CERT_PATH: fixtures('temporal-test-client.pem'),
          TEMPORAL_TLS_KEY_PATH: fixtures('temporal-test-client.key'),
        },
      }),
    ).rejects.toThrow(TemporalTlsConfigurationError)
  })

  test('effect loader rejects invalid env', async () => {
    await expect(
      Effect.runPromise(
        loadTemporalConfigEffect({
          env: {
            TEMPORAL_LOG_LEVEL: 'nope',
          },
        }),
      ),
    ).rejects.toThrow(TemporalConfigError)
  })
})
