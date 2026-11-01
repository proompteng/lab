import 'server-only'

import { getPlatformIdentity } from '@/lib/platform/auth'

import { OfzError } from '../platform/ofz'
import { reportServerError } from '@/lib/observability/server'

type RateWindow = { count: number; resetsAt: number }
export type ReadPlatformJsonBodyOptions = Readonly<{
  subject?: string
  totalTimeoutMs?: number
  inactivityTimeoutMs?: number
  maxBytes?: number
}>

const RATE_WINDOW_MS = 60_000
const SUBJECT_LIMIT = 120
const RATE_WINDOW_CAP = 20_000
export const MAX_ACTION_BODY_BYTES = 24 * 1024 * 1024 + 64 * 1024
export const MAX_CONCURRENT_ACTION_BODIES = 4
export const MAX_CONCURRENT_ACTION_BODIES_PER_SUBJECT = 2
export const BODY_TOTAL_TIMEOUT_MS = 15_000
export const BODY_INACTIVITY_TIMEOUT_MS = 5_000

export class PlatformRequestError extends Error {
  constructor(
    message: string,
    readonly status = 503,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'PlatformRequestError'
  }
}

export async function requirePlatformIdentity(request: Request) {
  const identity = await getRateLimitedPlatformIdentity(request)
  if (!identity) throw new PlatformRequestError('GitHub sign-in is required', 401)
  return identity
}

export function requireSameOrigin(request: Request) {
  const expectedOrigin = configuredAuthOrigin()
  const requestOrigin = request.headers.get('origin')
  if (request.headers.get('sec-fetch-site') === 'cross-site' || requestOrigin !== expectedOrigin) {
    throw new PlatformRequestError('Cross-origin actions are not allowed', 403)
  }
}

export function requireSameOriginGet(request: Request) {
  const expectedOrigin = configuredAuthOrigin()
  const fetchSite = request.headers.get('sec-fetch-site')
  const requestOrigin = request.headers.get('origin')
  const sameOriginMetadata = fetchSite === 'same-origin'
  const matchingOrigin = requestOrigin === expectedOrigin

  if (
    (!sameOriginMetadata && !matchingOrigin) ||
    (fetchSite !== null && !sameOriginMetadata) ||
    (requestOrigin !== null && !matchingOrigin)
  ) {
    throw new PlatformRequestError('Cross-origin actions are not allowed', 403)
  }
}

export async function getRateLimitedPlatformIdentity(request: Request) {
  const identity = await getPlatformIdentity(request.headers)
  if (!identity) return null
  const blocked = isPlatformRateLimited(identity.subject)
  if (blocked) throw new PlatformRequestError('Request rate limit exceeded', 429)
  return identity
}

export function platformRouteError(error: unknown) {
  const status =
    error instanceof OfzError || error instanceof PlatformRequestError
      ? error.status
      : error instanceof SyntaxError
        ? 400
        : error instanceof Error && error.name === 'AbortError'
          ? 499
          : 500
  if (status >= 500) reportServerError(error, 'platform.request', status)
  if (error instanceof OfzError) {
    return Response.json(
      { error: error.message, auditReceiptId: error.auditReceiptId },
      { status: error.status, headers: noStoreHeaders() },
    )
  }
  if (error instanceof PlatformRequestError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders() },
    )
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: 'Request body is invalid JSON' }, { status: 400, headers: noStoreHeaders() })
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return Response.json({ error: error.message }, { status: 499, headers: noStoreHeaders() })
  }
  return Response.json({ error: 'Request failed unexpectedly' }, { status: 500, headers: noStoreHeaders() })
}

export async function readPlatformJsonBody(
  request: Request,
  options: ReadPlatformJsonBodyOptions = {},
): Promise<unknown> {
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) {
    throw new PlatformRequestError('Invalid request size configuration')
  }
  const maxBytes =
    options.maxBytes === undefined
      ? MAX_ACTION_BODY_BYTES
      : Math.min(MAX_ACTION_BODY_BYTES, Math.max(1, options.maxBytes))
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new PlatformRequestError('Actions require application/json', 415)
  }
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      throw new PlatformRequestError('Request body is too large', 413)
    }
  }

  const body = request.body
  if (!body) throw new SyntaxError('Request body is empty')
  const signal = request.signal
  if (signal?.aborted) throw abortedRequestError()

  const inactivityTimeoutMs = resolveBodyTimeout(options.inactivityTimeoutMs, BODY_INACTIVITY_TIMEOUT_MS)
  const totalTimeoutMs = resolveBodyTimeout(options.totalTimeoutMs, BODY_TOTAL_TIMEOUT_MS)
  const releaseBodySlot = acquireActionBodySlot(options.subject)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let cancelRequested = false
  let finished = false
  let terminationError: Error | undefined
  let rejectRead: ((reason?: unknown) => void) | undefined
  let totalTimer: ReturnType<typeof setTimeout> | undefined
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined
  let abortListenerAttached = false

  const cancelReader = (reason: string) => {
    if (cancelRequested || !reader) return
    cancelRequested = true
    try {
      void Promise.resolve(reader.cancel(reason)).catch(() => undefined)
    } catch {
      // A reader may reject cancellation synchronously after the request has already failed.
    }
  }

  const failForTimeout = () => {
    if (finished) return
    const error = new PlatformRequestError('Request body timed out', 408)
    terminationError = error
    finished = true
    cancelReader(error.message)
    rejectRead?.(error)
  }

  const onAbort = () => {
    if (finished) return
    const error = abortedRequestError()
    terminationError = error
    finished = true
    cancelReader(error.message)
    rejectRead?.(error)
  }

  const clearTimers = () => {
    if (totalTimer !== undefined) clearTimeout(totalTimer)
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer)
    totalTimer = undefined
    inactivityTimer = undefined
  }

  let completed = false

  try {
    reader = body.getReader()
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      abortListenerAttached = true
    }
    if (signal?.aborted) onAbort()

    totalTimer = setTimeout(failForTimeout, totalTimeoutMs)
    const armInactivityTimer = () => {
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(failForTimeout, inactivityTimeoutMs)
    }
    armInactivityTimer()

    const decoder = new TextDecoder('utf-8', { fatal: true })
    let totalBytes = 0
    let text = ''
    while (true) {
      if (terminationError) throw terminationError
      const readAbort = new Promise<never>((_, reject) => {
        rejectRead = reject
      })
      void readAbort.catch(() => undefined)
      let readResult: Awaited<ReturnType<typeof reader.read>>
      try {
        const pendingRead = reader.read()
        void pendingRead.catch(() => undefined)
        readResult = await Promise.race([pendingRead, readAbort])
      } finally {
        rejectRead = undefined
      }
      const { done, value } = readResult
      if (terminationError) throw terminationError
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        cancelReader('Request body is too large')
        throw new PlatformRequestError('Request body is too large', 413)
      }
      try {
        text += decoder.decode(value, { stream: true })
      } catch {
        cancelReader('Request body is not valid UTF-8')
        throw new SyntaxError('Request body is not valid UTF-8')
      }
      if (value.byteLength > 0) armInactivityTimer()
    }
    try {
      text += decoder.decode()
    } catch {
      cancelReader('Request body is not valid UTF-8')
      throw new SyntaxError('Request body is not valid UTF-8')
    }
    completed = true
    return JSON.parse(text)
  } catch (error) {
    if (!completed) cancelReader(error instanceof Error ? error.message : 'Request body read failed')
    throw error
  } finally {
    finished = true
    clearTimers()
    if (signal && abortListenerAttached) {
      try {
        signal.removeEventListener('abort', onAbort)
      } catch {
        // Request cleanup must not prevent returning body capacity.
      }
    }
    if (reader) {
      try {
        reader.releaseLock()
      } catch {
        // Releasing a reader can race an underlying stream cancellation; capacity still must be returned.
      }
    }
    releaseBodySlot()
  }
}

function resolveBodyTimeout(value: number | undefined, fallback: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, value)
}

function abortedRequestError() {
  const error = new Error('Request was canceled')
  error.name = 'AbortError'
  return error
}

function acquireActionBodySlot(subject?: string) {
  const state = globalThis as typeof globalThis & {
    platformActiveActionBodies?: number
    platformActiveActionBodiesBySubject?: Map<string, number>
  }
  const activeBodies = state.platformActiveActionBodies ?? 0
  if (activeBodies >= MAX_CONCURRENT_ACTION_BODIES) {
    throw new PlatformRequestError('Too many concurrent request bodies', 429)
  }
  const subjectActiveBodies = subject ? (state.platformActiveActionBodiesBySubject?.get(subject) ?? 0) : 0
  if (subject && subjectActiveBodies >= MAX_CONCURRENT_ACTION_BODIES_PER_SUBJECT) {
    throw new PlatformRequestError('Too many concurrent request bodies for this subject', 429)
  }
  state.platformActiveActionBodies = activeBodies + 1
  if (subject) {
    const activeBySubject = (state.platformActiveActionBodiesBySubject ??= new Map())
    activeBySubject.set(subject, subjectActiveBodies + 1)
  }

  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (state.platformActiveActionBodies ?? 1) - 1
    if (remaining <= 0) delete state.platformActiveActionBodies
    else state.platformActiveActionBodies = remaining
    if (subject) {
      const activeBySubject = state.platformActiveActionBodiesBySubject
      const subjectRemaining = (activeBySubject?.get(subject) ?? 1) - 1
      if (activeBySubject && subjectRemaining > 0) activeBySubject.set(subject, subjectRemaining)
      else activeBySubject?.delete(subject)
      if (activeBySubject?.size === 0) delete state.platformActiveActionBodiesBySubject
    }
  }
}

export function noStoreHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
  }
}

export function isPlatformRateLimited(subject: string) {
  const state = globalThis as typeof globalThis & {
    platformRateSweepAt?: number
    platformRateWindows?: Map<string, RateWindow>
  }
  const windows = (state.platformRateWindows ??= new Map())
  const now = Date.now()
  if (!state.platformRateSweepAt || state.platformRateSweepAt <= now) {
    for (const [key, window] of windows) {
      if (window.resetsAt <= now) windows.delete(key)
    }
    state.platformRateSweepAt = now + RATE_WINDOW_MS
  }
  return exceeds(windows, `subject:${subject}`, SUBJECT_LIMIT, now)
}

function exceeds(windows: Map<string, RateWindow>, key: string, limit: number, now: number) {
  const current = windows.get(key)
  if (!current || current.resetsAt <= now) {
    if (!current && windows.size >= RATE_WINDOW_CAP) return true
    windows.set(key, { count: 1, resetsAt: now + RATE_WINDOW_MS })
    return false
  }
  current.count += 1
  return current.count > limit
}

function configuredAuthOrigin() {
  const configuredUrl = process.env.PLATFORM_WEB_ORIGIN?.trim() || 'https://proompteng.ai'
  try {
    const url = new URL(configuredUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      throw new Error('Invalid HTTPS desktop origin')
    return url.origin
  } catch {
    throw new PlatformRequestError('Authentication origin is not configured')
  }
}
