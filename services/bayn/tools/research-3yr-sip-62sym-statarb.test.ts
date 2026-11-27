import { describe, expect, test } from 'bun:test'

import { cliOptions } from './research-3yr-sip-62sym-statarb'
import { barOffset, makeDay, type Day, type Panel } from './sip-statarb-data'
import { nominate, passesSplit } from './sip-statarb-evaluation'
import { buildTrials, grossCapUsd, neighborPairs, trialId, wdcReset, type Trial } from './sip-statarb-protocol'
import {
  buildFeatures,
  executionCost,
  netFor,
  rankCrossSection,
  replay,
  replayLeg,
  selectBasket,
} from './sip-statarb-replay'

const bar = (day: Day, symbol: number, slot: number, values = [100, 101, 99, 100, 100, 100]) =>
  day.tape.set(values, barOffset(symbol, slot))
const sample = (date: string, slots = 4, count = 4) => {
  const day = makeDay(date, 0, slots, count)
  for (let i = 0; i < count; i++) for (let slot = 0; slot < slots; slot++) bar(day, i, slot)
  return day
}
const data = { symbols: ['A', 'B', 'SPY', 'WDC'], sector: [2, 2, -1, 2], spy: 2 }
const vwap100 = (slots: number) => ({ vwap: new Float64Array(slots).fill(100), atr: 0.02, inverseVol: 50 })

describe('Wave 2C protocol', () => {
  test('requires exactly one stage and registers unique IDs with matched neighbors', () => {
    expect(() => cliOptions([])).toThrow('Usage:')
    expect(() => cliOptions(['--freeze', '--score'])).toThrow('Usage:')
    expect(cliOptions(['--score', '--input-dir', '/local'])).toMatchObject({ stage: 'score', inputDir: '/local' })
    const trials = buildTrials()
    const ids = new Set(trials.map(trialId))
    expect(ids.size).toBe(347)
    expect(trials.length).toBe(ids.size)
    const anchor = trials.find((trial) => trialId(trial) === 'expanded46-stocks/median/4/30/single/wide/equal/0')
    if (anchor === undefined) throw new Error('Missing protocol trial')
    expect(
      neighborPairs(anchor)
        .flatMap((axis) => axis.ids)
        .every((id) => ids.has(id)),
    ).toBeTrue()
  })

  test('uses only strictly prior complete sessions and resets WDC', () => {
    const history = data.symbols.map(() => [])
    for (let i = 0; i < 14; i++) {
      const day = sample('2025-02-01')
      if (i === 0) day.tape.fill(0, barOffset(0, 1), barOffset(0, 2))
      expect(buildFeatures(day, data, history).features[1].atr).toBe(0)
    }
    const current = sample(wdcReset)
    bar(current, 1, 0, [100, 150, 90, 115, 100, 100])
    bar(current, 1, 1, [100, 145, 98, 110, 300, 110])
    const computed = buildFeatures(current, data, history)
    expect(computed.features[0].atr).toBe(0)
    expect(computed.features[1].atr).toBeCloseTo(0.02)
    expect(computed.features[1].vwap[1]).toBeCloseTo(107.5)
    expect(computed.features[3].atr).toBe(0)
    expect(computed.marketMultiplier).toBe(0)
  })

  test('uses the last completed bar; LOSO recomputes median, IQR and both sides', () => {
    const day = sample('2025-06-30')
    for (const [id, price] of [98, 99, 100, 104].entries()) {
      bar(day, id, 0, [100, 105, 95, price, 100, 100])
      bar(day, id, 1, [100, 110, 95, 110 - 4 * id, 100, 100])
    }
    const section = rankCrossSection(
      day,
      data,
      data.symbols.map(() => vwap100(4)),
      [0, 1, 2, 3],
      1,
      'median',
    )
    expect(selectBasket(section, 2)).toMatchObject({ longs: [0, 1], shorts: [3, 2] })
    const omitted = selectBasket(section, 2, 0)
    expect(omitted).toMatchObject({ longs: [1], shorts: [3] })
    expect(omitted.iqr).toBeCloseTo(0.025)
    expect(selectBasket(section, 2, -1, new Set([0, 3]))).toMatchObject({ longs: [1], shorts: [2] })
  })

  test('Validation veto does not replace the Train winner; bootstrap equality fails', () => {
    type Input = Parameters<typeof nominate>[0][number]
    type Stamp = NonNullable<Input['costs'][5]['train']>
    const periods = (sharpe: number, passes: boolean) => ({
      train: { net: 100, exTop5: 50, sharpe, bootstrapP: 0.03 } as Stamp,
      validation: { net: 100, exTop5: 50, sharpe, bootstrapP: passes ? 0.04 : 0.05 } as Stamp,
    })
    const grid = buildTrials()
      .filter(
        (t) =>
          t.universe === 'expanded46-stocks' &&
          t.timing === 'single' &&
          t.signal === 'spy' &&
          t.exit === 'wide' &&
          t.sizing === 'equal' &&
          t.gateBps === 0,
      )
      .map((trial): Input => {
        const isBest = trial.entry === 30 && trial.pairs === 4
        const m = periods(isBest ? 4 : 3.5, !isBest)
        return { id: trialId(trial), trial, costs: { 2: m, 5: m, 10: m } }
      })
    const nominee = nominate(grid)[0]
    expect(nominee).toMatchObject({ nominee: 'expanded46-stocks/spy/4/30/single/wide/equal/0', approved: false })
    const trial = grid.find(({ id }) => id === nominee.nominee)
    if (trial === undefined) throw new Error('Missing Train winner')
    expect(passesSplit(trial, 'validation')).toBeFalse()
  })
})

describe('execution', () => {
  test('uses next open, resolves a two-touch bar stop-first and gaps a stop at the observed open', () => {
    const day = sample('2025-07-01')
    bar(day, 0, 0, [97, 101, 95, 98, 100, 98])
    bar(day, 0, 1, [100, 110, 94, 100, 100, 100])
    expect(replayLeg(day, vwap100(4), 0, 1, 1, 3, 'wide')).toMatchObject({ entry: 100, exit: 95, reason: 'stop' })
    bar(day, 0, 1)
    bar(day, 0, 2, [107, 107, 99, 105, 100, 104])
    expect(replayLeg(day, vwap100(4), 0, -1, 1, 3, 'wide')).toMatchObject({ entry: 100, exit: 107, reason: 'stop' })
  })

  test('waits until next open after a VWAP cross and does not invent a missing close', () => {
    const day = sample('2025-07-01')
    bar(day, 0, 1, [100, 103, 99, 102, 100, 102])
    bar(day, 0, 2, [101, 101, 97, 100, 100, 100])
    expect(replayLeg(day, vwap100(4), 0, 1, 1, 3, 'cross')).toMatchObject({ exit: 101, reason: 'vwap-cross' })
    day.tape.fill(0, barOffset(0, 3), barOffset(0, 4))
    expect(replayLeg(day, vwap100(4), 0, 1, 1, 3, 'timed')).toMatchObject({ exit: 0, reason: null, gaps: 1 })
    expect(replayLeg(day, vwap100(4), 0, 1, 3, 4, 'timed')).toBeNull()
  })

  test('charges stress on both legs and sell fee on actual sale notional, retaining orphans', () => {
    const days = Array.from({ length: 15 }, (_, index) => sample(`2025-07-${String(index + 1).padStart(2, '0')}`))
    const last = days[14]
    bar(last, 0, 0, [100, 100, 98, 98, 100, 100])
    bar(last, 1, 0, [100, 103, 100, 102, 100, 100])
    bar(last, 0, 1, [101, 102, 100, 101, 100, 101])
    bar(last, 0, 3, [102, 103, 101, 102, 100, 102])
    last.tape.fill(0, barOffset(1, 1), barOffset(1, 2))
    const names = [0, 1]
    const panel: Panel = {
      ...data,
      days,
      universes: {
        'bayn17-stocks': names,
        'bayn18-mixed': names,
        'expanded46-stocks': names,
        'expanded50-mixed': names,
      },
      coverage: [],
    }
    const t: Trial = {
      universe: 'expanded46-stocks',
      signal: 'spy',
      pairs: 1,
      entry: 1,
      timing: 'single',
      exit: 'timed',
      sizing: 'equal',
      gateBps: 0,
    }
    const run = replay(panel, [t], true).get(trialId(t))
    const latest = run?.main.at(-1)
    if (latest === undefined) throw new Error('Expected replay ledger')
    const qty = grossCapUsd / 2 / 101
    expect(latest).toMatchObject({ attempted: 2, opened: 1, orphanWaves: 1, entryGross: grossCapUsd / 2 })
    expect(latest.gross).toBeCloseTo(qty)
    const { slippage, sellFees } = executionCost(latest, 10)
    expect(slippage).toBeCloseTo(qty * (101 + 102) * 0.0005)
    expect(sellFees).toBeCloseTo(qty * 102 * (1 - 0.0005) * 0.000021)
    expect(netFor(latest, 10)).toBeCloseTo(qty - slippage - sellFees)
    expect(run?.loso.get(0)?.at(-1)).toBe(0)
  })
})
