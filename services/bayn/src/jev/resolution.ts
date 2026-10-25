import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { JevEvidenceError, type JevEvaluationReceipt, type JevEvaluationRequest } from './evidence'

export enum JevResolutionStatus {
  Recorded = 'RECORDED',
  Abandoned = 'ABANDONED',
}

const Common = {
  schemaVersion: Schema.Literal('bayn.jev-evaluation-resolution.v1'),
  requestId: Sha256Schema,
}
const RecordedMaterial = Schema.Struct({
  ...Common,
  status: Schema.Literal(JevResolutionStatus.Recorded),
  receiptHash: Sha256Schema,
})
const AbandonedMaterial = Schema.Struct({
  ...Common,
  status: Schema.Literal(JevResolutionStatus.Abandoned),
  abandonedAt: UtcInstantSchema,
})
const Material = Schema.Union([RecordedMaterial, AbandonedMaterial])
export const JevResolutionSchema = Schema.Union([
  Schema.Struct({ ...RecordedMaterial.fields, resolutionHash: Sha256Schema }),
  Schema.Struct({ ...AbandonedMaterial.fields, resolutionHash: Sha256Schema }),
])
export type JevResolution = typeof JevResolutionSchema.Type

export interface JevEvaluationEvidence {
  readonly request: JevEvaluationRequest
  readonly receipt: JevEvaluationReceipt | null
  readonly resolution: JevResolution | null
}

export const makeJevResolution = (
  request: JevEvaluationRequest,
  receipt: JevEvaluationReceipt | null,
  input: unknown,
) =>
  Schema.decodeUnknownResult(
    Material,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(() => new JevEvidenceError({ message: 'Jev evaluation resolution is malformed' })),
    Result.flatMap((material) => {
      if (
        material.requestId !== request.requestId ||
        (material.status === JevResolutionStatus.Recorded &&
          (receipt === null ||
            receipt.requestId !== request.requestId ||
            material.receiptHash !== receipt.receiptHash)) ||
        (material.status === JevResolutionStatus.Abandoned && material.abandonedAt < request.expiresAt)
      )
        return Result.fail(
          new JevEvidenceError({ message: 'Jev resolution does not match its request, receipt or deadline' }),
        )
      return canonicalHashV1Result(material).pipe(
        Result.mapError(() => new JevEvidenceError({ message: 'Jev resolution cannot be hashed' })),
        Result.map((resolutionHash) => ({ ...material, resolutionHash })),
      )
    }),
  )

export const decodeJevResolution = (
  request: JevEvaluationRequest,
  receipt: JevEvaluationReceipt | null,
  input: unknown,
) =>
  Schema.decodeUnknownResult(
    JevResolutionSchema,
    strictParseOptions,
  )(input).pipe(
    Result.mapError(() => new JevEvidenceError({ message: 'Stored Jev resolution is malformed' })),
    Result.flatMap(({ resolutionHash, ...material }) =>
      makeJevResolution(request, receipt, material).pipe(
        Result.flatMap((resolution) =>
          resolution.resolutionHash === resolutionHash
            ? Result.succeed(resolution)
            : Result.fail(new JevEvidenceError({ message: 'Stored Jev resolution hash differs' })),
        ),
      ),
    ),
  )
