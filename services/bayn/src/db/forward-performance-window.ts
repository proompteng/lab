import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import type { ForwardPerformanceReceipt } from '../forward-performance/model'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { ForwardPerformanceReceiptSchema } from './forward-performance-receipt'

const schemaVersion = 'bayn.forward-performance-window.v1' as const
type Receipt = typeof ForwardPerformanceReceiptSchema.Type

export class ForwardPerformanceWindowError extends Data.TaggedError('ForwardPerformanceWindowError')<{
  readonly operation: 'construct' | 'publish' | 'read'
  readonly failure: 'incomplete' | 'hash' | 'decode' | 'binding' | 'conflict' | 'query'
  readonly message: string
  readonly cause?: unknown
}> {}

const isClosedWindow = (receipt: Receipt): boolean => {
  const { window, reconciliationProof: proof } = receipt
  return (
    receipt.evidence.status === 'SUFFICIENT' &&
    receipt.evidence.reasonCodes.length === 0 &&
    receipt.bindings.source !== null &&
    receipt.bindings.strategy !== null &&
    window.firstCycleId !== null &&
    window.lastCycleId !== null &&
    window.openedAt !== null &&
    window.closedAt !== null &&
    window.closedAt >= window.openedAt &&
    window.reconciliationId !== null &&
    window.reconciliationContentHash !== null &&
    (window.reconciliationStatus === 'EXACT' || window.cashYieldAdjustedExact === true) &&
    proof.accountingReceiptsExact &&
    proof.ledgerExact &&
    proof.missingLedgerAccountCount === 0 &&
    proof.unresolvedMutationCount === 0 &&
    proof.unclosedCycleCount === 0 &&
    proof.openPositionCount === 0 &&
    receipt.counts.completedExecutionCount > 0 &&
    receipt.totals.netRealizedReturn !== null
  )
}

const windowIdentity = (authorityGenerationHash: string, receipt: Receipt) => ({
  schemaVersion,
  authorityGenerationHash,
  accountReferenceHash: receipt.bindings.account.accountReferenceHash,
  sourceRevision: receipt.bindings.runtime.sourceRevision,
  firstCycleId: receipt.window.firstCycleId,
  lastCycleId: receipt.window.lastCycleId,
  reconciliationId: receipt.window.reconciliationId,
  reconciliationContentHash: receipt.window.reconciliationContentHash,
  evidenceCutoffAt: receipt.window.closedAt,
})

export const ForwardPerformanceWindowSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  windowId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  receipt: ForwardPerformanceReceiptSchema,
  contentHash: Sha256Schema,
}).check(
  Schema.makeFilter((window) => {
    if (!isClosedWindow(window.receipt)) return false
    const identity = canonicalHashV1Result(windowIdentity(window.authorityGenerationHash, window.receipt))
    const { contentHash: _contentHash, ...material } = window
    const content = canonicalHashV1Result(material)
    return (
      Result.isSuccess(identity) &&
      identity.success === window.windowId &&
      Result.isSuccess(content) &&
      content.success === window.contentHash
    )
  }),
)
export type ForwardPerformanceWindow = typeof ForwardPerformanceWindowSchema.Type

export const decodeForwardPerformanceWindow = (value: unknown) =>
  Schema.decodeUnknownResult(ForwardPerformanceWindowSchema)(value, strictParseOptions).pipe(
    Result.mapError(
      (cause) =>
        new ForwardPerformanceWindowError({
          operation: 'read',
          failure: 'decode',
          message: 'published performance window failed validation',
          cause,
        }),
    ),
  )

export const makeForwardPerformanceWindow = (
  authorityGenerationHash: string,
  input: ForwardPerformanceReceipt,
): Result.Result<ForwardPerformanceWindow, ForwardPerformanceWindowError> =>
  Result.gen(function* () {
    const receipt = yield* Schema.decodeUnknownResult(ForwardPerformanceReceiptSchema)(input, strictParseOptions).pipe(
      Result.mapError(
        (cause) =>
          new ForwardPerformanceWindowError({
            operation: 'construct',
            failure: 'decode',
            message: 'performance receipt failed publication validation',
            cause,
          }),
      ),
    )
    if (!isClosedWindow(receipt))
      return yield* Result.fail(
        new ForwardPerformanceWindowError({
          operation: 'construct',
          failure: 'incomplete',
          message: 'performance publication requires an exactly reconciled closed window with completed executions',
        }),
      )
    const hashFailure = (cause: unknown) =>
      new ForwardPerformanceWindowError({
        operation: 'construct',
        failure: 'hash',
        message: 'performance window identity could not be hashed',
        cause,
      })
    const windowId = yield* canonicalHashV1Result(windowIdentity(authorityGenerationHash, receipt)).pipe(
      Result.mapError(hashFailure),
    )
    const material = { schemaVersion, windowId, authorityGenerationHash, receipt }
    const contentHash = yield* canonicalHashV1Result(material).pipe(Result.mapError(hashFailure))
    return yield* decodeForwardPerformanceWindow({ ...material, contentHash })
  })
