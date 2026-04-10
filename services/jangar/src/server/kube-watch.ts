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
  onEvent: (event: WatchEvent) => void | Promise<void>
  onError?: (error: Error) => void
  onRestart?: (reason: string) => void | Promise<void>
  logPrefix?: string
}

type WatchHandle = {
  stop: () => void
}

const DEFAULT_RESTART_DELAY_MS = 2_000

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
    onEvent,
    onError,
    onRestart,
    logPrefix = '[jangar][watch]',
  } = options

  const { kubeConfig } = getNativeKubeClients()

  let stopped = false
  let restartTimer: NodeJS.Timeout | null = null
  let abortController: AbortController | null = null
  let currentResourceVersion = resourceVersion?.trim() ? resourceVersion.trim() : null
  let watchStartResourceVersion: string | null = null
  let sawEventSinceStart = false
  const normalizedResource = resource.trim() ? resource.trim() : 'unknown'
  const normalizedNamespace = namespace.trim() ? namespace.trim() : 'unknown'

  const clearStaleResourceVersionBeforeRestart = () => {
    if (!watchStartResourceVersion || sawEventSinceStart) return
    if (currentResourceVersion !== watchStartResourceVersion) return
    currentResourceVersion = null
  }

  const scheduleRestart = (reason: string) => {
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
    }, restartDelayMs)
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
              recordKubeWatchError({
                resource: normalizedResource,
                namespace: normalizedNamespace,
                reason: 'watch_error',
              })
              recordWatchReliabilityError({
                resource: normalizedResource,
                namespace: normalizedNamespace,
              })
              onError?.(new Error(`${logPrefix} ${resource} (${namespace}) watch failed: ${error.message}`))
            }
            scheduleRestart(error ? 'watch_error' : 'closed')
          },
        ),
      )
      .then((controller) => {
        abortController = controller
      })
      .catch((error) => {
        recordKubeWatchError({
          resource: normalizedResource,
          namespace: normalizedNamespace,
          reason: 'watch_start_error',
        })
        recordWatchReliabilityError({
          resource: normalizedResource,
          namespace: normalizedNamespace,
        })
        onError?.(error instanceof Error ? error : new Error(String(error)))
        scheduleRestart('watch_start_error')
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
