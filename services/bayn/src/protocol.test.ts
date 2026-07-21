import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import { defaultProtocolDocument, hashTsmomParameters, loadDefaultProtocol, loadTsmomProtocol } from './protocol'

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
