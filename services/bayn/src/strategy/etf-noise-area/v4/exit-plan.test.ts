import { expect, test } from 'bun:test'

import { advanceChandelier, openChandelier } from './exit-plan'
import { Direction, type PriceBar } from './signals'

test.each([Direction.Long, Direction.Short])(
  'ratchets beyond 1.2R without using an ambiguous same bar (%s)',
  (direction) => {
    const bar = (low: number, high: number, close: number): PriceBar =>
      direction === Direction.Long
        ? { open: 100, low, high, close }
        : { open: 100, low: 200 - high, high: 200 - low, close: 200 - close }

    const initial = openChandelier(direction, 100, 2.5)
    if (initial === undefined) throw new Error('Expected initial 10-point risk')
    expect(initial.stop).toBe(100 - direction * 10)
    const equality = advanceChandelier(initial, bar(98, 114, 112))
    if (equality._tag !== 'Hold') throw new Error('Unexpected old stop touch at equality')
    expect(equality.state.stop).toBe(initial.stop)

    expect(advanceChandelier(initial, bar(89, 116, 115))._tag).toBe('ExitNextOpen')
    const armed = advanceChandelier(equality.state, bar(99, 120, 118))
    if (armed._tag !== 'Hold') throw new Error('The new stop cannot apply to its arming bar')
    expect(direction * (armed.state.stop - 100)).toBeGreaterThanOrEqual(0)
    expect(direction * (armed.state.stop - 100)).toBeLessThan(18)

    const level = 100 + direction * (armed.state.stop - 100)
    const wider = advanceChandelier(armed.state, bar(level + 0.01, 120, 115))
    if (wider._tag !== 'Hold') throw new Error('The bar did not reach the existing stop')
    expect(wider.state.stop).toBe(armed.state.stop)
    expect(advanceChandelier(wider.state, bar(level, 121, 120))._tag).toBe('ExitNextOpen')
  },
)
