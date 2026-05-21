import {
  normalizeOptionalMemoryNoteNamespace,
  parsePersistMemoryNoteInput,
  parseRetrieveMemoryNotesInput,
} from '@proompteng/agent-contracts/memory-client'

import { errorResponse, okResponse, parseJsonBody } from '../http'
import { createPostgresMemoriesStore, type MemoriesStore } from '../memory-notes-store'

export type MemoryNotesApiDependencies = {
  storeFactory?: () => MemoriesStore
}

const getStore = (deps: MemoryNotesApiDependencies) => (deps.storeFactory ?? createPostgresMemoriesStore)()

const closeStore = async (store: MemoriesStore) => {
  await store.close()
}

const resolveServiceError = (message: string) => (message.includes('DATABASE_URL') ? 503 : 500)

const parsePositiveInt = (value: string | null, fallback: number, min: number, max: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export const getMemoryNotesHandler = async (request: Request, deps: MemoryNotesApiDependencies = {}) => {
  const url = new URL(request.url)
  const parsed = parseRetrieveMemoryNotesInput({
    namespace: url.searchParams.get('namespace'),
    query: url.searchParams.get('query') ?? '',
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.ok) return errorResponse(parsed.message, 400)

  const store = getStore(deps)
  try {
    const records = await store.retrieve(parsed.value)
    return okResponse({ ok: true, memories: records })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, resolveServiceError(message))
  } finally {
    await closeStore(store)
  }
}

export const postMemoryNotesHandler = async (request: Request, deps: MemoryNotesApiDependencies = {}) => {
  let payload: Record<string, unknown>
  try {
    payload = await parseJsonBody(request)
  } catch {
    return errorResponse('invalid JSON body', 400)
  }

  const parsed = parsePersistMemoryNoteInput(payload)
  if (!parsed.ok) return errorResponse(parsed.message, 400)

  const store = getStore(deps)
  try {
    const record = await store.persist(parsed.value)
    return okResponse({ ok: true, memory: record }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, resolveServiceError(message))
  } finally {
    await closeStore(store)
  }
}

export const getMemoryNotesCountHandler = async (request: Request, deps: MemoryNotesApiDependencies = {}) => {
  const url = new URL(request.url)
  const namespace = normalizeOptionalMemoryNoteNamespace(url.searchParams.get('namespace'))

  const store = getStore(deps)
  try {
    const count = await store.count({ namespace })
    return okResponse({ ok: true, count })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, resolveServiceError(message))
  } finally {
    await closeStore(store)
  }
}

export const getMemoryNotesStatsHandler = async (request: Request, deps: MemoryNotesApiDependencies = {}) => {
  const url = new URL(request.url)
  const namespace = normalizeOptionalMemoryNoteNamespace(url.searchParams.get('namespace'))
  const days = parsePositiveInt(url.searchParams.get('days'), 30, 1, 365)
  const topNamespaces = parsePositiveInt(url.searchParams.get('topNamespaces'), 8, 1, 25)

  const store = getStore(deps)
  try {
    const stats = await store.stats({ namespace, days, topNamespaces })
    return okResponse({ ok: true, ...stats })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, resolveServiceError(message))
  } finally {
    await closeStore(store)
  }
}
