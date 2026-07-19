import { describe, expect, test } from 'bun:test'

import { buildInputManifest } from './market-data'
import { defaultProtocol } from './protocol'
import { makeBars } from './test-fixtures'

describe('Signal input manifest', () => {
  test('is deterministic and records exact coverage', () => {
    const bars = makeBars(10)
    const first = buildInputManifest(bars, 'signal', 'adjusted_daily_bars_v1', defaultProtocol.universe, 'fixture-v1')
    const second = buildInputManifest(
      [...bars].reverse(),
      'signal',
      'adjusted_daily_bars_v1',
      defaultProtocol.universe,
      'fixture-v1',
    )
    expect(first.hash).toBe(second.hash)
    expect(first.rowCount).toBe(80)
    expect(first.symbols).toHaveLength(8)
    expect(first.symbols.every((coverage) => coverage.rows === 10)).toBe(true)
    const changedBars = bars.map((bar, index) => (index === 0 ? { ...bar, close: bar.close + 0.01 } : bar))
    const changed = buildInputManifest(
      changedBars,
      'signal',
      'adjusted_daily_bars_v1',
      defaultProtocol.universe,
      'fixture-v1',
    )
    expect(changed.contentHash).not.toBe(first.contentHash)
    expect(changed.hash).not.toBe(first.hash)
  })

  test('rejects duplicates and missing symbols', () => {
    const bars = makeBars(2)
    expect(() =>
      buildInputManifest(
        [...bars, bars[0]],
        'signal',
        'adjusted_daily_bars_v1',
        defaultProtocol.universe,
        'fixture-v1',
      ),
    ).toThrow('duplicate adjusted bar')
    expect(() =>
      buildInputManifest(
        bars.filter((bar) => bar.symbol !== 'SPY'),
        'signal',
        'adjusted_daily_bars_v1',
        defaultProtocol.universe,
        'fixture-v1',
      ),
    ).toThrow('universe mismatch')
  })
})
