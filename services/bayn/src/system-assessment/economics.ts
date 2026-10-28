import { Data, Result, Schema } from 'effect'

import { SignedMicrosSchema, UnsignedMicrosSchema } from '../schemas'

export class SystemAssessmentError extends Data.TaggedError('SystemAssessmentError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const CashInventoryBridgeSchema = Schema.Struct({
  openingEquityMicros: SignedMicrosSchema,
  closingEquityMicros: SignedMicrosSchema,
  netExternalFlowsMicros: SignedMicrosSchema,
  passiveCashYieldMicros: SignedMicrosSchema,
  operatingCostsPaidFromAccountMicros: UnsignedMicrosSchema,
})

export const cashInventoryTradingPnl = (bridge: typeof CashInventoryBridgeSchema.Type): string =>
  (
    BigInt(bridge.closingEquityMicros) -
    BigInt(bridge.openingEquityMicros) -
    BigInt(bridge.netExternalFlowsMicros) -
    BigInt(bridge.passiveCashYieldMicros) +
    BigInt(bridge.operatingCostsPaidFromAccountMicros)
  ).toString()

export const netTradingPnl = (financial: {
  readonly grossRealizedPnlMicros: string
  readonly openingUnrealizedPnlMicros: string
  readonly closingUnrealizedPnlMicros: string
  readonly executionCostMicros: string
  readonly cashSettlementRoundingMicros: string
}): bigint =>
  BigInt(financial.grossRealizedPnlMicros) +
  BigInt(financial.closingUnrealizedPnlMicros) -
  BigInt(financial.openingUnrealizedPnlMicros) -
  BigInt(financial.executionCostMicros) +
  BigInt(financial.cashSettlementRoundingMicros)

export const advanceQualificationEquity = (opening: bigint | null, sessionProfit: bigint | null): bigint | null =>
  opening === null || sessionProfit === null ? null : opening + sessionProfit

export const binaryTradeEdge = (input: {
  readonly gainMicros: bigint
  readonly lossMicros: bigint
  readonly costMicros: bigint
  readonly winProbabilityNumerator: bigint
  readonly winProbabilityDenominator: bigint
}) => {
  if (
    input.gainMicros < 0n ||
    input.lossMicros < 0n ||
    input.costMicros < 0n ||
    input.gainMicros + input.lossMicros === 0n ||
    input.winProbabilityDenominator <= 0n ||
    input.winProbabilityNumerator < 0n ||
    input.winProbabilityNumerator > input.winProbabilityDenominator
  )
    return Result.fail(new SystemAssessmentError({ message: 'Binary edge inputs are outside their domain' }))
  const numerator =
    input.winProbabilityNumerator * input.gainMicros -
    (input.winProbabilityDenominator - input.winProbabilityNumerator) * input.lossMicros -
    input.winProbabilityDenominator * input.costMicros
  return Result.succeed({
    expectedNetMicros: {
      numerator: numerator.toString(),
      denominator: input.winProbabilityDenominator.toString(),
    },
    breakEvenWinProbability: {
      numerator: (input.lossMicros + input.costMicros).toString(),
      denominator: (input.gainMicros + input.lossMicros).toString(),
    },
    positive: numerator > 0n,
  })
}

export const markedRisk = (marks: readonly bigint[]) => {
  let peak: bigint | undefined
  let drawdown = 0n
  for (const mark of marks) {
    if (peak === undefined || mark > peak) peak = mark
    const loss = peak - mark
    if (loss > drawdown) drawdown = loss
  }
  const opening = marks[0]
  let sessionLoss = 0n
  if (opening !== undefined)
    for (const mark of marks) {
      const loss = opening - mark
      if (loss > sessionLoss) sessionLoss = loss
    }
  return { maximumDrawdownMicros: drawdown.toString(), maximumSessionLossMicros: sessionLoss.toString() }
}
