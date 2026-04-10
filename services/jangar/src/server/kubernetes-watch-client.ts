import { STATUS_CODES } from 'node:http'

import { KubeConfig, Watch } from '@kubernetes/client-node'

import { buildBunKubernetesFetchInit, shouldUseBunKubernetesTransport } from '~/server/primitives-kube'

type WatchQuery = Record<string, string | number | boolean | undefined>

type WatchDone = (error: Error | null) => void

const isAbortError = (error: unknown) => {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.message.includes('aborted')
}

const drainWatchStream = async (
  response: Response,
  callback: (type: string, object: unknown, data: unknown) => void,
  done: WatchDone,
  controller: AbortController,
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
    if (controller.signal.aborted && isAbortError(error)) {
      done(null)
      return
    }
    done(error instanceof Error ? error : new Error(String(error)))
  }
}

const watchWithBunFetch = async (
  kubeConfig: KubeConfig,
  path: string,
  queryParams: WatchQuery,
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
      const response = await fetch(
        watchURL,
        await buildBunKubernetesFetchInit(kubeConfig, {
          method: 'GET',
          signal: controller.signal,
        }),
      )
      if (response.status !== 200) {
        const statusText = response.statusText || STATUS_CODES[response.status] || 'Internal Server Error'
        const error = new Error(statusText) as Error & { statusCode?: number }
        error.statusCode = response.status
        throw error
      }

      await drainWatchStream(response, callback, doneOnce, controller)
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
  if (shouldUseBunKubernetesTransport()) {
    return watchWithBunFetch(kubeConfig, path, queryParams, callback, done)
  }

  const watch = new Watch(kubeConfig)
  return watch.watch(path, queryParams, callback, done)
}

export const __private = {
  drainWatchStream,
  isAbortError,
}
