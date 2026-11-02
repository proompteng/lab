'use client'

import * as Sentry from '@sentry/browser'

const lastReported = new Map<string, number>()

export function reportBrowserFailure(operation: string, status?: number, traceId?: string | null) {
  const key = `${operation}:${status ?? 'network'}`
  const now = Date.now()
  if (now - (lastReported.get(key) ?? 0) < 60_000) return
  lastReported.set(key, now)
  Sentry.withScope((scope) => {
    scope.setTag('service', 'tengri-browser')
    scope.setTag('operation', operation)
    if (status !== undefined) scope.setTag('status', status)
    if (traceId && /^[a-f0-9]{32}$/.test(traceId)) scope.setTag('trace_id', traceId)
    Sentry.captureException(new Error('Tengri operation failed'))
  })
}
