import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { makeNativeChartEvidence } from './chart-evidence'
import { JevContractError } from './contract'
import {
  DecisionsInferenceSchema,
  DecisionsUsageSchema,
  decodeDecisionsResponse,
  validDecisionsUsage,
} from './decisions'
import { decodeJevEvaluationRequest } from './evidence'
import { makeInitialChartStageRequest, makeSelectedBaseStartStageRequest } from './staged-chart-questions'
import { hasFeasibleEntrySource } from './entry-inference'

export const VisualStageSchema = Schema.Literals(['CHART', 'BASE_START'])
export const VisualStageFailureSchema = Schema.Struct({
  category: Schema.Literals(['REQUEST', 'TRANSPORT', 'STATUS', 'RESPONSE', 'DEADLINE']),
  httpStatus: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
  responseHash: Schema.NullOr(Sha256Schema),
  usage: Schema.NullOr(DecisionsUsageSchema),
})
const ClaimMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.staged-dispatch-claim.v1'),
  stage: VisualStageSchema,
  requestId: Sha256Schema,
  providerRequestHash: Sha256Schema,
  predecessorHash: Schema.NullOr(Sha256Schema),
  selectedEnd: Schema.NullOr(Schema.NonEmptyString),
  claimedAt: UtcInstantSchema,
  expiresAt: UtcInstantSchema,
})
export const StagedDispatchClaimSchema = Schema.Struct({ ...ClaimMaterial.fields, claimHash: Sha256Schema })
export type StagedDispatchClaim = typeof StagedDispatchClaimSchema.Type
export const StageTerminalOutcomeSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('RECEIVED'), inference: DecisionsInferenceSchema }),
  Schema.Struct({ status: Schema.Literal('FAILED'), failure: VisualStageFailureSchema }),
])
const TerminalMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.staged-terminal-receipt.v1'),
  stage: VisualStageSchema,
  requestId: Sha256Schema,
  claimHash: Sha256Schema,
  recordedAt: UtcInstantSchema,
  outcome: StageTerminalOutcomeSchema,
})
export const StagedTerminalReceiptSchema = Schema.Struct({ ...TerminalMaterial.fields, terminalHash: Sha256Schema })
export type StagedTerminalReceipt = typeof StagedTerminalReceiptSchema.Type
export const BaseStartSkipReasonSchema = Schema.Literals([
  'INSUFFICIENT_BARS',
  'NO_ELIGIBLE_BASE',
  'END_REFUSED',
  'NO_BASE',
  'CHART_FAILED',
  'SOURCE_INFEASIBLE',
])
const SkipMaterial = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.staged-skip-receipt.v1'),
  stage: Schema.Literal('BASE_START'),
  requestId: Sha256Schema,
  predecessorHash: Schema.NullOr(Sha256Schema),
  reason: BaseStartSkipReasonSchema,
  recordedAt: UtcInstantSchema,
})
export const StagedSkipReceiptSchema = Schema.Struct({ ...SkipMaterial.fields, skipHash: Sha256Schema })
export type StagedSkipReceipt = typeof StagedSkipReceiptSchema.Type
export const StagedCheckpointSchema = Schema.Struct({
  claims: Schema.Array(StagedDispatchClaimSchema).check(Schema.isMaxLength(2)),
  terminals: Schema.Array(StagedTerminalReceiptSchema).check(Schema.isMaxLength(2)),
  skips: Schema.Array(StagedSkipReceiptSchema).check(Schema.isMaxLength(1)),
})
export type StagedCheckpoint = typeof StagedCheckpointSchema.Type
export const BaseStartEvidenceSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal('NOT_REQUESTED'), skip: StagedSkipReceiptSchema }),
  Schema.Struct({ status: Schema.Literal('RECEIVED'), inference: DecisionsInferenceSchema }),
  Schema.Struct({ status: Schema.Literal('FAILED'), failure: VisualStageFailureSchema }),
])
export type BaseStartEvidence = typeof BaseStartEvidenceSchema.Type
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

export const makeStagedDispatchClaim = (input: typeof ClaimMaterial.Type) =>
  Result.gen(function* () {
    const value = yield* Schema.decodeUnknownResult(ClaimMaterial, strictParseOptions)(input)
    return { ...value, claimHash: yield* canonicalHashV1Result(value) }
  })
export const makeStagedTerminalReceipt = (input: typeof TerminalMaterial.Type) =>
  Result.gen(function* () {
    const value = yield* Schema.decodeUnknownResult(TerminalMaterial, strictParseOptions)(input)
    return { ...value, terminalHash: yield* canonicalHashV1Result(value) }
  })
export const makeStagedSkipReceipt = (input: typeof SkipMaterial.Type) =>
  Result.gen(function* () {
    const value = yield* Schema.decodeUnknownResult(SkipMaterial, strictParseOptions)(input)
    return { ...value, skipHash: yield* canonicalHashV1Result(value) }
  })
export const stageResponseIdentity = (inference: typeof DecisionsInferenceSchema.Type) => ({
  requestHash: inference.requestHash,
  responseHash: inference.responseHash,
  response: inference.response,
})

// Decode the whole journal, including every row, before deriving expense cuts.
// A missing claim or terminal is uncertainty, never evidence of non-dispatch.
export const decodeStagedCheckpoint = (requestInput: unknown, input: unknown) =>
  Result.gen(function* () {
    const request = yield* decodeJevEvaluationRequest(requestInput)
    const checkpoint = yield* Schema.decodeUnknownResult(StagedCheckpointSchema, strictParseOptions)(input)
    for (const rows of [checkpoint.claims, checkpoint.terminals, checkpoint.skips])
      if (new Set(rows.map((row) => row.stage)).size !== rows.length)
        return yield* invalid('Duplicate staged journal row')
    const chart = yield* makeNativeChartEvidence(request.request.chartSource)
    const chartSource = { chart, protocol: request.request.protocol, funding: request.request.funding }
    const initial = yield* makeInitialChartStageRequest(chartSource)
    const chartTerminal = checkpoint.terminals.find((row) => row.stage === 'CHART')
    // Claims and terminals must reproduce the same selected request within this decode.
    // Keep the derivation local: every new decode still validates the full source graph.
    let selectedBase: ReturnType<typeof makeSelectedBaseStartStageRequest> | undefined
    const selectedBaseRequest = () => {
      if (chartTerminal?.outcome.status !== 'RECEIVED')
        return invalid('Base start requires a received chart predecessor')
      return (selectedBase ??= makeSelectedBaseStartStageRequest(
        chartSource,
        stageResponseIdentity(chartTerminal.outcome.inference),
      ))
    }
    for (const claim of checkpoint.claims) {
      const { claimHash, ...material } = claim
      if (
        claim.requestId !== request.requestId ||
        claimHash !== (yield* canonicalHashV1Result(material)) ||
        claim.expiresAt !== request.expiresAt ||
        claim.claimedAt < request.observedAt ||
        claim.claimedAt >= request.expiresAt
      )
        return yield* invalid('Staged dispatch identity or original deadline differs')
      if (claim.stage === 'CHART') {
        if (
          claim.predecessorHash !== null ||
          claim.selectedEnd !== null ||
          claim.providerRequestHash !== initial.requestHash
        )
          return yield* invalid('Initial chart claim differs from its source')
      } else {
        if (
          chartTerminal?.outcome.status !== 'RECEIVED' ||
          claim.predecessorHash !== chartTerminal.terminalHash ||
          claim.claimedAt < chartTerminal.recordedAt
        )
          return yield* invalid('Base start claim has no preceding committed chart response')
        const next = yield* selectedBaseRequest()
        if (
          next.status !== 'PREPARED' ||
          claim.providerRequestHash !== next.requestHash ||
          claim.selectedEnd !== next.selectedEnd
        )
          return yield* invalid('Base start claim changes its selected end or provider request')
      }
    }
    for (const terminal of checkpoint.terminals) {
      const { terminalHash, ...material } = terminal
      const claim = checkpoint.claims.find((row) => row.stage === terminal.stage)
      if (
        claim === undefined ||
        terminal.requestId !== request.requestId ||
        terminal.claimHash !== claim.claimHash ||
        terminalHash !== (yield* canonicalHashV1Result(material)) ||
        terminal.recordedAt < claim.claimedAt
      )
        return yield* invalid('Stage terminal has no exact immutable dispatch claim')
      if (terminal.outcome.status === 'RECEIVED') {
        const inference = terminal.outcome.inference
        const prepared =
          terminal.stage === 'CHART'
            ? initial
            : chartTerminal?.outcome.status === 'RECEIVED'
              ? yield* selectedBaseRequest()
              : null
        if (
          prepared === null ||
          !('request' in prepared) ||
          inference.requestHash !== claim.providerRequestHash ||
          inference.responseHash !== (yield* canonicalHashV1Result(inference.response)) ||
          inference.startedAt < claim.claimedAt ||
          inference.startedAt >= request.expiresAt ||
          inference.completedAt < inference.startedAt ||
          inference.completedAt > terminal.recordedAt ||
          Result.isFailure(decodeDecisionsResponse(prepared.request, inference.response))
        )
          return yield* invalid('Stage terminal response does not reproduce its source-bound call')
      } else if (terminal.outcome.failure.usage !== null && !validDecisionsUsage(terminal.outcome.failure.usage))
        return yield* invalid('Stage failure metering is invalid')
    }
    for (const skip of checkpoint.skips) {
      const { skipHash, ...material } = skip
      if (
        skip.requestId !== request.requestId ||
        skipHash !== (yield* canonicalHashV1Result(material)) ||
        skip.recordedAt < request.observedAt ||
        checkpoint.claims.some((row) => row.stage === 'BASE_START')
      )
        return yield* invalid('Base start skip conflicts with dispatched evidence')
      if (skip.reason === 'SOURCE_INFEASIBLE') {
        if (
          skip.predecessorHash !== null ||
          checkpoint.claims.length !== 0 ||
          (yield* hasFeasibleEntrySource(request.request, chart))
        )
          return yield* invalid('Source infeasible skip does not reproduce')
      } else {
        if (
          chartTerminal === undefined ||
          skip.predecessorHash !== chartTerminal.terminalHash ||
          skip.recordedAt < chartTerminal.recordedAt
        )
          return yield* invalid('Base start skip lacks exact predecessor evidence')
        if (chartTerminal.outcome.status === 'FAILED') {
          if (skip.reason !== 'CHART_FAILED') return yield* invalid('Failed chart has a contradictory base start skip')
        } else {
          const next = yield* selectedBaseRequest()
          if (next.status !== 'NOT_REQUESTED' || next.reason !== skip.reason)
            return yield* invalid('Base start skip changes the source-selected eligibility')
        }
      }
    }
    return checkpoint
  })
