import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevFailure, JevResponseSchema } from '../jev/contract'
import { validDecisionsUsage } from '../jev/decisions'
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
export const ReplayInferenceCostSummarySchema = Schema.Struct({
  callCount: NonNegativeIntegerSchema,
  chartCallCount: NonNegativeIntegerSchema,
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
  if (call.stage === 'CHART') {
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
    const tariff = model[call.stage === 'CHART' ? 'chart' : 'jev']
    const charge =
      (usage.input - usage.cached - usage.written) * BigInt(tariff.inputMicrosPerMillionTokens) +
      usage.output * BigInt(tariff.outputMicrosPerMillionTokens) +
      (call.stage === 'CHART'
        ? usage.cached * BigInt(model.chart.cachedInputMicrosPerMillionTokens) +
          usage.written * BigInt(model.chart.cacheWriteInputMicrosPerMillionTokens)
        : 0n)
    knownCostMicros += (charge + 999_999n) / 1_000_000n
  }
  return {
    callCount: calls.length,
    chartCallCount: calls.filter((call) => call.stage === 'CHART').length,
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
