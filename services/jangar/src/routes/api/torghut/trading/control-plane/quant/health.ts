import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'kysely'

import { ensureQuantStoreReady } from '~/server/torghut-quant-metrics-store'

export const Route = createFileRoute('/api/torghut/trading/control-plane/quant/health')({
  server: {
    handlers: {
      GET: async () => getQuantHealthHandler(),
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

export const getQuantHealthHandler = async () => {
  try {
    const db = await ensureQuantStoreReady()
    const nowIso = new Date().toISOString()

    const latest = await sql<{ updated_at: Date | string | null; count: number | string | null }>`
      select max(updated_at) as updated_at, count(*) as count
      from torghut_control_plane.quant_metrics_latest
    `.execute(db)

    const row = latest.rows[0]
    const updatedAt = row?.updated_at ? new Date(row.updated_at as string | Date).toISOString() : null
    const count = row?.count ? Number(row.count) : 0
    const lagSeconds = updatedAt ? Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 1000)) : null

    return jsonResponse({
      ok: true,
      asOf: nowIso,
      latestMetricsUpdatedAt: updatedAt,
      latestMetricsCount: count,
      metricsPipelineLagSeconds: lagSeconds,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Quant health failed'
    return jsonResponse({ ok: false, message }, 503)
  }
}
