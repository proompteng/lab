import { Effect, pipe } from 'effect'

import { createBunRedisClient, type BunRedisClient } from './bun-redis-client'
import { parseTranscriptSignature, type TranscriptEntry } from './chat-transcript'

export const TRANSCRIPT_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_PREFIX = 'openwebui:transcript'

export type ChatTranscriptStore = {
  getTranscript: (chatId: string) => Effect.Effect<TranscriptEntry[] | null, Error>
  setTranscript: (chatId: string, signature: TranscriptEntry[]) => Effect.Effect<void, Error>
  clearTranscript: (chatId: string) => Effect.Effect<void, Error>
  shutdown: () => Effect.Effect<void, Error>
}

type ChatTranscriptStoreOptions = {
  url?: string
  prefix?: string
}

const redisError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

export const createRedisChatTranscriptStore = (options: ChatTranscriptStoreOptions = {}): ChatTranscriptStore => {
  const url = options.url ?? process.env.JANGAR_REDIS_URL
  if (!url) {
    throw new Error('JANGAR_REDIS_URL is required for OpenWebUI chat transcript storage')
  }

  const prefix = (options.prefix ?? process.env.JANGAR_TRANSCRIPT_KEY_PREFIX ?? DEFAULT_PREFIX).replace(/:+$/, '')
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
        await client.expire(redisKey, TRANSCRIPT_TTL_SECONDS)
      },
      catch: (error) => redisError(`set ttl on ${redisKey}`, error),
    })

  const getTranscript: ChatTranscriptStore['getTranscript'] = (chatId) =>
    withClient(async (client) => {
      const value = await client.get(key(chatId))
      if (typeof value !== 'string' || value.length === 0) return null
      try {
        const parsed = parseTranscriptSignature(JSON.parse(value))
        return parsed ?? null
      } catch {
        return null
      }
    })

  const setTranscript: ChatTranscriptStore['setTranscript'] = (chatId, signature) =>
    pipe(
      withClient(async (client) => {
        const redisKey = key(chatId)
        await client.set(redisKey, JSON.stringify(signature))
        return { client, redisKey }
      }),
      Effect.flatMap(({ client, redisKey }) => ensureExpiry(client, redisKey)),
    )

  const clearTranscript: ChatTranscriptStore['clearTranscript'] = (chatId) =>
    withClient(async (client) => {
      await client.del(key(chatId))
    })

  const shutdown: ChatTranscriptStore['shutdown'] = () =>
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
    getTranscript,
    setTranscript,
    clearTranscript,
    shutdown,
  }
}

export const createInMemoryChatTranscriptStore = (): ChatTranscriptStore => {
  const transcripts = new Map<string, TranscriptEntry[]>()

  return {
    getTranscript: (chatId) => Effect.succeed(transcripts.get(chatId) ?? null),
    setTranscript: (chatId, signature) =>
      Effect.sync(() => {
        transcripts.set(
          chatId,
          signature.map((entry) => ({ ...entry })),
        )
      }),
    clearTranscript: (chatId) =>
      Effect.sync(() => {
        transcripts.delete(chatId)
      }),
    shutdown: () => Effect.void,
  }
}
