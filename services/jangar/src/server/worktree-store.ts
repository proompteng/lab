import { Effect, pipe } from 'effect'

import { createBunRedisClient, type BunRedisClient } from './bun-redis-client'

export const WORKTREE_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_PREFIX = 'openwebui:worktree'

export type WorktreeStore = {
  getWorktreeName: (chatId: string) => Effect.Effect<string | null, Error>
  setWorktreeName: (chatId: string, worktreeName: string) => Effect.Effect<void, Error>
  clearWorktree: (chatId: string) => Effect.Effect<void, Error>
  shutdown: () => Effect.Effect<void, Error>
}

type WorktreeStoreOptions = {
  url?: string
  prefix?: string
}

const redisError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const createRedisWorktreeStore = (options: WorktreeStoreOptions = {}): WorktreeStore => {
  const url = options.url ?? process.env.JANGAR_REDIS_URL
  if (!url) {
    throw new Error('JANGAR_REDIS_URL is required for worktree storage')
  }

  const prefix = (options.prefix ?? process.env.JANGAR_WORKTREE_KEY_PREFIX ?? DEFAULT_PREFIX).replace(/:+$/, '')
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
        await client.expire(redisKey, WORKTREE_TTL_SECONDS)
      },
      catch: (error) => redisError(`set ttl on ${redisKey}`, error),
    })

  const getWorktreeName: WorktreeStore['getWorktreeName'] = (chatId) =>
    withClient(async (client) => {
      const value = await client.hget(key(chatId), 'name')
      return typeof value === 'string' && value.length > 0 ? value : null
    })

  const setWorktreeName: WorktreeStore['setWorktreeName'] = (chatId, worktreeName) =>
    pipe(
      withClient(async (client) => {
        const redisKey = key(chatId)
        await client.hset(redisKey, { name: worktreeName })
        return { client, redisKey }
      }),
      Effect.flatMap(({ client, redisKey }) => ensureExpiry(client, redisKey)),
    )

  const clearWorktree: WorktreeStore['clearWorktree'] = (chatId) =>
    withClient(async (client) => {
      await client.del(key(chatId))
    })

  const shutdown: WorktreeStore['shutdown'] = () =>
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
    getWorktreeName,
    setWorktreeName,
    clearWorktree,
    shutdown,
  }
}

export const createInMemoryWorktreeStore = (): WorktreeStore => {
  const worktrees = new Map<string, string>()

  return {
    getWorktreeName: (chatId) => Effect.succeed(worktrees.get(chatId) ?? null),
    setWorktreeName: (chatId, worktreeName) =>
      Effect.sync(() => {
        worktrees.set(chatId, worktreeName)
      }),
    clearWorktree: (chatId) =>
      Effect.sync(() => {
        worktrees.delete(chatId)
      }),
    shutdown: () => Effect.void,
  }
}
