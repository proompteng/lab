import { join } from 'node:path'

import { etfs as canaryEtfs, splits } from './etf-canary-macro-protocol'
import { etfs as premiaEtfs } from './multi-asset-risk-premia-protocol'
import type { Bar } from './multi-asset-risk-premia-signals'
import { normalizeResearchCalendar, requireCalendarCoverage } from './research-lib/calendar'
import { archiveBucket, countArchiveLines, decodeArchiveJson, readGzipLines } from './research-lib/s3-archive'

export const etfs = [...new Set<string>([...canaryEtfs, ...premiaEtfs])]
export const intradayEtfs = ['IWM', 'QQQ', 'SMH', 'SPY'] as const
const intradaySet = new Set<string>(intradayEtfs)
const etfSet = new Set(etfs)
export type DailyFrame = { date: string; bars: ReadonlyMap<string, Bar> }
export type IntradayDay = { date: string; slots: number; bars: ReadonlyMap<string, readonly (Bar | undefined)[]> }
const prefix = 'bayn-research-datasets/2026-11-27'

const datasets = {
  daily: {
    prefix: prefix + '-sip-10yr-sp100',
    manifestSha256: 'ffaa9d30d69d38307f69ec77f07c12cdd82c7407131a110bc3b88421b0f1676e',
    name: 'alpaca_sip_daily_10yr_sp100_etfs_20160104_20261125.tsv.gz',
    sha256: 'fdda4017ee662fae548d8111a970ea90d83b3e8ee6f61abd6153be0fe83547d2',
    bytes: 9_338_659,
    rawSha256: 'e5331bb57e6f6427449d0cd3ab59291f56e508cb8c3961557bfd1374a635c9a8',
    rawBytes: 29_435_892,
    rows: 450_712,
  },
  macro: {
    prefix: prefix + '-sip-10yr-sp100-supplement-dia-uup',
    manifestSha256: 'ea0324abff46b2a44ea718dfbac625b9c434a1d21addc77eb5491d0249a79355',
    name: 'alpaca_sip_daily_dia_uup_20160104_20261125.tsv.gz',
    sha256: '0c8daf58178d0de84f9c8183ab01ba0708fcac395f0623d901864ed5ad96d620',
    bytes: 100_078,
    rows: 5_482,
  },
  blind: {
    prefix: prefix + '-sip-8yr-5m-unseen-v2',
    manifestSha256: 'c18d9c4d537ae17a6322dc8a2d5a9338b8851706d58c5ea62f02a31b37ea0eb0',
    name: 'alpaca_sip_5m_rth_exact62_20160104_20231229.tsv.gz',
    sha256: 'b077755a745238dad9e64234e9ca4cde63b08808aeb9fef4cf74210af349b141',
    bytes: 174_598_869,
    memberBytes: 174_597_176,
    rows: 8_641_719,
  },
  recent: {
    prefix: prefix + '-sip-multiyear',
    manifestSha256: '5df0cfe213c69e9a6489dde46553db610edb2632b5e54fb76a6347740abcdead',
    name: 'alpaca_sip_5m_rth_62sym_20240102_20261125.tsv.gz',
    sha256: '105972d7825b4deb14a30295fab153b1e734929e1c321642964ec8d35bbbc697',
    bytes: 80_649_568,
    rawSha256: 'c053ede2875ad791c99aae517db9efa9a4587b08c9907d55e0960dade59d567e',
    rawBytes: 273_982_883,
    rows: 3_923_737,
  },
} as const

const calendars = {
  blind: {
    prefix: datasets.blind.prefix,
    name: 'calendar_2016_2023.json',
    sha256: '0165400d9544973b0971a2397969e65bd2543beff5d8bd47510f09b015ef7f86',
  },
  recent: {
    prefix,
    name: 'calendar_2024_2026.json',
    sha256: 'b7a02f0c79aa479de2eba14e6168826cabaf8eef15df4c94cf1f199511752b71',
  },
} as const
export const receipts = { bucket: archiveBucket, datasets, calendars }
type Dataset = (typeof datasets)[keyof typeof datasets]

export const tapeReceipt = (receipt: Dataset) => ({
  key: `${receipt.prefix}/${receipt.name}`,
  bytes: receipt.bytes,
  sha256: receipt.sha256,
  ...('memberBytes' in receipt ? { memberBytes: receipt.memberBytes } : {}),
  ...('rawSha256' in receipt ? { raw: { bytes: receipt.rawBytes, sha256: receipt.rawSha256 } } : {}),
})
const json = async (path: string, digest: string): Promise<unknown> =>
  decodeArchiveJson(await Bun.file(path).bytes(), path, digest)

const verifiedLines = (
  path: string,
  receipt: Dataset,
  signal: AbortSignal,
  onLine: (line: string, index: number) => void,
) => readGzipLines(Bun.file(path).stream(), tapeReceipt(receipt), signal, countArchiveLines(onLine))

const bar = (fields: readonly string[], label: string): Bar => {
  const [open, high, low, close, volume] = fields.slice(2, 7).map(Number)
  if (
    ![open, high, low, close, volume, Number(fields.at(-1))].every((v) => Number.isFinite(v) && v > 0) ||
    high < Math.max(open, close) ||
    low > Math.min(open, close) ||
    !Number.isSafeInteger(volume)
  )
    throw new Error(`Invalid OHLCV: ${label}`)
  return { open, high, low, close }
}

const dateOfDaily = /^\d{4}-\d{2}-\d{2}T0[45]:00:00Z$/
const dateOfMinute = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00(?:\.0+)?(?:Z|\+00:00)$/

export const loadData = async (directory: string, signal: AbortSignal) => {
  // These exact upstream manifests are content-addressed; admission precedes reading any bars.
  for (const [id, dataset] of Object.entries(datasets))
    await json(join(directory, `${id}.json`), dataset.manifestSha256)
  const first = '2016-01-04'
  const seam = '2023-12-29'
  const blind = requireCalendarCoverage(
    normalizeResearchCalendar({
      query: { start: first, end: seam },
      response: await json(join(directory, 'calendar.json'), calendars.blind.sha256),
    }),
    first,
    seam,
    2_012,
  )
  const recent = requireCalendarCoverage(
    normalizeResearchCalendar(await json(join(directory, 'recent-calendar.json'), calendars.recent.sha256)).filter(
      ({ date }) => date <= splits.holdout[1],
    ),
    splits.holdout[0],
    splits.holdout[1],
    splits.holdout[2],
  )
  const calendar = [...blind, ...recent]
  const byDate = new Map(calendar.map(({ date }) => [date, new Map<string, Bar>()]))
  for (const kind of ['daily', 'macro'] as const) {
    const receipt = datasets[kind]
    const rows = await verifiedLines(join(directory, `${kind}.gz`), receipt, signal, (line) => {
      const symbol = line.slice(0, line.indexOf('\t'))
      if (!etfSet.has(symbol)) return
      const fields = line.split('\t')
      const date = fields[1]?.slice(0, 10)
      const bars = byDate.get(date)
      if (
        fields.length !== 8 ||
        !dateOfDaily.test(fields[1]) ||
        bars === undefined ||
        bars.has(symbol) ||
        (kind === 'macro') !== (symbol === 'DIA' || symbol === 'UUP')
      )
        throw new Error(`Invalid or duplicate ${kind} row: ${symbol} ${fields[1]}`)
      bars.set(symbol, bar(fields, `${symbol} ${date}`))
    })
    if (rows !== receipt.rows) throw new Error(`Unexpected ${kind} row count: ${rows}`)
  }
  const daily = [...byDate].map(([date, bars]) => {
    for (const symbol of etfs) {
      const knownGap =
        (symbol === 'XLC' && date < '2018-06-19') ||
        (symbol === 'XLRE' && (date === '2016-01-25' || date === '2016-02-16'))
      if (bars.has(symbol) === knownGap) throw new Error(`Unexpected daily coverage: ${symbol} ${date}`)
    }
    return { date, bars }
  })

  const intraday: IntradayDay[] = []
  const coverage: Record<string, unknown> = {}
  for (const [kind, sessions] of [
    ['blind', blind],
    ['recent', recent],
  ] as const) {
    const receipt = datasets[kind]
    const input = new Map(
      sessions.map((session) => [
        session.date,
        {
          session,
          bars: new Map<string, (Bar | undefined)[]>(),
        },
      ]),
    )
    const outsideRth = new Map<string, number>()
    const accepted = new Map<string, number>()
    const last = new Map<string, number>()
    let header = 0
    const rows = await verifiedLines(join(directory, `${kind}.gz`), receipt, signal, (line, index) => {
      if (index === 0 && line === 'symbol\tt\to\th\tl\tc\tv\tn\tvw') {
        header++
        return
      }
      const symbol = line.slice(0, line.indexOf('\t'))
      if (!intradaySet.has(symbol)) return
      const fields = line.split('\t')
      const stamp = fields[1]
      const frame = input.get(stamp?.slice(0, 10))
      const time = Date.parse(stamp)
      if (
        fields.length !== (kind === 'blind' ? 9 : 8) ||
        !dateOfMinute.test(stamp) ||
        !Number.isFinite(time) ||
        time <= (last.get(symbol) ?? -Infinity) ||
        frame === undefined
      )
        throw new Error(`Invalid, unordered or duplicate ${kind} bar: ${symbol} ${stamp}`)
      last.set(symbol, time)
      const slots = frame.session.minutes / 5
      const slot = (time - frame.session.openMs) / 300_000
      if (!Number.isInteger(slot)) throw new Error(`Off-grid bar: ${symbol} ${stamp}`)
      if (slot < 0 || slot >= slots) {
        outsideRth.set(symbol, (outsideRth.get(symbol) ?? 0) + 1)
        return
      }
      let series = frame.bars.get(symbol)
      if (series === undefined) {
        series = Array.from({ length: slots })
        frame.bars.set(symbol, series)
      }
      if (kind === 'blind' && (!Number.isSafeInteger(Number(fields[7])) || Number(fields[7]) <= 0))
        throw new Error(`Invalid SIP trade count: ${symbol} ${stamp}`)
      series[slot] = bar(fields, `${symbol} ${stamp}`)
      accepted.set(symbol, (accepted.get(symbol) ?? 0) + 1)
    })
    if (rows - header !== receipt.rows) throw new Error(`Unexpected ${kind} row count: ${rows - header}`)
    for (const [date, { session, bars }] of input) {
      const slots = session.minutes / 5
      if (intradayEtfs.some((symbol) => !bars.has(symbol))) throw new Error(`Missing ETF session: ${date}`)
      intraday.push({ date, slots, bars })
    }
    coverage[kind] = {
      rows: rows - header,
      regular: Object.fromEntries(accepted),
      outsideRth: Object.fromEntries(outsideRth),
    }
  }
  return { daily, intraday, coverage }
}
