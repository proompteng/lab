import { STATUS_CODES } from 'node:http'

import { KubeConfig, Watch } from '@kubernetes/client-node'

import { buildBunKubernetesFetchInit, shouldUseBunKubernetesTransport } from './kubernetes-bun-transport'
import { parsePositiveIntEnv } from './runtime-env'

type WatchQuery = Record<string, string | number | boolean | undefined>

type WatchDone = (error: Error | null) => void

const WATCH_TIMEOUT_GRACE_MS = 30_000

const isAbortError = (error: unknown) => {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.message.includes('aborted')
}

const isWatchTimeoutClose = (error: unknown, timeoutAt: number) => {
  if (!(error instanceof Error) || !('code' in error) || error.code !== 'ECONNRESET') return false
  const elapsedPastDeadline = performance.now() - timeoutAt
  return elapsedPastDeadline >= 0 && elapsedPastDeadline < WATCH_TIMEOUT_GRACE_MS
}

const drainWatchStream = async (
  response: Response,
  callback: (type: string, object: unknown, data: unknown) => void,
  done: WatchDone,
  controller: AbortController,
  timeoutAt: number,
) => {
  const reader = response.body?.getReader()
  if (!reader) {
    done(new Error('Watch response missing body'))
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  const flushLine = (line: string) => {
    if (!line.trim()) return
    try {
      const data = JSON.parse(line) as { type?: string; object?: unknown }
      callback(data.type ?? '', data.object, data)
    } catch {
      // Ignore malformed watch chunks.
    }
  }

  try {
    while (true) {
      const { done: streamDone, value } = await reader.read()
      if (streamDone) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        flushLine(buffer.slice(0, newlineIndex))
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
      }
    }

    buffer += decoder.decode()
    flushLine(buffer)
    done(null)
  } catch (error) {
    // Bun can report a server close as ECONNRESET. Only accept it at the
    // expected timeout of an established stream, between complete events.
    if (
      (controller.signal.aborted && isAbortError(error)) ||
      (buffer.length === 0 && isWatchTimeoutClose(error, timeoutAt))
    ) {
      done(null)
      return
    }
    done(error instanceof Error ? error : new Error(String(error)))
  }
}

const watchWithBunFetch = async (
  kubeConfig: KubeConfig,
  path: string,
  queryParams: WatchQuery & { timeoutSeconds: number },
  callback: (type: string, object: unknown, data: unknown) => void,
  done: WatchDone,
) => {
  const cluster = kubeConfig.getCurrentCluster()
  if (!cluster) {
    throw new Error('No currently active cluster')
  }

  const watchURL = new URL(cluster.server + path)
  watchURL.searchParams.set('watch', 'true')
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined) {
      watchURL.searchParams.set(key, String(value))
    }
  }

  const controller = new AbortController()
  let doneCalled = false
  const doneOnce: WatchDone = (error) => {
    if (doneCalled) return
    doneCalled = true
    controller.abort()
    done(error)
  }

  void (async () => {
    try {
      const init = await buildBunKubernetesFetchInit(kubeConfig, {
        method: 'GET',
        signal: controller.signal,
      })
      const timeoutMs = queryParams.timeoutSeconds * 1000
      const timeoutAt = performance.now() + timeoutMs
      // Let the API server finish the watch before Bun's socket idle timeout.
      const response = await fetch(watchURL, { ...init, timeout: timeoutMs + WATCH_TIMEOUT_GRACE_MS })
      if (response.status !== 200) {
        const statusText = response.statusText || STATUS_CODES[response.status] || 'Internal Server Error'
        const error = new Error(statusText) as Error & { statusCode?: number }
        error.statusCode = response.status
        throw error
      }

      await drainWatchStream(response, callback, doneOnce, controller, timeoutAt)
    } catch (error) {
      if (controller.signal.aborted && isAbortError(error)) {
        doneOnce(null)
        return
      }
      doneOnce(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  return controller
}

export const startKubernetesWatch = async (
  kubeConfig: KubeConfig,
  path: string,
  queryParams: WatchQuery,
  callback: (type: string, object: unknown, data: unknown) => void,
  done: WatchDone,
) => {
  const timeoutSeconds = parsePositiveIntEnv(process.env.AGENTS_KUBE_WATCH_TIMEOUT_SECONDS, 300, {
    minimum: 30,
    maximum: 600,
  })
  const query = { ...queryParams, timeoutSeconds }
  if (shouldUseBunKubernetesTransport()) {
    return watchWithBunFetch(kubeConfig, path, query, callback, done)
  }

  const watch = new Watch(kubeConfig)
  return watch.watch(path, query, callback, done)
}

export const __private = {
  drainWatchStream,
  isAbortError,
}
