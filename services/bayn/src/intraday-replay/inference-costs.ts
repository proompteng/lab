import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevFailure, jevModel, JevResponseSchema } from '../jev/contract'
import { decisionsModel, validDecisionsUsage } from '../jev/decisions'
import { InferenceCostError, prepareInferenceRateCard } from '../inference-costs'
import { NonNegativeIntegerSchema, PositiveMicrosSchema, UnsignedMicrosSchema } from '../schemas'
import type { ReplayInferenceCall } from './inference-timing'

const rates = {
  inputMicrosPerMillionTokens: PositiveMicrosSchema,
  outputMicrosPerMillionTokens: UnsignedMicrosSchema,
}
export const ReplayInferenceCostModelSchema = Schema.Struct({
  jev: Schema.Struct(rates),
  chart: Schema.Struct({
    ...rates,
    cachedInputMicrosPerMillionTokens: UnsignedMicrosSchema,
    cacheWriteInputMicrosPerMillionTokens: UnsignedMicrosSchema,
  }),
})

/** A fixed replay tariff must cover the entire registered interval, including no-call periods. */
export const registeredReplayInferenceTariff = (
  rateCard: unknown,
  interval: { readonly startAt: string; readonly endAt: string },
) =>
  Result.gen(function* () {
    const { rates } = yield* prepareInferenceRateCard(rateCard)
    const covering = rates.filter(
      ({ rate }) => rate.effectiveFrom <= interval.startAt && interval.endAt < rate.effectiveUntil,
    )
    const jev = covering.find(({ rate }) => rate.provider === 'typesafe' && rate.model === jevModel)?.rate
    const chart = covering.find(({ rate }) => rate.provider === 'openai' && rate.model === decisionsModel)?.rate
    if (jev?.provider !== 'typesafe' || chart?.provider !== 'openai' || interval.startAt >= interval.endAt)
      return yield* Result.fail(
        new InferenceCostError({ message: 'Fixed replay tariff does not cover the registered interval' }),
      )
    return yield* Schema.decodeUnknownResult(ReplayInferenceCostModelSchema)({
      jev: {
        inputMicrosPerMillionTokens: jev.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens: jev.outputMicrosPerMillionTokens,
      },
      chart: {
        inputMicrosPerMillionTokens: chart.inputMicrosPerMillionTokens,
        outputMicrosPerMillionTokens: chart.outputMicrosPerMillionTokens,
        cachedInputMicrosPerMillionTokens: chart.cachedInputMicrosPerMillionTokens,
        cacheWriteInputMicrosPerMillionTokens: chart.cacheWriteInputMicrosPerMillionTokens,
      },
    })
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
  model: typeof ReplayInferenceCostModelSchema.Type,
) => {
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
    const tariff = model[call.stage === 'JEV' ? 'jev' : 'chart']
    const charge =
      (usage.input - usage.cached - usage.written) * BigInt(tariff.inputMicrosPerMillionTokens) +
      usage.output * BigInt(tariff.outputMicrosPerMillionTokens) +
      (call.stage !== 'JEV'
        ? usage.cached * BigInt(model.chart.cachedInputMicrosPerMillionTokens) +
          usage.written * BigInt(model.chart.cacheWriteInputMicrosPerMillionTokens)
        : 0n)
    knownCostMicros += (charge + 999_999n) / 1_000_000n
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
