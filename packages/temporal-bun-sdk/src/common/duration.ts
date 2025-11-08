import type { Duration } from '@bufbuild/protobuf/wkt'
import { durationFromMs, durationMs } from '@bufbuild/protobuf/wkt'

export const durationFromMillis = (ms?: number): Duration | undefined => {
  if (ms === undefined || !Number.isFinite(ms) || ms <= 0) {
    return undefined
  }
  return durationFromMs(ms)
}

export const durationToMillis = (duration?: Duration): number | undefined => {
  if (!duration) {
    return undefined
  }
  return durationMs(duration)
}
