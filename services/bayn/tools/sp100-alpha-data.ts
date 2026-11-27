import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

import { Schema } from 'effect'

import { etfs, sectors, splits } from './sp100-alpha-protocol'

export const prefix = 'bayn-research-datasets/2026-11-27-sip-10yr-sp100'
export const dataName = 'alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz'
export const manifestSha = 'ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e'
export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')

const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.sip-10yr-sp100-manifest.v1'),
    sectorMap: Schema.Record(Schema.String, Schema.Array(Schema.String)),
    etfs: Schema.Array(Schema.String),
    totalSymbols: Schema.Literal(165),
    files: Schema.Tuple([
      Schema.Struct({
        key: Schema.Literal(`${prefix}/${dataName}`),
        rows: Schema.Literal(450_712),
        rawBytes: Schema.Int,
        gzipBytes: Schema.Int,
        rawSha256: Schema.String,
        gzipSha256: Schema.String,
      }),
    ]),
  }),
)

export type Series = {
  symbol: string
  open: Float64Array
  close: Float64Array
  high: Float64Array
  low: Float64Array
}
export type Tape = {
  dates: string[]
  series: Series[]
  spy: number
  stockSectors: number[][]
  etfClasses: number[][]
  sectorEtfs: number[]
  rows: number
  dataSha: string
}

export const decodeManifest = (bytes: Uint8Array) => {
  if (sha256(bytes) !== manifestSha) throw new Error('Unexpected frozen manifest SHA-256')
  return decode(JSON.parse(new TextDecoder().decode(bytes)))
}

export function* lines(content: string) {
  let start = 0
  while (start < content.length) {
    const end = content.indexOf('\n', start)
    if (end === -1) {
      yield content.slice(start)
      return
    }
    yield content.slice(start, end)
    start = end + 1
  }
}

export function parseTape(
  content: string,
  stockGroups: readonly (readonly string[])[],
  etfGroups: readonly (readonly string[])[],
  through: string,
): Tape {
  const symbols = [...stockGroups.flat(), ...etfGroups.flat()]
  const ids = new Map(symbols.map((symbol, i) => [symbol, i]))
  const index = (symbol: string) => {
    const id = ids.get(symbol)
    if (id === undefined) throw new Error(`Missing universe symbol: ${symbol}`)
    return id
  }
  if (ids.size !== symbols.length) throw new Error('Duplicate universe symbol')
  const spy = index('SPY')
  const dates: string[] = []
  let previous = ''
  for (const line of lines(content)) {
    if (!line.startsWith('SPY\t')) continue
    const date = line.slice(4, 14)
    if (date > through) continue
    if (date <= previous) throw new Error(`SPY calendar not strictly increasing: ${date}`)
    dates.push(date)
    previous = date
  }
  const sessions = new Map(dates.map((date, i) => [date, i]))
  const series: Series[] = symbols.map((symbol) => ({
    symbol,
    open: new Float64Array(dates.length),
    close: new Float64Array(dates.length),
    high: new Float64Array(dates.length),
    low: new Float64Array(dates.length),
  }))
  let rows = 0
  const digest = createHash('sha256')
  const latest: number[] = []
  for (const line of lines(content)) {
    const tab = line.indexOf('\t')
    const date = line.slice(tab + 1, tab + 11)
    // Do not decode prices or expose future bar objects to development.
    if (date > through) continue
    const [symbol, time, ...fields] = line.split('\t')
    const id = index(symbol)
    const i = sessions.get(date)
    const [open, high, low, close, volume, vwap] = fields.map(Number)
    if (
      i === undefined ||
      !/^\d{4}-\d\d-\d\dT0[45]:00:00Z$/.test(time) ||
      !Number.isFinite(Date.parse(time)) ||
      fields.length !== 6 ||
      fields.some((field) => field.trim() === '') ||
      [open, high, low, close, volume, vwap].some((n) => !Number.isFinite(n) || n <= 0) ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close) ||
      i <= (latest[id] ?? -1)
    ) {
      throw new Error(`Invalid or unordered bar: ${symbol} ${time}`)
    }
    latest[id] = i
    const bar = series[id]
    bar.open[i] = open
    bar.close[i] = close
    bar.high[i] = high
    bar.low[i] = low
    rows++
    digest.update(line).update('\n')
  }
  return {
    dates,
    series,
    spy,
    stockSectors: stockGroups.map((group) => group.map(index)),
    etfClasses: etfGroups.map((group) => group.map(index)),
    sectorEtfs: stockGroups.map((_, i) => index(sectors[i])),
    rows,
    dataSha: digest.digest('hex'),
  }
}

export function loadTape(
  manifest: ReturnType<typeof decodeManifest>,
  compressed: Uint8Array,
  through: (typeof splits)[keyof typeof splits][1],
  groups: readonly (readonly string[])[],
) {
  const [file] = manifest.files
  if (compressed.length !== file.gzipBytes || sha256(compressed) !== file.gzipSha256)
    throw new Error('Frozen SIP gzip identity mismatch')
  const raw = gunzipSync(compressed)
  if (raw.length !== file.rawBytes || sha256(raw) !== file.rawSha256)
    throw new Error('Frozen SIP TSV identity mismatch')
  const stockGroups = sectors.map((sector) => manifest.sectorMap[sector])
  if (
    Object.keys(manifest.sectorMap).length !== sectors.length ||
    stockGroups.some((group) => group === undefined || group.length < 4) ||
    stockGroups.flat().length !== 138 ||
    manifest.etfs.toSorted().join(',') !== etfs.toSorted().join(',')
  )
    throw new Error('Frozen universe does not match the 11-sector protocol')
  const tape = parseTape(new TextDecoder('utf-8', { fatal: true }).decode(raw), stockGroups, groups, through)
  if (
    tape.series.length !== manifest.totalSymbols ||
    tape.series.some((_, i) => !tape.series[i].close.some((close) => close > 0)) ||
    tape.dates[0] !== splits.train[0] ||
    tape.dates.at(-1) !== through ||
    tape.dates.length !== (through === splits.holdout[1] ? 2741 : 2012) ||
    (through === splits.holdout[1] && tape.rows !== file.rows)
  )
    throw new Error('SIP session, symbol or row coverage mismatch')
  return tape
}
