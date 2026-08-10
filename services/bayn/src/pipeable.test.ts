import { describe, expect, test } from 'bun:test'

import { Pipeable } from './pipeable'

describe('pipeable functions', () => {
  test('supports unary data-first and data-last calls', () => {
    const length = Pipeable.dual(1, (value: string) => value.length)

    expect(length('bayn')).toBe(4)
    expect(length()('bayn')).toBe(4)
  })

  test('delegates multi-argument calls to Effect dual', () => {
    const append = Pipeable.dual(2, (self: string, suffix: string) => `${self}${suffix}`)

    expect(append('bayn', '-paper')).toBe('bayn-paper')
    expect(append('-paper')('bayn')).toBe('bayn-paper')
  })

  test('preserves generic inference in both call styles', () => {
    const pairDataFirst = <A>(self: A, suffix: string): readonly [A, string] => [self, suffix]
    const pair = Pipeable.generic<<A>(suffix: string) => (self: A) => readonly [A, string], typeof pairDataFirst>(
      2,
      pairDataFirst,
    )

    expect(pair(42, 'paper')).toEqual([42, 'paper'])
    expect(pair('paper')(42)).toEqual([42, 'paper'])
  })
})
