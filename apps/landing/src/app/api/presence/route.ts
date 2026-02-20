import { createHash, randomUUID } from 'node:crypto'
import { ConvexHttpClient } from 'convex/browser'
import { makeFunctionReference } from 'convex/server'
import { type NextRequest, NextResponse } from 'next/server'
import {
  getPresenceTtlSeconds,
  isPresenceEvent,
  LIVE_PRESENCE_COOKIE_NAME,
  LIVE_PRESENCE_ENABLED,
  LIVE_PRESENCE_SITE,
  normalizePresencePath,
} from '@/lib/live-presence'

const BOT_USER_AGENT_RE =
  /(bot|spider|crawler|headless|slurp|curl|wget|python-requests|httpclient|scrapy|facebookexternalhit|preview)/i
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/
const VISITOR_ID_RE = /^[a-zA-Z0-9-]{16,128}$/
const trackPresenceMutation = makeFunctionReference<'mutation'>('presence:track')

type PresenceRequestBody = {
  event?: unknown
  sessionId?: unknown
  path?: unknown
}

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  if (!LIVE_PRESENCE_ENABLED) {
    return emptySuccess()
  }

  const userAgent = request.headers.get('user-agent') ?? ''
  if (isLikelyBot(userAgent)) {
    return emptySuccess()
  }

  const payload = await parseBody(request)
  if (!payload || !isPresenceEvent(payload.event) || !isValidSessionId(payload.sessionId)) {
    return NextResponse.json({ error: 'invalid presence payload' }, { status: 400, headers: noStoreHeaders() })
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!convexUrl) {
    return emptySuccess()
  }

  const existingVisitorId = request.cookies.get(LIVE_PRESENCE_COOKIE_NAME)?.value
  const visitorId = isValidVisitorId(existingVisitorId) ? existingVisitorId : randomUUID()
  const shouldSetCookie = visitorId !== existingVisitorId
  const now = Date.now()
  const ttlMs = getPresenceTtlSeconds() * 1000
  const convex = new ConvexHttpClient(convexUrl)

  try {
    await convex.mutation(trackPresenceMutation, {
      site: LIVE_PRESENCE_SITE,
      sessionId: payload.sessionId,
      visitorIdHash: hashValue(visitorId),
      path: normalizePresencePath(payload.path ?? '/'),
      event: payload.event,
      now,
      ttlMs,
    })
  } catch (error) {
    console.error('presence tracking failed', error)
    return NextResponse.json({ error: 'failed to track presence' }, { status: 500, headers: noStoreHeaders() })
  }

  const response = NextResponse.json({ ok: true }, { headers: noStoreHeaders() })
  if (shouldSetCookie) {
    response.cookies.set({
      name: LIVE_PRESENCE_COOKIE_NAME,
      value: visitorId,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 365,
      path: '/',
    })
  }

  return response
}

async function parseBody(
  request: NextRequest,
): Promise<{ event: 'join' | 'heartbeat' | 'leave'; sessionId: string; path?: string } | null> {
  let parsed: PresenceRequestBody

  try {
    parsed = (await request.json()) as PresenceRequestBody
  } catch {
    return null
  }

  if (!isPresenceEvent(parsed.event)) {
    return null
  }

  if (typeof parsed.sessionId !== 'string') {
    return null
  }

  if (parsed.path !== undefined && typeof parsed.path !== 'string') {
    return null
  }

  return {
    event: parsed.event,
    sessionId: parsed.sessionId,
    path: parsed.path,
  }
}

function isLikelyBot(userAgent: string) {
  return BOT_USER_AGENT_RE.test(userAgent)
}

function isValidSessionId(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false
  }

  return SESSION_ID_RE.test(value)
}

function isValidVisitorId(value: string | undefined): value is string {
  if (!value) {
    return false
  }

  return VISITOR_ID_RE.test(value)
}

function hashValue(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function noStoreHeaders() {
  return {
    'Cache-Control': 'no-store',
  }
}

function emptySuccess() {
  return new NextResponse(null, {
    status: 204,
    headers: noStoreHeaders(),
  })
}
