import { createServer } from 'node:http'
import activities from '@proompteng/bumba/src/activities/index'
import workflows from '@proompteng/bumba/src/workflows/index'
import { createTemporalClient, type TemporalConfig, temporalCallOptions } from '@proompteng/temporal-bun-sdk'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'
import type { WorkflowDefinitions } from '@proompteng/temporal-bun-sdk/workflow'
import { resolveWorkerRuntimeConfig } from '~/server/runtime-entry-config'

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

const startHealthServer = async (config: TemporalConfig): Promise<HealthServer> => {
  const { health } = resolveWorkerRuntimeConfig()
  const { port, checkIntervalMs, checkTimeoutMs, readyTtlMs, liveTtlMs } = health
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
        console.warn('[jangar-worker] Temporal readiness check failed', { error: state.lastTemporalError })
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

  console.log(`[jangar-worker] health server listening on :${port}`)

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
  const taskQueue = resolveWorkerRuntimeConfig().temporalTaskQueue
  const { worker, config } = await createWorker({
    taskQueue,
    workflows: workflows as WorkflowDefinitions,
    activities: activities as Record<string, ActivityHandler>,
  })

  console.log('[jangar-worker] started', {
    namespace: config.namespace,
    taskQueue,
    workerBuildId: config.workerBuildId,
  })

  const health = await startHealthServer(config)

  const shutdown = async (signal: string) => {
    console.log(`[jangar-worker] received ${signal}; shutting down`)
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
  console.error('[jangar-worker] crashed', error)
  process.exit(1)
})
