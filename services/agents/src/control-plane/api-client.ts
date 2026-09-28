import type { ControlPlanePrimitiveRegistryEntry } from './primitive-registry.generated'

export type PrimitiveListResponse = {
  ok: true
  total: number
  items: ControlPlanePrimitiveRegistryEntry[]
}

export type PrimitiveResourceSummary = {
  apiVersion: string | null
  kind: string | null
  metadata: Record<string, unknown>
  spec: Record<string, unknown>
  status: Record<string, unknown>
}

export type PrimitiveResourceListResponse = {
  ok: true
  kind: string
  namespace: string
  total: number
  items: PrimitiveResourceSummary[]
}

export type PrimitiveResourceGetResponse = {
  ok: true
  kind: string
  namespace: string
  resource: Record<string, unknown>
}

export type AgentRunLogsResponse = {
  ok: true
  name: string
  namespace: string
  pods: Array<{
    name: string
    phase: string | null
    containers: Array<{ name: string; type: 'main' | 'init' }>
  }>
  logs: string
  pod: string | null
  container: string | null
  tailLines: number | null
}

export type PrimitiveEventSummary = {
  name: string | null
  namespace: string | null
  type: string | null
  reason: string | null
  action: string | null
  count: number | null
  message: string | null
  firstTimestamp: string | null
  lastTimestamp: string | null
  eventTime: string | null
  involvedObject: unknown
}

export type PrimitiveEventsResponse = {
  ok: true
  kind: string
  namespace: string
  name: string
  items: PrimitiveEventSummary[]
}

const assertOk = async (response: Response) => {
  if (response.ok) return response
  const body = (await response.text()).trim()
  throw new Error(body || `${response.status} ${response.statusText}`)
}

const formatUuidV4 = (bytes: Uint8Array) => {
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const createIdempotencyKey = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  return formatUuidV4(bytes)
}

export const fetchPrimitiveDefinitions = async () => {
  const response = await assertOk(await fetch('/api/primitives'))
  return (await response.json()) as PrimitiveListResponse
}

export type PrimitiveResourceQuery = {
  namespace?: string
  phase?: string
  status?: string
  runtime?: string
  labelSelector?: string
  label_selector?: string
  limit?: number
}

export const fetchPrimitiveResources = async (kind: string, query: PrimitiveResourceQuery | string = {}) => {
  const url = new URL(`/api/primitives/${encodeURIComponent(kind)}/resources`, window.location.origin)
  const params = typeof query === 'string' ? { namespace: query } : query
  url.searchParams.set('namespace', params.namespace ?? 'agents')
  if (params.phase) url.searchParams.set('phase', params.phase)
  if (!params.phase && params.status) url.searchParams.set('phase', params.status)
  if (params.runtime) url.searchParams.set('runtime', params.runtime)
  if (params.labelSelector) url.searchParams.set('labelSelector', params.labelSelector)
  if (params.label_selector) url.searchParams.set('label_selector', params.label_selector)
  if (typeof params.limit === 'number') url.searchParams.set('limit', params.limit.toString())
  const response = await assertOk(await fetch(url))
  return (await response.json()) as PrimitiveResourceListResponse
}

export const fetchPrimitiveResource = async (kind: string, namespace: string, name: string) => {
  const url = new URL(`/api/primitives/${encodeURIComponent(kind)}/resource`, window.location.origin)
  url.searchParams.set('namespace', namespace)
  url.searchParams.set('name', name)
  const response = await assertOk(await fetch(url))
  return (await response.json()) as PrimitiveResourceGetResponse
}

export const createPrimitiveResource = async (kind: string, manifest: Record<string, unknown>) => {
  const response = await assertOk(
    await fetch(`/api/primitives/${encodeURIComponent(kind)}/resources`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': createIdempotencyKey(),
      },
      body: JSON.stringify(manifest),
    }),
  )
  return (await response.json()) as PrimitiveResourceGetResponse
}

export const fetchAgentRunLogs = async ({
  namespace,
  name,
  pod,
  container,
  tailLines,
}: {
  namespace: string
  name: string
  pod?: string | null
  container?: string | null
  tailLines?: number | null
}) => {
  const url = new URL('/v1/control-plane/logs', window.location.origin)
  url.searchParams.set('namespace', namespace)
  url.searchParams.set('name', name)
  if (pod) url.searchParams.set('pod', pod)
  if (container) url.searchParams.set('container', container)
  if (tailLines) url.searchParams.set('tailLines', String(tailLines))
  const response = await assertOk(await fetch(url))
  return (await response.json()) as AgentRunLogsResponse
}

export const fetchPrimitiveEvents = async ({
  kind,
  namespace,
  name,
  uid,
  limit = 50,
}: {
  kind: string
  namespace: string
  name: string
  uid?: string | null
  limit?: number
}) => {
  const url = new URL('/v1/control-plane/events', window.location.origin)
  url.searchParams.set('kind', kind)
  url.searchParams.set('namespace', namespace)
  url.searchParams.set('name', name)
  url.searchParams.set('limit', String(limit))
  if (uid) url.searchParams.set('uid', uid)
  const response = await assertOk(await fetch(url))
  return (await response.json()) as PrimitiveEventsResponse
}
