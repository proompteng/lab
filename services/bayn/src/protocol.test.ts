import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import {
  defaultProtocolDocument,
  defaultRiskBalancedTrendProtocolDocument,
  hashRiskBalancedTrendParameters,
  hashTsmomParameters,
  loadDefaultProtocol,
  loadDefaultRiskBalancedTrendProtocol,
  loadRiskBalancedTrendProtocol,
  loadTsmomProtocol,
} from './protocol'

describe('TSMOM parameter contract', () => {
  test('runtime-decodes the committed immutable parameters', async () => {
    const protocol = await Effect.runPromise(loadDefaultProtocol)

    expect(protocol.schemaVersion).toBe('bayn.tsmom.protocol.v2')
    expect(protocol.universe).toEqual(['DBC', 'EEM', 'EFA', 'GLD', 'IEF', 'SPY', 'TLT', 'VNQ'])
    expect(hashTsmomParameters(protocol)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('fails with a typed reason for malformed or non-canonical parameters', async () => {
    const invalidDocuments: readonly unknown[] = [
      { ...defaultProtocolDocument, universe: [...defaultProtocolDocument.universe, 'SPY'] },
      { ...defaultProtocolDocument, universe: [...defaultProtocolDocument.universe].reverse() },
      { ...defaultProtocolDocument, lookbacks: [] },
      { ...defaultProtocolDocument, lookbacks: [63, 21] },
      {
        ...defaultProtocolDocument,
        thresholds: { ...defaultProtocolDocument.thresholds, minimumObservations: 0 },
      },
      {
        ...defaultProtocolDocument,
        executionModel: {
          ...defaultProtocolDocument.executionModel,
          precision: { ...defaultProtocolDocument.executionModel.precision, quantityIncrementMicros: '0' },
        },
      },
      {
        ...defaultProtocolDocument,
        executionModel: {
          ...defaultProtocolDocument.executionModel,
          partialFills: { ...defaultProtocolDocument.executionModel.partialFills, filledFractionPpm: 1_000_000 },
        },
      },
      {
        ...defaultProtocolDocument,
        executionModel: {
          ...defaultProtocolDocument.executionModel,
          fees: { ...defaultProtocolDocument.executionModel.fees, commissionBps: Number.NaN },
        },
      },
      { ...defaultProtocolDocument, futureField: true },
    ]

    for (const document of invalidDocuments) {
      const exit = await Effect.runPromiseExit(loadTsmomProtocol(document))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain('invalid TSMOM parameters')
      }
    }
  })

  test('requires every execution fact instead of inserting favorable defaults', async () => {
    const requiredPaths = [
      ['schemaVersion'],
      ['venue'],
      ['assetClass'],
      ['order', 'type'],
      ['order', 'timeInForce'],
      ['order', 'extendedHours'],
      ['order', 'submitAfter'],
      ['order', 'submitBefore'],
      ['order', 'priceReference'],
      ['precision', 'quantityIncrementMicros'],
      ['precision', 'priceIncrementMicros'],
      ['precision', 'minimumBuyNotionalMicros'],
      ['priceImpact', 'halfSpreadBps'],
      ['priceImpact', 'slippageBps'],
      ['fees', 'scheduleVersion'],
      ['fees', 'commissionBps'],
      ['fees', 'secSellBps'],
      ['fees', 'tafSellPerShareMicros'],
      ['fees', 'tafMaximumPerOrderMicros'],
      ['fees', 'catPerShareMicros'],
      ['fees', 'aggregation'],
      ['fees', 'roundingIncrementMicros'],
      ['cash', 'annualYieldBps'],
      ['cash', 'dayCount'],
      ['cash', 'accrual'],
      ['partialFills', 'policy'],
      ['partialFills', 'probabilityPpm'],
      ['partialFills', 'filledFractionPpm'],
      ['partialFills', 'remainder'],
      ['doubleCostMultiplier'],
    ] as const

    for (const path of requiredPaths) {
      const document = structuredClone(defaultProtocolDocument) as unknown as Record<string, unknown>
      let parent = document.executionModel as Record<string, unknown>
      for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>
      delete parent[path.at(-1)!]
      const exit = await Effect.runPromiseExit(loadTsmomProtocol(document))
      expect(Exit.isFailure(exit)).toBe(true)
    }
  })
})

describe('risk-balanced trend parameter contract', () => {
  test('decodes the fixed candidate protocol without requiring full-investment cap capacity', async () => {
    const protocol = await Effect.runPromise(loadDefaultRiskBalancedTrendProtocol)
    const cashRetainingProtocol = await Effect.runPromise(
      loadRiskBalancedTrendProtocol({ ...defaultRiskBalancedTrendProtocolDocument, maximumSymbolWeight: 0.1 }),
    )

    expect(protocol).toMatchObject({
      schemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
      universeId: 'equity-infrastructure-v1',
      universeSymbolHash: 'ddcc8adc04dc29822969cddf02b821ea8110856162cca20a7ff28c1c43263e18',
      universe: ['AMD', 'AVGO', 'COHR', 'CRDO', 'LITE', 'MRVL', 'MU', 'NVDA', 'WDC'],
      historyStart: '2022-01-27',
      evaluationStart: '2023-01-30',
      horizons: [21, 63, 126, 252],
      volatilityWindow: 63,
      maximumSymbolWeight: 0.35,
      maximumPortfolioVolatility: 0.1,
    })
    expect(cashRetainingProtocol.maximumSymbolWeight).toBe(0.1)
    expect(hashRiskBalancedTrendParameters(protocol)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('rejects malformed or non-canonical candidate parameters', async () => {
    const invalidDocuments: readonly unknown[] = [
      { ...defaultRiskBalancedTrendProtocolDocument, universe: [...defaultProtocolDocument.universe].reverse() },
      { ...defaultRiskBalancedTrendProtocolDocument, horizons: [] },
      { ...defaultRiskBalancedTrendProtocolDocument, horizons: [63, 21] },
      { ...defaultRiskBalancedTrendProtocolDocument, volatilityWindow: 0 },
      { ...defaultRiskBalancedTrendProtocolDocument, volatilityWindow: 1 },
      { ...defaultRiskBalancedTrendProtocolDocument, horizons: [1, 2], volatilityWindow: 2 },
      { ...defaultRiskBalancedTrendProtocolDocument, maximumSymbolWeight: 0 },
      { ...defaultRiskBalancedTrendProtocolDocument, maximumPortfolioVolatility: 1.1 },
      { ...defaultRiskBalancedTrendProtocolDocument, universeSymbolHash: '0'.repeat(64) },
      { ...defaultRiskBalancedTrendProtocolDocument, evaluationStart: '2022-01-27' },
      { ...defaultRiskBalancedTrendProtocolDocument, futureField: true },
    ]

    for (const document of invalidDocuments) {
      const exit = await Effect.runPromiseExit(loadRiskBalancedTrendProtocol(document))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.toString()).toContain('invalid risk-balanced trend parameters')
      }
    }
  })
})
