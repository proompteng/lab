import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevFailure, JevResponseSchema, type JevResponse } from '../jev/contract'
import { PositiveMicrosSchema, UnsignedMicrosSchema } from '../schemas'
import type { ReplayJevCall } from './jev-timing'

export const ReplayJevCostModelSchema = Schema.Struct({
  inputMicrosPerMillionTokens: PositiveMicrosSchema,
  outputMicrosPerMillionTokens: UnsignedMicrosSchema,
})

const UsageReceiptSchema = Schema.Struct({
  model: JevResponseSchema.fields.model,
  usage: JevResponseSchema.fields.usage,
})

const verifiedUsage = (call: ReplayJevCall): JevResponse['usage'] | undefined => {
  const outcome = call.outcome
  if (outcome.status === 'RECEIVED') return outcome.inference.response.usage
  if (
    outcome.status !== 'FAILED' ||
    (outcome.failure !== JevFailure.Response && outcome.failure !== JevFailure.Timeout) ||
    outcome.responseHash === null
  )
    return undefined
  const hash = canonicalHashV1Result(outcome.rejectedResponse)
  if (Result.isFailure(hash) || hash.success !== outcome.responseHash) return undefined
  const receipt = Schema.decodeUnknownResult(UsageReceiptSchema)(outcome.rejectedResponse)
  return Result.isSuccess(receipt) && receipt.success.model === call.request.model ? receipt.success.usage : undefined
}

export const calculateReplayJevCosts = (
  calls: readonly ReplayJevCall[],
  model: typeof ReplayJevCostModelSchema.Type,
) => {
  let knownCostMicros = 0n
  let unresolvedCallCount = 0
  let inputTokens = 0n
  let outputTokens = 0n
  for (const call of calls) {
    const usage = verifiedUsage(call)
    if (usage === undefined) {
      unresolvedCallCount++
      continue
    }
    inputTokens += BigInt(usage.input_tokens)
    outputTokens += BigInt(usage.output_tokens)
    const charge =
      BigInt(usage.input_tokens) * BigInt(model.inputMicrosPerMillionTokens) +
      BigInt(usage.output_tokens) * BigInt(model.outputMicrosPerMillionTokens)
    knownCostMicros += (charge + 999_999n) / 1_000_000n
  }
  return {
    callCount: calls.length,
    unresolvedCallCount,
    inputTokens: inputTokens.toString(),
    outputTokens: outputTokens.toString(),
    knownCostMicros: knownCostMicros.toString(),
    rounding: 'ceil-each-call-to-one-micro' as const,
    basis: 'declared-tariff-pending-invoice-verification' as const,
  }
}
