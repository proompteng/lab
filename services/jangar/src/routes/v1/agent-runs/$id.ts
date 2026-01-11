import { createFileRoute } from '@tanstack/react-router'
import { asRecord, asString, errorResponse, normalizeNamespace, okResponse, readNested } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/agent-runs/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }) => getAgentRunHandler(params.id, request),
    },
  },
})

const extractStatusPhase = (resource: Record<string, unknown>) => {
  const status = asRecord(resource.status)
  return asString(status?.phase)
}

export const getAgentRunHandler = async (
  id: string,
  request: Request,
  deps: {
    storeFactory?: typeof createPrimitivesStore
    kubeClient?: ReturnType<typeof createKubernetesClient>
  } = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'))
  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    await store.ready
    const record = await store.getAgentRunById(id)
    if (!record) return errorResponse('AgentRun not found', 404)

    const resourceNamespace =
      asString(readNested(record.payload, ['resource', 'metadata', 'namespace'])) ??
      asString(readNested(record.payload, ['request', 'namespace'])) ??
      namespace

    const kube = deps.kubeClient ?? createKubernetesClient()
    const resource = record.externalRunId
      ? await kube.get(RESOURCE_MAP.AgentRun, record.externalRunId, resourceNamespace)
      : null
    if (resource) {
      const phase = extractStatusPhase(resource)
      if (phase && phase !== record.status) {
        await store.updateAgentRunStatus(record.id, phase, record.externalRunId)
        record.status = phase
      }
    }

    return okResponse({ ok: true, agentRun: record, resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}
