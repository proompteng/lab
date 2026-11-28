import { readFileSync } from 'node:fs'
import { Schema } from 'effect'

import { sha256 } from '../src/hash'
import { IsoDateSchema, PositiveIntegerSchema, SymbolSchema, strictParseOptions } from '../src/schemas'

export const readReplayFile = (path: string) => {
  const content = readFileSync(path, 'utf8')
  return { content, source: { path, sha256: sha256(content), bytes: Buffer.byteLength(content) } }
}

// Avoid allocating a second full copy of a multi-year export as an array of lines.
export function* replayLines(content: string) {
  let start = 0
  while (start < content.length) {
    const end = content.indexOf('\n', start)
    if (end < 0) {
      yield content.slice(start)
      break
    }
    yield content.slice(start, end).replace(/\r$/, '')
    start = end + 1
  }
}

export interface MinuteQuote {
  readonly firstBid: number
  readonly firstAsk: number
  readonly lastBid: number
  readonly lastAsk: number
}

export const parseReplayQuotes = (path: string, symbols: ReadonlySet<string>) => {
  const { content, source } = readReplayFile(path)
  const bySymbol = new Map<string, Map<number, MinuteQuote>>()
  let rows = 0
  let lineNumber = 0
  for (const line of replayLines(content)) {
    lineNumber++
    if (lineNumber === 1) {
      if (
        line !==
        'symbol\tminute_utc\tquote_count\tfirst_bid\tfirst_ask\tlast_bid\tlast_ask\tmedian_spread_bps\tp75_spread_bps'
      )
        throw new Error(`Unexpected quote TSV header in ${path}`)
      continue
    }
    if (line === '') continue
    const [symbol = '', at = '', ...values] = line.split('\t')
    const [count = 0, firstBid = 0, firstAsk = 0, lastBid = 0, lastAsk = 0, median = -1, p75 = -1] = values.map(Number)
    const minute = Date.parse(at)
    if (
      values.length !== 7 ||
      values.some((value) => value.trim() === '' || !Number.isFinite(Number(value))) ||
      !Number.isFinite(minute) ||
      (at !== new Date(minute).toISOString() && at !== new Date(minute).toISOString().replace('.000Z', 'Z')) ||
      minute % 60_000 !== 0 ||
      !Number.isSafeInteger(count) ||
      count <= 0 ||
      firstBid <= 0 ||
      firstAsk < firstBid ||
      lastBid <= 0 ||
      lastAsk < lastBid ||
      median < 0 ||
      p75 < median
    )
      throw new Error(`Invalid L1 minute in ${path}:${lineNumber}`)
    if (!symbols.has(symbol)) continue
    const quotes = bySymbol.get(symbol) ?? new Map<number, MinuteQuote>()
    if (quotes.has(minute)) throw new Error(`Duplicate L1 minute for ${symbol} ${at} in ${path}:${lineNumber}`)
    quotes.set(minute, { firstBid, firstAsk, lastBid, lastAsk })
    bySymbol.set(symbol, quotes)
    rows++
  }
  if (rows === 0) throw new Error(`No replay-universe L1 rows in ${path}`)
  return { source, rows, bySymbol }
}

const SplitSchema = Schema.Struct({
  symbol: SymbolSchema,
  effectiveDate: IsoDateSchema,
  newShares: PositiveIntegerSchema,
  oldShares: PositiveIntegerSchema,
})
type Split = typeof SplitSchema.Type

export const parseReplaySplits = (path: string, symbols: ReadonlySet<string>, sessions: ReadonlySet<string>) => {
  const { content, source } = readReplayFile(path)
  const splits = Schema.decodeUnknownSync(Schema.Array(SplitSchema), strictParseOptions)(JSON.parse(content))
  const seen = new Set<string>()
  for (const { symbol, effectiveDate, newShares, oldShares } of splits) {
    const key = `${symbol}|${effectiveDate}`
    if (
      !symbols.has(symbol) ||
      !sessions.has(effectiveDate) ||
      !Number.isSafeInteger(newShares) ||
      !Number.isSafeInteger(oldShares) ||
      seen.has(key)
    )
      throw new Error(`Invalid or duplicate split for ${key} in ${path}`)
    seen.add(key)
  }
  return { source, splits: splits.toSorted((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)) }
}

export const priorPriceScale = (splits: readonly Split[], symbol: string, priorDate: string, currentDate: string) =>
  splits.reduce(
    (scale, split) =>
      split.symbol === symbol && priorDate < split.effectiveDate && split.effectiveDate <= currentDate
        ? scale * (split.oldShares / split.newShares)
        : scale,
    1,
  )
