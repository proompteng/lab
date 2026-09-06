import { Result } from 'effect'

import {
  constrainExecutionTargetAllocationCapitalMicros,
  executionMandateAllocationCapitalMicros,
} from '../execution/mandate'
import type { IntradayMomentumCoreOutput } from '../strategy/intraday-momentum/decision-core'
import type { IntradayReplayLedger } from './ledger'

const minBigInt = (left: bigint, right: bigint): bigint => (left < right ? left : right)

export const allocationForDecision = (
  ledger: Pick<IntradayReplayLedger, 'cashMicros'>,
  decision: Pick<IntradayMomentumCoreOutput, 'targetWeights'>,
  symbol: string,
  askPriceMicros: bigint,
  configuredAllocationCapitalMicros: string,
  policy: {
    readonly maxGrossExposureMicros: string
    readonly maxNetExposureMicros: string
    readonly maxDailyTradedNotionalMicros: string
    readonly maxAdverseSlippageBps: number
    readonly maxOrderNotionalMicros: string
    readonly maxSymbolExposureMicros: string
  },
) =>
  Result.flatMap(
    executionMandateAllocationCapitalMicros({
      accountEquityMicros: BigInt(ledger.cashMicros),
      dailyTradedNotionalMicros: 0n,
      maxGrossExposureMicros: BigInt(policy.maxGrossExposureMicros),
      maxNetExposureMicros: BigInt(policy.maxNetExposureMicros),
      maxDailyTradedNotionalMicros: BigInt(policy.maxDailyTradedNotionalMicros),
      maxAdverseSlippageBps: BigInt(policy.maxAdverseSlippageBps),
      positions: [],
      referencePriceMicros: { [symbol]: askPriceMicros.toString() },
    }),
    (mandateCapital) =>
      constrainExecutionTargetAllocationCapitalMicros({
        allocationCapitalMicros: minBigInt(
          mandateCapital,
          minBigInt(BigInt(configuredAllocationCapitalMicros), BigInt(ledger.cashMicros)),
        ),
        maxOrderNotionalMicros: BigInt(policy.maxOrderNotionalMicros),
        maxSymbolExposureMicros: BigInt(policy.maxSymbolExposureMicros),
        targetWeights: decision.targetWeights,
      }),
  )
