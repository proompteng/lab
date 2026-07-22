import { describe, expect, test } from 'bun:test'

import { readFileSync } from 'node:fs'

import { Effect, Exit } from 'effect'

import { defaultProtocolDocument, hashParameters, loadDefaultProtocol, loadProtocol } from './protocol'

const imageParameterHash = (): string => {
  const imageSource = readFileSync(new URL('../../../nix/images/bayn.nix', import.meta.url), 'utf8')
  const matches = [...imageSource.matchAll(/^\s*strategyParameterHash = "([a-f0-9]{64})";$/gm)]
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error('nix/images/bayn.nix must define exactly one strategyParameterHash')
  }
  return matches[0][1]
}

describe('strategy protocol', () => {
  test('decodes the committed protocol', async () => {
    const protocol = await Effect.runPromise(loadDefaultProtocol)

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
    expect(hashParameters(protocol)).toBe(imageParameterHash())
  })

  test('rejects legacy, malformed, and non-canonical documents', async () => {
    const invalidDocuments: readonly unknown[] = [
      { schemaVersion: 'bayn.tsmom.protocol.v2' },
      { ...defaultProtocolDocument, universe: [...defaultProtocolDocument.universe].reverse() },
      { ...defaultProtocolDocument, horizons: [] },
      { ...defaultProtocolDocument, horizons: [63, 21] },
      { ...defaultProtocolDocument, volatilityWindow: 1 },
      { ...defaultProtocolDocument, horizons: [1, 2], volatilityWindow: 2 },
      { ...defaultProtocolDocument, maximumSymbolWeight: 0 },
      { ...defaultProtocolDocument, maximumPortfolioVolatility: 1.1 },
      { ...defaultProtocolDocument, universeSymbolHash: '0'.repeat(64) },
      { ...defaultProtocolDocument, evaluationStart: defaultProtocolDocument.historyStart },
      { ...defaultProtocolDocument, futureField: true },
    ]

    for (const document of invalidDocuments) {
      const exit = await Effect.runPromiseExit(loadProtocol(document))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain('invalid risk-balanced trend parameters')
    }
  })

  test('requires every execution fact', async () => {
    const requiredPaths = [
      ['order', 'type'],
      ['order', 'timeInForce'],
      ['order', 'extendedHours'],
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
      ['cash', 'annualYieldBps'],
      ['partialFills', 'probabilityPpm'],
      ['partialFills', 'filledFractionPpm'],
    ] as const

    for (const path of requiredPaths) {
      const document = structuredClone(defaultProtocolDocument) as unknown as Record<string, unknown>
      let parent = document.executionModel as Record<string, unknown>
      for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>
      const key = path.at(-1)
      if (key === undefined) throw new Error('execution path cannot be empty')
      delete parent[key]
      expect(Exit.isFailure(await Effect.runPromiseExit(loadProtocol(document)))).toBe(true)
    }
  })
})
