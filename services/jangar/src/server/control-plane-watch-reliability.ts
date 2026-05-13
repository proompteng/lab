import { resolveControlPlaneWatchReliabilityConfig } from './control-plane-config'

type ControlPlaneWatchReliabilityStream = {
  resource: string
  namespace: string
  events: number
  errors: number
  restarts: number
  last_seen_at: string
  error_reasons?: Record<string, number>
  restart_reasons?: Record<string, number>
}

export type ControlPlaneWatchReliabilitySummary = {
  status: 'healthy' | 'degraded' | 'unknown'
  window_minutes: number
  observed_streams: number
  total_events: number
  total_errors: number
  total_restarts: number
  streams: ControlPlaneWatchReliabilityStream[]
}

type WatchEventType = 'event' | 'error' | 'restart'

type ReasonedWatchEvent = {
  observedAt: number
  reason: string
}

type WatchStreamState = {
  events: number[]
  errors: ReasonedWatchEvent[]
  restarts: ReasonedWatchEvent[]
  lastSeenAt: number
  resource: string
  namespace: string
}

const MAX_RECORDED_STREAMS = 200
const TOP_STREAM_LIMIT = 10
const MINUTE_MS = 60_000

const normalize = (value: string) => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : 'unknown'
}

const normalizeReason = (value: string | undefined) => normalize(value ?? 'unknown')

const resolveWindowMinutes = () => resolveControlPlaneWatchReliabilityConfig(process.env).windowMinutes

const resolveStreamLimit = () =>
  Math.min(resolveControlPlaneWatchReliabilityConfig(process.env).streamLimit, MAX_RECORDED_STREAMS)

const resolveRestartDegradeThreshold = () =>
  resolveControlPlaneWatchReliabilityConfig(process.env).restartDegradeThreshold

const windowStartMs = (now: number, windowMinutes: number) => now - windowMinutes * MINUTE_MS

const prune = (values: number[], cutoffMs: number) => {
  while (values.length > 0 && values[0] < cutoffMs) {
    values.shift()
  }
}

const pruneReasonedEvents = (values: ReasonedWatchEvent[], cutoffMs: number) => {
  while (values.length > 0 && values[0].observedAt < cutoffMs) {
    values.shift()
  }
}

const streamStore = new Map<string, WatchStreamState>()
const makeStreamKey = (resource: string, namespace: string) => `${normalize(resource)}||${normalize(namespace)}`

const readStreamState = (resource: string, namespace: string) => {
  const normalizedResource = normalize(resource)
  const normalizedNamespace = normalize(namespace)
  const key = makeStreamKey(normalizedResource, normalizedNamespace)
  let state = streamStore.get(key)
  if (!state) {
    state = {
      events: [],
      errors: [],
      restarts: [],
      lastSeenAt: Date.now(),
      resource: normalizedResource,
      namespace: normalizedNamespace,
    }
    streamStore.set(key, state)
  }
  if (streamStore.size > MAX_RECORDED_STREAMS) {
    const oldest = [...streamStore.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0]
    if (oldest) {
      streamStore.delete(oldest[0])
    }
  }
  return state
}

const record = (eventType: WatchEventType, input: { resource: string; namespace: string; reason?: string }) => {
  const now = Date.now()
  const state = readStreamState(input.resource, input.namespace)
  state.lastSeenAt = now
  if (eventType === 'event') {
    state.events.push(now)
  } else if (eventType === 'error') {
    state.errors.push({ observedAt: now, reason: normalizeReason(input.reason) })
  } else {
    state.restarts.push({ observedAt: now, reason: normalizeReason(input.reason) })
  }
}

export const recordWatchReliabilityEvent = (input: { resource: string; namespace: string }) => {
  record('event', input)
}

export const recordWatchReliabilityError = (input: { resource: string; namespace: string; reason?: string }) => {
  record('error', input)
}

export const recordWatchReliabilityRestart = (input: { resource: string; namespace: string; reason?: string }) => {
  record('restart', input)
}

const mapReasonsToRecord = (events: ReasonedWatchEvent[]) => {
  const reasons = new Map<string, number>()
  for (const event of events) {
    reasons.set(event.reason, (reasons.get(event.reason) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...reasons.entries()].filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export const getWatchReliabilitySummary = (): ControlPlaneWatchReliabilitySummary => {
  const now = Date.now()
  const windowMinutes = resolveWindowMinutes()
  const cutoffMs = windowStartMs(now, windowMinutes)
  const observedStreams = new Array<ControlPlaneWatchReliabilityStream>()

  let totalEvents = 0
  let totalErrors = 0
  let totalRestarts = 0

  for (const [key, state] of streamStore.entries()) {
    prune(state.events, cutoffMs)
    pruneReasonedEvents(state.errors, cutoffMs)
    pruneReasonedEvents(state.restarts, cutoffMs)

    const hasRecentActivity =
      state.events.length > 0 || state.errors.length > 0 || state.restarts.length > 0 || state.lastSeenAt >= cutoffMs

    if (!hasRecentActivity) {
      streamStore.delete(key)
      continue
    }

    const events = state.events.length
    const errors = state.errors.length
    const restarts = state.restarts.length
    observedStreams.push({
      resource: state.resource,
      namespace: state.namespace,
      events,
      errors,
      restarts,
      last_seen_at: new Date(state.lastSeenAt).toISOString(),
      error_reasons: mapReasonsToRecord(state.errors),
      restart_reasons: mapReasonsToRecord(state.restarts),
    })

    totalEvents += events
    totalErrors += errors
    totalRestarts += restarts
  }

  const streamLimit = resolveStreamLimit()
  observedStreams.sort((a, b) => {
    const delta = b.errors + b.restarts - (a.errors + a.restarts)
    if (delta !== 0) return delta
    return b.events - a.events
  })
  const topStreams = observedStreams.slice(0, Math.min(streamLimit, TOP_STREAM_LIMIT))
  const restartDegradeThreshold = resolveRestartDegradeThreshold()
  const maxStreamRestarts = observedStreams.reduce((currentMax, stream) => Math.max(currentMax, stream.restarts), 0)

  const status =
    totalErrors > 0 || maxStreamRestarts >= restartDegradeThreshold
      ? 'degraded'
      : observedStreams.length > 0
        ? 'healthy'
        : 'unknown'

  return {
    status,
    window_minutes: windowMinutes,
    observed_streams: observedStreams.length,
    total_events: totalEvents,
    total_errors: totalErrors,
    total_restarts: totalRestarts,
    streams: topStreams,
  }
}

export const clearWatchReliabilityState = () => {
  streamStore.clear()
}
