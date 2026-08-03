import { Context, Data, Effect, Option, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import type { ForwardPerformanceReceipt } from '../forward-performance/model'

const ForwardPerformanceReceiptEnvelopeMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.forward-performance-receipt-envelope.v1'),
  authorityGenerationHash: Sha256Schema,
  cycleId: Sha256Schema,
  receiptHash: Sha256Schema,
  receipt: Schema.Unknown,
  createdAt: UtcInstantSchema,
}).check(
  Schema.makeFilter((envelope) => {
    if (typeof envelope.receipt !== 'object' || envelope.receipt === null) return false
    if (!('receiptHash' in envelope.receipt) || envelope.receipt.receiptHash !== envelope.receiptHash) return false
    return true
  }),
)

export const ForwardPerformanceReceiptEnvelopeSchema = Schema.Struct({
  ...ForwardPerformanceReceiptEnvelopeMaterialSchema.fields,
  contentHash: Sha256Schema,
}).check(
  Schema.makeFilter((envelope) => {
    const { contentHash: _contentHash, ...material } = envelope
    const expected = canonicalHashV1Result(material)
    return Result.isSuccess(expected) && expected.success === envelope.contentHash
  }),
)

export type ForwardPerformanceReceiptEnvelopeMaterial = typeof ForwardPerformanceReceiptEnvelopeMaterialSchema.Type
export type ForwardPerformanceReceiptEnvelope = Omit<typeof ForwardPerformanceReceiptEnvelopeSchema.Type, 'receipt'> & {
  readonly receipt: ForwardPerformanceReceipt
}

export const makeForwardPerformanceReceiptEnvelope = (
  material: Omit<ForwardPerformanceReceiptEnvelopeMaterial, 'receipt'> & {
    readonly receipt: ForwardPerformanceReceipt
  },
): Result.Result<ForwardPerformanceReceiptEnvelope, 'ForwardPerformanceReceiptCanonicalizationFailed'> =>
  Result.map(canonicalHashV1Result(material), (contentHash) => ({ ...material, contentHash })).pipe(
    Result.mapError(() => 'ForwardPerformanceReceiptCanonicalizationFailed' as const),
  )

export class ForwardPerformanceReceiptStoreError extends Data.TaggedError('ForwardPerformanceReceiptStoreError')<{
  readonly operation: 'bind' | 'read'
  readonly failure: 'conflict' | 'decode' | 'invariant' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ForwardPerformanceReceiptStoreShape {
  readonly read: (
    authorityGenerationHash: string,
  ) => Effect.Effect<Option.Option<ForwardPerformanceReceiptEnvelope>, ForwardPerformanceReceiptStoreError>
  readonly bind: (
    envelope: ForwardPerformanceReceiptEnvelope,
  ) => Effect.Effect<ForwardPerformanceReceiptEnvelope, ForwardPerformanceReceiptStoreError>
}

export class ForwardPerformanceReceiptStore extends Context.Service<
  ForwardPerformanceReceiptStore,
  ForwardPerformanceReceiptStoreShape
>()('bayn/ForwardPerformanceReceiptStore') {}

const decodeEnvelopeResult = Schema.decodeUnknownResult(ForwardPerformanceReceiptEnvelopeSchema, strictParseOptions)

export const decodeForwardPerformanceReceiptEnvelopeResult = (
  input: unknown,
): Result.Result<ForwardPerformanceReceiptEnvelope, unknown> =>
  decodeEnvelopeResult(input) as Result.Result<ForwardPerformanceReceiptEnvelope, unknown>
