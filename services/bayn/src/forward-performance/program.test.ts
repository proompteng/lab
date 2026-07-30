import { describe, expect, test } from 'bun:test'

import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Redacted, Result } from 'effect'

import { makeBrokerIdentity, BrokerEnvironment, BrokerProvider } from '../broker/identity'
import type { LoadedRuntimeConfig } from '../config'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { readForwardPerformancePostgres } from './postgres'
import { runForwardPerformance, type ForwardPerformanceReaders } from './program'

const identityResult = makeBrokerIdentity({
  schemaVersion: 'bayn.broker-identity.v2',
  provider: BrokerProvider.Alpaca,
  environment: BrokerEnvironment.Sandbox,
  accountId: 'paper-account-forward-performance',
})
if (Result.isFailure(identityResult)) throw new Error('broker identity fixture failed')

const config: LoadedRuntimeConfig = {
  runtimeMode: 'AutonomousService',
  host: '127.0.0.1',
  port: 8080,
  execution: {
    brokerIdentity: identityResult.success,
    brokerAccess: BrokerAccess.ReadOnly,
    capitalAuthority: noCapitalAuthority,
  },
  alpaca: {
    provider: BrokerProvider.Alpaca,
    environment: BrokerEnvironment.Sandbox,
    identity: identityResult.success,
    baseUrl: 'https://paper-api.alpaca.markets',
    expectedAccountId: identityResult.success.accountId,
    key: Redacted.make('unused-key'),
    secret: Redacted.make('unused-secret'),
    proxyUrl: 'http://proxy.invalid:3128',
    operationTimeoutMs: 5_000,
    retryAttempts: 2,
    authorityGenerationHash: 'e'.repeat(64),
    reconciliationIntervalMs: 30_000,
  },
  build: {
    sourceRevision: 'a'.repeat(40),
    imageRepository: 'registry.example.test/lab/bayn',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    strategyBehaviorHash: 'c'.repeat(64),
    strategyParameterHash: 'd'.repeat(64),
    verification: 'embedded',
  },
  healthIntervalMs: 30_000,
  operationTimeoutMs: 5_000,
  cycleStallThresholdMs: 300_000,
  reconciliationStaleThresholdMs: 120_000,
  unknownMutationThresholdMs: 300_000,
  cyclePollIntervalMs: 30_000,
  clickhouse: {
    url: 'http://clickhouse.invalid',
    username: 'bayn',
    password: Redacted.make('unused'),
    snapshotId: '1'.repeat(64),
    publicationAsOf: '2026-07-20',
    calendarVersion: 'fixture-calendar-v1',
    bounds: {
      schemaVersion: 'bayn.evaluation-bounds.v1',
      dataStart: '2018-01-02',
      dataEnd: '2026-07-20',
      lookbackStart: '2018-01-02',
      evaluationStart: '2019-01-02',
      evaluationEnd: '2026-07-20',
    },
  },
  postgres: { url: Redacted.make('postgresql://unused'), tls: false, caPath: '/unused' },
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['3000'], ledger: 7_001 },
}

interface SqlObservation {
  readonly statements: string[]
}

const makeReadOnlySql = (observation: SqlObservation): PgClient.PgClient => {
  const query = ((strings: TemplateStringsArray) => {
    const statement = strings.join('?').replaceAll(/\s+/g, ' ').trim()
    observation.statements.push(statement)
    return Effect.succeed(statement.includes('count(*)::integer AS count') ? [{ count: 0 }] : [])
  }) as unknown as PgClient.PgClient
  Object.assign(query, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
  })
  return query
}

describe('forward performance read program', () => {
  test('executes only read-only PostgreSQL statements and never treats zero activity as profitable', async () => {
    const observation: SqlObservation = { statements: [] }
    const sql = makeReadOnlySql(observation)
    const readers: ForwardPerformanceReaders = {
      postgres: readForwardPerformancePostgres,
      ledger: () =>
        Effect.succeed({
          totals: {
            realizedGainMicros: '0',
            realizedLossMicros: '0',
            brokerExecutionFeesMicros: '0',
            otherChargedCostsMicros: '0',
            cashYieldMicros: '0',
          },
          ledgerExact: true,
          missingLedgerAccountCount: 0,
          openPositionCount: 0,
        }),
    }

    const receipt = await Effect.runPromise(
      Effect.scoped(runForwardPerformance(config, readers).pipe(Effect.provide(Layer.succeed(PgClient.PgClient, sql)))),
    )

    expect(observation.statements.length).toBeGreaterThan(8)
    expect(observation.statements[0]).toBe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    expect(
      observation.statements.filter((statement) =>
        /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP|LOCK)\b/i.test(statement),
      ),
    ).toEqual([])
    expect(receipt.evidence.status).toBe('INSUFFICIENT_EVIDENCE')
    expect(receipt.evidence.reasonCodes).toContain('ZERO_COMPLETED_EXECUTIONS')
    expect(receipt.profitability).toBe('UNDETERMINED')
  })
})
