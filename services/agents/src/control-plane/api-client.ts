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
        'idempotency-key': crypto.randomUUID(),
      },
      body: JSON.stringify(manifest),
    }),
  )
  return (await response.json()) as PrimitiveResourceGetResponse
}
