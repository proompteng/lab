import {
  normalizeOptionalMemoryNoteNamespace,
  parsePersistMemoryNoteInput,
  parseRetrieveMemoryNotesInput,
  parseListMemoryNotesInput,
  parseMemoryNoteId,
  parseRetireMemoryNoteInput,
} from '@proompteng/agent-contracts'

import { errorResponse, okResponse, parseJsonBody } from '../http'
import { createPostgresMemoriesStore, type MemoriesStore } from '../memory-notes-store'

export type MemoryNotesApiDependencies = {
  storeFactory?: () => MemoriesStore
}

const getStore = (deps: MemoryNotesApiDependencies) => (deps.storeFactory ?? createPostgresMemoriesStore)()

const resolveServiceError = (message: string) => (message.includes('DATABASE_URL') ? 503 : 500)

const parsePositiveInt = (value: string | null, fallback: number, min: number, max: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export const getMemoryNotesHandler = async (request: Request, deps: MemoryNotesApiDependencies = {}) => {
  const url = new URL(request.url)
  const input = { ...Object.fromEntries(url.searchParams), tags: url.searchParams.getAll('tag') }
  const mode = url.searchParams.get('mode') ?? 'search'
  if (mode !== 'search' && mode !== 'latest') return errorResponse('mode must be search or latest.', 400)
  const parsed = mode === 'latest' ? parseListMemoryNotesInput(input) : parseRetrieveMemoryNotesInput(input)
  if (!parsed.ok) return errorResponse(parsed.message, 400)

  let store: MemoriesStore | undefined
  try {
    store = getStore(deps)
    if (mode === 'latest') return okResponse(await store.list(parsed.value))
    return okResponse({
      ok: true,
      memories: await store.retrieve({ ...parsed.value, query: url.searchParams.get('query') ?? '' }),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message === 'Memory cursor note not found.' ? 400 : resolveServiceError(message))
  } finally {
    await store?.close()
  }
}

export const getMemoryNoteHandler = async (request: Request, id: string, deps: MemoryNotesApiDependencies = {}) => {
  const parsed = parseMemoryNoteId(id)
  if (!parsed.ok) return errorResponse(parsed.message, 400)
  let store: MemoriesStore | undefined
  try {
    store = getStore(deps)
    const note = await store.get(parsed.value)
    return note ? okResponse({ ok: true, memory: note }) : errorResponse('Memory note not found.', 404)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, resolveServiceError(message))
  } finally {
    await store?.close()
  }
}

export const postRetireMemoryNoteHandler = async (request: Request, deps: MemoryNotesApiDependencies = {}) => {
  let payload: Record<string, unknown>
  try {
    payload = await parseJsonBody(request)
  } catch {
    return errorResponse('invalid JSON body', 400)
  }
  const parsed = parseRetireMemoryNoteInput(payload)
  if (!parsed.ok) return errorResponse(parsed.message, 400)
  let store: MemoriesStore | undefined
  try {
    store = getStore(deps)
    return okResponse({ ok: true, memory: await store.retire(parsed.value) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status =
      message === 'Memory note not found.'
        ? 404
        : message.includes('already retired')
          ? 409
          : message.startsWith('Replacement must')
            ? 400
            : resolveServiceError(message)
    return errorResponse(message, status)
  } finally {
    await store?.close()
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

  let store: MemoriesStore | undefined
  try {
    store = getStore(deps)
    const record = await store.persist(parsed.value)
    return okResponse({ ok: true, memory: record })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, resolveServiceError(message))
  } finally {
    await store?.close()
  }
}

export const getMemoryNotesCountHandler = async (request: Request, deps: MemoryNotesApiDependencies = {}) => {
  const url = new URL(request.url)
  const namespace = normalizeOptionalMemoryNoteNamespace(url.searchParams.get('namespace'))

  let store: MemoriesStore | undefined
  try {
    store = getStore(deps)
    const count = await store.count({ namespace })
    return okResponse({ ok: true, count })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, resolveServiceError(message))
  } finally {
    await store?.close()
  }
}

export const getMemoryNotesStatsHandler = async (request: Request, deps: MemoryNotesApiDependencies = {}) => {
  const url = new URL(request.url)
  const namespace = normalizeOptionalMemoryNoteNamespace(url.searchParams.get('namespace'))
  const days = parsePositiveInt(url.searchParams.get('days'), 30, 1, 365)
  const topNamespaces = parsePositiveInt(url.searchParams.get('topNamespaces'), 8, 1, 25)

  let store: MemoriesStore | undefined
  try {
    store = getStore(deps)
    const stats = await store.stats({ namespace, days, topNamespaces })
    return okResponse({ ok: true, ...stats })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, resolveServiceError(message))
  } finally {
    await store?.close()
  }
}
