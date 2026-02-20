export const LIVE_PRESENCE_SITE = 'proompteng.ai'
export const LIVE_PRESENCE_COOKIE_NAME = 'pv_id'
export const LIVE_PRESENCE_HEARTBEAT_SECONDS = 15
export const LIVE_PRESENCE_TTL_SECONDS = 45
export const LIVE_PRESENCE_ENABLED = process.env.NEXT_PUBLIC_ENABLE_LIVE_PRESENCE_COUNTER !== 'false'

const DEFAULT_HEARTBEAT_SECONDS = LIVE_PRESENCE_HEARTBEAT_SECONDS
const DEFAULT_TTL_SECONDS = LIVE_PRESENCE_TTL_SECONDS
const MIN_HEARTBEAT_SECONDS = 5
const MAX_HEARTBEAT_SECONDS = 60
const MIN_TTL_SECONDS = 15
const MAX_TTL_SECONDS = 600

export type PresenceEvent = 'join' | 'heartbeat' | 'leave'

export function isPresenceEvent(value: unknown): value is PresenceEvent {
  return value === 'join' || value === 'heartbeat' || value === 'leave'
}

export function getPresenceHeartbeatSeconds() {
  return parseOptionalNumber(
    process.env.NEXT_PUBLIC_PRESENCE_HEARTBEAT_SECONDS,
    DEFAULT_HEARTBEAT_SECONDS,
    MIN_HEARTBEAT_SECONDS,
    MAX_HEARTBEAT_SECONDS,
  )
}

export function getPresenceTtlSeconds() {
  return parseOptionalNumber(process.env.PRESENCE_TTL_SECONDS, DEFAULT_TTL_SECONDS, MIN_TTL_SECONDS, MAX_TTL_SECONDS)
}

export function normalizePresencePath(path: string) {
  if (!path) {
    return '/'
  }

  if (path.startsWith('/')) {
    return path
  }

  return `/${path}`
}

function parseOptionalNumber(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) {
    return fallback
  }

  if (parsed < min) {
    return min
  }

  if (parsed > max) {
    return max
  }

  return parsed
}
