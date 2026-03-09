import { randomUUID } from 'node:crypto'

import { createBunRedisClient, type BunRedisClient } from './bun-redis-client'
import { shouldUseInMemoryChatStateStore } from './chat-state-store-mode'

export const OPENWEBUI_RENDER_BLOB_TTL_SECONDS = 60 * 60 * 24 * 7
const DEFAULT_PREFIX = 'openwebui:render'

export type OpenWebUiRenderLane = 'message' | 'reasoning' | 'plan' | 'rate_limits' | 'tool' | 'usage' | 'error'

export type OpenWebUiRenderBlob = {
  version: 'v1'
  renderId: string
  kind: string
  logicalId: string
  lane: OpenWebUiRenderLane
  payload: Record<string, unknown>
  preview?: {
    title?: string
    subtitle?: string
    badge?: string
  }
  messageBindingHash: string
  createdAt: string
  expiresAt: string
}

export type OpenWebUIRenderBlob = OpenWebUiRenderBlob

export type OpenWebUiRenderStore = {
  getRenderBlob: (renderId: string) => Promise<OpenWebUiRenderBlob | null>
  setRenderBlob: (blob: OpenWebUiRenderBlob) => Promise<void>
  clearRenderBlob: (renderId: string) => Promise<void>
  clearAll: () => Promise<void>
  shutdown: () => Promise<void>
}

type OpenWebUiRenderStoreOptions = {
  url?: string
  prefix?: string
}

const redisError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

const serializeBlob = (blob: OpenWebUiRenderBlob) => JSON.stringify(blob)

const parseBlob = (value: unknown): OpenWebUiRenderBlob | null => {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed = JSON.parse(value) as Partial<OpenWebUiRenderBlob> | null
    if (!parsed || parsed.version !== 'v1' || typeof parsed.renderId !== 'string') return null
    if (typeof parsed.kind !== 'string' || typeof parsed.logicalId !== 'string' || typeof parsed.lane !== 'string') {
      return null
    }
    if (!parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) return null
    if (typeof parsed.messageBindingHash !== 'string') return null
    if (typeof parsed.createdAt !== 'string' || typeof parsed.expiresAt !== 'string') return null
    return parsed as OpenWebUiRenderBlob
  } catch {
    return null
  }
}

export const createOpenWebUiRenderBlob = (args: {
  kind: string
  logicalId: string
  lane: OpenWebUiRenderLane
  payload: Record<string, unknown>
  preview?: OpenWebUiRenderBlob['preview']
  messageBindingHash: string
  expiresAt: string
}) =>
  ({
    version: 'v1',
    renderId: randomUUID(),
    kind: args.kind,
    logicalId: args.logicalId,
    lane: args.lane,
    payload: structuredClone(args.payload),
    preview: args.preview ? { ...args.preview } : undefined,
    messageBindingHash: args.messageBindingHash,
    createdAt: new Date().toISOString(),
    expiresAt: args.expiresAt,
  }) satisfies OpenWebUiRenderBlob

export const createOpenWebUIRenderBlob = createOpenWebUiRenderBlob

export const createRedisOpenWebUiRenderStore = (options: OpenWebUiRenderStoreOptions = {}): OpenWebUiRenderStore => {
  const url = options.url ?? process.env.JANGAR_REDIS_URL
  if (!url) {
    throw new Error('JANGAR_REDIS_URL is required for OpenWebUI rich render storage')
  }

  const prefix = (options.prefix ?? process.env.JANGAR_OPENWEBUI_RENDER_KEY_PREFIX ?? DEFAULT_PREFIX).replace(/:+$/, '')
  let redisPromise: Promise<BunRedisClient> | null = null

  const getRedis = async () => {
    if (!redisPromise) {
      redisPromise = createBunRedisClient(url)
    }
    const redis = await redisPromise
    if (!redis.connected) {
      await redis.connect()
    }
    return redis
  }

  const key = (renderId: string) => `${prefix}:${renderId}`

  return {
    getRenderBlob: async (renderId) => {
      const redis = await getRedis()
      return parseBlob(await redis.get(key(renderId)))
    },
    setRenderBlob: async (blob) => {
      const redis = await getRedis()
      const redisKey = key(blob.renderId)
      await redis.set(redisKey, serializeBlob(blob))
      await redis.expire(redisKey, OPENWEBUI_RENDER_BLOB_TTL_SECONDS)
    },
    clearRenderBlob: async (renderId) => {
      const redis = await getRedis()
      await redis.del(key(renderId))
    },
    clearAll: async () => {
      const redis = await getRedis()
      let cursor: string | number = 0
      const pattern = `${prefix}:*`
      do {
        const [nextCursor, keys]: [string | number, string[]] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        if (keys.length > 0) {
          await redis.del(...keys)
        }
        cursor = nextCursor
      } while (Number(cursor) !== 0)
    },
    shutdown: async () => {
      const redis = redisPromise ? await redisPromise : null
      if (redis?.connected) {
        redis.close()
      }
    },
  }
}

export const createInMemoryOpenWebUiRenderStore = (): OpenWebUiRenderStore => {
  const blobs = new Map<string, OpenWebUiRenderBlob>()

  return {
    getRenderBlob: async (renderId) => blobs.get(renderId) ?? null,
    setRenderBlob: async (blob) => {
      blobs.set(blob.renderId, structuredClone(blob))
    },
    clearRenderBlob: async (renderId) => {
      blobs.delete(renderId)
    },
    clearAll: async () => {
      blobs.clear()
    },
    shutdown: async () => {},
  }
}

let defaultRenderStore: OpenWebUiRenderStore | null = null

export const getOpenWebUiRenderStore = () => {
  if (!defaultRenderStore) {
    defaultRenderStore = shouldUseInMemoryChatStateStore()
      ? createInMemoryOpenWebUiRenderStore()
      : createRedisOpenWebUiRenderStore()
  }
  return defaultRenderStore
}

export const resolveOpenWebUIRenderStore = getOpenWebUiRenderStore

export const setOpenWebUiRenderStoreForTests = (store: OpenWebUiRenderStore | null) => {
  defaultRenderStore = store
}

export const resetOpenWebUiRenderStoreForTests = async () => {
  if (!defaultRenderStore) return
  try {
    await defaultRenderStore.clearAll()
  } catch (error) {
    throw redisError('clear default openwebui render store', error)
  } finally {
    await defaultRenderStore.shutdown().catch(() => undefined)
    defaultRenderStore = null
  }
}

export const resetOpenWebUIRenderStoreForTests = resetOpenWebUiRenderStoreForTests
