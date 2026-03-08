import { spawn } from 'node:child_process'
import { recordKubeWatchError, recordKubeWatchEvent, recordKubeWatchRestart } from '~/server/metrics'
import {
  recordWatchReliabilityError,
  recordWatchReliabilityEvent,
  recordWatchReliabilityRestart,
} from '~/server/control-plane-watch-reliability'

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

const parseJsonStream = (onJson: (jsonText: string) => void) => {
  let buffer = ''
  let depth = 0
  let startIndex = -1
  let inString = false
  let escaped = false

  return (chunk: string) => {
    buffer += chunk
    for (let i = 0; i < buffer.length; i += 1) {
      const char = buffer[i]
      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }
        if (char === '\\\\') {
          escaped = true
          continue
        }
        if (char === '"') {
          inString = false
        }
        continue
      }

      if (char === '"') {
        inString = true
        continue
      }

      if (char === '{' || char === '[') {
        if (depth === 0) {
          startIndex = i
        }
        depth += 1
        continue
      }

      if (char === '}' || char === ']') {
        if (depth > 0) {
          depth -= 1
        }
        if (depth === 0 && startIndex >= 0) {
          const jsonText = buffer.slice(startIndex, i + 1)
          onJson(jsonText)
          buffer = buffer.slice(i + 1)
          i = -1
          startIndex = -1
        }
      }
    }
  }
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

  let stopped = false
  let child: ReturnType<typeof spawn> | null = null
  let restartTimer: NodeJS.Timeout | null = null
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
    const args = [
      'get',
      resource,
      '-n',
      namespace,
      '--watch',
      '--output-watch-events',
      '-o',
      'json',
      '--request-timeout=0',
    ]
    if (currentResourceVersion) {
      args.push(`--resource-version=${currentResourceVersion}`)
    }
    if (labelSelector) {
      args.push('-l', labelSelector)
    }
    if (fieldSelector) {
      args.push('--field-selector', fieldSelector)
    }

    child = spawn('kubectl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const parse = parseJsonStream((jsonText) => {
      try {
        const payload = JSON.parse(jsonText) as WatchEvent
        if (!payload || typeof payload !== 'object') return
        const eventType = typeof payload.type === 'string' ? payload.type : 'UNKNOWN'
        const payloadObject =
          payload.object && typeof payload.object === 'object' && !Array.isArray(payload.object)
            ? (payload.object as Record<string, unknown>)
            : null
        const payloadMetadata =
          payloadObject?.metadata &&
          typeof payloadObject.metadata === 'object' &&
          !Array.isArray(payloadObject.metadata)
            ? (payloadObject.metadata as Record<string, unknown>)
            : null
        const nextResourceVersion =
          typeof payloadMetadata?.resourceVersion === 'string' ? payloadMetadata.resourceVersion.trim() : ''
        if (nextResourceVersion) {
          currentResourceVersion = nextResourceVersion
        }
        sawEventSinceStart = true
        if (eventType === 'BOOKMARK') return
        recordKubeWatchEvent({
          resource: normalizedResource,
          namespace: normalizedNamespace,
          type: eventType,
        })
        recordWatchReliabilityEvent({
          resource: normalizedResource,
          namespace: normalizedNamespace,
        })
        void onEvent(payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        recordKubeWatchError({
          resource: normalizedResource,
          namespace: normalizedNamespace,
          reason: 'parse_error',
        })
        recordWatchReliabilityError({
          resource: normalizedResource,
          namespace: normalizedNamespace,
        })
        onError?.(new Error(`${logPrefix} failed to parse watch event: ${message}`))
      }
    })

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => parse(String(chunk)))
    } else {
      recordKubeWatchError({
        resource: normalizedResource,
        namespace: normalizedNamespace,
        reason: 'stdout_unavailable',
      })
      onError?.(new Error(`${logPrefix} ${resource} (${namespace}) stdout unavailable`))
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const message = String(chunk).trim()
        if (message) {
          recordKubeWatchError({
            resource: normalizedResource,
            namespace: normalizedNamespace,
            reason: 'stderr_message',
          })
          recordWatchReliabilityError({
            resource: normalizedResource,
            namespace: normalizedNamespace,
          })
          onError?.(new Error(`${logPrefix} ${resource} (${namespace}) stderr: ${message}`))
        }
      })
    } else {
      recordKubeWatchError({
        resource: normalizedResource,
        namespace: normalizedNamespace,
        reason: 'stderr_unavailable',
      })
      recordWatchReliabilityError({
        resource: normalizedResource,
        namespace: normalizedNamespace,
      })
      onError?.(new Error(`${logPrefix} ${resource} (${namespace}) stderr unavailable`))
    }
    child.on('error', (error) => {
      recordKubeWatchError({
        resource: normalizedResource,
        namespace: normalizedNamespace,
        reason: 'spawn_error',
      })
      recordWatchReliabilityError({
        resource: normalizedResource,
        namespace: normalizedNamespace,
      })
      onError?.(error instanceof Error ? error : new Error(String(error)))
      scheduleRestart('spawn_error')
    })
    child.on('close', (code) => {
      if (stopped) return
      if (code !== 0) {
        clearStaleResourceVersionBeforeRestart()
        recordKubeWatchError({
          resource: normalizedResource,
          namespace: normalizedNamespace,
          reason: `close_${String(code ?? 'unknown')}`,
        })
        recordWatchReliabilityError({
          resource: normalizedResource,
          namespace: normalizedNamespace,
        })
        onError?.(new Error(`${logPrefix} ${resource} (${namespace}) closed with code ${code ?? 'unknown'}`))
      }
      scheduleRestart(code === 0 ? 'closed' : 'nonzero_exit')
    })
  }

  start()

  return {
    stop: () => {
      stopped = true
      if (restartTimer) clearTimeout(restartTimer)
      restartTimer = null
      if (child) {
        child.kill()
        child = null
      }
    },
  }
}
