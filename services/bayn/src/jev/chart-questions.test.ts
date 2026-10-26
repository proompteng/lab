import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeNativeChartEvidence } from './chart-evidence'
import { chartAssessments, makeChartDecisionsRequest } from './chart-questions'
import type { DecisionsRequest } from './decisions'

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
const responseFor = (request: DecisionsRequest) => ({
  model: 'gpt-6-luna',
  answers: request.questions.map((question) =>
    question.type === 'predicate'
      ? { type: 'predicate', name: question.name, probability: 0.2 }
      : {
          type: 'choice',
          name: question.name,
          choice: question.choices[0]?.value,
          confidence: 0.8,
          probabilities: question.choices.map((choice, index) => ({
            value: choice.value,
            probability: index === 0 ? 1 : 0,
          })),
        },
  ),
  usage: {
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 0,
    total_tokens: 100,
  },
})

describe('source-bound chart questions', () => {
  test('asks separate presence and source-anchor questions over the actual chart', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source))
    const prepared = Result.getOrThrow(makeChartDecisionsRequest(chart))
    expect(prepared.request.questions.map((question) => question.name)).toEqual([
      'support_present',
      'resistance_present',
      'base_present',
      'support_anchor',
      'resistance_anchor',
      'base_first_bar',
      'base_last_bar',
    ])
    const first = chart.bars[0]
    expect(first?.timestamp).toBe('2026-10-25T06:54:00.000Z')
    expect(first?.chartLabel).toBe('6')
    expect(chart.bars.at(-1)?.timestamp).toBe('2026-10-25T06:59:00.000Z')
    for (const question of prepared.request.questions)
      if (question.type === 'choice')
        expect(question.choices.map((choice) => choice.value)).toEqual(chart.bars.map((bar) => bar.id))
    expect(prepared.request.input[0].content[1].image_url).toBe(chart.image)
    expect(chart).toEqual(Result.getOrThrow(makeNativeChartEvidence(source)))
  })

  test('retains weak presence evidence instead of treating a forced choice as an observed structure', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source))
    const request = Result.getOrThrow(makeChartDecisionsRequest(chart)).request
    const assessments = Result.getOrThrow(chartAssessments(chart, responseFor(request)))
    expect(assessments.support.presence).toEqual({ status: 'ASSESSED', probability: 0.2 })
    expect(assessments.support.anchor).toMatchObject({ status: 'ASSESSED', barId: chart.bars[0]?.id, probability: 1 })
  })

  test('keeps a refused base independent of the support assessment', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence(source))
    const request = Result.getOrThrow(makeChartDecisionsRequest(chart)).request
    const response = responseFor(request)
    const assessments = Result.getOrThrow(
      chartAssessments(chart, {
        ...response,
        answers: response.answers.map((answer) =>
          answer.name.startsWith('base_') ? { type: 'refusal', name: answer.name } : answer,
        ),
      }),
    )
    expect(assessments.base.presence).toEqual({ status: 'REFUSED' })
    expect(assessments.base.first).toEqual({ status: 'REFUSED' })
    expect(assessments.support.presence.status).toBe('ASSESSED')
  })

  test('does not invent a second option when only one source bar exists', () => {
    const chart = Result.getOrThrow(makeNativeChartEvidence({ ...source, bars: source.bars.slice(-1) }))
    const request = Result.getOrThrow(makeChartDecisionsRequest(chart)).request
    expect(request.questions).toHaveLength(3)
    const assessments = Result.getOrThrow(chartAssessments(chart, responseFor(request)))
    expect(assessments.support.anchor).toEqual({ status: 'SOURCE_SINGLETON', barId: chart.bars[0]?.id })
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
      expect(Result.getOrThrow(makeChartDecisionsRequest(chart)).requestHash).not.toBe(
        Result.getOrThrow(makeChartDecisionsRequest(baseline)).requestHash,
      )
    }
  })
})
