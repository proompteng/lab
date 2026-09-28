export type BunRedisClient = {
  connected: boolean
  connect: () => Promise<void>
  close: () => void
  del: (...keys: string[]) => Promise<unknown>
  expire: (key: string, seconds: number) => Promise<unknown>
  get: (key: string) => Promise<unknown>
  hget: (key: string, field: string) => Promise<unknown>
  hincrby: (key: string, field: string, increment: number) => Promise<number | string>
  hset: (key: string, values: Record<string, string>) => Promise<unknown>
  scan: (
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ) => Promise<[string | number, string[]]>
  set: (key: string, value: string) => Promise<unknown>
}

type BunRedisClientConstructor = new (url: string) => BunRedisClient

let redisClientConstructorPromise: Promise<BunRedisClientConstructor> | null = null
const importRuntimeModule = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>

export const loadBunRedisClientConstructor = async (): Promise<BunRedisClientConstructor> => {
  if (!redisClientConstructorPromise) {
    // Keep the Bun import opaque to Vite's Node runner so the in-memory test path can boot without Bun.
    redisClientConstructorPromise = importRuntimeModule('bun')
      .then((module) => {
        if (typeof module.RedisClient !== 'function') {
          throw new Error('bun RedisClient is unavailable in the current runtime')
        }
        return module.RedisClient as BunRedisClientConstructor
      })
      .catch((error) => {
        redisClientConstructorPromise = null
        throw error
      })
  }

  return redisClientConstructorPromise
}

export const createBunRedisClient = async (url: string): Promise<BunRedisClient> => {
  const RedisClient = await loadBunRedisClientConstructor()
  return new RedisClient(url)
}
