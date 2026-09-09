import type { KubeConfig } from '@kubernetes/client-node'
import { Context, Effect, Layer } from 'effect'

import { buildKubernetesResourceCollectionPath, getNativeKubeClients } from './kube-types'
import {
  recordWatchReliabilityError,
  recordWatchReliabilityEvent,
  recordWatchReliabilityRestart,
} from './control-plane-watch-reliability'
import { startKubernetesWatch } from './kubernetes-watch-client'

type WatchEvent = {
  type?: string
  object?: Record<string, unknown>
}

type WatchMetricLabels = {
  resource: string
  namespace: string
}

type WatchEventMetricLabels = WatchMetricLabels & {
  type: string
}

type WatchReasonMetricLabels = WatchMetricLabels & {
  reason: string
}

export type WatchOptions = {
  resource: string
  namespace: string
  labelSelector?: string
  fieldSelector?: string
  resourceVersion?: string
  restartDelayMs?: number
  maxRestartDelayMs?: number
  rateLimitRestartDelayMs?: number
  rateLimitMaxRestartDelayMs?: number
  onEvent: (event: WatchEvent) => void | Promise<void>
  onError?: (error: Error) => void
  onRestart?: (reason: string) => void | Promise<void>
  logPrefix?: string
}

export type WatchHandle = {
  stop: () => void
}

export type ResourceWatchStarterDependencies = {
  buildWatchPath?: (resource: string, namespace: string) => string | Promise<string>
  defaultLogPrefix?: string
  getKubeConfig?: () => KubeConfig
  recordEvent?: (labels: WatchEventMetricLabels) => void
  recordError?: (labels: WatchReasonMetricLabels) => void
  recordRestart?: (labels: WatchReasonMetricLabels) => void
  startKubernetesWatch?: typeof startKubernetesWatch
}

export type ResourceWatchService = {
  start: (options: WatchOptions) => Effect.Effect<WatchHandle>
}

export class ResourceWatch extends Context.Tag('ResourceWatch')<ResourceWatch, ResourceWatchService>() {}

const DEFAULT_RESTART_DELAY_MS = 2_000
const DEFAULT_MAX_RESTART_DELAY_MS = 60_000
const DEFAULT_RATE_LIMIT_RESTART_DELAY_MS = 30_000
const DEFAULT_RATE_LIMIT_MAX_RESTART_DELAY_MS = 300_000
const MAX_BACKOFF_EXPONENT = 6

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value)

const errorStatusCode = (error: Error) => {
  if (!isRecord(error)) return null
  const statusCode = error.statusCode ?? error.code
  return typeof statusCode === 'number' && Number.isFinite(statusCode) ? statusCode : null
}

const normalizeError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

const isRateLimitError = (error: Error) => errorStatusCode(error) === 429 || error.message.includes('Too Many Requests')

const boundedDelay = (value: number, fallback: number) => {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

const defaultBuildWatchPath = async (resource: string, namespace: string) =>
  buildKubernetesResourceCollectionPath(resource, namespace)

const defaultGetKubeConfig = () => getNativeKubeClients().kubeConfig

export const resetKubectlWatchCompatibilityCacheForTests = () => {
  // no-op: watch compatibility caching was removed when the watch path moved to the native client.
}

export const createResourceWatchStarter = (deps: ResourceWatchStarterDependencies = {}) => {
  const buildWatchPath = deps.buildWatchPath ?? defaultBuildWatchPath
  const getKubeConfig = deps.getKubeConfig ?? defaultGetKubeConfig
  const recordEvent = deps.recordEvent ?? recordWatchReliabilityEvent
  const recordError = deps.recordError ?? recordWatchReliabilityError
  const recordRestart = deps.recordRestart ?? recordWatchReliabilityRestart
  const startWatch = deps.startKubernetesWatch ?? startKubernetesWatch

  return (options: WatchOptions): WatchHandle => {
    const {
      resource,
      namespace,
      labelSelector,
      fieldSelector,
      resourceVersion,
      restartDelayMs = DEFAULT_RESTART_DELAY_MS,
      maxRestartDelayMs = DEFAULT_MAX_RESTART_DELAY_MS,
      rateLimitRestartDelayMs = DEFAULT_RATE_LIMIT_RESTART_DELAY_MS,
      rateLimitMaxRestartDelayMs = DEFAULT_RATE_LIMIT_MAX_RESTART_DELAY_MS,
      onEvent,
      onError,
      onRestart,
      logPrefix = deps.defaultLogPrefix ?? '[agents][watch]',
    } = options

    const kubeConfig = getKubeConfig()
    const baseRestartDelayMs = boundedDelay(restartDelayMs, DEFAULT_RESTART_DELAY_MS)
    const boundedMaxRestartDelayMs = Math.max(
      baseRestartDelayMs,
      boundedDelay(maxRestartDelayMs, DEFAULT_MAX_RESTART_DELAY_MS),
    )
    const boundedRateLimitRestartDelayMs = Math.max(
      baseRestartDelayMs,
      boundedDelay(rateLimitRestartDelayMs, DEFAULT_RATE_LIMIT_RESTART_DELAY_MS),
    )
    const boundedRateLimitMaxRestartDelayMs = Math.max(
      boundedRateLimitRestartDelayMs,
      boundedDelay(rateLimitMaxRestartDelayMs, DEFAULT_RATE_LIMIT_MAX_RESTART_DELAY_MS),
    )

    let stopped = false
    let restartTimer: NodeJS.Timeout | null = null
    let abortController: AbortController | null = null
    let currentResourceVersion = resourceVersion?.trim() ? resourceVersion.trim() : null
    let watchStartResourceVersion: string | null = null
    let sawEventSinceStart = false
    let consecutiveFailureRestarts = 0
    const normalizedResource = resource.trim() ? resource.trim() : 'unknown'
    const normalizedNamespace = namespace.trim() ? namespace.trim() : 'unknown'

    const clearStaleResourceVersionBeforeRestart = () => {
      if (!watchStartResourceVersion || sawEventSinceStart) return
      if (currentResourceVersion !== watchStartResourceVersion) return
      currentResourceVersion = null
    }

    const restartDelayForReason = (reason: string) => {
      if (reason === 'closed') return baseRestartDelayMs
      const exponent = Math.min(Math.max(consecutiveFailureRestarts - 1, 0), MAX_BACKOFF_EXPONENT)
      const multiplier = 2 ** exponent
      if (reason === 'watch_rate_limited' || reason === 'watch_start_rate_limited') {
        return Math.min(boundedRateLimitMaxRestartDelayMs, boundedRateLimitRestartDelayMs * multiplier)
      }
      return Math.min(boundedMaxRestartDelayMs, baseRestartDelayMs * multiplier)
    }

    const scheduleRestart = (reason: string) => {
      if (reason === 'closed') {
        consecutiveFailureRestarts = 0
      } else {
        consecutiveFailureRestarts += 1
      }
      const restartDelay = restartDelayForReason(reason)
      recordRestart({
        resource: normalizedResource,
        namespace: normalizedNamespace,
        reason,
      })
      if (stopped) return
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = setTimeout(() => {
        restartTimer = null
        start()
      }, restartDelay)
      void onRestart?.(reason)
    }

    const handleEventHandlerError = (error: unknown) => {
      if (stopped) return
      const normalizedError = normalizeError(error)
      recordError({
        resource: normalizedResource,
        namespace: normalizedNamespace,
        reason: 'event_handler_error',
      })
      onError?.(new Error(`${logPrefix} ${resource} (${namespace}) event handler failed: ${normalizedError.message}`))
    }

    const handleEvent = (event: WatchEvent) => {
      try {
        void Promise.resolve(onEvent(event)).catch(handleEventHandlerError)
      } catch (error) {
        handleEventHandlerError(error)
      }
    }

    const start = () => {
      if (stopped) return
      watchStartResourceVersion = currentResourceVersion
      sawEventSinceStart = false

      void Promise.resolve(buildWatchPath(resource, namespace))
        .then((path) =>
          startWatch(
            kubeConfig,
            path,
            {
              ...(labelSelector ? { labelSelector } : {}),
              ...(fieldSelector ? { fieldSelector } : {}),
              ...(currentResourceVersion ? { resourceVersion: currentResourceVersion } : {}),
              allowWatchBookmarks: true,
            },
            (type, object) => {
              if (!object || typeof object !== 'object' || Array.isArray(object)) return
              const payload = object as Record<string, unknown>
              const metadata =
                payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
                  ? (payload.metadata as Record<string, unknown>)
                  : null
              const nextResourceVersion =
                typeof metadata?.resourceVersion === 'string' ? metadata.resourceVersion.trim() : ''
              if (nextResourceVersion) {
                currentResourceVersion = nextResourceVersion
              }
              consecutiveFailureRestarts = 0
              sawEventSinceStart = true
              if (type === 'BOOKMARK') return

              recordEvent({
                resource: normalizedResource,
                namespace: normalizedNamespace,
                type,
              })
              handleEvent({ type, object: payload })
            },
            (error) => {
              if (stopped) return
              clearStaleResourceVersionBeforeRestart()
              if (error) {
                const reason = isRateLimitError(error) ? 'watch_rate_limited' : 'watch_error'
                recordError({
                  resource: normalizedResource,
                  namespace: normalizedNamespace,
                  reason,
                })
                onError?.(new Error(`${logPrefix} ${resource} (${namespace}) watch failed: ${error.message}`))
              }
              scheduleRestart(error ? (isRateLimitError(error) ? 'watch_rate_limited' : 'watch_error') : 'closed')
            },
          ),
        )
        .then((controller) => {
          abortController = controller
        })
        .catch((error) => {
          const normalizedError = normalizeError(error)
          const reason = isRateLimitError(normalizedError) ? 'watch_start_rate_limited' : 'watch_start_error'
          recordError({
            resource: normalizedResource,
            namespace: normalizedNamespace,
            reason,
          })
          onError?.(normalizedError)
          scheduleRestart(reason)
        })
    }

    start()

    return {
      stop: () => {
        stopped = true
        if (restartTimer) clearTimeout(restartTimer)
        restartTimer = null
        abortController?.abort()
        abortController = null
      },
    }
  }
}

export const startResourceWatch = createResourceWatchStarter()

export const makeResourceWatchService = (deps: ResourceWatchStarterDependencies = {}): ResourceWatchService => {
  const start = createResourceWatchStarter(deps)
  return {
    start: (options) => Effect.sync(() => start(options)),
  }
}

export const ResourceWatchLive = Layer.succeed(ResourceWatch, makeResourceWatchService())
