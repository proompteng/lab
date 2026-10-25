type Hash = Map<string, string | number>

export class RedisClient {
  private store = new Map<string, Hash>()
  connected = false

  async connect() {
    this.connected = true
  }

  async hget(key: string, field: string) {
    return this.store.get(key)?.get(field) ?? null
  }

  async hset(key: string, fields: Record<string, string | number>) {
    const hash = this.store.get(key) ?? new Map()
    for (const [field, value] of Object.entries(fields)) {
      hash.set(field, value)
    }
    this.store.set(key, hash)
  }

  async hincrby(key: string, field: string, increment: number) {
    const hash = this.store.get(key) ?? new Map()
    const current = Number(hash.get(field) ?? 0)
    const next = current + increment
    hash.set(field, next)
    this.store.set(key, hash)
    return next
  }

  async expire(_key: string, _seconds: number) {
    // no-op for stub
  }

  async del(...keys: string[]) {
    for (const key of keys) {
      this.store.delete(key)
    }
  }

  async close() {
    this.connected = false
    this.store.clear()
  }
}

export default { RedisClient }
