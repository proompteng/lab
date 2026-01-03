type HashRecord = Record<string, string>

export class RedisClient {
  connected = false
  private store = new Map<string, HashRecord>()
  private url: string

  constructor(url: string) {
    this.url = url
  }

  async connect() {
    void this.url
    this.connected = true
  }

  async hget(key: string, field: string) {
    return this.store.get(key)?.[field] ?? null
  }

  async hset(key: string, fields: HashRecord) {
    const existing = this.store.get(key) ?? {}
    this.store.set(key, { ...existing, ...fields })
  }

  async expire(_key: string, _ttlSeconds: number) {}

  async del(key: string) {
    this.store.delete(key)
  }

  close() {
    this.connected = false
  }
}
