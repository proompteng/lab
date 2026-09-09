import 'server-only'

import { getTengriIdentity } from '@/lib/tengri/auth'
import { TengriUnavailableError } from '@/lib/tengri/grpc'
import { MAX_EDITABLE_FILE_BYTES } from '@/lib/tengri/schemas'

type RateWindow = { count: number; resetsAt: number }
export type ReadTengriJsonBodyOptions = Readonly<{
  subject?: string
  totalTimeoutMs?: number
  inactivityTimeoutMs?: number
}>

const RATE_WINDOW_MS = 60_000
const SUBJECT_LIMIT = 120
const RATE_WINDOW_CAP = 20_000
export const MAX_TENGRI_ACTION_BODY_BYTES = MAX_EDITABLE_FILE_BYTES * 6 + 64 * 1024
export const MAX_CONCURRENT_TENGRI_ACTION_BODIES = 4
export const MAX_CONCURRENT_TENGRI_ACTION_BODIES_PER_SUBJECT = 2
export const TENGRI_BODY_TOTAL_TIMEOUT_MS = 15_000
export const TENGRI_BODY_INACTIVITY_TIMEOUT_MS = 5_000

export async function requireTengriIdentity(request: Request) {
  const identity = await getRateLimitedTengriIdentity(request)
  if (!identity) throw new TengriUnavailableError('GitHub sign-in is required', 401)
  return identity
}

export function requireSameOrigin(request: Request) {
  const expectedOrigin = configuredAuthOrigin()
  const requestOrigin = request.headers.get('origin')
  if (request.headers.get('sec-fetch-site') === 'cross-site' || requestOrigin !== expectedOrigin) {
    throw new TengriUnavailableError('Cross-origin Tengri actions are not allowed', 403)
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
    throw new TengriUnavailableError('Cross-origin Tengri actions are not allowed', 403)
  }
}

export async function getRateLimitedTengriIdentity(request: Request) {
  const identity = await getTengriIdentity(request.headers)
  if (!identity) return null
  const blocked = isTengriRateLimited(identity.subject)
  if (blocked) throw new TengriUnavailableError('Request rate limit exceeded', 429)
  return identity
}

export function tengriRouteError(error: unknown) {
  if (error instanceof TengriUnavailableError) {
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
  return Response.json({ error: 'Tengri request failed unexpectedly' }, { status: 500, headers: noStoreHeaders() })
}

export async function readTengriJsonBody(request: Request, options: ReadTengriJsonBodyOptions = {}): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw new TengriUnavailableError('Tengri actions require application/json', 415)
  }
  const contentLength = request.headers.get('content-length')
  if (contentLength) {
    const declaredBytes = Number(contentLength)
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_TENGRI_ACTION_BODY_BYTES) {
      throw new TengriUnavailableError('Tengri action body is too large', 413)
    }
  }

  const body = request.body
  if (!body) throw new SyntaxError('Request body is empty')
  const signal = request.signal
  if (signal?.aborted) throw abortedRequestError()

  const inactivityTimeoutMs = resolveBodyTimeout(options.inactivityTimeoutMs, TENGRI_BODY_INACTIVITY_TIMEOUT_MS)
  const totalTimeoutMs = resolveBodyTimeout(options.totalTimeoutMs, TENGRI_BODY_TOTAL_TIMEOUT_MS)
  const releaseBodySlot = acquireTengriActionBodySlot(options.subject)
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
    const error = new TengriUnavailableError('Tengri action body timed out', 408)
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
      if (totalBytes > MAX_TENGRI_ACTION_BODY_BYTES) {
        cancelReader('Tengri action body is too large')
        throw new TengriUnavailableError('Tengri action body is too large', 413)
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
    if (!completed) cancelReader(error instanceof Error ? error.message : 'Tengri action body read failed')
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
  const error = new Error('Tengri request was canceled')
  error.name = 'AbortError'
  return error
}

function acquireTengriActionBodySlot(subject?: string) {
  const state = globalThis as typeof globalThis & {
    tengriActiveActionBodies?: number
    tengriActiveActionBodiesBySubject?: Map<string, number>
  }
  const activeBodies = state.tengriActiveActionBodies ?? 0
  if (activeBodies >= MAX_CONCURRENT_TENGRI_ACTION_BODIES) {
    throw new TengriUnavailableError('Too many concurrent Tengri action bodies', 429)
  }
  const subjectActiveBodies = subject ? (state.tengriActiveActionBodiesBySubject?.get(subject) ?? 0) : 0
  if (subject && subjectActiveBodies >= MAX_CONCURRENT_TENGRI_ACTION_BODIES_PER_SUBJECT) {
    throw new TengriUnavailableError('Too many concurrent Tengri action bodies for this subject', 429)
  }
  state.tengriActiveActionBodies = activeBodies + 1
  if (subject) {
    const activeBySubject = (state.tengriActiveActionBodiesBySubject ??= new Map())
    activeBySubject.set(subject, subjectActiveBodies + 1)
  }

  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (state.tengriActiveActionBodies ?? 1) - 1
    if (remaining <= 0) delete state.tengriActiveActionBodies
    else state.tengriActiveActionBodies = remaining
    if (subject) {
      const activeBySubject = state.tengriActiveActionBodiesBySubject
      const subjectRemaining = (activeBySubject?.get(subject) ?? 1) - 1
      if (activeBySubject && subjectRemaining > 0) activeBySubject.set(subject, subjectRemaining)
      else activeBySubject?.delete(subject)
      if (activeBySubject?.size === 0) delete state.tengriActiveActionBodiesBySubject
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

export function isTengriRateLimited(subject: string) {
  const state = globalThis as typeof globalThis & {
    tengriRateSweepAt?: number
    tengriRateWindows?: Map<string, RateWindow>
  }
  const windows = (state.tengriRateWindows ??= new Map())
  const now = Date.now()
  if (!state.tengriRateSweepAt || state.tengriRateSweepAt <= now) {
    for (const [key, window] of windows) {
      if (window.resetsAt <= now) windows.delete(key)
    }
    state.tengriRateSweepAt = now + RATE_WINDOW_MS
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
  const configuredUrl = process.env.BETTER_AUTH_URL?.trim() || 'http://localhost:3000'
  try {
    return new URL(configuredUrl).origin
  } catch {
    throw new TengriUnavailableError('Tengri authentication origin is not configured')
  }
}
