type ControlPlaneWatchReliabilityStream = {
  resource: string
  namespace: string
  events: number
  errors: number
  restarts: number
  last_seen_at: string
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

type WatchStreamState = {
  events: number[]
  errors: number[]
  restarts: number[]
  lastSeenAt: number
  resource: string
  namespace: string
}

const DEFAULT_WINDOW_MINUTES = 15
const DEFAULT_STREAM_LIMIT = 20
const DEFAULT_RESTART_DEGRADE_THRESHOLD = 2
const MAX_RECORDED_STREAMS = 200
const TOP_STREAM_LIMIT = 10
const MINUTE_MS = 60_000

const normalize = (value: string) => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : 'unknown'
}

const resolveWindowMinutes = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_WATCH_HEALTH_WINDOW_MINUTES?.trim()
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_WINDOW_MINUTES
  return Math.min(Math.max(Math.floor(parsed), 1), 24 * 60)
}

const resolveStreamLimit = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_WATCH_HEALTH_STREAM_LIMIT?.trim()
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STREAM_LIMIT
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_RECORDED_STREAMS)
}

const resolveRestartDegradeThreshold = () => {
  const raw = process.env.JANGAR_CONTROL_PLANE_WATCH_HEALTH_RESTART_DEGRADE_THRESHOLD?.trim()
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RESTART_DEGRADE_THRESHOLD
  return Math.max(1, Math.floor(parsed))
}

const windowStartMs = (now: number, windowMinutes: number) => now - windowMinutes * MINUTE_MS

const prune = (values: number[], cutoffMs: number) => {
  while (values.length > 0 && values[0] < cutoffMs) {
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

const record = (eventType: WatchEventType, input: { resource: string; namespace: string }) => {
  const now = Date.now()
  const state = readStreamState(input.resource, input.namespace)
  state.lastSeenAt = now
  if (eventType === 'event') {
    state.events.push(now)
  } else if (eventType === 'error') {
    state.errors.push(now)
  } else {
    state.restarts.push(now)
  }
}

export const recordWatchReliabilityEvent = (input: { resource: string; namespace: string }) => {
  record('event', input)
}

export const recordWatchReliabilityError = (input: { resource: string; namespace: string }) => {
  record('error', input)
}

export const recordWatchReliabilityRestart = (input: { resource: string; namespace: string }) => {
  record('restart', input)
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
    prune(state.errors, cutoffMs)
    prune(state.restarts, cutoffMs)

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

  const status =
    totalErrors > 0 || totalRestarts >= restartDegradeThreshold
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
