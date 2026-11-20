import { Effect, Result, Schema } from 'effect'
import { SqlClient } from 'effect/sql'

import { canonicalHashV1Result } from '../src/hash'
import { JevBatchResultSchema, JevCandidateResultStatus } from '../src/jev/batch'
import { JevEvidenceError } from '../src/jev/evidence'
import { decodeJevResolution, JevResolutionStatus, makeJevResolution } from '../src/jev/resolution'
import { Sha256Schema, SymbolSchema, UtcInstantSchema } from '../src/schemas'

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const Request = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-evaluation-request.v1'),
  requestId: Sha256Schema,
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  snapshotId: Sha256Schema,
  symbol: SymbolSchema,
  observedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})
const Plan = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-batch-plan.v3'),
  batchId: Sha256Schema,
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  candidates: Schema.Array(
    Schema.Union([
      Schema.Struct({ status: Schema.Literal('EXCLUDED'), symbol: SymbolSchema }),
      Schema.Struct({ status: Schema.Literal('REQUESTED'), symbol: SymbolSchema, request: JsonObject }),
    ]),
  ),
})
const Claim = Schema.Struct({
  request_id: Sha256Schema,
  payload: JsonObject,
  receipt: Schema.NullOr(Schema.Unknown),
  resolution: Schema.NullOr(Schema.Unknown),
})
type Claim = typeof Claim.Type
const invalid = () => Result.fail(new JevEvidenceError({ message: 'Retired Jev batch settlement evidence differs' }))

// One-time financial finalization, never an inference or admission decoder. Keep the original plan/request bytes.
export const settleRetiredJevBatch = (input: unknown, claims: readonly Claim[], completedAt: string) =>
  Result.gen(function* () {
    const original = yield* Schema.decodeUnknownResult(JsonObject)(input)
    const plan = yield* Schema.decodeUnknownResult(Plan)(original)
    yield* Schema.decodeUnknownResult(UtcInstantSchema)(completedAt)
    const { batchId: _, ...material } = original
    if (
      (yield* canonicalHashV1Result(material)) !== plan.batchId ||
      completedAt < plan.expiresAt ||
      plan.expiresAt <= plan.observedAt ||
      plan.candidates.length === 0
    )
      return yield* invalid()
    const byId = new Map(claims.map((claim) => [claim.request_id, claim]))
    const resolutions = []
    const candidates = []
    let previous = ''
    for (const candidate of plan.candidates) {
      if (candidate.symbol <= previous) return yield* invalid()
      previous = candidate.symbol
      if (candidate.status === 'EXCLUDED') {
        candidates.push({ status: JevCandidateResultStatus.Excluded, symbol: candidate.symbol })
        continue
      }
      const request = yield* Schema.decodeUnknownResult(Request)(candidate.request)
      const { requestId: _, ...requestMaterial } = candidate.request
      if (
        (yield* canonicalHashV1Result(requestMaterial)) !== request.requestId ||
        request.symbol !== candidate.symbol ||
        request.cycleId !== plan.cycleId ||
        request.authorityGenerationHash !== plan.authorityGenerationHash ||
        request.snapshotId !== plan.snapshotId ||
        request.observedAt !== plan.observedAt ||
        request.expiresAt !== plan.expiresAt
      )
        return yield* invalid()
      const claim = byId.get(request.requestId)
      if (claim === undefined) {
        candidates.push({
          status: JevCandidateResultStatus.Unattempted,
          symbol: candidate.symbol,
          requestId: request.requestId,
        })
        continue
      }
      byId.delete(request.requestId)
      if (
        claim.receipt !== null ||
        (yield* canonicalHashV1Result(claim.payload)) !== (yield* canonicalHashV1Result(candidate.request))
      )
        return yield* invalid()
      const resolution =
        claim.resolution === null
          ? yield* makeJevResolution(request, null, {
              schemaVersion: 'bayn.jev-evaluation-resolution.v1',
              requestId: request.requestId,
              status: JevResolutionStatus.Abandoned,
              abandonedAt: completedAt,
            })
          : yield* decodeJevResolution(request, null, claim.resolution)
      if (resolution.status !== JevResolutionStatus.Abandoned || resolution.abandonedAt > completedAt)
        return yield* invalid()
      resolutions.push(resolution)
      candidates.push({
        status: JevCandidateResultStatus.Resolved,
        symbol: candidate.symbol,
        requestId: request.requestId,
        receipt: null,
        resolution,
      })
    }
    if (byId.size !== 0) return yield* invalid()
    const resultMaterial = { schemaVersion: 'bayn.jev-batch-result.v1', batchId: plan.batchId, completedAt, candidates }
    const result = yield* Schema.decodeUnknownResult(JevBatchResultSchema)({
      ...resultMaterial,
      resultHash: yield* canonicalHashV1Result(resultMaterial),
    })
    return { result, resolutions }
  })

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  // Retired writers cannot race the absence-of-claim proof or the append-only terminal records.
  yield* sql`LOCK TABLE jev_evaluation_requests, jev_evaluation_receipts, jev_evaluation_resolutions,
    jev_batch_plans, jev_batch_results IN SHARE ROW EXCLUSIVE MODE`
  const rows = yield* sql`WITH pending AS MATERIALIZED (
    SELECT plan.batch_id FROM jev_batch_plans plan
    JOIN autonomous_cycles cycle USING (cycle_id)
    WHERE cycle.state IN ('COMPLETED','NO_TRADE','BLOCKED') AND cycle.terminal_at IS NOT NULL
      AND cycle.terminal_at <= transaction_timestamp()
      AND NOT EXISTS (SELECT 1 FROM jev_batch_results result WHERE result.batch_id=plan.batch_id)
  ) SELECT plan.payload,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at
    FROM pending JOIN jev_batch_plans plan USING (batch_id)`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ payload: Schema.Unknown, completed_at: UtcInstantSchema })),
      ),
    ),
  )
  for (const row of rows) {
    const version = yield* Schema.decodeUnknownEffect(Schema.Struct({ schemaVersion: Schema.String }))(row.payload)
    if (version.schemaVersion !== 'bayn.jev-batch-plan.v3') continue
    const plan = yield* Schema.decodeUnknownEffect(Plan)(row.payload)
    const ids = plan.candidates.flatMap((candidate) =>
      candidate.status === 'EXCLUDED' ? [] : [candidate.request['requestId']],
    )
    const claims =
      yield* sql`SELECT request.request_id, request.payload, receipt.payload AS receipt, resolution.payload AS resolution
      FROM jev_evaluation_requests request
      LEFT JOIN jev_evaluation_receipts receipt USING (request_id)
      LEFT JOIN jev_evaluation_resolutions resolution USING (request_id)
      WHERE request.request_id = ANY(${ids}::text[])`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Claim))),
      )
    const { result, resolutions } = yield* Effect.fromResult(
      settleRetiredJevBatch(row.payload, claims, row.completed_at),
    )
    for (const resolution of resolutions)
      yield* sql`INSERT INTO jev_evaluation_resolutions (request_id,resolution_hash,payload)
        VALUES (${resolution.requestId},${resolution.resolutionHash},${JSON.stringify(resolution)}::jsonb) ON CONFLICT DO NOTHING`
    yield* sql`INSERT INTO jev_batch_results (batch_id,result_hash,payload)
      VALUES (${result.batchId},${result.resultHash},${JSON.stringify(result)}::jsonb)`
  }
})
