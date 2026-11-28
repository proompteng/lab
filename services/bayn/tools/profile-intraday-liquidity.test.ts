import { expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { inspect } from 'node:util'

import { sha256 } from '../src/hash'
import { BarInterval, createTapeProfiler, rankEtfs, rthBuckets } from './profile-intraday-liquidity-core'
import { profileSipArchive, readTapeProfile } from './profile-intraday-liquidity'
import { normalizeResearchCalendar, type Session } from './research-lib/calendar'
import { type ArchiveReader, readGzipLines, S3ArchiveError } from './research-lib/s3-archive'

const sessions = (dates: readonly string[], earlyClose?: string) =>
  normalizeResearchCalendar({
    query: { start: dates[0], end: dates.at(-1) },
    response: dates.map((date) => ({ date, open: '09:30', close: date === earlyClose ? '13:00' : '16:00' })),
  })
const bar = (
  symbol: string,
  session: Session,
  minute: number,
  values: readonly number[] = [100, 100, 100, 100, 100, 100],
) => [symbol, new Date(session.openMs + minute * 60_000).toISOString().replace('.000Z', 'Z'), ...values].join('\t')
const flat = (price: number, shares = 100) => [price, price, price, price, shares, price]
const fullSession = (symbol: string, session: Session, price: number) =>
  Array.from({ length: session.minutes / 5 }, (_, i) => bar(symbol, session, i * 5, flat(price)))
const winter = sessions(['2024-03-08'])[0]

test('computes dollar-volume sums, native-bar range volatility and contiguous Amihud with explicit denominators', () => {
  const profiler = createTapeProfiler([winter], ['SPY'], BarInterval.FiveMinutes)
  ;[
    bar('SPY', winter, 0, [100, 110, 90, 105, 100, 101]),
    bar('SPY', winter, 5, [105, 120, 100, 110, 200, 109]),
    ...[10, 15, 20, 25].map((minute) => bar('SPY', winter, minute, flat(110))),
    bar('SPY', winter, 30, flat(121)),
    bar('SPY', winter, 40, flat(130)),
  ].forEach(profiler.add)

  const { daily, buckets } = profiler.finish().symbols[0]
  expect(daily).toMatchObject({ expectedBars: 78, observedBars: 8, medianDollarVolumeUsd: null, amihudPairs: 6 })
  expect(buckets[0]).toMatchObject({
    expectedBars: 6,
    observedBars: 6,
    completeSessions: 1,
    medianDollarVolumeUsd: 75_900,
    amihudPairs: 5,
  })
  expect(buckets[0].garmanKlassBarVolatilityBps).toBeCloseTo(763.7559469624977, 9)
  expect(buckets[0].parkinsonBarVolatilityBps).toBeCloseTo(664.7441129719344, 9)
  expect(buckets[0].amihudBpsPerMillionUsd).toBeCloseTo(4368.719965050245, 8)
  expect(buckets[1]).toMatchObject({
    observedBars: 2,
    completeSessions: 0,
    medianDollarVolumeUsd: null,
    amihudPairs: 1,
  })
  expect(buckets[1].amihudBpsPerMillionUsd).toBeCloseTo(82644.62809917363, 7)
  expect(buckets[2]).toMatchObject({
    observedBars: 0,
    garmanKlassBarVolatilityBps: null,
    parkinsonBarVolatilityBps: null,
    amihudBpsPerMillionUsd: null,
  })
})

test('uses Eastern windows through DST and stops at the early close without inserting empty afternoon buckets', () => {
  const calendar = sessions(['2024-03-08', '2024-03-11', '2024-11-29'], '2024-11-29')
  expect(calendar.map(({ openMs }) => new Date(openMs).toISOString().slice(11, 16))).toEqual([
    '14:30',
    '13:30',
    '14:30',
  ])
  const profiler = createTapeProfiler(calendar, ['SPY'], BarInterval.FiveMinutes)
  ;[
    bar('SPY', calendar[0], -5),
    ...fullSession('SPY', calendar[0], 100),
    ...fullSession('SPY', calendar[1], 110),
    ...fullSession('SPY', calendar[2], 99),
    bar('SPY', calendar[2], 210),
  ].forEach(profiler.add)
  const { rowCoverage, symbols } = profiler.finish()
  expect(rowCoverage).toEqual({ regular: 198, outsideRth: 2, beforeListing: 0 })
  const { daily, buckets, gapAtOpen } = symbols[0]
  expect(daily).toMatchObject({ expectedSessions: 3, completeSessions: 3, medianDollarVolumeUsd: 780_000 })
  expect(buckets[0]).toMatchObject({ expectedSessions: 3, completeSessions: 3, medianDollarVolumeUsd: 60_000 })
  expect(rthBuckets[7]).toEqual({ startEt: '13:00', endEt: '13:30' })
  expect(buckets[7]).toMatchObject({ expectedSessions: 2, completeSessions: 2, medianDollarVolumeUsd: 63_000 })
  expect(gapAtOpen.sessions).toBe(2)
  expect(gapAtOpen.p05Bps).toBeCloseTo(-900, 9)
  expect(gapAtOpen.medianBps).toBeCloseTo(0, 9)
  expect(gapAtOpen.p95Bps).toBeCloseTo(900, 9)
  expect(gapAtOpen.p95AbsoluteBps).toBeCloseTo(1000, 9)
})

test('requires the exact previous close and current open on adjacent registered sessions for a gap', () => {
  const calendar = sessions(['2024-03-04', '2024-03-05', '2024-03-06', '2024-03-07', '2024-03-08', '2024-03-11'])
  const profiler = createTapeProfiler(calendar, ['SPY'], BarInterval.FiveMinutes)
  ;[
    bar('SPY', calendar[0], 380),
    bar('SPY', calendar[1], 0),
    bar('SPY', calendar[1], 385),
    bar('SPY', calendar[2], 5),
    bar('SPY', calendar[2], 385),
    bar('SPY', calendar[4], 0),
    bar('SPY', calendar[4], 385),
    bar('SPY', calendar[5], 0, flat(101)),
  ].forEach(profiler.add)
  const { daily, gapAtOpen } = profiler.finish().symbols[0]
  expect(daily).toMatchObject({ expectedSessions: 6, completeSessions: 0, observedBars: 8, amihudPairs: 0 })
  expect(gapAtOpen.sessions).toBe(1)
  expect(gapAtOpen.medianBps).toBeCloseTo(100, 9)
})

test('excludes pre-regular-way SNDK bars from both coverage and the opening-gap baseline', () => {
  const calendar = sessions(['2025-02-21', '2025-02-24'])
  const profiler = createTapeProfiler(calendar, ['SNDK'], BarInterval.FiveMinutes)
  ;[bar('SNDK', calendar[0], 385), bar('SNDK', calendar[1], 0, flat(50))].forEach(profiler.add)
  const { rowCoverage, symbols } = profiler.finish()
  expect(rowCoverage).toEqual({ regular: 1, outsideRth: 0, beforeListing: 1 })
  expect(symbols[0]).toMatchObject({
    firstRthSession: '2025-02-24',
    daily: { expectedSessions: 1, observedBars: 1 },
    gapAtOpen: { sessions: 0, medianBps: null },
  })
})

test('ranks only ETFs and ranks their own 30-minute windows independently on 1m bars', () => {
  const profiler = createTapeProfiler([winter], ['AAA', 'BBB', 'CCC', 'STOCK'], BarInterval.OneMinute)
  let index = 0
  for (let minute = 0; minute < winter.minutes; minute++) {
    profiler.add(bar('AAA', winter, minute, flat(minute % 2 === 0 ? 100 : 120, minute >= 360 ? 1000 : 900)), index++)
    profiler.add(bar('BBB', winter, minute, flat(100, 10)), index++)
    profiler.add(bar('CCC', winter, minute, flat(minute % 2 === 0 ? 100 : 100.1)), index++)
    profiler.add(bar('STOCK', winter, minute, flat(100, 10_000)), index++)
  }
  const { symbols } = profiler.finish()
  expect(symbols[0].buckets[0]).toMatchObject({ observedBars: 30, expectedBars: 30, amihudPairs: 29 })
  const ranked = rankEtfs(symbols, new Set(['AAA', 'BBB', 'CCC']))
  expect(
    ranked.map(({ symbol, tier, dollarVolumeRank, amihudRank }) => [symbol, tier, dollarVolumeRank, amihudRank]),
  ).toEqual([
    ['AAA', 'DEEPER', 1, 3],
    ['CCC', 'MIDDLE', 2, 2],
    ['BBB', 'THINNER', 3, 1],
  ])
  expect(ranked[0].windows[0]).toMatchObject({ startEt: '15:30', dollarVolumeRank: 1 })
  expect(ranked[2].windows.map(({ startEt }) => startEt)).toEqual(rthBuckets.map(({ startEt }) => startEt))
})

test('fails closed on bad TSV, mismatched OHLC, off-grid clock, unknown identity, or non-increasing symbol time', () => {
  const next = bar('SPY', winter, 5)
  for (const [line, error] of [
    [next + '\t100', 'Invalid SIP TSV'],
    [next.replace('\t100', '\tNaN'), 'Invalid SIP TSV'],
    [bar('SPY', winter, 5, [100, 95, 90, 100, 1, 100]), 'Inconsistent SIP OHLC'],
    [bar('SPY', winter, 6), 'Invalid, duplicate or unordered SIP timestamp'],
    [bar('SPY', winter, 0), 'Invalid, duplicate or unordered SIP timestamp'],
    [bar('SPY', winter, -5), 'Invalid, duplicate or unordered SIP timestamp'],
    [bar('QQQ', winter, 5), 'Unregistered SIP symbol or session'],
    [next.replace(winter.date, '2024-03-09'), 'Unregistered SIP symbol or session'],
  ]) {
    const profiler = createTapeProfiler([winter], ['SPY'], BarInterval.FiveMinutes)
    profiler.add(bar('SPY', winter, 0), 0)
    expect(() => profiler.add(line, 1)).toThrow(error + ' at row 2')
  }
  expect(() => createTapeProfiler([winter], ['SPY'], BarInterval.FiveMinutes).finish()).toThrow('No admitted RTH bars')
})

test('returns no tape profile before compressed and decoded receipts and row counts verify', async () => {
  const raw = new TextEncoder().encode(fullSession('SPY', winter, 100).join('\n'))
  const compressed = Bun.gzipSync(raw)
  const tape = {
    key: 'fixture.tsv.gz',
    rows: 78,
    gzipBytes: compressed.length,
    gzipSha256: sha256(compressed),
    rawBytes: raw.length,
    rawSha256: sha256(raw),
  }
  const archive: ArchiveReader = {
    readJson: () => Promise.reject(new Error('Tape reads must not open metadata')),
    readGzip: (receipt, consume) =>
      readGzipLines(
        new ReadableStream({
          start(controller) {
            controller.enqueue(compressed)
            controller.close()
          },
        }),
        receipt,
        new AbortController().signal,
        consume,
      ),
  }
  const profile = (descriptor: typeof tape) =>
    readTapeProfile(archive, [winter], BarInterval.FiveMinutes, ['SPY'], descriptor)
  expect((await profile(tape)).symbols[0].daily.medianDollarVolumeUsd).toBe(780_000)
  await rejects(profile({ ...tape, gzipSha256: 'a'.repeat(64) }), /Compressed byte receipt mismatch/)
  await rejects(profile({ ...tape, rawSha256: 'b'.repeat(64) }), /Decoded byte receipt mismatch/)
  await rejects(profile({ ...tape, rows: 77 }), /SIP row count mismatch/)
})

test('interrupting an unfinished tape rejects the profile and cancels its input once', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  let cancellations = 0
  const archive: ArchiveReader = {
    readJson: () => Promise.reject(new Error('Tape reads must not open metadata')),
    readGzip: (receipt, consume) =>
      readGzipLines(
        new ReadableStream({
          start: () => started.resolve(),
          cancel: () => {
            cancellations++
          },
        }),
        receipt,
        controller.signal,
        consume,
      ),
  }
  const tape = {
    key: 'fixture.tsv.gz',
    rows: 1,
    gzipBytes: 32,
    gzipSha256: '0'.repeat(64),
    rawBytes: 32,
    rawSha256: '0'.repeat(64),
  }
  const profile = readTapeProfile(archive, [winter], BarInterval.FiveMinutes, ['SPY'], tape)
  await started.promise
  controller.abort()
  await rejects(profile, { name: 'AbortError' })
  expect(cancellations).toBe(1)
})

test('manifest schema failures retain a redacted cause and open no calendar or bars', async () => {
  const keys: string[] = []
  const sensitive = 'untrusted-manifest-value'
  const archive: ArchiveReader = {
    readJson: async (key) => {
      keys.push(key)
      return { schemaVersion: sensitive }
    },
    readGzip: (receipt) => {
      keys.push(receipt.key)
      return Promise.reject(new Error('Unexpected gzip read'))
    },
  }
  await rejects(profileSipArchive(archive), (error: unknown) => {
    expect(error).toBeInstanceOf(S3ArchiveError)
    expect(error).toHaveProperty('cause')
    expect(inspect(error)).not.toContain(sensitive)
    expect(JSON.stringify(error)).not.toContain(sensitive)
    return true
  })
  expect(keys).toEqual(['bayn-research-datasets/2026-11-27-sip-multiyear/MANIFEST.json'])
})
