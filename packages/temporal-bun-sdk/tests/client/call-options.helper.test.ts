import { describe, expect, test } from 'bun:test'

import { temporalCallOptions } from '../../src/client'

describe('temporalCallOptions helper', () => {
  test('brands call options with a hidden marker', () => {
    const options = temporalCallOptions({ timeoutMs: 1_000 }) as Record<string | symbol, unknown>
    const markerPresent = Object.getOwnPropertySymbols(options).some(
      (symbol) => symbol.toString() === 'Symbol(temporal.bun.callOptions)',
    )

    expect(markerPresent).toBe(true)
    expect(options.__temporalCallOptions).toBe(true)
    expect(Object.prototype.propertyIsEnumerable.call(options, '__temporalCallOptions')).toBe(false)
  })
})
