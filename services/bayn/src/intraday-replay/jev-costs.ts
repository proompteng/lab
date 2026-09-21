import { Schema } from 'effect'

import { PositiveMicrosSchema, UnsignedMicrosSchema } from '../schemas'
import type { ReplayJevCall } from './jev-timing'

export const ReplayJevCostModelSchema = Schema.Struct({
  inputMicrosPerMillionTokens: PositiveMicrosSchema,
  outputMicrosPerMillionTokens: UnsignedMicrosSchema,
})

export const calculateReplayJevCosts = (
  calls: readonly ReplayJevCall[],
  model: typeof ReplayJevCostModelSchema.Type,
) => {
  let knownCostMicros = 0n
  let unresolvedCallCount = 0
  let inputTokens = 0n
  let outputTokens = 0n
  for (const call of calls) {
    if (call.outcome.status !== 'RECEIVED') {
      unresolvedCallCount++
      continue
    }
    const usage = call.outcome.inference.response.usage
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
