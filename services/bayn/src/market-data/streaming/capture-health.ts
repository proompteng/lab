import { Clock, Effect, Metric, type Scope } from 'effect'
import type { NativeArrivalCapture, NativeArrivalCaptureFactory } from './native-arrival-journal'

/** Operational evidence only: no transport values, identities, or completeness claim. */
export interface CaptureHealth {
  readonly observedAtSeconds: number
  readonly activeCaptures: number
  readonly incompleteCaptures: number
  readonly pendingStagnantSeconds: number
  readonly terminalFailures: number
}

export const makeCaptureHealth = () => {
  const captures = new Map<
    NativeArrivalCapture,
    { durable: number; pendingSince: number | undefined; failed: boolean }
  >()
  let terminalFailures = 0
  const read = (capture: NativeArrivalCapture, now: number) => {
    const previous = captures.get(capture)
    if (previous === undefined) return
    const status = capture.status()
    if (status.status === 'INCOMPLETE' && !previous.failed) {
      previous.failed = true
      terminalFailures++
    }
    const pending = status.status === 'RECORDING' && status.observedConsumerSequence > status.durableConsumerSequence
    if (!pending) previous.pendingSince = undefined
    else if (previous.pendingSince === undefined || previous.durable !== status.durableConsumerSequence)
      previous.pendingSince = now
    previous.durable = status.durableConsumerSequence
    return { status, pendingSince: previous.pendingSince }
  }
  return {
    wrap:
      (factory: NativeArrivalCaptureFactory): NativeArrivalCaptureFactory =>
      (bootstrap, sources) =>
        Effect.gen(function* () {
          let capture: NativeArrivalCapture | undefined
          // Registered before the journal: its finalizer runs first, so failed sealing is retained.
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              if (capture === undefined) return
              read(capture, 0)
              captures.delete(capture)
            }),
          )
          capture = yield* factory(bootstrap, sources)
          captures.set(capture, {
            durable: capture.status().durableConsumerSequence,
            pendingSince: undefined,
            failed: false,
          })
          return capture
        }),
    sample: (monotonicSeconds: number, observedAtSeconds: number): CaptureHealth => {
      let incompleteCaptures = 0
      let pendingStagnantSeconds = 0
      for (const capture of captures.keys()) {
        const value = read(capture, monotonicSeconds)
        if (value?.status.status === 'INCOMPLETE') incompleteCaptures++
        if (value?.pendingSince !== undefined)
          pendingStagnantSeconds = Math.max(pendingStagnantSeconds, monotonicSeconds - value.pendingSince)
      }
      return {
        observedAtSeconds,
        activeCaptures: captures.size,
        incompleteCaptures,
        pendingStagnantSeconds,
        terminalFailures,
      }
    },
  }
}

interface Owner {
  health: CaptureHealth | undefined
  reportedFailures: number
}
const registries = new WeakMap<object, Map<string, Set<Owner>>>()
const expected = Metric.gauge('bayn_capture_workers_expected')
const missing = Metric.gauge('bayn_capture_workers_unobserved')
const active = Metric.gauge('bayn_capture_active')
const incomplete = Metric.gauge('bayn_capture_incomplete')
const stagnant = Metric.gauge('bayn_capture_pending_stagnant_seconds')
const observed = Metric.gauge('bayn_capture_observation_timestamp_seconds')
const lastFailure = Metric.gauge('bayn_capture_last_failure_observed_timestamp_seconds')
const failures = Metric.counter('bayn_capture_terminal_failures_total', { incremental: true })

/** Scope-owned parent observation; one failed or missing sibling cannot be averaged away. */
export const observeCaptureWorker = Effect.gen(function* () {
  const registry = yield* Metric.MetricRegistry
  const attributes = yield* Metric.CurrentMetricAttributes
  const key = JSON.stringify(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)))
  let groups = registries.get(registry)
  if (groups === undefined) {
    groups = new Map()
    registries.set(registry, groups)
  }
  let owners = groups.get(key)
  if (owners === undefined) {
    owners = new Set()
    groups.set(key, owners)
  }
  const group = owners
  const owner: Owner = { health: undefined, reportedFailures: 0 }
  group.add(owner)
  const record = Effect.gen(function* () {
    const now = (yield* Clock.currentTimeMillis) / 1000
    let unknown = 0
    let captures = 0
    let failed = 0
    let pending = 0
    let newFailures = 0
    for (const entry of group) {
      const health = entry.health
      if (health === undefined || health.observedAtSeconds < now - 45 || health.observedAtSeconds > now + 5) {
        unknown++
      } else {
        captures += health.activeCaptures
        failed += health.incompleteCaptures
        pending = Math.max(pending, health.pendingStagnantSeconds)
      }
      if (health !== undefined && health.terminalFailures > entry.reportedFailures) {
        newFailures += health.terminalFailures - entry.reportedFailures
        entry.reportedFailures = health.terminalFailures
      }
    }
    if (newFailures > 0) {
      yield* Metric.update(failures, newFailures)
      yield* Metric.update(lastFailure, now)
    }
    yield* Metric.update(expected, group.size)
    yield* Metric.update(missing, unknown)
    yield* Metric.update(active, captures)
    yield* Metric.update(incomplete, failed)
    yield* Metric.update(stagnant, pending)
    yield* Metric.update(observed, now)
  })
  yield* Effect.addFinalizer(() =>
    record.pipe(
      Effect.andThen(Effect.sync(() => group.delete(owner))),
      Effect.andThen(record),
      Effect.andThen(
        Effect.sync(() => {
          if (group.size === 0) groups?.delete(key)
        }),
      ),
    ),
  )
  yield* record
  yield* Effect.forever(Effect.sleep('15 seconds').pipe(Effect.andThen(record))).pipe(Effect.forkScoped)
  return (health: CaptureHealth) => {
    owner.health = health
  }
}) satisfies Effect.Effect<(health: CaptureHealth) => void, never, Scope.Scope>
