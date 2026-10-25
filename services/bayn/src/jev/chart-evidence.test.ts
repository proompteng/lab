import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { sha256 } from '../hash'
import { makeNativeChartEvidence, renderNativeCandlesPng } from './chart-evidence'

const source = {
  symbol: 'AAPL',
  windowEndAt: '2026-09-04T14:30:00.000Z',
  bars: [
    { minuteBeforeWindowEnd: 2, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
    { minuteBeforeWindowEnd: 1, open: 101, high: 103, low: 100, close: 102, volume: 1200 },
  ],
}

test('repeated chart evidence retains the exact uncached renderer bytes', () => {
  const png = renderNativeCandlesPng(source.bars)
  const first = Result.getOrThrow(makeNativeChartEvidence(source))
  const repeated = Result.getOrThrow(makeNativeChartEvidence(structuredClone(source)))
  expect(first.pngHash).toBe(sha256(png))
  expect(first.image).toBe(`data:image/png;base64,${png.toString('base64')}`)
  expect(repeated).toEqual(first)
})

test('caller changes to returned evidence cannot poison a later chart', () => {
  const first = Result.getOrThrow(makeNativeChartEvidence(source))
  const expected = structuredClone(first)
  Reflect.set(first, 'image', 'changed')
  Reflect.set(first, 'pngHash', 'changed')
  const bar = first.bars[0]
  if (bar === undefined) throw new Error('Missing source bar')
  Reflect.set(bar, 'high', 999)
  expect(Result.getOrThrow(makeNativeChartEvidence(source))).toEqual(expected)
})

test('every call validates and hashes the actual source before using rendered bytes', () => {
  const original = Result.getOrThrow(makeNativeChartEvidence(source))
  const changed = structuredClone(source)
  const bar = changed.bars[1]
  if (bar === undefined) throw new Error('Missing source bar')
  bar.close = 100
  const next = Result.getOrThrow(makeNativeChartEvidence(changed))
  expect(next.barsHash).not.toBe(original.barsHash)
  expect(next.pngHash).not.toBe(original.pngHash)
  expect(next.pngHash).toBe(sha256(renderNativeCandlesPng(changed.bars)))
  bar.low = 200
  expect(Result.isFailure(makeNativeChartEvidence(changed))).toBe(true)
  expect(Result.getOrThrow(makeNativeChartEvidence(source))).toEqual(original)
})
