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

export const fetchPrimitiveResources = async (kind: string, namespace = 'agents') => {
  const url = new URL(`/api/primitives/${encodeURIComponent(kind)}/resources`, window.location.origin)
  url.searchParams.set('namespace', namespace)
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
