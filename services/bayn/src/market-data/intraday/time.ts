const nanosPerMillisecond = 1_000_000n

export const intradayInstantNanos = (value: string): bigint => {
  const withoutZulu = value.slice(0, -1)
  const separator = withoutZulu.lastIndexOf('.')
  const seconds = withoutZulu.slice(0, separator)
  const fractional = withoutZulu.slice(separator + 1).padEnd(9, '0')
  return BigInt(Date.parse(`${seconds}.000Z`)) * nanosPerMillisecond + BigInt(fractional)
}

export const compareIntradayInstants = (left: string, right: string): number => {
  const leftNanos = intradayInstantNanos(left)
  const rightNanos = intradayInstantNanos(right)
  return leftNanos < rightNanos ? -1 : leftNanos > rightNanos ? 1 : 0
}

export const intradayAgeNanos = (later: string, earlier: string): bigint =>
  intradayInstantNanos(later) - intradayInstantNanos(earlier)

export const millisecondsAsNanos = (value: number): bigint => BigInt(value) * nanosPerMillisecond
