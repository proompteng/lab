import { describe, expect, test } from 'bun:test'

import { monthEndLiquidityReversal } from '../strategy'

describe('candidate 6 public strategy interface', () => {
  test('exports one cohesive namespace without legacy environment terminology', () => {
    expect(monthEndLiquidityReversal.CANDIDATE_6_ORDINAL).toBe(6)
    expect(monthEndLiquidityReversal.CANDIDATE_6_STRATEGY_NAME).toBe('month-end-liquidity-reversal')
    expect(monthEndLiquidityReversal.candidate6Protocol.candidateOrdinal).toBe(6)
    expect(monthEndLiquidityReversal.makeCandidate6Decision).toBeFunction()
    expect(monthEndLiquidityReversal.makeSealedCandidate6Preregistration).toBeFunction()
    expect(Object.keys(monthEndLiquidityReversal).some((key) => key.toLowerCase().includes('paper'))).toBe(false)
  })
})
