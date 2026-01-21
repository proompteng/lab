import { createFileRoute } from '@tanstack/react-router'
import { resolvePrimitiveKind } from '~/server/primitives-control-plane'
import { asRecord, asString, errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'
import { createKubectlWatchStream } from '~/server/primitives-watch'

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

const parseFilter = (value: string | null) => {
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const parseStream = (value: string | null) => value === 'true' || value === '1'

const toSummary = (resource: Record<string, unknown>) => ({
  apiVersion: asString(resource.apiVersion) ?? null,
  kind: asString(resource.kind) ?? null,
  metadata: asRecord(resource.metadata) ?? {},
  spec: asRecord(resource.spec) ?? {},
  status: asRecord(resource.status) ?? {},
})

const matchesAgentRunFilters = (resource: Record<string, unknown>, phase?: string | null, runtime?: string | null) => {
  if (phase) {
    const status = asRecord(resource.status) ?? {}
    const itemPhase = asString(status.phase)
    if (itemPhase !== phase) return false
  }
  if (runtime) {
    const spec = asRecord(resource.spec) ?? {}
    const runtimeSpec = asRecord(spec.runtime) ?? {}
    const runtimeType = asString(runtimeSpec.type)
    if (runtimeType !== runtime) return false
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
  const labelSelector =
    parseFilter(url.searchParams.get('labelSelector')) ?? parseFilter(url.searchParams.get('label_selector'))
  const phase = parseFilter(url.searchParams.get('phase'))
  const runtime = parseFilter(url.searchParams.get('runtime'))
  const kube = deps.kubeClient ?? createKubernetesClient()
  const stream = parseStream(url.searchParams.get('stream'))

  try {
    if (stream) {
      const args = ['get', resolved.resource, '-n', namespace, '-o', 'json', '--watch', '--output-watch-events']
      if (labelSelector) {
        args.push('-l', labelSelector)
      }
      return createKubectlWatchStream({
        request,
        args,
        onEvent: (event) => {
          const summary = toSummary(asRecord(event.object) ?? {})
          if (resolved.kind === 'AgentRun' && event.type !== 'DELETED') {
            if (!matchesAgentRunFilters(summary, phase, runtime)) return null
          }
          const metadata = asRecord(summary.metadata) ?? {}
          return {
            type: event.type,
            kind: resolved.kind,
            namespace,
            name: asString(metadata.name),
            resource: summary,
          }
        },
      })
    }
    const list = await kube.list(resolved.resource, namespace, labelSelector ?? undefined)
    const itemsRaw = Array.isArray(list.items) ? list.items : []
    const summaries = itemsRaw.map((item) => toSummary(asRecord(item) ?? {}))
    const filtered =
      resolved.kind === 'AgentRun' && (phase || runtime)
        ? summaries.filter((item) => {
            return matchesAgentRunFilters(item, phase, runtime)
          })
        : summaries
    const sliced = limit ? filtered.slice(0, limit) : filtered
    return okResponse({ ok: true, kind: resolved.kind, namespace, total: filtered.length, items: sliced })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { kind: resolved.kind, namespace })
  }
}
