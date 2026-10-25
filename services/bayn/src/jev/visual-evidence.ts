import { deflateSync } from 'node:zlib'
import { Result, Schema } from 'effect'

import { sha256 } from '../hash'
import { JevContractError, type JevRequest } from './contract'

const Bar = Schema.Struct({
  minuteBeforeWindowEnd: Schema.Finite,
  open: Schema.Finite,
  high: Schema.Finite,
  low: Schema.Finite,
  close: Schema.Finite,
  volume: Schema.Finite,
})
export type VisualBar = typeof Bar.Type
const VisualState = Schema.Struct({
  candidate: Schema.Struct({ symbol: Schema.NonEmptyString, bars1m: Schema.Array(Bar) }),
})
const invalid = (message: string) => Result.fail(new JevContractError({ message }))

/** Validate only a projection; native Jev state includes additional sealed signals. */
export const verifiedVisualBars = (request: JevRequest) =>
  Result.gen(function* () {
    const state = yield* Schema.decodeUnknownResult(VisualState)(request.state).pipe(
      Result.mapError(() => new JevContractError({ message: 'Visual research requires native candidate OHLCV state' })),
    )
    const bars = state.candidate.bars1m
    if (bars.length < 5 || bars.length > 120)
      return yield* invalid('Visual research requires between 5 and 120 completed bars')
    let previousMinute = Number.POSITIVE_INFINITY
    for (const bar of bars) {
      if (
        !Object.values(bar).every(Number.isFinite) ||
        !Number.isInteger(bar.minuteBeforeWindowEnd) ||
        bar.minuteBeforeWindowEnd < 1 ||
        bar.minuteBeforeWindowEnd >= previousMinute ||
        bar.open <= 0 ||
        bar.close <= 0 ||
        bar.low <= 0 ||
        bar.high < Math.max(bar.open, bar.close, bar.low) ||
        bar.low > Math.min(bar.open, bar.close) ||
        bar.volume < 0
      )
        return yield* invalid('Visual research rejected malformed, unordered or impossible OHLCV bars')
      previousMinute = bar.minuteBeforeWindowEnd
    }
    const first = bars[0]
    const last = bars.at(-1)
    if (first === undefined || last === undefined || first.minuteBeforeWindowEnd - last.minuteBeforeWindowEnd > 120)
      return yield* invalid('Visual research observation exceeds 120 elapsed minutes')
    return { symbol: state.candidate.symbol, bars }
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

/** Reproducible PNG: no clock, external renderer, additional data or hidden indicators. */
export const renderNativeCandlesPng = (bars: readonly VisualBar[]): Buffer => {
  const first = bars[0]
  const last = bars.at(-1)
  if (first === undefined || last === undefined) throw new RangeError('Cannot render empty OHLCV')
  const width = 640
  const height = 360
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
  for (const bar of bars) {
    const x = 12 + Math.round(((first.minuteBeforeWindowEnd - bar.minuteBeforeWindowEnd) / timeRange) * 616)
    const color = bar.close >= bar.open ? up : down
    vertical(x, yFor(bar.high), yFor(bar.low), ink)
    const top = Math.min(yFor(bar.open), yFor(bar.close))
    const bottom = Math.max(yFor(bar.open), yFor(bar.close))
    for (let column = x - bodyWidth; column <= x + bodyWidth; column++) {
      vertical(column, top, bottom, color)
      vertical(column, 349 - Math.round((bar.volume / volumeMax) * 67), 349, color)
    }
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

export const nativeCandlestickEvidence = (request: JevRequest) =>
  verifiedVisualBars(request).pipe(
    Result.map(({ symbol, bars }) => {
      const png = renderNativeCandlesPng(bars)
      return {
        symbol,
        barCount: bars.length,
        barsHash: sha256(JSON.stringify(bars)),
        pngHash: sha256(png),
        image: `data:image/png;base64,${png.toString('base64')}`,
        provenance: 'DERIVED_FROM_SAME_NATIVE_OHLCV' as const,
      }
    }),
  )
