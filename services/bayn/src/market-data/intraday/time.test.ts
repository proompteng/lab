import { expect, test } from 'bun:test'
import { compareIntradayInstants, intradayAgeNanos, intradayInstantNanos } from './time'

test('canonical timestamps retain exact nanoseconds across epoch, calendar and precision boundaries', () => {
  const seconds = [
    '0001-01-01T00:00:00',
    '1969-12-31T23:59:59',
    '1970-01-01T00:00:00',
    '2024-02-29T23:59:59',
    '2024-03-01T00:00:00',
    '2026-09-11T19:59:59',
    '9999-12-31T23:59:59',
  ]
  const instants = seconds.flatMap((second) => {
    const start = BigInt(Date.parse(`${second}.000Z`)) * 1_000_000n
    return [0, 1, 999, 999_999, 1_000_000, 123_456_789, 999_999_999]
      .map((nanos) => ({
        text: `${second}.${String(nanos).padStart(9, '0')}Z`,
        expected: start + BigInt(nanos),
      }))
      .concat(
        [0, 1, 123, 999].map((millis) => ({
          text: `${second}.${String(millis).padStart(3, '0')}Z`,
          expected: start + BigInt(millis) * 1_000_000n,
        })),
      )
  })
  for (const left of instants) {
    expect(intradayInstantNanos(left.text)).toBe(left.expected)
    for (const right of instants) {
      expect(compareIntradayInstants(left.text, right.text)).toBe(
        left.expected < right.expected ? -1 : left.expected > right.expected ? 1 : 0,
      )
      expect(intradayAgeNanos(left.text, right.text)).toBe(left.expected - right.expected)
    }
  }
  for (let second = 0; second < 1000; second++) {
    const text = new Date(second * 1000).toISOString()
    expect(intradayInstantNanos(text)).toBe(BigInt(second) * 1_000_000_000n)
  }
  for (const instant of instants) expect(intradayInstantNanos(instant.text)).toBe(instant.expected)
})
