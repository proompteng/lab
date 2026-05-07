import {
  recordWatchReliabilityError,
  recordWatchReliabilityEvent,
  recordWatchReliabilityRestart,
} from '~/server/control-plane-watch-reliability'
import { startKubernetesWatch } from '~/server/kubernetes-watch-client'
import { recordKubeWatchError, recordKubeWatchEvent, recordKubeWatchRestart } from '~/server/metrics'
import { buildKubernetesResourceCollectionPath, getNativeKubeClients } from '~/server/primitives-kube'

type WatchEvent = {
  type?: string
  object?: Record<string, unknown>
}

type WatchOptions = {
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

type WatchHandle = {
  stop: () => void
}

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

const isRateLimitError = (error: Error) => errorStatusCode(error) === 429 || error.message.includes('Too Many Requests')

const boundedDelay = (value: number, fallback: number) => {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

const buildWatchPath = async (resource: string, namespace: string) => {
  return buildKubernetesResourceCollectionPath(resource, namespace)
}

export const resetKubectlWatchCompatibilityCacheForTests = () => {
  // no-op: watch compatibility caching was removed when the watch path moved to the native client.
}

export const startResourceWatch = (options: WatchOptions): WatchHandle => {
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
    logPrefix = '[jangar][watch]',
  } = options

  const { kubeConfig } = getNativeKubeClients()
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
    recordKubeWatchRestart({
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
    recordWatchReliabilityRestart({
      resource: normalizedResource,
      namespace: normalizedNamespace,
    })
    void onRestart?.(reason)
  }

  const start = () => {
    if (stopped) return
    watchStartResourceVersion = currentResourceVersion
    sawEventSinceStart = false

    void buildWatchPath(resource, namespace)
      .then((path) =>
        startKubernetesWatch(
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

            recordKubeWatchEvent({
              resource: normalizedResource,
              namespace: normalizedNamespace,
              type,
            })
            recordWatchReliabilityEvent({
              resource: normalizedResource,
              namespace: normalizedNamespace,
            })
            void onEvent({ type, object: payload })
          },
          (error) => {
            if (stopped) return
            clearStaleResourceVersionBeforeRestart()
            if (error) {
              const reason = isRateLimitError(error) ? 'watch_rate_limited' : 'watch_error'
              recordKubeWatchError({
                resource: normalizedResource,
                namespace: normalizedNamespace,
                reason,
              })
              recordWatchReliabilityError({
                resource: normalizedResource,
                namespace: normalizedNamespace,
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
        const normalizedError = error instanceof Error ? error : new Error(String(error))
        const reason = isRateLimitError(normalizedError) ? 'watch_start_rate_limited' : 'watch_start_error'
        recordKubeWatchError({
          resource: normalizedResource,
          namespace: normalizedNamespace,
          reason,
        })
        recordWatchReliabilityError({
          resource: normalizedResource,
          namespace: normalizedNamespace,
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
