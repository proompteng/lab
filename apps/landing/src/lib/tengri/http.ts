import 'server-only'

import { getTengriIdentity } from '@/lib/tengri/auth'
import { TengriUnavailableError } from '@/lib/tengri/grpc'
import { MAX_EDITABLE_FILE_BYTES } from '@/lib/tengri/schemas'

type RateWindow = { count: number; resetsAt: number }

const RATE_WINDOW_MS = 60_000
const SUBJECT_LIMIT = 120
const RATE_WINDOW_CAP = 20_000
export const MAX_TENGRI_ACTION_BODY_BYTES = MAX_EDITABLE_FILE_BYTES * 6 + 64 * 1024
export const MAX_CONCURRENT_TENGRI_ACTION_BODIES = 4

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
    return Response.json({ error: error.message }, { status: error.status, headers: noStoreHeaders() })
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: 'Request body is invalid JSON' }, { status: 400, headers: noStoreHeaders() })
  }
  return Response.json({ error: 'Tengri request failed unexpectedly' }, { status: 500, headers: noStoreHeaders() })
}

export async function readTengriJsonBody(request: Request): Promise<unknown> {
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

  if (!request.body) throw new SyntaxError('Request body is empty')
  const releaseBodySlot = acquireTengriActionBodySlot()
  const reader = request.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let totalBytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_TENGRI_ACTION_BODY_BYTES) {
        await reader.cancel('Tengri action body is too large').catch(() => undefined)
        throw new TengriUnavailableError('Tengri action body is too large', 413)
      }
      try {
        text += decoder.decode(value, { stream: true })
      } catch {
        await reader.cancel('Request body is not valid UTF-8').catch(() => undefined)
        throw new SyntaxError('Request body is not valid UTF-8')
      }
    }
    try {
      text += decoder.decode()
    } catch {
      throw new SyntaxError('Request body is not valid UTF-8')
    }
  } finally {
    reader.releaseLock()
    releaseBodySlot()
  }
  return JSON.parse(text)
}

function acquireTengriActionBodySlot() {
  const state = globalThis as typeof globalThis & { tengriActiveActionBodies?: number }
  const activeBodies = state.tengriActiveActionBodies ?? 0
  if (activeBodies >= MAX_CONCURRENT_TENGRI_ACTION_BODIES) {
    throw new TengriUnavailableError('Too many concurrent Tengri action bodies', 429)
  }
  state.tengriActiveActionBodies = activeBodies + 1

  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (state.tengriActiveActionBodies ?? 1) - 1
    if (remaining <= 0) delete state.tengriActiveActionBodies
    else state.tengriActiveActionBodies = remaining
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
