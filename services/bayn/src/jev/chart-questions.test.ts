import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeNativeChartEvidence, type NativeChartEvidence } from './chart-evidence'
import { defaultJevProtocolDocument } from './protocol'
import { canonicalHashV1Result } from '../hash'
import {
  makeInitialChartStageRequest,
  makeSelectedBaseStartStageRequest,
  stagedChartAssessments,
} from './staged-chart-questions'
import type { JevRequest, JevResponse } from './contract'
import { buildChartJevRequest } from './chart-questions'
import { jevEntryEconomics } from './entry-economics'
import { EntrySetup, makeEntryProposals, ProposalRejection } from './entry-proposals'

const sourceFor = (chart: NativeChartEvidence) => ({
  chart,
  protocol: defaultJevProtocolDocument,
  funding: { bidMicros: '106010000', askMicros: '106020000', capitalMicros: '100000000000', cryptoFeeTier: null },
})
const prepareFixtureChart = (chart: NativeChartEvidence) => makeInitialChartStageRequest(sourceFor(chart))
const receiptFor = (requestHash: string, response: unknown) => ({
  requestHash,
  responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
  response,
})
const assessFixtureChart = (chart: NativeChartEvidence, response: unknown) =>
  Result.gen(function* () {
    const source = sourceFor(chart)
    const initial = yield* prepareFixtureChart(chart)
    const receipt = receiptFor(initial.requestHash, response)
    const next = yield* makeSelectedBaseStartStageRequest(source, receipt)
    return yield* stagedChartAssessments(
      source,
      receipt,
      next.status === 'PREPARED' ? receiptFor(next.requestHash, responseFor(next.request)) : null,
    )
  })

const source = {
  symbol: 'ETH/USD',
  windowEndAt: '2026-10-25T07:00:00.000Z',
  bars: Array.from({ length: 6 }, (_, index) => ({
    minuteBeforeWindowEnd: 6 - index,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 100,
  })),
}
const responseFor = (request: JevRequest): JevResponse => ({
  model: request.model,
  answers: Object.fromEntries(
    Object.entries(request.questions).map(([name, question]) => {
      if (question.type === 'noul') return [name, { type: 'noul' as const, noul: 0.2 }]
      if (question.type !== 'choice') throw new Error('Unexpected source question')
      const choices = Object.keys(question.criteria)
      const selected = choices[0]
      if (selected === undefined) throw new Error('Missing source choices')
      return [
        name,
        {
          type: 'choice' as const,
          choice: selected,
          confidence: 0.8,
          probabilities: Object.fromEntries(choices.map((choice, index) => [choice, index === 0 ? 1 : 0])),
        },
      ]
    }),
  ),
  usage: { input_tokens: 100, output_tokens: 0 },
})

describe('source-bound chart questions', () => {
  test('keeps the same observed base available across fee tiers while independently rejecting an unfunded proposal', () => {
    const chart = Result.getOrThrow(
      makeNativeChartEvidence({
        symbol: 'ETH/USD',
        windowEndAt: '2026-10-31T08:00:00.000Z',
        bars: [
          { minuteBeforeWindowEnd: 4, open: 99.4, high: 100, low: 99, close: 99.8, volume: 100 },
          { minuteBeforeWindowEnd: 3, open: 100.1, high: 100.4, low: 100, close: 100.3, volume: 100 },
          { minuteBeforeWindowEnd: 2, open: 100.3, high: 100.4, low: 100, close: 100.2, volume: 100 },
          { minuteBeforeWindowEnd: 1, open: 100.4, high: 100.405, low: 100.395, close: 100.4, volume: 100 },
        ],
      }),
    )
    const first = chart.bars[1]
    const last = chart.bars[2]
    if (first === undefined || last === undefined) throw new Error('Expected the observed two-bar base')
    const requests: string[] = []
    for (const cryptoFeeTier of [4, 8] as const) {
      const funding = {
        bidMicros: '100410000',
        askMicros: '100420000',
        capitalMicros: '100000000000',
        cryptoFeeTier,
      }
      const prepared = Result.getOrThrow(
        buildChartJevRequest({ chart, protocol: defaultJevProtocolDocument, funding }, { selectedEnd: last.id }),
      )
      expect(prepared.sourceFeasible).toBe(true)
      requests.push(prepared.body)
      const start = prepared.request.questions['base_first_bar_ending_2']
      if (start?.type !== 'choice') throw new Error('Expected the selected base-start question')
      expect(Object.keys(start.criteria)).toContain(first.id)
      const economics = Result.getOrThrow(
        jevEntryEconomics({
          feeAt: '2026-09-04T14:15:00.000Z',
          ...funding,
          symbol: chart.symbol,
          protocol: defaultJevProtocolDocument,
          bidMicros: BigInt(funding.bidMicros),
          askMicros: BigInt(funding.askMicros),
        }),
      )
      if (economics === null) throw new Error('Expected a bounded entry quantity')
      const absent = { status: 'NOT_IDENTIFIED' } as const
      const result = Result.getOrThrow(
        makeEntryProposals({
          chart,
          protocol: defaultJevProtocolDocument,
          economics,
          bidMicros: BigInt(funding.bidMicros),
          assessments: {
            schemaVersion: 'bayn.chart-assessments.v4',
            symbol: chart.symbol,
            windowEndAt: chart.windowEndAt,
            barsHash: chart.barsHash,
            pngHash: chart.pngHash,
            support: { presence: { status: 'ASSESSED', probability: 0 }, anchor: absent },
            resistance: { presence: { status: 'ASSESSED', probability: 0 }, anchor: absent },
            base: {
              presence: { status: 'ASSESSED', probability: 1 },
              first: { status: 'ASSESSED', probability: 1, barId: first.id },
              last: { status: 'ASSESSED', probability: 1, barId: last.id },
            },
          },
        }),
      )
      if (cryptoFeeTier === 4) {
        expect(result.proposals).toHaveLength(0)
        expect(result.rejections).toContainEqual({ setup: EntrySetup.BaseBreakout, reason: ProposalRejection.Unfunded })
      } else {
        expect(result.proposals).toHaveLength(1)
        expect(result.proposals[0]?.source.setup).toBe(EntrySetup.BaseBreakout)
      }
    }
    expect(requests[0]).toBe(requests[1])
  })

  test('reuses preparation work for identical source content', () => {
    const native = Result.getOrThrow(makeNativeChartEvidence({ ...source, windowEndAt: '2031-01-01T00:00:00.000Z' }))
    let barReads = 0
    const chart = new Proxy(native, {
      get(target, property, receiver) {
        if (property === 'bars') barReads++
        return Reflect.get(target, property, receiver)
      },
    })
    const first = Result.getOrThrow(prepareFixtureChart(chart))
    const initialReads = barReads
    barReads = 0
    const second = Result.getOrThrow(prepareFixtureChart(chart))
    expect(second).toEqual(first)
    expect(barReads).toBeLessThan(initialReads)
  })

  test('reuses deterministic request bytes without sharing mutable results or trusting a claimed chart hash', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source))
    const first = Result.getOrThrow(prepareFixtureChart(chart))
    const originalBody = first.body
    const originalHash = first.requestHash
    const question = Object.values(first.request.questions)[0]
    if (question === undefined) throw new Error('Missing chart question')
    Reflect.set(question, 'instructions', 'Mutated caller copy')
    Reflect.set(first, 'body', 'Mutated caller body')
    const second = Result.getOrThrow(prepareFixtureChart(chart))
    expect(second.request).not.toBe(first.request)
    expect(second.body).toBe(originalBody)
    expect(second.requestHash).toBe(originalHash)
    expect(JSON.parse(second.body)).toEqual(second.request)
    const bar = chart.bars[0]
    if (bar === undefined) throw new Error('Missing chart bar')
    const changed = Result.getOrThrow(
      prepareFixtureChart({ ...chart, bars: [{ ...bar, high: bar.high + 1 }, ...chart.bars.slice(1)] }),
    )
    expect(changed.requestHash).not.toBe(originalHash)
    expect(changed.request.state).toMatchObject({
      source: { bars: [{ ...bar, high: bar.high + 1 }, ...chart.bars.slice(1)] },
    })
  })

  test('asks separate presence and source-anchor questions over the actual chart', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source))
    const prepared = Result.getOrThrow(prepareFixtureChart(chart))
    expect(Object.keys(prepared.request.questions).toSorted()).toEqual(
      [
        'support_present',
        'resistance_present',
        'base_present',
        'support_anchor',
        'resistance_anchor',
        'base_last_bar',
      ].toSorted(),
    )
    const first = chart.bars[0]
    expect(first?.timestamp).toBe('2026-10-25T06:54:00.000Z')
    expect(first?.chartLabel).toBe('6')
    expect(chart.bars.at(-1)?.timestamp).toBe('2026-10-25T06:59:00.000Z')
    for (const [name, question] of Object.entries(prepared.request.questions))
      if (question.type === 'choice' && !name.startsWith('base_'))
        expect(Object.keys(question.criteria)).toEqual(
          name === 'support_anchor'
            ? [...chart.bars.map((bar) => bar.id), 'no_support']
            : [...chart.bars.slice(-1).map((bar) => bar.id), 'no_resistance'],
        )
    const ends = prepared.request.questions['base_last_bar']
    if (ends?.type !== 'choice') throw new Error('Expected base end choice')
    expect(Object.keys(ends.criteria)).toEqual([...chart.bars.slice(1, -1).map((bar) => bar.id), 'no_base'])
    expect(prepared.request.assets?.[`bayn_chart_image_${chart.pngHash}`]?.data_base64).toBe(chart.image.split(',')[1])
    expect(chart).toEqual(Result.getOrThrow(makeNativeChartEvidence(source)))
  })

  test('retains weak presence evidence instead of treating a forced choice as an observed structure', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source))
    const request = Result.getOrThrow(prepareFixtureChart(chart)).request
    const assessments = Result.getOrThrow(assessFixtureChart(chart, responseFor(request)))
    expect(assessments.support.presence).toEqual({ status: 'ASSESSED', probability: 0.2 })
    expect(assessments.support.anchor).toMatchObject({ status: 'ASSESSED', barId: chart.bars[0]?.id, probability: 1 })
  })

  test('keeps a missing base independent of the support assessment', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source))
    const request = Result.getOrThrow(prepareFixtureChart(chart)).request
    const response = responseFor(request)
    const answer = response.answers['base_last_bar']
    if (answer?.type !== 'choice') throw new Error('Expected base end question')
    const assessments = Result.getOrThrow(
      assessFixtureChart(chart, {
        ...response,
        answers: {
          ...response.answers,
          base_last_bar: {
            ...answer,
            choice: 'no_base',
            probabilities: Object.fromEntries(
              Object.keys(answer.probabilities).map((value) => [value, value === 'no_base' ? 1 : 0]),
            ),
          },
        },
      }),
    )
    expect(assessments.base.first).toEqual({ status: 'NOT_IDENTIFIED' })
    expect(assessments.base.last).toEqual({ status: 'NOT_IDENTIFIED' })
    expect(assessments.support.presence.status).toBe('ASSESSED')
  })

  test('keeps no-match available when only one eligible source bar exists', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence({ ...source, bars: source.bars.slice(-1) }))
    const request = Result.getOrThrow(prepareFixtureChart(chart)).request
    expect(Object.keys(request.questions)).toHaveLength(5)
    const assessments = Result.getOrThrow(assessFixtureChart(chart, responseFor(request)))
    expect(assessments.support.anchor).toMatchObject({ status: 'ASSESSED', barId: chart.bars[0]?.id })
    const response = responseFor(request)
    const absent = Result.getOrThrow(
      assessFixtureChart(chart, {
        ...response,
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([name, answer]) => {
            if (answer.type !== 'choice') return [name, answer]
            const value = name === 'support_anchor' ? 'no_support' : 'no_resistance'
            return [
              name,
              {
                ...answer,
                choice: value,
                probabilities: Object.fromEntries(
                  Object.keys(answer.probabilities).map((key) => [key, key === value ? 1 : 0]),
                ),
              },
            ]
          }),
        ),
      }),
    )
    expect(absent.support.anchor).toEqual({ status: 'NOT_IDENTIFIED' })
    expect(absent.resistance.anchor).toEqual({ status: 'NOT_IDENTIFIED' })
  })

  test('rejects missing bars, unfinished bars, impossible OHLC, duplicate times and off-minute boundaries', () => {
    const first = source.bars[0]
    if (first === undefined) throw new Error('Expected source fixture')
    for (const changed of [
      { ...source, bars: [] },
      { ...source, bars: [{ ...first, minuteBeforeWindowEnd: 0 }] },
      { ...source, bars: [{ ...first, minuteBeforeWindowEnd: 121 }] },
      { ...source, bars: [{ ...first, high: 1 }] },
      { ...source, bars: [first, first] },
      { ...source, windowEndAt: '2026-10-25T07:00:01.000Z' },
    ])
      expect(Result.isFailure(makeNativeChartEvidence(changed))).toBe(true)
  })

  test('binds changed source prices and window identity into the chart and provider request', () => {
    const baseline = Result.getOrThrow(makeNativeChartEvidence(source))
    for (const changed of [
      { ...source, windowEndAt: '2026-10-25T07:01:00.000Z' },
      { ...source, bars: source.bars.map((bar, index) => (index === 0 ? { ...bar, low: bar.low - 1 } : bar)) },
    ]) {
      const chart = Result.getOrThrow(makeNativeChartEvidence(changed))
      expect(chart.barsHash).not.toBe(baseline.barsHash)
      expect(Result.getOrThrow(prepareFixtureChart(chart)).requestHash).not.toBe(
        Result.getOrThrow(prepareFixtureChart(baseline)).requestHash,
      )
    }
  })
})
