import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { makeNativeEntryJudgmentRequest, shortQuestionNames } from './short-entry-questions'
import { decodeJevResponse } from './contract'
import { evaluateSupportedEntryProposals } from './entry-questions'
import { shortNativeEntryFixture } from './short-entry.test-support'
import { compileJevEntry } from './runtime'

import { makeNativeChartEvidence } from './chart-evidence'
import { defaultJevProtocolDocument, retainedJevProtocolV40Document, decodeJevProtocol } from './protocol'
import {
  makeShortEntryProposals,
  ShortEntryProposalSchema,
  ShortEntrySetup,
  mayHaveFundableShortSource,
} from './short-entry'
import { shortEntryProposalExitPlan } from './short-exit-plan'
import { decidePositionProtection, entryBracketProtection } from '../execution/position-protection'
import { OrderSide, OrderType, TimeInForce } from '../execution/contracts'
import { orderRequestBody } from '../broker/alpaca-mutations/decisions'
import { nativeJevFixture } from './native.test-support'
import { decodeJevPortfolio, JevPurpose } from './portfolio'
import { decideJevExit, JevExitReason, JevExitTargetSchema, jevProfitTargetLimitCeilings } from './exit'
import { jevPricingQuery } from './runtime'
import { IntradaySnapshotPurpose } from '../market-data/intraday/model'
import { persistIntradayRecordRows } from '../market-data/intraday/verification'
import { reconciledStateHash } from '../simulation-reconciliation/broker-model'
import { canonicalHashV1Result } from '../hash'
import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'

const fixture = () => {
  const chart = Result.getOrThrow(
    makeNativeChartEvidence({
      symbol: 'AAPL',
      windowEndAt: '2026-11-13T15:00:00.000Z',
      bars: [
        { minuteBeforeWindowEnd: 6, open: 99, high: 100, low: 97, close: 99.5, volume: 1200 },
        { minuteBeforeWindowEnd: 5, open: 101.5, high: 102, low: 101, close: 101.2, volume: 1000 },
        { minuteBeforeWindowEnd: 4, open: 101.2, high: 101.9, low: 101, close: 101.4, volume: 1100 },
        { minuteBeforeWindowEnd: 3, open: 101.4, high: 101.8, low: 101.1, close: 101.3, volume: 1000 },
        { minuteBeforeWindowEnd: 2, open: 101.3, high: 101.3, low: 100.4, close: 100.6, volume: 2200 },
        { minuteBeforeWindowEnd: 1, open: 100.6, high: 100.7, low: 100.3, close: 100.5, volume: 2000 },
      ],
    }),
  )
  const assessed = (barId: string) => ({ status: 'ASSESSED' as const, barId, probability: 0.9 })
  const presence = { status: 'ASSESSED' as const, probability: 0.9 }
  return {
    chart,
    protocol: defaultJevProtocolDocument,
    bidMicros: 100_500_000n,
    askMicros: 100_520_000n,
    capitalMicros: '100000000000',
    assessments: {
      schemaVersion: 'bayn.chart-assessments.v4' as const,
      symbol: chart.symbol,
      windowEndAt: chart.windowEndAt,
      barsHash: chart.barsHash,
      pngHash: chart.pngHash,
      support: { presence, anchor: assessed(chart.bars[0]!.id) },
      resistance: { presence, anchor: assessed(chart.bars[1]!.id) },
      base: { presence, first: assessed(chart.bars[1]!.id), last: assessed(chart.bars[3]!.id) },
    },
  }
}

describe('native JeV equity shorts', () => {
  test.each([JevExitReason.ProfitTarget, JevExitReason.ProtectiveStop, JevExitReason.MaximumHold])(
    'signed native management produces a bounded cover for %s',
    (reason) => {
      const opening = Result.getOrThrow(shortNativeEntryFixture('jev-native-test'))
      const entryAt = opening.observation.observedAt
      const at = new Date(Date.parse(entryAt) + (reason === JevExitReason.MaximumHold ? 15 : 1) * 60_000).toISOString()
      const managed = nativeJevFixture(JevPurpose.Manage, at)
      if (managed.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected managed portfolio')
      const plan = opening.decision.exitPolicy.plans['AAPL']
      if (plan?.schemaVersion !== 'bayn.jev-short-funded-exit-plan.v1') throw new Error('Expected native short plan')
      const price = BigInt(plan.levels.minimumEntryPriceMicros)
      const value = price * 5n
      const previous = managed.portfolio.brokerState
      const state = {
        ...previous,
        account: { ...previous.account, cashMicros: (BigInt(previous.account.equityMicros) + value).toString() },
        positions: previous.positions.map((position) => ({
          ...position,
          quantityAtoms: '-5000000000',
          averageEntryPriceMicros: price.toString(),
          costBasisMicros: (-value).toString(),
          marketPriceMicros: price.toString(),
          marketValueMicros: (-value).toString(),
          unrealizedPnlMicros: '0',
        })),
        orders: previous.orders.map((order) => ({ ...order, side: OrderSide.Sell })),
      }
      const hash = Result.getOrThrow(reconciledStateHash(state))
      const portfolio = Result.getOrThrow(
        decodeJevPortfolio({
          ...managed.portfolio,
          entryDecisionHash: Result.getOrThrow(canonicalHashV1Result(opening.decision)),
          exitPolicy: opening.decision.exitPolicy,
          entryFills: managed.portfolio.entryFills.map((fill) => ({
            ...fill,
            side: OrderSide.Sell,
            priceAtoms: (price * 1000n).toString(),
            occurredAt: entryAt,
          })),
          brokerState: {
            ...state,
            reconciliation: { ...previous.reconciliation, expectedHash: hash, observedHash: hash },
          },
        }),
      )
      const evidence = {
        cycleId: managed.draft.identity.cycleId,
        sessionDate: managed.snapshot.manifest.sessionDate,
        protocol: managed.protocol,
        portfolio,
        observedAt: at,
      }
      const query = Result.getOrThrow(
        jevPricingQuery(
          managed.draft,
          managed.protocol,
          managed.snapshot.manifest.calendar,
          at,
          ['AAPL'],
          IntradaySnapshotPurpose.Liquidation,
        ),
      )
      const raw = makeIntradayMomentumTestSnapshot(managed.protocol, { ...query, archiveWatermarks: [] })
      const ask =
        Number(
          reason === JevExitReason.ProfitTarget ? plan.levels.profitLimitPriceMicros : plan.levels.stopPriceMicros,
        ) / 1e6
      const snapshot = streamingFixtureFromRaw(
        { ...raw, quotes: raw.quotes.map((quote) => ({ ...quote, askPrice: ask, bidPrice: ask - 0.01 })) },
        query,
      ).snapshot
      const target = Result.getOrThrow(
        decideJevExit({
          ...evidence,
          trigger:
            reason === JevExitReason.MaximumHold
              ? { reason }
              : { reason, manifest: snapshot.manifest, rows: Result.getOrThrow(persistIntradayRecordRows(snapshot)) },
        }),
      )
      expect(target.targetWeights['AAPL']).toBe(0)
      expect(target.reason).toBe(reason)
      expect(Result.isSuccess(Schema.decodeUnknownResult(JevExitTargetSchema)(target))).toBe(true)
      const bounds = Result.getOrThrow(
        jevProfitTargetLimitCeilings(target, at, [
          { symbol: 'AAPL', referencePriceMicros: (BigInt(plan.levels.profitLimitPriceMicros) - 10000n).toString() },
        ]),
      )
      expect(bounds).toEqual(
        reason === JevExitReason.ProfitTarget ? { AAPL: BigInt(plan.levels.profitLimitPriceMicros) } : {},
      )
    },
  )
  test('native chart and bearish receipts produce a funded signed target with a finite whole-share sell bound', () => {
    const fixture = Result.getOrThrow(shortNativeEntryFixture())
    expect(fixture.decision.selectedSymbols).toEqual(['AAPL'])
    expect(fixture.decision.targetWeights['AAPL']).toBe(-0.2)
    expect(fixture.decision.exitPolicy.plans['AAPL']?.schemaVersion).toBe('bayn.jev-short-funded-exit-plan.v1')
    const compiled = Result.getOrThrow(compileJevEntry(fixture.decision, fixture.snapshot, fixture.snapshot))
    expect(compiled.maximumBuyQuantityAtoms['AAPL']).toBe('0')
    expect(BigInt(compiled.maximumSellQuantityAtoms['AAPL'] ?? '0')).toBeGreaterThan(0n)
    expect(BigInt(compiled.maximumSellQuantityAtoms['AAPL'] ?? '0') % 1_000_000_000n).toBe(0n)
  }, 15000)

  test('asks independent bearish judgments at actual prices and rejects intervening downside support', () => {
    const input = fixture()
    const proposals = Result.getOrThrow(makeShortEntryProposals(input))
    const prepared = Result.getOrThrow(
      makeNativeEntryJudgmentRequest({
        ...input,
        proposals,
        numericalState: { candidate: { symbol: 'AAPL' }, webullContext: null },
      }),
    )
    if (prepared === null) throw new Error('Expected native short questions')
    const state = JSON.parse(prepared.body).state
    expect(state.completedSourceBars).toEqual(input.chart.bars)
    expect(state.proposals.BASE_BREAKDOWN.calculatedFacts.consecutiveNewestClosesBelowStructure).toBe(2)
    expect(Object.keys(prepared.request.questions)).toHaveLength(6)
    const answers = Object.fromEntries(
      Object.keys(prepared.request.questions).map((name) => [
        name,
        { type: 'noul', noul: name.endsWith('_target_obstructed') ? 0.1 : 0.9 },
      ]),
    )
    const response = Result.getOrThrow(
      decodeJevResponse(prepared.request, {
        model: prepared.request.model,
        answers,
        usage: { input_tokens: 100, output_tokens: 25 },
      }),
    )
    expect(
      Result.getOrThrow(evaluateSupportedEntryProposals({ proposals, response })).supported[0]?.proposal.schemaVersion,
    ).toBe('bayn.equity-short-entry-proposal.v1')
    for (const proposal of proposals)
      answers[shortQuestionNames(proposal.source.setup).obstruction] = { type: 'noul', noul: 0.9 }
    const obstructed = Result.getOrThrow(
      decodeJevResponse(prepared.request, {
        model: prepared.request.model,
        answers,
        usage: { input_tokens: 100, output_tokens: 25 },
      }),
    )
    const rejected = Result.getOrThrow(evaluateSupportedEntryProposals({ proposals, response: obstructed }))
    expect(rejected.supported).toEqual([])
    expect(rejected.rejections.map((value) => value.reason)).toEqual(['OBJECTIVE_OBSTRUCTED', 'OBJECTIVE_OBSTRUCTED'])
  })

  test('uses resistance rejection and a completed downside base at the observed prices', () => {
    const input = fixture()
    const proposals = Result.getOrThrow(makeShortEntryProposals(input))
    expect(proposals.map((value) => value.source.setup)).toEqual([
      ShortEntrySetup.ResistanceRejection,
      ShortEntrySetup.BaseBreakdown,
    ])
    expect(input.chart.bars[0]?.low).toBe(97)
    for (const proposal of proposals) {
      expect(Schema.is(ShortEntryProposalSchema)(proposal)).toBe(true)
      expect(proposal.minimumEntryPriceMicros).toBe('100500000')
      expect(proposal.stopPriceMicros).toBe('102010000')
      expect(BigInt(proposal.stopLimitPriceMicros)).toBeGreaterThan(BigInt(proposal.stopPriceMicros))
      expect((BigInt(proposal.stopLimitPriceMicros) - BigInt(proposal.stopPriceMicros)) * 10_000n).toBeLessThanOrEqual(
        BigInt(proposal.stopPriceMicros) * BigInt(input.protocol.maximumEntryLimitSlippageBps),
      )
      expect(BigInt(proposal.profitLimitPriceMicros)).toBeLessThan(100_500_000n)
      expect(BigInt(proposal.funding.maximumQuantityAtoms)).toBe(199_000_000_000n)
      expect(proposal.funding.collateralMicros).toBe('29999250000')
      expect(BigInt(proposal.funding.estimatedStopPnlMicros)).toBeLessThan(0n)
      expect(BigInt(proposal.funding.estimatedTargetPnlMicros)).toBeGreaterThan(0n)
      expect(BigInt(proposal.funding.saleNetProceedsMicros)).toBeLessThan(19_999_500_000n)
    }
    expect(proposals[0]?.profitLimitPriceMicros).toBe('97010000')
    expect(proposals[1]?.profitLimitPriceMicros).toBe('100000000')
    expect(Result.getOrThrow(mayHaveFundableShortSource(input))).toBe(true)
  })

  test('requires the cover ask below the completed base, independently of the sell bid', () => {
    const input = fixture()
    const proposals = Result.getOrThrow(
      makeShortEntryProposals({ ...input, bidMicros: 100_990_000n, askMicros: 101_010_000n }),
    )
    expect(proposals.some((proposal) => proposal.source.setup === ShortEntrySetup.BaseBreakdown)).toBe(false)
  })

  test('an absent or refused source structure cannot create a bearish proposal', () => {
    const input = fixture()
    const assessments = {
      ...input.assessments,
      base: { ...input.assessments.base, presence: { status: 'REFUSED' as const } },
      resistance: { ...input.assessments.resistance, presence: { status: 'ASSESSED' as const, probability: 0.1 } },
    }
    expect(Result.getOrThrow(makeShortEntryProposals({ ...input, assessments }))).toEqual([])
    expect(
      Result.isFailure(
        makeShortEntryProposals({ ...input, assessments: { ...input.assessments, barsHash: 'a'.repeat(64) } }),
      ),
    ).toBe(true)
  })

  test('short protection cancels a partial entry before covering and never overcovers', () => {
    const input = fixture()
    const proposal = Result.getOrThrow(makeShortEntryProposals(input))[0]!
    const plan = shortEntryProposalExitPlan(proposal)
    const common = {
      plan,
      quantityAtoms: -2_000_000_000n,
      protection: { _tag: 'Absent' as const },
      exitDue: false,
      observedAt: '2026-11-13T15:00:05.000Z',
    }
    expect(decidePositionProtection({ ...common, entry: { _tag: 'Working', intentId: 'entry' } })).toEqual({
      _tag: 'CancelEntry',
      intentId: 'entry',
    })
    expect(decidePositionProtection({ ...common, entry: { _tag: 'Settled' } })).toEqual({
      _tag: 'Arm',
      method: 'OCO',
      quantityAtoms: 2_000_000_000n,
    })
    expect(decidePositionProtection({ ...common, entry: { _tag: 'Settled' }, exitDue: true })).toEqual({
      _tag: 'Liquidate',
      quantityAtoms: 2_000_000_000n,
    })
    expect(
      decidePositionProtection({ ...common, entry: { _tag: 'Settled' }, quantityAtoms: 1_000_000_000n })._tag,
    ).toBe('Block')
  })

  test('native broker request sells whole shares with an upper stop and lower profit cover', () => {
    const input = fixture()
    const proposal = Result.getOrThrow(makeShortEntryProposals(input))[0]!
    const plan = shortEntryProposalExitPlan(proposal)
    const protection = entryBracketProtection('AAPL', '2000000000', '2026-11-13T15:00:05.000Z', plan)
    expect(protection?._tag).toBe('EquityShortBracket')
    if (protection === undefined) throw new Error('Expected short bracket')
    const body = Result.getOrThrow(
      orderRequestBody({
        symbol: 'AAPL',
        side: OrderSide.Sell,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        quantityAtoms: '2000000000',
        limitPriceMicros: proposal.minimumEntryPriceMicros,
        notionalLimitMicros: '201000000',
        clientOrderId: 'short-test',
        protection,
      }),
    )
    expect(body).toMatchObject({
      side: 'sell',
      qty: '2',
      type: 'limit',
      time_in_force: 'day',
      order_class: 'bracket',
      extended_hours: false,
      take_profit: { limit_price: '97.01' },
      stop_loss: { stop_price: '102.01' },
    })
  })

  test('v40 remains exactly long-only and cannot be relabeled as the native short protocol', () => {
    expect(retainedJevProtocolV40Document.entryQuestionPolicyHash).toBe(
      'ca8886c5555bfac42cbb7391978309575ee9ff2321b2b9ced0ddd4ddf9abe442',
    )
    expect(Result.isSuccess(decodeJevProtocol(retainedJevProtocolV40Document))).toBe(true)
    expect(
      Result.isFailure(decodeJevProtocol({ ...retainedJevProtocolV40Document, positionPolicy: 'equity-long-short' })),
    ).toBe(true)
  })
})
