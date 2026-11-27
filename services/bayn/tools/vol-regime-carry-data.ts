import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'

export const universe = [
  'SPY',
  'QQQ',
  'IWM',
  'SMH',
  'XLK',
  'XLF',
  'XLV',
  'XLY',
  'XLC',
  'XLI',
  'XLP',
  'XLE',
  'XLU',
  'XLRE',
  'XLB',
  'TLT',
  'IEF',
  'SHY',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'USO',
  'DBC',
  'EFA',
  'EEM',
  'VNQ',
  'DIA',
  'UUP',
] as const
export type Symbol = (typeof universe)[number]

export const assets = Object.fromEntries(universe.map((symbol, i) => [symbol, i])) as Record<Symbol, number>
const start = '2016-01-04'
export const developmentEnd = '2023-12-29'
export const end = '2026-11-25'
const prefix = 'bayn-research-datasets/2026-11-27-sip-10yr-sp100'
export const sources = [
  {
    name: 'base',
    prefix,
    file: 'alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz',
    manifest: 'ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e',
    gzip: 'fdda4017ee662fae548d8111a970ea90d83b3e8ee6f61abd6153be0fe83547d2',
    raw: 'e5331bb57e6f6427449d0cd3ab59291f56e508cb8c3961557bfd1374a635c9a8',
    symbols: universe.slice(0, -2),
  },
  {
    name: 'supplement',
    prefix: `${prefix}-supplement-dia-uup`,
    file: 'alpaca_sip_daily_dia_uup_20160104_20261125.tsv.gz',
    manifest: 'ea0324abff46b2a44ea718dfbac625b9c434a1d21addc77eb5491d0249a79355',
    gzip: '0c8daf58178d0de84f9c8183ab01ba0708fcac395f0623d901864ed5ad96d620',
    raw: null,
    symbols: universe.slice(-2),
  },
] as const

export const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export type Bar = { open: number; close: number }
export type Session = { date: string; bars: (Bar | undefined)[] }
export type Archive = { manifest: Uint8Array; gzip: Uint8Array }

export const parseBars = (text: string, symbols: readonly Symbol[], through: string) => {
  const panel = new Map<string, Session>()
  const allowed = new Set<string>(symbols)
  const last = new Map<string, string>()
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t')
    const symbol = line.slice(0, tab) as Symbol
    if (!allowed.has(symbol)) continue
    const date = line.slice(tab + 1, tab + 11)
    if (date > through) continue
    const cells = line.split('\t')
    const [, stamp, o, h, l, c, v, vw] = cells
    const [open, high, low, close, volume, vwap] = [o, h, l, c, v, vw].map(Number)
    // SIP daily timestamps are midnight New York time (04:00 or 05:00 UTC).
    if (
      cells.length !== 8 ||
      !/^\d{4}-\d{2}-\d{2}T0[45]:00:00(?:\.\d+)?Z$/.test(stamp) ||
      date < start ||
      [open, high, low, close, volume, vwap].some((value) => !Number.isFinite(value) || value <= 0) ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close) ||
      date <= (last.get(symbol) ?? '')
    )
      throw new Error(`Invalid or out-of-order ETF bar: ${symbol} ${date}`)
    last.set(symbol, date)
    const session = panel.get(date) ?? { date, bars: Array<Bar | undefined>(universe.length).fill(undefined) }
    session.bars[assets[symbol]] = { open, close }
    panel.set(date, session)
  }
  return panel
}

export const loadSessions = (archives: readonly Archive[], through: typeof developmentEnd | typeof end): Session[] => {
  const panels = sources.map((source, i) => {
    const { manifest, gzip } = archives[i]
    if (hash(manifest) !== source.manifest || hash(gzip) !== source.gzip)
      throw new Error(`Frozen archive hash mismatch: ${source.prefix}`)
    const raw = gunzipSync(gzip)
    if (source.raw !== null && hash(raw) !== source.raw) throw new Error(`Raw archive hash mismatch: ${source.prefix}`)
    return parseBars(raw.toString(), source.symbols, through)
  })
  const [base, supplement] = panels
  const dates = [...base.keys()].toSorted()
  if (
    dates.length !== (through === developmentEnd ? 2012 : 2741) ||
    dates[0] !== start ||
    dates.at(-1) !== through ||
    supplement.size !== dates.length
  )
    throw new Error('Unexpected frozen session calendar')
  return dates.map((date) => {
    const baseBars = base.get(date)?.bars
    const supplementBars = supplement.get(date)?.bars
    if (baseBars === undefined || supplementBars === undefined) throw new Error(`Calendar disagreement on ${date}`)
    const bars = universe.map((symbol, i) => {
      const bar = i < sources[0].symbols.length ? baseBars[i] : supplementBars[i]
      const expectedGap =
        (symbol === 'XLC' && date < '2018-06-19') || (symbol === 'XLRE' && ['2016-01-25', '2016-02-16'].includes(date))
      if ((bar === undefined) !== expectedGap) throw new Error(`Unexpected coverage for ${symbol} on ${date}`)
      return bar
    })
    return { date, bars }
  })
}
