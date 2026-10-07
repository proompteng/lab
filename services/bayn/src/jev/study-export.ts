import { createHash } from 'node:crypto'
import { PgClient } from '@effect/sql-pg'
import { Data, Effect, FileSystem, Path, Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../hash'
import { CycleState } from '../cycle/model'
import {
  IsoDateSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { decodeJevBatchResult } from './batch'
import { JevPurpose } from './portfolio'
import { reproduceJevTradingSignalBatchEvidence } from './trading-signals'

export class JevStudyExportFailure extends Data.TaggedError('JevStudyExportFailure')<{
  readonly message: string
}> {}

const CycleSchema = Schema.Struct({
  cycleId: Sha256Schema,
  protocolHash: Sha256Schema,
  state: Schema.Enum(CycleState),
  decisionHash: Schema.NullOr(Sha256Schema),
})
const RowSchema = Schema.Struct({
  batchId: Sha256Schema,
  cycleId: Sha256Schema,
  observationHash: Sha256Schema,
  observation: Schema.Unknown,
  plan: Schema.Unknown,
  result: Schema.NullOr(Schema.Unknown),
})

export const verifyJevStudyExportRow = (input: unknown, sessionDate: string, accountId: string) =>
  Result.gen(function* () {
    const row = yield* Schema.decodeUnknownResult(
      RowSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError(() => new JevStudyExportFailure({ message: 'Stored batch row is malformed' })))
    const { observation, plan } = yield* reproduceJevTradingSignalBatchEvidence(row.observation, row.plan).pipe(
      Result.mapError(() => new JevStudyExportFailure({ message: `Batch ${row.batchId} does not reproduce` })),
    )
    if (
      observation.schemaVersion !== 'bayn.jev-observation.v1' ||
      observation.cycleId !== row.cycleId ||
      observation.contentHash !== row.observationHash ||
      observation.snapshot.manifest.sessionDate !== sessionDate ||
      observation.portfolio.brokerState.account.accountId !== accountId ||
      plan.batchId !== row.batchId ||
      plan.cycleId !== row.cycleId ||
      plan.observationHash !== row.observationHash
    )
      return yield* Result.fail(new JevStudyExportFailure({ message: 'Batch scope or source identity differs' }))
    const result =
      row.result === null
        ? null
        : yield* decodeJevBatchResult(plan, row.result).pipe(
            Result.mapError(() => new JevStudyExportFailure({ message: `Batch ${row.batchId} result is invalid` })),
          )
    return { ...row, plan, result, purpose: observation.portfolio.purpose }
  })

type StudyBatch = Result.Result.Success<ReturnType<typeof verifyJevStudyExportRow>>

const maximumCycles = 10_000
const maximumRecordBytes = 16 * 1024 * 1024
const maximumExportBytes = 512 * 1024 * 1024

/** Export every committed batch, including abstentions, exclusions and unfinished inference. */
export const exportJevStudySession = (
  sql: PgClient.PgClient,
  accountId: string,
  sessionDate: string,
  outputPath: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ accountId: StrictNonEmptyStringSchema, sessionDate: IsoDateSchema }),
        strictParseOptions,
      )({ accountId, sessionDate })
      const fs = yield* FileSystem.FileSystem
      const paths = yield* Path.Path
      yield* fs.makeDirectory(outputPath, { mode: 0o700 })
      const file = yield* fs.open(paths.join(outputPath, 'batches.ndjson'), { flag: 'wx', mode: 0o600 })
      const digest = createHash('sha256')
      let bytes = 0
      const write = (value: unknown) =>
        Effect.gen(function* () {
          const text = `${yield* Effect.fromResult(canonicalJsonV1Result(value))}\n`
          const encoded = new TextEncoder().encode(text)
          if (encoded.byteLength > maximumRecordBytes || bytes + encoded.byteLength > maximumExportBytes)
            return yield* new JevStudyExportFailure({ message: 'Session export exceeded its retained-data bound' })
          yield* file.writeAll(encoded)
          digest.update(encoded)
          bytes += encoded.byteLength
        })
      const receipt = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
          yield* sql`SET LOCAL statement_timeout = '5s'`
          const [cut] = yield* Schema.decodeUnknownEffect(
            Schema.Tuple([Schema.Struct({ asOf: UtcInstantSchema })]),
            strictParseOptions,
          )(
            yield* sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "asOf"`,
          )
          const cycles = yield* Schema.decodeUnknownEffect(
            Schema.Array(CycleSchema),
            strictParseOptions,
          )(
            yield* sql`
            SELECT cycle_id AS "cycleId", strategy_protocol_hash AS "protocolHash", state,
              decision_hash AS "decisionHash"
            FROM autonomous_cycles
            WHERE account_id = ${scope.accountId} AND execution_session_date = ${scope.sessionDate}::date
              AND strategy_name = 'jev'
            ORDER BY cycle_id COLLATE "C" LIMIT ${maximumCycles + 1}
          `,
          )
          if (cycles.length > maximumCycles)
            return yield* new JevStudyExportFailure({ message: 'Session exceeds the complete cycle inventory bound' })
          const accountBindingHash = yield* Effect.fromResult(
            canonicalHashV1Result({ schemaVersion: 'bayn.jev-study-account.v1', accountId: scope.accountId }),
          )
          yield* write({
            schemaVersion: 'bayn.jev-study-session.v1',
            accountBindingHash,
            sessionDate: scope.sessionDate,
            asOf: cut.asOf,
            cycles,
          })
          let lastBatchId: string | null = null
          let batchCount = 0
          let pendingResultCount = 0
          let entryBatchCount = 0
          for (;;) {
            // Fetch one large observation at a time; never aggregate JSON or materialize the session on the server.
            const rows: readonly Record<string, unknown>[] = yield* sql<Record<string, unknown>>`
              WITH selected AS MATERIALIZED (
                SELECT plan.batch_id FROM jev_batch_plans AS plan
                JOIN autonomous_cycles AS cycle ON cycle.cycle_id = plan.cycle_id
                WHERE cycle.account_id = ${scope.accountId} AND cycle.execution_session_date = ${scope.sessionDate}::date
                  AND cycle.strategy_name = 'jev'
                  AND (${lastBatchId}::text IS NULL OR plan.batch_id COLLATE "C" > ${lastBatchId}::text COLLATE "C")
                ORDER BY plan.batch_id COLLATE "C" LIMIT 1
              )
              SELECT plan.batch_id AS "batchId", plan.cycle_id AS "cycleId", plan.observation_hash AS "observationHash",
                observation.payload AS observation, plan.payload AS plan, result.payload AS result
              FROM selected JOIN jev_batch_plans AS plan USING (batch_id)
              LEFT JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
              LEFT JOIN jev_batch_results AS result USING (batch_id)
            `
            if (rows.length === 0) break
            if (rows.length !== 1)
              return yield* new JevStudyExportFailure({ message: 'Batch paging returned a duplicate row' })
            const row: StudyBatch = yield* Effect.fromResult(
              verifyJevStudyExportRow(rows[0], scope.sessionDate, scope.accountId),
            )
            if (!cycles.some((cycle) => cycle.cycleId === row.cycleId))
              return yield* new JevStudyExportFailure({ message: 'Batch is outside the retained cycle inventory' })
            if (lastBatchId !== null && row.batchId <= lastBatchId)
              return yield* new JevStudyExportFailure({ message: 'Batch inventory did not advance' })
            yield* write(row)
            lastBatchId = row.batchId
            batchCount += 1
            if (row.result === null) pendingResultCount += 1
            if (row.purpose === JevPurpose.Entry) entryBatchCount += 1
          }
          return {
            schemaVersion: 'bayn.jev-study-export.v1',
            accountBindingHash,
            sessionDate: scope.sessionDate,
            asOf: cut.asOf,
            cycleCount: cycles.length,
            batchCount,
            entryBatchCount,
            managementBatchCount: batchCount - entryBatchCount,
            pendingResultCount,
            sourceCoverage: 'RECORDED_OBSERVATIONS_ONLY',
            qualification: 'UNQUALIFIED',
            controllerCoverage: 'UNKNOWN',
          } as const
        }),
      )
      yield* file.sync
      const material = { ...receipt, bytes, dataSha256: digest.digest('hex') }
      const report = { ...material, receiptHash: yield* Effect.fromResult(canonicalHashV1Result(material)) }
      const receiptFile = yield* fs.open(paths.join(outputPath, 'receipt.json'), { flag: 'wx', mode: 0o600 })
      yield* receiptFile.writeAll(new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`))
      yield* receiptFile.sync
      return report
    }),
  )
