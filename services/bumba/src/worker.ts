import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { createTemporalClient, type TemporalConfig, temporalCallOptions } from '@proompteng/temporal-bun-sdk'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'

import activities from './activities/index'

type ActivityHandler = (...args: unknown[]) => unknown | Promise<unknown>

type HealthState = {
  startedAt: number
  running: boolean
  shuttingDown: boolean
  lastHeartbeatAt: number
  lastTemporalSuccessAt: number | null
  lastTemporalFailureAt: number | null
  lastTemporalError?: string
}

type HealthServer = {
  port: number
  setRunning: (running: boolean) => void
  markShuttingDown: () => void
  stop: () => Promise<void>
}

const parseIntEnv = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const resolveHealthConfig = () => {
  const port = parseIntEnv(process.env.BUMBA_HEALTH_PORT, 3001)
  const checkIntervalMs = parseIntEnv(process.env.BUMBA_HEALTH_CHECK_INTERVAL_MS, 10_000)
  const checkTimeoutMs = parseIntEnv(process.env.BUMBA_HEALTH_CHECK_TIMEOUT_MS, 2_000)
  const readyTtlMs = parseIntEnv(process.env.BUMBA_HEALTH_READY_TTL_MS, 30_000)
  const liveTtlMs = parseIntEnv(process.env.BUMBA_HEALTH_LIVE_TTL_MS, 30_000)

  return {
    port,
    checkIntervalMs,
    checkTimeoutMs: Math.min(checkTimeoutMs, Math.max(checkIntervalMs - 100, 1_000)),
    readyTtlMs,
    liveTtlMs,
  }
}

const startHealthServer = async (config: TemporalConfig): Promise<HealthServer> => {
  const { port, checkIntervalMs, checkTimeoutMs, readyTtlMs, liveTtlMs } = resolveHealthConfig()
  const state: HealthState = {
    startedAt: Date.now(),
    running: false,
    shuttingDown: false,
    lastHeartbeatAt: Date.now(),
    lastTemporalSuccessAt: null,
    lastTemporalFailureAt: null,
  }

  const { client } = await createTemporalClient({ config })
  let lastLogAt = 0
  let stopped = false

  const checkTemporal = async () => {
    try {
      await client.describeNamespace(config.namespace, temporalCallOptions({ timeoutMs: checkTimeoutMs }))
      state.lastTemporalSuccessAt = Date.now()
      state.lastTemporalError = undefined
    } catch (error) {
      state.lastTemporalFailureAt = Date.now()
      state.lastTemporalError = error instanceof Error ? error.message : String(error)
      const now = Date.now()
      if (now - lastLogAt > checkIntervalMs * 6) {
        console.warn('Temporal readiness check failed', { error: state.lastTemporalError })
        lastLogAt = now
      }
    }
  }

  const heartbeatIntervalMs = Math.max(1_000, Math.floor(liveTtlMs / 3))
  const heartbeatTimer = setInterval(() => {
    state.lastHeartbeatAt = Date.now()
  }, heartbeatIntervalMs)

  const temporalTimer = setInterval(() => {
    void checkTemporal()
  }, checkIntervalMs)

  await checkTemporal()

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const now = Date.now()
    const uptimeMs = now - state.startedAt
    const live = !state.shuttingDown && now - state.lastHeartbeatAt <= liveTtlMs
    const temporalOk = state.lastTemporalSuccessAt !== null && now - state.lastTemporalSuccessAt <= readyTtlMs
    const ready = live && state.running && temporalOk

    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')

    if (path === '/livez') {
      res.statusCode = live ? 200 : 503
      res.end(
        JSON.stringify({
          status: live ? 'ok' : 'error',
          uptimeMs,
          running: state.running,
          shuttingDown: state.shuttingDown,
          lastHeartbeatAt: state.lastHeartbeatAt,
        }),
      )
      return
    }

    if (path === '/readyz' || path === '/healthz') {
      res.statusCode = ready ? 200 : 503
      res.end(
        JSON.stringify({
          status: ready ? 'ok' : 'error',
          uptimeMs,
          running: state.running,
          shuttingDown: state.shuttingDown,
          temporal: {
            ok: temporalOk,
            lastSuccessAt: state.lastTemporalSuccessAt,
            lastFailureAt: state.lastTemporalFailureAt,
            lastError: state.lastTemporalError,
          },
        }),
      )
      return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ status: 'not_found' }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => resolve())
  })

  console.log(`Bumba health server listening on :${port}`)

  return {
    port,
    setRunning: (running) => {
      state.running = running
    },
    markShuttingDown: () => {
      state.shuttingDown = true
    },
    stop: async () => {
      if (stopped) {
        return
      }
      stopped = true
      clearInterval(heartbeatTimer)
      clearInterval(temporalTimer)
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await client.shutdown()
    },
  }
}

const main = async () => {
  const { worker, config } = await createWorker({
    workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
    activities: activities as Record<string, ActivityHandler>,
  })

  const health = await startHealthServer(config)

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}. Shutting down worker...`)
    health.markShuttingDown()
    await worker.shutdown()
    await health.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  try {
    health.setRunning(true)
    await worker.run()
  } finally {
    health.setRunning(false)
    await health.stop()
  }
}

await main().catch((error) => {
  console.error('Bumba worker crashed:', error)
  process.exit(1)
})
