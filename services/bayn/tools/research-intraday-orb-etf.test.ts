import { beforeAll, expect, test } from 'bun:test'
import { Redacted } from 'effect'

import type { Day } from './noise-area-study-replay'
import { normalizeResearchCalendar } from './research-lib/calendar'
import { readGzipLines, type ArchiveReader } from './research-lib/s3-archive'
import { stationaryBootstrap } from './research-lib/statistics'
import {
  Cash,
  Etf,
  etfs,
  fillOrder,
  FillGap,
  fitWidth,
  openingRange,
  planEntry,
  replayOrb,
  scoreBook,
} from './research-intraday-orb-etf-core'
import { loadStudyData, OrbStudyError, readStudyTape } from './research-intraday-orb-etf'

// Observed rows from the registered 5m SIP tape, not fabricated price or return fixtures.
// Only opening, breakout, fill and calendar-boundary slots are retained for these tests.
const rows = `QQQ	2024-04-19T13:30:00Z	422.22	422.24	421.06	421.71	1679531	421.794833
SPY	2024-04-19T13:30:00Z	499.44	499.73	498.6899	499.33	1616536	499.279202
IWM	2024-04-19T13:30:00Z	191.93	192.93	191.79	192.88	1310018	192.316984
SMH	2024-04-19T13:30:00Z	206.72	207.62	205.97	207.48	343286	206.722051
XLK	2024-04-19T13:30:00Z	97.92	98.05	97.74	97.98	602826	97.905364
XLE	2024-04-19T13:30:00Z	47.01	47.32	46.94	47.3	1235892	47.100395
XLI	2024-04-19T13:30:00Z	120.95	121.235	120.76	121.15	691924	121.010129
XLF	2024-04-19T13:30:00Z	40.05	40.12	39.97	40.085	1241573	40.047774
XLF	2024-04-19T13:35:00Z	40.085	40.14	40.04	40.125	710406	40.100289
XLF	2024-04-19T13:40:00Z	40.125	40.19	40.09	40.18	947967	40.154474
XLF	2024-04-19T13:45:00Z	40.17	40.22	40.16	40.16	974616	40.189595
XLF	2024-04-19T13:50:00Z	40.16	40.18	40.09	40.17	1119743	40.130717
XLF	2024-04-19T13:55:00Z	40.17	40.22	40.16	40.175	616213	40.183734
XLF	2024-04-19T14:00:00Z	40.18	40.245	40.18	40.21	473097	40.205993
XLF	2024-04-19T14:05:00Z	40.21	40.2599	40.2	40.235	777484	40.236572
XLF	2024-04-19T14:10:00Z	40.235	40.235	40.155	40.19	472377	40.1933
XLF	2024-04-19T14:15:00Z	40.19	40.2	40.13	40.155	750329	40.164363
XLF	2024-04-19T19:55:00Z	40.38	40.41	40.36	40.39	3773877	40.38261
XLF	2024-07-03T13:30:00Z	41.72	41.745	41.65	41.665	1162600	41.699399
XLF	2024-07-03T13:35:00Z	41.665	41.75	41.65	41.67	1586523	41.702601
XLF	2024-07-03T13:40:00Z	41.68	41.69	41.6	41.65	446643	41.635163
XLF	2024-07-03T13:45:00Z	41.65	41.67	41.64	41.645	427582	41.653544
XLF	2024-07-03T13:50:00Z	41.64	41.64	41.5401	41.57	631302	41.598362
XLF	2024-07-03T13:55:00Z	41.57	41.645	41.57	41.635	896702	41.612763
XLF	2024-07-03T14:00:00Z	41.64	41.69	41.61	41.655	785219	41.651006
XLF	2024-07-03T16:55:00Z	41.63	41.65	41.57	41.58	1467777	41.614763
XLF	2024-07-03T17:00:00Z	41.55	41.58	41.55	41.55	897776	41.550047`.split('\n')

// XLF, 30-minute opening features of the 20 exchange sessions preceding 2024-04-19.
const prior = [
  [0.003984126569143921, 4926289],
  [0.0020761690707910914, 3233192],
  [0.0029349760090504485, 3932457],
  [0.0020315047998149477, 2400010],
  [0.002976398296696602, 3320950],
  [0.0025002377936974456, 3986505],
  [0.004152762973295844, 4931479],
  [0.0016355381394699573, 4554320],
  [0.0028702779811527893, 2829271],
  [0.001766480046031356, 3498463],
  [0.004101509506415233, 3578250],
  [0.00267457512231826, 2966037],
  [0.004006763412600319, 4431760],
  [0.005065530287330651, 7226914],
  [0.0036264706983756604, 4217351],
  [0.005541896739602736, 8280857],
  [0.0032749360044247652, 7122167],
  [0.00685971314834244, 6142558],
  [0.002217263892121616, 4971564],
  [0.0024966592434366138, 3282465],
].map(([realizedVol, volume]) => ({ realizedVol, volume }))

const sessions = normalizeResearchCalendar({
  query: { start: '2024-04-19', end: '2024-07-03' },
  response: [
    { date: '2024-04-19', open: '09:30', close: '16:00' },
    { date: '2024-07-03', open: '09:30', close: '13:00' },
  ],
})
const roster = new Set(etfs)
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const fixture = (lines: readonly string[], expectedRows = lines.length, declared: ReadonlySet<string> = roster) => {
  const raw = new TextEncoder().encode(lines.join('\n') + '\n')
  const gzip = Uint8Array.from(Bun.gzipSync(raw))
  const archive: ArchiveReader = {
    readJson: () => Promise.reject(new Error('Unexpected metadata read')),
    readGzip: (receipt, consume) =>
      readGzipLines(
        new ReadableStream({
          start: (stream) => {
            stream.enqueue(gzip)
            stream.close()
          },
        }),
        receipt,
        new AbortController().signal,
        consume,
      ),
  }
  return readStudyTape(
    archive,
    {
      key: 'verified-excerpt.tsv.gz',
      bytes: gzip.length,
      sha256: hash(gzip),
      raw: { bytes: raw.length, sha256: hash(raw) },
    },
    sessions,
    declared,
    expectedRows,
  )
}

let data: Awaited<ReturnType<typeof fixture>>
beforeAll(async () => {
  data = await fixture(rows)
})

const xlf = (day: Day) => day.bars.get(Etf.XLF) ?? []
const gated30 = { width: 30, gated: true } as const
const ungated15 = { width: 15, gated: false } as const
const ungated30 = { width: 30, gated: false } as const

test('admits the registered ETF slots only and discards the bar at the early close', () => {
  expect(data.coverage).toMatchObject({ archiveRows: 27, sessions: 2, earlyCloses: 1, scopedOutsideRthRows: 1 })
  expect(data.coverage.bySymbol[Etf.XLF]).toEqual({ expectedBars: 120, observedBars: 19, missingBars: 101 })
  expect(data.days[0].bars.size).toBe(8)
  expect(data.days[1].slots).toBe(42)
  expect(xlf(data.days[1])[41]?.open).toBe(41.63)
  expect(xlf(data.days[1])[42]).toBeUndefined()
})

test('rejects short, duplicate, off-grid or undeclared evidence rather than repairing it', async () => {
  const rejects = async (input: Promise<unknown>, message: string) => {
    const error: unknown = await input.catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(OrbStudyError)
    if (!(error instanceof OrbStudyError)) throw new Error('Expected structured study error')
    expect(error.message).toContain(message)
  }
  await rejects(fixture(rows, rows.length + 1), 'row count')
  await rejects(fixture([...rows, rows[rows.length - 1]]), 'duplicate or unordered')
  await rejects(fixture(rows.with(0, rows[0].replace('13:30', '13:31'))), 'Off-grid')
  await rejects(fixture(rows, rows.length, new Set(etfs.filter((etf) => etf !== Etf.SPY))), 'Unregistered')
  await rejects(fixture(rows.filter((row) => !row.startsWith('XLI\t'))), 'No regular-session SIP bars')
})

test('invalid manifest failure is typed, redacts decoder inputs and does not request prices', async () => {
  const causeMarker = 'bad-feed-decoder-probe'
  const requests: string[] = []
  const archive: ArchiveReader = {
    readJson: (key) => {
      requests.push(key)
      return Promise.resolve({
        schemaVersion: 'bayn.sip-multiyear-dataset-manifest.v1',
        source: causeMarker,
        universes: { all62: [] },
        files: [],
      })
    },
    readGzip: (receipt) => {
      requests.push(receipt.key)
      return Promise.reject(new Error('Archive should be rejected before bar I/O'))
    },
  }
  const error: unknown = await loadStudyData(archive).catch((cause: unknown) => cause)
  expect(error).toBeInstanceOf(OrbStudyError)
  if (!(error instanceof OrbStudyError)) throw new Error('Expected structured study error')
  expect(Redacted.isRedacted(error.cause)).toBe(true)
  expect(Bun.inspect(error)).not.toContain(causeMarker)
  expect(requests).toEqual(['bayn-research-datasets/2026-11-27-sip-multiyear/MANIFEST.json'])
})

test('waits for a completed close outside the range, with exact same-width prior features', () => {
  const bars = xlf(data.days[0])
  const range = openingRange(bars, 30)
  expect(range).toMatchObject({ high: 40.22, low: 39.97, volume: 5610518 })
  expect(range?.realizedVol).toBeCloseTo(0.001989843493735446, 14)
  expect(planEntry(bars, range, prior.slice(1), gated30)).toBe(Cash.ReferenceUnavailable)
  expect(planEntry(bars, range, [undefined, ...prior.slice(1)], gated30)).toBe(Cash.ReferenceUnavailable)
  expect(planEntry(bars, openingRange(bars.with(0, undefined), 30), prior, gated30)).toBe(Cash.OpeningUnavailable)
  // Slot 6 prints a high through 40.22, but it closes inside the range. Prefix-only planning
  // places the order only after slot 7 closes; neither entry nor flatten bars are available yet.
  expect(planEntry(bars.slice(0, 7), range, prior, gated30)).toBe(Cash.SignalUnavailable)
  expect(planEntry(bars.slice(0, 8), range, prior, gated30)).toEqual({ side: 1, signalSlot: 7, quantity: 310 })
  expect(planEntry(bars.with(6, undefined), range, prior, gated30)).toBe(Cash.SignalUnavailable)
  expect(planEntry(bars, openingRange(bars, 15), [], ungated15)).toEqual({ side: 1, signalSlot: 6, quantity: 310 })
})

test('rejects uncompressed and low-volume openings before looking for a breakout', () => {
  // Recorded XLF 30-minute opening features for the next two exchange sessions.
  const april19 = openingRange(xlf(data.days[0]), 30)
  const april22 = { high: 40.62, low: 40.43, realizedVol: 0.003107664548494927, volume: 4034481 }
  const april23 = { high: 41.06, low: 40.95, realizedVol: 0.0020031199584874815, volume: 4609169 }
  expect(planEntry([], april22, [...prior.slice(1), april19], gated30)).toBe(Cash.VolatilityGate)
  expect(planEntry([], april23, [...prior.slice(2), april19, april22], gated30)).toBe(Cash.RvolGate)
})

test('fills at the scheduled opens without resizing or substituting a later open', () => {
  const regular = xlf(data.days[0])
  const long = planEntry(regular, openingRange(regular, 30), prior, gated30)
  if (typeof long === 'string') throw new Error('Expected regular-session breakout')
  expect(fillOrder(long, regular, 78, 0)).toMatchObject({
    entry: 40.235,
    entrySlot: 8,
    exit: 40.38,
    exitSlot: 77,
    quantity: 310,
  })
  expect(fillOrder(long, regular, 78, 1)).toMatchObject({
    entry: 40.19,
    entrySlot: 9,
    exit: 40.38,
    exitSlot: 77,
    quantity: 310,
  })
  expect(fillOrder(long, regular.with(8, undefined), 78, 0)).toBe(FillGap.Entry)

  const early = xlf(data.days[1])
  const short = planEntry(early, openingRange(early, 15), [], ungated15)
  if (typeof short === 'string') throw new Error('Expected early-close breakout')
  expect(fillOrder(short, early, 42, 0)).toMatchObject({
    side: -1,
    entry: 41.57,
    entrySlot: 5,
    exit: 41.63,
    exitSlot: 41,
    quantity: 300,
  })
  expect(fillOrder(short, early.with(41, undefined), 42, 0)).toBe(FillGap.Exit)
})

test('computes adverse costs and paired metrics from actual endpoint prices', () => {
  const [regular, early] = data.days
  const books = [replayOrb([regular], ungated30)[0].nextOpen, replayOrb([early], ungated15)[0].nextOpen]
  const plan = stationaryBootstrap(2, { draws: 100, meanBlock: 5, seed: 17 })
  const score = scoreBook(books, plan, books)
  expect(score.execution).toMatchObject({
    confirmedRoundTrips: 2,
    longRoundTrips: 1,
    shortRoundTrips: 1,
    activeDays: 2,
  })
  const notional = 310 * (40.235 + 40.38) + 300 * (41.57 + 41.63)
  expect(score.execution.confirmedRawTurnoverUsd).toBeCloseTo(notional, 9)
  expect(score.execution.turnoverCapital).toBeCloseTo(notional / 100_000, 12)
  expect(score.costs.map(({ bp }) => bp)).toEqual([0, 2, 5, 10])
  for (const { bp, netUsd, versusB0 } of score.costs) {
    const slip = bp / 20_000
    const expected = 310 * (40.38 * (1 - slip) - 40.235 * (1 + slip)) + 300 * (41.57 * (1 - slip) - 41.63 * (1 + slip))
    expect(netUsd).toBeCloseTo(expected, 9)
    expect(versusB0).toMatchObject({ correlation: 1, netLiftUsd: 0, netLiftP: null })
  }
  expect(() => scoreBook(books, plan, books.toReversed())).toThrow('Session alignment mismatch')
})

test('unresolved scheduled flatten withholds the complete window and cannot affect an earlier fold fit', () => {
  const [regular, early] = data.days
  const missingExit: Day = { ...early, bars: new Map([[Etf.XLF, xlf(early).with(41, undefined)]]) }
  const missingOpening: Day = { date: '2024-01-02', slots: 78, bars: new Map() }
  const resolved = replayOrb([missingOpening, regular, early], ungated15)
  const unresolved = replayOrb([missingOpening, regular, missingExit], ungated15)
  const plan = stationaryBootstrap(3, { draws: 100, meanBlock: 5, seed: 17 })
  const score = scoreBook(
    unresolved.map((row) => row.nextOpen),
    plan,
  )
  expect(score.execution).toMatchObject({
    confirmedRoundTrips: 1,
    confirmedEntryFills: 2,
    confirmedExitFills: 1,
    turnoverCapital: null,
    unresolvedDays: [{ date: '2024-07-03', missingEntries: 0, missingExits: 1, ambiguousHeldBars: 0 }],
  })
  expect(
    score.costs.every(
      ({ netUsd, positiveMeanP, sharpe }) => netUsd === null && positiveMeanP === null && sharpe === null,
    ),
  ).toBe(true)

  // Give the selector identical observed training ledgers under two eligible labels to exercise its tie-break.
  const paths = [
    { width: 30, gated: true, days: resolved },
    { width: 15, gated: true, days: unresolved },
    { ...ungated15, days: resolved },
  ] as const
  expect(fitWidth(paths, { first: 0, end: 2 }).selectedWidth).toBe(15)
  expect(fitWidth(paths, { first: 0, end: 2 }).training).toHaveLength(2)
  expect(fitWidth(paths, { first: 0, end: 3 }).selectedWidth).toBe(30)
})
