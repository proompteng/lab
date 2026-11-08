import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { strictParseOptions, SymbolSchema } from '../schemas'
import {
  JevBatchPlanSchema,
  JevBatchPlanVersion,
  JevCandidateExclusionSchema,
  JevCandidatePlanStatus,
  JevEntryExclusion,
  jevBatchQuestionSetHash,
  JevBatchResultSchema,
  JevCandidateResultStatus,
} from './batch'
import { JevContractError, JevFailure } from './contract'
import {
  AblationEntryInferenceInputSchema,
  CandidateEntryInferenceInputSchema,
  EntryAblationSelection,
  verifyEntryInferenceSource,
} from './entry-inference-input'
import {
  JevEvaluationRequestSchema,
  JevEvaluationReceiptSchema,
  JevOutcome,
  entryInferenceAvailableAt,
} from './evidence'
import { decodeStagedEntryHandoff, verifyEntryCompletion } from './entry-inference-evidence'
import { makeEntryJudgmentRequest } from './entry-questions'
import { makeFinancialChartStageReplay } from './retained-jev-staged-chart-questions'
import { decodeJevResolution, JevResolutionStatus } from './resolution'
import { reproduceRetainedJevCandidateObservation } from './observation'
import { RetainedVisualJevProtocolSchema } from './protocol'
import { jevEntryQuoteExclusion, jevTradingSignalRequestMaterial } from './trading-signals'

// These readers reconstruct immutable v38 evidence. They are not fresh-entry admission paths.
const RetainedInputSchema = Schema.Union([
  Schema.Struct({ ...CandidateEntryInferenceInputSchema.fields, protocol: RetainedVisualJevProtocolSchema }),
  Schema.Struct({ ...AblationEntryInferenceInputSchema.fields, protocol: RetainedVisualJevProtocolSchema }),
])
const RetainedRequestSchema = Schema.Struct({
  ...JevEvaluationRequestSchema.fields,
  request: RetainedInputSchema,
})
export const RetainedJevBatchPlanSchema = Schema.Struct({
  ...JevBatchPlanSchema.fields,
  candidates: Schema.Array(
    Schema.Union([
      Schema.Struct({
        status: Schema.Literal(JevCandidatePlanStatus.Requested),
        symbol: SymbolSchema,
        request: RetainedRequestSchema,
      }),
      JevCandidateExclusionSchema,
    ]),
  ),
})
type RetainedBatch = typeof RetainedJevBatchPlanSchema.Type
type RetainedObservation = Result.Result.Success<ReturnType<typeof reproduceRetainedJevCandidateObservation>>
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

const requestFromObservation = (
  observation: RetainedObservation,
  symbol: string,
  selectionPolicy: EntryAblationSelection | null,
) =>
  Result.gen(function* () {
    const material = yield* jevTradingSignalRequestMaterial(observation.snapshot, symbol, observation, selectionPolicy)
    const decoded = yield* Schema.decodeUnknownResult(RetainedInputSchema, strictParseOptions)(material)
    const prepared = yield* verifyEntryInferenceSource(decoded)
    const input = yield* Schema.decodeUnknownResult(RetainedInputSchema, strictParseOptions)(JSON.parse(prepared.body))
    return { input, ...prepared }
  })

export const reproduceRetainedJevRequestFromObservation = (inputRequest: unknown, inputObservation: unknown) =>
  Result.gen(function* () {
    const request = yield* Schema.decodeUnknownResult(RetainedRequestSchema, strictParseOptions)(inputRequest)
    const observation = yield* reproduceRetainedJevCandidateObservation(inputObservation)
    const { requestId, ...material } = request
    if (
      requestId !== (yield* canonicalHashV1Result(material)) ||
      request.cycleId !== observation.cycleId ||
      request.authorityGenerationHash !== observation.authorityGenerationHash ||
      request.snapshotId !== observation.snapshot.manifest.snapshotId ||
      request.observedAt !== observation.observedAt ||
      !observation.protocol.candidateSymbols.includes(request.symbol) ||
      request.symbol !== request.request.chartSource.symbol ||
      Date.parse(request.expiresAt) !== Date.parse(observation.observedAt) + observation.protocol.inferenceValidityMs
    )
      return yield* invalid('Retained v38 request does not belong to its original observation and validity interval')
    const prepared = yield* requestFromObservation(
      observation,
      request.symbol,
      request.request.schemaVersion === 'bayn.entry-ablation-input.v1' ? request.request.selectionPolicy : null,
    )
    const stored = yield* verifyEntryInferenceSource(request.request)
    if (prepared.requestHash !== request.requestHash || stored.body !== prepared.body)
      return yield* invalid('Retained v38 request payload differs from its reproduced source')
    return prepared
  })

export const reconstructRetainedJevTradingSignalBatch = (input: {
  readonly observation: unknown
  readonly expiresAt: string
  readonly planVersion: JevBatchPlanVersion
}) =>
  Result.gen(function* () {
    const observation = yield* reproduceRetainedJevCandidateObservation(input.observation)
    const { snapshot, protocol } = observation
    const manifest = snapshot.manifest
    if (Date.parse(input.expiresAt) !== Date.parse(observation.observedAt) + protocol.inferenceValidityMs)
      return yield* invalid('Retained v38 batch deadline differs from its original validity interval')
    if (manifest.candidateSymbols === undefined || manifest.candidateSymbols.length === 0)
      return yield* invalid('Retained v38 batch requires the complete recorded candidate universe')
    const candidates: RetainedBatch['candidates'][number][] = []
    for (const symbol of manifest.candidateSymbols) {
      const excluded = manifest.candidateExclusions?.find((candidate) => candidate.symbol === symbol)
      if (excluded !== undefined) {
        candidates.push(
          yield* Schema.decodeUnknownResult(
            JevCandidateExclusionSchema,
            strictParseOptions,
          )({
            ...excluded,
            status: JevCandidatePlanStatus.Excluded,
          }),
        )
        continue
      }
      const prepared = yield* requestFromObservation(
        observation,
        symbol,
        input.planVersion === JevBatchPlanVersion.Ablation ? EntryAblationSelection.LowestModeledLoss : null,
      )
      const quote = snapshot.latestQuotes[symbol]
      if (quote !== undefined) {
        const entryExclusion = yield* jevEntryQuoteExclusion(quote)
        if (entryExclusion !== null) {
          candidates.push({
            symbol,
            status: JevCandidatePlanStatus.Excluded,
            reason: entryExclusion,
            message:
              entryExclusion === JevEntryExclusion.Spread
                ? 'Verified entry quote exceeds the maximum spread'
                : 'Verified entry quote has no two-sided displayed size',
          })
          continue
        }
      }
      const requestMaterial = {
        schemaVersion: 'bayn.jev-evaluation-request.v3',
        cycleId: observation.cycleId,
        authorityGenerationHash: observation.authorityGenerationHash,
        snapshotId: manifest.snapshotId,
        symbol,
        observedAt: manifest.observedAt,
        expiresAt: input.expiresAt,
        requestHash: prepared.requestHash,
        request: prepared.input,
      }
      const request = yield* Schema.decodeUnknownResult(
        RetainedRequestSchema,
        strictParseOptions,
      )({
        ...requestMaterial,
        requestId: yield* canonicalHashV1Result(requestMaterial),
      })
      candidates.push({ symbol, status: JevCandidatePlanStatus.Requested, request })
    }
    const material = {
      schemaVersion: input.planVersion,
      cycleId: observation.cycleId,
      authorityGenerationHash: observation.authorityGenerationHash,
      observationHash: observation.contentHash,
      protocolHash: yield* canonicalHashV1Result(protocol),
      snapshotId: manifest.snapshotId,
      observedAt: manifest.observedAt,
      expiresAt: input.expiresAt,
      questionSetHash: yield* jevBatchQuestionSetHash(candidates),
      candidates,
    }
    return yield* Schema.decodeUnknownResult(
      RetainedJevBatchPlanSchema,
      strictParseOptions,
    )({
      ...material,
      batchId: yield* canonicalHashV1Result(material),
    })
  })

export const reproduceRetainedJevTradingSignalBatchEvidence = (inputObservation: unknown, inputPlan: unknown) =>
  Result.gen(function* () {
    const plan = yield* Schema.decodeUnknownResult(RetainedJevBatchPlanSchema, strictParseOptions)(inputPlan)
    const { batchId, ...material } = plan
    if (batchId !== (yield* canonicalHashV1Result(material)))
      return yield* invalid('Retained v38 batch identity differs from its stored material')
    const reconstructed = yield* reconstructRetainedJevTradingSignalBatch({
      observation: inputObservation,
      expiresAt: plan.expiresAt,
      planVersion: plan.schemaVersion,
    })
    if (reconstructed.batchId !== batchId)
      return yield* invalid('Retained v38 batch requests or candidate universe differ from their reproduced source')
    return reconstructed
  })

/** Receipt reconstruction is read-only; the current receipt decoder still requires a v39 source. */
const decodeRetainedReceipt = (request: typeof RetainedRequestSchema.Type, input: unknown) =>
  Result.gen(function* () {
    const receipt = yield* Schema.decodeUnknownResult(JevEvaluationReceiptSchema, strictParseOptions)(input)
    const { receiptHash, ...material } = receipt
    if (
      receiptHash !== (yield* canonicalHashV1Result(material)) ||
      receipt.requestId !== request.requestId ||
      receipt.startedAt < request.observedAt ||
      receipt.completedAt < receipt.startedAt
    )
      return yield* invalid('Retained v38 receipt identity or original clocks do not reproduce')
    const prepared = yield* verifyEntryInferenceSource(request.request)
    if (prepared.requestHash !== request.requestHash)
      return yield* invalid('Retained v38 receipt source differs from its sealed input')
    const source = {
      requestId: request.requestId,
      input: request.request,
      observedAt: request.observedAt,
      expiresAt: request.expiresAt,
    }
    if (receipt.outcome.status === JevOutcome.Completed) {
      const { handoff: rawHandoff, ...completion } = receipt.outcome.completion
      const handoff = yield* decodeStagedEntryHandoff(
        source,
        rawHandoff,
        request.requestHash,
        makeEntryJudgmentRequest,
        makeFinancialChartStageReplay(),
      )
      yield* verifyEntryCompletion(source, completion, handoff)
      if (
        completion.completedAt > receipt.completedAt ||
        handoff.recordedAt < receipt.startedAt ||
        (handoff.disposition.status !== 'VISUAL_FAILED' &&
          handoff.disposition.status !== 'SOURCE_INFEASIBLE' &&
          handoff.disposition.visual.startedAt < receipt.startedAt)
      )
        return yield* invalid('Retained v38 receipt precedes its provider evidence')
    } else if (
      receipt.outcome.failure === JevFailure.NotDispatched &&
      (receipt.startedAt >= request.expiresAt || receipt.completedAt < request.expiresAt)
    )
      return yield* invalid('Retained v38 non-dispatch does not prove original expiry')
    return receipt
  })

export const decodeRetainedJevBatchResult = (plan: RetainedBatch, input: unknown) =>
  Result.gen(function* () {
    const result = yield* Schema.decodeUnknownResult(JevBatchResultSchema, strictParseOptions)(input)
    const { resultHash, ...material } = result
    if (
      resultHash !== (yield* canonicalHashV1Result(material)) ||
      result.batchId !== plan.batchId ||
      result.completedAt < plan.observedAt ||
      result.candidates.length !== plan.candidates.length
    )
      return yield* invalid('Retained v38 result must reproduce and cover its entire original plan')
    for (const [index, candidate] of result.candidates.entries()) {
      const planned = plan.candidates[index]
      if (planned === undefined || planned.symbol !== candidate.symbol)
        return yield* invalid('Retained v38 result omits, repeats or reorders a planned candidate')
      if (planned.status === JevCandidatePlanStatus.Excluded) {
        if (candidate.status !== JevCandidateResultStatus.Excluded)
          return yield* invalid('An excluded retained v38 candidate cannot acquire an inference')
        continue
      }
      if (candidate.status === JevCandidateResultStatus.Excluded || candidate.requestId !== planned.request.requestId)
        return yield* invalid('Retained v38 result does not bind its planned request')
      if (candidate.status === JevCandidateResultStatus.Unattempted) {
        if (result.completedAt < plan.expiresAt)
          return yield* invalid('An unattempted retained v38 request cannot finalize before its original deadline')
        continue
      }
      const receipt =
        candidate.receipt === null ? null : yield* decodeRetainedReceipt(planned.request, candidate.receipt)
      const resolution = yield* decodeJevResolution(planned.request, receipt, candidate.resolution)
      if (
        (receipt !== null && receipt.completedAt > result.completedAt) ||
        (resolution.status === JevResolutionStatus.Abandoned && resolution.abandonedAt > result.completedAt)
      )
        return yield* invalid('Retained v38 result precedes a candidate receipt or abandonment')
    }
    return result
  })

/** Reproduce historical selection evidence without admitting any retained request to execution. */
export const retainedJevV38BatchInferencesAt = (
  plan: RetainedBatch,
  input: unknown,
  now: number,
  expectedVersion: JevBatchPlanVersion,
) =>
  Result.gen(function* () {
    if (plan.schemaVersion !== expectedVersion)
      return yield* invalid('Retained v38 batch belongs to another selection policy')
    const result = yield* decodeRetainedJevBatchResult(plan, input)
    if (!Number.isSafeInteger(now) || now < Date.parse(result.completedAt) || now >= Date.parse(plan.expiresAt))
      return yield* invalid('Retained v38 decision is outside the complete original batch validity interval')
    const inferences = []
    for (const [index, candidate] of result.candidates.entries()) {
      const planned = plan.candidates[index]
      if (candidate.status === JevCandidateResultStatus.Excluded) continue
      if (
        planned?.status !== JevCandidatePlanStatus.Requested ||
        candidate.status !== JevCandidateResultStatus.Resolved ||
        candidate.resolution.status !== JevResolutionStatus.Recorded ||
        candidate.receipt === null
      )
        return yield* invalid('Every retained v38 requested candidate must have a recorded result before selection')
      const inference = yield* entryInferenceAvailableAt(
        planned.request,
        candidate.receipt,
        now,
        expectedVersion === JevBatchPlanVersion.Ablation
          ? 'bayn.entry-ablation-input.v1'
          : 'bayn.entry-inference-input.v8',
      )
      inferences.push({ symbol: candidate.symbol, requestId: candidate.requestId, inference })
    }
    if (
      inferences.length === 0 &&
      !plan.candidates.every(
        (candidate) =>
          candidate.status === JevCandidatePlanStatus.Excluded &&
          (candidate.reason === JevEntryExclusion.Spread || candidate.reason === JevEntryExclusion.DisplayedSize),
      )
    )
      return yield* invalid('No retained v38 candidate has usable inference evidence')
    return inferences
  })
