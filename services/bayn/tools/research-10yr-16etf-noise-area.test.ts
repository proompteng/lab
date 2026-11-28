import { expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { gzipSync } from 'node:zlib'

import { readTape, unpack } from './noise-area-study-data'
import {
  baskets,
  checkpoints,
  createReplay,
  grid,
  legacy,
  netAt,
  prepare,
  symbols,
  type Bar,
  type Day,
  type Trial,
} from './noise-area-study-replay'
import { correlation, stationaryBootstrap, summarize } from './noise-area-study-statistics'
import { afterFreeze, choose, commonMask } from './research-10yr-16etf-noise-area'
import { sha256 } from './research-orb-zab-data'

const first = grid.find(
  ({ basket, band, minutes, exit, sizing }) =>
    basket === 'B0' && band === 1.2 && minutes === 30 && exit === 'opposite_band' && sizing === 'equal_weight',
)
if (first === undefined) throw new Error('Missing B0 fixture')

const bar = (open = 100, close = open, vwap = (open + close) / 2): Bar => ({
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  volume: 100,
  vwap,
})

const series = (slots = 78) => Array.from<Bar | undefined>({ length: slots }).fill(bar())
const prior = (halfDayIndex = -1): Day[] =>
  Array.from({ length: 14 }, (_, i) => {
    const slots = i === halfDayIndex ? 42 : 78
    const qqq = series(slots)
    const smh = series(slots)
    for (let slot = 5; slot < slots - 1; slot += 3) qqq[slot] = smh[slot] = bar(100, 101)
    qqq[slots - 1] = bar(100, 100 + (i % 2 === 0 ? 1 : -1))
    smh[slots - 1] = bar(100, 100 + (i % 2 === 0 ? 4 : -4))
    return {
      date: `history-${i}`,
      slots,
      bars: new Map([
        ['QQQ', qqq],
        ['SMH', smh],
      ]),
    }
  })

const forDay = (today: Day, history = prior()) => {
  const last = [...prepare([...history, today])].at(-1)
  if (last === undefined) throw new Error('Expected one replay day')
  return createReplay(last)
}

const lastDay = (qqq: readonly (Bar | undefined)[], smh = series(qqq.length)): Day => ({
  date: 'today',
  slots: qqq.length,
  bars: new Map([
    ['QQQ', qqq],
    ['SMH', smh],
  ]),
})

const long = (slots = 78) => {
  const bars = series(slots)
  bars[5] = bar(100, 104)
  bars[6] = bar(105)
  bars[slots - 3] = bar(110)
  return bars
}

test('registers the balanced 90-grid fraction plus the single historical control', () => {
  expect(new Set(grid.map(({ id }) => id)).size).toBe(90)
  for (const [basket, members] of Object.entries(baskets)) {
    const all = grid.filter((spec) => spec.basket === basket)
    expect(all).toHaveLength(18)
    expect(new Set(all.map(({ exit }) => exit)).size).toBe(3)
    expect(new Set(members).size).toBe(members.length)
    expect(all.filter(({ minutes }) => minutes === 15)).toHaveLength(6)
  }
  expect(symbols).toHaveLength(16)
  expect(legacy.legacy).toBeTrue()
})

test('official regular and shortened calendars clamp checkpoints and flatten at the exact next open', () => {
  expect(checkpoints(78, 30)).toEqual([5, 11, 17, 23, 29, 35, 41, 47, 53, 59, 65])
  expect(checkpoints(42, 30).at(-1)).toBe(35)
  expect(checkpoints(42, 15).at(-1)).toBe(35)
  const bars = long(42)
  const result = forDay(lastDay(bars))(first, ['QQQ'])
  const shares = Math.floor(100_000 / (105 * 1.0005))
  expect(result.trades).toBe(1)
  expect(result.base).toBeCloseTo(shares * (110 - 105 - 110 * 0.000021), 7)
  expect(result.grossUpperBound).toBeLessThan(180_000)
  const ten = shares * (110 * 0.9995 * (1 - 0.000021) - 105 * 1.0005)
  expect(netAt(result, 10)).toBeCloseTo(ten, 7)
})

test('a half-day cannot supply a future clock or suppress an otherwise available modern late band', () => {
  const qqq = series()
  qqq[65] = bar(100, 105)
  qqq[66] = bar(106)
  qqq[75] = bar(110)
  const shorter = prior(1)
  const extra = prior()[0]
  const replay = forDay(lastDay(qqq), [extra, ...shorter])
  expect(replay(first, ['QQQ']).trades).toBe(1)
  expect(replay(legacy, ['QQQ']).trades).toBe(0)
  expect(forDay(lastDay(qqq), shorter)(first, ['QQQ']).trades).toBe(0)
})

test('causal opposite-band, VWAP and ATR signals settle at the next actual open, not stop level', () => {
  const qqq = long()
  qqq[7] = bar(105, 80)
  qqq[8] = bar(82)
  qqq[11] = bar(100, 96)
  qqq[12] = bar(88)
  const replay = forDay(lastDay(qqq))
  const shares = Math.floor(100_000 / (105 * 1.0005))
  for (const [exit, price] of [
    ['opposite_band', 88],
    ['vwap_or_opposite', 88],
    ['band_with_1.5xATR_stop', 82],
  ] as const)
    expect(replay({ ...first, exit }, ['QQQ']).base).toBeCloseTo(shares * (price - 105 - price * 0.000021), 7)
  qqq[11] = bar(100, 98)
  const noOpposite = forDay(lastDay(qqq))
  expect(noOpposite(first, ['QQQ']).base).toBeGreaterThan(0)
  expect(noOpposite({ ...first, exit: 'vwap_or_opposite' }, ['QQQ']).base).toBeLessThan(0)
})

test('inverse-vol sizing uses only lagged risk, never reallocates on a missing order, and reruns omission weights', () => {
  const bars = long()
  const replay = forDay(lastDay(bars))
  const parity = { ...first, sizing: 'inverse_vol_parity' } satisfies Trial
  const equal = replay(first)
  const inverse = replay(parity)
  const standalone = replay(parity, ['QQQ'])
  expect(equal.trades).toBe(1)
  expect(inverse.base).toBeGreaterThan(equal.base)
  expect(standalone.base).toBeGreaterThan(inverse.base)
  expect(inverse.base / standalone.base).toBeCloseTo(0.8, 2)
  bars[6] = undefined
  expect(forDay(lastDay(bars))(parity)).toMatchObject({ trades: 0, missingEntries: 1, unresolved: 0 })
})

test('missing exit cannot become a successful flatten; an earlier pending exit can find a later RTH open', () => {
  const bars = long()
  bars[75] = bars[76] = bars[77] = undefined
  const unresolved = forDay(lastDay(bars))(first, ['QQQ'])
  expect(unresolved.unresolved).toBe(1)
  expect(netAt(unresolved, 5)).toBeNull()
  expect(summarize([unresolved], 5, 0)).toMatchObject({
    activeDays: 1,
    netUsd: null,
    bootstrapP: null,
    maxDrawdownUsd: null,
  })
  bars[76] = bar(108)
  expect(forDay(lastDay(bars))(first, ['QQQ'])).toMatchObject({ trades: 1, missingHeld: 1, unresolved: 0 })
  bars[11] = bar(100, 96)
  bars[12] = undefined
  bars[13] = bar(92)
  const recovered = forDay(lastDay(bars))(first, ['QQQ'])
  expect(recovered).toMatchObject({ unresolved: 0, trades: 1, missingHeld: 1 })
  expect(recovered.base).toBeLessThan(0)
})

test('short-side fee uses the short sale on entry', () => {
  const bars = long()
  bars[5] = bar(100, 96)
  bars[6] = bar(94)
  bars[75] = bar(90)
  const replay = forDay(lastDay(bars))(first, ['QQQ'])
  const shares = Math.floor(100_000 / 96)
  expect(netAt(replay, 3)).toBeCloseTo(shares * (94 * 0.99985 * (1 - 0.000021) - 90 * 1.00015), 7)
})

test('freeze uses Train finalists only, and mismatched receipt never opens Holdout', async () => {
  const score = (sharpeDaily: number) => ({ sharpeDaily, netUsd: 1, unresolved: 0 })
  const rankings = [5, 4, 3, 2].map((train, index) => ({
    spec: grid[index],
    train: score(train),
    validation: score([1, 2, 3, 100][index]),
  }))
  expect(choose(rankings).selected.id).toBe(grid[2].id)
  let opened = 0
  const open = async () => ++opened
  await rejects(afterFreeze({ hash: 'new' }, '{"hash":"old"}', open), /Published freeze differs/)
  expect(opened).toBe(0)
  expect(await afterFreeze({ hash: 'old' }, '{"hash":"old"}', open)).toBe(1)
})

test('validates checksummed gzip framing, including trailing bytes, without dropping rows', async () => {
  const body = 'first\nlast\n'
  const gzip = gzipSync(body)
  const bytes = Buffer.concat([gzip, Buffer.from('suffix')])
  const read = (object: Buffer, sha: string) =>
    new Response(
      unpack(
        new Response(new Uint8Array(object)).body ?? new ReadableStream<Uint8Array<ArrayBuffer>>(),
        { key: 'fixture', bytes: object.length, sha256: sha },
        gzip.length,
      ),
    ).text()
  expect(await read(bytes, sha256(bytes))).toBe(body)
  bytes[bytes.length - 1] ^= 1
  await rejects(read(bytes, sha256(Buffer.concat([gzip, Buffer.from('suffix')]))), /Byte receipt mismatch/)
})

test('preserves all physical rows while rejecting bad session bars and reporting gaps', async () => {
  const roster = [...symbols, ...Array.from({ length: 46 }, (_, i) => `X${i}`)]
  const lines = [
    ...symbols.map((ticker) => `${ticker}\t2024-01-02T14:30:00Z\t100\t101\t99\t100\t100\t100`),
    'QQQ\t2024-01-02T21:00:00Z\t100\t101\t99\t100\t100\t100',
  ]
  const calendar = [{ date: '2024-01-02', minutes: 390, openMs: Date.parse('2024-01-02T14:30:00Z') }]
  const tape = await readTape(lines, calendar, roster, 17)
  expect(tape.coverage).toMatchObject({
    physical: 17,
    outsideRth: 1,
    counts: { QQQ: { rthBars: 1, missingRthBars: 77, missingFlatOpen: 1 } },
  })
  await rejects(readTape([...lines, lines[0]], calendar, roster, 18), /unordered/)
  await rejects(readTape(lines, calendar, roster, 16), /row receipt mismatch/)
  const counts = Object.fromEntries(
    roster.map((symbol) => [symbol, symbol === 'QQQ' ? 2 : symbols.some((name) => name === symbol) ? 1 : 0]),
  )
  const development = ['symbol\tt\to\th\tl\tc\tv\tn\tvw', ...lines.map((line) => line.replace(/\t100$/, '\t1\t100'))]
  expect((await readTape(development, calendar, roster, 17, counts)).coverage).toEqual(tape.coverage)
  await rejects(readTape(lines, calendar, roster, 17, counts), /Missing development SIP header/)
})

test('cost, carry, pairing and deterministic stationary bootstrap are separate', () => {
  const rows = [10, -3, 1].map((base) => ({
    base,
    slope: 1,
    trades: 1,
    missingEntries: 0,
    missingHeld: 0,
    unresolved: 0,
    grossUpperBound: 1,
  }))
  expect(commonMask([rows, [rows[0], { ...rows[1], unresolved: 1 }, rows[2]]], 3)).toEqual([true, false, true])
  expect(summarize(rows, 1, 0)).toMatchObject({ netUsd: 5, maxDrawdownUsd: 4, exTop5Usd: -4 })
  expect(summarize(rows, 1, 0).breakevenRtBps).toBeCloseTo(8 / 3, 10)
  expect(summarize(rows, 1, null, [0, 5, 0])).toMatchObject({ netUsd: 10, carryUsd: 5, maxDrawdownUsd: 0, dsr: null })
  const bootstrap = stationaryBootstrap(3, 200)
  expect(bootstrap([2, 3, 4])).toBe(1 / 201)
  expect(bootstrap([-3, -3, -3])).toBe(1)
  expect(bootstrap([2, 3, -4])).toBe(stationaryBootstrap(3, 200)([2, 3, -4]))
  expect(correlation([1, null, 2], [-1, 0, -2])).toEqual({ sessions: 2, r: -1 })
})
