import * as Sentry from '@sentry/node'
import { trace } from '@opentelemetry/api'
import { Cause, Effect } from 'effect'
import { embeddedBuildMetadata } from './build'
import type { Reconciliation } from './execution/contracts'
import type { CycleRunnerError } from './cycle/runner/model'
import type { NativeArrivalCaptureError } from './market-data/streaming/native-arrival'

/**
 * Error-only GlitchTip reporting. Existing Effect/OpenTelemetry tracing remains
 * authoritative; the Sentry SDK must not create another tracing pipeline.
 * Neither account data nor broker requests may leave the trading namespace.
 */
let initialized = false
let initializedService = 'bayn'
let reportedReconciliationDiscrepancies: string | undefined

export const sanitizeErrorEvent = (event: Sentry.ErrorEvent): Sentry.ErrorEvent => {
  delete event.user
  delete event.request
  delete event.extra
  delete event.breadcrumbs
  delete event.contexts
  delete event.transaction
  if (event.message !== undefined) event.message = 'Bayn application exception'
  for (const exception of event.exception?.values ?? []) {
    // Preserve the exception class and stack frames for grouping, never the
    // exception message: it may include broker tokens, orders, or raw inputs.
    exception.value = 'Message withheld: potentially sensitive runtime data'
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars
      delete frame.context_line
      delete frame.pre_context
      delete frame.post_context
    }
  }
  return event
}

export const initializeErrorTracking = (service: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  const dsn = env['BAYN_GLITCHTIP_DSN']?.trim()
  if (dsn === undefined || dsn.length === 0) return false
  if (initialized) return true
  const endpoint = new URL(dsn)
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:')
    throw new Error('Bayn GlitchTip DSN must use HTTP(S)')
  if (endpoint.hostname !== 'glitchtip-web.glitchtip.svc.cluster.local') {
    throw new Error('Bayn GlitchTip DSN must use the internal service')
  }
  if (!/^[0-9a-f]{32}$/.test(endpoint.username) || !/^\/[1-9][0-9]*$/.test(endpoint.pathname)) {
    // Django models UUID keys with dashes; Sentry DSNs require a hex public key.
    throw new Error('Bayn GlitchTip DSN has an invalid project key or project ID')
  }
  Sentry.init({
    dsn,
    release: env['BAYN_CODE_REVISION'] || embeddedBuildMetadata?.sourceRevision,
    environment: env['NODE_ENV'] || 'production',
    // Disable SDK auto-instrumentation, request body collection and tracing.
    defaultIntegrations: false,
    enableRuntimeChannelInjection: false,
    enableOpenTelemetrySetup: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    beforeSend: sanitizeErrorEvent,
    integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
  })
  if (Sentry.getClient()?.getDsn() === undefined) {
    throw new Error('Bayn GlitchTip SDK did not accept its configured DSN')
  }
  Sentry.setTag('service', service)
  Sentry.setTag('namespace', 'bayn')
  initializedService = service
  initialized = true
  return true
}

export const reportReconciliationState = (reconciliation: Reconciliation): void => {
  if (!initialized) return
  if (reconciliation.discrepancies.length === 0) {
    reportedReconciliationDiscrepancies = undefined
    return
  }
  const signature = `${reconciliation.accountId}:${reconciliation.discrepancies
    .map((d) => d.discrepancyId)
    .toSorted()
    .join(',')}`
  if (signature === reportedReconciliationDiscrepancies) return
  reportedReconciliationDiscrepancies = signature
  const error = new Error('Reconciliation restricted trading authority')
  error.name = 'ReconciliationDiscrepancyError'
  Sentry.withScope((scope) => {
    scope.setTag('stage', 'bayn.reconciliation')
    scope.setTag('failure_kind', [...new Set(reconciliation.discrepancies.map((d) => d.kind))].toSorted().join(','))
    scope.setTag('reconciliation_id', reconciliation.reconciliationId)
    reportError(error, initializedService)
  })
}

export const reportError = (error: unknown, service: string): void => {
  if (!initialized) return
  Sentry.withScope((scope) => {
    scope.setTag('service', service)
    const traceId = trace.getActiveSpan()?.spanContext().traceId
    if (traceId !== undefined && traceId.length > 0) scope.setTag('trace_id', traceId)
    Sentry.captureException(error)
  })
}

export const reportCyclePassFailure = (error: CycleRunnerError): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!initialized) return
    Sentry.withScope((scope) => {
      scope.setTag('stage', 'bayn.execution.cycle-pass')
      scope.setTag('operation', error.operation)
      scope.setTag('failure', error.failure)
      reportError(error, initializedService)
    })
  }).pipe(Effect.catchCause(() => Effect.logWarning('GlitchTip cycle failure could not be captured')))

export const reportNativeArrivalFailure = (error: NativeArrivalCaptureError): Effect.Effect<void> =>
  Effect.sync(() => {
    if (!initialized) return
    Sentry.withScope((scope) => {
      scope.setTag('stage', 'bayn.market-data.native-arrival')
      scope.setTag('failure', 'retention-incomplete')
      reportError(error, initializedService)
    })
  }).pipe(Effect.catchCause(() => Effect.logWarning('GlitchTip native arrival failure could not be captured')))

/** Process-terminal causes; completed failed cycle passes report at their observation boundary. */
export const reportTerminalFailure =
  (service: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Effect.gen(function* () {
          // Normal Kubernetes shutdown interrupts scoped fibers; it is not an
          // application error and must not create a new issue every rollout.
          if (Cause.hasInterruptsOnly(cause)) return
          reportError(Cause.squash(cause), service)
          const flushed = yield* Effect.promise(() => flushErrorTracking()).pipe(
            Effect.timeout('4 seconds'),
            Effect.catchCause(() => Effect.succeed(false)),
          )
          if (!flushed) yield* Effect.logWarning('GlitchTip terminal error did not flush')
        }),
      ),
    )

export const flushErrorTracking = (timeoutMs = 3_000): Promise<boolean> =>
  initialized ? Sentry.flush(timeoutMs) : Promise.resolve(true)
