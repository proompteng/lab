import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  directory?: string
  url?: string
  prefix?: string
}

const redisError = (message: string, error: unknown) =>
  new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`)

const serializeBlob = (blob: OpenWebUiRenderBlob) => JSON.stringify(blob)
const shouldDebugOpenWebUIRenderStore = () => process.env.JANGAR_DEBUG_OPENWEBUI_RENDER_STORE === '1'

const debugOpenWebUIRenderStore = (event: string, details: Record<string, unknown>) => {
  if (!shouldDebugOpenWebUIRenderStore()) return
  console.info(`[openwebui-render-store] ${event}`, details)
}

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
  renderId?: string
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
    renderId: args.renderId ?? randomUUID(),
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
      const blob = parseBlob(await redis.get(key(renderId)))
      debugOpenWebUIRenderStore('redis:get', {
        renderId,
        hit: blob != null,
        kind: blob?.kind ?? null,
        logicalId: blob?.logicalId ?? null,
      })
      return blob
    },
    setRenderBlob: async (blob) => {
      const redis = await getRedis()
      const redisKey = key(blob.renderId)
      await redis.set(redisKey, serializeBlob(blob))
      await redis.expire(redisKey, OPENWEBUI_RENDER_BLOB_TTL_SECONDS)
      debugOpenWebUIRenderStore('redis:set', {
        renderId: blob.renderId,
        kind: blob.kind,
        logicalId: blob.logicalId,
        redisKey,
      })
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

const sanitizePrefix = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, '-')

export const createFileOpenWebUiRenderStore = (options: OpenWebUiRenderStoreOptions = {}): OpenWebUiRenderStore => {
  const prefix = sanitizePrefix(
    (options.prefix ?? process.env.JANGAR_OPENWEBUI_RENDER_KEY_PREFIX ?? DEFAULT_PREFIX).replace(/:+$/, ''),
  )
  const directory = options.directory ?? process.env.JANGAR_OPENWEBUI_RENDER_DIRECTORY ?? join(tmpdir(), prefix)
  let ensuredDirectoryPromise: Promise<void> | null = null

  const ensureDirectory = () => {
    if (!ensuredDirectoryPromise) {
      ensuredDirectoryPromise = mkdir(directory, { recursive: true }).then(() => undefined)
    }
    return ensuredDirectoryPromise
  }

  const filePath = (renderId: string) => join(directory, `${prefix}-${renderId}.json`)

  return {
    getRenderBlob: async (renderId) => {
      await ensureDirectory()
      try {
        const blob = parseBlob(await readFile(filePath(renderId), 'utf8'))
        debugOpenWebUIRenderStore('file:get', {
          renderId,
          hit: blob != null,
          kind: blob?.kind ?? null,
          logicalId: blob?.logicalId ?? null,
          path: filePath(renderId),
        })
        return blob
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
        throw error
      }
    },
    setRenderBlob: async (blob) => {
      await ensureDirectory()
      const path = filePath(blob.renderId)
      await writeFile(path, serializeBlob(blob), 'utf8')
      debugOpenWebUIRenderStore('file:set', {
        renderId: blob.renderId,
        kind: blob.kind,
        logicalId: blob.logicalId,
        path,
      })
    },
    clearRenderBlob: async (renderId) => {
      await ensureDirectory()
      await rm(filePath(renderId), { force: true })
    },
    clearAll: async () => {
      await ensureDirectory()
      const entries = await readdir(directory, { withFileTypes: true })
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith('.json'))
          .map((entry) => rm(join(directory, entry.name), { force: true })),
      )
    },
    shutdown: async () => {},
  }
}

export const createInMemoryOpenWebUiRenderStore = (): OpenWebUiRenderStore => {
  const blobs = new Map<string, OpenWebUiRenderBlob>()

  return {
    getRenderBlob: async (renderId) => {
      const blob = blobs.get(renderId) ?? null
      debugOpenWebUIRenderStore('memory:get', {
        renderId,
        hit: blob != null,
        kind: blob?.kind ?? null,
        logicalId: blob?.logicalId ?? null,
        size: blobs.size,
      })
      return blob
    },
    setRenderBlob: async (blob) => {
      blobs.set(blob.renderId, structuredClone(blob))
      debugOpenWebUIRenderStore('memory:set', {
        renderId: blob.renderId,
        kind: blob.kind,
        logicalId: blob.logicalId,
        size: blobs.size,
      })
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

const globalState = globalThis as typeof globalThis & {
  __jangarOpenWebUiRenderStore?: OpenWebUiRenderStore | null
}

const getDefaultRenderStore = () => globalState.__jangarOpenWebUiRenderStore ?? null

const setDefaultRenderStore = (store: OpenWebUiRenderStore | null) => {
  globalState.__jangarOpenWebUiRenderStore = store
}

export const getOpenWebUiRenderStore = () => {
  const existing = getDefaultRenderStore()
  if (existing) {
    debugOpenWebUIRenderStore('reuse', { mode: 'existing' })
    return existing
  }

  const storeMode = process.env.JANGAR_OPENWEBUI_RENDER_STORE_MODE?.trim().toLowerCase()
  const store =
    storeMode === 'memory'
      ? createInMemoryOpenWebUiRenderStore()
      : storeMode === 'file'
        ? createFileOpenWebUiRenderStore()
        : shouldUseInMemoryChatStateStore()
          ? process.env.NODE_ENV === 'test'
            ? createInMemoryOpenWebUiRenderStore()
            : createFileOpenWebUiRenderStore()
          : createRedisOpenWebUiRenderStore()
  debugOpenWebUIRenderStore('create', {
    requestedMode: storeMode ?? null,
    resolvedMode:
      storeMode === 'memory'
        ? 'memory'
        : storeMode === 'file'
          ? 'file'
          : shouldUseInMemoryChatStateStore()
            ? process.env.NODE_ENV === 'test'
              ? 'memory'
              : 'file'
            : 'redis',
    nodeEnv: process.env.NODE_ENV ?? null,
  })
  setDefaultRenderStore(store)
  return store
}

export const resolveOpenWebUIRenderStore = getOpenWebUiRenderStore

export const setOpenWebUiRenderStoreForTests = (store: OpenWebUiRenderStore | null) => {
  setDefaultRenderStore(store)
}

export const resetOpenWebUiRenderStoreForTests = async () => {
  const defaultRenderStore = getDefaultRenderStore()
  if (!defaultRenderStore) return
  try {
    await defaultRenderStore.clearAll()
  } catch (error) {
    throw redisError('clear default openwebui render store', error)
  } finally {
    await defaultRenderStore.shutdown().catch(() => undefined)
    setDefaultRenderStore(null)
  }
}

export const resetOpenWebUIRenderStoreForTests = resetOpenWebUiRenderStoreForTests
