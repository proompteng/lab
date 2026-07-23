import { describe, expect, test } from 'bun:test'

import { Effect, Exit } from 'effect'

import { riskBalancedTrendBehaviorHash } from './behavior'
import { verifyBehaviorHash, verifyParameterHash, type EmbeddedBuildMetadata } from './build'
import { defaultProtocolDocument, hashParameters, loadDefaultProtocol, loadProtocol } from './protocol'

describe('strategy protocol', () => {
  test('decodes the committed protocol', async () => {
    const protocol = await Effect.runPromise(loadDefaultProtocol)

    expect(protocol).toMatchObject({
      schemaVersion: 'bayn.risk-balanced-trend.protocol.v3',
      universeId: 'cross-asset-taa-v1',
      universeSymbolHash: 'c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8',
      universe: ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'],
      historyStart: '2016-01-04',
      evaluationStart: '2017-01-03',
      horizons: [21, 63, 126, 252],
      volatilityWindow: 63,
      maximumSymbolWeight: 0.35,
      maximumPortfolioVolatility: 0.1,
      executionModel: {
        schemaVersion: 'bayn.execution-model.v2',
        order: {
          planningPriceReference: 'signal-session-close',
          planningBrokerStateReference: 'reconciled-pre-plan-broker-state',
          fillPriceReference: 'next-session-open',
          buyingPowerPolicy: 'pre-submit-cash-without-sell-proceeds',
          submissionCutoffLeadMinutes: 15,
        },
      },
    })
    expect(hashParameters(protocol)).toMatch(/^[a-f0-9]{64}$/)
  })

  test('rejects build metadata for different compiled parameters', async () => {
    const protocol = await Effect.runPromise(loadDefaultProtocol)
    const parameterHash = hashParameters(protocol)
    const metadata: EmbeddedBuildMetadata = {
      sourceRevision: 'a'.repeat(40),
      imageRepository: 'registry.example.test/lab/bayn',
      strategyBehaviorHash: riskBalancedTrendBehaviorHash,
      strategyParameterHash: parameterHash,
    }

    await Effect.runPromise(verifyParameterHash(metadata, parameterHash))
    await Effect.runPromise(verifyBehaviorHash(metadata, riskBalancedTrendBehaviorHash))
    const exit = await Effect.runPromiseExit(
      verifyParameterHash({ ...metadata, strategyParameterHash: '0'.repeat(64) }, parameterHash),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain('compiled strategy parameters')
    const behaviorExit = await Effect.runPromiseExit(
      verifyBehaviorHash({ ...metadata, strategyBehaviorHash: '0'.repeat(64) }, riskBalancedTrendBehaviorHash),
    )
    expect(Exit.isFailure(behaviorExit)).toBe(true)
    if (Exit.isFailure(behaviorExit)) expect(behaviorExit.cause.toString()).toContain('compiled strategy behavior')
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
      { ...defaultProtocolDocument, universeId: 'equity-infrastructure-v1' },
      { ...defaultProtocolDocument, evaluationStart: defaultProtocolDocument.historyStart },
      { ...defaultProtocolDocument, futureField: true },
    ]

    for (const document of invalidDocuments) {
      const exit = await Effect.runPromiseExit(loadProtocol(document))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(exit.cause.toString()).toContain('invalid risk-balanced trend parameters')
    }
  })

  test('decodes the frozen v2 protocol only for immutable historical evidence', async () => {
    const historical = {
      ...defaultProtocolDocument,
      schemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
      executionModel: {
        ...defaultProtocolDocument.executionModel,
        schemaVersion: 'bayn.execution-model.v1',
        order: {
          type: 'market',
          timeInForce: 'day',
          extendedHours: false,
          submitAfter: 'signal-session-close',
          submitBefore: 'next-session-open',
          priceReference: 'next-session-open',
        },
      },
    } as const

    const protocol = await Effect.runPromise(loadProtocol(historical))

    expect(protocol.schemaVersion).toBe('bayn.risk-balanced-trend.protocol.v2')
    expect(protocol.executionModel.schemaVersion).toBe('bayn.execution-model.v1')
  })

  test('requires every execution fact', async () => {
    const requiredPaths = [
      ['order', 'type'],
      ['order', 'timeInForce'],
      ['order', 'extendedHours'],
      ['order', 'planningPriceReference'],
      ['order', 'planningBrokerStateReference'],
      ['order', 'fillPriceReference'],
      ['order', 'buyingPowerPolicy'],
      ['order', 'submissionCutoffLeadMinutes'],
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
      const document: Record<string, unknown> = structuredClone(defaultProtocolDocument)
      let parent = document.executionModel as Record<string, unknown>
      for (const segment of path.slice(0, -1)) parent = parent[segment] as Record<string, unknown>
      const key = path.at(-1)
      if (key === undefined) throw new Error('execution path cannot be empty')
      delete parent[key]
      expect(Exit.isFailure(await Effect.runPromiseExit(loadProtocol(document)))).toBe(true)
    }
  })
})
