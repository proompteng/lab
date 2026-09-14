import { validateBacktestSourceReceipt } from './intraday-replay/source'
import { OperationDeadlineClock } from './operation-timeout'
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import {
  Cause,
  Clock,
  Config,
  Data,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Path,
  Redacted,
  Schema,
  Stdio,
  Stream,
} from 'effect'
import { TestClock } from 'effect/testing'
import { PostgresClientLive } from './db/postgres-client'
import { WriterFenceLive } from './execution/writer-fence'
import { JournalLive } from './ledger'
import { IntentStoreLive, BlockedCycleIntentStoreLive } from './execution/intents'
import { MutationStoreLive } from './execution/mutations'
import { ExecutionCycleClosureStoreLive } from './db/execution-cycle-closure-postgres'
import { PersistedCapitalGrantStoreLive } from './db/persisted-capital-grant'
import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from './hash'
import { operationalError } from './errors'
import { prepareBacktest, runBacktest, type ReplayDatabaseConfig } from './intraday-replay/backtest'

const usage =
  'Usage: bayn-backtest --input <backtest.json> --arrivals <source.ndjson.gz> --source-receipt <receipt.json> --source-receipt-sha256 <trusted-hash> --output <new-directory> | --help'
class BacktestCommandFailure extends Data.TaggedError('BacktestCommandFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}
export const parseBacktestArgs = (args: readonly string[]) => {
  if (args.length === 1 && args[0] === '--help') return { _tag: 'Help' } as const
  if (
    args.length === 10 &&
    args[0] === '--input' &&
    args[2] === '--arrivals' &&
    args[4] === '--source-receipt' &&
    args[6] === '--source-receipt-sha256' &&
    args[8] === '--output' &&
    args[1] !== undefined &&
    args[3] !== undefined &&
    args[5] !== undefined &&
    args[7] !== undefined &&
    /^[a-f0-9]{64}$/.test(args[7]) &&
    args[9] !== undefined &&
    [args[1], args[3], args[5], args[9]].every((value) => value.trim().length > 0 && !value.startsWith('--'))
  )
    return {
      _tag: 'Run',
      inputPath: args[1],
      arrivalsPath: args[3],
      sourceReceiptPath: args[5],
      sourceReceiptHash: args[7],
      outputPath: args[9],
    } as const
  return { _tag: 'Invalid' } as const
}
export const validateReplayDatabaseTargets = (config: ReplayDatabaseConfig) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(Redacted.value(config.postgres.url)),
      catch: (cause) => new BacktestCommandFailure({ message: 'Invalid replay database URL', cause }),
    })
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !/\/(?:[a-z][a-z0-9_]*_)?(?:replay|test)$/.test(url.pathname) ||
      url.search !== '' ||
      url.hash !== '' ||
      config.tigerBeetle.replicaAddresses.length !== 1 ||
      !/^127\.0\.0\.1:\d+$/.test(config.tigerBeetle.replicaAddresses[0] ?? '') ||
      config.tigerBeetle.clusterId <= 0n ||
      config.tigerBeetle.ledger <= 0
    )
      return yield* new BacktestCommandFailure({
        message: 'Replay requires explicitly named local replay/test PostgreSQL and local TigerBeetle targets',
      })
  })
const print = (value: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${value}\n`), stdio.stdout())
  })
const main = Effect.scoped(
  Effect.gen(function* () {
    const args = parseBacktestArgs(process.argv.slice(2))
    if (args._tag === 'Help') return yield* print(usage)
    if (args._tag === 'Invalid') return yield* new BacktestCommandFailure({ message: usage })
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const raw = yield* fs.readFileString(args.inputPath)
    const parsed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(raw)
    const sourceReceiptText = yield* fs.readFileString(args.sourceReceiptPath)
    const sourceReceipt = yield* Effect.fromResult(
      validateBacktestSourceReceipt(sourceReceiptText, args.sourceReceiptHash),
    )
    const prepared = yield* Effect.fromResult(prepareBacktest(parsed, sourceReceipt))
    const databaseInput = yield* Config.all({
      postgresUrl: Config.redacted('BAYN_BACKTEST_POSTGRES_URL'),
      tigerBeetleAddress: Config.string('BAYN_BACKTEST_TIGERBEETLE_ADDRESS'),
      tigerBeetleCluster: Config.schema(
        Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/)),
        'BAYN_BACKTEST_TIGERBEETLE_CLUSTER_ID',
      ),
      tigerBeetleLedger: Config.int('BAYN_BACKTEST_TIGERBEETLE_LEDGER'),
    })
    const databases: ReplayDatabaseConfig = {
      operationTimeoutMs: 30_000,
      postgres: { url: databaseInput.postgresUrl, tls: false, caPath: '/unused' },
      tigerBeetle: {
        clusterId: BigInt(databaseInput.tigerBeetleCluster),
        ledger: databaseInput.tigerBeetleLedger,
        replicaAddresses: [databaseInput.tigerBeetleAddress],
      },
    }
    yield* validateReplayDatabaseTargets(databases)
    yield* fs.makeDirectory(args.outputPath, { mode: 0o700 })
    yield* fs.writeFileString(path.join(args.outputPath, 'input.json'), raw, { flag: 'wx' })
    yield* fs.writeFileString(path.join(args.outputPath, 'source-receipt.json'), sourceReceiptText, { flag: 'wx' })
    const passesPath = path.join(args.outputPath, 'passes.ndjson')
    const base = Layer.mergeAll(WriterFenceLive, JournalLive(databases)).pipe(
      Layer.provideMerge(PostgresClientLive(databases)),
    )
    const stores = Layer.mergeAll(
      IntentStoreLive,
      BlockedCycleIntentStoreLive,
      MutationStoreLive,
      ExecutionCycleClosureStoreLive,
      PersistedCapitalGrantStoreLive,
    ).pipe(Layer.provideMerge(base))
    const deadlineClock = yield* Clock.clockWith(Effect.succeed)
    const report = yield* runBacktest(prepared, args.arrivalsPath, databases, (pass) =>
      Effect.fromResult(canonicalJsonV1Result(pass)).pipe(
        Effect.flatMap((line) => fs.writeFileString(passesPath, `${line}\n`, { flag: 'a' })),
        Effect.mapError((cause) =>
          operationalError({
            component: 'strategy',
            operation: 'replay-pass',
            message: 'Cannot retain execution pass',
            cause,
          }),
        ),
      ),
    ).pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- isolated replay command owns its database and virtual clock resources
      Effect.provide(Layer.mergeAll(stores, TestClock.layer())),
      Effect.provideService(OperationDeadlineClock, deadlineClock),
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          const failure = {
            schemaVersion: 'bayn.backtest-failure.v1',
            completion: 'INCOMPLETE',
            profitability: 'UNPROVEN',
            runId: prepared.runId,
            sourceManifestHash: yield* Effect.fromResult(canonicalHashV1Result(prepared.input.source)),
            reason: Cause.pretty(cause),
          }
          const output = yield* Effect.fromResult(canonicalJsonV1Result(failure))
          yield* fs.writeFileString(path.join(args.outputPath, 'failure.json'), `${output}\n`, { flag: 'wx' })
        }),
      ),
    )
    const passText = yield* fs.readFileString(passesPath)
    const { reportHash: _reportHash, ...reportBody } = report
    const material = {
      ...reportBody,
      passLog: { file: 'passes.ndjson', sha256: sha256(passText), records: report.schedule.passCount },
    }
    const output = yield* Effect.fromResult(
      canonicalJsonV1Result({
        ...material,
        reportHash: yield* Effect.fromResult(canonicalHashV1Result(material)),
      }),
    )
    yield* fs.writeFileString(path.join(args.outputPath, 'report.json'), `${output}\n`, { flag: 'wx' })
    yield* print(output)
  }),
)
if (import.meta.main)
  NodeRuntime.runMain(
    main.pipe(
      Effect.tapCause(Effect.logError),
      // @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns platform resources
      Effect.provide(Layer.mergeAll(NodeServices.layer, Logger.layer([Logger.withConsoleError(Logger.formatJson)]))),
    ),
    { disableErrorReporting: true },
  )
