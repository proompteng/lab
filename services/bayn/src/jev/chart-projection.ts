import type { VisualBar } from './chart-evidence'

export const candleProjection = <B extends VisualBar>(bars: readonly B[]) => {
  const first = bars[0]
  const last = bars.at(-1)
  if (first === undefined || last === undefined) throw new RangeError('Cannot project an empty chart')
  const minimum = Math.min(...bars.map((bar) => bar.low))
  const maximum = Math.max(...bars.map((bar) => bar.high))
  const range = maximum - minimum || maximum * 0.001
  const timeRange = first.minuteBeforeWindowEnd - last.minuteBeforeWindowEnd || 1
  const priceY = (price: number) => 16 + Math.round(((maximum - price) / range) * 236)
  return {
    width: 640,
    height: 384,
    plot: { left: 12, right: 628, top: 16, bottom: 252 },
    bodyWidth: Math.max(1, Math.min(5, Math.floor(616 / timeRange / 3))),
    priceY,
    bars: bars.map((bar) => ({
      source: bar,
      x: 12 + Math.round(((first.minuteBeforeWindowEnd - bar.minuteBeforeWindowEnd) / timeRange) * 616),
      low: priceY(bar.low),
      high: priceY(bar.high),
      bodyTop: Math.min(priceY(bar.open), priceY(bar.close)),
      bodyBottom: Math.max(priceY(bar.open), priceY(bar.close)),
    })),
  }
}
