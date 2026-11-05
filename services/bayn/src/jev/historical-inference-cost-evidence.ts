import { Data, Result, Schema } from 'effect'

import { decodeJevResolution } from './resolution'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { decodeJevResponse, JevFailure, JevRequestSchema, JevResponseSchema, prepareJevRequest } from './contract'

const RequestMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-evaluation-request.v1'),
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  snapshotId: Sha256Schema,
  symbol: SymbolSchema,
  observedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
  requestHash: Sha256Schema,
  request: JevRequestSchema,
})

const JevEvaluationRequestSchema = Schema.Struct({
  ...RequestMaterialSchema.fields,
  requestId: Sha256Schema,
})
type JevEvaluationRequest = typeof JevEvaluationRequestSchema.Type

enum JevOutcome {
  Received = 'RECEIVED',
  Failed = 'FAILED',
}

const InferenceSchema = Schema.Struct({
  requestHash: Sha256Schema,
  responseHash: Sha256Schema,
  startedAt: UtcInstantSchema,
  completedAt: UtcInstantSchema,
  response: JevResponseSchema,
})

const OutcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal(JevOutcome.Received), inference: InferenceSchema }),
  Schema.Struct({
    status: Schema.Literal(JevOutcome.Failed),
    failure: Schema.Enum(JevFailure),
    httpStatus: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
    responseHash: Schema.NullOr(Sha256Schema),
    rejectedResponse: Schema.Json,
  }),
])

const ReceiptMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-evaluation-receipt.v1'),
  requestId: Sha256Schema,
  startedAt: UtcInstantSchema,
  completedAt: UtcInstantSchema,
  outcome: OutcomeSchema,
})
const JevEvaluationReceiptSchema = Schema.Struct({
  ...ReceiptMaterialSchema.fields,
  receiptHash: Sha256Schema,
})

class HistoricalJevCostError extends Data.TaggedError('HistoricalJevCostError')<{
  readonly message: string
}> {}

const invalid = (message: string) => Result.fail(new HistoricalJevCostError({ message }))

const makeJevEvaluationRequest = (input: unknown) =>
  Schema.decodeUnknownResult(
    RequestMaterialSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(() => new HistoricalJevCostError({ message: 'Jev evaluation request is malformed' })),
    Result.flatMap((material) =>
      prepareJevRequest(material.request).pipe(
        Result.mapError(
          () => new HistoricalJevCostError({ message: 'Jev evaluation request violates the model contract' }),
        ),
        Result.flatMap((prepared) => {
          const lifetime = Date.parse(material.expiresAt) - Date.parse(material.observedAt)
          if (prepared.requestHash !== material.requestHash || lifetime <= 0 || lifetime > 10_000) {
            return invalid('Jev evaluation request has a mismatched hash or invalid validity window')
          }
          return canonicalHashV1Result(material).pipe(
            Result.mapError(() => new HistoricalJevCostError({ message: 'Jev evaluation request cannot be hashed' })),
            Result.map((requestId) => ({ ...material, requestId })),
          )
        }),
      ),
    ),
  )

const decodeJevEvaluationRequest = (input: unknown) =>
  Schema.decodeUnknownResult(
    JevEvaluationRequestSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(() => new HistoricalJevCostError({ message: 'Stored Jev evaluation request is malformed' })),
    Result.flatMap(({ requestId, ...material }) =>
      makeJevEvaluationRequest(material).pipe(
        Result.flatMap((request) =>
          request.requestId === requestId ? Result.succeed(request) : invalid('Stored Jev request identity differs'),
        ),
      ),
    ),
  )

const makeJevEvaluationReceipt = (request: JevEvaluationRequest, input: unknown) =>
  Schema.decodeUnknownResult(
    ReceiptMaterialSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(() => new HistoricalJevCostError({ message: 'Jev evaluation receipt is malformed' })),
    Result.flatMap((material) => {
      if (
        material.requestId !== request.requestId ||
        material.startedAt < request.observedAt ||
        material.completedAt < material.startedAt
      ) {
        return invalid('Jev evaluation receipt has a mismatched request or regressed clock')
      }
      const outcome = material.outcome
      if (outcome.status === JevOutcome.Received) {
        const inference = outcome.inference
        const responseHash = canonicalHashV1Result(inference.response)
        if (
          inference.requestHash !== request.requestHash ||
          inference.startedAt < material.startedAt ||
          inference.completedAt < inference.startedAt ||
          inference.completedAt > material.completedAt ||
          Result.isFailure(responseHash) ||
          responseHash.success !== inference.responseHash ||
          Result.isFailure(decodeJevResponse(request.request, inference.response))
        ) {
          return invalid('Jev inference does not match its recorded request, response or clocks')
        }
      } else if (outcome.responseHash !== null) {
        const responseHash = canonicalHashV1Result(outcome.rejectedResponse)
        if (Result.isFailure(responseHash) || responseHash.success !== outcome.responseHash) {
          return invalid('Rejected Jev response differs from its recorded hash')
        }
      }
      if (
        outcome.status === JevOutcome.Failed &&
        outcome.failure === JevFailure.NotDispatched &&
        (outcome.httpStatus !== null ||
          outcome.responseHash !== null ||
          outcome.rejectedResponse !== null ||
          material.startedAt >= request.expiresAt ||
          material.completedAt < request.expiresAt)
      )
        return invalid('Undispatched Jev evidence must prove pre-HTTP deadline expiry without a response')
      return canonicalHashV1Result(material).pipe(
        Result.mapError(() => new HistoricalJevCostError({ message: 'Jev evaluation receipt cannot be hashed' })),
        Result.map((receiptHash) => ({ ...material, receiptHash })),
      )
    }),
  )

const decodeJevEvaluationReceipt = (request: JevEvaluationRequest, input: unknown) =>
  Schema.decodeUnknownResult(
    JevEvaluationReceiptSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(() => new HistoricalJevCostError({ message: 'Stored Jev evaluation receipt is malformed' })),
    Result.flatMap(({ receiptHash, ...material }) =>
      makeJevEvaluationReceipt(request, material).pipe(
        Result.flatMap((receipt) =>
          receipt.receiptHash === receiptHash
            ? Result.succeed(receipt)
            : invalid('Stored Jev receipt identity differs'),
        ),
      ),
    ),
  )

// Read-only financial projection. Retired requests never enter the current executable codecs.
export const decodeHistoricalJevCostEvidence = (
  requestInput: unknown,
  receiptInput: unknown,
  resolutionInput: unknown,
) =>
  Result.gen(function* () {
    const request = yield* decodeJevEvaluationRequest(requestInput)
    const receipt = receiptInput === null ? null : yield* decodeJevEvaluationReceipt(request, receiptInput)
    const resolution = resolutionInput === null ? null : yield* decodeJevResolution(request, receipt, resolutionInput)
    return { request, receipt, resolution }
  })
