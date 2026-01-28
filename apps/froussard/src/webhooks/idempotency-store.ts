export interface IdempotencyConfig {
  ttlMs: number
  maxEntries: number
}

export interface IdempotencyStore {
  isDuplicate: (key: string) => boolean
}

export const createIdempotencyStore = ({ ttlMs, maxEntries }: IdempotencyConfig): IdempotencyStore => {
  const boundedTtlMs = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : 0
  const boundedMaxEntries = Number.isFinite(maxEntries) ? Math.max(0, maxEntries) : 0

  if (boundedTtlMs === 0 || boundedMaxEntries === 0) {
    return {
      isDuplicate: () => false,
    }
  }

  const entries = new Map<string, number>()

  const pruneExpired = (now: number) => {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) {
        entries.delete(key)
      }
    }
  }

  return {
    isDuplicate: (key: string) => {
      if (!key) {
        return false
      }

      const now = Date.now()
      pruneExpired(now)

      const expiresAt = entries.get(key)
      if (typeof expiresAt === 'number' && expiresAt > now) {
        return true
      }

      entries.set(key, now + boundedTtlMs)

      while (entries.size > boundedMaxEntries) {
        const oldestKey = entries.keys().next().value
        if (typeof oldestKey !== 'string') {
          break
        }
        entries.delete(oldestKey)
      }

      return false
    },
  }
}
