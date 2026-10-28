import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevFailure, jevModel, JevResponseSchema } from '../jev/contract'
import { decisionsModel, validDecisionsUsage } from '../jev/decisions'
import {
  InferenceCostError,
  type InferenceRateCardSchema,
  inferenceRatesCoverWindow,
  prepareInferenceRateCard,
  priceInferenceUsage,
} from '../inference-costs'
import { JevResearchPolicy } from '../jev/acceptance'
import { NonNegativeIntegerSchema, UnsignedMicrosSchema } from '../schemas'
import type { ReplayInferenceCall } from './inference-timing'

/** Retain the registered provider schedule, including adjacent periods and no-call intervals. */
export const registeredReplayInferenceTariff = (
  rateCard: unknown,
  interval: { readonly startAt: string; readonly endAt: string },
  policy: JevResearchPolicy,
) =>
  Result.gen(function* () {
    const { rates } = yield* prepareInferenceRateCard(rateCard)
    const requiredModels =
      policy === JevResearchPolicy.Candidate
        ? [
            { provider: 'typesafe', model: jevModel },
            { provider: 'openai', model: decisionsModel },
          ]
        : policy === JevResearchPolicy.Ablation
          ? [{ provider: 'openai', model: decisionsModel }]
          : []
    if (
      interval.startAt >= interval.endAt ||
      requiredModels.some(
        (model) =>
          !inferenceRatesCoverWindow(
            rates.map(({ rate }) => rate),
            { ...model, ...interval },
          ),
      )
    )
      return yield* Result.fail(
        new InferenceCostError({ message: 'Replay tariff does not cover the registered interval' }),
      )
    return {
      schemaVersion: 'bayn.inference-rate-card.v1' as const,
      rates: rates
        .filter(({ rate }) =>
          requiredModels.some(({ provider, model }) => rate.provider === provider && rate.model === model),
        )
        .toSorted((a, b) => a.rateHash.localeCompare(b.rateHash))
        .map(({ rate }) => rate),
    }
  })
export const ReplayInferenceCostSummarySchema = Schema.Struct({
  callCount: NonNegativeIntegerSchema,
  chartCallCount: NonNegativeIntegerSchema,
  baseStartCallCount: Schema.optionalKey(NonNegativeIntegerSchema),
  jevCallCount: NonNegativeIntegerSchema,
  unresolvedCallCount: NonNegativeIntegerSchema,
  inputTokens: UnsignedMicrosSchema,
  cachedInputTokens: UnsignedMicrosSchema,
  cacheWriteInputTokens: UnsignedMicrosSchema,
  outputTokens: UnsignedMicrosSchema,
  knownCostMicros: UnsignedMicrosSchema,
  rounding: Schema.Literal('ceil-each-call-to-one-micro'),
  basis: Schema.Literal('declared-tariff-pending-invoice-verification'),
})
const UsageReceiptSchema = Schema.Struct({
  model: JevResponseSchema.fields.model,
  usage: JevResponseSchema.fields.usage,
})

const verifiedUsage = (call: ReplayInferenceCall) => {
  if (call.stage !== 'JEV') {
    const outcome = call.outcome
    const usage =
      outcome.status === 'RECEIVED'
        ? outcome.inference.response.usage
        : outcome.status === 'FAILED' && outcome.responseHash !== null
          ? outcome.usage
          : null
    if (usage === null || !validDecisionsUsage(usage)) return undefined
    return {
      input: BigInt(usage.input_tokens),
      cached: BigInt(usage.input_tokens_details.cached_tokens),
      written: BigInt(usage.input_tokens_details.cache_write_tokens),
      output: BigInt(usage.output_tokens),
    }
  }
  const outcome = call.outcome
  let usage
  if (outcome.status === 'RECEIVED') usage = outcome.inference.response.usage
  else {
    if (
      outcome.status !== 'FAILED' ||
      (outcome.failure !== JevFailure.Response &&
        outcome.failure !== JevFailure.Timeout &&
        outcome.failure !== JevFailure.Status) ||
      outcome.responseHash === null
    )
      return undefined
    const hash = canonicalHashV1Result(outcome.rejectedResponse)
    if (Result.isFailure(hash) || hash.success !== outcome.responseHash) return undefined
    const receipt = Schema.decodeUnknownResult(UsageReceiptSchema)(outcome.rejectedResponse)
    if (Result.isFailure(receipt) || receipt.success.model !== call.request.model) return undefined
    usage = receipt.success.usage
  }
  return { input: BigInt(usage.input_tokens), cached: 0n, written: 0n, output: BigInt(usage.output_tokens) }
}

export const calculateReplayInferenceCosts = (
  calls: readonly ReplayInferenceCall[],
  model: typeof InferenceRateCardSchema.Type,
) => {
  const prepared = prepareInferenceRateCard(model)
  let knownCostMicros = 0n
  let unresolvedCallCount = 0
  let inputTokens = 0n
  let cachedInputTokens = 0n
  let cacheWriteInputTokens = 0n
  let outputTokens = 0n
  for (const call of calls) {
    const usage = verifiedUsage(call)
    if (usage === undefined) {
      unresolvedCallCount++
      continue
    }
    inputTokens += usage.input
    cachedInputTokens += usage.cached
    cacheWriteInputTokens += usage.written
    outputTokens += usage.output
    const tariff = Result.isSuccess(prepared)
      ? prepared.success.rates.find(
          ({ rate }) =>
            rate.provider === (call.stage === 'JEV' ? 'typesafe' : 'openai') &&
            rate.model === call.request.model &&
            rate.effectiveFrom <= call.simulatedStartedAt &&
            call.simulatedStartedAt < rate.effectiveUntil,
        )?.rate
      : undefined
    if (tariff === undefined) {
      unresolvedCallCount++
      continue
    }
    const charge = priceInferenceUsage(
      {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cachedInputTokens: usage.cached,
        cacheWriteInputTokens: usage.written,
      },
      tariff,
    )
    if (Result.isFailure(charge)) {
      unresolvedCallCount++
      continue
    }
    knownCostMicros += (charge.success + 999_999n) / 1_000_000n
  }
  return {
    callCount: calls.length,
    chartCallCount: calls.filter((call) => call.stage === 'CHART').length,
    ...(calls.some((call) => call.stage === 'BASE_START')
      ? { baseStartCallCount: calls.filter((call) => call.stage === 'BASE_START').length }
      : {}),
    jevCallCount: calls.filter((call) => call.stage === 'JEV').length,
    unresolvedCallCount,
    inputTokens: inputTokens.toString(),
    cachedInputTokens: cachedInputTokens.toString(),
    cacheWriteInputTokens: cacheWriteInputTokens.toString(),
    outputTokens: outputTokens.toString(),
    knownCostMicros: knownCostMicros.toString(),
    rounding: 'ceil-each-call-to-one-micro' as const,
    basis: 'declared-tariff-pending-invoice-verification' as const,
  }
}
