import { Effect, pipe } from 'effect'

import { createBunRedisClient, type BunRedisClient } from './bun-redis-client'
import { resolveRedisConfig } from './storage-config'

export const THREAD_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_PREFIX = 'openwebui:chat'

export type ChatThreadStore = {
  getThread: (chatId: string) => Effect.Effect<string | null, Error>
  setThread: (chatId: string, threadId: string) => Effect.Effect<void, Error>
  nextTurn: (chatId: string) => Effect.Effect<number, Error>
  clearThread: (chatId: string) => Effect.Effect<void, Error>
  clearAll: () => Effect.Effect<void, Error>
  shutdown: () => Effect.Effect<void, Error>
}

type ChatThreadStoreOptions = {
  url?: string
  prefix?: string
}

const redisError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const createRedisChatThreadStore = (options: ChatThreadStoreOptions = {}): ChatThreadStore => {
  const redisConfig = resolveRedisConfig(process.env)
  const url = options.url ?? redisConfig.url
  if (!url) {
    throw new Error('JANGAR_REDIS_URL is required for OpenWebUI chat thread storage')
  }

  const prefix = (options.prefix ?? redisConfig.chatKeyPrefix ?? DEFAULT_PREFIX).replace(/:+$/, '')
  let redisPromise: Promise<BunRedisClient> | null = null

  const getRedis = async () => {
    if (!redisPromise) {
      redisPromise = createBunRedisClient(url)
    }
    return redisPromise
  }

  const connectEffect = Effect.tryPromise({
    try: async () => {
      const redis = await getRedis()
      if (!redis.connected) {
        await redis.connect()
      }
      return redis
    },
    catch: (error) => redisError('connect to redis', error),
  })

  const withClient = <A>(fn: (client: BunRedisClient) => Promise<A>) =>
    pipe(
      connectEffect,
      Effect.flatMap((client) =>
        Effect.tryPromise({
          try: () => fn(client),
          catch: (error) => redisError('redis operation failed', error),
        }),
      ),
    )

  const key = (chatId: string) => `${prefix}:${chatId}`

  const ensureExpiry = (client: BunRedisClient, redisKey: string) =>
    Effect.tryPromise({
      try: async () => {
        await client.expire(redisKey, THREAD_TTL_SECONDS)
      },
      catch: (error) => redisError(`set ttl on ${redisKey}`, error),
    })

  const getThread: ChatThreadStore['getThread'] = (chatId) =>
    withClient(async (client) => {
      const value = await client.hget(key(chatId), 'thread')
      return typeof value === 'string' && value.length > 0 ? value : null
    })

  const setThread: ChatThreadStore['setThread'] = (chatId, threadId) =>
    pipe(
      withClient(async (client) => {
        const redisKey = key(chatId)
        await client.hset(redisKey, { thread: threadId })
        return { client, redisKey }
      }),
      Effect.flatMap(({ client, redisKey }) => ensureExpiry(client, redisKey)),
    )

  const nextTurn: ChatThreadStore['nextTurn'] = (chatId) =>
    pipe(
      withClient(async (client) => {
        const redisKey = key(chatId)
        const turn = await client.hincrby(redisKey, 'turn', 1)
        return { client, redisKey, turn }
      }),
      Effect.tap(({ client, redisKey }) => ensureExpiry(client, redisKey)),
      Effect.map(({ turn }) => (typeof turn === 'number' ? turn : Number(turn))),
    )

  const clearThread: ChatThreadStore['clearThread'] = (chatId) =>
    withClient(async (client) => {
      await client.del(key(chatId))
    })

  const clearAll: ChatThreadStore['clearAll'] = () =>
    withClient(async (client) => {
      let cursor: string | number = 0
      const pattern = `${prefix}:*`

      do {
        const [nextCursor, keys]: [string | number, string[]] = await client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          100,
        )
        if (keys.length > 0) {
          await client.del(...keys)
        }
        cursor = nextCursor
      } while (Number(cursor) !== 0)
    })

  const shutdown: ChatThreadStore['shutdown'] = () =>
    Effect.tryPromise({
      try: async () => {
        const redis = redisPromise ? await redisPromise : null
        if (redis?.connected) {
          redis.close()
        }
      },
      catch: (error) => redisError('close redis client', error),
    })

  return {
    getThread,
    setThread,
    nextTurn,
    clearThread,
    clearAll,
    shutdown,
  }
}

export const createInMemoryChatThreadStore = (): ChatThreadStore => {
  const records = new Map<string, { threadId: string | null; turn: number }>()

  return {
    getThread: (chatId) => Effect.succeed(records.get(chatId)?.threadId ?? null),
    setThread: (chatId, threadId) =>
      Effect.sync(() => {
        const current = records.get(chatId)
        records.set(chatId, {
          threadId,
          turn: current?.turn ?? 0,
        })
      }),
    nextTurn: (chatId) =>
      Effect.sync(() => {
        const current = records.get(chatId)
        const nextTurnNumber = (current?.turn ?? 0) + 1
        records.set(chatId, {
          threadId: current?.threadId ?? null,
          turn: nextTurnNumber,
        })
        return nextTurnNumber
      }),
    clearThread: (chatId) =>
      Effect.sync(() => {
        records.delete(chatId)
      }),
    clearAll: () =>
      Effect.sync(() => {
        records.clear()
      }),
    shutdown: () => Effect.void,
  }
}
