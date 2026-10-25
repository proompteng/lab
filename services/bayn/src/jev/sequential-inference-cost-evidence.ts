import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { strictParseOptions } from '../schemas'
import { makeRetainedChartEvidenceV1 } from './chart-evidence'
import { JevContractError, JevFailure } from './contract'
import { decodeEntryHandoff, decodeEntryHandoffForChart, verifyEntryCompletion } from './entry-inference-evidence'
import { EntryInferenceInputSchema, verifyEntryInferenceSource } from './entry-inference-input'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevEvaluationReceiptSchema,
  JevEvaluationRequestSchema,
  JevOutcome,
} from './evidence'
import { decodeJevResolution } from './resolution'

const RetainedInput = Schema.Struct({
  ...EntryInferenceInputSchema.fields,
  schemaVersion: Schema.Literal('bayn.entry-inference-input.v1'),
})
const RetainedRequest = Schema.Struct({ ...JevEvaluationRequestSchema.fields, request: RetainedInput })
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

// Financial projection only. The executable entry codec accepts only v2 inputs.
export const readSequentialInferenceCostEvidence = (row: {
  readonly request: unknown
  readonly receipt: unknown
  readonly handoff: unknown
  readonly resolution: unknown
}) =>
  Result.gen(function* () {
    const version = yield* Schema.decodeUnknownResult(
      Schema.Struct({
        request: Schema.Struct({
          schemaVersion: Schema.Literals(['bayn.entry-inference-input.v1', 'bayn.entry-inference-input.v2']),
        }),
      }),
    )(row.request)
    if (version.request.schemaVersion === 'bayn.entry-inference-input.v2') {
      const request = yield* decodeJevEvaluationRequest(row.request)
      const receipt = row.receipt === null ? null : yield* decodeJevEvaluationReceipt(request, row.receipt)
      const resolution = row.resolution === null ? null : yield* decodeJevResolution(request, receipt, row.resolution)
      const handoff =
        row.handoff === null
          ? null
          : yield* decodeEntryHandoff(
              {
                requestId: request.requestId,
                input: request.request,
                observedAt: request.observedAt,
                expiresAt: request.expiresAt,
              },
              row.handoff,
            )
      return { request, receipt, resolution, handoff }
    }

    const request = yield* Schema.decodeUnknownResult(RetainedRequest, strictParseOptions)(row.request)
    const { requestId, ...material } = request
    const prepared = yield* verifyEntryInferenceSource(request.request)
    if (
      requestId !== (yield* canonicalHashV1Result(material)) ||
      request.requestHash !== prepared.requestHash ||
      request.symbol !== request.request.chartSource.symbol ||
      request.request.chartSource.windowEndAt > request.observedAt ||
      Date.parse(request.expiresAt) - Date.parse(request.observedAt) !== request.request.protocol.inferenceValidityMs
    )
      return yield* invalid('Retained chart request identity or original validity interval does not reproduce')
    const chart = yield* makeRetainedChartEvidenceV1(request.request.chartSource)
    const source = { requestId, input: request.request, observedAt: request.observedAt, expiresAt: request.expiresAt }
    const handoff =
      row.handoff === null
        ? null
        : yield* decodeEntryHandoffForChart({
            source,
            input: row.handoff,
            inputHash: prepared.requestHash,
            chart,
          })
    const receipt =
      row.receipt === null
        ? null
        : yield* Schema.decodeUnknownResult(JevEvaluationReceiptSchema, strictParseOptions)(row.receipt)
    if (receipt !== null) {
      const { receiptHash, ...receiptMaterial } = receipt
      if (
        receipt.requestId !== requestId ||
        receipt.startedAt < request.observedAt ||
        receipt.completedAt < receipt.startedAt ||
        receiptHash !== (yield* canonicalHashV1Result(receiptMaterial))
      )
        return yield* invalid('Retained chart receipt identity or clocks do not reproduce')
      if (receipt.outcome.status === JevOutcome.Completed) {
        const completion = receipt.outcome.completion
        if (handoff === null) return yield* invalid('Retained chart receipt requires its committed handoff')
        yield* verifyEntryCompletion(source, completion, handoff)
        if (
          completion.completedAt > receipt.completedAt ||
          handoff.recordedAt < receipt.startedAt ||
          (handoff.disposition.status !== 'VISUAL_FAILED' && handoff.disposition.visual.startedAt < receipt.startedAt)
        )
          return yield* invalid('Retained chart receipt precedes its provider evidence')
      } else if (
        receipt.outcome.failure === JevFailure.NotDispatched &&
        (receipt.startedAt >= request.expiresAt || receipt.completedAt < request.expiresAt)
      )
        return yield* invalid('Retained undispatched chart receipt does not prove its original deadline expiry')
    }
    const resolution = row.resolution === null ? null : yield* decodeJevResolution(request, receipt, row.resolution)
    return { request, receipt, resolution, handoff }
  })
