import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { candidate6Protocol, type Candidate6Decision, type Candidate6OrderIntent } from './model'
import { candidate6MovingBlockBootstrapSample, executeCandidate6OrderIntent } from './simulation'

const trimIntent: Candidate6OrderIntent = {
  symbol: 'SPY',
  side: 'sell',
  fromWeight: 0.5,
  toWeight: 0.35,
  weightDelta: -0.15,
  maximumNotionalUsd: 150_000,
  reason: 'exposure-cap-trim',
}

const trimDecision: Candidate6Decision = {
  schemaVersion: 'bayn.month-end-liquidity-reversal.decision.v1',
  candidateOrdinal: 6,
  strategyName: 'month-end-liquidity-reversal',
  signalDate: '2022-01-25',
  executionDate: '2022-01-26',
  action: 'hold',
  reason: 'exposure-cap-trim',
  targetWeights: { SPY: 0.35 },
  feature: null,
  orderIntents: [trimIntent],
  constraints: {
    grossExposure: 0.35,
    oneWayTurnover: 0.15,
    maximumGrossExposure: 0.35,
    maximumOneWayTurnover: 1,
    maximumSymbolWeight: 0.35,
  },
}

describe('candidate 6 research simulation primitives', () => {
  test('executes the close-time bounded intent without next-open resizing', () => {
    const fill = executeCandidate6OrderIntent({
      cashUsd: 500_000,
      shares: 5_000,
      openPrice: 200,
      decision: trimDecision,
      orderIntent: trimIntent,
      protocol: candidate6Protocol,
      costMultiplier: 0,
      includePartialFills: false,
    })

    assert(Result.isSuccess(fill))
    expect(fill.success).toEqual({
      cashUsd: 650_000,
      shares: 4_250,
      turnoverFraction: 0.1,
      modeledCostUsd: 0,
      partial: false,
    })
  })

  test('samples moving blocks without wrapping across the series boundary', () => {
    expect(candidate6MovingBlockBootstrapSample([1, 2, 3, 4, 5], 3, () => 0.999_999)).toEqual([3, 4, 5, 3, 4])
  })
})
