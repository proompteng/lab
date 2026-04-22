import { createFileRoute } from '@tanstack/react-router'
import { listTorghutAutoresearchEpochs } from '~/server/torghut-autoresearch'
import { parseQuantAccount, parseQuantStrategyId, parseQuantWindow } from '~/server/torghut-quant-http'
import { listQuantAlerts, listQuantLatestMetrics } from '~/server/torghut-quant-metrics-store'
import {
  getTorghutQuantRuntimeStatus,
  isTorghutQuantMaterializationNotFoundError,
  materializeTorghutQuantFrameOnDemand,
  startTorghutQuantRuntime,
} from '~/server/torghut-quant-runtime'

export const Route = createFileRoute('/api/torghut/trading/control-plane/quant/snapshot')({
  server: {
    handlers: {
      GET: async ({ request }: JangarServerRouteArgs) => getQuantSnapshotHandler(request),
    },
  },
})

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

export const getQuantSnapshotHandler = async (request: Request) => {
  startTorghutQuantRuntime()

  const url = new URL(request.url)
  const strategyIdResult = parseQuantStrategyId(url)
  if (!strategyIdResult.ok) return jsonResponse({ ok: false, message: strategyIdResult.message }, 400)

  const accountResult = parseQuantAccount(url)
  const windowResult = parseQuantWindow(url)
  if (!windowResult.ok) return jsonResponse({ ok: false, message: windowResult.message }, 400)

  try {
    const autoresearchPromise = listTorghutAutoresearchEpochs({ limit: 5 }).catch((error) => ({
      available: false,
      count: 0,
      epochs: [],
      error: error instanceof Error ? error.message : 'autoresearch_epoch_query_failed',
    }))

    let metrics = await listQuantLatestMetrics({
      strategyId: strategyIdResult.value,
      account: accountResult.value,
      window: windowResult.value,
    })
    const runtimeStatus = getTorghutQuantRuntimeStatus()
    if (metrics.length === 0 && runtimeStatus.enabled) {
      try {
        await materializeTorghutQuantFrameOnDemand({
          strategyId: strategyIdResult.value,
          account: accountResult.value,
          window: windowResult.value,
        })
      } catch (error) {
        if (!isTorghutQuantMaterializationNotFoundError(error)) throw error
      }
      metrics = await listQuantLatestMetrics({
        strategyId: strategyIdResult.value,
        account: accountResult.value,
        window: windowResult.value,
      })
    }
    const alerts = await listQuantAlerts({ strategyId: strategyIdResult.value, state: 'open', limit: 1000 })

    const frameAsOf =
      metrics.reduce<string | null>((latest, metric) => {
        if (!metric.asOf) return latest
        if (!latest) return metric.asOf
        return Date.parse(metric.asOf) > Date.parse(latest) ? metric.asOf : latest
      }, null) ?? new Date().toISOString()

    const frame = {
      strategyId: strategyIdResult.value,
      account: accountResult.value,
      window: windowResult.value,
      frameAsOf,
      metrics,
      alerts: alerts.filter((alert) => alert.window === windowResult.value && alert.account === accountResult.value),
      autoresearch: await autoresearchPromise,
    }

    return jsonResponse({ ok: true, frame })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quant snapshot failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
