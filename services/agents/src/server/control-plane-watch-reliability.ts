import { Context, Data, Effect, Layer } from 'effect'

import type { ControlPlaneWatchReliability } from './control-plane-status-contract'

type EnvSource = Record<string, string | undefined>

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

export type WatchReliabilityStore = Map<string, WatchStreamState>

export type WatchReliabilityLabels = {
  resource: string
  namespace: string
  reason?: string
}

export type WatchReliabilityConfig = {
  windowMinutes: number
  streamLimit: number
  restartDegradeThreshold: number
}

export type ControlPlaneWatchReliabilityDependencies = {
  env?: EnvSource
  now?: () => Date
  store?: WatchReliabilityStore
}

export type ControlPlaneWatchReliabilityService = {
  recordEvent: (labels: Omit<WatchReliabilityLabels, 'reason'>) => Effect.Effect<void>
  recordError: (labels: WatchReliabilityLabels) => Effect.Effect<void>
  recordRestart: (labels: WatchReliabilityLabels) => Effect.Effect<void>
  summarize: () => Effect.Effect<ControlPlaneWatchReliability, ControlPlaneWatchReliabilityError>
  clear: () => Effect.Effect<void>
}

export class ControlPlaneWatchReliabilityError extends Data.TaggedError('ControlPlaneWatchReliabilityError')<{
  readonly operation: string
  readonly message: string
}> {}

export class ControlPlaneWatchReliabilityApi extends Context.Tag('ControlPlaneWatchReliabilityApi')<
  ControlPlaneWatchReliabilityApi,
  ControlPlaneWatchReliabilityService
>() {}

const DEFAULT_WATCH_WINDOW_MINUTES = 15
const DEFAULT_WATCH_STREAM_LIMIT = 20
const DEFAULT_WATCH_RESTART_DEGRADE_THRESHOLD = 2
const MAX_RECORDED_STREAMS = 200
const TOP_STREAM_LIMIT = 10
const MAX_WINDOW_MINUTES = 24 * 60
const MINUTE_MS = 60_000

const defaultStore: WatchReliabilityStore = new Map()

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (value: string | undefined, fallback: number, minimum = 1, maximum?: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback
  const bounded = Math.floor(parsed)
  return maximum === undefined ? bounded : Math.min(bounded, maximum)
}

export const resolveControlPlaneWatchReliabilityConfig = (env: EnvSource = process.env): WatchReliabilityConfig => ({
  windowMinutes: parsePositiveInt(
    normalizeNonEmpty(env.AGENTS_CONTROL_PLANE_WATCH_HEALTH_WINDOW_MINUTES) ?? undefined,
    DEFAULT_WATCH_WINDOW_MINUTES,
    1,
    MAX_WINDOW_MINUTES,
  ),
  streamLimit: parsePositiveInt(
    normalizeNonEmpty(env.AGENTS_CONTROL_PLANE_WATCH_HEALTH_STREAM_LIMIT) ?? undefined,
    DEFAULT_WATCH_STREAM_LIMIT,
    1,
    MAX_RECORDED_STREAMS,
  ),
  restartDegradeThreshold: parsePositiveInt(
    normalizeNonEmpty(env.AGENTS_CONTROL_PLANE_WATCH_HEALTH_RESTART_DEGRADE_THRESHOLD) ?? undefined,
    DEFAULT_WATCH_RESTART_DEGRADE_THRESHOLD,
    1,
  ),
})

const normalize = (value: string) => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : 'unknown'
}

const normalizeReason = (value: string | undefined) => normalize(value ?? 'unknown')

const makeStreamKey = (resource: string, namespace: string) => `${normalize(resource)}||${normalize(namespace)}`

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

const readStreamState = (input: {
  store: WatchReliabilityStore
  resource: string
  namespace: string
  observedAt: number
}) => {
  const normalizedResource = normalize(input.resource)
  const normalizedNamespace = normalize(input.namespace)
  const key = makeStreamKey(normalizedResource, normalizedNamespace)
  let state = input.store.get(key)
  if (!state) {
    state = {
      events: [],
      errors: [],
      restarts: [],
      lastSeenAt: input.observedAt,
      resource: normalizedResource,
      namespace: normalizedNamespace,
    }
    input.store.set(key, state)
  }
  if (input.store.size > MAX_RECORDED_STREAMS) {
    const oldest = [...input.store.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0]
    if (oldest) {
      input.store.delete(oldest[0])
    }
  }
  return state
}

const record = (
  store: WatchReliabilityStore,
  now: () => Date,
  eventType: WatchEventType,
  input: WatchReliabilityLabels,
) =>
  Effect.sync(() => {
    const observedAt = now().getTime()
    const state = readStreamState({ store, resource: input.resource, namespace: input.namespace, observedAt })
    state.lastSeenAt = observedAt
    if (eventType === 'event') {
      state.events.push(observedAt)
    } else if (eventType === 'error') {
      state.errors.push({ observedAt, reason: normalizeReason(input.reason) })
    } else {
      state.restarts.push({ observedAt, reason: normalizeReason(input.reason) })
    }
  })

const mapReasonsToRecord = (events: ReasonedWatchEvent[]) => {
  const reasons = new Map<string, number>()
  for (const event of events) {
    reasons.set(event.reason, (reasons.get(event.reason) ?? 0) + 1)
  }
  return Object.fromEntries(
    [...reasons.entries()].filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export const createControlPlaneWatchReliabilityService = ({
  env = process.env,
  now = () => new Date(),
  store = defaultStore,
}: ControlPlaneWatchReliabilityDependencies = {}): ControlPlaneWatchReliabilityService => ({
  recordEvent: (labels) => record(store, now, 'event', labels),
  recordError: (labels) => record(store, now, 'error', labels),
  recordRestart: (labels) => record(store, now, 'restart', labels),
  summarize: () =>
    Effect.try({
      try: () => {
        const observedAt = now().getTime()
        const config = resolveControlPlaneWatchReliabilityConfig(env)
        const cutoffMs = windowStartMs(observedAt, config.windowMinutes)
        const observedStreams = new Array<ControlPlaneWatchReliability['streams'][number]>()

        let totalEvents = 0
        let totalErrors = 0
        let totalRestarts = 0

        for (const [key, state] of store.entries()) {
          prune(state.events, cutoffMs)
          pruneReasonedEvents(state.errors, cutoffMs)
          pruneReasonedEvents(state.restarts, cutoffMs)

          const hasRecentActivity =
            state.events.length > 0 ||
            state.errors.length > 0 ||
            state.restarts.length > 0 ||
            state.lastSeenAt >= cutoffMs

          if (!hasRecentActivity) {
            store.delete(key)
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

        observedStreams.sort((a, b) => {
          const delta = b.errors + b.restarts - (a.errors + a.restarts)
          if (delta !== 0) return delta
          return b.events - a.events
        })
        const topStreams = observedStreams.slice(0, Math.min(config.streamLimit, TOP_STREAM_LIMIT))
        const maxStreamRestarts = observedStreams.reduce(
          (currentMax, stream) => Math.max(currentMax, stream.restarts),
          0,
        )
        const status =
          totalErrors > 0 || maxStreamRestarts >= config.restartDegradeThreshold
            ? 'degraded'
            : observedStreams.length > 0
              ? 'healthy'
              : 'unknown'

        return {
          status,
          window_minutes: config.windowMinutes,
          observed_streams: observedStreams.length,
          total_events: totalEvents,
          total_errors: totalErrors,
          total_restarts: totalRestarts,
          streams: topStreams,
        }
      },
      catch: (error) =>
        new ControlPlaneWatchReliabilityError({
          operation: 'summarize-watch-reliability',
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
  clear: () => Effect.sync(() => store.clear()),
})

export const ControlPlaneWatchReliabilityApiLive = Layer.succeed(
  ControlPlaneWatchReliabilityApi,
  createControlPlaneWatchReliabilityService(),
)

const defaultService = () => createControlPlaneWatchReliabilityService()

export const recordWatchReliabilityEvent = (input: Omit<WatchReliabilityLabels, 'reason'>) =>
  Effect.runSync(defaultService().recordEvent(input))

export const recordWatchReliabilityError = (input: WatchReliabilityLabels) =>
  Effect.runSync(defaultService().recordError(input))

export const recordWatchReliabilityRestart = (input: WatchReliabilityLabels) =>
  Effect.runSync(defaultService().recordRestart(input))

export const getWatchReliabilitySummary = (deps: ControlPlaneWatchReliabilityDependencies = {}) =>
  Effect.runSync(createControlPlaneWatchReliabilityService(deps).summarize())

export const clearWatchReliabilityState = () => Effect.runSync(defaultService().clear())
