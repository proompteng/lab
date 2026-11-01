import { makeResearchStreamDecoder, verifyOpenCodeEvidence } from './client'
import type { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { inferenceExpensePosting } from '../inference-expense'
import { postInferenceExpenses } from '../inference-expense-journal'
import { strictParseOptions } from '../schemas'
import type { TigerBeetleRequestClient } from '../tigerbeetle-client'
import {
  decodeResearchRun,
  decodeRetainedResearchRun,
  hashResearch,
  parseResearchOutput,
  ResearchError,
  ResearchReceiptSchema,
  researchRequest,
  researchServingIdentity,
  maximumResearchStreamBytes,
  sealResearchReceipt,
  type ResearchReceipt,
  type ResearchRun,
  type RetainedResearchRun,
} from './contract'

export const verifyResearchReceipt = (run: RetainedResearchRun, input: unknown) =>
  Result.gen(function* () {
    const receipt = yield* Schema.decodeUnknownResult(
      ResearchReceiptSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError((cause) => new ResearchError({ message: 'Research receipt is malformed', cause })))
    const {
      receiptHash,
      costPicoUsd: _cost,
      schemaVersion: _version,
      qualification: _qualification,
      ...material
    } = receipt
    const expected = yield* sealResearchReceipt(run, material)
    if (
      receipt.costPicoUsd !== expected.costPicoUsd ||
      receipt.responseHash !==
        (receipt.responseBase64 === '' ? null : sha256(Buffer.from(receipt.responseBase64, 'base64'))) ||
      receiptHash !== expected.receiptHash ||
      receipt.runId !== (yield* hashResearch(run)) ||
      receipt.requestHash !== (yield* hashResearch(researchRequest(run))) ||
      receipt.completedAtMs < receipt.startedAtMs
    )
      return yield* Result.fail(
        new ResearchError({ message: 'Research receipt differs from its immutable run or cost basis' }),
      )
    if (
      receipt.outcome === 'COMPLETE' &&
      (receipt.httpStatus !== 200 ||
        (yield* hashResearch(receipt.servingIdentity)) !== (yield* hashResearch(researchServingIdentity(run.policy))) ||
        receipt.firstTokenAtMs === null ||
        receipt.firstTokenAtMs < receipt.startedAtMs ||
        receipt.firstTokenAtMs > receipt.completedAtMs ||
        receipt.startedAtMs < Date.parse(run.featureCutoff) ||
        receipt.completedAtMs >= Date.parse(run.deadlineAt) ||
        receipt.usage === null ||
        receipt.usage.total_tokens !== receipt.usage.prompt_tokens + receipt.usage.completion_tokens)
    )
      return yield* Result.fail(
        new ResearchError({ message: 'Complete research receipt lacks valid timing, serving or usage evidence' }),
      )
    if (Buffer.from(receipt.responseBase64, 'base64').length > maximumResearchStreamBytes)
      return yield* Result.fail(new ResearchError({ message: 'Research response bytes exceed the serving bound' }))
    if (receipt.outcome === 'COMPLETE') {
      yield* verifyOpenCodeEvidence(run, receipt.harnessEvidence, receipt.startedAtMs)
      if (
        'harness' in run.policy &&
        (receipt.workerSourceRevision === null ||
          receipt.harnessEvidence === undefined ||
          receipt.harnessEvidence.firstTokenAtMs !== receipt.firstTokenAtMs)
      )
        return yield* Result.fail(
          new ResearchError({ message: 'OpenCode receipt lacks worker source or matching provider timing evidence' }),
        )
      const stream = makeResearchStreamDecoder(run)
      yield* stream.push(Buffer.from(receipt.responseBase64, 'base64'), receipt.startedAtMs)
      yield* stream.complete()
      if (
        JSON.stringify(stream.snapshot().usage) !== JSON.stringify(receipt.usage) ||
        stream.snapshot().responseText !== receipt.responseText ||
        stream.snapshot().serverRequestId !== receipt.serverRequestId
      )
        return yield* Result.fail(
          new ResearchError({ message: 'Research stream differs from retained usage or output' }),
        )
    }
    if (
      receipt.outcome === 'COMPLETE' &&
      JSON.stringify(receipt.instructions) !== JSON.stringify(yield* parseResearchOutput(run, receipt.responseText))
    )
      return yield* Result.fail(
        new ResearchError({ message: 'Research receipt instructions differ from its retained response' }),
      )
    return receipt
  })

export const researchExpensePlan = (run: RetainedResearchRun, input: unknown) =>
  Result.gen(function* () {
    const receipt = yield* verifyResearchReceipt(run, input)
    if (receipt.costPicoUsd === null) return { accounts: [], transfers: [] }
    const amount = BigInt(receipt.costPicoUsd)
    if (amount >= 2n ** 128n)
      return yield* Result.fail(new ResearchError({ message: 'Research expense exceeds the ledger amount bound' }))
    return inferenceExpensePosting(
      `bayn.research-expense.v1:${run.studyHash}`,
      `bayn.research-expense.transfer.v1:${receipt.runId}`,
      receipt.receiptHash,
      amount,
    )
  })

const PayloadRows = Schema.Array(Schema.Struct({ payload: Schema.Unknown }))
const PendingRows = Schema.Array(Schema.Struct({ run: Schema.Unknown, receipt: Schema.Unknown }))
export const makeResearchStore = (sql: PgClient.PgClient) => {
  const read = (runId: string) =>
    sql`SELECT payload FROM research_inference_receipts WHERE run_id = ${runId}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PayloadRows)),
      Effect.map((rows) => rows[0]?.payload),
    )
  const claim = (runId: string, run: ResearchRun) =>
    Effect.gen(function* () {
      const valid = yield* Effect.fromResult(decodeResearchRun(run))
      if ((yield* Effect.fromResult(hashResearch(valid))) !== runId)
        return yield* new ResearchError({ message: 'Research run ID differs from its canonical contract' })
      const inserted =
        yield* sql`INSERT INTO research_inference_runs (run_id, payload) VALUES (${runId}, ${sql.json(valid)}) ON CONFLICT DO NOTHING RETURNING run_id`
      const rows = yield* sql`SELECT payload FROM research_inference_runs WHERE run_id = ${runId}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PayloadRows)),
      )
      if (rows.length !== 1 || (yield* Effect.fromResult(hashResearch(rows[0]?.payload))) !== runId)
        return yield* new ResearchError({ message: 'Retained research run identity differs' })
      return inserted.length === 1
    })
  const finish = (run: ResearchRun, receipt: ResearchReceipt) =>
    Effect.gen(function* () {
      yield* Effect.fromResult(verifyResearchReceipt(run, receipt))
      yield* sql`INSERT INTO research_inference_receipts (run_id, receipt_hash, payload) VALUES (${receipt.runId}, ${receipt.receiptHash}, ${sql.json(receipt)}) ON CONFLICT DO NOTHING`
      const retained = yield* read(receipt.runId)
      if (
        (yield* Effect.fromResult(canonicalHashV1Result(retained))) !==
        (yield* Effect.fromResult(canonicalHashV1Result(receipt)))
      )
        return yield* new ResearchError({ message: 'Retained research receipt conflicts' })
    })
  const pending =
    sql`SELECT run.payload AS run, receipt.payload AS receipt FROM research_inference_receipts receipt JOIN research_inference_runs run USING (run_id) WHERE receipt.verified_at IS NULL AND receipt.payload->>'costPicoUsd' IS NOT NULL ORDER BY receipt.run_id LIMIT 16`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PendingRows)),
    )
  const acknowledge = (runId: string) =>
    sql`UPDATE research_inference_receipts SET verified_at = transaction_timestamp() WHERE run_id = ${runId} AND verified_at IS NULL`.pipe(
      Effect.asVoid,
    )
  const coverage = sql`SELECT
    (SELECT count(*)::int FROM research_inference_receipts WHERE payload->>'costPicoUsd' IS NULL) AS unpriced,
    (SELECT count(*)::int FROM research_inference_receipts WHERE verified_at IS NULL AND payload->>'costPicoUsd' IS NOT NULL) AS pending,
    (SELECT COALESCE(max(extract(epoch FROM statement_timestamp() - created_at)), 0)::double precision FROM research_inference_receipts WHERE verified_at IS NULL AND payload->>'costPicoUsd' IS NOT NULL) AS lag,
    (SELECT count(*)::int FROM research_inference_runs r WHERE claimed_at < statement_timestamp() - interval '180 seconds' AND NOT EXISTS (SELECT 1 FROM research_inference_receipts c WHERE c.run_id = r.run_id)) AS ambiguous
  `.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Tuple([
          Schema.Struct({ unpriced: Schema.Int, pending: Schema.Int, lag: Schema.Finite, ambiguous: Schema.Int }),
        ]),
      ),
    ),
    Effect.map(([row]) => row),
  )
  return { read, claim, finish, pending, acknowledge, coverage }
}
export type ResearchStore = ReturnType<typeof makeResearchStore>

export const projectResearchExpenses = Effect.fn('bayn.research.expense-projection')(function* (
  store: ResearchStore,
  client: TigerBeetleRequestClient,
) {
  const rows = yield* store.pending
  for (const row of rows) {
    const run = yield* Effect.fromResult(decodeRetainedResearchRun(row.run))
    const receipt = yield* Effect.fromResult(verifyResearchReceipt(run, row.receipt))
    if (receipt.costPicoUsd === null) continue
    yield* postInferenceExpenses(client, yield* Effect.fromResult(researchExpensePlan(run, receipt)))
    yield* store.acknowledge(receipt.runId)
    yield* Effect.logInfo('Bayn research expense verified').pipe(
      Effect.annotateLogs({
        runId: receipt.runId,
        receiptHash: receipt.receiptHash,
        costPicoUsd: receipt.costPicoUsd,
        ledger: 7002,
        unit: 'USD_PICO',
      }),
    )
  }
})
