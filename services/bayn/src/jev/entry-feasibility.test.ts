import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { makeNativeChartEvidence } from './chart-evidence'
import { jevEntryEconomics } from './entry-economics'
import { entryEvaluationRequestFixture } from './entry-inference.test-support'
import { makeEntryProposals, makeEntrySourceCandidates } from './entry-proposals'
import type { ChartAssessments } from './chart-questions'

const sourceIsFeasible = (input: Parameters<typeof makeEntrySourceCandidates>[0]) =>
  makeEntrySourceCandidates(input).pipe(
    Result.map((c) => c.baseWindows.length > 0 || (c.supportBarIds.length > 0 && c.resistanceBarIds.length > 0)),
  )

const check = (symbol: string, values: readonly { high: number; low: number }[], bid: number, capital: string) => {
  const request = entryEvaluationRequestFixture(undefined, symbol)
  const chart = Result.getOrThrow(
    makeNativeChartEvidence({
      ...request.request.chartSource,
      bars: values.map((value, i) => ({
        minuteBeforeWindowEnd: values.length - i,
        open: value.low,
        close: value.high,
        high: value.high,
        low: value.low,
        volume: 1,
      })),
    }),
  )
  const economics = Result.getOrThrow(
    jevEntryEconomics({
      protocol: request.request.protocol,
      symbol,
      bidMicros: BigInt(bid),
      askMicros: BigInt(bid + 10_000),
      capitalMicros: capital,
      cryptoFeeTier: symbol.includes('/') ? 4 : null,
    }),
  )
  if (economics === null) return
  const input = { chart, economics, protocol: request.request.protocol, bidMicros: BigInt(bid) }
  const feasible = Result.getOrThrow(sourceIsFeasible(input))
  const first = chart.bars[0]
  if (first === undefined) throw new Error('Expected source bars')
  const refused = { status: 'REFUSED' } as const
  const assessed = { status: 'ASSESSED', probability: 1 } as const
  const anchor = (barId: string) => ({ ...assessed, barId })
  const assessments: ChartAssessments = {
    schemaVersion: 'bayn.chart-assessments.v4',
    symbol,
    windowEndAt: chart.windowEndAt,
    barsHash: chart.barsHash,
    pngHash: chart.pngHash,
    support: { presence: assessed, anchor: anchor(first.id) },
    resistance: { presence: assessed, anchor: anchor(first.id) },
    base: { presence: refused, first: refused, last: refused },
  }
  let anyFunded = false
  for (const support of chart.bars)
    for (const resistance of chart.bars) {
      const result = Result.getOrThrow(
        makeEntryProposals({
          ...input,
          assessments: {
            ...assessments,
            support: { presence: assessed, anchor: anchor(support.id) },
            resistance: { presence: assessed, anchor: anchor(resistance.id) },
          },
        }),
      )
      anyFunded ||= result.proposals.length > 0
    }
  for (const firstBar of chart.bars)
    for (const lastBar of chart.bars) {
      const result = Result.getOrThrow(
        makeEntryProposals({
          ...input,
          assessments: {
            ...assessments,
            support: { presence: refused, anchor: refused },
            base: { presence: assessed, first: anchor(firstBar.id), last: anchor(lastBar.id) },
          },
        }),
      )
      anyFunded ||= result.proposals.length > 0
    }
  expect(feasible).toBe(anyFunded)
}

describe('pre-chart source feasibility', () => {
  test('matches exhaustive native proposal construction for equity and crypto source windows', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('AAPL', 'BTC/USD', 'ETH/USD', 'SOL/USD'),
        fc.array(fc.record({ low: fc.integer({ min: 90, max: 110 }), width: fc.integer({ min: 0, max: 12 }) }), {
          minLength: 1,
          maxLength: 6,
        }),
        fc.integer({ min: 90_000_000, max: 125_000_000 }),
        (symbol, values, bid) =>
          check(
            symbol,
            values.map(({ low, width }) => ({ low, high: low + width })),
            bid,
            '100000000000',
          ),
      ),
      { numRuns: 120, seed: 664 },
    )
  })

  test('retains possible input when an unselected source price cannot be represented', () => {
    const request = entryEvaluationRequestFixture()
    const bars = request.request.chartSource.bars.map((bar, index) => (index === 3 ? { ...bar, high: 1e12 } : bar))
    const chart = Result.getOrThrow(makeNativeChartEvidence({ ...request.request.chartSource, bars }))
    const economics = Result.getOrThrow(
      jevEntryEconomics({
        protocol: request.request.protocol,
        symbol: chart.symbol,
        bidMicros: 104_000_000n,
        askMicros: 104_020_000n,
        capitalMicros: '100000000000',
        cryptoFeeTier: null,
      }),
    )
    if (economics === null) throw new Error('Expected funded quantity')
    const support = chart.bars[0]
    const resistance = chart.bars[2]
    if (support === undefined || resistance === undefined) throw new Error('Expected selectable source bars')
    const assessed = { status: 'ASSESSED', probability: 1 } as const
    const refused = { status: 'REFUSED' } as const
    const proposals = Result.getOrThrow(
      makeEntryProposals({
        chart,
        economics,
        protocol: request.request.protocol,
        bidMicros: 104_000_000n,
        assessments: {
          schemaVersion: 'bayn.chart-assessments.v1',
          symbol: chart.symbol,
          windowEndAt: chart.windowEndAt,
          barsHash: chart.barsHash,
          pngHash: chart.pngHash,
          support: { presence: assessed, anchor: { ...assessed, barId: support.id } },
          resistance: { presence: assessed, anchor: { ...assessed, barId: resistance.id } },
          base: { presence: refused, first: refused, last: refused },
        },
      }),
    )
    expect(proposals.proposals).toHaveLength(1)
    expect(
      Result.getOrThrow(
        sourceIsFeasible({
          chart,
          economics,
          protocol: request.request.protocol,
          bidMicros: 104_000_000n,
        }),
      ),
    ).toBe(true)
  })

  test('does not invent base intervals across missing source minutes', () => {
    const request = entryEvaluationRequestFixture()
    for (const gap of [false, true]) {
      const chart = Result.getOrThrow(
        makeNativeChartEvidence({
          ...request.request.chartSource,
          bars: [
            { minuteBeforeWindowEnd: gap ? 4 : 3, open: 100, close: 100, high: 101, low: 99, volume: 1 },
            { minuteBeforeWindowEnd: 2, open: 100, close: 100, high: 101, low: 99, volume: 1 },
            { minuteBeforeWindowEnd: 1, open: 100, close: 100, high: 101, low: 100, volume: 1 },
          ],
        }),
      )
      const economics = Result.getOrThrow(
        jevEntryEconomics({
          protocol: request.request.protocol,
          symbol: chart.symbol,
          bidMicros: 101_500_000n,
          askMicros: 101_510_000n,
          capitalMicros: '100000000000',
          cryptoFeeTier: null,
        }),
      )
      if (economics === null) throw new Error('Expected funded quantity')
      expect(
        Result.getOrThrow(
          sourceIsFeasible({
            chart,
            economics,
            protocol: request.request.protocol,
            bidMicros: 101_500_000n,
          }),
        ),
      ).toBe(!gap)
    }
  })
})
