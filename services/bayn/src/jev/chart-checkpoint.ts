import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { makeNativeChartEvidence } from './chart-evidence'
import { makeChartDecisionsRequest } from './chart-questions'
import { JevContractError } from './contract'
import {
  DecisionsInferenceSchema,
  DecisionsUsageSchema,
  decodeDecisionsResponse,
  validDecisionsUsage,
  type DecisionsRequest,
} from './decisions'
import type { JevEvaluationRequest } from './evidence'
import type { EntryHandoffMaterial } from './entry-inference'

const ClaimMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.chart-dispatch-claim.v1'),
  stage: Schema.Literal('CHART'),
  requestId: Sha256Schema,
  providerRequestHash: Sha256Schema,
  claimedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})
export const ChartDispatchClaimSchema = Schema.Struct({ ...ClaimMaterial.fields, claimHash: Sha256Schema })
export type ChartDispatchClaim = typeof ChartDispatchClaimSchema.Type
export const ChartTerminalOutcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('RECEIVED'), inference: DecisionsInferenceSchema }),
  Schema.Struct({
    status: Schema.Literal('FAILED'),
    failure: Schema.Struct({
      category: Schema.Literals(['REQUEST', 'TRANSPORT', 'STATUS', 'RESPONSE', 'DEADLINE']),
      httpStatus: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
      responseHash: Schema.NullOr(Sha256Schema),
      usage: Schema.NullOr(DecisionsUsageSchema),
    }),
  }),
])
const ReceiptMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.chart-terminal-receipt.v1'),
  requestId: Sha256Schema,
  claimHash: Sha256Schema,
  recordedAt: UtcInstantSchema,
  outcome: ChartTerminalOutcomeSchema,
})
export const ChartTerminalReceiptSchema = Schema.Struct({ ...ReceiptMaterial.fields, terminalHash: Sha256Schema })
export type ChartTerminalReceipt = typeof ChartTerminalReceiptSchema.Type
export const ChartCheckpointSchema = Schema.Struct({
  claim: ChartDispatchClaimSchema,
  terminal: Schema.NullOr(ChartTerminalReceiptSchema),
})
export type ChartCheckpoint = typeof ChartCheckpointSchema.Type
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

export const makeChartDispatchClaim = (input: typeof ClaimMaterial.Type) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(ClaimMaterial, strictParseOptions)(input)
    return { ...material, claimHash: yield* canonicalHashV1Result(material) }
  })

export const makeChartTerminalReceipt = (input: typeof ReceiptMaterial.Type) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(ReceiptMaterial, strictParseOptions)(input)
    return { ...material, terminalHash: yield* canonicalHashV1Result(material) }
  })

/** Financial evidence only: late terminal receipts never renew dispatch or trading validity. */
export const decodeChartCheckpointForSource = (
  source: Pick<JevEvaluationRequest, 'requestId' | 'observedAt' | 'expiresAt'> & {
    readonly chartRequest: { readonly request: DecisionsRequest; readonly requestHash: string }
  },
  input: unknown,
) =>
  Result.gen(function* () {
    const request = source
    const checkpoint = yield* Schema.decodeUnknownResult(ChartCheckpointSchema, strictParseOptions)(input)
    const { claimHash, ...claim } = checkpoint.claim
    const prepared = source.chartRequest
    if (
      claim.requestId !== request.requestId ||
      claim.providerRequestHash !== prepared.requestHash ||
      claim.expiresAt !== request.expiresAt ||
      claim.claimedAt < request.observedAt ||
      claim.claimedAt >= request.expiresAt ||
      (yield* canonicalHashV1Result(claim)) !== claimHash
    )
      return yield* invalid('Chart dispatch checkpoint differs from its original current request')
    const terminal = checkpoint.terminal
    if (terminal === null) return checkpoint
    const { terminalHash, ...material } = terminal
    if (
      terminal.requestId !== request.requestId ||
      terminal.claimHash !== claimHash ||
      terminal.recordedAt < claim.claimedAt ||
      (yield* canonicalHashV1Result(material)) !== terminalHash
    )
      return yield* invalid('Chart terminal checkpoint identity or clocks differ')
    if (terminal.outcome.status === 'RECEIVED') {
      const inference = terminal.outcome.inference
      yield* decodeDecisionsResponse(prepared.request, inference.response)
      if (
        inference.requestHash !== prepared.requestHash ||
        inference.startedAt < claim.claimedAt ||
        inference.startedAt >= claim.expiresAt ||
        inference.completedAt < inference.startedAt ||
        inference.completedAt > terminal.recordedAt ||
        (yield* canonicalHashV1Result(inference.response)) !== inference.responseHash
      )
        return yield* invalid('Chart terminal response does not reproduce its claimed provider request')
    } else if (terminal.outcome.failure.usage !== null && !validDecisionsUsage(terminal.outcome.failure.usage)) {
      return yield* invalid('Chart terminal failure contains invalid metering')
    }
    return checkpoint
  })

export const decodeChartCheckpoint = (request: JevEvaluationRequest, input: unknown) =>
  Result.gen(function* () {
    const chart = yield* makeNativeChartEvidence(request.request.chartSource)
    const chartRequest = yield* makeChartDecisionsRequest({
      chart,
      protocol: request.request.protocol,
      funding: request.request.funding,
    })
    return yield* decodeChartCheckpointForSource({ ...request, chartRequest }, input)
  })

export const verifyChartCheckpointHandoff = (checkpoint: ChartCheckpoint, handoff: EntryHandoffMaterial) =>
  Result.gen(function* () {
    const terminal = checkpoint.terminal
    if (terminal === null || terminal.recordedAt > handoff.recordedAt)
      return yield* invalid('Chart handoff has no preceding committed terminal checkpoint')
    const disposition = handoff.disposition
    if (terminal.outcome.status === 'RECEIVED') {
      if (
        disposition.status === 'VISUAL_FAILED' ||
        disposition.status === 'SOURCE_INFEASIBLE' ||
        (yield* canonicalHashV1Result(disposition.visual)) !==
          (yield* canonicalHashV1Result(terminal.outcome.inference))
      )
        return yield* invalid('Chart handoff differs from its committed provider receipt')
    } else if (
      disposition.status !== 'VISUAL_FAILED' ||
      (yield* canonicalHashV1Result(disposition.failure)) !== (yield* canonicalHashV1Result(terminal.outcome.failure))
    ) {
      return yield* invalid('Chart handoff differs from its committed failure receipt')
    }
  })
