import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { makeNativeEntryJudgmentRequest, shortQuestionNames } from './short-entry-questions'
import { decodeJevResponse } from './contract'
import { evaluateSupportedEntryProposals } from './entry-questions'
import { shortNativeEntryFixture } from './short-entry.test-support'
import { compileJevEntry } from './runtime'

import { makeNativeChartEvidence } from './chart-evidence'
import {
  defaultJevProtocolDocument,
  retainedJevProtocolV40Document,
  retainedJevProtocolV41Document,
  retainedJevProtocolV42Document,
  retainedJevProtocolV43Document,
  decodeJevProtocol,
  type JevProtocolMaterial,
} from './protocol'
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

const fixture = (protocol: JevProtocolMaterial = defaultJevProtocolDocument) => {
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
    protocol,
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
    const input = fixture(retainedJevProtocolV41Document)
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
      Result.getOrThrow(evaluateSupportedEntryProposals({ proposals, response, protocol: input.protocol })).supported[0]
        ?.proposal.schemaVersion,
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
    const rejected = Result.getOrThrow(
      evaluateSupportedEntryProposals({ proposals, response: obstructed, protocol: input.protocol }),
    )
    expect(rejected.supported).toEqual([])
    expect(rejected.rejections.map((value) => value.reason)).toEqual(['OBJECTIVE_OBSTRUCTED', 'OBJECTIVE_OBSTRUCTED'])
  })

  test('uses resistance rejection and a completed downside base at the observed prices', () => {
    const input = fixture(retainedJevProtocolV41Document)
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
        notionalLimitMicros: (2n * BigInt(proposal.minimumEntryPriceMicros)).toString(),
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

  test('v42 applies 5 bps drift/slippage allowances and enforces G/L >= 1.0 on equity shorts', () => {
    const input = fixture(retainedJevProtocolV42Document)
    const proposals = Result.getOrThrow(makeShortEntryProposals(input))
    expect(proposals.map((proposal) => proposal.source.setup)).toEqual([ShortEntrySetup.ResistanceRejection])
    expect(proposals[0]?.minimumEntryPriceMicros).toBe('100390000')
    expect(proposals[0]?.stopPriceMicros).toBe('102010000')
    expect(proposals[0]?.stopLimitPriceMicros).toBe('102060000')
    expect(BigInt(proposals[0]?.funding.estimatedTargetPnlMicros ?? '0')).toBeGreaterThanOrEqual(
      -BigInt(proposals[0]?.funding.estimatedStopPnlMicros ?? '0'),
    )
    expect(Result.getOrThrow(mayHaveFundableShortSource(input))).toBe(true)

    const lowRewardChart = Result.getOrThrow(
      makeNativeChartEvidence({
        symbol: 'AAPL',
        windowEndAt: '2026-11-13T15:00:00.000Z',
        bars: input.chart.bars.map((bar, index) => ({
          minuteBeforeWindowEnd: bar.minuteBeforeWindowEnd,
          open: index === 0 ? 100.26 : bar.open,
          high: index === 0 ? 100.3 : bar.high,
          low: index === 0 ? 100.25 : bar.low,
          close: index === 0 ? 100.28 : bar.close,
          volume: bar.volume,
        })),
      }),
    )
    const chartSource = { ...input, chart: lowRewardChart }
    const lowRewardAssessments = {
      ...input.assessments,
      barsHash: lowRewardChart.barsHash,
      pngHash: lowRewardChart.pngHash,
      support: {
        ...input.assessments.support,
        anchor: { status: 'ASSESSED' as const, barId: lowRewardChart.bars[0]!.id, probability: 0.9 },
      },
      resistance: {
        ...input.assessments.resistance,
        anchor: { status: 'ASSESSED' as const, barId: lowRewardChart.bars[1]!.id, probability: 0.9 },
      },
      base: {
        ...input.assessments.base,
        first: { status: 'ASSESSED' as const, barId: lowRewardChart.bars[1]!.id, probability: 0.9 },
        last: { status: 'ASSESSED' as const, barId: lowRewardChart.bars[3]!.id, probability: 0.9 },
      },
    }
    expect(Result.getOrThrow(makeShortEntryProposals({ ...chartSource, assessments: lowRewardAssessments }))).toEqual(
      [],
    )
    expect(Result.getOrThrow(mayHaveFundableShortSource(chartSource))).toBe(false)
  })

  test('v42 symmetric short judgment policy removes asymmetric bias and provides full breakdown chronology facts', () => {
    const v41Input = fixture(retainedJevProtocolV41Document)
    const proposals = Result.getOrThrow(makeShortEntryProposals(v41Input))
    const prepared = Result.getOrThrow(
      makeNativeEntryJudgmentRequest({
        ...v41Input,
        proposals,
        symmetric: true,
        numericalState: { candidate: { symbol: 'AAPL' }, webullContext: null },
      }),
    )
    if (prepared === null) throw new Error('Expected symmetric short judgment request')
    const state = JSON.parse(prepared.body).state
    expect(state.schemaVersion).toBe('bayn.jev-long-short-proposal-evidence.v2')
    expect(JSON.stringify(prepared.request.questions)).not.toContain('Never invert bullish probabilities')
    expect(state.proposals.BASE_BREAKDOWN).toMatchObject({
      terms: { setup: 'BASE_BREAKDOWN', targetBasis: 'PROJECTED_MEASURED_BASE_RANGE' },
      calculatedFacts: {
        stopIsAboveStructureHigh: true,
        entryIsBelowStructureLow: true,
        completedBarsAfterStructure: 2,
        consecutiveNewestClosesBelowStructure: 2,
      },
    })
    expect(state.proposals.BASE_BREAKDOWN.calculatedFacts.completedClosesAfterStructure).toHaveLength(2)
  })

  test('mayHaveFundableShortSource checks selectable resistance stops when a higher bar fails G/L >= 1.0', () => {
    const input = fixture()
    const chart = Result.getOrThrow(
      makeNativeChartEvidence({
        symbol: 'AAPL',
        windowEndAt: '2026-11-13T15:00:00.000Z',
        bars: input.chart.bars.map((bar, index) => ({
          minuteBeforeWindowEnd: bar.minuteBeforeWindowEnd,
          open: 100,
          high: index === 0 ? 101 : index === 1 ? 100.2 : 100.1,
          low: 99,
          close: 100,
          volume: bar.volume,
        })),
      }),
    )
    const source = {
      chart,
      protocol: input.protocol,
      bidMicros: 100_000_000n,
      askMicros: 100_010_000n,
      capitalMicros: input.capitalMicros,
    }
    expect(Result.getOrThrow(mayHaveFundableShortSource(source))).toBe(true)
    const proposals = Result.getOrThrow(
      makeShortEntryProposals({
        ...source,
        assessments: {
          ...input.assessments,
          barsHash: chart.barsHash,
          pngHash: chart.pngHash,
          support: {
            ...input.assessments.support,
            anchor: { status: 'ASSESSED', barId: chart.bars[0]!.id, probability: 0.9 },
          },
          resistance: {
            ...input.assessments.resistance,
            anchor: { status: 'ASSESSED', barId: chart.bars[1]!.id, probability: 0.9 },
          },
          base: { ...input.assessments.base, presence: { status: 'ASSESSED', probability: 0.1 } },
        },
      }),
    )
    expect(proposals.map((proposal) => proposal.source.setup)).toEqual([ShortEntrySetup.ResistanceRejection])
  })

  test('v44 retains the 15 bps short stop floor while accepting positive targets rejected by v43', () => {
    const base = fixture()
    const subRatioChart = Result.getOrThrow(
      makeNativeChartEvidence({
        symbol: 'AAPL',
        windowEndAt: '2026-11-13T15:00:00.000Z',
        bars: [
          { minuteBeforeWindowEnd: 5, open: 101, high: 102, low: 100.5, close: 101, volume: 100 },
          { minuteBeforeWindowEnd: 4, open: 101, high: 102, low: 100.5, close: 101, volume: 100 },
          { minuteBeforeWindowEnd: 3, open: 100.8, high: 102, low: 98.55, close: 100.4, volume: 100 },
          { minuteBeforeWindowEnd: 2, open: 100.2, high: 102, low: 99.6, close: 99.8, volume: 100 },
          { minuteBeforeWindowEnd: 1, open: 99.8, high: 100.1, low: 99.7, close: 100.0, volume: 100 },
        ],
      }),
    )
    const subRatioAssessments = {
      ...base.assessments,
      barsHash: subRatioChart.barsHash,
      pngHash: subRatioChart.pngHash,
      support: {
        ...base.assessments.support,
        anchor: { status: 'ASSESSED' as const, barId: subRatioChart.bars[2]!.id, probability: 0.9 },
      },
      resistance: {
        ...base.assessments.resistance,
        anchor: { status: 'ASSESSED' as const, barId: subRatioChart.bars[0]!.id, probability: 0.9 },
      },
      base: { ...base.assessments.base, presence: { status: 'ASSESSED' as const, probability: 0.1 } },
    }
    const subRatioSource = { ...base, chart: subRatioChart, assessments: subRatioAssessments }
    const v42Proposals = Result.getOrThrow(
      makeShortEntryProposals({ ...subRatioSource, protocol: retainedJevProtocolV42Document }),
    )
    expect(v42Proposals.map((proposal) => proposal.source.setup)).toEqual([ShortEntrySetup.ResistanceRejection])
    expect(
      Result.getOrThrow(mayHaveFundableShortSource({ ...subRatioSource, protocol: retainedJevProtocolV42Document })),
    ).toBe(true)
    const v43Source = { ...subRatioSource, protocol: retainedJevProtocolV43Document }
    expect(Result.getOrThrow(makeShortEntryProposals(v43Source))).toEqual([])
    expect(Result.getOrThrow(mayHaveFundableShortSource(v43Source))).toBe(false)
    expect(Result.getOrThrow(makeShortEntryProposals(subRatioSource)).map((proposal) => proposal.source.setup)).toEqual(
      [ShortEntrySetup.ResistanceRejection],
    )
    expect(Result.getOrThrow(mayHaveFundableShortSource(subRatioSource))).toBe(true)

    const makeStopFloorSource = (resistanceHigh: number) => {
      const stopChart = Result.getOrThrow(
        makeNativeChartEvidence({
          symbol: 'AAPL',
          windowEndAt: '2026-11-13T15:00:00.000Z',
          bars: [
            { minuteBeforeWindowEnd: 5, open: 100.1, high: resistanceHigh, low: 99.9, close: 100, volume: 100 },
            { minuteBeforeWindowEnd: 4, open: 100.05, high: resistanceHigh, low: 95.0, close: 100, volume: 100 },
            { minuteBeforeWindowEnd: 3, open: 100.05, high: resistanceHigh, low: 98.0, close: 100, volume: 100 },
            { minuteBeforeWindowEnd: 2, open: 100.05, high: resistanceHigh, low: 99.5, close: 100, volume: 100 },
            { minuteBeforeWindowEnd: 1, open: 100.0, high: 100.05, low: 99.95, close: 100, volume: 100 },
          ],
        }),
      )
      return {
        chart: stopChart,
        protocol: defaultJevProtocolDocument,
        bidMicros: 100_000_000n,
        askMicros: 100_000_000n,
        capitalMicros: base.capitalMicros,
        assessments: {
          ...base.assessments,
          barsHash: stopChart.barsHash,
          pngHash: stopChart.pngHash,
          support: {
            ...base.assessments.support,
            anchor: { status: 'ASSESSED' as const, barId: stopChart.bars[1]!.id, probability: 0.9 },
          },
          resistance: {
            ...base.assessments.resistance,
            anchor: { status: 'ASSESSED' as const, barId: stopChart.bars[0]!.id, probability: 0.9 },
          },
          base: { ...base.assessments.base, presence: { status: 'ASSESSED' as const, probability: 0.1 } },
        },
      }
    }

    // ask = 100.00: high = 100.13 -> stop = 100.14 (14 bps < 15 bps) must be rejected; high = 100.14 -> stop = 100.15 (15 bps) admitted
    const tightSource = makeStopFloorSource(100.13)
    expect(Result.getOrThrow(makeShortEntryProposals(tightSource))).toEqual([])
    expect(Result.getOrThrow(mayHaveFundableShortSource(tightSource))).toBe(false)

    const validSource = makeStopFloorSource(100.14)
    expect(Result.getOrThrow(mayHaveFundableShortSource(validSource))).toBe(true)
    const validProposals = Result.getOrThrow(makeShortEntryProposals(validSource))
    expect(validProposals.map((proposal) => proposal.source.setup)).toEqual([ShortEntrySetup.ResistanceRejection])
    expect(validProposals[0]?.stopPriceMicros).toBe('100150000')
  })
})
