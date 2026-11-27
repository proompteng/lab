import { describe, expect, test } from 'bun:test'

import { collectBars, sha256, type Session } from './etf-canary-macro-data'
import {
  asset,
  etfs,
  grid,
  mix,
  neighbors,
  priorTrials,
  sellFee,
  shy,
  trialId,
  type Canary,
} from './etf-canary-macro-protocol'
import { marks, needsTrade, replay, trades } from './etf-canary-macro-replay'
import { canaryProtection, features, macroRegime, riskParity, targets, trendSignal } from './etf-canary-macro-signals'
import { bootstrapP, stationaryBlocks, summarize } from './etf-canary-macro-statistics'
import { verifyPublished } from './research-etf-canary-macro-v2'

const spy = asset('SPY')
const uup = asset('UUP')
const xlc = asset('XLC')
const canary: Canary = {
  kind: 'canary',
  panel: 0,
  protection: 'breadth',
  cadence: 21,
  offensive: 2,
  defensive: 2,
  weighting: 'equal',
}
const session = (day: number): Session => ({
  date: new Date(Date.UTC(2016, 0, 4 + day)).toISOString().slice(0, 10),
  open: new Float64Array(etfs.length).fill(100),
  close: new Float64Array(etfs.length).fill(100),
})
const book = (n: number) => Array.from({ length: n }, () => new Float64Array(etfs.length))
const encode = (s: string) => new TextEncoder().encode(s)

describe('registered mechanisms', () => {
  test('bounded grid, prior trial count, and all eight single-parameter blend neighbors', () => {
    const trials = [...grid()]
    expect(trials).toHaveLength(135)
    expect(new Set(trials.map(trialId)).size).toBe(135)
    expect(priorTrials + trials.length).toBe(257)
    expect(neighbors(mix, trials)).toHaveLength(8)
  })

  test('binary canary fails closed while breadth scales without switching off the whole book', () => {
    expect(canaryProtection([1, -1, 1, 1], 'binary')).toBe(1)
    expect(canaryProtection([1, -1, 1, 1], 'breadth')).toBe(0.25)
    expect(canaryProtection([1, 0, NaN], 'breadth')).toBeCloseTo(2 / 3)
    expect(canaryProtection([1, 1, 1], 'binary')).toBe(0)
  })

  test('continuous trend remains signed, bounded, and insensitive to missing assets', () => {
    expect(trendSignal([1, 1, 1, 1], 0.05)).toBe(1)
    expect(trendSignal([-0.9, -0.9, -0.9, -0.9], 0.05)).toBe(-1)
    const a = trendSignal([0.01, 0.02, 0.03, 0.04], 0.15)
    const b = trendSignal([0.01, 0.02, 0.03, 0.08], 0.15)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(a)
    expect(b).toBeLessThan(1)
    expect(trendSignal([0.2, 0.3, 0.4, NaN], 0.1)).toBe(0)
  })

  test('four macro states, dollars in stagflation, EMA smoothing, and omitted credit guard', () => {
    expect([macroRegime(1, -1), macroRegime(1, 1), macroRegime(-1, 1), macroRegime(-1, -1)]).toEqual([0, 1, 2, 3])
    expect(macroRegime(NaN, 1)).toBeNull()
    const tape = Array.from({ length: 66 }, (_, t) => {
      const s = session(t)
      for (const [symbol, value] of [
        ['HYG', -0.2],
        ['GLD', 0.3],
        ['DBC', 0.2],
        ['UUP', 0.1],
      ] as const)
        s.close[asset(symbol)] *= 1 + (value * t) / 63
      return s
    })
    const f = features(tape)
    const rule = { kind: 'macro', horizon: 63, review: 1, band: 0.1 } as const
    const weights = targets(rule, f, -1)
    expect(weights[62][uup]).toBe(0)
    expect(weights[63][uup]).toBeCloseTo(0.4 / 3)
    expect(weights[64][uup]).toBeGreaterThan(weights[63][uup])
    expect(targets(rule, f, uup)[64][uup]).toBe(0)
    expect(targets(rule, f, asset('HYG'))[65].every((w) => w === 0)).toBe(true)
  })

  test('sector momentum will not buy a recently listed sector before its own lookback exists', () => {
    const tape = Array.from({ length: 160 }, (_, t) => {
      const s = session(t)
      s.close[xlc] = s.open[xlc] = t < 80 ? 0 : 100 + t * 2
      s.close[spy] = 100 + t
      s.close[asset('HYG')] = 100 + t
      return s
    })
    const f = features(tape)
    const weights = targets({ kind: 'sector', horizon: 63, cadence: 21, top: 2 }, f, -1)
    expect(weights[126][xlc]).toBe(0)
    expect(weights[147][xlc]).toBeGreaterThan(0)
  })

  test('covariance risk parity equalizes positive marginal risk contributions', () => {
    const matrix = [
      [0.01, 0.01, 0.003],
      [0.01, 0.04, 0.009],
      [0.003, 0.009, 0.09],
    ]
    const w = riskParity(matrix)
    const risk = w.map((x, i) => x * matrix[i].reduce((s, cov, j) => s + cov * w[j], 0))
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1)
    expect(risk[0]).toBeCloseTo(risk[1], 10)
    expect(risk[1]).toBeCloseTo(risk[2], 10)
  })
})

describe('SIP and publication guardrails', () => {
  test('development skips malformed later prices, scoring refuses them, duplicate rows fail', () => {
    const base = 'SPY\t2023-12-29T05:00:00Z\t10\t12\t9\t11\t100\t10\n'
    const later = 'SPY\t2024-01-02T05:00:00Z\tnot-a-price\n'
    const dates = new Map<string, Session>()
    collectBars(encode(base + later), '2023-12-29', dates, new Set(['SPY']), 2)
    expect(dates.get('2023-12-29')?.close[spy]).toBe(11)
    expect(dates.has('2024-01-02')).toBe(false)
    expect(() => collectBars(encode(base + later), '2024-01-02', new Map(), new Set(['SPY']), 2)).toThrow(
      'Invalid daily bar',
    )
    expect(() => collectBars(encode(base + base), '2023-12-29', new Map(), new Set(['SPY']), 2)).toThrow(
      'Invalid daily bar',
    )
  })

  test('publishing means exact committed bytes on the designated remote branch', () => {
    const hash = 'ab'.repeat(20)
    const head = 'refs/heads/codex/bayn-w4d-etf-risk-premia-v2'
    const sources = new Map([['/tmp/fake/protocol.md', sha256('registered\n')]])
    const git =
      (remoteBytes: string, protocol = 'registered\n') =>
      (...cmd: string[]) => {
        if (cmd[0] === 'rev-parse') return '/tmp/fake\n'
        if (cmd[0] === 'ls-remote') return hash + '\t' + head + '\n'
        if (cmd[0] === 'show' && cmd[1] === hash + ':protocol.md') return protocol
        if (cmd[0] === 'show') return cmd[1].startsWith('HEAD:') ? 'receipt\n' : remoteBytes
        if (cmd[0] === 'log') return hash + '\n'
        throw new Error('unexpected command')
      }
    expect(() => verifyPublished('/tmp/fake/freeze.json', 'uncommitted\n', sources, git('receipt\n'))).toThrow('HEAD')
    expect(() => verifyPublished('/tmp/fake/freeze.json', 'receipt\n', sources, git('old\n'))).toThrow('not published')
    expect(() => verifyPublished('/tmp/fake/freeze.json', 'receipt\n', sources, git('receipt\n', 'new'))).toThrow(
      'protocol.md',
    )
    expect(verifyPublished('/tmp/fake/freeze.json', 'receipt\n', sources, git('receipt\n')).commit).toBe(hash)
  })
})

describe('next-open self-financing simulation', () => {
  test('prior close signal never earns an opening gap on a new holding', () => {
    const tape = Array.from({ length: 255 }, (_, t) => session(t))
    const w = book(tape.length)
    w[252][spy] = 1
    tape[253].open[spy] = 200
    tape[253].close[spy] = 220
    tape[254].open[spy] = 220
    tape[254].close[spy] = 220
    const result = replay(marks(tape), w, canary, 0, false, -1)
    expect(result.net[252]).toBe(0)
    expect(result.net[253]).toBeCloseTo(0.1)
    expect(result.net[254]).toBeCloseTo(0)
    expect(result.turnover[253]).toBeCloseTo(0.5)
    // Mutating the execution-day close cannot alter the prior-close target.
    const first = targets(canary, features(tape), -1)[252]
    tape[253].close[spy] = 800
    expect(targets(canary, features(tape), -1)[252]).toEqual(first)
  })

  test('band decisions, exact sell fees, and sweep cash vs SHY benchmark', () => {
    expect(needsTrade(0.07, 0.03, false, 0.05)).toBe(false)
    expect(needsTrade(0.07, 0.03, true, 0.05)).toBe(true)
    expect(needsTrade(0.03, 0.03, true, 0.05)).toBe(true)
    expect(needsTrade(0, 0, true, 0.05)).toBe(false)
    expect(needsTrade(0.1, 0, false, 0.1)).toBe(true)
    expect(trades(1, 1, 2)).toBeCloseTo(0.0002 + sellFee, 12)
    const tape = [session(0), session(1)]
    tape[0].close[shy] = 110
    tape[1].open[shy] = 110
    tape[1].close[shy] = 121
    const prices = marks(tape)
    const w = book(2)
    const swept = replay(prices, w, canary, 0, true, -1)
    const flat = replay(prices, w, canary, 0, false, -1)
    const s = summarize(swept, flat, prices, { name: 'test', first: 0, end: 2 }, null)
    expect(s.withShy.net).toBeCloseTo(0.21)
    expect(s.withShy.excessVsShy).toBeCloseTo(0)
    expect(s.zeroCash.net).toBe(0)
    expect(s.zeroCash.excessVsShy).toBeCloseTo(-0.21)
  })

  test('short collateral does not earn SHY; borrow uses calendar time and charges even at unchanged prices', () => {
    const tape = Array.from({ length: 255 }, (_, t) => session(t))
    tape[254].date = session(256).date
    tape[254].open[shy] = tape[254].close[shy] = 200
    const w = book(tape.length)
    w[252][spy] = -1
    const result = replay(marks(tape), w, canary, 0, true, -1)
    expect(result.net[253]).toBeCloseTo((-2 * sellFee) / (1 + sellFee), 10)
    expect(result.net[254]).toBeCloseTo((-0.015 * 3) / 365, 10)
  })

  test('stationary bootstrap is deterministic, circular, and uses 10,000 centered draws', () => {
    const excess = Array.from({ length: 50 }, (_, i) => (i % 10 === 0 ? -0.001 : 0.002))
    const blocks = stationaryBlocks(excess.length)
    expect(blocks).toEqual(stationaryBlocks(excess.length))
    expect(bootstrapP(excess, blocks)).toBeCloseTo(1 / 10001, 12)
    expect(
      bootstrapP(
        excess.map((x) => -x),
        blocks,
      ),
    ).toBe(1)
  })
})
