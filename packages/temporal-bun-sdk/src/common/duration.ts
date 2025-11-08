import type { Duration } from '@bufbuild/protobuf/wkt'

const NANOS_PER_MILLISECOND = 1_000_000
const MILLIS_PER_SECOND = 1_000

export const durationFromMillis = (ms?: number): Duration | undefined => {
  if (ms === undefined) {
    return undefined
  }
  const seconds = BigInt(Math.trunc(ms / MILLIS_PER_SECOND))
  const nanos = Math.trunc(ms % MILLIS_PER_SECOND) * NANOS_PER_MILLISECOND
  return {
    seconds,
    nanos,
  }
}

export const durationToMillis = (duration?: Duration): number | undefined => {
  if (!duration) {
    return undefined
  }
  const seconds = Number(duration.seconds ?? 0n)
  const nanos = duration.nanos ?? 0
  return seconds * MILLIS_PER_SECOND + Math.trunc(nanos / NANOS_PER_MILLISECOND)
}
