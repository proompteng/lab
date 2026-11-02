import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevContractError, JevFailure } from './contract'
import { decodeEntryHandoff, decodeStagedEntryHandoff, verifyEntryCompletion } from './entry-inference-evidence'
import { type EntryHandoff } from './entry-inference'
import {
  decodeJevEvaluationRequest,
  decodeJevEvaluationReceipt,
  JevOutcome,
  JevEvaluationRequestSchema,
  JevEvaluationReceiptSchema,
} from './evidence'
import { decodeJevResolution } from './resolution'
import { decodeStagedCheckpointForRequest, type StagedCheckpoint } from './staged-checkpoint'
import type { DecisionsUsageSchema } from './decisions'
import {
  AblationEntryInferenceInputSchema,
  CandidateEntryInferenceInputSchema,
  verifyEntryInferenceSource,
} from './entry-inference-input'
import {
  jevProtocolSchemaForQuestionPolicy,
  RetainedJevProtocolV30Schema,
  RetainedJevProtocolV31Schema,
  RetainedJevProtocolV32Schema,
  RetainedJevProtocolV33Schema,
  RetainedJevProtocolV34Schema,
  RetainedJevProtocolV35Schema,
} from './protocol'
import * as retainedChartStages from './retained-filtered-staged-chart-questions'
import * as currentChartStages from './staged-chart-questions'
import * as retainedCandidateChartStages from './retained-candidate-staged-chart-questions'
import { makeEntryJudgmentRequest } from './entry-questions'
import {
  retainedFundedEntryJudgmentPolicy,
  makeRetainedFundedEntryJudgmentRequest,
} from './retained-funded-entry-questions'
import { strictParseOptions } from '../schemas'
import { makeRetainedMarketEntryJudgmentRequest } from './retained-market-entry-questions'

export const retainedStagedQuestionPolicyHash = Result.getOrThrow(
  canonicalHashV1Result({
    chart: retainedChartStages.stagedChartQuestionPolicy,
    jev: retainedFundedEntryJudgmentPolicy,
  }),
)
export const retainedMarketQuestionPolicyHash = 'abf1e97da2d6a9bdef380aa224cde4245aa332c2686976bb9d755ad9a1a60910'
const RetainedMarketProtocol = Schema.Union([
  jevProtocolSchemaForQuestionPolicy(retainedMarketQuestionPolicyHash, 'bayn.jev.protocol.v26'),
  jevProtocolSchemaForQuestionPolicy(retainedMarketQuestionPolicyHash, 'bayn.jev.protocol.v27'),
  jevProtocolSchemaForQuestionPolicy(retainedMarketQuestionPolicyHash, 'bayn.jev.protocol.v28'),
  jevProtocolSchemaForQuestionPolicy(retainedMarketQuestionPolicyHash, 'bayn.jev.protocol.v29'),
  RetainedJevProtocolV30Schema,
  RetainedJevProtocolV31Schema,
  RetainedJevProtocolV32Schema,
  RetainedJevProtocolV33Schema,
])
const RetainedRequest = Schema.Struct({
  ...JevEvaluationRequestSchema.fields,
  request: Schema.Union([
    Schema.Struct({ ...CandidateEntryInferenceInputSchema.fields, protocol: RetainedJevProtocolV35Schema }),
    Schema.Struct({
      ...CandidateEntryInferenceInputSchema.fields,
      schemaVersion: Schema.Literal('bayn.entry-inference-input.v7'),
      protocol: RetainedJevProtocolV34Schema,
    }),
    Schema.Struct({
      ...CandidateEntryInferenceInputSchema.fields,
      schemaVersion: Schema.Literal('bayn.entry-inference-input.v6'),
      protocol: Schema.Union([
        RetainedJevProtocolV30Schema,
        RetainedJevProtocolV31Schema,
        RetainedJevProtocolV32Schema,
        RetainedJevProtocolV33Schema,
      ]),
    }),
    Schema.Struct({
      ...CandidateEntryInferenceInputSchema.fields,
      schemaVersion: Schema.Literal('bayn.entry-inference-input.v5'),
      protocol: Schema.Union([
        jevProtocolSchemaForQuestionPolicy(retainedStagedQuestionPolicyHash, 'bayn.jev.protocol.v26'),
        RetainedMarketProtocol,
      ]),
    }),
    Schema.Struct({
      ...AblationEntryInferenceInputSchema.fields,
      protocol: Schema.Union([RetainedMarketProtocol, RetainedJevProtocolV34Schema, RetainedJevProtocolV35Schema]),
    }),
  ]),
})
const decodeRetainedRequest = (input: unknown) =>
  Result.gen(function* () {
    const request = yield* Schema.decodeUnknownResult(RetainedRequest, strictParseOptions)(input)
    const { requestId, ...material } = request
    const prepared = yield* verifyEntryInferenceSource(request.request)
    if (
      requestId !== (yield* canonicalHashV1Result(material)) ||
      request.requestHash !== prepared.requestHash ||
      request.symbol !== request.request.chartSource.symbol ||
      request.request.chartSource.windowEndAt > request.observedAt ||
      Date.parse(request.expiresAt) - Date.parse(request.observedAt) !== request.request.protocol.inferenceValidityMs
    )
      return yield* invalid('Retained staged request identity or original validity interval does not reproduce')
    return request
  })

const invalid = (message: string) => Result.fail(new JevContractError({ message }))
export const verifyStagedCheckpointHandoff = (checkpoint: StagedCheckpoint, handoff: EntryHandoff) =>
  Result.gen(function* () {
    for (const row of [...checkpoint.claims, ...checkpoint.terminals, ...checkpoint.skips]) {
      const at = 'claimedAt' in row ? row.claimedAt : row.recordedAt
      if (at > handoff.recordedAt) return yield* invalid('Staged handoff precedes committed provider evidence')
    }
    const chart = checkpoint.terminals.find((row) => row.stage === 'CHART')
    const disposition = handoff.disposition
    if (disposition.status === 'SOURCE_INFEASIBLE') {
      if (checkpoint.claims.length !== 0) return yield* invalid('Source-infeasible handoff omits a visual dispatch')
    } else {
      if (chart === undefined) return yield* invalid('Staged handoff has no committed chart terminal')
      const expected =
        disposition.status === 'VISUAL_FAILED'
          ? { status: 'FAILED', failure: disposition.failure }
          : { status: 'RECEIVED', inference: disposition.visual }
      if ((yield* canonicalHashV1Result(expected)) !== (yield* canonicalHashV1Result(chart.outcome)))
        return yield* invalid('Staged handoff changes the committed chart outcome')
    }
    const base = handoff.baseStart
    if (base.status === 'NOT_REQUESTED') {
      const skip = checkpoint.skips.find((row) => row.stage === 'BASE_START')
      if (skip === undefined || (yield* canonicalHashV1Result(skip)) !== (yield* canonicalHashV1Result(base.skip)))
        return yield* invalid('Staged handoff changes its committed base-start skip')
    } else {
      const terminal = checkpoint.terminals.find((row) => row.stage === 'BASE_START')
      if (
        terminal === undefined ||
        (yield* canonicalHashV1Result(terminal.outcome)) !== (yield* canonicalHashV1Result(base))
      )
        return yield* invalid('Staged handoff changes its committed base-start outcome')
    }
    return handoff
  })

export interface VisualCostStage {
  readonly stage: 'CHART' | 'BASE_START'
  readonly claimHash: string | null
  readonly terminalHash: string | null
  readonly skipHash: string | null
  readonly tariffAt: string | undefined
  readonly recordedStartedAt: string | undefined
  readonly outcome: 'UNKNOWN' | 'NOT_DISPATCHED' | 'RECEIVED' | 'REJECTED'
  readonly usage: typeof DecisionsUsageSchema.Type | null
  readonly handoffHash: string | null
  readonly receiptHash: string | null
  readonly resolutionHash: string | null
}

// This is the new-version evidence boundary, not a second financial report reader.
// Full source validation happens once before the existing typed-facts pipeline.
export const readStagedInferenceCostEvidence = (row: {
  readonly request: unknown
  readonly receipt: unknown
  readonly resolution: unknown
  readonly handoff: unknown
  readonly stagedCheckpoint: unknown
}) =>
  Result.gen(function* () {
    const identity = yield* Schema.decodeUnknownResult(
      Schema.Struct({
        request: Schema.Struct({
          protocol: Schema.Struct({ schemaVersion: Schema.String, entryQuestionPolicyHash: Schema.String }),
        }),
      }),
    )(row.request)
    const retained =
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v26' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v27' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v28' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v29' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v30' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v31' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v32' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v33' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v34' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v35'
    const retainedQuestions =
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v32' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v33' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v34' ||
      identity.request.protocol.schemaVersion === 'bayn.jev.protocol.v35'
        ? makeEntryJudgmentRequest
        : identity.request.protocol.entryQuestionPolicyHash === retainedStagedQuestionPolicyHash
          ? makeRetainedFundedEntryJudgmentRequest
          : makeRetainedMarketEntryJudgmentRequest
    const decoded = retained
      ? { _tag: 'Retained' as const, request: yield* decodeRetainedRequest(row.request) }
      : { _tag: 'Current' as const, request: yield* decodeJevEvaluationRequest(row.request) }
    const request = decoded.request
    const stages =
      decoded._tag === 'Current' || request.request.protocol.schemaVersion === 'bayn.jev.protocol.v35'
        ? currentChartStages
        : request.request.protocol.schemaVersion === 'bayn.jev.protocol.v33' ||
            request.request.protocol.schemaVersion === 'bayn.jev.protocol.v34'
          ? retainedCandidateChartStages
          : retainedChartStages
    const checkpoint = yield* decodeStagedCheckpointForRequest(request, row.stagedCheckpoint, stages)
    const source = {
      requestId: request.requestId,
      input: request.request,
      observedAt: request.observedAt,
      expiresAt: request.expiresAt,
    }
    const handoff =
      row.handoff === null
        ? null
        : yield* decoded._tag === 'Retained'
            ? decodeStagedEntryHandoff(source, row.handoff, request.requestHash, retainedQuestions, stages)
            : decodeEntryHandoff({ ...source, input: decoded.request.request }, row.handoff)
    const receipt =
      row.receipt === null
        ? null
        : yield* decoded._tag === 'Retained'
            ? Schema.decodeUnknownResult(JevEvaluationReceiptSchema, strictParseOptions)(row.receipt)
            : decodeJevEvaluationReceipt(decoded.request, row.receipt)
    if (retained && receipt !== null) {
      const { receiptHash, ...material } = receipt
      if (
        receiptHash !== (yield* canonicalHashV1Result(material)) ||
        receipt.requestId !== request.requestId ||
        receipt.startedAt < request.observedAt ||
        receipt.completedAt < receipt.startedAt
      )
        return yield* invalid('Retained staged receipt identity or original clocks do not reproduce')
      if (receipt.outcome.status === JevOutcome.Completed) {
        const { handoff: completedHandoff, ...completion } = receipt.outcome.completion
        if (
          handoff === null ||
          (yield* canonicalHashV1Result(completedHandoff)) !== (yield* canonicalHashV1Result(handoff))
        )
          return yield* invalid('Retained staged completion differs from its committed handoff')
        yield* verifyEntryCompletion(source, completion, handoff)
        if (
          completion.completedAt > receipt.completedAt ||
          handoff.recordedAt < receipt.startedAt ||
          (handoff.disposition.status !== 'VISUAL_FAILED' &&
            handoff.disposition.status !== 'SOURCE_INFEASIBLE' &&
            handoff.disposition.visual.startedAt < receipt.startedAt)
        )
          return yield* invalid('Retained staged receipt precedes its provider evidence')
      } else if (
        receipt.outcome.failure === JevFailure.NotDispatched &&
        (receipt.startedAt >= request.expiresAt || receipt.completedAt < request.expiresAt)
      )
        return yield* invalid('Retained staged non-dispatch does not prove original expiry')
    }
    const resolution = row.resolution === null ? null : yield* decodeJevResolution(request, receipt, row.resolution)
    if (handoff !== null) yield* verifyStagedCheckpointHandoff(checkpoint, handoff)
    if (
      receipt?.outcome.status === JevOutcome.Completed &&
      (handoff === null || receipt.outcome.completion.handoff.handoffHash !== handoff.handoffHash)
    )
      return yield* invalid('Staged completion differs from its committed handoff')
    const expiredUndispatched =
      receipt?.outcome.status === JevOutcome.Failed && receipt.outcome.failure === JevFailure.NotDispatched
    if (expiredUndispatched && checkpoint.claims.length !== 0)
      return yield* invalid('Undispatched receipt omits a committed staged provider claim')
    const visualStages = (['CHART', 'BASE_START'] as const).map((stage): VisualCostStage => {
      const claim = checkpoint.claims.find((value) => value.stage === stage)
      const terminal = checkpoint.terminals.find((value) => value.stage === stage)
      const skip = stage === 'BASE_START' ? checkpoint.skips[0] : undefined
      const outcome = terminal?.outcome
      const usage = outcome?.status === 'RECEIVED' ? outcome.inference.response.usage : (outcome?.failure.usage ?? null)
      const zero = skip !== undefined || expiredUndispatched || handoff?.disposition.status === 'SOURCE_INFEASIBLE'
      return {
        stage,
        claimHash: claim?.claimHash ?? null,
        terminalHash: terminal?.terminalHash ?? null,
        skipHash: skip?.skipHash ?? null,
        tariffAt: outcome?.status === 'RECEIVED' ? outcome.inference.startedAt : claim?.claimedAt,
        recordedStartedAt: outcome?.status === 'RECEIVED' ? outcome.inference.startedAt : undefined,
        outcome: zero
          ? 'NOT_DISPATCHED'
          : usage === null
            ? 'UNKNOWN'
            : outcome?.status === 'RECEIVED'
              ? 'RECEIVED'
              : 'REJECTED',
        usage,
        handoffHash: claim !== undefined || skip !== undefined ? null : (handoff?.handoffHash ?? null),
        receiptHash: expiredUndispatched ? receipt.receiptHash : null,
        resolutionHash: expiredUndispatched ? (resolution?.resolutionHash ?? null) : null,
      }
    })
    return { request, receipt, resolution, handoff, checkpoint, visualStages }
  })
