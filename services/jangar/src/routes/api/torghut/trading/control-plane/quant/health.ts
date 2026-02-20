import { createFileRoute } from '@tanstack/react-router'

import { parseQuantAccount, parseQuantStrategyId, parseQuantWindow } from '~/server/torghut-quant-http'
import { getQuantLatestStoreStatus, listLatestQuantPipelineHealth } from '~/server/torghut-quant-metrics-store'

export const Route = createFileRoute('/api/torghut/trading/control-plane/quant/health')({
  server: {
    handlers: {
      GET: async ({ request }) => getQuantHealthHandler(request),
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

export const getQuantHealthHandler = async (request: Request) => {
  try {
    const requestUrl = new URL(request.url)
    const strategyIdParam = requestUrl.searchParams.get('strategy_id') ?? requestUrl.searchParams.get('strategyId')
    const strategyIdResult = strategyIdParam
      ? parseQuantStrategyId(requestUrl)
      : { ok: true as const, value: undefined }
    if (!strategyIdResult.ok) return jsonResponse({ ok: false, message: strategyIdResult.message }, 400)
    const account = parseQuantAccount(requestUrl).value
    const windowParam = requestUrl.searchParams.get('window')
    const windowResult = windowParam ? parseQuantWindow(requestUrl) : { ok: true as const, value: undefined }
    if (!windowResult.ok) return jsonResponse({ ok: false, message: windowResult.message }, 400)

    const nowIso = new Date().toISOString()
    const latestStore = await getQuantLatestStoreStatus()
    const updatedAt = latestStore.updatedAt
    const count = latestStore.count
    const lagSeconds = updatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 1000)) : null
    const missingUpdateThresholdSeconds = Number.parseInt(
      process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS ?? '15',
      10,
    )
    const duringMarketHours = isMarketHoursNy()
    const missingUpdateAlarm =
      duringMarketHours &&
      lagSeconds !== null &&
      lagSeconds > (Number.isFinite(missingUpdateThresholdSeconds) ? missingUpdateThresholdSeconds : 15)

    const stages = await listLatestQuantPipelineHealth({
      strategyId: strategyIdResult.value,
      account,
      window: windowResult.value,
    })
    const maxStageLagSeconds = stages.reduce((max, stage) => Math.max(max, stage.lagSeconds), 0)
    const overallState = stages.some((stage) => !stage.ok) || missingUpdateAlarm ? 'degraded' : 'ok'

    return jsonResponse({
      ok: true,
      status: overallState,
      asOf: nowIso,
      latestMetricsUpdatedAt: updatedAt,
      latestMetricsCount: count,
      metricsPipelineLagSeconds: lagSeconds,
      missingUpdateAlarm,
      missingUpdateThresholdSeconds: Number.isFinite(missingUpdateThresholdSeconds)
        ? missingUpdateThresholdSeconds
        : 15,
      stages,
      maxStageLagSeconds,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quant health failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}

const isMarketHoursNy = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const record: Record<string, string> = {}
  for (const part of parts) {
    if (part.type !== 'literal') record[part.type] = part.value
  }
  const weekday = record.weekday ?? ''
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const hour = Number(record.hour ?? '0')
  const minute = Number(record.minute ?? '0')
  const minutes = hour * 60 + minute
  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60
}
