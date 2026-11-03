import { Clock, Effect, Option } from 'effect'

import { ValkeyCache } from '../valkey-cache'

export const valkeyFixture = () => {
  const values = new Map<string, { value: string; expiresAt: number }>()
  const put: ValkeyCache['Service']['put'] = ({ key, value, ttlMs }) =>
    Effect.gen(function* () {
      values.set(key, { value, expiresAt: (yield* Clock.currentTimeMillis) + ttlMs })
    })
  const cache = ValkeyCache.of({
    get: (key) =>
      Effect.gen(function* () {
        const value = values.get(key)
        return value === undefined || value.expiresAt <= (yield* Clock.currentTimeMillis)
          ? Option.none()
          : Option.some(value.value)
      }),
    put,
    putAll: (writes) => Effect.forEach(writes, put, { discard: true }),
    remove: (key) =>
      Effect.sync(() => {
        values.delete(key)
      }),
  })
  return { cache, values }
}
