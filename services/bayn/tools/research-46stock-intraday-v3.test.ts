import { describe, expect, test } from 'bun:test'

import { readTape, type TapeDay } from './intraday-v3-data'
import {
  grossCap,
  noiseTrials,
  orbTrials,
  portfolios,
  reversionTrials,
  sleeves,
  type Portfolio,
} from './intraday-v3-protocol'
import { laggedVol, netAt, replayDay, sleeveWeights } from './intraday-v3-replay'
import { fillPath, pickBasket, prepareDays, type Order, type PreparedDay, type Signal } from './intraday-v3-signals'
import { parseArgs, verifyDevelopment } from './research-46stock-intraday-v3'

const bar = (open = 100, high = 101, low = 99, close = 100.5, volume = 100, vwap = 100) => [
  open,
  high,
  low,
  close,
  volume,
  vwap,
]

describe('SIP research tape and eligibility', () => {
  test('clips early closes, excludes when-issued rows and skips holdout price decoding during freeze', async () => {
    const sessions = ['2025-02-21', '2025-02-24', '2026-03-31', '2026-04-01'].map((date) => ({
      date,
      openMs: Date.parse(`${date}T14:30:00Z`),
      minutes: 210,
    }))
    async function* rows() {
      for (const [date, time, fields] of [
        ['2025-02-21', '14:30', bar()],
        ['2025-02-24', '14:30', bar()],
        ['2026-03-31', '18:00', bar()],
        ['2026-04-01', '14:30', ['unreadable']],
      ] as const)
        yield ['SNDK', `${date}T${time}:00Z`, ...fields].join('\t')
    }
    const tape = await readTape(sessions, '2026-03-31', rows())
    expect(tape.row).toBe(4)
    expect(tape.coverage).toMatchObject({ rows: 3, regular: 1, nonRegular: 1, preListing: 1 })
    expect(tape.days.map((day) => day.bars.has('SNDK'))).toEqual([false, true, false])
    await expect(readTape(sessions, '2026-04-01', rows())).rejects.toThrow()
  })

  test('OR5 takes exactly 14 strictly prior full sessions and does not depend on later closes', () => {
    const slots = 5
    const fixture = (gap = -1): TapeDay[] =>
      Array.from({ length: 17 }, (_, i) => {
        const ordinary = [bar(), bar(), bar(), bar(), bar()]
        const spike = [bar(110, 112, 109, 111, 1000), bar(111, 114, 110, 112), bar(113, 115, 111, 114), bar(), bar()]
        const data = i === 13 || i === 14 || i === 16 ? spike : ordinary
        if (i === gap) data[1] = [0, 0, 0, 0, 0, 0]
        return {
          date: `2024-01-${String(i + 2).padStart(2, '0')}`,
          slots,
          bars: new Map([['NVDA', new Float64Array(data.flat())]]),
        }
      })
    const trial = orbTrials.find((trial) => trial.id === 'orb/k1/2.5/2') ?? orbTrials[0]
    const full = prepareDays(fixture())
    expect(full[13].orb(trial, '')).toHaveLength(0)
    expect(full[14].orb(trial, '')).toMatchObject([{ start: 2, symbol: 'NVDA', side: 1, fill: { entry: 113 } }])
    expect(prepareDays(fixture().slice(0, 15))[14].orb(trial, '')).toEqual(full[14].orb(trial, ''))
    expect(prepareDays(fixture(4))[14].orb(trial, '')).toHaveLength(0)
  })

  test('the weakest tail pair must meet the spread threshold after eligibility exclusions', () => {
    const ranks = [
      ['a', -200],
      ['b', -90],
      ['c', -15],
      ['d', 10],
      ['e', 110],
      ['f', 260],
    ].map(([symbol, bps]) => ({ symbol: String(symbol), bps: Number(bps) }))
    expect(pickBasket(ranks, { gate: 'spread', minBps: 200 })).toEqual(['a', 'b', 'f', 'e'])
    expect(pickBasket(ranks, { gate: 'spread', minBps: 201 })).toBeNull()
    expect(pickBasket(ranks, { gate: 'spread', minBps: 200 }, new Set(['a']))).toBeNull()
    expect(pickBasket(ranks, { gate: 'iqr', minBps: 100 })).not.toBeNull()
    expect(pickBasket(ranks, { gate: 'iqr', minBps: 200 })).toBeNull()
  })
})

describe('causal execution', () => {
  const signal: Signal = {
    symbol: 'AAPL',
    slot: 0,
    reference: 100,
    side: 1,
    stop: { price: 95 },
    target: { riskMultiple: 2 },
  }
  test('fills at t+1 OPEN, resolves an ambiguous touch stop first, and honors adverse gaps', () => {
    const tape = new Float64Array([bar(100, 150, 50), bar(101, 120, 90), bar(), bar()].flat())
    expect(fillPath(tape, 4, signal)).toMatchObject({ entry: 101, exit: 95, exitSlot: 1, exitAtOpen: false })
    const gap = new Float64Array([bar(), bar(), bar(90, 91, 88, 90), bar()].flat())
    expect(fillPath(gap, 4, signal)).toMatchObject({ entry: 100, exit: 90, exitSlot: 2, exitAtOpen: true })
  })

  test('an opposite-band close uses the next open, and a missing final open never becomes cash', () => {
    const tape = new Float64Array([bar(), bar(), bar(104, 105, 103, 104), [0, 0, 0, 0, 0, 0]].flat())
    expect(fillPath(tape, 4, { ...signal, exitAt: (i) => i === 1 })).toMatchObject({ exit: 104, exitSlot: 2 })
    expect(fillPath(tape, 4, signal)).toMatchObject({ exit: null, gaps: 1 })
  })

  const portfolio: Portfolio = {
    engine: 'portfolio',
    id: 'test',
    orb: orbTrials[0],
    reversion: reversionTrials[0],
    noise: noiseTrials[0],
    weight: 'equal',
  }
  const order = (
    symbol: string,
    engine: Order['engine'],
    start: number,
    exitSlot: number,
    exitAtOpen = false,
  ): Order => ({
    symbol,
    engine,
    start,
    side: 1,
    reference: 100,
    riskDistance: engine === 'reversion' ? null : 1,
    fill: { entry: 100, exit: 101, exitSlot, exitAtOpen, gaps: 0 },
  })

  test('shares actual concurrent capacity, excludes occupancy at the close and blocks late OR5 conflicts', () => {
    let excluded: string[] = []
    const noon = portfolio.reversion.signalSlot + 1
    const day: PreparedDay = {
      date: '2024-02-02',
      orb: () => [order('AAPL', 'orb', 2, noon, true), order('NVDA', 'orb', noon + 1, 77)],
      noise: () => [order('QQQ', 'noise', 6, 77)],
      reversion: (_, held) => {
        excluded = [...held]
        return ['NVDA', 'AMD', 'META', 'MU'].map((symbol) => order(symbol, 'reversion', noon, 77))
      },
    }
    // Oversubscribed inputs exercise the shared cap independently of the normal weight envelopes.
    const ledger = replayDay(day, portfolio, { orb: 1, reversion: 1, noise: 1 })
    expect(excluded).toContain('AAPL')
    expect(ledger.trades).toBe(6)
    expect(ledger.conflicts).toBe(1)
    expect(ledger.peakGross).toBeCloseTo(grossCap, 7)
    expect(netAt(ledger, 2)).toBeGreaterThan(netAt(ledger, 10) ?? Infinity)
  })

  test('a four-leg basket with one missing opening print never creates unhedged positions', () => {
    const day: PreparedDay = {
      date: '2024-02-02',
      orb: () => [],
      noise: () => [],
      reversion: () =>
        ['AAPL', 'AMD', 'META', 'MU'].map((symbol) => {
          const next = order(symbol, 'reversion', 24, 77)
          return symbol === 'AAPL' ? { ...next, fill: 'missing' } : next
        }),
    }
    expect(replayDay(day, portfolio, { orb: 0, reversion: 1, noise: 0 })).toMatchObject({
      trades: 0,
      canceledMissing: 1,
      peakGross: 0,
    })
  })

  test('volatility excludes current P&L and adaptive modes preserve the idle cash budget', () => {
    const day: PreparedDay = { date: '2024-02-02', orb: () => [], noise: () => [], reversion: () => [] }
    const flat = replayDay(day, portfolio, { orb: 0, reversion: 0, noise: 0 })
    const history = Array.from({ length: 22 }, (_, i) => ({ ...flat, netBeforeSlippage: i === 20 ? 10_000 : i }))
    const vols = laggedVol(history)
    expect(vols[19]).toBeNull()
    expect(vols[20]).toBe(laggedVol(history.map((row, i) => (i === 20 ? flat : row)))[20])
    expect(vols[21] ?? 0).toBeGreaterThan(vols[20] ?? Infinity)
    expect(sleeveWeights('risk-parity', ['orb', 'reversion'], { orb: 0.01, reversion: 0.02, noise: 0 })).toEqual({
      orb: 2 / 3,
      reversion: 1 / 3,
      noise: 0,
    })
    expect(sleeveWeights('inverse-variance', ['orb', 'reversion'], { orb: 0.01, reversion: 0.02, noise: 0 })).toEqual({
      orb: 0.125,
      reversion: 0.03125,
      noise: 0,
    })
  })
})

test('registers unique experiments and refuses a different freeze', () => {
  expect(orbTrials).toHaveLength(27)
  expect(reversionTrials).toHaveLength(54)
  expect(noiseTrials).toHaveLength(4)
  const registry = [...sleeves, ...portfolios(orbTrials.slice(0, 4), reversionTrials.slice(0, 4))]
  expect(registry).toHaveLength(485)
  expect(new Set(registry.map(({ id }) => id)).size).toBe(registry.length)
  expect(parseArgs(['--score', '--output', '/tmp/score.json'])).toEqual({ mode: '--score', output: '/tmp/score.json' })
  expect(() => parseArgs(['--freeze', '--score'])).toThrow()
  expect(() => verifyDevelopment('{ "dev": 1 }', { dev: 1 })).not.toThrow()
  expect(() => verifyDevelopment('{"dev":1}', { dev: 2 })).toThrow('does not reproduce')
})
