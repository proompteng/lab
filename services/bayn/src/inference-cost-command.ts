import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Cause, DateTime, Effect, FileSystem, Logger, Redacted, Result, Schema, Stdio, Stream } from 'effect'

import { PostgresClientLive } from './db/postgres-client'
import { researchLedgerReaderConfig, researchReaderConfig } from './db/research-reader-config'
import { canonicalJsonV1Result } from './hash'
import { InferenceCostError, makeInferenceCostReport } from './inference-costs'
import { readInferenceCostEvidence } from './inference-costs-postgres'
import { makeOperatingCostReport } from './operating-costs'
import { readOperatingCostPacket } from './operating-cost-files'
import { IsoDateSchema } from './schemas'
import { inferenceExpenseLedger, verifyInferenceExpenseCoverage } from './inference-expense'
import { readInferenceExpenseLedger } from './inference-expense-journal'
import { makeInferenceExpenseStore } from './inference-expense-postgres'
import { makeTigerBeetleRequestClient } from './tigerbeetle-client'

export const INFERENCE_COST_COMMAND_USAGE =
  'Usage: bayn-inference-cost (--session YYYY-MM-DD | --evidence evidence.json) --rate-card rates.json [--expenses packet.json] | --ledger-session YYYY-MM-DD | --help'

type InferenceCostCommand =
  | { readonly _tag: 'Help' }
  | { readonly _tag: 'LedgerSession'; readonly sessionDate: string }
  | {
      readonly _tag: 'Session'
      readonly sessionDate: string
      readonly rateCardPath: string
      readonly expensesPath?: string
    }
  | {
      readonly _tag: 'Evidence'
      readonly evidencePath: string
      readonly rateCardPath: string
      readonly expensesPath?: string
    }

export const parseInferenceCostArgs = (
  args: readonly string[],
): Result.Result<InferenceCostCommand, InferenceCostError> => {
  if (args.length === 1 && args[0] === '--help') return Result.succeed({ _tag: 'Help' })
  const value = args[1]
  if (
    args.length === 2 &&
    args[0] === '--ledger-session' &&
    value !== undefined &&
    Result.isSuccess(Schema.decodeUnknownResult(IsoDateSchema)(value))
  )
    return Result.succeed({ _tag: 'LedgerSession', sessionDate: value })
  const rateCardPath = args[3]
  const expensesPath = args[5]
  const hasExpenses =
    args.length === 6 &&
    args[4] === '--expenses' &&
    expensesPath !== undefined &&
    expensesPath.trim() !== '' &&
    !expensesPath.startsWith('--')
  if (
    (args.length === 4 || hasExpenses) &&
    args[2] === '--rate-card' &&
    value !== undefined &&
    rateCardPath !== undefined &&
    [value, rateCardPath].every((part) => part.trim().length > 0 && !part.startsWith('--'))
  ) {
    const extra = hasExpenses ? { expensesPath } : {}
    if (args[0] === '--evidence')
      return Result.succeed({ _tag: 'Evidence', evidencePath: value, rateCardPath, ...extra })
    if (args[0] === '--session' && Result.isSuccess(Schema.decodeUnknownResult(IsoDateSchema)(value)))
      return Result.succeed({ _tag: 'Session', sessionDate: value, rateCardPath, ...extra })
  }
  return Result.fail(new InferenceCostError({ message: INFERENCE_COST_COMMAND_USAGE }))
}

const readJson = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs.readFileString(path)
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)
  }).pipe(
    Effect.mapError(() => new InferenceCostError({ message: 'Inference cost input file is unavailable or invalid' })),
  )

const readSession = (sessionDate: string) =>
  Effect.gen(function* () {
    // Deliberately require no broker key or model key: this command has no broker or inference client.
    const config = yield* researchReaderConfig
    const read = Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      return yield* readInferenceCostEvidence(sql, Redacted.value(config.accountId), sessionDate)
    })
    return yield* read.pipe(
      // @effect-diagnostics-next-line strictEffectProvide:off -- read-only command owns the scoped database layer
      Effect.provide(
        PostgresClientLive({
          operationTimeoutMs: 30_000,
          postgres: { url: config.url, tls: config.tls, caPath: config.caPath },
        }),
      ),
    )
  }).pipe(Effect.mapError(() => new InferenceCostError({ message: 'Inference cost session read failed' })))

const print = (value: string) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(Stream.make(`${value}\n`), stdio.stdout())
  })

export const readInferenceExpenseSession = (sessionDate: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* researchReaderConfig
      const tigerBeetle = yield* researchLedgerReaderConfig
      const read = Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const accountId = Redacted.value(config.accountId)
        const evidence = yield* readInferenceCostEvidence(sql, accountId, sessionDate)
        const rows = yield* makeInferenceExpenseStore(sql, accountId).session(sessionDate)
        const coverage = yield* Effect.fromResult(verifyInferenceExpenseCoverage(evidence, accountId, rows))
        const client = yield* makeTigerBeetleRequestClient({
          operationTimeoutMs: 30_000,
          tigerBeetle: { ...tigerBeetle, ledger: inferenceExpenseLedger },
        })
        const ledger = yield* readInferenceExpenseLedger(
          client,
          evidence.accountBindingHash,
          sessionDate,
          rows.map((row) => row.quote),
        )
        return { ...ledger, coverage, ledgerObservedAt: DateTime.formatIso(yield* DateTime.now) }
      })
      return yield* read.pipe(
        // @effect-diagnostics-next-line strictEffectProvide:off -- read-only command owns the database and ledger clients
        Effect.provide(
          PostgresClientLive({
            operationTimeoutMs: 30_000,
            postgres: { url: config.url, tls: config.tls, caPath: config.caPath },
          }),
        ),
      )
    }),
  )

const readPricedReport = (args: Exclude<InferenceCostCommand, { readonly _tag: 'Help' | 'LedgerSession' }>) =>
  Effect.gen(function* () {
    const rateCard = yield* readJson(args.rateCardPath)
    const evidence = yield* args._tag === 'Evidence' ? readJson(args.evidencePath) : readSession(args.sessionDate)
    const report = yield* Effect.fromResult(makeInferenceCostReport(evidence, rateCard))
    const packet = args.expensesPath === undefined ? undefined : yield* readOperatingCostPacket(args.expensesPath)
    const economic =
      packet === undefined
        ? undefined
        : yield* Effect.fromResult(makeOperatingCostReport(report, packet.evidence, packet.verifiedSourceHashes))
    return economic === undefined
      ? report
      : { schemaVersion: 'bayn.inference-economic-report.v1', inference: report, economic }
  })

const main = Effect.scoped(
  Effect.gen(function* () {
    const args = yield* Effect.fromResult(parseInferenceCostArgs(process.argv.slice(2)))
    if (args._tag === 'Help') return yield* print(INFERENCE_COST_COMMAND_USAGE)
    const output = yield* args._tag === 'LedgerSession'
      ? readInferenceExpenseSession(args.sessionDate)
      : readPricedReport(args)
    const text = yield* Effect.fromResult(canonicalJsonV1Result(output)).pipe(
      Effect.mapError(() => new InferenceCostError({ message: 'Inference cost report encoding failed' })),
    )
    yield* print(text)
  }),
)

const program = main.pipe(
  // @effect-diagnostics-next-line strictEffectProvide:off -- command entry point owns the platform runtime
  Effect.provide(NodeServices.layer),
  Effect.tapCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause))),
  Effect.provideService(Logger.LogToStderr, true),
)
if (import.meta.main) NodeRuntime.runMain(program, { disableErrorReporting: true })
