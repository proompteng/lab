import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeNativeChartEvidence, type NativeChartEvidence } from './chart-evidence'
import { makeInitialChartStageRequest } from './staged-chart-questions'
import { jevEntryEconomics } from './entry-economics'
import { makeEntryProposals, makeEntrySourceCandidates } from './entry-proposals'
import { defaultJevProtocolDocument } from './protocol'

const source = {
  symbol: 'AAPL',
  windowEndAt: '2026-10-26T19:00:00.000Z',
  bars: [
    { minuteBeforeWindowEnd: 8, open: 101, high: 104, low: 100, close: 103, volume: 100 },
    { minuteBeforeWindowEnd: 7, open: 103, high: 106, low: 101, close: 104, volume: 100 },
    { minuteBeforeWindowEnd: 6, open: 104, high: 104, low: 102, close: 103, volume: 100 },
    { minuteBeforeWindowEnd: 5, open: 104.2, high: 104.5, low: 104, close: 104.4, volume: 100 },
    { minuteBeforeWindowEnd: 4, open: 104.4, high: 104.6, low: 104.2, close: 104.3, volume: 100 },
    { minuteBeforeWindowEnd: 3, open: 104.3, high: 105, low: 104.3, close: 104.9, volume: 100 },
    { minuteBeforeWindowEnd: 2, open: 104.9, high: 105.3, low: 104.8, close: 105.2, volume: 100 },
    { minuteBeforeWindowEnd: 1, open: 105.2, high: 105.4, low: 105, close: 105.3, volume: 100 },
  ],
}
const context = (chart: NativeChartEvidence, bidMicros = 105_500_000n, askMicros = 105_550_000n) => {
  const funding = {
    bidMicros: bidMicros.toString(),
    askMicros: askMicros.toString(),
    capitalMicros: '100000000000',
    cryptoFeeTier: null,
  }
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      protocol: defaultJevProtocolDocument,
      symbol: chart.symbol,
      bidMicros,
      askMicros,
      capitalMicros: funding.capitalMicros,
      cryptoFeeTier: funding.cryptoFeeTier,
    }),
  )
  if (economics === null) throw new Error('Expected funded fixture quantity')
  return { chart, economics, protocol: defaultJevProtocolDocument, bidMicros, funding }
}
const assessments = (chart: NativeChartEvidence) => ({
  schemaVersion: 'bayn.chart-assessments.v4' as const,
  symbol: chart.symbol,
  windowEndAt: chart.windowEndAt,
  barsHash: chart.barsHash,
  pngHash: chart.pngHash,
  support: { presence: { status: 'ASSESSED' as const, probability: 1 }, anchor: { status: 'NOT_IDENTIFIED' as const } },
  resistance: {
    presence: { status: 'ASSESSED' as const, probability: 1 },
    anchor: { status: 'NOT_IDENTIFIED' as const },
  },
  base: {
    presence: { status: 'ASSESSED' as const, probability: 1 },
    first: { status: 'NOT_IDENTIFIED' as const },
    last: { status: 'NOT_IDENTIFIED' as const },
  },
})

test('excludes resistance behind the current bounded entry even when it is above the last candle close', () => {
  const chart = Result.getOrThrow(makeNativeChartEvidence(source))
  const input = context(chart)
  const candidates = Result.getOrThrow(makeEntrySourceCandidates(input))
  const recent = chart.bars.at(-1)
  if (recent === undefined) throw new Error('Missing fixture candle')
  expect(recent.high).toBeGreaterThan(recent.close)
  expect(BigInt(Math.round(recent.high * 1_000_000))).toBeLessThan(input.bidMicros)
  expect(candidates.resistanceBarIds).not.toContain(recent.id)
  expect(candidates.resistanceBarIds).toEqual([chart.bars[1]?.id])
  expect(candidates.supportBarIds.length).toBeGreaterThan(0)
})

test('chart anchor questions expose only executable sources and allow no matching structure', () => {
  const chart = Result.getOrThrow(makeNativeChartEvidence(source))
  const input = context(chart)
  const candidates = Result.getOrThrow(makeEntrySourceCandidates(input))
  const prepared = Result.getOrThrow(makeInitialChartStageRequest(input))
  const resistance = prepared.request.questions.find((question) => question.name === 'resistance_anchor')
  if (resistance?.type !== 'choice') throw new Error('Missing resistance question')
  expect(resistance.choices.map((choice) => choice.value)).toEqual([...candidates.resistanceBarIds, 'no_resistance'])
  expect(prepared.request.input[0].content[2].data).toMatchObject({
    executionReference: {
      bidUsd: 105.5,
      askUsd: 105.55,
      maximumEntryPriceUsd: input.economics.maximumEntryPriceUsd,
      bidMicros: input.bidMicros.toString(),
      maximumEntryPriceMicros: input.economics.maximumEntryPriceMicros,
    },
  })
})

test('keeps observed resistance available when it obstructs a funded breakout but cannot itself cover crypto fees', () => {
  const chart = Result.getOrThrow(makeNativeChartEvidence({ ...source, symbol: 'ETH/USD' }))
  const input = context(chart)
  const candidates = Result.getOrThrow(makeEntrySourceCandidates(input))
  expect(candidates.baseWindows.length).toBeGreaterThan(0)
  expect(candidates.resistanceBarIds).toEqual([])

  const prepared = Result.getOrThrow(makeInitialChartStageRequest(input))
  expect(prepared.sourceFeasible).toBe(true)
  const resistance = prepared.request.questions.find((question) => question.name === 'resistance_anchor')
  if (resistance?.type !== 'choice') throw new Error('Observed overhead resistance was hidden by the funding filter')
  expect(resistance.choices.map((choice) => choice.value)).toEqual([chart.bars[1]?.id, 'no_resistance'])
})

test('candidate filtering retains every fundable support pair and excludes every unfundable pair', () => {
  const chart = Result.getOrThrow(makeNativeChartEvidence(source))
  const input = context(chart)
  const candidates = Result.getOrThrow(makeEntrySourceCandidates(input))
  const evidence = assessments(chart)
  for (const support of chart.bars)
    for (const resistance of chart.bars) {
      const result = Result.getOrThrow(
        makeEntryProposals({
          ...input,
          assessments: {
            ...evidence,
            support: { ...evidence.support, anchor: { status: 'ASSESSED', barId: support.id, probability: 1 } },
            resistance: {
              ...evidence.resistance,
              anchor: { status: 'ASSESSED', barId: resistance.id, probability: 1 },
            },
          },
        }),
      )
      expect(candidates.supportBarIds.includes(support.id) && candidates.resistanceBarIds.includes(resistance.id)).toBe(
        result.proposals.length === 1,
      )
    }
})

test('an unrepresentable unselected high cannot remove a usable support low', () => {
  const chart = Result.getOrThrow(
    makeNativeChartEvidence({
      ...source,
      bars: source.bars.map((bar, index) => (index === 0 ? { ...bar, high: 1e15 } : bar)),
    }),
  )
  const input = context(chart)
  const support = chart.bars[0]
  const resistance = chart.bars[1]
  if (support === undefined || resistance === undefined) throw new Error('Missing source anchors')
  const evidence = assessments(chart)
  const complete = Result.getOrThrow(
    makeEntryProposals({
      ...input,
      assessments: {
        ...evidence,
        support: { ...evidence.support, anchor: { status: 'ASSESSED', barId: support.id, probability: 1 } },
        resistance: { ...evidence.resistance, anchor: { status: 'ASSESSED', barId: resistance.id, probability: 1 } },
      },
    }),
  )
  expect(complete.proposals).toHaveLength(1)
  const candidates = Result.getOrThrow(makeEntrySourceCandidates(input))
  expect(candidates.supportBarIds).toContain(support.id)
  expect(candidates.resistanceBarIds).toContain(resistance.id)
  expect(candidates.resistanceBarIds).not.toContain(support.id)
})

test('base candidates match complete-plan construction for every source interval', () => {
  const chart = Result.getOrThrow(makeNativeChartEvidence(source))
  const input = context(chart)
  const candidates = Result.getOrThrow(makeEntrySourceCandidates(input))
  const evidence = assessments(chart)
  for (const first of chart.bars)
    for (const last of chart.bars) {
      const result = Result.getOrThrow(
        makeEntryProposals({
          ...input,
          assessments: {
            ...evidence,
            base: {
              presence: evidence.base.presence,
              first: { status: 'ASSESSED', barId: first.id, probability: 1 },
              last: { status: 'ASSESSED', barId: last.id, probability: 1 },
            },
          },
        }),
      )
      expect(candidates.baseWindows.some((span) => span.firstBarId === first.id && span.lastBarId === last.id)).toBe(
        result.proposals.length === 1,
      )
    }
})

test('a quiet crypto window remains infeasible after fees', () => {
  const chart = Result.getOrThrow(
    makeNativeChartEvidence({
      ...source,
      symbol: 'ETH/USD',
      bars: source.bars.map((bar) => ({ ...bar, open: 100, high: 100.03, low: 99.99, close: 100 })),
    }),
  )
  const candidates = Result.getOrThrow(makeEntrySourceCandidates(context(chart, 100_000_000n, 100_010_000n)))
  expect(candidates).toEqual({ supportBarIds: [], resistanceBarIds: [], baseWindows: [] })
})
