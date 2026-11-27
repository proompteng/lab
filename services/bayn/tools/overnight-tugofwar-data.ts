import { createHash } from 'node:crypto'

export const prefix = 'bayn-research-datasets/2026-11-27-sip-10yr-sp100'
export const tapeKey = `${prefix}/alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz`
export const gzipHash = 'fdda4017ee662fae548d8111a970ea90d83b3e8ee6f61abd6153be0fe83547d2'
export const rawHash = 'e5331bb57e6f6427449d0cd3ab59291f56e508cb8c3961557bfd1374a635c9a8'
export const manifestHash = 'ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e'
export const splits = {
  train: { from: '2016-01-04', through: '2021-12-31', sessions: 1511 },
  validation: { from: '2022-01-03', through: '2023-12-29', sessions: 501 },
  holdout: { from: '2024-01-02', through: '2026-11-25', sessions: 729 },
} as const
export const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

export interface Universe {
  equities: ReadonlyMap<string, string>
  etfs: readonly string[]
  symbols: ReadonlySet<string>
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isSymbols = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((symbol) => typeof symbol === 'string' && /^[A-Z]+$/.test(symbol))

export function readManifest(bytes: Uint8Array): Universe {
  if (sha256(bytes) !== manifestHash) throw new Error('Manifest SHA-256 mismatch')
  const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!isObject(manifest)) throw new Error('Malformed manifest')
  const { sectorMap, etfs, files } = manifest
  const file: unknown = Array.isArray(files) && files.length === 1 ? files[0] : null
  if (
    manifest['schemaVersion'] !== 'bayn.sip-10yr-sp100-manifest.v1' ||
    !isObject(file) ||
    file['key'] !== tapeKey ||
    file['gzipSha256'] !== gzipHash ||
    file['rawSha256'] !== rawHash ||
    file['rows'] !== 450_712 ||
    !isObject(sectorMap) ||
    Object.keys(sectorMap).length !== 11 ||
    !isSymbols(etfs) ||
    etfs.length !== 27
  )
    throw new Error('Unexpected Wave 4G manifest contract')
  const equities = new Map<string, string>()
  const symbols = new Set(etfs)
  for (const [sector, members] of Object.entries(sectorMap)) {
    if (!etfs.includes(sector) || !isSymbols(members)) throw new Error(`Invalid sector: ${sector}`)
    for (const symbol of members) {
      if (symbols.has(symbol)) throw new Error(`Repeated manifest symbol: ${symbol}`)
      symbols.add(symbol)
      if (symbol !== 'MMC') equities.set(symbol, sector)
    }
  }
  if (
    symbols.size !== 165 ||
    equities.size !== 137 ||
    !symbols.has('MMC') ||
    !etfs.includes('SHY') ||
    !etfs.includes('SPY')
  ) {
    throw new Error('Unexpected Wave 4G universe')
  }
  return { equities, etfs, symbols }
}

export interface Bar {
  open: number
  close: number
  volume: number
}

export interface Tape {
  dates: string[]
  bars: ReadonlyMap<string, readonly (Bar | undefined)[]>
  universe: Universe
  rows: number
}

// Development projects the date field before parsing any price, volume, or symbol beyond its cutoff.
export function parseTape(text: string, universe: Universe, through: string): Tape {
  const records = new Map<string, Map<string, Bar>>()
  const observedDates = new Set<string>()
  let rows = 0
  for (const line of text.split('\n')) {
    if (line === '') continue
    const dateOffset = line.indexOf('\t') + 1
    const date = line.slice(dateOffset, dateOffset + 10)
    if (date > through) continue
    const [symbol, stamp, o, h, l, c, v, vwap, ...extra] = line.split('\t')
    if (
      !universe.symbols.has(symbol) ||
      !/^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/.test(stamp) ||
      date < splits.train.from ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date ||
      extra.length !== 0
    )
      throw new Error(`Unexpected bar identity: ${symbol} ${stamp}`)
    const [open, high, low, close, volume, weightedPrice] = [o, h, l, c, v, vwap].map(Number)
    if (
      [open, high, low, close, weightedPrice].some((x) => !Number.isFinite(x) || x <= 0) ||
      low > Math.min(open, close) ||
      high < Math.max(open, close) ||
      !Number.isSafeInteger(volume) ||
      volume <= 0
    )
      throw new Error(`Invalid OHLCV: ${symbol} ${date}`)
    const series = records.get(symbol) ?? new Map<string, Bar>()
    if (series.has(date)) throw new Error(`Duplicate bar: ${symbol} ${date}`)
    series.set(date, { open, close, volume })
    records.set(symbol, series)
    observedDates.add(date)
    rows++
  }
  const dates = [...observedDates].sort()
  const bars = new Map<string, (Bar | undefined)[]>()
  for (const symbol of universe.symbols) {
    const series = records.get(symbol)
    if (series === undefined) throw new Error(`Missing registered symbol: ${symbol}`)
    bars.set(
      symbol,
      dates.map((date) => series.get(date)),
    )
  }
  for (const benchmark of ['SPY', 'SHY']) {
    if (bars.get(benchmark)?.some((bar) => bar === undefined) !== false)
      throw new Error(`Incomplete benchmark: ${benchmark}`)
  }
  return { dates, bars, universe, rows }
}

export function readTape(gzip: Uint8Array, universe: Universe, mode: 'development' | 'full') {
  if (sha256(gzip) !== gzipHash) throw new Error('Gzip SHA-256 mismatch')
  const raw = Bun.gunzipSync(new Uint8Array(gzip))
  const full = mode === 'full'
  if (full && sha256(raw) !== rawHash) throw new Error('Raw tape SHA-256 mismatch')
  const tape = parseTape(
    new TextDecoder().decode(raw),
    universe,
    full ? splits.holdout.through : splits.validation.through,
  )
  if (tape.rows !== (full ? 450_712 : 330_646)) throw new Error(`Unexpected ${mode} row count: ${tape.rows}`)
  for (const [name, { from, through, sessions }] of Object.entries(splits)) {
    if (name === 'holdout' && !full) continue
    const dates = tape.dates.filter((date) => date >= from && date <= through)
    if (dates.length !== sessions || dates[0] !== from || dates.at(-1) !== through)
      throw new Error(`Unexpected ${name} calendar`)
  }
  if (tape.dates.length !== (full ? 2741 : 2012)) throw new Error('Unexpected dates outside registered splits')
  return tape
}
