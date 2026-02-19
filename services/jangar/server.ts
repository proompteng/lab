import serverEntry from 'virtual:tanstack-start-server-entry'
import { defineEventHandler } from 'h3'

import { getPrometheusMetricsPath, isPrometheusMetricsEnabled, renderPrometheusMetrics } from './src/server/metrics'

type UnknownRecord = Record<string, unknown>

const isRecord = (value: unknown): value is UnknownRecord =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const toHeaders = (value: unknown) => {
  if (!isRecord(value)) return undefined
  const headers = new Headers()
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') {
      headers.set(key, raw)
      continue
    }
    if (Array.isArray(raw)) {
      const strings = raw.filter((item): item is string => typeof item === 'string')
      if (strings.length > 0) headers.set(key, strings.join(','))
    }
  }
  return headers
}

const headerValue = (headers: unknown, key: string) => {
  if (!(headers instanceof Headers) || key.length === 0) return undefined
  const value = headers.get(key)
  return value ?? undefined
}

const toRequest = (event: unknown) => {
  if (isRecord(event)) {
    const web = event.web
    if (isRecord(web) && web.request instanceof Request) {
      return web.request
    }

    if (event.req instanceof Request) {
      return event.req
    }

    const node = event.node
    if (isRecord(node) && node.req && typeof node.req === 'object') {
      const nodeReq = node.req as UnknownRecord
      const headers = toHeaders(nodeReq.headers) ?? new Headers()

      const proto = headerValue(headers, 'x-forwarded-proto') ?? 'http'
      const host = headerValue(headers, 'x-forwarded-host') ?? headerValue(headers, 'host') ?? 'localhost'
      const url = typeof nodeReq.url === 'string' ? nodeReq.url : '/'
      const absoluteUrl = url.startsWith('http') ? url : `${proto}://${host}${url}`

      const method = typeof nodeReq.method === 'string' ? nodeReq.method : undefined
      return new Request(absoluteUrl, { method, headers })
    }

    const url =
      (typeof event.url === 'string' ? event.url : undefined) ??
      (typeof event.path === 'string' ? event.path : undefined) ??
      '/'
    const method = typeof event.method === 'string' ? event.method : 'GET'
    const headers = toHeaders(event.headers)
    return new Request(url, { method, headers })
  }

  return new Request('/', { method: 'GET' })
}

export default defineEventHandler(async (event) => {
  const request = toRequest(event)
  if (isPrometheusMetricsEnabled()) {
    const metricsPath = getPrometheusMetricsPath()
    const url = new URL(request.url)
    if (url.pathname === metricsPath) {
      const rendered = await renderPrometheusMetrics()
      if (!rendered.ok) {
        return new Response(JSON.stringify({ ok: false, message: rendered.message }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(rendered.body, {
        status: 200,
        headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      })
    }
  }
  return serverEntry.fetch(request)
})
