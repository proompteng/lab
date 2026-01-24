import { spawn } from 'node:child_process'

type WatchEvent = {
  type?: string
  object?: Record<string, unknown>
}

type WatchOptions = {
  resource: string
  namespace: string
  labelSelector?: string
  fieldSelector?: string
  restartDelayMs?: number
  onEvent: (event: WatchEvent) => void | Promise<void>
  onError?: (error: Error) => void
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
    restartDelayMs = DEFAULT_RESTART_DELAY_MS,
    onEvent,
    onError,
    logPrefix = '[jangar][watch]',
  } = options

  let stopped = false
  let child: ReturnType<typeof spawn> | null = null
  let restartTimer: NodeJS.Timeout | null = null

  const scheduleRestart = () => {
    if (stopped) return
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      restartTimer = null
      start()
    }, restartDelayMs)
  }

  const start = () => {
    if (stopped) return
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
        if (payload.type === 'BOOKMARK') return
        void onEvent(payload)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        onError?.(new Error(`${logPrefix} failed to parse watch event: ${message}`))
      }
    })

    if (child.stdout) {
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => parse(String(chunk)))
    } else {
      onError?.(new Error(`${logPrefix} ${resource} (${namespace}) stdout unavailable`))
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        const message = String(chunk).trim()
        if (message) {
          onError?.(new Error(`${logPrefix} ${resource} (${namespace}) stderr: ${message}`))
        }
      })
    } else {
      onError?.(new Error(`${logPrefix} ${resource} (${namespace}) stderr unavailable`))
    }
    child.on('error', (error) => {
      onError?.(error instanceof Error ? error : new Error(String(error)))
      scheduleRestart()
    })
    child.on('close', (code) => {
      if (stopped) return
      if (code !== 0) {
        onError?.(new Error(`${logPrefix} ${resource} (${namespace}) closed with code ${code ?? 'unknown'}`))
      }
      scheduleRestart()
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
