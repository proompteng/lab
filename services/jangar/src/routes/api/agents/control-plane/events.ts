import { createFileRoute } from '@tanstack/react-router'
import { resolvePrimitiveKind } from '~/server/primitives-control-plane'
import { asString, errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'

export const Route = createFileRoute('/api/agents/control-plane/events')({
  server: {
    handlers: {
      GET: async ({ request }) => listPrimitiveEvents(request),
    },
  },
})

const parseLimit = (value: string | null) => {
  if (!value) return 25
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 25
  return Math.min(Math.floor(parsed), 200)
}

const parseEventTime = (event: Record<string, unknown>) => {
  const eventTime = asString(event.eventTime)
  const lastTimestamp = asString(event.lastTimestamp)
  const firstTimestamp = asString(event.firstTimestamp)
  return eventTime || lastTimestamp || firstTimestamp || null
}

const toEventSummary = (event: Record<string, unknown>) => {
  const metadata =
    event.metadata && typeof event.metadata === 'object' ? (event.metadata as Record<string, unknown>) : {}
  return {
    name: asString(metadata.name) ?? null,
    namespace: asString(metadata.namespace) ?? null,
    type: asString(event.type) ?? null,
    reason: asString(event.reason) ?? null,
    action: asString(event.action) ?? null,
    count: typeof event.count === 'number' ? event.count : null,
    message: asString(event.message) ?? null,
    firstTimestamp: asString(event.firstTimestamp) ?? null,
    lastTimestamp: asString(event.lastTimestamp) ?? null,
    eventTime: asString(event.eventTime) ?? null,
    involvedObject: event.involvedObject ?? null,
  }
}

const buildFieldSelector = (kind: string, name: string, uid?: string | null) => {
  const fields = [`involvedObject.kind=${kind}`, `involvedObject.name=${name}`]
  if (uid) fields.push(`involvedObject.uid=${uid}`)
  return fields.join(',')
}

export const listPrimitiveEvents = async (
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const kindParam = url.searchParams.get('kind')
  const name = asString(url.searchParams.get('name'))
  const uid = asString(url.searchParams.get('uid'))
  const resolved = resolvePrimitiveKind(kindParam)
  if (!resolved) {
    return errorResponse('kind is required', 400)
  }
  if (!name) {
    return errorResponse('name is required', 400)
  }

  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const limit = parseLimit(url.searchParams.get('limit'))
  const kube = deps.kubeClient ?? createKubernetesClient()
  const fieldSelector = buildFieldSelector(resolved.kind, name, uid)

  try {
    const list = await kube.listEvents(namespace, fieldSelector)
    const itemsRaw = Array.isArray(list.items) ? list.items : []
    const items = itemsRaw
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : {}))
      .sort((a, b) => {
        const aTime = parseEventTime(a)
        const bTime = parseEventTime(b)
        if (!aTime && !bTime) return 0
        if (!aTime) return 1
        if (!bTime) return -1
        return bTime.localeCompare(aTime)
      })
      .slice(0, limit)
      .map((event) => toEventSummary(event))

    return okResponse({ ok: true, kind: resolved.kind, namespace, name, items })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { kind: resolved.kind, namespace, name })
  }
}
