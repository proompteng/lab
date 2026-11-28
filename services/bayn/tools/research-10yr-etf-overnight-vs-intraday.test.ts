import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { expect, test } from 'bun:test'

import { createReplay, netAt, prepare, type Bar, type Day } from './noise-area-study-replay'
import { stationaryBootstrap } from './noise-area-study-statistics'
import { decomposition, summarize } from './overnight-etf-statistics'
import {
  afterFreeze,
  b0,
  books,
  gateAtClose,
  replayBook,
  settleNoise,
  verifyPublished,
} from './research-10yr-etf-overnight-vs-intraday'
import { assets, hash, universe, type Session, type Symbol } from './vol-regime-carry-data'

const session = (date: string, prices: Partial<Record<Symbol, readonly [number, number]>> = {}): Session => ({
  date,
  bars: universe.map((symbol) => {
    const [open, close] = prices[symbol] ?? [100, 100]
    return { open, close }
  }),
})

const emptyTape = (frames: readonly Session[]) => frames.map(({ date }) => ({ date, slots: 78, bySymbol: new Map() }))

test('MOC decision excludes the close of the session on which it fills', () => {
  const frames = Array.from({ length: 202 }, (_, i) => session(String(i), { SPY: [100, 100 + i], HYG: [100, 100 + i] }))
  const shock = frames.with(200, session('200', { SPY: [100, 1], HYG: [100, 1] }))
  const baseline = gateAtClose(frames)
  const shocked = gateAtClose(shock)
  expect(baseline[199][assets.SHY]).toBe(1)
  expect(baseline[200][assets.SMH]).toBe(1 / 3)
  expect(shocked[200]).toEqual(baseline[200])
  expect(shocked[201][assets.GLD]).toBe(1 / 3)
})

test('C2 earns only the adjacent overnight gap, and funds daytime SHY with a separate auction trade', () => {
  const frames = [session('2016-01-04'), session('2016-01-05', { SPY: [110, 75], SHY: [100, 102] })]
  const registered = books(frames)
  expect(new Set(registered.map(({ id }) => id)).size).toBe(19)
  const cash = registered.find(({ id }) => id === 'C2-SPY-cash')
  const shy = registered.find(({ id }) => id === 'C2-SPY-SHY')
  if (cash === undefined || shy === undefined) throw new Error('Missing C2 variants')
  const gross = replayBook(frames, emptyTape(frames), cash, 0)
  const net = replayBook(frames, emptyTape(frames), cash, 2)
  const carry = replayBook(frames, emptyTape(frames), shy, 2)
  expect(gross[0].net).toBe(0)
  expect(gross[1].overnight).toBeCloseTo(0.1, 12)
  expect(gross[1].intraday).toBe(0)
  expect(gross[1].mocNotional).toBe(100_000)
  expect(gross[1].openNotional).toBe(110_000)
  expect(net[1].net).toBeCloseTo((1.1 * (1 - 0.0001 - 0.000021)) / 1.0001 - 1, 12)
  expect(carry[1].intraday).toBeCloseTo(0.02, 12)
  expect(carry[1].openNotional).toBeGreaterThan(219_000)
  expect(carry[1].fees).toBeGreaterThan(net[1].fees)
  expect((1 + carry[1].overnight) * (1 + carry[1].intraday) - 1).toBeCloseTo(carry[1].net, 12)
})

test('decomposition keeps the first intraday observation and does not bridge a missing prior close', () => {
  const frames = [
    session('2016-01-04', { SPY: [100, 110] }),
    session('2016-01-05', { SPY: [121, 100] }),
    session('2016-01-06', { SPY: [100, 200] }),
    session('2016-01-07', { SPY: [220, 100] }),
    session('2016-01-08', { SPY: [110, 120] }),
  ]
  frames[2].bars[assets.SPY] = undefined
  const result = decomposition(frames, [0, 5])
  const train = result['SPY']['train']
  expect(Object.keys(result)).toHaveLength(29)
  expect(train.overnightCount).toBe(2)
  expect(train.intradayCount).toBe(4)
  expect(train.pairedCloseToCloseGross).toBeCloseTo((100 / 110) * (120 / 100) - 1, 12)
  expect(train.returns[0].overnight).toBeCloseTo(1.1 ** 2 - 1, 12)
  expect(train.returns[1].intraday).toBeLessThan(Number(train.returns[0].intraday))
})

const intradayBar = (open = 100, close = open): Bar => ({
  open,
  close,
  high: Math.max(open, close),
  low: Math.min(open, close),
  volume: 100,
  vwap: (open + close) / 2,
})
const noiseTape = (missingExit = false, exit = 110) => {
  const inputs: Day[] = Array.from({ length: 15 }, (_, i) => {
    const slots = i < 14 ? 78 : 42
    const bars = Array.from<Bar | undefined>({ length: slots }).fill(intradayBar())
    for (let slot = 5; slot < slots - 1; slot += 6) bars[slot] = intradayBar(100, i < 14 ? 101 : slot === 5 ? 104 : 100)
    if (i === 14) {
      bars[6] = intradayBar(105)
      bars[slots - 3] = intradayBar(exit)
      if (missingExit) for (let slot = slots - 3; slot < slots; slot++) bars[slot] = undefined
    }
    return {
      date: String(i),
      slots,
      bars: new Map([
        ['QQQ', bars],
        ['SMH', bars],
      ]),
    }
  })
  const day = [...prepare(inputs)].at(-1)
  if (day === undefined) throw new Error('Missing prepared fixture')
  return day
}

test('B0 retains the Wave 6A fill/P&L, sizes to cash and never reallocates a blocked symbol', () => {
  const day = noiseTape()
  const replay = createReplay(day)
  const reference = settleNoise(day, 100_000, () => false, 2)
  const smaller = settleNoise(day, 20_000, () => false, 2)
  const blocked = settleNoise(day, 20_000, (symbol) => symbol === 'QQQ', 2)
  expect(reference.net).toBeCloseTo(Number(netAt(replay(b0), 2)), 10)
  expect(smaller.reserved).toBeLessThanOrEqual(20_000)
  expect(smaller.lastExitMinutesBeforeClose).toBe(15)
  expect(smaller.trades).toBe(2)
  expect(blocked.trades).toBe(1)
  expect(blocked.blockedEntries).toBe(1)
  expect(blocked.net * 2).toBeCloseTo(smaller.net, 10)
  expect(() => settleNoise(noiseTape(true), 100_000, () => false, 2)).toThrow('Unresolved executed B0 exit')
})

test('C4 checks held symbols at entry while C5 releases the overnight book before B0', () => {
  const day = noiseTape()
  const frames = [session('prev'), session(day.date)]
  const tape = [emptyTape(frames)[0], day]
  const qqq = universe.map((symbol) => Number(symbol === 'QQQ'))
  const c4 = replayBook(frames, tape, { id: 'fixture', initial: qqq, noise: 'continuous' }, 2)[1]
  const c5 = replayBook(
    frames,
    tape,
    { id: 'fixture', close: [qqq], daytime: universe.map(() => 0), noise: 'cash' },
    2,
  )[1]
  expect(c4.noise?.blockedEntries).toBe(1)
  expect(c4.noise?.trades).toBe(1)
  expect(c5.noise?.blockedEntries).toBe(0)
  expect(c5.noise?.trades).toBe(2)
  expect(c5.overnightGrossRatio).toBeCloseTo(1, 12)
  expect(c5.openNotional).toBeGreaterThan(99_000)
  expect(c5.intradayEntryGrossRatio).toBeLessThanOrEqual(1)
  expect(c5.cashStressShortfall).toBe(0)
})

test('paired metrics reject wrong dates and compare self paths without spurious significance', () => {
  const frames = [session('2016-01-04', { SPY: [100, 102] }), session('2016-01-05', { SPY: [99, 98] })]
  const spec = books(frames).find(({ id }) => id === 'C1-SPY')
  if (spec === undefined) throw new Error('Missing SPY benchmark')
  const rows = replayBook(frames, emptyTape(frames), spec, 0)
  const p = stationaryBootstrap(2)
  const result = summarize(rows, rows, rows, 1, 0.01, p)
  expect(result.pVsShy).toBe(1)
  expect(result.pVsB0).toBe(1)
  expect(result.dsr).toBeNull()
  expect(result.finalEquity).toBeCloseTo(98_000, 8)
  expect(result.maxDrawdown).toBeCloseTo(1 - 98 / 102, 12)
  expect(result.topRemovedDates).toEqual(['2016-01-04'])
  expect(result.daytimeBetaToSpy).toBeCloseTo(1, 12)
  expect(() => summarize(rows, rows.toReversed(), rows, 1, 0.01, p)).toThrow('Misaligned comparison window')
})

test('mismatched development receipt never opens holdout', async () => {
  let opens = 0
  const load = () => Promise.resolve(++opens)
  expect(() => afterFreeze('computed', 'different', load)).toThrow('does not reproduce')
  expect(opens).toBe(0)
  expect(await afterFreeze('exact', 'exact', load)).toBe(1)
})

test('authenticates the original receipts when one squash commit introduces both files', () => {
  const evidence = 'docs/bayn/evidence/2026-11-27-10yr-etf-overnight-vs-intraday'
  const protocolPath = `${evidence}/protocol.md`
  const freezePath = `${evidence}/freeze.json`
  const original = JSON.parse(readFileSync(new URL(`../../../${freezePath}`, import.meta.url), 'utf8')) as {
    files: Record<string, string>
  }
  const cwd = mkdtempSync(join(tmpdir(), 'bayn-wave9a-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
  const write = (path: string, content: string) => {
    const file = join(cwd, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const commit = (message: string) => {
    git('add', '.')
    git('commit', '--quiet', '-m', message)
    return git('rev-parse', 'HEAD').trim()
  }
  try {
    git('init', '--quiet', '--initial-branch=checkout')
    git('config', 'user.name', 'Wave 9A test')
    git('config', 'user.email', 'wave9a@example.invalid')
    git('config', 'commit.gpgsign', 'false')
    git('commit', '--quiet', '--allow-empty', '-m', 'base')
    git('switch', '--quiet', '-c', 'published')
    const protocol = 'registered protocol\n'
    write(protocolPath, protocol)
    const protocolCommit = commit('publish protocol')
    const files = Object.fromEntries(
      Object.keys(original.files).map((path) => {
        const content = path === protocolPath ? protocol : `published ${path}\n`
        write(path, content)
        return [path, hash(content)]
      }),
    )
    const freeze = JSON.stringify({ schema: 'bayn.research.wave-9a.freeze.v1', protocolCommit, files }) + '\n'
    write(freezePath, freeze)
    const freezeCommit = commit('publish freeze')
    const freezeSha256 = hash(freeze)
    const receipt = { protocolCommit, freezeCommit, freezeSha256 }

    git('switch', '--quiet', 'checkout')
    git('merge', '--quiet', '--squash', 'published')
    write('services/bayn/tools/noise-area-study-replay.ts', 'merged replay with the same B0 behavior\n')
    const squash = commit('squash published branch')
    expect(git('log', '-1', '--format=%H', '--', protocolPath).trim()).toBe(squash)
    expect(git('log', '-1', '--diff-filter=A', '--format=%H', '--', freezePath).trim()).toBe(squash)
    expect(git('merge-base', freezeCommit, 'HEAD').trim()).not.toBe(freezeCommit)

    expect(verifyPublished(git, receipt)).toEqual({
      protocolCommit,
      files,
      publication: { freezeCommit, freezeSha256, freeze },
    })
    expect(() => verifyPublished(git, { ...receipt, protocolCommit: freezeCommit })).toThrow('merge-base')
    expect(() => verifyPublished(git, { ...receipt, freezeSha256: hash('different bytes') })).toThrow(
      'published SHA-256',
    )
    write(protocolPath, 'changed protocol\n')
    expect(() => verifyPublished(git, receipt)).toThrow('git diff HEAD')
    commit('change protocol')
    expect(() => verifyPublished(git, receipt)).toThrow(
      `Checkout differs from the published freeze for ${protocolPath}`,
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('C4 funds a realized B0 loss through a closing core sale, including its fee', () => {
  const day = noiseTape(false, 100)
  const frames = [session('prev'), session(day.date), session('next')]
  const tape = [emptyTape(frames)[0], day, emptyTape(frames)[2]]
  const shy = universe.map((symbol) => Number(symbol === 'SHY'))
  const rows = replayBook(frames, tape, { id: 'fixture', initial: shy, noise: 'continuous' }, 2)
  const loss = -rows[1].noiseNet
  expect(loss).toBeGreaterThan(0)
  expect(rows[1].fundingNotional).toBeCloseTo(loss / (1 - 0.0001 - 0.000021), 10)
  expect(rows[2].overnightGrossRatio).toBeCloseTo(1, 12)
  expect(rows[2].net).toBeCloseTo(0, 12)
})
