export interface IdempotencyConfig {
  ttlMs: number
  maxEntries: number
}

export interface IdempotencyStore {
  /** Resolves only after this delivery's broker write succeeds. */
  run: (key: string, publish: () => Promise<void>) => Promise<boolean>
}

export const createIdempotencyStore = ({ ttlMs, maxEntries }: IdempotencyConfig): IdempotencyStore => {
  const pending = new Map<string, Promise<void>>()
  const committed = new Map<string, number>()
  return {
    async run(key, publish) {
      const now = Date.now()
      for (const [id, expiry] of committed) if (expiry <= now) committed.delete(id)
      if (committed.has(key)) return true
      const existing = pending.get(key)
      if (existing) {
        await existing
        return true
      }
      if (pending.size >= 128) throw new Error('Kafka admission capacity exhausted')
      const write = Promise.resolve().then(publish)
      pending.set(key, write)
      try {
        await write
        if (ttlMs > 0 && maxEntries > 0) {
          committed.set(key, Date.now() + ttlMs)
          while (committed.size > maxEntries) {
            const oldest = committed.keys().next().value
            if (oldest === undefined) break
            committed.delete(oldest)
          }
        }
        return false
      } finally {
        pending.delete(key)
      }
    },
  }
}
