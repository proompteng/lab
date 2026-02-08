import { createFileRoute } from '@tanstack/react-router'
import { createControlPlaneCacheStore } from '~/server/control-plane-cache-store'
import { resolvePrimitiveKind } from '~/server/primitives-control-plane'
import {
  asRecord,
  asString,
  errorResponse,
  normalizeNamespace,
  okResponse,
  parseJsonBody,
  requireIdempotencyKey,
} from '~/server/primitives-http'
import { createKubernetesClient } from '~/server/primitives-kube'
import { createPrimitivesStore } from '~/server/primitives-store'
import { createKubectlWatchStream } from '~/server/primitives-watch'

export const Route = createFileRoute('/api/agents/control-plane/resource')({
  server: {
    handlers: {
      GET: async ({ request }) => getPrimitiveResource(request),
      POST: async ({ request }) => postPrimitiveResource(request),
      DELETE: async ({ request }) => deletePrimitiveResource(request),
    },
  },
})

export const getPrimitiveResource = async (
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const kindParam = url.searchParams.get('kind')
  const name = asString(url.searchParams.get('name'))
  const resolved = resolvePrimitiveKind(kindParam)
  if (!resolved) {
    return errorResponse('kind is required', 400)
  }
  if (!name) {
    return errorResponse('name is required', 400)
  }

  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const kube = deps.kubeClient ?? createKubernetesClient()
  const stream = url.searchParams.get('stream') === 'true' || url.searchParams.get('stream') === '1'

  try {
    if (stream) {
      const args = ['get', resolved.resource, name, '-n', namespace, '-o', 'json', '--watch', '--output-watch-events']
      return createKubectlWatchStream({
        request,
        args,
        onEvent: (event) => {
          const summary = {
            apiVersion: asString(event.object.apiVersion) ?? null,
            kind: asString(event.object.kind) ?? null,
            metadata: asRecord(event.object.metadata) ?? {},
            spec: asRecord(event.object.spec) ?? {},
            status: asRecord(event.object.status) ?? {},
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

    const cacheFlag = (process.env.JANGAR_CONTROL_PLANE_CACHE_ENABLED ?? '').trim().toLowerCase()
    const cacheEnabled = cacheFlag === '1' || cacheFlag === 'true' || cacheFlag === 'yes' || cacheFlag === 'on'
    const cacheKinds = new Set([
      'Agent',
      'AgentRun',
      'AgentProvider',
      'ImplementationSpec',
      'ImplementationSource',
      'VersionControlProvider',
    ])

    if (cacheEnabled && cacheKinds.has(resolved.kind)) {
      const cluster = (process.env.JANGAR_CONTROL_PLANE_CACHE_CLUSTER ?? 'default').trim() || 'default'
      let store: ReturnType<typeof createControlPlaneCacheStore> | null = null
      try {
        store = createControlPlaneCacheStore()
        await store.ready
        const cached = await store.getResource({ cluster, kind: resolved.kind, namespace, name })
        if (cached) {
          return okResponse({ ok: true, kind: resolved.kind, namespace, resource: cached })
        }
      } catch {
        // Fall back to kubectl get for transient DB issues.
      } finally {
        try {
          await store?.close()
        } catch {
          // ignore
        }
      }
    }

    const resource = await kube.get(resolved.resource, name, namespace)
    if (!resource) {
      return errorResponse(`${resolved.kind} not found`, 404, { name, namespace })
    }
    return okResponse({ ok: true, kind: resolved.kind, namespace, resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { kind: resolved.kind, namespace, name })
  }
}

export const deletePrimitiveResource = async (
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const kindParam = url.searchParams.get('kind')
  const name = asString(url.searchParams.get('name'))
  const resolved = resolvePrimitiveKind(kindParam)
  if (!resolved) {
    return errorResponse('kind is required', 400)
  }
  if (!name) {
    return errorResponse('name is required', 400)
  }

  const namespace = normalizeNamespace(url.searchParams.get('namespace'), 'agents')
  const kube = deps.kubeClient ?? createKubernetesClient()

  try {
    const deleted = await kube.delete(resolved.resource, name, namespace)
    if (!deleted) {
      return errorResponse(`${resolved.kind} not found`, 404, { name, namespace })
    }
    return okResponse({ ok: true, kind: resolved.kind, namespace, resource: deleted })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { kind: resolved.kind, namespace, name })
  }
}

type ImplementationSpecPayload = {
  name: string
  namespace: string
  spec: Record<string, unknown>
}

const coerceStringList = (value: unknown, limit = 100) => {
  if (!Array.isArray(value)) return []
  const trimmed = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return trimmed.slice(0, limit)
}

const normalizeContractMappings = (value: unknown) => {
  if (!Array.isArray(value)) return []
  const mappings = value
    .map((entry) => {
      const record = asRecord(entry)
      if (!record) return null
      const from = asString(record.from)
      const to = asString(record.to)
      if (!from || !to) return null
      return { from, to }
    })
    .filter((entry): entry is { from: string; to: string } => Boolean(entry))
  return mappings.slice(0, 100)
}

const normalizeImplementationSpec = (spec: Record<string, unknown>) => {
  const summary = asString(spec.summary) ?? undefined
  const description = asString(spec.description) ?? undefined
  const text = asString(spec.text)
  const acceptanceCriteria = coerceStringList(spec.acceptanceCriteria, 50)
  const labels = coerceStringList(spec.labels, 50)
  const sourceInput = asRecord(spec.source) ?? null
  const provider = asString(sourceInput?.provider) ?? 'manual'
  const source = sourceInput
    ? {
        provider,
        ...(asString(sourceInput.externalId) ? { externalId: asString(sourceInput.externalId) } : {}),
        ...(asString(sourceInput.url) ? { url: asString(sourceInput.url) } : {}),
      }
    : { provider }
  const contractInput = asRecord(spec.contract) ?? null
  const contractMappings = normalizeContractMappings(contractInput?.mappings)
  const requiredKeys = coerceStringList(contractInput?.requiredKeys, 50)
  const contract =
    contractMappings.length > 0 || requiredKeys.length > 0
      ? {
          ...(contractMappings.length > 0 ? { mappings: contractMappings } : {}),
          ...(requiredKeys.length > 0 ? { requiredKeys } : {}),
        }
      : undefined

  if (!text) {
    throw new Error('spec.text is required')
  }

  return {
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(labels.length > 0 ? { labels } : {}),
    ...(contract ? { contract } : {}),
    ...(source ? { source } : {}),
    text,
  }
}

const parseImplementationSpecPayload = (payload: Record<string, unknown>): ImplementationSpecPayload => {
  const kind = asString(payload.kind)
  if (kind && kind.toLowerCase() !== 'implementationspec') {
    throw new Error('kind must be ImplementationSpec')
  }
  const name = asString(payload.name)
  if (!name) throw new Error('name is required')
  const namespace = normalizeNamespace(asString(payload.namespace), 'agents')
  const specInput = asRecord(payload.spec)
  if (!specInput) throw new Error('spec is required')
  const spec = normalizeImplementationSpec(specInput)
  return { name, namespace, spec }
}

export const postPrimitiveResource = async (
  request: Request,
  deps: { storeFactory?: typeof createPrimitivesStore; kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseImplementationSpecPayload(payload)

    await store.ready
    const kube = deps.kubeClient ?? createKubernetesClient()
    const resource = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'ImplementationSpec',
      metadata: {
        name: parsed.name,
        namespace: parsed.namespace,
        labels: {
          'jangar.proompteng.ai/delivery-id': deliveryId,
        },
      },
      spec: parsed.spec,
    }

    const applied = await kube.apply(resource)
    const metadata = asRecord(applied.metadata) ?? {}
    const uid = asString(metadata.uid)

    if (uid) {
      await store.createAuditEvent({
        entityType: 'ImplementationSpec',
        entityId: uid,
        eventType: 'implementation_spec.created',
        payload: { deliveryId, name: parsed.name, namespace: parsed.namespace },
      })
    }

    return okResponse({ ok: true, resource: applied }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  } finally {
    await store.close()
  }
}
