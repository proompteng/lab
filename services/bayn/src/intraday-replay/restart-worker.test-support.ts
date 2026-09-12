import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Clock, Config, Effect, FileSystem, Layer, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { PostgresClientLive } from '../db/postgres-client'
import { postgresMigrations } from '../db/postgres-migrations'
import { ExecutionCycleClosureStoreLive } from '../db/execution-cycle-closure-postgres'
import { PersistedCapitalGrantStoreLive } from '../db/persisted-capital-grant'
import { WriterFenceLive } from '../execution/writer-fence'
import { IntentStoreLive, BlockedCycleIntentStoreLive } from '../execution/intents'
import { MutationStoreLive } from '../execution/mutations'
import { BrokerAccess, noCapitalAuthority } from '../execution/authority'
import { BrokerEnvironment, BrokerProvider, makeBrokerIdentity } from '../broker/identity'
import { AssetClass, AssetExchange, AssetStatus, MarketCalendarResponseSchema } from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { BrokerMutationError, MutationFailure, MutationOperation, causeSummary } from '../broker/alpaca-mutations/model'
import { MutationOutcome } from '../execution/contracts'
import { JournalLive } from '../ledger'
import { Sha256Schema } from '../schemas'
import { canonicalJsonV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import type { RuntimeConfig } from '../config'
import { config as baseConfig, fixtureRuntime } from '../testing/runtime-fixtures'
import { simulationFixture } from '../testing/simulated-streaming-fixture'
import { makeReplayBroker, ReplayBrokerFailure } from './broker'
import { ReplayBrokerCheckpointSchema } from './broker-checkpoint'
import { makeSimulatedExecutionClock } from './clock'
import { makeReplayExecutionRuntime } from './runtime'
import { validateReplayDatabaseTargets } from '../session-replay-command'

const main = Effect.scoped(
  Effect.gen(function* () {
    const [mode, rawRunId, checkpointPath, resultPath] = process.argv.slice(2)
    if ((mode !== 'crash' && mode !== 'recover') || checkpointPath === undefined || resultPath === undefined)
      return yield* new ReplayBrokerFailure({ message: 'Invalid restart acceptance arguments' })
    const runId = yield* Schema.decodeUnknownEffect(Sha256Schema)(rawRunId)
    const postgresUrl = yield* Config.redacted('BAYN_TEST_POSTGRES_URL')
    const tigerAddress = yield* Config.string('BAYN_TEST_TIGERBEETLE_ADDRESS')
    if (!Redacted.value(postgresUrl).endsWith('/bayn_test'))
      return yield* new ReplayBrokerFailure({
        message: 'Restart acceptance requires its disposable bayn_test database',
      })
    const accountId = `replay-${runId}`
    const config: RuntimeConfig = {
      ...baseConfig,
      operationTimeoutMs: 10000,
      execution: {
        brokerIdentity: yield* Effect.fromResult(
          makeBrokerIdentity({
            schemaVersion: 'bayn.broker-identity.v2',
            provider: BrokerProvider.Alpaca,
            environment: BrokerEnvironment.Sandbox,
            accountId,
          }),
        ),
        brokerAccess: BrokerAccess.ReadOnly,
        capitalAuthority: noCapitalAuthority,
      },
      postgres: { url: postgresUrl, tls: false, caPath: '/unused' },
      tigerBeetle: { clusterId: 20912n, ledger: 70912, replicaAddresses: [tigerAddress] },
    }
    yield* validateReplayDatabaseTargets(config)
    const base = Layer.mergeAll(WriterFenceLive, JournalLive(config)).pipe(
      Layer.provideMerge(PostgresClientLive(config)),
    )
    const stores = Layer.mergeAll(
      IntentStoreLive,
      BlockedCycleIntentStoreLive,
      MutationStoreLive,
      ExecutionCycleClosureStoreLive,
      PersistedCapitalGrantStoreLive,
    ).pipe(Layer.provideMerge(base))
    yield* Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const fs = yield* FileSystem.FileSystem
      const fixture = simulationFixture()
      const saved =
        mode === 'recover'
          ? yield* fs
              .readFileString(checkpointPath)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ReplayBrokerCheckpointSchema))))
          : undefined
      const initialMs = saved === undefined ? Date.parse(fixture.query.observedAt) : Date.parse(saved.observedAt)
      yield* TestClock.setTime(initialMs)
      if (mode === 'crash') {
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
      }
      const source = { ...fixture.source, runId }
      const cursor = {
        ...fixture.cursor,
        runId,
        source,
        projection: { ...fixture.cursor.projection, epoch: `historical-${runId}` },
      }
      const clock = yield* makeSimulatedExecutionClock(runId, source.sourceManifestHash)
      const advanceTo = (atMs: number) =>
        clock.advanceTo(utcInstantFromEpochMillis(atMs)).pipe(
          Effect.andThen(TestClock.setTime(atMs)),
          Effect.mapError((cause) => new ReplayBrokerFailure({ message: 'Cannot advance restart test clock', cause })),
        )
      const broker = yield* makeReplayBroker({
        runId,
        sourceManifestHash: source.sourceManifestHash,
        openingCashMicros: '100000000000',
        protocol: fixture.protocol,
        assumptions: { latencyMs: 10, slippageBps: 0, availableLiquidityPpm: 1000000, feeMultiplierPpm: 1000000 },
        fractionalTrading: false,
        calendar: Result.getOrThrow(Schema.decodeUnknownResult(MarketCalendarResponseSchema)(fixture.input.calendar)),
        assets: fixture.protocol.universe.map((symbol, index) =>
          Result.getOrThrow(
            normalizeAssetResult(
              {
                id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
                symbol,
                class: AssetClass.UsEquity,
                exchange: AssetExchange.Nasdaq,
                status: AssetStatus.Active,
                tradable: true,
                fractionable: true,
              },
              symbol,
              fixture.query.observedAt,
            ),
          ),
        ),
        quoteAt: (symbol) => Effect.succeed(cursor.projection.quotes.get(symbol)),
        advanceToArrival: advanceTo,
        ...(saved === undefined ? {} : { restoreCheckpoint: saved }),
      })
      const executionBroker =
        mode === 'recover'
          ? broker
          : {
              ...broker,
              mutation: {
                ...broker.mutation,
                submit: (intent: Parameters<typeof broker.mutation.submit>[0], closeOnly?: boolean) =>
                  broker.mutation.submit(intent, closeOnly).pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        const checkpoint = yield* broker.checkpoint
                        if (checkpoint.state.fills.length === 0)
                          return yield* new ReplayBrokerFailure({ message: 'Crash point requires a committed fill' })
                        yield* fs.writeFileString(
                          checkpointPath + '.writing',
                          yield* Effect.fromResult(canonicalJsonV1Result(checkpoint)),
                          { flag: 'wx' },
                        )
                        yield* fs.rename(checkpointPath + '.writing', checkpointPath)
                        // Parent sends SIGKILL after this write. The coordinator never receives the successful broker response.
                        return yield* Effect.never
                      }).pipe(
                        Effect.mapError(
                          (cause) =>
                            new BrokerMutationError({
                              operation: MutationOperation.Submit,
                              failure: MutationFailure.Unknown,
                              outcome: MutationOutcome.Unknown,
                              message: 'Restart acceptance could not retain broker commit',
                              cause: causeSummary(cause),
                            }),
                        ),
                      ),
                    ),
                  ),
              },
            }
      // The restored broker commits at checkpoint time; the restarted process observes it after that instant.
      if (mode === 'recover') yield* advanceTo(initialMs + 1)
      const runtime = yield* makeReplayExecutionRuntime({
        config,
        strategy: fixtureRuntime,
        broker: executionBroker,
        source,
        cursor: Effect.succeed(cursor),
        clock,
        recordPass: () => Effect.void,
        pollIntervalMs: 1000,
        reconciliationIntervalMs: 1000,
        reconciliationPassTimeoutMs: 1000,
      })
      yield* advanceTo((yield* Clock.currentTimeMillis) + 1)
      for (let pass = 0; pass < 120; pass++) {
        const outcome = yield* runtime.advance
        if (outcome.observation.result === 'FAILURE')
          return yield* new ReplayBrokerFailure({ message: JSON.stringify(outcome.observation) })
        yield* advanceTo((yield* Clock.currentTimeMillis) + (outcome.nextDelayMs ?? runtime.nextDelayMs))
        if (mode === 'recover') {
          const recovered = yield* runtime.reconcile
          if (recovered.riskContext.unknownMutationCount === 0) break
        }
      }
      if (mode === 'crash')
        return yield* new ReplayBrokerFailure({ message: 'Native execution did not reach the crash point' })
      const reconciliation = yield* runtime.reconcile
      const counts = yield* sql<Record<string, unknown>>`SELECT
      (SELECT count(*)::int FROM intents WHERE account_id=${accountId}) AS intents,
      (SELECT count(*)::int FROM fills WHERE account_id=${accountId}) AS fills,
      (SELECT count(*)::int FROM accounting_transactions WHERE account_id=${accountId}) AS transactions`
      const state = yield* broker.snapshot
      yield* fs.writeFileString(
        resultPath,
        yield* Effect.fromResult(canonicalJsonV1Result({ state, reconciliation, counts })),
        { flag: 'wx' },
      )
    }).pipe(Effect.provide(Layer.mergeAll(stores, TestClock.layer())))
  }),
)
if (import.meta.main)
  NodeRuntime.runMain(main.pipe(Effect.tapCause(Effect.logError), Effect.provide(NodeServices.layer)), {
    disableErrorReporting: true,
  })
