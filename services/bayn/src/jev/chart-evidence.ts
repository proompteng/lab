import { deflateSync } from 'node:zlib'
import { Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import { SymbolSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { JevContractError } from './contract'

const Bar = Schema.Struct({
  minuteBeforeWindowEnd: Schema.Finite,
  open: Schema.Finite,
  high: Schema.Finite,
  low: Schema.Finite,
  close: Schema.Finite,
  volume: Schema.Finite,
})
export type VisualBar = typeof Bar.Type
export const ChartSourceSchema = Schema.Struct({
  symbol: SymbolSchema,
  windowEndAt: UtcInstantSchema,
  bars: Schema.Array(Bar).check(Schema.isMinLength(1), Schema.isMaxLength(120)),
})
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

export const decodeChartSource = (input: unknown) =>
  Result.gen(function* () {
    const source = yield* Schema.decodeUnknownResult(
      ChartSourceSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError(() => new JevContractError({ message: 'Chart source requires identified completed OHLCV bars' })),
    )
    const { bars } = source
    let previousMinute = Number.POSITIVE_INFINITY
    for (const bar of bars) {
      if (
        !Object.values(bar).every(Number.isFinite) ||
        !Number.isInteger(bar.minuteBeforeWindowEnd) ||
        bar.minuteBeforeWindowEnd < 1 ||
        bar.minuteBeforeWindowEnd > 120 ||
        bar.minuteBeforeWindowEnd >= previousMinute ||
        bar.open <= 0 ||
        bar.close <= 0 ||
        bar.low <= 0 ||
        bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close) ||
        bar.volume < 0
      )
        return yield* invalid('Chart source contains malformed, unordered or impossible completed bars')
      previousMinute = bar.minuteBeforeWindowEnd
    }
    if (Date.parse(source.windowEndAt) % 60_000 !== 0)
      return yield* invalid('Chart source requires a completed minute boundary')
    return source
  })

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index
  for (let shift = 0; shift < 8; shift++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})
const pngChunk = (kind: string, payload: Buffer): Buffer => {
  const data = Buffer.concat([Buffer.from(kind, 'ascii'), payload])
  let crc = 0xffffffff
  for (const byte of data) crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  const length = Buffer.alloc(4)
  const check = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  check.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([length, data, check])
}

const digits = [
  '111101101101111',
  '010110010010111',
  '111001111100111',
  '111001111001111',
  '101101111001001',
  '111100111001111',
  '111100111101111',
  '111001001001001',
  '111101111101111',
  '111101111001111',
]

export const renderNativeCandlesPng = (bars: readonly VisualBar[]): Buffer => {
  const first = bars[0]
  const last = bars.at(-1)
  if (first === undefined || last === undefined) throw new RangeError('Cannot render empty OHLCV')
  const width = 640
  const height = 384
  const pixels = Buffer.alloc(width * height * 4, 255)
  const pixel = (x: number, y: number, color: readonly [number, number, number]) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const i = (y * width + x) * 4
    pixels[i] = color[0]
    pixels[i + 1] = color[1]
    pixels[i + 2] = color[2]
  }
  const vertical = (x: number, top: number, bottom: number, color: readonly [number, number, number]) => {
    for (let y = Math.max(0, top); y <= Math.min(height - 1, bottom); y++) pixel(x, y, color)
  }
  const number = (value: number, x: number, y: number, color: readonly [number, number, number]) => {
    const text = String(value)
    for (let index = 0; index < text.length; index++) {
      const glyph = digits[Number(text[index])]
      if (glyph === undefined) continue
      for (let row = 0; row < 5; row++)
        for (let column = 0; column < 3; column++) {
          if (glyph[row * 3 + column] !== '1') continue
          for (let dx = 0; dx < 2; dx++)
            for (let dy = 0; dy < 2; dy++) pixel(x + index * 8 + column * 2 + dx, y + row * 2 + dy, color)
        }
    }
  }
  const minimum = Math.min(...bars.map((bar) => bar.low))
  const maximum = Math.max(...bars.map((bar) => bar.high))
  const range = maximum - minimum || maximum * 0.001
  const timeRange = first.minuteBeforeWindowEnd - last.minuteBeforeWindowEnd || 1
  const yFor = (price: number) => 16 + Math.round(((maximum - price) / range) * 236)
  const volumeMax = Math.max(1, ...bars.map((bar) => bar.volume))
  const ink: readonly [number, number, number] = [83, 94, 103]
  const up: readonly [number, number, number] = [22, 136, 109]
  const down: readonly [number, number, number] = [190, 64, 69]
  for (let x = 8; x < width - 8; x++) pixel(x, 273, ink)
  const bodyWidth = Math.max(1, Math.min(5, Math.floor(616 / timeRange / 3)))
  for (const [index, bar] of bars.entries()) {
    const x = 12 + Math.round(((first.minuteBeforeWindowEnd - bar.minuteBeforeWindowEnd) / timeRange) * 616)
    const color = bar.close >= bar.open ? up : down
    vertical(x, yFor(bar.high), yFor(bar.low), ink)
    const top = Math.min(yFor(bar.open), yFor(bar.close))
    const bottom = Math.max(yFor(bar.open), yFor(bar.close))
    for (let column = x - bodyWidth; column <= x + bodyWidth; column++) {
      vertical(column, top, bottom, color)
      vertical(column, 349 - Math.round((bar.volume / volumeMax) * 67), 349, color)
    }
    if (index % Math.max(1, Math.ceil(bars.length / 20)) === 0 || index === bars.length - 1)
      number(bar.minuteBeforeWindowEnd, Math.max(0, x - String(bar.minuteBeforeWindowEnd).length * 4), 365, ink)
  }
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const chartImages = new Map<string, { readonly pngHash: string; readonly image: string }>()
const chartImage = (barsHash: string, bars: readonly VisualBar[]) => {
  const existing = chartImages.get(barsHash)
  if (existing !== undefined) return existing
  const png = renderNativeCandlesPng(bars)
  const rendered = { pngHash: sha256(png), image: `data:image/png;base64,${png.toString('base64')}` }
  if (chartImages.size >= 64) {
    const oldest = chartImages.keys().next()
    if (!oldest.done) chartImages.delete(oldest.value)
  }
  chartImages.set(barsHash, rendered)
  return rendered
}

export const makeNativeChartEvidence = (input: unknown) =>
  decodeChartSource(input).pipe(
    Result.flatMap((source) =>
      Result.gen(function* () {
        const { symbol, bars, windowEndAt } = source
        const barsHash = yield* canonicalHashV1Result(source).pipe(
          Result.mapError((cause) => new JevContractError({ message: 'Chart source cannot be hashed', cause })),
        )
        const identifiedBars = bars.map((bar) => {
          const timestamp = new Date(Date.parse(windowEndAt) - bar.minuteBeforeWindowEnd * 60_000).toISOString()
          return { ...bar, id: `bar_${timestamp}`, timestamp, chartLabel: String(bar.minuteBeforeWindowEnd) }
        })
        return {
          symbol,
          windowEndAt,
          bars: identifiedBars,
          barCount: bars.length,
          barsHash,
          ...chartImage(barsHash, bars),
          provenance: 'DERIVED_FROM_SAME_NATIVE_OHLCV' as const,
        }
      }),
    ),
  )

export type NativeChartEvidence = Result.Result.Success<ReturnType<typeof makeNativeChartEvidence>>
