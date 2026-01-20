import { createFileRoute } from '@tanstack/react-router'
import { resolvePrimitiveKind } from '~/server/primitives-control-plane'
import { asRecord, asString, errorResponse, normalizeNamespace, okResponse, readNested } from '~/server/primitives-http'
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

const normalizeFilter = (value: string | null) => (value ? value.trim() : '')

const matchesAgentRunFilters = (resource: Record<string, unknown>, phase?: string, runtime?: string) => {
  if (phase) {
    const currentPhase = asString(readNested(resource, ['status', 'phase']))
    if (!currentPhase || currentPhase !== phase) {
      return false
    }
  }
  if (runtime) {
    const currentRuntime = asString(readNested(resource, ['spec', 'runtime', 'type']))
    if (!currentRuntime || currentRuntime !== runtime) {
      return false
    }
  }
  return true
}

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
  const phase = normalizeFilter(url.searchParams.get('phase')) || undefined
  const runtime = normalizeFilter(url.searchParams.get('runtime')) || undefined
  const kube = deps.kubeClient ?? createKubernetesClient()

  try {
    const list = await kube.list(resolved.resource, namespace)
    const itemsRaw = Array.isArray(list.items) ? list.items : []
    const filtered =
      resolved.kind === 'AgentRun' && (phase || runtime)
        ? itemsRaw.filter((item) => matchesAgentRunFilters(asRecord(item) ?? {}, phase, runtime))
        : itemsRaw
    const sliced = limit ? filtered.slice(0, limit) : filtered
    const items = sliced.map((item) => toSummary(asRecord(item) ?? {}))
    return okResponse({ ok: true, kind: resolved.kind, namespace, total: filtered.length, items })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { kind: resolved.kind, namespace })
  }
}
