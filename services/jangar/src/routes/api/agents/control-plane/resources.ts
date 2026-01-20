import { createFileRoute } from '@tanstack/react-router'
import { resolvePrimitiveKind } from '~/server/primitives-control-plane'
import { asRecord, asString, errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'

export const Route = createFileRoute('/api/agents/control-plane/resources')({
  server: {
    handlers: {
      GET: async ({ request }) => listPrimitiveResources(request),
    },
  },
})

const parseLimit = (value: string | null) => {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), 500)
}

const toSummary = (resource: Record<string, unknown>) => ({
  apiVersion: asString(resource.apiVersion) ?? null,
  kind: asString(resource.kind) ?? null,
  metadata: asRecord(resource.metadata) ?? {},
  spec: asRecord(resource.spec) ?? {},
  status: asRecord(resource.status) ?? {},
})

export const listPrimitiveResources = async (
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const kindParam = url.searchParams.get('kind')
  const resolved = resolvePrimitiveKind(kindParam)
  if (!resolved) {
    return errorResponse('kind is required', 400)
  }

  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const limit = parseLimit(url.searchParams.get('limit'))
  const kube = deps.kubeClient ?? createKubernetesClient()

  try {
    const list = await kube.list(resolved.resource, namespace)
    const itemsRaw = Array.isArray(list.items) ? list.items : []
    const sliced = limit ? itemsRaw.slice(0, limit) : itemsRaw
    const items = sliced.map((item) => toSummary(asRecord(item) ?? {}))
    return okResponse({ ok: true, kind: resolved.kind, namespace, total: itemsRaw.length, items })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { kind: resolved.kind, namespace })
  }
}
