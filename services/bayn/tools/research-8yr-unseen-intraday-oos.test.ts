import { describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'

import {
  admitUniverse,
  compareUniverse,
  gunzipArchive,
  loadTapes,
  readArchiveMetadata,
  replacementBlindSource,
} from './8yr-unseen-intraday-data'
import { baselineNames, blind, listingDates, noiseNames, stocks, universe } from './8yr-unseen-intraday-protocol'
import { createPreparation, exitPath, netAt, replayDay } from './8yr-unseen-intraday-replay'
import { stationaryP, stationaryPlan } from './8yr-unseen-intraday-statistics'
import { Field, makeSeries, price, readTape } from './8yr-unseen-intraday-tape'
import { verifyScorePublication } from './research-8yr-unseen-intraday-oos'

describe('Wave 5A score publication', () => {
  const freeze = '0ade8141ccba92cd20346579676ee2ca04e62a97'
  const binding = 'a'.repeat(64)
  const refs = 'study\trefs/heads/codex/bayn-w4e-8yr-unseen-intraday-oos\nmain\trefs/heads/main\n'
  const reader =
    (ancestors: readonly (readonly string[])[], bindingSha256 = binding) =>
    (command: string, ...args: string[]) => {
      if (command === 'ls-remote') return refs
      if (command === 'merge-base' && ancestors.some(([from, to]) => args[1] === from && args[2] === to)) {
        return ''
      }
      if (command === 'show' && args[0].startsWith('squashed:') && args[0].endsWith('/results.json')) {
        return JSON.stringify({
          schema: 'bayn.research.wave-4e.results.v1',
          freezeSha256: '0fe346561ed3610336a82e812e4f1e4fe873cd60967c1d6af03a0e301f649d33',
          inputs: { blind: { bindingSha256 } },
        })
      }
      throw new Error(`Unpublished evidence: ${command} ${args.join(' ')}`)
    }

  test('requires the original preregistration for the exact study branch tip', () => {
    expect(() => verifyScorePublication('study', binding, reader([[freeze, 'study']]))).not.toThrow()
    expect(() => verifyScorePublication('study', binding, reader([]))).toThrow('Unpublished evidence')
  })

  test('allows a published squash without study ancestry only for the published archive binding', () => {
    const onMain = [['squashed', 'main']]
    expect(() => verifyScorePublication('squashed', binding, reader(onMain))).not.toThrow()
    expect(() => verifyScorePublication('squashed', binding, reader(onMain, 'b'.repeat(64)))).toThrow(
      'archive binding does not match',
    )
    expect(() => verifyScorePublication('squashed', binding, reader([]))).toThrow('Unpublished evidence: merge-base')
  })
})

describe('Wave 4E metadata admission', () => {
  const correctedReceipt = {
    schema: 'bayn.research.wave-4e.blind-archive.v1',
    manifest: 'bayn-research-datasets/corrected/MANIFEST.json',
    manifestSha256: 'a'.repeat(64),
    bars: 'bayn-research-datasets/corrected/bars.tsv.gz',
    calendar: 'bayn-research-datasets/corrected/calendar.json',
    rows: universe.filter((symbol) => (listingDates[symbol] ?? blind.first) <= blind.last).length,
  }

  test('a corrected receipt cannot alter strategy fields or rebind the rejected object in place', () => {
    expect(() => replacementBlindSource({ ...correctedReceipt, calendar: 'other.json' })).toThrow()
    expect(() => replacementBlindSource({ ...correctedReceipt, calendarSha256: 'a'.repeat(64) })).toThrow()
    expect(() => replacementBlindSource({ ...correctedReceipt, bars: blind.bars })).toThrow(
      'distinct manifest and tape',
    )
    expect(() =>
      replacementBlindSource({ ...correctedReceipt, manifest: 'bayn-research-datasets/../unexpected' }),
    ).toThrow()
    expect(() => replacementBlindSource({ ...correctedReceipt, rows: 0 })).toThrow()
  })

  test('corrected metadata binds new bytes but still requires the original dates, calendar and exact roster', async () => {
    const binding = replacementBlindSource(correctedReceipt)
    const symbolRowCounts = Object.fromEntries(
      universe.filter((symbol) => (listingDates[symbol] ?? blind.first) <= blind.last).map((symbol) => [symbol, 1]),
    )
    const manifest = {
      schemaVersion: 'bayn.sip-8yr-unseen-manifest.v2',
      dataset: 'alpaca-sip-8yr-5m-exact62-unseen-2016-2023',
      source: 'Alpaca Market Data API v2 (feed=sip, adjustment=split, timeframe=5Min)',
      matchesWave3BUniverse: true,
      dateRange: { start: blind.first, end: blind.last },
      calendarSessions: blind.sessions,
      symbolCount: universe.length,
      symbols: universe,
      symbolRowCounts,
      totalRows: binding.rows,
      files: {
        bars_5m: { key: binding.bars, bytes: 1, sha256: 'b'.repeat(64) },
        calendar: { key: binding.calendar, bytes: 1, sha256: blind.calendarSha256 },
      },
    }
    const reads: Array<[string, string]> = []
    await rejects(
      readArchiveMetadata((key, sha) => {
        reads.push([key, sha])
        if (key === binding.manifest) return Promise.resolve(manifest)
        return Promise.reject(new Error('Calendar lookup reached'))
      }, binding),
      /Calendar lookup reached/,
    )
    expect(reads).toEqual([
      [binding.manifest, binding.manifestSha256],
      [binding.calendar, blind.calendarSha256],
    ])
    await rejects(
      readArchiveMetadata(() => Promise.resolve({ ...manifest, totalRows: binding.rows + 1 }), binding),
      /does not match the registered archive receipt/,
    )
    await rejects(
      readArchiveMetadata(
        () =>
          Promise.resolve({
            ...manifest,
            files: { ...manifest.files, calendar: { ...manifest.files.calendar, sha256: 'c'.repeat(64) } },
          }),
        binding,
      ),
      /does not match the registered archive receipt/,
    )
  })

  test('rejects an equal-size manifest with an unrelated name replacing a strategy input', () => {
    const substituted = universe.map((symbol) => (symbol === 'INTC' ? 'ADBE' : symbol))
    expect(substituted).toHaveLength(62)
    expect(stocks).toHaveLength(46)
    expect([...baselineNames, ...noiseNames, 'SPY']).toHaveLength(21)
    expect(compareUniverse(substituted)).toEqual({
      missing: ['INTC'],
      unexpected: ['ADBE'],
      duplicates: [],
      listedWithoutRows: [],
    })
    expect(() => admitUniverse('blind', substituted)).toThrow('missing=[INTC]; unexpected=[ADBE]')
  })

  test('distinguishes missing rows for a listed name from a genuine post-window first listing', () => {
    const coverage = Object.fromEntries(universe.map((symbol) => [symbol, 1]))
    delete coverage['SNDK']
    delete coverage['GEV']
    delete coverage['ALAB']
    expect(() => admitUniverse('blind', universe, coverage)).not.toThrow()
    delete coverage['ARM']
    expect(() => admitUniverse('blind', universe, coverage)).toThrow('listedWithoutRows=[ARM]')
  })

  test('rejects duplicate members independently of a set match', () => {
    expect(() => admitUniverse('blind', [...universe, 'SPY'])).toThrow('duplicates=[SPY]')
  })

  test('reads only a bound gzip member but authenticates every byte of the object', async () => {
    const payload = 'example tape\n'
    const member = Bun.gzipSync(new TextEncoder().encode(payload))
    const bytes = new Uint8Array(member.length + 8)
    bytes.set(member)
    bytes.fill(0xff, member.length)
    const receipt = { key: 'fixture', bytes: bytes.length, sha256: Bun.CryptoHasher.hash('sha256', bytes, 'hex') }
    const read = (boundary?: number) =>
      new Response(gunzipArchive(new Blob([bytes]).stream(), receipt, boundary)).text()
    expect(await read(member.length)).toBe(payload)
    await rejects(read())
    bytes[bytes.length - 1] = 0xfe
    await rejects(read(member.length), /Byte receipt mismatch: fixture/)
  })

  test('rejects the mismatch without even requesting the calendar or any bar object', async () => {
    const objects: string[] = []
    const symbols = universe.map((symbol) => (symbol === 'INTC' ? 'ADBE' : symbol))
    const metadata = {
      dataset: 'alpaca-sip-8yr-5m-unseen-2016-2023',
      source: 'Alpaca Data API v2 (feed=sip, adjustment=split, timeframe=5Min)',
      dateRange: { start: blind.first, end: blind.last },
      calendarSessions: blind.sessions,
      symbolCount: 62,
      symbols,
      symbolRowCounts: { AAPL: blind.rows },
      totalRows: blind.rows,
      files: {
        bars_5m: { key: blind.bars, bytes: 1, sha256: 'a'.repeat(64) },
        calendar: { key: blind.calendar, bytes: 1, sha256: blind.calendarSha256 },
      },
    }
    await rejects(
      loadTapes(
        (key) => {
          objects.push(key)
          return Promise.resolve(metadata)
        },
        (key) => {
          objects.push(key)
          return Promise.reject(new Error('Attempted to open a bar object'))
        },
      ),
      /missing=\[INTC\]; unexpected=\[ADBE\]/,
    )
    expect(objects).toEqual([blind.manifest])
  })
})

describe('Frozen replay on synthetic fixtures', () => {
  const session = (date: string, open: string, minutes = 390) => ({
    date,
    openMs: Date.parse(`${date}T${open}:00Z`),
    minutes,
  })
  const fillBar = (series: Float64Array, slot: number, bar = [100, 101, 99, 100, 200, 100]) => series.set(bar, slot * 6)
  const allBars = (slots: number) => {
    const series = makeSeries(slots)
    for (let slot = 0; slot < slots; slot++) fillBar(series, slot)
    return series
  }
  test('admission uses UTC bounds for each calendar session and excludes the short-day close itself', async () => {
    const bar = (date: string, time: string) => `AAPL\t${date}T${time}:00Z\t100\t102\t99\t101\t500\t5\t100`
    const tape = await readTape(
      [session('2023-11-03', '13:30'), session('2023-11-24', '14:30', 210)],
      [
        'symbol\tt\to\th\tl\tc\tv\tn\tvw',
        bar('2023-11-03', '13:25'),
        bar('2023-11-03', '13:30'),
        bar('2023-11-24', '14:30'),
        bar('2023-11-24', '17:55'),
        bar('2023-11-24', '18:00'),
      ],
      'blind',
      5,
    )
    expect(tape.coverage).toEqual({ rows: 5, outsideRth: 2, outsideListing: 0, regular: 3 })
    expect(tape.days[1].slots).toBe(42)
    const short = tape.days[1].bars.get('AAPL')
    if (short === undefined) throw new Error('Expected short-day bars')
    expect(price(short, 41, Field.Open)).toBe(100)
    expect(price(short, 1, Field.Open)).toBe(0)
  })

  test('fourteen consecutive complete sessions are required, excluding the current session and pre-listing bars', () => {
    const prepare = createPreparation()
    const bars = new Map([['ARM', allBars(78)]])
    expect(prepare({ date: '2023-09-13', slots: 78, bars }).activeStocks).toEqual([])
    for (let i = 14; i < 28; i++) {
      expect(prepare({ date: `2023-09-${i}`, slots: 78, bars }).activeStocks).toEqual([])
    }
    expect(prepare({ date: '2023-09-28', slots: 78, bars }).activeStocks).toEqual(['ARM'])
    expect(prepare({ date: '2023-09-29', slots: 78, bars: new Map() }).activeStocks).toEqual([])
    expect(prepare({ date: '2023-10-02', slots: 78, bars }).activeStocks).toEqual([])
  })

  test('a completed bracket touch exits at the next open, not the stop, target or signal close', () => {
    const series = allBars(5)
    fillBar(series, 1, [100, 120, 80, 103, 200, 100])
    fillBar(series, 2, [92, 99, 91, 97, 200, 95])
    expect(exitPath(series, 1, 1, 4, { stop: 95, target: 108 })).toEqual({ exit: 92, exitSlot: 2, heldGaps: 0 })
    fillBar(series, 2, [0, 0, 0, 0, 0, 0])
    expect(exitPath(series, 1, 1, 4, { stop: 95, target: 108 })).toEqual({
      exit: null,
      exitSlot: Infinity,
      heldGaps: 1,
    })
  })

  test('OR5 uses actual next-open prices, fee-adjusted slippage and the two registered close clocks', () => {
    for (const [slots, exitSlot] of [
      [78, 23],
      [42, 37],
    ]) {
      const prepare = createPreparation()
      for (let i = 1; i <= 14; i++) {
        prepare({ date: `2023-02-${String(i).padStart(2, '0')}`, slots: 78, bars: new Map([['AAPL', allBars(78)]]) })
      }
      const series = allBars(slots)
      for (let i = 0; i < slots; i++) fillBar(series, i, [104, 106, 103, 105, 200, 104])
      fillBar(series, 0, [103, 105, 102, 104, 501, 104])
      fillBar(series, exitSlot, [107, 108, 102, 102, 200, 105])
      const prepared = prepare({ date: '2023-02-15', slots, bars: new Map([['AAPL', series]]) })
      const result = replayDay(prepared, 'C2')
      const qty = 333
      expect(result.trades).toBe(1)
      expect(result.unresolved).toBe(0)
      expect(result.peakGross).toBeCloseTo(qty * 104 * 1.0005)
      expect(netAt(result, 5)).toBeCloseTo(
        qty * (107 * (1 - 5 / 20_000) * (1 - 0.21 / 10_000) - 104 * (1 + 5 / 20_000)),
      )
    }
  })

  test('stationary resampling has geometric blocks that preserve every draw length and is deterministic', () => {
    const plan = stationaryPlan(12, 24)
    for (let draw = 0; draw < plan.draws; draw++) {
      const blocks = plan.blocks.slice(plan.offsets[draw], plan.offsets[draw + 1])
      expect(blocks.reduce((total, block) => total + (block & 0xffff), 0)).toBe(12)
    }
    expect(new Set(plan.blocks.map((block) => block & 0xffff)).size).toBeGreaterThan(1)
    expect(stationaryPlan(12, 24)).toEqual(plan)
    expect(
      stationaryP(
        Array.from({ length: 12 }, (_, i) => 10 + i),
        plan,
      ),
    ).toBe(1 / 25)
  })
  test('the two-engine book reranks around a still-held OR5 name and preserves an atomic reversion basket', () => {
    const prepare = createPreparation()
    const names = ['AAPL', 'AMD', 'AMZN', 'GOOGL', 'META', 'NVDA', 'SPY']
    for (let i = 1; i <= 14; i++) {
      prepare({
        date: `2023-11-${String(i).padStart(2, '0')}`,
        slots: 78,
        bars: new Map(names.map((symbol) => [symbol, allBars(78)])),
      })
    }
    const short = new Map(names.map((symbol) => [symbol, allBars(42)]))
    const aapl = short.get('AAPL')
    const nvda = short.get('NVDA')
    if (aapl === undefined || nvda === undefined) throw new Error('Expected test bars')
    for (let i = 0; i < 42; i++) fillBar(aapl, i, [104, 106, 103, 104, 200, 106])
    fillBar(aapl, 0, [104, 105, 102, 104.5, 800, 104])
    const scores: Readonly<Record<string, number>> = { AMD: 98.5, AMZN: 99, GOOGL: 101, META: 101.5, NVDA: 102 }
    for (const [symbol, series] of short) {
      const close = scores[symbol]
      if (close !== undefined) fillBar(series, 29, [100, Math.max(100, close), Math.min(100, close), close, 200, 100])
    }
    const prepared = prepare({ date: '2023-11-24', slots: 42, bars: short })
    const single = replayDay(prepared, 'C4_timed')
    const combined = replayDay(prepared, 'C6')
    expect([...single.symbols.keys()]).toEqual(['AAPL', 'AMD', 'NVDA', 'META'])
    expect([...combined.symbols.keys()]).toEqual(['AAPL', 'AMD', 'AMZN', 'NVDA', 'META'])
    expect(combined.trades).toBe(5)
    expect(combined.peakGross).toBeLessThanOrEqual(180_000)
    fillBar(nvda, 30, [0, 0, 0, 0, 0, 0])
    expect(replayDay(prepared, 'C6')).toMatchObject({ trades: 1, missingEntries: 1 })
  })

  test('Noise responds only at the 30-minute checkpoints and exits the opposite signal at the next open', () => {
    const prepare = createPreparation()
    const prior = allBars(78)
    fillBar(prior, 5, [100, 101, 99, 101, 200, 100])
    fillBar(prior, 11, [100, 101, 99, 99, 200, 100])
    for (let i = 1; i <= 14; i++) {
      prepare({ date: `2023-02-${String(i).padStart(2, '0')}`, slots: 78, bars: new Map([['QQQ', prior]]) })
    }
    const today = allBars(78)
    fillBar(today, 4, [100, 110, 100, 109, 200, 100])
    fillBar(today, 5, [100, 103, 100, 102, 200, 100])
    fillBar(today, 6, [104, 104, 102, 103, 200, 103])
    fillBar(today, 11, [100, 100, 98, 98, 200, 99])
    fillBar(today, 12, [96, 99, 96, 98, 200, 97])
    const result = replayDay(prepare({ date: '2023-02-15', slots: 78, bars: new Map([['QQQ', today]]) }), 'C5')
    expect(result.trades).toBe(1)
    expect(result.base).toBeCloseTo(375 * (96 - 104 - (96 * 0.21) / 10_000))
  })
})
