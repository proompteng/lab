import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { makeNativeChartEvidence } from './chart-evidence'
import { candleProjection } from './chart-projection'
import { buildChartJevRequest, chartAssessmentsFromBoxes } from './chart-questions'
import { decodeJevProtocol, defaultJevProtocolDocument } from './protocol'
import { jevModel } from './contract'

const chart = Result.getOrThrow(
  makeNativeChartEvidence({
    symbol: 'AAPL',
    windowEndAt: '2026-11-06T16:00:00.000Z',
    bars: [
      [101, 112, 99, 103],
      [104, 106, 100, 103],
      [102, 104, 100, 103],
      [103, 104, 101, 103],
      [104, 106, 103, 105],
      [106, 108, 104, 106],
    ].map(([open, high, low, close], index) => ({
      minuteBeforeWindowEnd: 6 - index,
      open,
      high,
      low,
      close,
      volume: 1000,
    })),
  }),
)
const source = {
  chart,
  protocol: Result.getOrThrow(decodeJevProtocol(defaultJevProtocolDocument)),
  funding: { bidMicros: '105000000', askMicros: '105010000', capitalMicros: '5000000000', cryptoFeeTier: null },
}
const boxFor = (first: number, last = first) => {
  const projection = candleProjection(chart.bars)
  const bars = projection.bars.slice(first, last + 1)
  return {
    top: (Math.min(...bars.map((bar) => bar.high)) - 1) / projection.height,
    bottom: (Math.max(...bars.map((bar) => bar.low)) + 1) / projection.height,
    left: (Math.min(...bars.map((bar) => bar.x)) - 1) / projection.width,
    right: (Math.max(...bars.map((bar) => bar.x)) + 1) / projection.width,
  }
}
const response = () => ({
  model: jevModel,
  answers: {
    support_present: { type: 'noul', noul: 0.9 },
    support_region: { type: 'box', box: boxFor(0), confidence: 0.92 },
    resistance_present: { type: 'noul', noul: 0.9 },
    resistance_region: { type: 'box', box: boxFor(1), confidence: 0.93 },
    base_present: { type: 'noul', noul: 0.9 },
    base_region: { type: 'box', box: boxFor(2, 3), confidence: 0.94 },
  },
  usage: { input_tokens: 2000, output_tokens: 100 },
})

test('one image request localizes all three structures without a base-start choice', () => {
  const prepared = Result.getOrThrow(buildChartJevRequest(source))
  expect(prepared.request.model).toBe('jev-1.14.0')
  expect(
    Object.values(prepared.request.questions)
      .map((question) => question.type)
      .sort(),
  ).toEqual(['box', 'box', 'box', 'noul', 'noul', 'noul'])
  expect(Object.keys(prepared.request.assets ?? {})).toEqual([`bayn_chart_image_${chart.pngHash}`])
})

test('maps normalized boxes to exact original bar IDs and retains their confidence', () => {
  const assessed = Result.getOrThrow(chartAssessmentsFromBoxes(source, response()))
  expect(assessed.support.anchor).toEqual({ status: 'ASSESSED', barId: chart.bars[0]?.id, probability: 0.92 })
  expect(assessed.resistance.anchor).toEqual({ status: 'ASSESSED', barId: chart.bars[1]?.id, probability: 0.93 })
  expect(assessed.base.first).toEqual({ status: 'ASSESSED', barId: chart.bars[2]?.id, probability: 0.94 })
  expect(assessed.base.last).toEqual({ status: 'ASSESSED', barId: chart.bars[3]?.id, probability: 0.94 })
  expect(assessed.pngHash).toBe(chart.pngHash)
  expect(assessed.barsHash).toBe(chart.barsHash)
})

test.each([0, 0.1, 0.3])('a returned box cannot invent a structure when presence is %s', (probability) => {
  const raw = response()
  raw.answers.support_present.noul = probability
  raw.answers.base_present.noul = probability
  const assessed = Result.getOrThrow(chartAssessmentsFromBoxes(source, raw))
  expect(assessed.support.anchor.status).toBe('NOT_IDENTIFIED')
  expect(assessed.base.first.status).toBe('NOT_IDENTIFIED')
  expect(assessed.resistance.anchor.status).toBe('ASSESSED')
})

test('rejects volume-panel anchors and a base which includes the newest candle', () => {
  const raw = response()
  raw.answers.support_region.box = { top: 0.8, bottom: 0.9, left: 0, right: 1 }
  raw.answers.base_region.box = boxFor(2, 5)
  const assessed = Result.getOrThrow(chartAssessmentsFromBoxes(source, raw))
  expect(assessed.support.anchor.status).toBe('NOT_IDENTIFIED')
  expect(assessed.base.last.status).toBe('NOT_IDENTIFIED')
})

test('rounded zero-area regions remain unavailable even with strong presence and confidence', () => {
  const raw = response()
  raw.answers.support_region.box.bottom = raw.answers.support_region.box.top
  raw.answers.base_region.box.right = raw.answers.base_region.box.left
  const assessed = Result.getOrThrow(chartAssessmentsFromBoxes(source, raw))
  expect(assessed.support.anchor.status).toBe('NOT_IDENTIFIED')
  expect(assessed.base.first.status).toBe('NOT_IDENTIFIED')
  expect(assessed.resistance.anchor.status).toBe('ASSESSED')
})

test('a partial boundary candle cannot extend the fully enclosed consolidation', () => {
  const raw = response()
  raw.answers.base_region.box.left = boxFor(1).left
  const assessed = Result.getOrThrow(chartAssessmentsFromBoxes(source, raw))
  expect(assessed.base.first).toEqual({ status: 'ASSESSED', barId: chart.bars[2]?.id, probability: 0.94 })
  expect(assessed.base.last).toEqual({ status: 'ASSESSED', barId: chart.bars[3]?.id, probability: 0.94 })
})
