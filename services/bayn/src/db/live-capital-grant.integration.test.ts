import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'

import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Exit, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import { config as baseConfig } from '../app-test-support'
import {
  BrokerEnvironment,
  BrokerProvider,
  decodePersistedBrokerIdentity,
  makeBrokerIdentity,
} from '../broker/identity'
import { makeLiveCapitalGrant, type LiveCapitalGrantRevocation } from '../execution/authority'
import { EvidenceStore, EvidenceStoreFromPostgres, PostgresClientLive } from './evidence-store'
import { LiveCapitalGrantStore, LiveCapitalGrantStoreLive } from './live-capital-grant'

const postgresUrl = process.env.BAYN_TEST_POSTGRES_URL
const testUrl = postgresUrl ?? 'postgresql://bayn:bayn@127.0.0.1:5432/bayn_test'
const describePostgres = postgresUrl === undefined ? describe.skip : describe
const runtimeConfig = {
  ...baseConfig,
  postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
}

const makeClientRuntime = () =>
  ManagedRuntime.make(PostgresClientLive(runtimeConfig).pipe(Layer.provide(NodeServices.layer)))

const makeMigrationRuntime = () =>
  ManagedRuntime.make(
    EvidenceStoreFromPostgres(runtimeConfig).pipe(
      Layer.provideMerge(PostgresClientLive(runtimeConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

const makeGrantRuntime = () =>
  ManagedRuntime.make(
    LiveCapitalGrantStoreLive.pipe(
      Layer.provideMerge(PostgresClientLive(runtimeConfig)),
      Layer.provide(NodeServices.layer),
    ),
  )

describePostgres('explicit execution authority persistence', () => {
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('BAYN_TEST_POSTGRES_URL must target a local database whose name ends in _test')
    }
  })

  beforeEach(async () => {
    const client = makeClientRuntime()
    await client.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
      }),
    )
    await client.dispose()

    const migrations = makeMigrationRuntime()
    await migrations.runPromise(Effect.flatMap(EvidenceStore, (store) => store.check))
    await migrations.dispose()
  }, 15_000)

  test('preserves historical authority evidence and round-trips a versioned live grant and revocation', async () => {
    const runtime = makeGrantRuntime()
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* PgClient.PgClient
          const store = yield* LiveCapitalGrantStore
          const [historical] = yield* sql<{
            generation_hash: string
            account_id: string | null
            broker_identity_schema_version: string | null
            broker_identity_hash: string | null
            broker_provider: BrokerProvider | null
            broker_environment: BrokerEnvironment | null
          }>`
            SELECT
              generation_hash,
              account_id,
              broker_identity_schema_version,
              broker_identity_hash,
              broker_provider,
              broker_environment
            FROM authority_generations
            ORDER BY authority_version
            LIMIT 1
          `
          const decodedHistorical = decodePersistedBrokerIdentity(historical)
          const identity = Result.getOrThrow(
            makeBrokerIdentity({
              schemaVersion: 'bayn.broker-identity.v2',
              provider: BrokerProvider.Alpaca,
              environment: BrokerEnvironment.Live,
              accountId: 'live-account-integration',
            }),
          )
          const grant = Result.getOrThrow(
            makeLiveCapitalGrant({
              schemaVersion: 'bayn.live-capital-grant.v1',
              brokerIdentity: identity,
              authorityGenerationHash: historical!.generation_hash,
              strategy: {
                name: 'risk-balanced-trend',
                behaviorHash: '1'.repeat(64),
                parameterHash: '2'.repeat(64),
                parameterSchemaVersion: 'bayn.risk-balanced-trend.protocol.v4',
              },
              limits: {
                maxGrossNotionalMicros: '100000000000',
                maxOrderNotionalMicros: '10000000000',
                maxPositionNotionalMicros: '25000000000',
                maxDailyLossMicros: '1000000000',
                maxOpenOrders: 5,
              },
              validFrom: '2026-07-28T07:00:00.000Z',
              validUntil: '2026-07-28T09:00:00.000Z',
              issuedAt: '2026-07-28T06:00:00.000Z',
              issuedBy: 'integration:test',
            }),
          )
          const recorded = yield* store.record(grant)
          const readBack = yield* store.read(grant.grantHash)
          const revocation: LiveCapitalGrantRevocation = {
            schemaVersion: 'bayn.live-capital-grant-revocation.v1',
            revokedAt: '2026-07-28T08:15:00.000Z',
            revokedBy: 'integration:test',
            reason: 'integration containment proof',
          }
          const revoked = yield* store.revoke(grant.grantHash, revocation)
          const mutateGrant = yield* Effect.exit(sql`
            UPDATE live_capital_grants
            SET issued_by = 'forbidden'
            WHERE grant_hash = ${grant.grantHash}
          `)
          const mutateHistorical = yield* Effect.exit(sql`
            UPDATE authority_generations
            SET broker_identity_schema_version = 'bayn.broker-identity.v2'
            WHERE generation_hash = ${historical!.generation_hash}
          `)
          const [historicalAfter] = yield* sql<{
            generation_hash: string
            broker_identity_schema_version: string | null
            broker_identity_hash: string | null
            broker_provider: string | null
            broker_environment: string | null
          }>`
            SELECT
              generation_hash,
              broker_identity_schema_version,
              broker_identity_hash,
              broker_provider,
              broker_environment
            FROM authority_generations
            WHERE generation_hash = ${historical!.generation_hash}
          `
          return {
            historical,
            decodedHistorical,
            recorded,
            readBack,
            revoked,
            mutateGrant,
            mutateHistorical,
            historicalAfter,
          }
        }),
      )

      expect(result.historical).toMatchObject({
        account_id: null,
        broker_identity_schema_version: null,
        broker_identity_hash: null,
        broker_provider: null,
        broker_environment: null,
      })
      expect(result.decodedHistorical).toEqual(Result.succeed(undefined))
      expect(result.recorded.grant.brokerIdentity).toMatchObject({
        schemaVersion: 'bayn.broker-identity.v2',
        provider: BrokerProvider.Alpaca,
        environment: BrokerEnvironment.Live,
        accountId: 'live-account-integration',
      })
      expect(result.readBack).toEqual(result.recorded)
      expect(result.revoked.revocation).toMatchObject({
        schemaVersion: 'bayn.live-capital-grant-revocation.v1',
        reason: 'integration containment proof',
      })
      expect(Exit.isFailure(result.mutateGrant)).toBe(true)
      expect(Exit.isFailure(result.mutateHistorical)).toBe(true)
      expect(result.historicalAfter).toEqual({
        generation_hash: result.historical!.generation_hash,
        broker_identity_schema_version: null,
        broker_identity_hash: null,
        broker_provider: null,
        broker_environment: null,
      })
    } finally {
      await runtime.dispose()
    }
  }, 15_000)
})
