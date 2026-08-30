import { describe, expect, it } from 'vitest'

import { resolveTradingDayInterval } from '~/server/torghut-trading-time'

describe('torghut trading time', () => {
  it('rejects invalid calendar dates', () => {
    const url = new URL('https://example.test/api?tz=America%2FNew_York&day=2026-02-31')
    const result = resolveTradingDayInterval(url)

    expect(result.ok).toBe(false)
  })

  it('accepts leap day on leap years', () => {
    const url = new URL('https://example.test/api?tz=America%2FNew_York&day=2024-02-29')
    const result = resolveTradingDayInterval(url)

    expect(result.ok).toBe(true)
  })

  it('rejects leap day on non-leap years', () => {
    const url = new URL('https://example.test/api?tz=America%2FNew_York&day=2025-02-29')
    const result = resolveTradingDayInterval(url)

    expect(result.ok).toBe(false)
  })

  it('computes UTC bounds for an ET trading day', () => {
    const url = new URL('https://example.test/api?tz=America%2FNew_York&day=2026-02-10')
    const result = resolveTradingDayInterval(url)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.value.day).toBe('2026-02-10')
    expect(result.value.startUtc).toBe('2026-02-10T05:00:00.000Z')
    expect(result.value.endUtc).toBe('2026-02-11T05:00:00.000Z')
  })
})
